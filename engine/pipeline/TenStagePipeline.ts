import { EventEmitter } from 'node:events';
import type { PipelineContext, PipelineStage, StageResult } from './PipelineStage.js';
import { IntentScopeStage } from './stages/01_IntentScopeStage.js';
import { ReconMappingStage } from './stages/02_ReconMappingStage.js';
import { RedReproStage } from './stages/03_RedReproStage.js';
import { RootCauseStage } from './stages/04_RootCauseStage.js';
import { MinimalPlanStage } from './stages/05_MinimalPlanStage.js';
import { PatchGenStage } from './stages/06_PatchGenStage.js';
import { ApplySavepointStage } from './stages/07_ApplySavepointStage.js';
import { GreenVerifyStage } from './stages/08_GreenVerifyStage.js';
import { AdversarialAuditStage } from './stages/09_AdversarialAuditStage.js';
import { CleanupSynthesisStage } from './stages/10_CleanupSynthesisStage.js';
import { TimelineRewindEngine } from '../../state/TimelineRewindEngine.js';

export interface PipelineExecutionReport {
  success: boolean;
  totalStagesExecuted: number;
  stageResults: StageResult[];
  context: PipelineContext;
  durationMs: number;
}

export class TenStagePipeline extends EventEmitter {
  private readonly stages: PipelineStage[];
  private readonly cleanupStage: CleanupSynthesisStage;

  constructor() {
    super();
    this.cleanupStage = new CleanupSynthesisStage();
    this.stages = [
      new IntentScopeStage(),
      new ReconMappingStage(),
      new RedReproStage(),
      new RootCauseStage(),
      new MinimalPlanStage(),
      new PatchGenStage(),
      new ApplySavepointStage(),
      new GreenVerifyStage(),
      new AdversarialAuditStage(),
      this.cleanupStage
    ];
  }

  async run(userPrompt: string, cwd: string = process.cwd()): Promise<PipelineExecutionReport> {
    const startTime = Date.now();
    const context: PipelineContext = {
      userPrompt,
      cwd,
      appliedPatches: [],
      changeBudget: {
        maxFiles: 5,
        maxAddedLines: 80,
        maxDeletedLines: 50
      },
      auditFindings: [],
      isAuditPassed: false,
      pipelineStatus: 'SUCCESS',
      logs: []
    };

    const stageResults: StageResult[] = [];
    let overallSuccess = true;

    for (const stage of this.stages) {
      this.emit('stage_start', {
        index: stage.index,
        name: stage.name,
        description: stage.description
      });

      try {
        const result = await stage.execute(context);
        stageResults.push(result);

        this.emit('stage_complete', {
          index: stage.index,
          name: stage.name,
          result
        });

        if (!result.success) {
          overallSuccess = false;
          if (context.pipelineStatus === 'SUCCESS') {
            context.pipelineStatus = 'FAILED';
          }
          context.logs.push(`Execution stopped at ${stage.name}. Reason: ${result.message}`);

          // Automatic rollback guard if savepoint was active and un-reverted
          if (context.appliedSavepointId && stage.index < 10) {
            TimelineRewindEngine.rollback(context.appliedSavepointId);
            context.pipelineStatus = 'ROLLED_BACK';
          }

          // Execute cleanup stage if failed early
          if (stage.index < 10) {
            await this.cleanupStage.execute(context);
          }
          break;
        }
      } catch (err: any) {
        overallSuccess = false;
        context.pipelineStatus = 'FAILED';
        const failResult: StageResult = {
          success: false,
          stageIndex: stage.index,
          stageName: stage.name,
          message: `Execution threw unhandled exception: ${err.message}`
        };
        stageResults.push(failResult);
        context.logs.push(`Unhandled error: ${err.message}`);

        if (context.appliedSavepointId && stage.index < 10) {
          TimelineRewindEngine.rollback(context.appliedSavepointId);
          context.pipelineStatus = 'ROLLED_BACK';
        }

        if (stage.index < 10) {
          await this.cleanupStage.execute(context);
        }
        break;
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      success: overallSuccess && context.pipelineStatus === 'SUCCESS',
      totalStagesExecuted: stageResults.length,
      stageResults,
      context,
      durationMs
    };
  }
}
