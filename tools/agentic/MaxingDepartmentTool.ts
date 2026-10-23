import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { SwarmDepartmentCoordinator } from '../../engine/swarm/SwarmDepartmentCoordinator.js';
import { SwarmPolicy, resolveAutoMerge } from '../../engine/swarm/SwarmPolicy.js';
import type { SwarmRole } from '../../engine/swarm/SwarmTypes.js';

export interface MaxingDepartmentArgs {
  overallGoal: string;
  requiredRoles?: SwarmRole[];
  maxingBudget?: number;
  autoMerge?: boolean;
}

const MIN_GOAL_LENGTH = 5;

/**
 * MaxingDepartmentTool convenes and orchestrates a full multi-threaded Software Engineering Department
 * running in Maxing Mode across isolated Git worktrees with unconstrained thinking budgets.
 */
export class MaxingDepartmentTool extends BaseTool<MaxingDepartmentArgs, string> {
  readonly name = 'maxing_department';
  readonly description =
    'Convene and dispatch a multi-threaded Software Engineering Department Swarm in Maxing Mode (Lead Architect, Backend, Frontend, Research, Security, QA/Tester, Hostile Reviewer).';
  readonly isReadOnly = false;
  readonly isDestructive = false;
  readonly requiresPermission = true;
  readonly isDeferred = false;

  readonly inputSchema = z.object({
    overallGoal: z
      .string()
      .min(MIN_GOAL_LENGTH)
      .describe('Overall mission goal for the software engineering department to design, implement, and verify'),
    requiredRoles: z
      .array(
        z.enum([
          'architect',
          'backend',
          'frontend',
          'tester',
          'reviewer',
          'security',
          'research',
          'bioinformatics',
          'general',
        ])
      )
      .optional()
      .describe('Optional explicit list of department desks to mobilize (default: auto-inferred by Lead Architect)'),
    maxingBudget: z
      .number()
      .optional()
      .describe('Thinking token budget per specialist agent (default: 16,384)'),
    autoMerge: z
      .boolean()
      .optional()
      .default(SwarmPolicy.autoMerge)
      .describe('Whether to automatically verify and merge all worktree branches back to main'),
  });

  async execute(args: MaxingDepartmentArgs, context: ToolExecutionContext): Promise<string> {
    const coordinator = new SwarmDepartmentCoordinator();

    if (context.onProgress) {
      context.onProgress(`[MAXING DEPARTMENT]: Mobilizing multi-threaded department for "${args.overallGoal}"`);
    }

    const report = await coordinator.executeMission({
      missionGoal: args.overallGoal,
      baseCwd: context.cwd,
      maxingBudget: args.maxingBudget,
      autoMerge: resolveAutoMerge(args.autoMerge),
      requiredRoles: args.requiredRoles,
      onProgress: context.onProgress,
    });

    return report.summary;
  }
}
