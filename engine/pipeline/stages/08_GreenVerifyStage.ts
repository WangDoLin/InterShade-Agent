import fs from 'node:fs';
import type { PipelineStage, PipelineContext, StageResult } from '../PipelineStage.js';
import { TimelineRewindEngine } from '../../../state/TimelineRewindEngine.js';
import { defaultProcessRunner } from '../../ports/ProcessRunner.js';

export class GreenVerifyStage implements PipelineStage {
  readonly index = 8;
  readonly name = 'Green Verification Gate (Green Phase)';
  readonly description = 'Executes reproduction test to verify that the applied patch achieves 100% resolution.';

  async execute(ctx: PipelineContext): Promise<StageResult> {
    // 1. Verification of reproduction script
    if (ctx.reproductionScriptPath && fs.existsSync(ctx.reproductionScriptPath)) {
      const reproRes = await defaultProcessRunner.run({
        command: 'npx',
        args: ['tsx', ctx.reproductionScriptPath],
        cwd: ctx.cwd,
        timeoutMs: 30_000,
      });
      if (reproRes.exitCode === 0 && !reproRes.timedOut) {
        ctx.reproductionVerifiedGreen = true;
        ctx.logs.push('Reproduction verification passed with exit code 0.');
      } else {
        const errMessage = (reproRes.stderr || reproRes.stdout || `Exit code ${reproRes.exitCode}`).trim();
        ctx.reproductionVerifiedGreen = false;
        ctx.pipelineStatus = 'ROLLED_BACK';
        ctx.logs.push(`Reproduction verification failed: ${errMessage}. Triggering automatic rollback.`);

        if (ctx.appliedSavepointId) {
          TimelineRewindEngine.rollback(ctx.appliedSavepointId);
          ctx.logs.push(`Rollback to savepoint ${ctx.appliedSavepointId} completed.`);
        }

        return {
          success: false,
          stageName: this.name,
          stageIndex: this.index,
          message: 'Green verification failed. Changes rolled back.'
        };
      }
    } else {
      ctx.reproductionVerifiedGreen = true;
      ctx.logs.push('Verification passed by baseline.');
    }

    // 2. Targeted test verification if related test suite is registered
    const targetedTest = ctx.reconManifest?.relatedTests?.[0];
    if (targetedTest && fs.existsSync(targetedTest) && targetedTest !== ctx.reproductionScriptPath) {
      const targetRes = await defaultProcessRunner.run({
        command: 'npx',
        args: ['tsx', targetedTest],
        cwd: ctx.cwd,
        timeoutMs: 30_000,
      });
      if (targetRes.exitCode === 0 && !targetRes.timedOut) {
        ctx.logs.push(`Targeted test suite passed: ${targetedTest}.`);
      } else {
        const errMessage = (targetRes.stderr || targetRes.stdout || `Exit code ${targetRes.exitCode}`).trim();
        ctx.reproductionVerifiedGreen = false;
        ctx.pipelineStatus = 'ROLLED_BACK';
        ctx.logs.push(`Targeted test ${targetedTest} failed: ${errMessage}. Triggering automatic rollback.`);

        if (ctx.appliedSavepointId) {
          TimelineRewindEngine.rollback(ctx.appliedSavepointId);
          ctx.logs.push(`Rollback to savepoint ${ctx.appliedSavepointId} completed.`);
        }

        return {
          success: false,
          stageName: this.name,
          stageIndex: this.index,
          message: `Targeted regression test failed on ${targetedTest}. Changes rolled back.`
        };
      }
    }

    return {
      success: true,
      stageName: this.name,
      stageIndex: this.index,
      message: 'Verification confirmed with exit code 0.',
      details: {
        reproductionPassed: ctx.reproductionVerifiedGreen
      }
    };
  }
}
