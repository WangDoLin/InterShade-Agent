import OpenAI from 'openai';
import type { ProtocolAdapter } from '../ProtocolAdapter.js';
import type { ConnectionProfile } from '../../profiles/ProviderProfile.js';
import type { ModelDescriptor } from '../../catalog/ModelDescriptor.js';
import type {
  LanguageModel,
  ModelRequest,
  UnifiedStreamEvent,
} from '../../core/BaseModel.js';
import { ProviderError } from '../../core/ProviderErrors.js';
import { ConnectionRegistry } from '../../core/ConnectionRegistry.js';
import { zodToJsonSchema } from '../../zodHelper.js';
import { ToolExecutionGate } from '../../security/ToolExecutionGate.js';
import type { ToolCall } from '../../../types/index.js';

interface PendingToolCall {
  id: string;
  name: string;
  argsString: string;
}

export class OpenAIChatAdapter implements ProtocolAdapter {
  readonly protocolId = 'openai-chat-completions';

  createModel(connection: ConnectionProfile, descriptor: ModelDescriptor): LanguageModel {
    return new OpenAIChatLanguageModel(connection, descriptor);
  }
}

class OpenAIChatLanguageModel implements LanguageModel {
  readonly descriptor: ModelDescriptor;
  private readonly connection: ConnectionProfile;

  constructor(connection: ConnectionProfile, descriptor: ModelDescriptor) {
    this.connection = connection;
    this.descriptor = descriptor;
  }

  async *stream(request: ModelRequest): AsyncGenerator<UnifiedStreamEvent, void, unknown> {
    ConnectionRegistry.validateBaseURL(this.connection);
    const apiKey = ConnectionRegistry.resolveApiKey(this.connection) || 'dummy-key';
    const baseURL = this.connection.baseURL || 'https://api.openai.com/v1';

    const client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: this.connection.headers,
    });

    const openAITools = this.buildTools(request);
    const openAIMessages = this.buildMessages(request);

    try {
      yield { type: 'response.start' };

      const stream = await client.chat.completions.create(
        {
          model: request.modelId,
          messages: openAIMessages,
          tools: openAITools.length > 0 ? openAITools : undefined,
          temperature: request.generation?.temperature ?? 0.2,
          max_tokens: request.generation?.maxTokens ?? 16384,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: request.signal }
      );

      const pendingToolCalls = new Map<number, PendingToolCall>();
      const seenCallIds = new Set<string>();
      let finishReasonFromChunk: string | null = null;

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) {
          finishReasonFromChunk = choice.finish_reason;
        }
        if (choice?.delta) {
          const delta = choice.delta;

          if (delta.content) {
            yield { type: 'text.delta', text: delta.content };
          }

          // Support DeepSeek R1, o3-mini, 9Router, and OpenAI-compatible reasoning delta fields (PROV-001)
          const deltaRecord = delta as Record<string, unknown>;
          const thoughtContent =
            (typeof deltaRecord.reasoning_content === 'string' && deltaRecord.reasoning_content) ||
            (typeof deltaRecord.reasoning === 'string' && deltaRecord.reasoning) ||
            (typeof deltaRecord.thought === 'string' && deltaRecord.thought) ||
            (typeof deltaRecord.thinking === 'string' && deltaRecord.thinking);

          if (thoughtContent) {
            yield { type: 'reasoning.delta', text: thoughtContent };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!pendingToolCalls.has(idx)) {
                const item: PendingToolCall = {
                  id: tc.id || `call_${Date.now()}_${idx}`,
                  name: tc.function?.name || '',
                  argsString: tc.function?.arguments || '',
                };
                pendingToolCalls.set(idx, item);
                yield { type: 'tool_call.start', callId: item.id, name: item.name };
              } else {
                const item = pendingToolCalls.get(idx)!;
                if (tc.function?.name && !item.name) {
                  item.name = tc.function.name;
                }
                if (tc.function?.arguments) {
                  item.argsString += tc.function.arguments;
                  yield { type: 'tool_call.delta', callId: item.id, inputDelta: tc.function.arguments };
                }
              }
            }
          }
        }

        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            },
          };
        }
      }

      // Complete and validate assembled tool calls
      for (const [, item] of pendingToolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = item.argsString ? (JSON.parse(item.argsString) as Record<string, unknown>) : {};
        } catch (parseErr) {
          throw new ProviderError({
            code: 'INVALID_REQUEST',
            message: `Stream corrupted: Tool call '${item.name}' arguments are truncated or invalid JSON: ${item.argsString}`,
            retryable: true,
            rawError: parseErr,
          });
        }

        const completedCall: ToolCall = {
          id: item.id,
          name: item.name,
          arguments: parsedArgs,
          rawArguments: item.argsString,
        };
        ToolExecutionGate.validateToolCall(completedCall, request.tools, seenCallIds);
        yield { type: 'tool_call.ready', toolCall: completedCall };
      }

      const finishReason =
        finishReasonFromChunk === 'length'
          ? 'max_tokens'
          : finishReasonFromChunk === 'content_filter'
          ? 'content_filter'
          : pendingToolCalls.size > 0
          ? 'tool_use'
          : 'end_turn';
      yield { type: 'response.finish', reason: finishReason };
    } catch (err) {
      const normalized = ProviderError.fromUnknown(err);
      yield { type: 'error', error: normalized };
    }
  }

  private buildTools(request: ModelRequest): OpenAI.Chat.Completions.ChatCompletionTool[] {
    if (!request.tools || request.tools.length === 0) {
      return [];
    }
    return request.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.inputSchema),
      },
    }));
  }

  private buildMessages(request: ModelRequest): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        result.push({ role: 'system', content: msg.content });
      } else if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: msg.content || null,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        result.push(assistantMsg);
      } else if (msg.role === 'tool' && msg.toolResult) {
        result.push({
          role: 'tool',
          tool_call_id: msg.toolResult.toolCallId,
          content: msg.toolResult.content,
        });
      }
    }

    return result;
  }
}
