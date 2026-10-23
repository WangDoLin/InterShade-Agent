import { SecretScrubber } from '../../security/SecretScrubber.js';

export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
}

export interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramWebhookPayload {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    data: string;
    message?: {
      message_id: number;
      chat?: TelegramChat;
    };
  };
}

export interface TelegramFormattedResponse {
  chatId: number;
  text: string;
  parseMode: 'MarkdownV2' | 'HTML';
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

export interface ParsedTelegramUpdate {
  type: 'message' | 'callback_query' | 'unknown';
  updateId: number;
  chatId?: number;
  messageId?: number;
  senderId?: number;
  text?: string;
  action?: string;
  nonce?: string;
  decision?: 'approve' | 'reject';
}

export interface ApprovalFormatOptions {
  nonce?: string;
  shortCode?: string;
}

const MAX_DIFF_PREVIEW_CHARS = 1500;

export class TelegramAdapter {
  /**
   * Formats an approval request message with interactive Proceed/Reject inline buttons.
   * Automatically scrubs diffSummary and goal via SecretScrubber to prevent secret leakage (NEXT-B-08),
   * and binds callback_data to one-time nonces (`ap:<nonce>` / `rj:<nonce>`) when provided (NEXT-B-04).
   */
  static formatApprovalRequest(
    chatId: number,
    taskId: string,
    goal: string,
    diffSummary: string,
    options?: ApprovalFormatOptions,
  ): TelegramFormattedResponse {
    const scrubbedGoal = SecretScrubber.sanitize(goal);
    const scrubbedDiff = SecretScrubber.sanitize(diffSummary);

    const isTruncated = scrubbedDiff.length > MAX_DIFF_PREVIEW_CHARS;
    const previewBody = this.escapeHtml(scrubbedDiff.slice(0, MAX_DIFF_PREVIEW_CHARS));
    const truncationNote = isTruncated
      ? `\n[... truncated ${scrubbedDiff.length - MAX_DIFF_PREVIEW_CHARS} chars — inspect full diff on terminal]`
      : '';

    const confirmTarget = options?.shortCode || (options?.nonce ? options.nonce.slice(0, 8) : taskId);
    const approveCallback = options?.nonce ? `ap:${options.nonce}` : `approve:${taskId}`;
    const rejectCallback = options?.nonce ? `rj:${options.nonce}` : `reject:${taskId}`;

    const text = [
      `<b>InterShader Approval Request</b>`,
      `<b>Task:</b> <code>${this.escapeHtml(taskId)}</code>`,
      `<b>Goal:</b> ${this.escapeHtml(scrubbedGoal)}`,
      ``,
      `<b>Diff Preview:</b>`,
      `<pre>${previewBody}${truncationNote}</pre>`,
      ``,
      `<b>Safe Actions (Prevent Accidental Click):</b>`,
      `• Type: <code>/confirm ${this.escapeHtml(confirmTarget)}</code> to verify and execute`,
      `• Type: <code>/reject ${this.escapeHtml(confirmTarget)}</code> to decline`,
      `• Or tap quick action button below:`,
    ].join('\n');

    return {
      chatId,
      text,
      parseMode: 'HTML',
      replyMarkup: {
        inline_keyboard: [
          [
            { text: '[Proceed] Approve', callback_data: approveCallback },
            { text: '[Reject] Reject', callback_data: rejectCallback },
          ],
        ],
      },
    };
  }

  /**
   * Parses an incoming webhook update from Telegram Bot API with accurate `chat.id` (TG-1),
   * `senderId`, `updateId`, and one-time nonce extraction (`ap:<nonce>` / `rj:<nonce>`).
   */
  static parseWebhookUpdate(payload: TelegramWebhookPayload): ParsedTelegramUpdate {
    if (payload.callback_query) {
      const data = payload.callback_query.data || '';
      const chatId = payload.callback_query.message?.chat?.id;
      const messageId = payload.callback_query.message?.message_id;
      const senderId = payload.callback_query.from?.id;

      let nonce: string | undefined;
      let decision: 'approve' | 'reject' | undefined;
      if (data.startsWith('ap:')) {
        nonce = data.slice(3);
        decision = 'approve';
      } else if (data.startsWith('rj:')) {
        nonce = data.slice(3);
        decision = 'reject';
      } else if (data.startsWith('approve:')) {
        nonce = data.slice('approve:'.length);
        decision = 'approve';
      } else if (data.startsWith('reject:')) {
        nonce = data.slice('reject:'.length);
        decision = 'reject';
      }

      return {
        type: 'callback_query',
        updateId: payload.update_id,
        chatId,
        messageId,
        senderId,
        action: data,
        nonce,
        decision,
      };
    }

    if (payload.message && payload.message.text) {
      const trimmed = payload.message.text.trim();
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      const targetId = parts[1];
      const senderId = payload.message.from?.id;

      if (cmd === '/confirm' || cmd === '/approve') {
        return {
          type: 'message',
          updateId: payload.update_id,
          chatId: payload.message.chat.id,
          messageId: payload.message.message_id,
          senderId,
          text: trimmed,
          action: targetId ? `approve:${targetId}` : 'approve',
          nonce: targetId,
          decision: 'approve',
        };
      }

      if (cmd === '/reject' || cmd === '/deny') {
        return {
          type: 'message',
          updateId: payload.update_id,
          chatId: payload.message.chat.id,
          messageId: payload.message.message_id,
          senderId,
          text: trimmed,
          action: targetId ? `reject:${targetId}` : 'reject',
          nonce: targetId,
          decision: 'reject',
        };
      }

      return {
        type: 'message',
        updateId: payload.update_id,
        chatId: payload.message.chat.id,
        messageId: payload.message.message_id,
        senderId,
        text: trimmed,
      };
    }

    return { type: 'unknown', updateId: payload.update_id };
  }

  private static escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
