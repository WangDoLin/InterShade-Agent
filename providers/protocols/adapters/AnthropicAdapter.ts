import { Anthropic } from '@anthropic-ai/sdk';
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

interface PendingAnthropicToolCall {
  id: string;
  name: string;
  rawJson: string;
}

export class AnthropicAdapter implements ProtocolAdapter {
  readonly protocolId = 'anthropic-messages';

  createModel(connection: ConnectionProfile, descriptor: ModelDescriptor): LanguageModel {
    return new AnthropicLanguageModel(connection, descriptor);
  }
}

class AnthropicLanguageModel implements LanguageModel {
  readonly descriptor: ModelDescriptor;
  private readonly connection: ConnectionProfile;

  constructor(connection: ConnectionProfile, descriptor: ModelDescriptor) {
    this.connection = connection;
    this.descriptor = descriptor;
  }

  async *stream(request: ModelRequest): AsyncGenerator<UnifiedStreamEvent, void, unknown> {
    ConnectionRegistry.validateBaseURL(this.connection);
    const apiKey = ConnectionRegistry.resolveApiKey(this.connection) || process.env.ANTHROPIC_API_KEY;

    const client = new Anthropic({
      apiKey,
      baseURL: this.connection.baseURL,
      defaultHeaders: this.connection.headers,
    });

    const anthropicTools = this.buildTools(request);
    const { systemPrompt, messages } = this.buildMessages(request);

    try {
      yield { type: 'response.start' };

      const isThinking = Boolean(
        request.reasoning?.budgetTokens &&
          request.reasoning.budgetTokens > 0 &&
          this.descriptor.capabilities.reasoningControl !== 'unsupported'
      );
      const budgetTokens = request.reasoning?.budgetTokens || 0;

      const systemBlocks: Anthropic.TextBlockParam[] | undefined = systemPrompt
        ? [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ]
        : undefined;

      const streamParams: Anthropic.MessageCreateParams = {
        model: request.modelId,
        max_tokens: isThinking
          ? Math.max(16384, budgetTokens + 8192)
          : (request.generation?.maxTokens ?? 8192),
        system: systemBlocks,
        messages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        temperature: isThinking ? 1.0 : (request.generation?.temperature ?? 0.2),
      };

      if (isThinking) {
        streamParams.thinking = {
          type: 'enabled',
          budget_tokens: budgetTokens,
        };
      }

      const stream = client.messages.stream(streamParams, {
        signal: request.signal,
      });

      const pendingToolCalls = new Map<number, PendingAnthropicToolCall>();
      const seenCallIds = new Set<string>();
      let hasToolCall = false;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            hasToolCall = true;
            const pending: PendingAnthropicToolCall = {
              id: block.id,
              name: block.name,
              rawJson: '',
            };
            pendingToolCalls.set(event.index, pending);
            yield { type: 'tool_call.start', callId: block.id, name: block.name };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield { type: 'text.delta', text: delta.text };
          } else if (delta.type === 'thinking_delta') {
            yield { type: 'reasoning.delta', text: delta.thinking };
          } else if (delta.type === 'input_json_delta') {
            const pending = pendingToolCalls.get(event.index);
            if (pending) {
              pending.rawJson += delta.partial_json;
              yield { type: 'tool_call.delta', callId: pending.id, inputDelta: delta.partial_json };
            }
          }
        } else if (event.type === 'content_block_stop') {
          const pending = pendingToolCalls.get(event.index);
          if (pending) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = pending.rawJson ? JSON.parse(pending.rawJson) : {};
            } catch (parseErr) {
              throw new ProviderError({
                code: 'INVALID_REQUEST',
                message: `Stream corrupted: Tool call '${pending.name}' arguments are truncated or invalid JSON: ${pending.rawJson}`,
                retryable: true,
                rawError: parseErr,
              });
            }
            const completedCall: ToolCall = {
              id: pending.id,
              name: pending.name,
              arguments: parsedArgs,
              rawArguments: pending.rawJson,
            };
            ToolExecutionGate.validateToolCall(completedCall, request.tools, seenCallIds);
            yield { type: 'tool_call.ready', toolCall: completedCall };
          }
        }
      }

      const finalMessage = await stream.finalMessage();
      if (finalMessage.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
            cacheReadTokens: (finalMessage.usage as unknown as Record<string, unknown>).cache_read_input_tokens as number | undefined,
          },
        };
      }

      const reason =
        finalMessage.stop_reason === 'tool_use' || hasToolCall
          ? 'tool_use'
          : finalMessage.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : 'end_turn';
      yield { type: 'response.finish', reason };
    } catch (err) {
      const normalized = ProviderError.fromUnknown(err);
      yield { type: 'error', error: normalized };
    }
  }

  private buildTools(request: ModelRequest): Anthropic.Tool[] {
    if (!request.tools || request.tools.length === 0) {
      return [];
    }
    const tools: Anthropic.Tool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.inputSchema) as Anthropic.Tool.InputSchema,
    }));
    if (tools.length > 0) {
      (tools[tools.length - 1] as unknown as Record<string, unknown>).cache_control = {
        type: 'ephemeral',
      };
    }
    return tools;
  }

  private buildMessages(request: ModelRequest): { systemPrompt: string; messages: Anthropic.MessageParam[] } {
    let systemPrompt = '';
    const messages: Anthropic.MessageParam[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content;
      } else if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }
        messages.push({ role: 'assistant', content: blocks });
      } else if (msg.role === 'tool' && msg.toolResult) {
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: msg.toolResult.toolCallId,
          content: msg.toolResult.content,
          is_error: msg.toolResult.isError,
        };
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as Anthropic.ContentBlockParam[]).push(toolResultBlock);
        } else {
          messages.push({
            role: 'user',
            content: [toolResultBlock],
          });
        }
      }
    }

    return { systemPrompt, messages };
  }
}
