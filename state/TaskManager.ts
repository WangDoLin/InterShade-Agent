import { getDatabase } from './Database.js';
import { TaskGraph, type TaskItem, type TaskStatus } from '../tasks/TaskGraph.js';
import { EventEmitter } from 'events';

export const taskEvents = new EventEmitter();

export interface CreateTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  subject?: string;
  description?: string;
  status?: TaskStatus;
  activeForm?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export class TaskManager {
  static getGraph(sessionId: string): TaskGraph {
    const tasks = this.listTasks(sessionId);
    return new TaskGraph(tasks);
  }

  static getNextTaskId(sessionId?: string): string {
    const db = getDatabase();
    const stmt = sessionId
      ? db.prepare('SELECT id FROM tasks WHERE session_id = ?')
      : db.prepare('SELECT id FROM tasks');
    const rows = (sessionId ? stmt.all(sessionId) : stmt.all()) as { id: string }[];
    let maxId = 0;
    for (const row of rows) {
      const num = parseInt(row.id, 10);
      if (!isNaN(num) && num > maxId) {
        maxId = num;
      }
    }
    return String(maxId + 1);
  }

  static createTask(sessionId: string, input: CreateTaskInput): TaskItem {
    const graph = this.getGraph(sessionId);
    const id = this.getNextTaskId(sessionId);
    const now = Date.now();

    const task: TaskItem = {
      id,
      subject: input.subject,
      description: input.description,
      status: 'pending',
      activeForm: input.activeForm,
      owner: input.owner,
      blocks: input.blocks || [],
      blockedBy: input.blockedBy || [],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    // Validate with graph to prevent cycles
    graph.addTask(task);

    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO tasks (
        id, session_id, subject, description, status,
        active_form, blocks, blocked_by, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      sessionId ?? '',
      task.subject ?? '',
      task.description ?? '',
      task.status ?? 'pending',
      task.activeForm ?? null,
      JSON.stringify(task.blocks ?? []),
      JSON.stringify(task.blockedBy ?? []),
      task.metadata ? JSON.stringify(task.metadata) : null,
      task.createdAt ?? now,
      task.updatedAt ?? now
    );

    taskEvents.emit('change', sessionId);
    return task;
  }

  static createTaskWithId(sessionId: string, input: Partial<TaskItem> & { id: string; subject: string }): TaskItem {
    const graph = this.getGraph(sessionId);
    const existing = graph.getTask(input.id);
    if (existing) {
      return this.updateTask(sessionId, input.id, {
        subject: input.subject,
        description: input.description,
        status: input.status,
        activeForm: input.activeForm,
        blocks: input.blocks,
        blockedBy: input.blockedBy,
        metadata: input.metadata,
      });
    }

    const now = Date.now();
    const task: TaskItem = {
      id: input.id,
      subject: input.subject,
      description: input.description || input.subject,
      status: input.status || 'pending',
      activeForm: input.activeForm,
      owner: input.owner,
      blocks: input.blocks || [],
      blockedBy: input.blockedBy || [],
      metadata: input.metadata,
      createdAt: input.createdAt || now,
      updatedAt: now,
    };

    graph.addTask(task);

    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO tasks (
        id, session_id, subject, description, status,
        active_form, blocks, blocked_by, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      sessionId ?? '',
      task.subject ?? '',
      task.description ?? '',
      task.status ?? 'pending',
      task.activeForm ?? null,
      JSON.stringify(task.blocks ?? []),
      JSON.stringify(task.blockedBy ?? []),
      task.metadata ? JSON.stringify(task.metadata) : null,
      task.createdAt ?? now,
      task.updatedAt ?? now
    );

    taskEvents.emit('change', sessionId);
    return task;
  }

  static updateTask(sessionId: string, taskId: string, input: UpdateTaskInput): TaskItem {
    const graph = this.getGraph(sessionId);
    const existing = graph.getTask(taskId);
    if (!existing) {
      throw new Error(`Task #${taskId} not found in session.`);
    }

    const updated = graph.updateTask(taskId, input);

    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE tasks SET
        subject = ?,
        description = ?,
        status = ?,
        active_form = ?,
        blocks = ?,
        blocked_by = ?,
        metadata = ?,
        updated_at = ?
      WHERE id = ? AND session_id = ?
    `);

    stmt.run(
      updated.subject ?? existing.subject ?? '',
      updated.description ?? existing.description ?? '',
      updated.status ?? existing.status ?? 'pending',
      updated.activeForm ?? existing.activeForm ?? null,
      JSON.stringify(updated.blocks ?? []),
      JSON.stringify(updated.blockedBy ?? []),
      updated.metadata ? JSON.stringify(updated.metadata) : null,
      updated.updatedAt ?? Date.now(),
      taskId ?? '',
      sessionId ?? ''
    );

    taskEvents.emit('change', sessionId);
    return updated;
  }

  static getTask(sessionId: string, taskId: string): TaskItem | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM tasks WHERE id = ? AND session_id = ?');
    const row = stmt.get(taskId ?? '', sessionId ?? '') as any;
    if (!row) {
      return null;
    }
    return this.rowToTask(row);
  }

  static listTasks(sessionId: string): TaskItem[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(sessionId ?? '') as any[];
    return rows.map(r => this.rowToTask(r)).sort((a, b) => {
      const idA = parseInt(a.id, 10);
      const idB = parseInt(b.id, 10);
      if (!isNaN(idA) && !isNaN(idB)) return idA - idB;
      return a.createdAt - b.createdAt;
    });
  }

  static deleteTask(sessionId: string, taskId: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM tasks WHERE id = ? AND session_id = ?');
    stmt.run(taskId ?? '', sessionId ?? '');
    taskEvents.emit('change', sessionId);
    return true;
  }

  static clearCompletedTasks(sessionId: string): number {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM tasks WHERE session_id = ? AND status = ?');
    const res = stmt.run(sessionId ?? '', 'completed');
    taskEvents.emit('change', sessionId);
    return res.changes;
  }

  static clearAllTasks(sessionId: string): number {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM tasks WHERE session_id = ?');
    const res = stmt.run(sessionId ?? '');
    taskEvents.emit('change', sessionId);
    return res.changes;
  }

  private static rowToTask(row: any): TaskItem {
    return {
      id: row.id,
      subject: row.subject,
      description: row.description,
      status: row.status as TaskStatus,
      activeForm: row.active_form || undefined,
      blocks: JSON.parse(row.blocks || '[]'),
      blockedBy: JSON.parse(row.blocked_by || '[]'),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
