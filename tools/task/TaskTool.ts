import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { TaskManager } from '../../state/TaskManager.js';
import type { TaskItem } from '../../tasks/TaskGraph.js';

const TaskInputSchema = z.object({
  action: z
    .enum(['create', 'update', 'list', 'get', 'delete'])
    .describe('Action to perform on the session task checklist'),
  taskId: z.string().optional().describe('Task ID required for update, get, or delete actions'),
  subject: z.string().optional().describe('Brief title for the task (required when action="create")'),
  description: z.string().optional().describe('Details of what needs to be done'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .optional()
    .describe('New status for the task (for action="update")'),
  activeForm: z
    .string()
    .optional()
    .describe('Present continuous verb shown in UI spinner when in_progress, e.g. "Running unit tests"'),
  blocks: z.array(z.string()).optional().describe('IDs of tasks that cannot start until this task is completed'),
  blockedBy: z.array(z.string()).optional().describe('IDs of tasks that must complete before this task can start'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Optional key-value metadata to attach to the task'),
});

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

    switch (args.action) {
      case 'create': {
        if (!args.subject) {
          throw new Error('Field "subject" is required when action="create".');
        }
        const created = TaskManager.createTask(sessionId, {
          subject: args.subject,
          description: args.description || args.subject,
          activeForm: args.activeForm,
          blocks: args.blocks,
          blockedBy: args.blockedBy,
          metadata: args.metadata,
        });

        if (context.onProgress) {
          context.onProgress(`Created task #${created.id}: ${created.subject}`);
        }

        return this.formatTaskListResult(sessionId, `Created Task #${created.id}: "${created.subject}"`);
      }

      case 'update': {
        if (!args.taskId) {
          throw new Error('Field "taskId" is required when action="update".');
        }
        const updated = TaskManager.updateTask(sessionId, args.taskId, {
          subject: args.subject,
          description: args.description,
          status: args.status,
          activeForm: args.activeForm,
          blocks: args.blocks,
          blockedBy: args.blockedBy,
          metadata: args.metadata,
        });

        if (context.onProgress) {
          context.onProgress(`Updated task #${updated.id} status to ${updated.status}`);
        }

        return this.formatTaskListResult(sessionId, `Updated Task #${updated.id}: status -> ${updated.status}`);
      }

      case 'list': {
        return this.formatTaskListResult(sessionId, 'Current task checklist:');
      }

      case 'get': {
        if (!args.taskId) {
          throw new Error('Field "taskId" is required when action="get".');
        }
        const task = TaskManager.getTask(sessionId, args.taskId);
        if (!task) {
          return `Task #${args.taskId} not found.`;
        }
        return JSON.stringify(task, null, 2);
      }

      case 'delete': {
        if (!args.taskId) {
          throw new Error('Field "taskId" is required when action="delete".');
        }
        TaskManager.deleteTask(sessionId, args.taskId);
        return this.formatTaskListResult(sessionId, `Deleted Task #${args.taskId}`);
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

    return lines.join('\n');
  }
}
