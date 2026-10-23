export interface TelegramWebhookPayload {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    data: string;
    message?: {
      message_id: number;
      chat?: { id: number; type?: string };
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
}

const MAX_DIFF_PREVIEW_CHARS = 1500;

export class TelegramAdapter {
  /**
   * Formats an approval request message with interactive Proceed/Reject inline buttons.
   */
  static formatApprovalRequest(
    chatId: number,
    taskId: string,
    goal: string,
    diffSummary: string,
  ): TelegramFormattedResponse {
    const isTruncated = diffSummary.length > MAX_DIFF_PREVIEW_CHARS;
    const previewBody = this.escapeHtml(diffSummary.slice(0, MAX_DIFF_PREVIEW_CHARS));
    const truncationNote = isTruncated
      ? `\n[... truncated ${diffSummary.length - MAX_DIFF_PREVIEW_CHARS} chars — inspect full diff on terminal]`
      : '';

    const text = [
      `<b>InterShader Approval Request</b>`,
      `<b>Task:</b> <code>${this.escapeHtml(taskId)}</code>`,
      `<b>Goal:</b> ${this.escapeHtml(goal)}`,
      ``,
      `<b>Diff Preview:</b>`,
      `<pre>${previewBody}${truncationNote}</pre>`,
      ``,
      `<b>Safe Actions (Prevent Accidental Click):</b>`,
      `• Type: <code>/confirm ${this.escapeHtml(taskId)}</code> to verify and execute`,
      `• Type: <code>/reject ${this.escapeHtml(taskId)}</code> to decline`,
      `• Or tap quick action button below:`,
    ].join('\n');

    return {
      chatId,
      text,
      parseMode: 'HTML',
      replyMarkup: {
        inline_keyboard: [
          [
            { text: '[Proceed] Approve', callback_data: `approve:${taskId}` },
            { text: '[Reject] Reject', callback_data: `reject:${taskId}` },
          ],
        ],
      },
    };
  }

  /**
   * Parses an incoming webhook update from Telegram Bot API with accurate chat.id and senderId extraction.
   */
  static parseWebhookUpdate(payload: TelegramWebhookPayload): ParsedTelegramUpdate {
    if (payload.callback_query) {
      const data = payload.callback_query.data;
      const chatId = payload.callback_query.message?.chat?.id;
      const messageId = payload.callback_query.message?.message_id;
      const senderId = payload.callback_query.from?.id;
      return {
        type: 'callback_query',
        updateId: payload.update_id,
        chatId,
        messageId,
        senderId,
        action: data,
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
