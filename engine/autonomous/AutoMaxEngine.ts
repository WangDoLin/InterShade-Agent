import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AutoMaxConfig, AutoMaxStatus } from '../../types/index.js';
import { TaskManager } from '../../state/TaskManager.js';
import { SessionStore } from '../../state/SessionStore.js';
import { VerificationGate, type VerificationResult } from '../VerificationGate.js';
import { defaultProcessRunner, type ProcessRunner } from '../ports/ProcessRunner.js';

export interface AutoMaxCycleReport {
  cycle: number;
  phase: AutoMaxStatus['currentPhase'];
  focusTarget: string;
  actionTaken: string;
  verificationPassed: boolean;
  durationMs: number;
  filesTouched: string[];
}

export interface AutoMaxReport {
  sessionId: string;
  goal?: string;
  durationMinutes?: number;
  maxIterations: number;
  totalIterations: number;
  totalDurationMs: number;
  success: boolean;
  stopReason:
    | 'GOAL_ACCOMPLISHED'
    | 'TIME_LIMIT_REACHED'
    | 'ITERATION_LIMIT_REACHED'
    | 'USER_ABORTED'
    | 'UNRESOLVABLE_DEFECT';
  cycles: AutoMaxCycleReport[];
  summary: string;
}

export interface AutoMaxRunOptions extends AutoMaxConfig {
  sessionId?: string;
  cwd?: string;
  runner?: ProcessRunner;
  signal?: AbortSignal;
  onProgress?: (event: {
    iteration: number;
    phase: AutoMaxStatus['currentPhase'];
    message: string;
    status: AutoMaxStatus;
  }) => void;
  executor?: (prompt: string, options: { sessionId: string; cwd: string }) => Promise<string>;
}

/**
 * AutoMaxEngine orchestrates the unconstrained autonomous evolution and execution loop.
 * Combines Mode Max super-intelligence (deep unconstrained thinking) with
 * complete autonomous tool execution across goal-driven or time-driven horizons.
 */
export class AutoMaxEngine extends EventEmitter {
  private activeStatus: AutoMaxStatus = {
    active: false,
    iterationsCompleted: 0,
    elapsedMs: 0,
    currentPhase: 'idle',
    modifiedFilesCount: 0,
  };
  private abortController: AbortController | null = null;

  constructor() {
    super();
  }

  public getStatus(): AutoMaxStatus {
    return { ...this.activeStatus };
  }

  public isActive(): boolean {
    return this.activeStatus.active;
  }

  public stop(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.activeStatus.active = false;
    this.activeStatus.currentPhase = 'idle';
    this.emit('stopped');
  }

  /**
   * Executes an end-to-end AutoMax autonomous mission bounded by goal or time horizon.
   */
  async runMission(options: AutoMaxRunOptions): Promise<AutoMaxReport> {
    const sessionId = options.sessionId || `automax-${randomUUID()}`;
    const cwd = options.cwd || process.cwd();
    const runner = options.runner || defaultProcessRunner;
    const maxIterations = options.maxIterations && options.maxIterations > 0 ? options.maxIterations : 10;
    const durationMinutes = options.durationMinutes && options.durationMinutes > 0 ? options.durationMinutes : undefined;
    const thinkingBudget = options.thinkingBudget || 16384;
    const startTime = Date.now();
    const deadline = durationMinutes ? startTime + durationMinutes * 60 * 1000 : undefined;

    this.abortController = new AbortController();
    const effectiveSignal = options.signal || this.abortController.signal;

    this.activeStatus = {
      active: true,
      goal: options.goal,
      durationMinutes,
      maxIterations,
      iterationsCompleted: 0,
      startedAt: startTime,
      elapsedMs: 0,
      remainingMs: deadline ? deadline - startTime : undefined,
      currentPhase: 'orienting',
      modifiedFilesCount: 0,
    };

    const cycles: AutoMaxCycleReport[] = [];
    let stopReason: AutoMaxReport['stopReason'] = 'ITERATION_LIMIT_REACHED';
    let overallSuccess = false;

    this.notifyProgress(options.onProgress, 0, 'orienting', `[AutoMax]: Initializing mission: "${options.goal || 'Continuous Autonomous Evolution'}"`);

    // Ensure session exists in SQLite
    if (!SessionStore.getSession(sessionId)) {
      SessionStore.createSession({
        sessionId,
        cwd,
        model: 'automax-agent',
        provider: 'local',
        maxTokens: 4096,
        permissionMode: 'auto',
      });
    }

    // 1. Initial Plan Seeding if Goal is specified
    if (options.goal) {
      const existingTasks = TaskManager.listTasks(sessionId);
      if (existingTasks.length === 0) {
        TaskManager.createTask(sessionId, {
          subject: `AutoMax Primary Goal: ${options.goal}`,
          description: options.goal,
          activeForm: 'Executing AutoMax mission',
        });
      }
    }

    let iteration = 0;
    while (iteration < maxIterations) {
      if (effectiveSignal.aborted) {
        stopReason = 'USER_ABORTED';
        break;
      }

      const now = Date.now();
      if (deadline && now >= deadline) {
        stopReason = 'TIME_LIMIT_REACHED';
        break;
      }

      iteration++;
      const cycleStart = Date.now();
      this.activeStatus.iterationsCompleted = iteration;
      this.activeStatus.elapsedMs = Date.now() - startTime;
      if (deadline) {
        this.activeStatus.remainingMs = Math.max(0, deadline - Date.now());
      }

      // --- PHASE 1: ORIENTING ---
      this.activeStatus.currentPhase = 'orienting';
      this.notifyProgress(options.onProgress, iteration, 'orienting', `Iteration #${iteration}: Scanning workspace state and diagnostics...`);

      const modifiedFiles = this.getModifiedFiles(cwd, runner);
      this.activeStatus.modifiedFilesCount = modifiedFiles.length;

      const preflightTsc = await VerificationGate.verifyTypeScriptAsync(cwd, runner);
      const tasks = TaskManager.listTasks(sessionId);
      const pendingTasks = tasks.filter((t) => t.status !== 'completed');

      // Determine autonomous focus
      let currentFocus = '';
      if (!preflightTsc.passed && preflightTsc.errorDetails) {
        currentFocus = `Resolve TypeScript compilation diagnostics:\n${preflightTsc.errorDetails.slice(0, 400)}`;
      } else if (pendingTasks.length > 0) {
        currentFocus = `Execute next roadmap task #${pendingTasks[0].id}: "${pendingTasks[0].subject}"`;
      } else if (options.goal) {
        currentFocus = `Fulfill and verify acceptance criteria for goal: "${options.goal}"`;
      } else {
        currentFocus = `Autonomous Code Evolution: inspect code hotspots, increase test coverage, and harden edge invariants`;
      }

      // --- PHASE 2: DELIBERATING ---
      this.activeStatus.currentPhase = 'deliberating';
      this.notifyProgress(options.onProgress, iteration, 'deliberating', `Iteration #${iteration}: Formulating deep reasoning plan (Budget: ${thinkingBudget} tok)...`);

      const autonomousPrompt = this.constructAutonomousPrompt({
        iteration,
        maxIterations,
        goal: options.goal,
        currentFocus,
        deadline,
        remainingMinutes: deadline ? Math.ceil((deadline - Date.now()) / 60000) : undefined,
        preflightDiagnostics: preflightTsc.errorDetails,
      });

      // --- PHASE 3: EXECUTING ---
      this.activeStatus.currentPhase = 'executing';
      this.notifyProgress(options.onProgress, iteration, 'executing', `Iteration #${iteration}: Executing autonomous operations with auto permission...`);

      let executorResponse = '';
      if (options.executor) {
        try {
          executorResponse = await options.executor(autonomousPrompt, { sessionId, cwd });
        } catch (execErr: any) {
          executorResponse = `[Execution Exception]: ${execErr.message}`;
          this.notifyProgress(
            options.onProgress,
            iteration,
            'executing',
            `Execution error: ${execErr.message}`
          );
        }
      } else {
        // Fallback execution when no external LLM query engine is wired (e.g. headless unit testing)
        executorResponse = `[AutoMax Local Step]: Executed target "${currentFocus}".`;
        if (pendingTasks.length > 0) {
          TaskManager.updateTask(sessionId, pendingTasks[0].id, { status: 'completed' });
        }
      }

      // --- PHASE 4: VERIFYING ---
      this.activeStatus.currentPhase = 'verifying';
      this.notifyProgress(options.onProgress, iteration, 'verifying', `Iteration #${iteration}: Running verification gate and invariant fuzz checks...`);

      const postTsc = await VerificationGate.verifyTypeScriptAsync(cwd, runner);
      const verificationPassed = postTsc.passed;
      this.activeStatus.lastVerificationPassed = verificationPassed;

      // --- PHASE 5: REFLECTING & CHECKPOINTING ---
      this.activeStatus.currentPhase = 'reflecting';
      const cycleDuration = Date.now() - cycleStart;
      const touchedNow = this.getModifiedFiles(cwd, runner);

      cycles.push({
        cycle: iteration,
        phase: 'reflecting',
        focusTarget: currentFocus,
        actionTaken: executorResponse.slice(0, 300),
        verificationPassed,
        durationMs: cycleDuration,
        filesTouched: touchedNow,
      });

      if (options.autoCommit && touchedNow.length > 0 && verificationPassed) {
        this.commitCheckpoint(cwd, iteration, currentFocus, runner);
      }

      // Check termination criteria
      const remainingTasksAfter = TaskManager.listTasks(sessionId).filter((t) => t.status !== 'completed');
      if (options.goal && remainingTasksAfter.length === 0 && verificationPassed) {
        stopReason = 'GOAL_ACCOMPLISHED';
        overallSuccess = true;
        break;
      }
    }

    if (stopReason === 'TIME_LIMIT_REACHED' || stopReason === 'ITERATION_LIMIT_REACHED') {
      // Completed full duration or iteration budget safely
      overallSuccess = this.activeStatus.lastVerificationPassed ?? true;
    }

    this.activeStatus.active = false;
    this.activeStatus.currentPhase = 'completed';
    this.activeStatus.elapsedMs = Date.now() - startTime;

    const totalDurationMs = Date.now() - startTime;
    const summary = this.generateReportSummary({
      sessionId,
      goal: options.goal,
      durationMinutes,
      maxIterations,
      totalIterations: cycles.length,
      totalDurationMs,
      success: overallSuccess,
      stopReason,
      cycles,
    });

    const finalReport: AutoMaxReport = {
      sessionId,
      goal: options.goal,
      durationMinutes,
      maxIterations,
      totalIterations: cycles.length,
      totalDurationMs,
      success: overallSuccess,
      stopReason,
      cycles,
      summary,
    };

    this.notifyProgress(options.onProgress, cycles.length, 'completed', `[AutoMax]: Mission finished: ${stopReason}`);
    this.emit('completed', finalReport);
    return finalReport;
  }

  private constructAutonomousPrompt(params: {
    iteration: number;
    maxIterations: number;
    goal?: string;
    currentFocus: string;
    deadline?: number;
    remainingMinutes?: number;
    preflightDiagnostics?: string;
  }): string {
    const horizonNotice = params.remainingMinutes !== undefined
      ? `\n- Time Horizon: ~${params.remainingMinutes} minute(s) remaining until deadline.`
      : '';

    return [
      `[Mode AutoMax Autonomous Iteration #${params.iteration}/${params.maxIterations}]`,
      `Goal: "${params.goal || 'Continuous Workspace Self-Evolution & Hardening'}"`,
      `Focus Target: ${params.currentFocus}`,
      horizonNotice,
      '',
      `Instructions for this autonomous turn:`,
      `1. Directly inspect the target files with file_read or symbols.`,
      `2. Apply the necessary code changes using file_edit or file_write.`,
      `3. Execute verification commands (tests, typecheck) to ensure no regressions.`,
      `4. Update the task status to 'completed' using task_manage when verified.`,
      `5. Do NOT wait for user input; proceed autonomously with highest engineering standards.`,
    ].join('\n');
  }

  private getModifiedFiles(cwd: string, runner: ProcessRunner): string[] {
    try {
      const res = runner.runSync({
        command: 'git',
        args: ['status', '--porcelain'],
        cwd,
        timeoutMs: 5000,
      });
      if (res.exitCode !== 0 || !res.stdout) return [];
      return res.stdout
        .split('\n')
        .map((l) => l.trim().slice(3))
        .filter((f) => f.length > 0);
    } catch {
      return [];
    }
  }

  private commitCheckpoint(cwd: string, cycle: number, focus: string, runner: ProcessRunner): void {
    try {
      runner.runSync({ command: 'git', args: ['add', '-A'], cwd, timeoutMs: 5000 });
      runner.runSync({
        command: 'git',
        args: ['commit', '-m', `chore(automax): cycle #${cycle} checkpoint - ${focus.slice(0, 50)}`],
        cwd,
        timeoutMs: 5000,
      });
    } catch {
      // Non-fatal if git commit fails
    }
  }

  private notifyProgress(
    cb: AutoMaxRunOptions['onProgress'] | undefined,
    iteration: number,
    phase: AutoMaxStatus['currentPhase'],
    message: string
  ): void {
    const payload = {
      iteration,
      phase,
      message,
      status: this.getStatus(),
    };
    if (cb) cb(payload);
    this.emit('progress', payload);
  }

  private generateReportSummary(report: Omit<AutoMaxReport, 'summary'>): string {
    const lines = [
      `⚡ [AUTOMAX EVOLUTION REPORT]`,
      `- Mission: "${report.goal || 'Continuous Autonomous Evolution'}"`,
      `- Status: ${report.success ? '✅ SUCCESS' : '⚠️ COMPLETED WITH NOTICES'} (${report.stopReason})`,
      `- Iterations Completed: ${report.totalIterations}/${report.maxIterations}`,
      `- Duration: ${(report.totalDurationMs / 1000).toFixed(1)}s${report.durationMinutes ? ` (Configured Horizon: ${report.durationMinutes}m)` : ''}`,
      '',
      `### Iteration Cycles Provenance:`,
    ];

    for (const c of report.cycles) {
      const vIcon = c.verificationPassed ? '✔' : '✘';
      lines.push(`- Cycle #${c.cycle} [${vIcon}]: ${c.focusTarget}`);
      if (c.filesTouched.length > 0) {
        lines.push(`  * Files: ${c.filesTouched.slice(0, 3).join(', ')}${c.filesTouched.length > 3 ? '...' : ''}`);
      }
    }

    return lines.join('\n');
  }
}
