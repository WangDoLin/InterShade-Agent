import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { OrcaWorktreeOrchestrator } from '../orchestration/OrcaWorktreeOrchestrator.js';
import type { SwarmTask, SwarmMergeResult, MergeProposal } from './SwarmTypes.js';

const execFileAsync = promisify(execFile);

export class SwarmIntegrator {
  /**
   * Build a non-destructive MergeProposal inspecting all candidate worktree branches
   * and checking for overlapping file modifications without mutating the base branch (NEXT-C-05).
   */
  static async createMergeProposal(
    tasks: SwarmTask[],
    baseBranch: string = 'HEAD',
    cwd: string = process.cwd()
  ): Promise<MergeProposal> {
    const proposalId = `mp-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const isGit = await OrcaWorktreeOrchestrator.isGitRepository(cwd);
    const completedWithBranch = tasks.filter(
      (t) => t.status === 'completed' && t.branch && t.worktreePath
    );

    if (!isGit || completedWithBranch.length === 0) {
      return {
        proposalId,
        baseBranch,
        candidateBranches: [],
        collisionCheckPassed: true,
        collisions: [],
        createdAt: Date.now(),
      };
    }

    const candidateBranches: MergeProposal['candidateBranches'] = [];
    const allModifiedFiles = new Map<string, string>();
    const collisions: Array<{ file: string; branches: string[] }> = [];

    for (const t of completedWithBranch) {
      let files: string[] = [];
      try {
        const { stdout } = await execFileAsync('git', ['diff', '--name-only', baseBranch], {
          cwd: t.worktreePath,
        });
        files = stdout
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean);
      } catch {
        files = [];
      }

      candidateBranches.push({
        taskId: t.id,
        role: String(t.role),
        branch: t.branch!,
        worktreePath: t.worktreePath!,
        modifiedFiles: files,
      });

      for (const file of files) {
        if (allModifiedFiles.has(file)) {
          const firstBranch = allModifiedFiles.get(file)!;
          collisions.push({
            file,
            branches: [firstBranch, t.branch!],
          });
        } else {
          allModifiedFiles.set(file, t.branch!);
        }
      }
    }

    return {
      proposalId,
      baseBranch,
      candidateBranches,
      collisionCheckPassed: collisions.length === 0,
      collisions,
      createdAt: Date.now(),
    };
  }

  /**
   * Apply a previously generated MergeProposal after explicit approval (NEXT-C-05).
   */
  static async applyMergeProposal(
    proposal: MergeProposal,
    cwd: string = process.cwd()
  ): Promise<SwarmMergeResult> {
    if (!proposal.collisionCheckPassed) {
      const collisionSummary = proposal.collisions
        .map((c) => `File "${c.file}" modified by both [${c.branches.join(', ')}]`)
        .join('; ');
      return {
        success: false,
        mergedBranches: [],
        failedBranches: proposal.candidateBranches.map((c) => ({
          branch: c.branch,
          reason: 'Collision detected',
        })),
        verificationPassed: false,
        proposal,
        message: `[MERGE BLOCKED]: Overlapping file modifications detected across worker sessions: ${collisionSummary}. Manual resolution required.`,
      };
    }

    if (proposal.candidateBranches.length === 0) {
      return {
        success: true,
        mergedBranches: [],
        failedBranches: [],
        verificationPassed: true,
        proposal,
        message: 'No worktree branches to merge.',
      };
    }

    const mergedBranches: string[] = [];
    const failedBranches: Array<{ branch: string; reason: string }> = [];

    for (const candidate of proposal.candidateBranches) {
      try {
        const commitMsg = `feat(swarm): integrate changes from role "${candidate.role}" (${candidate.taskId})`;
        await execFileAsync('git', ['merge', '--no-ff', candidate.branch, '-m', commitMsg], {
          cwd,
        });
        mergedBranches.push(candidate.branch);
        await OrcaWorktreeOrchestrator.cleanupWorktree(candidate.taskId, true, cwd).catch(() => {});
      } catch (err: unknown) {
        failedBranches.push({
          branch: candidate.branch,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const allSuccess = failedBranches.length === 0;
    return {
      success: allSuccess,
      mergedBranches,
      failedBranches,
      verificationPassed: allSuccess,
      proposal,
      message: allSuccess
        ? `Successfully merged ${mergedBranches.length} worker branch(es) cleanly into workspace.`
        : `Partial merge completed. Merged: [${mergedBranches.join(', ')}]. Failed: [${failedBranches.map((f) => f.branch).join(', ')}]`,
    };
  }

  /**
   * Integrate and merge completed worker branches into base workspace branch
   */
  static async mergeSwarmTasks(
    tasks: SwarmTask[],
    baseBranch: string = 'HEAD',
    cwd: string = process.cwd()
  ): Promise<SwarmMergeResult> {
    const isGit = await OrcaWorktreeOrchestrator.isGitRepository(cwd);
    if (!isGit) {
      return {
        success: true,
        mergedBranches: [],
        failedBranches: [],
        verificationPassed: true,
        message: 'No git repository detected. Changes applied directly in shared workspace.',
      };
    }

    const proposal = await this.createMergeProposal(tasks, baseBranch, cwd);
    return this.applyMergeProposal(proposal, cwd);
  }
}
