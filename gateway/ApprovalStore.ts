import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ApprovalRecord {
  taskId: string;
  nonce: string;
  shortCode: string;
  chatId: number;
  senderScope?: number[];
  diffSha256: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  consumedAt?: number;
  decision?: 'approve' | 'reject';
}

export interface CreateApprovalParams {
  taskId: string;
  chatId: number;
  diffContent: string;
  senderScope?: number[];
  ttlSeconds?: number;
  now?: number;
}

export interface ConsumeApprovalParams {
  nonceOrCode: string;
  decision: 'approve' | 'reject';
  chatId: number;
  senderId: number;
  currentDiffContent: string;
  via?: 'telegram' | 'gateway';
  now?: number;
}

export interface ConsumeApprovalResult {
  valid: boolean;
  reason?:
    | 'NONCE_NOT_FOUND'
    | 'NONCE_ALREADY_CONSUMED'
    | 'NONCE_EXPIRED'
    | 'CHAT_MISMATCH'
    | 'UNAUTHORIZED_SENDER'
    | 'DIFF_MODIFIED_SINCE_APPROVAL';
  taskId?: string;
  decision?: 'approve' | 'reject';
}

export interface ApprovalAuditEntry {
  ts: string;
  taskId: string;
  via: 'telegram' | 'gateway';
  senderId: number;
  chatId: number;
  decision: string;
  reason?: string;
  nonceSuffix: string;
}

/**
 * Cryptographic one-time approval nonce store (NEXT-B-04).
 * Binds remote Telegram approvals to a specific taskId, chatId, sender allowlist,
 * TTL expiration, and SHA-256 digest of the exact diff under review.
 */
export class ApprovalStore {
  private records = new Map<string, ApprovalRecord>();
  private shortCodeIndex = new Map<string, string>();
  private auditLog: ApprovalAuditEntry[] = [];
  private auditFilePath?: string;

  constructor(options?: { stateDir?: string }) {
    if (options?.stateDir) {
      fs.mkdirSync(options.stateDir, { recursive: true });
      this.auditFilePath = path.join(options.stateDir, 'telegram-approvals-audit.jsonl');
    }
  }

  static computeDiffSha256(diffContent: string): string {
    return crypto.createHash('sha256').update(diffContent, 'utf8').digest('hex');
  }

  createApproval(params: CreateApprovalParams): ApprovalRecord {
    const now = params.now ?? Date.now();
    const ttlMs = (params.ttlSeconds ?? 600) * 1000;
    // 128-bit cryptographic nonce (32 hex chars) -> fits ap:<nonce> under 64-byte Telegram limit
    const nonce = crypto.randomBytes(16).toString('hex');
    const shortCode = nonce.slice(0, 8);
    const diffSha256 = ApprovalStore.computeDiffSha256(params.diffContent);

    const record: ApprovalRecord = {
      taskId: params.taskId,
      nonce,
      shortCode,
      chatId: params.chatId,
      senderScope: params.senderScope,
      diffSha256,
      createdAt: now,
      expiresAt: now + ttlMs,
      consumed: false,
    };

    this.records.set(nonce, record);
    this.shortCodeIndex.set(shortCode, nonce);
    return record;
  }

  verifyAndConsume(params: ConsumeApprovalParams): ConsumeApprovalResult {
    const now = params.now ?? Date.now();
    const via = params.via ?? 'telegram';
    const resolvedNonce = this.records.has(params.nonceOrCode)
      ? params.nonceOrCode
      : this.shortCodeIndex.get(params.nonceOrCode);

    if (!resolvedNonce) {
      this.recordAudit({
        ts: new Date(now).toISOString(),
        taskId: 'unknown',
        via,
        senderId: params.senderId,
        chatId: params.chatId,
        decision: 'rejected_invalid',
        reason: 'NONCE_NOT_FOUND',
        nonceSuffix: params.nonceOrCode.slice(-6),
      });
      return { valid: false, reason: 'NONCE_NOT_FOUND' };
    }

    const record = this.records.get(resolvedNonce)!;
    const nonceSuffix = record.nonce.slice(-6);

    if (record.consumed) {
      this.recordAudit({
        ts: new Date(now).toISOString(),
        taskId: record.taskId,
        via,
        senderId: params.senderId,
        chatId: params.chatId,
        decision: 'rejected_replay',
        reason: 'NONCE_ALREADY_CONSUMED',
        nonceSuffix,
      });
      return { valid: false, reason: 'NONCE_ALREADY_CONSUMED', taskId: record.taskId };
    }

    if (now > record.expiresAt) {
      record.consumed = true;
      record.consumedAt = now;
      this.recordAudit({
        ts: new Date(now).toISOString(),
        taskId: record.taskId,
        via,
        senderId: params.senderId,
        chatId: params.chatId,
        decision: 'expired',
        reason: 'NONCE_EXPIRED',
        nonceSuffix,
      });
      return { valid: false, reason: 'NONCE_EXPIRED', taskId: record.taskId };
    }

    if (record.chatId !== params.chatId) {
      this.recordAudit({
        ts: new Date(now).toISOString(),
        taskId: record.taskId,
        via,
        senderId: params.senderId,
        chatId: params.chatId,
        decision: 'rejected_scope',
        reason: 'CHAT_MISMATCH',
        nonceSuffix,
      });
      return { valid: false, reason: 'CHAT_MISMATCH', taskId: record.taskId };
    }

    if (record.senderScope && record.senderScope.length > 0 && !record.senderScope.includes(params.senderId)) {
      this.recordAudit({
        ts: new Date(now).toISOString(),
        taskId: record.taskId,
        via,
        senderId: params.senderId,
        chatId: params.chatId,
        decision: 'rejected_scope',
        reason: 'UNAUTHORIZED_SENDER',
        nonceSuffix,
      });
      return { valid: false, reason: 'UNAUTHORIZED_SENDER', taskId: record.taskId };
    }

    const currentSha256 = ApprovalStore.computeDiffSha256(params.currentDiffContent);
    if (currentSha256 !== record.diffSha256) {
      record.consumed = true;
      record.consumedAt = now;
      this.recordAudit({
        ts: new Date(now).toISOString(),
        taskId: record.taskId,
        via,
        senderId: params.senderId,
        chatId: params.chatId,
        decision: 'invalidated_diff_changed',
        reason: 'DIFF_MODIFIED_SINCE_APPROVAL',
        nonceSuffix,
      });
      return { valid: false, reason: 'DIFF_MODIFIED_SINCE_APPROVAL', taskId: record.taskId };
    }

    record.consumed = true;
    record.consumedAt = now;
    record.decision = params.decision;

    this.recordAudit({
      ts: new Date(now).toISOString(),
      taskId: record.taskId,
      via,
      senderId: params.senderId,
      chatId: params.chatId,
      decision: params.decision,
      nonceSuffix,
    });

    return {
      valid: true,
      taskId: record.taskId,
      decision: params.decision,
    };
  }

  getAuditLog(): readonly ApprovalAuditEntry[] {
    return this.auditLog;
  }

  private recordAudit(entry: ApprovalAuditEntry): void {
    this.auditLog.push(entry);
    if (this.auditFilePath) {
      try {
        fs.appendFileSync(this.auditFilePath, JSON.stringify(entry) + '\n', 'utf8');
      } catch {
        // Non-fatal if audit file cannot be written in read-only test dir
      }
    }
  }
}
