import { BaseProvider, type ChatStreamParams } from '../BaseProvider.js';
import type { StreamEvent, UnifiedMessage } from '../../types/index.js';
import type { LanguageModel, ModelRequest } from './BaseModel.js';
import type { ModelDescriptor } from '../catalog/ModelDescriptor.js';
import { ConnectionRegistry } from './ConnectionRegistry.js';
import { ProviderRegistry } from './ProviderRegistry.js';
import { ModelCatalogStore } from '../catalog/ModelCatalogStore.js';
import { ProviderError } from './ProviderErrors.js';

export class BridgedLanguageModelProvider extends BaseProvider {
  readonly name: string;
  private readonly languageModel: LanguageModel;

  constructor(name: string, languageModel: LanguageModel) {
    super();
    this.name = name;
    this.languageModel = languageModel;
  }

  get descriptor(): ModelDescriptor {
    return this.languageModel.descriptor;
  }

  async *streamChat(params: ChatStreamParams): AsyncGenerator<StreamEvent, void, unknown> {
    const messages: UnifiedMessage[] = [];

    if (params.systemPrompt) {
      messages.push({
        id: 'system_prompt',
        role: 'system',
        content: params.systemPrompt,
        timestamp: Date.now(),
      });
    }

    for (const m of params.messages) {
      messages.push(m);
    }

    const request: ModelRequest = {
      modelId: params.model,
      messages,
      tools: params.tools,
      generation: {
        temperature: params.temperature,
        maxTokens: params.maxTokens || 16384,
      },
      reasoning: params.thinkingBudget
        ? { budgetTokens: params.thinkingBudget }
        : undefined,
      signal: params.signal,
    };

    const stream = this.languageModel.stream(request);

    for await (const event of stream) {
      if (event.type === 'text.delta') {
        yield { type: 'text_delta', delta: event.text };
      } else if (event.type === 'reasoning.delta') {
        yield { type: 'thought_delta', delta: event.text };
      } else if (event.type === 'tool_call.start') {
        yield { type: 'tool_call_start', id: event.callId, name: event.name };
      } else if (event.type === 'tool_call.delta') {
        yield { type: 'tool_call_delta', id: event.callId, delta: event.inputDelta };
      } else if (event.type === 'tool_call.ready') {
        yield { type: 'tool_call_done', toolCall: event.toolCall };
      } else if (event.type === 'usage') {
        yield {
          type: 'usage',
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadTokens: event.usage.cacheReadTokens,
        };
      } else if (event.type === 'response.finish') {
        yield {
          type: 'finish',
          reason: event.reason === 'content_filter' ? 'stop' : event.reason,
        };
      } else if (event.type === 'error') {
        // PROV-003: Preserve structured ProviderError metadata (code, statusCode, retryable)
        yield {
          type: 'error',
          error: event.error instanceof Error ? event.error : new ProviderError(event.error),
        };
      }
      // 'response.start' is ignored for legacy streamChat
    }
  }
}

export class CompatibilityBridge {
  static create(
    providerNameOrConnection?: string,
    modelName?: string
  ): { provider: BaseProvider; model: string; descriptor: ModelDescriptor } {
    let connection = providerNameOrConnection
      ? ConnectionRegistry.findByProvider(providerNameOrConnection)
      : ConnectionRegistry.getDefault();

    if (!connection) {
      connection = ConnectionRegistry.getDefault();
    }

    const modelId = modelName || connection.defaultModelId || 'claude-3-7-sonnet-20250219';
    const descriptor = ModelCatalogStore.resolveOrCreate(connection.providerId, modelId);

    const adapter = ProviderRegistry.get(connection.protocolId);
    if (!adapter) {
      throw new ProviderError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: `No protocol adapter registered for protocol '${connection.protocolId}' (connection: '${connection.id}')`,
        retryable: false,
      });
    }

    const languageModel = adapter.createModel(connection, descriptor);
    const bridged = new BridgedLanguageModelProvider(connection.providerId, languageModel);

    return {
      provider: bridged,
      model: modelId,
      descriptor,
    };
  }
}
