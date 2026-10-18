import path from 'path';
import { getDatabase } from './Database.js';
import type { UnifiedMessage, SessionState, SessionConfig } from '../types/index.js';
import { randomUUID } from 'crypto';

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  provider: string;
  cwd: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface GlobalUsageSummary {
  totalSessions: number;
  activeSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

/**
 * Session persistence and history store backed by SQLite WAL
 */
export class SessionStore {
  static createSession(config: SessionConfig, title = 'New Conversation'): SessionState {
    const db = getDatabase();
    const now = Date.now();
    const session: SessionState = {
      id: config.sessionId || randomUUID(),
      createdAt: now,
      updatedAt: now,
      model: config.model,
      provider: config.provider,
      cwd: config.cwd,
      permissionMode: config.permissionMode || 'default',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0.0,
    };

    const stmt = db.prepare(`
      INSERT INTO sessions (id, title, model, provider, cwd, permission_mode, total_input_tokens, total_output_tokens, total_cost_usd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.id,
      title,
      session.model,
      session.provider,
      session.cwd,
      session.permissionMode,
      session.totalInputTokens,
      session.totalOutputTokens,
      session.totalCostUsd,
      session.createdAt,
      session.updatedAt
    );

    return session;
  }

  static appendMessage(sessionId: string, message: UnifiedMessage): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO messages (id, session_id, role, content, tool_calls_json, tool_result_json, tool_call_id, thought, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      sessionId,
      message.role,
      message.content,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolResult ? JSON.stringify(message.toolResult) : null,
      message.toolCallId || null,
      message.thought || null,
      message.timestamp
    );

    const updateSession = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`);
    updateSession.run(Date.now(), sessionId);
  }

  static getMessages(sessionId: string): UnifiedMessage[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT id, role, content, tool_calls_json, tool_result_json, tool_call_id, thought, timestamp
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(sessionId) as Array<{
      id: string;
      role: string;
      content: string;
      tool_calls_json: string | null;
      tool_result_json: string | null;
      tool_call_id: string | null;
      thought: string | null;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      role: row.role as UnifiedMessage['role'],
      content: row.content,
      toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) : undefined,
      toolResult: row.tool_result_json ? JSON.parse(row.tool_result_json) : undefined,
      toolCallId: row.tool_call_id || undefined,
      thought: row.thought || undefined,
      timestamp: row.timestamp,
    }));
  }

  static getSession(sessionId: string): SessionState | null {
    if (!sessionId || !sessionId.trim()) return null;
    const cleanId = sessionId.trim();
    const db = getDatabase();

    // Try exact ID match first, then prefix match if cleanId is at least 4 characters
    const stmt = db.prepare(`
      SELECT id, title, model, provider, cwd, permission_mode, total_input_tokens, total_output_tokens, total_cost_usd, created_at, updated_at
      FROM sessions
      WHERE id = ? OR (length(?) >= 4 AND id LIKE ? || '%')
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const row = stmt.get(cleanId, cleanId, cleanId) as {
      id: string;
      title: string;
      model: string;
      provider: string;
      cwd: string;
      permission_mode: string;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd: number;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      model: row.model,
      provider: row.provider,
      cwd: row.cwd,
      permissionMode: row.permission_mode as SessionState['permissionMode'],
      totalInputTokens: row.total_input_tokens || 0,
      totalOutputTokens: row.total_output_tokens || 0,
      totalCostUsd: row.total_cost_usd || 0.0,
    };
  }

  static findLatestSession(cwd?: string): SessionState | null {
    const targetCwd = cwd || process.cwd();
    const normalizedTarget = path.resolve(targetCwd);
    const db = getDatabase();

    // 1. Direct match with case-insensitivity
    let stmt = db.prepare(`
      SELECT id, title, model, provider, cwd, permission_mode, total_input_tokens, total_output_tokens, total_cost_usd, created_at, updated_at
      FROM sessions
      WHERE cwd = ? COLLATE NOCASE OR cwd = ? COLLATE NOCASE
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    let row = stmt.get(targetCwd, normalizedTarget) as any;

    // 2. Subpath or workspace parent directory match
    if (!row) {
      stmt = db.prepare(`
        SELECT id, title, model, provider, cwd, permission_mode, total_input_tokens, total_output_tokens, total_cost_usd, created_at, updated_at
        FROM sessions
        WHERE (? LIKE cwd || '%' OR cwd LIKE ? || '%') COLLATE NOCASE
        ORDER BY updated_at DESC
        LIMIT 1
      `);
      row = stmt.get(normalizedTarget, normalizedTarget) as any;
    }

    // 3. Fallback: Most recent session in database to prevent unwanted session resets across terminal instances
    if (!row) {
      stmt = db.prepare(`
        SELECT id, title, model, provider, cwd, permission_mode, total_input_tokens, total_output_tokens, total_cost_usd, created_at, updated_at
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT 1
      `);
      row = stmt.get() as any;
    }

    if (!row) return null;

    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      model: row.model,
      provider: row.provider,
      cwd: row.cwd,
      permissionMode: row.permission_mode as SessionState['permissionMode'],
      totalInputTokens: row.total_input_tokens || 0,
      totalOutputTokens: row.total_output_tokens || 0,
      totalCostUsd: row.total_cost_usd || 0.0,
    };
  }

  /**
   * Retrieves a list of recent conversation sessions.
   */
  static listSessions(limit = 10): SessionSummary[] {
    const db = getDatabase();
    try {
      const stmt = db.prepare(`
        SELECT id, title, model, provider, cwd, total_input_tokens, total_output_tokens, total_cost_usd, created_at, updated_at
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(limit) as Array<{
        id: string;
        title: string;
        model: string;
        provider: string;
        cwd: string;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost_usd: number;
        created_at: number;
        updated_at: number;
      }>;

      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        model: r.model,
        provider: r.provider,
        cwd: r.cwd,
        totalInputTokens: r.total_input_tokens || 0,
        totalOutputTokens: r.total_output_tokens || 0,
        totalCostUsd: r.total_cost_usd || 0.0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Calculates total token usage and financial cost across all historical conversations.
   */
  static getTotalUsage(): GlobalUsageSummary {
    const db = getDatabase();
    try {
      const stmt = db.prepare(`
        SELECT 
          COUNT(*) as total_sessions,
          SUM(CASE WHEN total_input_tokens > 0 OR total_output_tokens > 0 THEN 1 ELSE 0 END) as active_sessions,
          SUM(total_input_tokens) as total_in,
          SUM(total_output_tokens) as total_out,
          SUM(total_cost_usd) as total_cost
        FROM sessions
      `);
      const row = stmt.get() as {
        total_sessions: number;
        active_sessions: number;
        total_in: number | null;
        total_out: number | null;
        total_cost: number | null;
      };

      const tin = row.total_in || 0;
      const tout = row.total_out || 0;
      return {
        totalSessions: row.total_sessions || 0,
        activeSessions: row.active_sessions || 0,
        totalInputTokens: tin,
        totalOutputTokens: tout,
        totalTokens: tin + tout,
        totalCostUsd: row.total_cost || 0.0,
      };
    } catch {
      return {
        totalSessions: 0,
        activeSessions: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0.0,
      };
    }
  }

  static updateUsage(sessionId: string, inputTokens: number, outputTokens: number, costUsd = 0): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE sessions
      SET total_input_tokens = total_input_tokens + ?,
          total_output_tokens = total_output_tokens + ?,
          total_cost_usd = total_cost_usd + ?,
          updated_at = ?
      WHERE id = ?
    `);

    stmt.run(inputTokens, outputTokens, costUsd, Date.now(), sessionId);
  }

  static updateModel(sessionId: string, provider: string, model: string): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE sessions
      SET provider = ?,
          model = ?,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(provider, model, Date.now(), sessionId);
  }

  static recordFileSnapshot(
    sessionId: string,
    filePath: string,
    contentBefore: string,
    contentAfter: string,
    diff: string
  ): string {
    const db = getDatabase();
    const id = randomUUID();
    const stmt = db.prepare(`
      INSERT INTO file_snapshots (id, session_id, file_path, content_before, content_after, diff, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, sessionId, filePath, contentBefore, contentAfter, diff, Date.now());
    return id;
  }

  /**
   * Retrieves the list of files successfully modified or created during a session.
   */
  static getModifiedFiles(sessionId: string): string[] {
    const db = getDatabase();
    try {
      const stmt = db.prepare(`
        SELECT DISTINCT file_path
        FROM file_snapshots
        WHERE session_id = ?
        ORDER BY created_at ASC
      `);
      const rows = stmt.all(sessionId) as Array<{ file_path: string }>;
      return rows.map((r) => r.file_path);
    } catch {
      return [];
    }
  }

  /**
   * Permanently deletes a session and all its associated messages, file snapshots, tasks, and memories.
   */
  static deleteSession(sessionId: string): boolean {
    const db = getDatabase();
    try {
      db.prepare(`DELETE FROM memories WHERE session_id = ?`).run(sessionId);
      db.prepare(`DELETE FROM session_plans WHERE session_id = ?`).run(sessionId);
      const res = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
      return (res && typeof res.changes === 'number') ? res.changes > 0 : true;
    } catch {
      try {
        db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
        db.prepare(`DELETE FROM file_snapshots WHERE session_id = ?`).run(sessionId);
        db.prepare(`DELETE FROM tasks WHERE session_id = ?`).run(sessionId);
        db.prepare(`DELETE FROM session_plans WHERE session_id = ?`).run(sessionId);
        const res = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
        return (res && typeof res.changes === 'number') ? res.changes > 0 : true;
      } catch {
        return false;
      }
    }
  }
}

