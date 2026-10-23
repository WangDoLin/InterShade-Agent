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

const TARGET_SCHEMA_VERSION = 1;

let dbInstance: SqliteDatabase | null = null;

/**
 * Initialize SQLite connection with WAL (Write-Ahead Logging) mode,
 * 5000ms busy_timeout, and PRAGMA user_version schema migrations (STATE-DB-01..03).
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
      created_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      session_id UNINDEXED,
      project_id UNINDEXED,
      type,
      title,
      content,
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS trg_memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts (id, session_id, project_id, type, title, content)
      VALUES (new.id, new.session_id, new.project_id, new.type, new.title, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_memories_au AFTER UPDATE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
      INSERT INTO memories_fts (id, session_id, project_id, type, title, content)
      VALUES (new.id, new.session_id, new.project_id, new.type, new.title, new.content);
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

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_snapshots_session ON file_snapshots(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_session_plans ON session_plans(session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_trajectories_session ON trajectories(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_trajectories_task ON trajectories(task_id);
  `);

  runSchemaMigrations(db);

  dbInstance = db;
  return db;
}

/**
 * Versioned schema migration runner tracked via PRAGMA user_version (STATE-DB-01).
 */
function runSchemaMigrations(db: SqliteDatabase): void {
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
