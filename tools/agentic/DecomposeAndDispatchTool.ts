import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { SubagentOrchestrator } from '../../engine/swarm/SubagentOrchestrator.js';
import { SwarmPolicy, resolveAutoMerge } from '../../engine/swarm/SwarmPolicy.js';
import type { SubtaskSpec } from '../../engine/swarm/SwarmTypes.js';

export interface DecomposeAndDispatchArgs {
  overallGoal: string;
  subtasks: SubtaskSpec[];
  autoMerge?: boolean;
}

export class DecomposeAndDispatchTool extends BaseTool<DecomposeAndDispatchArgs, string> {
  readonly name = 'dispatch_subagents';
  readonly description =
    'Decompose a complex goal into specialized background subagents (backend, frontend, tester, bioinformatics, architect, reviewer) running concurrently in isolated Git worktrees, with automatic verification and merge back to main branch.';
  readonly isReadOnly = false;
  readonly isDestructive = false;
  readonly requiresPermission = true;
  readonly isDeferred = false;

  readonly inputSchema = z.object({
    overallGoal: z.string().describe('Overall goal or feature to accomplish across all subagents'),
    subtasks: z
      .array(
        z.object({
          id: z.string().describe('Unique identifier for subtask (e.g. task-1, api-worker)'),
          title: z.string().describe('Short title (e.g. Implement Auth Endpoint)'),
          role: z
            .enum(['backend', 'frontend', 'tester', 'bioinformatics', 'architect', 'reviewer', 'general'])
            .describe('Specialized agent role'),
          prompt: z.string().describe('Precise instructions for the subagent'),
          scope: z
            .array(z.string())
            .optional()
            .describe('File path globs this subagent is exclusively leased to modify (e.g. ["src/api/**"])'),
          dependsOn: z.array(z.string()).optional().describe('IDs of subtasks that must complete prior to this one'),
        })
      )
      .min(1)
      .describe('Array of specialized subtasks to dispatch concurrently'),
    autoMerge: z
      .boolean()
      .optional()
      .default(SwarmPolicy.autoMerge)
      .describe('Whether to automatically verify and merge completed subagent branches into main repository'),
  });

  async execute(args: DecomposeAndDispatchArgs, context: ToolExecutionContext): Promise<string> {
    const orchestrator = SubagentOrchestrator.getInstance();

    if (context.onProgress) {
      context.onProgress(`[ORCHESTRATOR DISPATCH]: Starting ${args.subtasks.length} parallel subagents for: "${args.overallGoal}"`);
    }

    const report = await orchestrator.decomposeAndDispatch({
      overallGoal: args.overallGoal,
      subtasks: args.subtasks,
      baseCwd: context.cwd,
      autoMerge: resolveAutoMerge(args.autoMerge),
      onProgress: context.onProgress,
    });

    return report.summary;
  }
}
