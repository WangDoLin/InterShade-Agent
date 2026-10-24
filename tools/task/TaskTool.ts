import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { TaskManager } from '../../state/TaskManager.js';
import type { TaskItem } from '../../tasks/TaskGraph.js';

const TaskInputSchema = z
  .object({
    action: z
      .enum(['create', 'update', 'list', 'get', 'delete'])
      .describe('Action to perform on the session task checklist'),
    taskId: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v !== undefined ? String(v) : undefined))
      .describe('Task ID required for update, get, or delete actions'),
    id: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v !== undefined ? String(v) : undefined))
      .describe('Alias for taskId'),
    subject: z.string().optional().describe('Brief title for the task (required when action="create")'),
    title: z.string().optional().describe('Alias for subject'),
    description: z.string().optional().describe('Details of what needs to be done'),
    status: z
      .enum(['pending', 'in_progress', 'completed'])
      .optional()
      .describe('New status for the task (for action="update")'),
    activeForm: z
      .string()
      .optional()
      .describe('Present continuous verb shown in UI spinner when in_progress, e.g. "Running unit tests"'),
    blocks: z
      .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
      .optional()
      .transform((v) => (Array.isArray(v) ? v.map(String) : v !== undefined ? [String(v)] : undefined))
      .describe('IDs of tasks that cannot start until this task is completed'),
    blockedBy: z
      .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
      .optional()
      .transform((v) => (Array.isArray(v) ? v.map(String) : v !== undefined ? [String(v)] : undefined))
      .describe('IDs of tasks that must complete before this task can start'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Optional key-value metadata to attach to the task'),
  })
  .passthrough();

type TaskInput = z.infer<typeof TaskInputSchema>;

export class TaskTool extends BaseTool<TaskInput, string> {
  readonly name = 'task_manage';
  readonly description =
    'Manage session tasks and track progress with dependency DAGs and verification reminders. Use this to break down complex goals into ordered tasks, track status, and coordinate multi-step workflows.';
  readonly inputSchema = TaskInputSchema;
  readonly isReadOnly = false;
  readonly isDestructive = false;
  readonly requiresPermission = false;

  async execute(args: TaskInput, context: ToolExecutionContext): Promise<string> {
    const sessionId = context.sessionId;
    const rawTaskId = args.taskId ?? (args as Record<string, unknown>).id;
    const effectiveTaskId = rawTaskId !== undefined && rawTaskId !== null ? String(rawTaskId) : undefined;

    const rawSubject = args.subject ?? (args as Record<string, unknown>).title;
    const effectiveSubject = rawSubject !== undefined && rawSubject !== null ? String(rawSubject) : undefined;

    const rawBlocks = args.blocks ?? (args as Record<string, unknown>).dependsOn;
    const effectiveBlocks = Array.isArray(rawBlocks)
      ? rawBlocks.map(String)
      : rawBlocks !== undefined && rawBlocks !== null
      ? [String(rawBlocks)]
      : undefined;

    const rawBlockedBy = args.blockedBy;
    const effectiveBlockedBy = Array.isArray(rawBlockedBy)
      ? rawBlockedBy.map(String)
      : rawBlockedBy !== undefined && rawBlockedBy !== null
      ? [String(rawBlockedBy)]
      : undefined;

    switch (args.action) {
      case 'create': {
        if (!effectiveSubject) {
          throw new Error('Field "subject" is required when action="create".');
        }
        const created = TaskManager.createTask(sessionId, {
          subject: effectiveSubject,
          description: args.description || effectiveSubject,
          activeForm: args.activeForm,
          blocks: effectiveBlocks,
          blockedBy: effectiveBlockedBy,
          metadata: args.metadata,
        });

        if (context.onProgress) {
          context.onProgress(`Created task #${created.id}: ${created.subject}`);
        }

        return this.formatTaskListResult(sessionId, `Created Task #${created.id}: "${created.subject}"`);
      }

      case 'update': {
        if (!effectiveTaskId) {
          throw new Error('Field "taskId" is required when action="update".');
        }
        const updates: Partial<Parameters<typeof TaskManager.updateTask>[2]> = {};
        if (effectiveSubject !== undefined) updates.subject = effectiveSubject;
        if (args.description !== undefined) updates.description = args.description;
        if (args.status !== undefined) updates.status = args.status;
        if (args.activeForm !== undefined) updates.activeForm = args.activeForm;
        if (effectiveBlocks !== undefined) updates.blocks = effectiveBlocks;
        if (effectiveBlockedBy !== undefined) updates.blockedBy = effectiveBlockedBy;
        if (args.metadata !== undefined) updates.metadata = args.metadata;

        const updated = TaskManager.updateTask(sessionId, effectiveTaskId, updates);

        if (context.onProgress) {
          context.onProgress(`Updated task #${updated.id} status to ${updated.status}`);
        }

        return this.formatTaskListResult(sessionId, `Updated Task #${updated.id}: status -> ${updated.status}`);
      }

      case 'list': {
        return this.formatTaskListResult(sessionId, 'Current task checklist:');
      }

      case 'get': {
        if (!effectiveTaskId) {
          throw new Error('Field "taskId" is required when action="get".');
        }
        const task = TaskManager.getTask(sessionId, effectiveTaskId);
        if (!task) {
          return `Task #${effectiveTaskId} not found.`;
        }
        return JSON.stringify(task, null, 2);
      }

      case 'delete': {
        if (!effectiveTaskId) {
          throw new Error('Field "taskId" is required when action="delete".');
        }
        TaskManager.deleteTask(sessionId, effectiveTaskId);
        return this.formatTaskListResult(sessionId, `Deleted Task #${effectiveTaskId}`);
      }

      default:
        throw new Error(`Unsupported action "${(args as any).action}".`);
    }
  }

  private formatTaskListResult(sessionId: string, prefixMessage: string): string {
    const tasks = TaskManager.listTasks(sessionId);
    const graph = TaskManager.getGraph(sessionId);

    if (tasks.length === 0) {
      return `${prefixMessage}\n(No tasks in checklist)`;
    }

    const lines: string[] = [prefixMessage, ''];

    for (const task of tasks) {
      const statusIcon = task.status === 'completed' ? '[x]' : task.status === 'in_progress' ? '[/]' : '[ ]';
      const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
      const blocks = Array.isArray(task.blocks) ? task.blocks : [];
      let depNotice = '';
      if (blockedBy.length > 0) {
        depNotice += ` (blocked by: #${blockedBy.join(', #')})`;
      }
      if (blocks.length > 0) {
        depNotice += ` (blocks: #${blocks.join(', #')})`;
      }
      const activeText = task.activeForm && task.status === 'in_progress' ? ` -> [${task.activeForm}]` : '';
      lines.push(`${statusIcon} #${task.id}: ${task.subject}${depNotice}${activeText}`);
    }

    // Verification reminder
    if (graph.isVerificationNudgeNeeded()) {
      lines.push('');
      lines.push('Please run tests or typecheck to verify that all completed changes function as intended.');
    }

    const allCompleted = tasks.length > 0 && tasks.every((t) => t.status === 'completed');
    if (allCompleted) {
      lines.push('');
      lines.push('[All Tasks Completed]: Please provide a comprehensive, synthesized user-facing walkthrough of the deliverables answering the user original request.');
    }

    return lines.join('\n');
  }
}
