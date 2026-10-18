import { z } from 'zod';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
  thoughtSignature?: string;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface UnifiedMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
  toolCallId?: string;
  thought?: string;
  timestamp: number;
  /** When true, this message is permanently preserved across compaction and trajectory compression */
  isPinned?: boolean;
}

export interface ToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput, any, any>;
  isReadOnly: boolean;
  isDestructive: boolean;
  requiresPermission: boolean;
  isDeferred?: boolean;
  execute(args: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface PermissionRequestDetails {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  respond: (approved: boolean, remember?: boolean) => void;
}

export interface UserQuestionRequest {
  id: string;
  question: string;
  options?: string[];
  allowCustomInput?: boolean;
  respond: (answer: string) => void;
}

export interface ToolExecutionContext {
  sessionId: string;
  cwd: string;
  permissionMode: PermissionMode;
  signal?: AbortSignal;
  onProgress?: (progress: string) => void;
  askConfirmation?: (prompt: string, details?: PermissionRequestDetails) => Promise<boolean>;
  askQuestion?: (question: string, options?: string[], allowCustomInput?: boolean) => Promise<string>;
}

export type PermissionMode =
  | 'default'
  | 'plan'
  | 'auto'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk';

export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; delta: string }
  | { type: 'tool_call_done'; toolCall: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  | { type: 'finish'; reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' }
  | { type: 'error'; error: Error };

export interface SessionConfig {
  sessionId?: string;
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'deepseek' | string;
  model: string;
  cwd: string;
  maxTokens: number;
  temperature?: number;
  thinkingBudget?: number;
  speedMode?: 'normal' | 'fast' | 'turbo';
  systemPrompt?: string;
  permissionMode: PermissionMode;
  enableDualLoop?: boolean;
  proofMode?: boolean;
  resumeSession?: boolean;
  maxTurns?: number;
  maxingMode?: boolean;
  maxingBudget?: number;
}

export interface SessionState {
  id: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  provider: string;
  cwd: string;
  permissionMode: PermissionMode;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  speedMode?: 'normal' | 'fast' | 'turbo';
  thinkingBudget?: number;
  totalCachedTokens?: number;
  maxingMode?: boolean;
  maxingBudget?: number;
  maxTurns?: number;
}

export interface PromptTurnEntry {
  turnIndex: number;
  promptId: string;
  promptText: string;
  timestamp: number;
  messages: UnifiedMessage[];
}

