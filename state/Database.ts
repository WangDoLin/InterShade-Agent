import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { config, ensureDataDir } from '../config/index.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const TARGET_SCHEMA_VERSION = 2;

let dbInstance: SqliteDatabase | null = null;

/**
 * Fold Vietnamese diacritics (including đ/Đ -> d) and normalize to lowercase ASCII
 * for accent-insensitive FTS5 indexing and search (NEXT-C-09).
 */
export function foldVietnameseText(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * Initialize SQLite connection with WAL (Write-Ahead Logging) mode,
 * 5000ms busy_timeout, and PRAGMA user_version schema migrations (STATE-DB-01..03, NEXT-C-09..18).
 */
export function getDatabase(): SqliteDatabase {
  if (dbInstance) {
    return dbInstance;
  }

  const dataDir = ensureDataDir(config.dataDir);
  const dbPath = path.join(dataDir, 'state.db');
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db: SqliteDatabase = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0.0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls_json TEXT,
      tool_result_json TEXT,
      tool_call_id TEXT,
      thought TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS file_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_before TEXT NOT NULL,
      content_after TEXT NOT NULL,
      diff TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      active_form TEXT,
      blocks TEXT NOT NULL,
      blocked_by TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (id, session_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      title_folded TEXT NOT NULL DEFAULT '',
      content_folded TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      session_id UNINDEXED,
      project_id UNINDEXED,
      type,
      title,
      content,
      title_folded,
      content_folded,
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS trg_memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts (id, session_id, project_id, type, title, content, title_folded, content_folded)
      VALUES (new.id, new.session_id, new.project_id, new.type, new.title, new.content, new.title_folded, new.content_folded);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_memories_au AFTER UPDATE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
      INSERT INTO memories_fts (id, session_id, project_id, type, title, content, title_folded, content_folded)
      VALUES (new.id, new.session_id, new.project_id, new.type, new.title, new.content, new.title_folded, new.content_folded);
    END;

    CREATE TABLE IF NOT EXISTS trajectories (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      prompt TEXT NOT NULL,
      stages_executed TEXT NOT NULL,
      changed_files TEXT NOT NULL,
      status TEXT NOT NULL,
      diff_stat TEXT,
      repro_evidence TEXT,
      tokens_used INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_plans (
      session_id TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      overview TEXT,
      plan_json TEXT NOT NULL,
      revisions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plan_revisions (
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      overview TEXT,
      steps_json TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      changelog_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, version),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS model_stats (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      task_type TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      tool_call_success INTEGER NOT NULL,
      proof_gate_passed INTEGER,
      recorded_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_snapshots_session ON file_snapshots(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_session_plans ON session_plans(session_id);
    CREATE INDEX IF NOT EXISTS idx_plan_revisions_session ON plan_revisions(session_id, version);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_trajectories_session ON trajectories(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_trajectories_task ON trajectories(task_id);
    CREATE INDEX IF NOT EXISTS idx_model_stats_model ON model_stats(model_id, task_type, recorded_at);
  `);

  runSchemaMigrations(db);

  dbInstance = db;
  return db;
}

/**
 * Versioned schema migration runner tracked via PRAGMA user_version (STATE-DB-01, NEXT-C-09, NEXT-C-13, NEXT-C-18).
 */
export function runSchemaMigrations(db: SqliteDatabase): void {
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const currentVersion = row?.user_version ?? 0;
    if (currentVersion >= TARGET_SCHEMA_VERSION) {
      return;
    }

    if (currentVersion < 1) {
      const tableInfo = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string; pk: number }>;
      const pkCols = tableInfo.filter((c) => c.pk > 0);
      if (pkCols.length === 1 && pkCols[0].name === 'id') {
        db.exec(`
          CREATE TABLE tasks_migrated (
            id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL,
            active_form TEXT,
            blocks TEXT NOT NULL,
            blocked_by TEXT NOT NULL,
            metadata TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (id, session_id),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          );
          INSERT OR IGNORE INTO tasks_migrated SELECT * FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_migrated RENAME TO tasks;
          CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at);
        `);
      }
    }

    if (currentVersion < 2) {
      // 1. Ensure memories has title_folded and content_folded columns (NEXT-C-09)
      const memCols = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
      const colNames = new Set(memCols.map((c) => c.name));
      if (!colNames.has('title_folded')) {
        db.exec(`ALTER TABLE memories ADD COLUMN title_folded TEXT NOT NULL DEFAULT '';`);
      }
      if (!colNames.has('content_folded')) {
        db.exec(`ALTER TABLE memories ADD COLUMN content_folded TEXT NOT NULL DEFAULT '';`);
      }

      // 2. Rebuild memories_fts and triggers with folded columns
      db.exec(`
        DROP TRIGGER IF EXISTS trg_memories_ai;
        DROP TRIGGER IF EXISTS trg_memories_ad;
        DROP TRIGGER IF EXISTS trg_memories_au;
        DROP TABLE IF EXISTS memories_fts;

        CREATE VIRTUAL TABLE memories_fts USING fts5(
          id UNINDEXED,
          session_id UNINDEXED,
          project_id UNINDEXED,
          type,
          title,
          content,
          title_folded,
          content_folded,
          tokenize='unicode61'
        );

        CREATE TRIGGER trg_memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts (id, session_id, project_id, type, title, content, title_folded, content_folded)
          VALUES (new.id, new.session_id, new.project_id, new.type, new.title, new.content, new.title_folded, new.content_folded);
        END;

        CREATE TRIGGER trg_memories_ad AFTER DELETE ON memories BEGIN
          DELETE FROM memories_fts WHERE id = old.id;
        END;

        CREATE TRIGGER trg_memories_au AFTER UPDATE ON memories BEGIN
          DELETE FROM memories_fts WHERE id = old.id;
          INSERT INTO memories_fts (id, session_id, project_id, type, title, content, title_folded, content_folded)
          VALUES (new.id, new.session_id, new.project_id, new.type, new.title, new.content, new.title_folded, new.content_folded);
        END;
      `);

      // 3. Backfill folded columns and FTS index for existing memory rows
      const existingMemories = db
        .prepare('SELECT id, title, content FROM memories')
        .all() as Array<{ id: string; title: string; content: string }>;
      const updateMemStmt = db.prepare(
        'UPDATE memories SET title_folded = ?, content_folded = ? WHERE id = ?'
      );
      for (const mem of existingMemories) {
        updateMemStmt.run(
          foldVietnameseText(mem.title),
          foldVietnameseText(mem.content),
          mem.id
        );
      }

      // 4. Backfill plan_revisions from existing session_plans.revisions_json (NEXT-C-13)
      const existingPlans = db
        .prepare('SELECT session_id, revisions_json FROM session_plans')
        .all() as Array<{ session_id: string; revisions_json: string }>;
      const insertRevStmt = db.prepare(`
        INSERT OR IGNORE INTO plan_revisions (
          session_id, version, title, overview, steps_json, acceptance_criteria_json, changelog_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const planRow of existingPlans) {
        try {
          const revisions = JSON.parse(planRow.revisions_json || '[]');
          if (Array.isArray(revisions)) {
            for (const rev of revisions) {
              insertRevStmt.run(
                planRow.session_id,
                Number(rev.version || 1),
                String(rev.title || 'Plan'),
                rev.overview ? String(rev.overview) : null,
                JSON.stringify(rev.steps || []),
                JSON.stringify(rev.acceptanceCriteria || []),
                JSON.stringify(rev.changelog || []),
                Number(rev.timestamp || Date.now())
              );
            }
          }
        } catch {
          // Ignore malformed legacy revisions_json
        }
      }

      db.exec(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION};`);
    }
  } catch {
    // Non-blocking migration fallback
  }
}

/**
 * Execute a synchronous callback inside an atomic SQLite transaction (STATE-DB-03).
 */
export function runInTransaction<T>(fn: (db: SqliteDatabase) => T): T {
  const db = getDatabase();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback error if transaction already closed
    }
    throw error;
  }
}
