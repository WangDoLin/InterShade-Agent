import { GoogleGenerativeAI } from '@google/generative-ai';
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

export class GeminiAdapter implements ProtocolAdapter {
  readonly protocolId = 'google-genai';

  static normalizeModelName(rawModel?: string): string {
    if (!rawModel) return 'gemini-2.5-flash';
    const m = rawModel.trim().toLowerCase();
    if (m === 'gemini-flash' || m === 'flash') return 'gemini-2.5-flash';
    if (m === 'gemini-pro' || m === 'pro') return 'gemini-2.5-pro';
    return rawModel.trim();
  }

  createModel(connection: ConnectionProfile, descriptor: ModelDescriptor): LanguageModel {
    return new GeminiLanguageModel(connection, descriptor);
  }
}

class GeminiLanguageModel implements LanguageModel {
  readonly descriptor: ModelDescriptor;
  private readonly connection: ConnectionProfile;

  constructor(connection: ConnectionProfile, descriptor: ModelDescriptor) {
    this.connection = connection;
    this.descriptor = descriptor;
  }

  async *stream(request: ModelRequest): AsyncGenerator<UnifiedStreamEvent, void, unknown> {
    ConnectionRegistry.validateBaseURL(this.connection);
    const apiKey = ConnectionRegistry.resolveApiKey(this.connection) || process.env.GEMINI_API_KEY || '';

    const genAI = new GoogleGenerativeAI(apiKey);

    const functionDeclarations = (request.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.inputSchema),
    }));

    const systemMsg = request.messages.find((m) => m.role === 'system');
    const systemPrompt = systemMsg ? systemMsg.content : undefined;
    const effectiveModel = GeminiAdapter.normalizeModelName(request.modelId);

    const generationConfig: Record<string, unknown> = {
      temperature: request.generation?.temperature ?? 0.2,
      maxOutputTokens: request.generation?.maxTokens ?? 16384,
    };

    if (request.reasoning?.budgetTokens !== undefined && request.reasoning.budgetTokens > 0) {
      generationConfig.thinkingConfig = {
        thinkingBudget: request.reasoning.budgetTokens,
      };
    }

    try {
      yield { type: 'response.start' };

      const model = genAI.getGenerativeModel({
        model: effectiveModel,
        systemInstruction: systemPrompt,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations: functionDeclarations as any }] : undefined,
        generationConfig: generationConfig as any,
      });

      const contents = this.buildContents(request);

      let result: any;
      const MAX_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          result = await model.generateContentStream({ contents });
          break;
        } catch (streamErr: any) {
          const errMsg = streamErr?.message || '';
          const isRateLimit = errMsg.includes('429') || errMsg.includes('Quota exceeded') || errMsg.includes('Too Many Requests');
          const isSpike = errMsg.includes('503') || errMsg.includes('high demand') || errMsg.includes('Service Unavailable');
          if ((isRateLimit || isSpike) && attempt < MAX_RETRIES) {
            let waitMs = 2000 * Math.pow(2, attempt - 1);
            const match = errMsg.match(/retry in ([0-9.]+)s/);
            if (match && parseFloat(match[1])) {
              const seconds = parseFloat(match[1]);
              if (seconds <= 45) {
                waitMs = Math.ceil(seconds * 1000) + 1000;
              }
            }
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          throw streamErr;
        }
      }

      let hasToolCall = false;
      const seenCallIds = new Set<string>();
      let toolCallCounter = 0;

      for await (const chunk of result.stream) {
        const candidateParts = chunk.candidates?.[0]?.content?.parts || [];
        let hadPartText = false;

        for (const part of candidateParts) {
          const p = part as any;

          if (p.thought === true || p.thoughtSignature) {
            if (p.text) {
              yield { type: 'reasoning.delta', text: p.text };
              hadPartText = true;
            }
          } else if (p.text && !p.functionCall) {
            yield { type: 'text.delta', text: p.text };
            hadPartText = true;
          }

          const fc = p.functionCall;
          if (fc) {
            hasToolCall = true;
            toolCallCounter++;
            const toolCall: ToolCall = {
              id: fc.id || `gemini_call_${Date.now()}_${toolCallCounter}`,
              name: fc.name,
              arguments: (fc.args as Record<string, unknown>) || {},
              thoughtSignature: p.thoughtSignature,
            };
            ToolExecutionGate.validateToolCall(toolCall, request.tools, seenCallIds);
            yield { type: 'tool_call.start', callId: toolCall.id, name: toolCall.name };
            yield { type: 'tool_call.ready', toolCall };
          }
        }

        if (!hadPartText) {
          try {
            const text = chunk.text();
            if (text) {
              yield { type: 'text.delta', text };
            }
          } catch {
            // chunk.text() throws when chunk only contains functionCall
          }
        }
      }

      let isMaxTokens = false;
      try {
        const response = await result.response;
        const candidateFinish = response?.candidates?.[0]?.finishReason;
        if (candidateFinish === 'MAX_TOKENS') {
          isMaxTokens = true;
        }
        if (response?.usageMetadata) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: response.usageMetadata.promptTokenCount || 0,
              outputTokens: response.usageMetadata.candidatesTokenCount || 0,
            },
          };
        }
      } catch {
        // Fallback in QueryEngine handles token estimation if usage metadata fails
      }

      const finishReason = isMaxTokens ? 'max_tokens' : hasToolCall ? 'tool_use' : 'end_turn';
      yield { type: 'response.finish', reason: finishReason };
    } catch (err) {
      const normalized = ProviderError.fromUnknown(err);
      yield { type: 'error', error: normalized };
    }
  }

  /**
   * Build Gemini Content turns with strict functionCall / functionResponse pairing (PROV-001).
   * Injects synthetic [TOOL INTERRUPTED] responses if a turn was aborted mid-tool-call.
   */
  private buildContents(request: ModelRequest): any[] {
    const contents: any[] = [];
    const pendingFunctionCalls = new Map<string, string>(); // callId -> toolName

    const flushPendingAsInterrupted = (messageSuffix: string) => {
      if (pendingFunctionCalls.size === 0) return;
      const autoResponses: any[] = [];
      for (const [, toolName] of pendingFunctionCalls.entries()) {
        autoResponses.push({
          functionResponse: {
            name: toolName,
            response: {
              content: `[TOOL INTERRUPTED]: The tool "${toolName}" was not executed.${messageSuffix}`,
            },
          },
        });
      }
      contents.push({ role: 'user', parts: autoResponses });
      pendingFunctionCalls.clear();
    };

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        continue;
      }
      if (msg.role === 'user') {
        flushPendingAsInterrupted(' Operation cancelled or interrupted.');
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        flushPendingAsInterrupted('');
        const parts: any[] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            const part: any = {
              functionCall: {
                name: tc.name,
                args: tc.arguments,
              },
            };
            if (tc.thoughtSignature) {
              part.thoughtSignature = tc.thoughtSignature;
            }
            parts.push(part);
            pendingFunctionCalls.set(tc.id || tc.name, tc.name);
          }
        }
        contents.push({ role: 'model', parts });
      } else if (msg.role === 'tool' && msg.toolResult) {
        const responsePart = {
          functionResponse: {
            name: msg.toolResult.toolName,
            response: { content: msg.toolResult.content },
          },
        };

        pendingFunctionCalls.delete(msg.toolResult.toolCallId);
        pendingFunctionCalls.delete(msg.toolResult.toolName);

        const lastContent = contents[contents.length - 1];
        if (
          lastContent &&
          lastContent.role === 'user' &&
          Array.isArray(lastContent.parts) &&
          lastContent.parts.some((p: any) => p.functionResponse)
        ) {
          lastContent.parts.push(responsePart);
        } else {
          contents.push({
            role: 'user',
            parts: [responsePart],
          });
        }
      }
    }

    flushPendingAsInterrupted('');
    return contents;
  }
}
