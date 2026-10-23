import { EventEmitter } from 'node:events';
import { SwarmSessionManager, type SpawnWorkerOptions } from './SwarmSessionManager.js';
import { SwarmCoordinator } from './SwarmCoordinator.js';
import { SwarmIntegrator } from './SwarmIntegrator.js';
import { FileLockRegistry } from './FileLockRegistry.js';
import { resolveAutoMerge } from './SwarmPolicy.js';
import type { SubtaskSpec, SwarmTask, SwarmRole, SwarmMergeResult, SwarmProgressEvent } from './SwarmTypes.js';

export interface OrchestratorDispatchOptions {
  overallGoal: string;
  subtasks: SubtaskSpec[];
  baseCwd?: string;
  autoMerge?: boolean;
  onProgress?: (progress: string) => void;
}

export interface OrchestratorDispatchReport {
  overallGoal: string;
  success: boolean;
  tasks: SwarmTask[];
  mergeResult?: SwarmMergeResult;
  summary: string;
  durationMs: number;
}

/**
 * SubagentOrchestrator decomposes high-level user tasks and dispatches concurrent
 * background subagents in isolated Git Worktrees with FileLockRegistry leases.
 */
export class SubagentOrchestrator extends EventEmitter {
  private static instance: SubagentOrchestrator | null = null;
  private sessionManager: SwarmSessionManager;

  constructor(sessionManager?: SwarmSessionManager) {
    super();
    this.sessionManager = sessionManager || new SwarmSessionManager();

    this.sessionManager.on('progress', (event: SwarmProgressEvent) => {
      this.emit('progress', event);
    });
  }

  getSessionManager(): SwarmSessionManager {
    return this.sessionManager;
  }

  static getInstance(): SubagentOrchestrator {
    if (!this.instance) {
      this.instance = new SubagentOrchestrator();
    }
    return this.instance;
  }

  /**
   * Decompose and dispatch multiple specialized subagents in parallel.
   */
  async decomposeAndDispatch(options: OrchestratorDispatchOptions): Promise<OrchestratorDispatchReport> {
    const startTime = Date.now();
    const baseCwd = options.baseCwd || process.cwd();
    const autoMerge = resolveAutoMerge(options.autoMerge);

    if (options.subtasks.length === 0) {
      return {
        overallGoal: options.overallGoal,
        success: false,
        tasks: [],
        summary: 'No subtasks provided for decomposition.',
        durationMs: 0,
      };
    }

    if (options.onProgress) {
      options.onProgress(`[ORCHESTRATOR]: Decomposing goal into ${options.subtasks.length} specialized subagent(s)...`);
    }

    // Convert SubtaskSpecs to SpawnWorkerOptions with role/scope inference
    const workerSpecs: SpawnWorkerOptions[] = options.subtasks.map((st) => {
      const inferred = SwarmCoordinator.inferRoleAndScope(st.prompt);
      const role: SwarmRole = st.role || inferred.role;
      const assignedScope = st.scope && st.scope.length > 0 ? st.scope : inferred.scope;

      return {
        role,
        prompt: `[${st.title}]: ${st.prompt}`,
        assignedScope,
        useWorktree: true,
        baseCwd,
      };
    });

    this.emit('orchestration_start', {
      overallGoal: options.overallGoal,
      subtaskCount: workerSpecs.length,
    });

    // Execute all subagents concurrently in isolated worktrees
    const completedTasks = await this.sessionManager.executeBatch(workerSpecs, baseCwd);

    let mergeResult: SwarmMergeResult | undefined;
    let overallSuccess = completedTasks.every((t) => t.status === 'completed');

    if (autoMerge && completedTasks.some((t) => t.status === 'completed' && t.branch)) {
      if (options.onProgress) {
        options.onProgress(`[ORCHESTRATOR]: Running VerificationGate & merging subagent branches...`);
      }

      this.emit('merge_start');
      mergeResult = await SwarmIntegrator.mergeSwarmTasks(completedTasks, 'HEAD', baseCwd);
      this.emit('merge_done', mergeResult);

      if (!mergeResult.success) {
        overallSuccess = false;
      }
    }

    const durationMs = Date.now() - startTime;
    const summaryLines = [
      `🤖 [Orchestrator Decomposition & Multi-Agent Dispatch Summary]:`,
      `- Goal: "${options.overallGoal}"`,
      `- Subtasks Executed: ${completedTasks.length}`,
      `- Overall Result: ${overallSuccess ? 'SUCCESS' : 'FAILED / PARTIAL'}`,
      `- Task Status Breakdown:`,
      ...completedTasks.map((t) => {
        const wtInfo = t.branch ? ` (Branch: ${t.branch})` : '';
        const resInfo = t.resultSummary || t.errorMessage || 'Done';
        return `  * [${t.role.toUpperCase()}]: ${t.status.toUpperCase()}${wtInfo} -> ${resInfo}`;
      }),
      mergeResult ? `\n🔀 [Branch Integration]: ${mergeResult.message}` : '',
      `- Duration: ${durationMs}ms`,
    ].filter(Boolean);

    const report: OrchestratorDispatchReport = {
      overallGoal: options.overallGoal,
      success: overallSuccess,
      tasks: completedTasks,
      mergeResult,
      summary: summaryLines.join('\n'),
      durationMs,
    };

    this.emit('orchestration_done', report);
    return report;
  }
}
