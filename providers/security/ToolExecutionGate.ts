import type { ToolCall, ToolDefinition } from '../../types/index.js';
import type { UnifiedStreamEvent } from '../core/BaseModel.js';
import { ProviderError } from '../core/ProviderErrors.js';

export interface ToolGateOptions {
  maxPayloadBytes?: number;
  maxAggregatePayloadBytes?: number;
  maxToolCallCount?: number;
  strictSchemaValidation?: boolean;
  turnBudget?: TurnBudgetTracker;
}

/**
 * Tracks and enforces tool payload budgets and tool quotas across an entire agent turn,
 * maintaining cumulative limits through multi-model iterations, retries, and fallbacks.
 */
export class TurnBudgetTracker {
  private _consumedBytes = 0;
  private _recordedToolCallIds = new Set<string>();
  readonly maxPayloadBytes: number;
  readonly maxAggregatePayloadBytes: number;
  readonly maxToolCallCount: number;

  constructor(options: ToolGateOptions = {}) {
    this.maxPayloadBytes = options.maxPayloadBytes ?? ToolExecutionGate.DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxAggregatePayloadBytes = options.maxAggregatePayloadBytes ?? ToolExecutionGate.DEFAULT_MAX_AGGREGATE_PAYLOAD_BYTES;
    this.maxToolCallCount = options.maxToolCallCount ?? ToolExecutionGate.DEFAULT_MAX_TOOL_CALL_COUNT;
  }

  recordToolCallStart(callId: string): void {
    if (!this._recordedToolCallIds.has(callId)) {
      if (this._recordedToolCallIds.size >= this.maxToolCallCount) {
        throw new ProviderError({
          code: 'INVALID_REQUEST',
          message: `REJECT_TOOL_COUNT_EXCEEDED: Number of tool calls exceeds maximum turn quota of ${this.maxToolCallCount}`,
          retryable: false,
        });
      }
      this._recordedToolCallIds.add(callId);
    }
  }

  recordDeltaBytes(deltaBytes: number): void {
    this._consumedBytes += deltaBytes;
    if (this._consumedBytes > this.maxAggregatePayloadBytes) {
      throw new ProviderError({
        code: 'INVALID_REQUEST',
        message: `REJECT_AGGREGATE_PAYLOAD_TOO_LARGE: Aggregate tool arguments (${this._consumedBytes} bytes) exceed total turn budget of ${this.maxAggregatePayloadBytes} bytes`,
        retryable: false,
      });
    }
  }

  get consumedBytes(): number {
    return this._consumedBytes;
  }

  get toolCount(): number {
    return this._recordedToolCallIds.size;
  }

  hasToolCall(callId: string): boolean {
    return this._recordedToolCallIds.has(callId);
  }
}

export class ToolExecutionGate {
  static readonly DEFAULT_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB per individual tool call
  static readonly DEFAULT_MAX_AGGREGATE_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB total across all tool calls
  static readonly DEFAULT_MAX_TOOL_CALL_COUNT = 32; // Maximum tool calls permitted in a single turn

  /**
   * Validate a completed tool call against registration, schema, duplicates, and payload size budget
   */
  static validateToolCall(
    toolCall: ToolCall,
    availableTools?: ToolDefinition[],
    seenCallIds?: Set<string>,
    options: ToolGateOptions = {}
  ): void {
    const maxPayload = options.maxPayloadBytes ?? ToolExecutionGate.DEFAULT_MAX_PAYLOAD_BYTES;

    // 1. Payload size guard
    const payloadSize = toolCall.rawArguments
      ? Buffer.byteLength(toolCall.rawArguments, 'utf8')
      : Buffer.byteLength(JSON.stringify(toolCall.arguments ?? {}), 'utf8');

    if (payloadSize > maxPayload) {
      throw new ProviderError({
        code: 'INVALID_REQUEST',
        message: `REJECT_TOOL_PAYLOAD_TOO_LARGE: Tool call '${toolCall.name}' payload (${payloadSize} bytes) exceeds budget of ${maxPayload} bytes`,
        retryable: false,
      });
    }

    // 2. Duplicate call ID rejection
    if (seenCallIds) {
      if (seenCallIds.has(toolCall.id)) {
        throw new ProviderError({
          code: 'INVALID_REQUEST',
          message: `REJECT_DUPLICATE_TOOL_CALL_ID: Duplicate tool_call id '${toolCall.id}' detected in stream`,
          retryable: false,
        });
      }
      seenCallIds.add(toolCall.id);
    }

    // 3. Tool whitelist check
    if (availableTools && availableTools.length > 0) {
      const toolDef = availableTools.find((t) => t.name === toolCall.name);
      if (!toolDef) {
        throw new ProviderError({
          code: 'INVALID_REQUEST',
          message: `REJECT_UNREGISTERED_TOOL: Tool '${toolCall.name}' is not registered in active toolset`,
          retryable: false,
        });
      }

      // 4. Schema conformance validation via Zod
      if (toolDef.inputSchema) {
        let args = toolCall.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            // Keep original if not JSON
          }
        }
        let parseResult = toolDef.inputSchema.safeParse(args);
        if (!parseResult.success && args && typeof args === 'object' && !Array.isArray(args)) {
          // Attempt smart coercion based on schema validation issues
          const coerced: Record<string, unknown> = { ...(args as Record<string, unknown>) };
          let changed = false;
          for (const issue of parseResult.error.issues) {
            const key = issue.path[0];
            if (typeof key === 'string' && key in coerced) {
              const val = coerced[key];
              // 1. Array expected, string or primitive received
              if (issue.code === 'invalid_type' && issue.expected === 'array') {
                if (typeof val === 'string') {
                  coerced[key] = val.split(',').map((s) => s.trim()).filter(Boolean);
                  changed = true;
                } else if (val !== undefined && val !== null) {
                  coerced[key] = [val];
                  changed = true;
                }
              }
              // 2. String expected, number, boolean or object received
              else if (issue.code === 'invalid_type' && issue.expected === 'string') {
                if (typeof val === 'number' || typeof val === 'boolean') {
                  coerced[key] = String(val);
                  changed = true;
                } else if (typeof val === 'object' && val !== null) {
                  coerced[key] = JSON.stringify(val);
                  changed = true;
                }
              }
              // 3. Number expected, numeric string received
              else if (issue.code === 'invalid_type' && issue.expected === 'number' && typeof val === 'string') {
                const parsedNum = Number(val);
                if (!isNaN(parsedNum)) {
                  coerced[key] = parsedNum;
                  changed = true;
                }
              }
              // 4. Boolean expected, string received
              else if (issue.code === 'invalid_type' && issue.expected === 'boolean' && typeof val === 'string') {
                if (val.toLowerCase() === 'true' || val === '1') {
                  coerced[key] = true;
                  changed = true;
                } else if (val.toLowerCase() === 'false' || val === '0') {
                  coerced[key] = false;
                  changed = true;
                }
              }
            }
          }

          if (changed) {
            const retryParse = toolDef.inputSchema.safeParse(coerced);
            if (retryParse.success) {
              parseResult = retryParse;
            }
          }
        }

        if (!parseResult.success) {
          throw new ProviderError({
            code: 'INVALID_REQUEST',
            message: `INVALID_TOOL_ARGUMENTS: Arguments for tool '${toolCall.name}' failed schema validation: ${parseResult.error.message}`,
            retryable: false,
            rawError: parseResult.error,
          });
        }
        toolCall.arguments = parseResult.data;
      }
    }
  }

  /**
   * Wrap an async event stream with tool boundary security checks, upstream cancellation,
   * per-call budget limits, aggregate payload limits, and maximum tool call count quotas.
   * If turnBudget is provided, budget and quotas accumulate across retries and model fallbacks.
   */
  static async *wrapStream(
    stream: AsyncIterable<UnifiedStreamEvent>,
    availableTools?: ToolDefinition[],
    options: ToolGateOptions = {}
  ): AsyncGenerator<UnifiedStreamEvent> {
    const tracker = options.turnBudget ?? new TurnBudgetTracker(options);
    const completedCallIds = new Set<string>();
    const deltaBytesByCall = new Map<string, number>();

    const maxPayload = tracker.maxPayloadBytes;

    try {
      for await (const event of stream) {
        if (event.type === 'tool_call.start') {
          tracker.recordToolCallStart(event.callId);
          yield event;
        } else if (event.type === 'tool_call.delta') {
          const deltaSize = Buffer.byteLength(event.inputDelta, 'utf8');

          // Check individual call payload limit
          const prev = deltaBytesByCall.get(event.callId) || 0;
          const callTotal = prev + deltaSize;
          if (callTotal > maxPayload) {
            throw new ProviderError({
              code: 'INVALID_REQUEST',
              message: `REJECT_TOOL_PAYLOAD_TOO_LARGE: Tool call id '${event.callId}' streamed arguments exceed budget of ${maxPayload} bytes`,
              retryable: false,
            });
          }
          deltaBytesByCall.set(event.callId, callTotal);

          // Track and check aggregate turn payload limit
          tracker.recordDeltaBytes(deltaSize);

          yield event;
        } else if (event.type === 'tool_call.ready') {
          tracker.recordToolCallStart(event.toolCall.id);
          ToolExecutionGate.validateToolCall(event.toolCall, availableTools, completedCallIds, options);
          yield event;
        } else {
          yield event;
        }
      }
    } catch (err) {
      // Actively cancel upstream stream to abort connection and close network socket
      if (typeof (stream as AsyncGenerator).return === 'function') {
        try {
          await (stream as AsyncGenerator).return(undefined);
        } catch {
          // Ignore cancellation errors
        }
      }

      const normalized = ProviderError.fromUnknown(err);
      yield { type: 'error', error: normalized };
    }
  }
}
