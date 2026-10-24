import type { UnifiedMessage } from '../../types/index.js';

export type ContinuationReason =
  | 'FORWARD_INTENT'
  | 'UNEXECUTED_CODE_BLOCK'
  | 'INCOMPLETE_PLAN_STEPS'
  | 'TRUNCATED_MAX_TOKENS'
  | 'INCOMPLETE_TOOL_ERROR_RECOVERY'
  | 'EMPTY_RESPONSE_RETRY'
  | 'NONE';

export interface ContinuationEvaluationParams {
  assistantContent: string;
  finishReason?: string;
  pendingToolCallsCount: number;
  lastToolTurnHadError: boolean;
  modifiedFilesCount: number;
  isProofModeActive: boolean;
  isPlanModeActive?: boolean;
  permissionMode?: string;
  recentMessages?: UnifiedMessage[];
}

export interface ContinuationDecision {
  shouldContinue: boolean;
  reason: ContinuationReason;
  intentSnippet?: string;
  nudgePrompt?: string;
  consecutiveNudges: number;
}

const ACTION_VERBS_VI =
  'bắt đầu|tiến hành|tiếp tục|kiểm tra|đọc|sửa|chỉnh sửa|tạo|chạy|thực hiện|xem|tìm|cập nhật|ghi|test|thử|deploy|triển khai|xóa|build|làm|xử lý|code|viết|fix|giải quyết|cấu hình|setup|khảo sát|thay đổi|áp dụng';

const ACTION_VERBS_EN =
  'inspect|read|edit|write|create|modify|run|check|test|investigate|look at|examine|update|execute|implement|verify|fix|build|continue|handle|process|proceed|do|solve|resolve|configure|setup|apply';

// Strict 1st-person declarations only (e.g. "tôi sẽ...", "để tôi..."). Never match loose words like "cần" or "bạn cần".
const INTENT_PATTERNS_VI: RegExp[] = [
  new RegExp(`\\b(?:tôi sẽ|bây giờ tôi sẽ|sau đây tôi sẽ|để tôi|hãy để tôi)\\s+(?:${ACTION_VERBS_VI})\\b[^.!?\\n]{0,80}`, 'i'),
];

const INTENT_PATTERNS_EN: RegExp[] = [
  new RegExp(`\\b(?:I will|I'll|now I will|next I will|let me|allow me to)\\s+(?:now\\s+)?(?:${ACTION_VERBS_EN})\\b[^.!?\\n]{0,80}`, 'i'),
];

const COMPLETION_PATTERNS: RegExp[] = [
  /^(?:đã hoàn thành|hoàn tất|tất cả thay đổi đã xong|tất cả các bước đã hoàn tất)/i,
  /\b(?:task completed?|all changes have been made|all tests passed|everything is complete|successfully finished)\b/i,
  /\b(?:here is the explanation|hope this helps|giải thích chi tiết|kết luận:)\b/i,
];

/**
 * AutonomousContinuationGuard ensures resilience for truncated tokens or empty model responses.
 * Strictly respects Plan Mode, User Confirmation, and Interactive Default Mode boundaries.
 * Prevents the agent from automatically exceeding authority or overriding the user.
 */
export class AutonomousContinuationGuard {
  private consecutiveNudges = 0;
  private readonly maxConsecutiveNudges: number;

  constructor(maxConsecutiveNudges: number = 2) {
    this.maxConsecutiveNudges = maxConsecutiveNudges;
  }

  /**
   * Resets consecutive nudges counter when a real tool call has been executed
   */
  resetConsecutive(): void {
    this.consecutiveNudges = 0;
  }

  /**
   * Returns current consecutive nudges count
   */
  getConsecutiveCount(): number {
    return this.consecutiveNudges;
  }

  /**
   * Evaluates whether the agentic loop should continue despite 0 tool calls in current turn
   */
  evaluateTurn(params: ContinuationEvaluationParams): ContinuationDecision {
    if (params.pendingToolCallsCount > 0) {
      this.resetConsecutive();
      return { shouldContinue: false, reason: 'NONE', consecutiveNudges: 0 };
    }

    if (this.consecutiveNudges >= this.maxConsecutiveNudges) {
      return { shouldContinue: false, reason: 'NONE', consecutiveNudges: this.consecutiveNudges };
    }

    // 1. Handle max_tokens or dangling unclosed syntax truncation (Always safe to recover text)
    if (params.finishReason === 'max_tokens' || this.isTextTruncated(params.assistantContent)) {
      return this.handleTruncation();
    }

    // 2. Handle empty response (Always safe to retry once)
    if (!params.assistantContent || params.assistantContent.trim().length === 0) {
      return this.handleEmptyResponse();
    }

    // 3. Plan Mode Protection: When in Plan Mode, the agent is strictly in safe read-only mode.
    // NEVER force tool execution or autonomous actions. The agent must present the plan and wait for user.
    if (params.isPlanModeActive) {
      return { shouldContinue: false, reason: 'NONE', consecutiveNudges: this.consecutiveNudges };
    }

    // 4. User Question / Confirmation Protection:
    // If the assistant ended with a question, asked for confirmation, or is waiting for user input,
    // MUST NOT continue autonomously! Yield immediately to the human user.
    if (this.isWaitingForUser(params.assistantContent)) {
      return { shouldContinue: false, reason: 'NONE', consecutiveNudges: this.consecutiveNudges };
    }

    // 4b. User Informational / Explanation Protection:
    // If the user's latest query is an informational/conceptual question (e.g. "tại sao...", "giải thích...", "so sánh...", "why...", "explain..."),
    // the assistant's response is an answer to the user's question, NOT an unfinished implementation step.
    // MUST NOT force tool execution or autonomous continuation!
    if (this.isUserInformationalQuery(params.recentMessages)) {
      return { shouldContinue: false, reason: 'NONE', consecutiveNudges: this.consecutiveNudges };
    }

    // 5. Skip continuation if assistant explicitly marked completion
    if (this.isExplicitlyComplete(params.assistantContent)) {
      return { shouldContinue: false, reason: 'NONE', consecutiveNudges: this.consecutiveNudges };
    }

    // 6. Handle forward action intent without tool execution
    const intentMatch = this.detectForwardIntent(params.assistantContent);
    if (intentMatch) {
      return this.handleForwardIntent(intentMatch);
    }

    // 7. Handle unaddressed tool error in previous turn
    if (params.lastToolTurnHadError) {
      return this.handleToolErrorRecovery();
    }

    // 8. Detect unexecuted code block in markdown when expected to apply
    const codeBlockFile = this.detectUnexecutedCodeBlock(params.assistantContent);
    if (codeBlockFile) {
      return this.handleUnexecutedCodeBlock(codeBlockFile);
    }

    // 9. Detect incomplete plan steps formulated in text without execution
    if (this.detectUnfinishedPlan(params.assistantContent, params.isPlanModeActive)) {
      return this.handleUnfinishedPlan(params.isPlanModeActive);
    }

    return { shouldContinue: false, reason: 'NONE', consecutiveNudges: this.consecutiveNudges };
  }

  private handleTruncation(): ContinuationDecision {
    this.consecutiveNudges++;
    return {
      shouldContinue: true,
      reason: 'TRUNCATED_MAX_TOKENS',
      consecutiveNudges: this.consecutiveNudges,
      nudgePrompt:
        '[AUTONOMOUS CONTINUATION]: Your previous response reached the token limit. Please resume your response directly from where you stopped.',
    };
  }

  private handleEmptyResponse(): ContinuationDecision {
    this.consecutiveNudges++;
    return {
      shouldContinue: true,
      reason: 'EMPTY_RESPONSE_RETRY',
      consecutiveNudges: this.consecutiveNudges,
      nudgePrompt:
        '[AUTONOMOUS CONTINUATION]: The provider returned an empty response. Please formulate your response to the user.',
    };
  }

  private handleForwardIntent(snippet: string): ContinuationDecision {
    this.consecutiveNudges++;
    return {
      shouldContinue: true,
      reason: 'FORWARD_INTENT',
      intentSnippet: snippet,
      consecutiveNudges: this.consecutiveNudges,
      nudgePrompt: `[AUTONOMOUS CONTINUATION]: You declared intent to take action ("${snippet}"). Please invoke the required tool to proceed, or present your findings to the user.`,
    };
  }

  private handleToolErrorRecovery(): ContinuationDecision {
    this.consecutiveNudges++;
    return {
      shouldContinue: true,
      reason: 'INCOMPLETE_TOOL_ERROR_RECOVERY',
      consecutiveNudges: this.consecutiveNudges,
      nudgePrompt:
        '[AUTONOMOUS CONTINUATION]: The previous tool execution encountered an error. Please inspect the diagnostic error and invoke the correcting tool call to resolve it.',
    };
  }

  private handleUnexecutedCodeBlock(fileHint?: string): ContinuationDecision {
    this.consecutiveNudges++;
    const targetFileSnippet = fileHint && fileHint !== 'the target file' ? ` for ${fileHint}` : '';
    return {
      shouldContinue: true,
      reason: 'UNEXECUTED_CODE_BLOCK',
      consecutiveNudges: this.consecutiveNudges,
      nudgePrompt: `[AUTONOMOUS CONTINUATION]: You provided a code implementation in markdown${targetFileSnippet}, but did not invoke any file modification tool. Do not simply print code blocks in text. Please invoke file_edit or file_write if this should be applied to the workspace.`,
    };
  }

  private handleUnfinishedPlan(isPlanMode?: boolean): ContinuationDecision {
    this.consecutiveNudges++;
    const nudgePrompt = isPlanMode
      ? '[AUTONOMOUS CONTINUATION]: You have formulated a plan. Please use the plan_mode tool (action="create" or action="update") to persist this plan into session memory and present the final plan.'
      : '[AUTONOMOUS CONTINUATION]: You formulated an implementation plan with ordered steps. Please proceed directly to execute Step 1 by invoking the required tool (such as file_read, grep_search, or file_edit), or confirm with the user.';

    return {
      shouldContinue: true,
      reason: 'INCOMPLETE_PLAN_STEPS',
      consecutiveNudges: this.consecutiveNudges,
      nudgePrompt,
    };
  }

  private isWaitingForUser(content?: string): boolean {
    if (!content) return false;
    const trimmed = content.trim();

    // Check trailing question mark
    if (trimmed.endsWith('?') || trimmed.endsWith('?\n') || trimmed.endsWith('?**') || trimmed.endsWith('?*')) {
      return true;
    }

    const lower = trimmed.toLowerCase();
    const questionMarkersVi = [
      'không?',
      'chưa?',
      'được không?',
      'như thế nào?',
      'bạn nghĩ sao?',
      'bạn có muốn',
      'bạn muốn',
      'vui lòng xác nhận',
      'hãy cho tôi biết',
      'nếu bạn đồng ý',
      'bạn có đồng ý',
      'hãy xác nhận',
      'xin ý kiến',
      'có cần điều chỉnh',
      'bạn có cần',
      'bạn muốn bắt đầu',
      'bạn chọn phương án',
      'lựa chọn nào',
    ];

    const questionMarkersEn = [
      'would you like',
      'do you want',
      'please confirm',
      'let me know',
      'what do you think',
      'shall we proceed',
      'should i proceed',
      'are you ready',
      'if you agree',
      'please let me know',
      'which option',
    ];

    return [...questionMarkersVi, ...questionMarkersEn].some((marker) => lower.includes(marker));
  }

  private detectForwardIntent(content: string): string | null {
    if (this.isWaitingForUser(content)) return null;

    for (const pat of [...INTENT_PATTERNS_VI, ...INTENT_PATTERNS_EN]) {
      const match = content.match(pat);
      if (match && match[0]) {
        // Disqualify if preceded by words indicating suggestion to user or condition
        const matchedIndex = match.index || 0;
        const prefix = content.slice(Math.max(0, matchedIndex - 30), matchedIndex).toLowerCase();
        if (prefix.includes('bạn') || prefix.includes('nếu') || prefix.includes('hoặc') || prefix.includes('chỉ cần')) {
          continue;
        }
        return match[0].trim();
      }
    }
    return null;
  }

  /**
   * Checks if the most recent user prompt in the session was an informational / conceptual question.
   * Informational Q&A responses must not be hijacked by autonomous coding continuation.
   */
  public isUserInformationalQuery(messages?: UnifiedMessage[]): boolean {
    if (!messages || messages.length === 0) return false;

    // Find the latest user message that is not a synthetic system/guard injection
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user') {
        const text = msg.content.trim();
        // Skip synthetic guard/continuation messages
        if (
          text.startsWith('[AUTONOMOUS CONTINUATION]') ||
          text.startsWith('[VERIFY-ON-STOP') ||
          text.startsWith('[MODE MAX INVARIANT')
        ) {
          continue;
        }

        const lower = text.toLowerCase();

        // Check if user specifically requested workspace modification actions
        const actionRequestRegex =
          /\b(?:hãy sửa|hãy fix|hãy tạo|hãy viết code vào|hãy chạy|implement|create file|write file|fix bug|apply change|refactor|chỉnh sửa file|thêm file)\b/i;
        if (actionRequestRegex.test(lower)) {
          return false;
        }

        // Informational question patterns (Vietnamese & English)
        const informationalPatternsVi = [
          /^(?:tại sao|vì sao|sao|tại vì sao|tại sao lại)\b/i,
          /\b(?:tại sao|vì sao|sao lại|liệu có|có phải|có nên|có tối ưu hơn)\b/i,
          /\b(?:là gì|thế nào|như thế nào|ra sao|có nghĩa là gì)\b/i,
          /\b(?:giải thích|so sánh|khác nhau thế nào|khác gì|phân tích|cho biết|tìm hiểu|tổng quan)\b/i,
          /\?$/
        ];

        const informationalPatternsEn = [
          /^(?:why|what|how|can you explain|explain|compare|tell me about)\b/i,
          /\b(?:why is|why does|what is|what are|how does|how do|difference between|is it better|should i)\b/i,
          /\?$/
        ];

        return [...informationalPatternsVi, ...informationalPatternsEn].some((pat) => pat.test(lower));
      }
    }

    return false;
  }

  private detectUnexecutedCodeBlock(content?: string): string | null {
    if (!content || this.isWaitingForUser(content)) return null;

    // Detect fenced code block with minimum content
    const codeBlockRegex = /```(?:[a-zA-Z0-9_-]*)\r?\n([\s\S]{20,}?)\r?\n```/;
    const match = content.match(codeBlockRegex);
    if (!match) return null;

    // Try to extract mentioned file path if present (e.g., "in file src/App.tsx", "file: index.ts")
    // Only return if an explicit file path is identified; illustrative examples must return null
    const fileHintRegex = /(?:file|trong file|tệp|đường dẫn|path)[:\s]+`?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)`?/i;
    const fileMatch = content.match(fileHintRegex);
    return fileMatch ? fileMatch[1] : null;
  }

  private detectUnfinishedPlan(content?: string, isPlanMode?: boolean): boolean {
    if (!content || this.isWaitingForUser(content)) return false;
    // In plan mode, do NOT nudge execution of steps
    if (isPlanMode) return false;

    const lower = content.toLowerCase();

    // MUST have an explicit implementation plan header declaration
    const hasPlanHeader =
      lower.includes('kế hoạch triển khai') ||
      lower.includes('kế hoạch thực hiện') ||
      lower.includes('kế hoạch chi tiết') ||
      lower.includes('implementation plan') ||
      lower.includes('action plan') ||
      lower.includes('các bước thực hiện:') ||
      lower.includes('steps to implement:');

    if (!hasPlanHeader) {
      return false;
    }

    // AND must have explicit action step indicators (e.g. Bước 1:, Step 1:)
    const hasSteps =
      /(?:bước 1[:\s-]|step 1[:\s-]|#step-1)/i.test(content) &&
      /(?:bước 2[:\s-]|step 2[:\s-]|#step-2)/i.test(content);

    return hasSteps;
  }

  private isTextTruncated(content?: string): boolean {
    if (!content || content.length < 50) return false;
    const trimmed = content.trim();

    // Check for unclosed markdown code block (odd number of triple backticks)
    const codeBlockCount = (trimmed.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      return true;
    }

    // Check for trailing incomplete syntax or dangling connective operators at end of output
    const trailingDanglingPattern =
      /(?:=>|->|&&|\|\||[({[+=:-]|\b(?:const|let|var|function|class|import|export|return))\s*$/;
    return trailingDanglingPattern.test(trimmed);
  }

  private isExplicitlyComplete(content: string): boolean {
    const trimmed = content.trim();
    return COMPLETION_PATTERNS.some((pat) => pat.test(trimmed));
  }
}
