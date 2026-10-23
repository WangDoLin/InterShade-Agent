import type { UnifiedMessage, ToolDefinition, ToolCall } from '../../types/index.js';
import type { ModelDescriptor } from '../catalog/ModelDescriptor.js';
import type { NormalizedProviderError } from './ProviderErrors.js';

export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface ReasoningOptions {
  budgetTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface ModelRequest {
  modelId: string;
  messages: UnifiedMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string };
  generation?: GenerationOptions;
  reasoning?: ReasoningOptions;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

export type UnifiedStreamEvent =
  | { type: 'response.start'; responseId?: string }
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool_call.start'; callId: string; name: string }
  | { type: 'tool_call.delta'; callId: string; inputDelta: string }
  | { type: 'tool_call.ready'; toolCall: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'response.finish'; reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'content_filter' }
  | { type: 'error'; error: NormalizedProviderError };

export interface LanguageModel {
  readonly descriptor: ModelDescriptor;
  stream(request: ModelRequest): AsyncGenerator<UnifiedStreamEvent, void, unknown>;
}
