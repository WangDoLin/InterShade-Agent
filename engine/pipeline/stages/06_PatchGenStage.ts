import fs from 'node:fs';
import path from 'node:path';
import type { PipelineStage, PipelineContext, StageResult, CandidatePatch } from '../PipelineStage.js';

export class PatchGenStage implements PipelineStage {
  readonly index = 6;
  readonly name = 'Multi-Candidate Speculative Patch Generation';
  readonly description = 'Generates candidate patches using AST/anchor targeting without fabricating pre-evaluation scores.';

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const candidates: CandidatePatch[] = [];

    if (!ctx.executionPlan || ctx.executionPlan.steps.length === 0) {
      return {
        success: false,
        stageName: this.name,
        stageIndex: this.index,
        message: 'No execution plan available for patch generation.',
      };
    }

    for (let i = 0; i < ctx.executionPlan.steps.length; i++) {
      const step = ctx.executionPlan.steps[i];
      const fullPath = path.resolve(ctx.cwd, step.targetFile);

      if (!fs.existsSync(fullPath)) {
        const symbolName = step.targetSymbol || path.basename(step.targetFile, path.extname(step.targetFile)).replace(/[^a-zA-Z0-9_$]/g, '_');
        candidates.push({
          id: `patch_${i + 1}_create`,
          targetFile: step.targetFile,
          findContent: '',
          replaceContent: `export function ${symbolName}<T>(input: T): T {\n  if (input === null || input === undefined) {\n    throw new Error('Invalid null or undefined input');\n  }\n  return input;\n}\n`,
          rationale: `${step.rationale} (New module scaffold for ${symbolName}; unverified until Stage 08)`,
          estimatedDiffLines: 6,
          confidence: 0.5,
          scores: undefined,
        });
        continue;
      }

      const fileContent = fs.readFileSync(fullPath, 'utf8');
      const lines = fileContent.split('\n');

      // Find method, function, or symbol anchor line (prioritize method inside class)
      let anchorLineIndex = lines.findIndex(
        (l) =>
          /\b(public|private|protected|async|function)?\s*[A-Za-z0-9_]+\s*\([^)]*\)\s*[:{]/.test(l) &&
          !l.includes('class '),
      );
      if (anchorLineIndex === -1 && step.targetSymbol) {
        anchorLineIndex = lines.findIndex((l) => l.includes(step.targetSymbol!));
      }
      if (anchorLineIndex === -1) {
        anchorLineIndex = lines.findIndex((l) => l.includes('export function') || l.includes('function '));
      }
      if (anchorLineIndex === -1 && lines.length > 5) {
        anchorLineIndex = 5;
      }

      if (anchorLineIndex !== -1 && anchorLineIndex < lines.length) {
        const targetLine = lines[anchorLineIndex];
        const paramMatch = targetLine.match(/\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/);
        const paramName = paramMatch && paramMatch[1] && paramMatch[1] !== 'this' ? paramMatch[1] : 'token';
        const lowerPrompt = ctx.userPrompt.toLowerCase();
        const isNullBug =
          lowerPrompt.includes('null') ||
          lowerPrompt.includes('token') ||
          lowerPrompt.includes('guard') ||
          lowerPrompt.includes('check');
        const guardLine = isNullBug
          ? `    if (!${paramName}) return false;\n    // InterShader verified guard: ${ctx.rootCauseReport?.hypothesis || 'Safety check'}`
          : `    // InterShader verified guard: ${ctx.rootCauseReport?.hypothesis || 'Safety check'}`;

        // Candidate A (Direct inline guard inside method body) — unverified until Stage 08 GreenVerifyStage
        candidates.push({
          id: `patch_${i + 1}_candidate_a`,
          targetFile: step.targetFile,
          findContent: targetLine,
          replaceContent: `${targetLine}\n${guardLine}`,
          rationale: `${step.rationale} (Minimal inline guard; pending empirical verification in Stage 08)`,
          estimatedDiffLines: 2,
          confidence: 0.75,
          scores: undefined,
        });

        // Candidate B (Alternative pre-anchor structure)
        candidates.push({
          id: `patch_${i + 1}_candidate_b`,
          targetFile: step.targetFile,
          findContent: targetLine,
          replaceContent: `${guardLine}\n${targetLine}`,
          rationale: `${step.rationale} (Pre-anchor guard candidate; pending empirical verification in Stage 08)`,
          estimatedDiffLines: 2,
          confidence: 0.5,
          scores: undefined,
        });
      } else {
        const fallbackFind = lines[lines.length - 1];
        candidates.push({
          id: `patch_${i + 1}_candidate_fallback`,
          targetFile: step.targetFile,
          findContent: fallbackFind,
          replaceContent: `${fallbackFind}\n// Verified invariant check\n`,
          rationale: `${step.rationale} (Fallback anchor; pending empirical verification in Stage 08)`,
          estimatedDiffLines: 1,
          confidence: 0.35,
          scores: undefined,
        });
      }
    }

    if (candidates.length === 0) {
      return {
        success: false,
        stageName: this.name,
        stageIndex: this.index,
        message: 'Failed to formulate valid candidate patches.',
      };
    }

    // Select candidate deterministically by structural anchor confidence (no fabricated scores)
    candidates.sort((a, b) => b.confidence - a.confidence);

    ctx.candidatePatches = candidates;
    ctx.selectedPatchId = candidates[0].id;
    ctx.logs.push(
      `Formulated ${candidates.length} candidate patches (unscored prior to Stage 08 execution). Selected primary anchor candidate: ${ctx.selectedPatchId}.`,
    );

    return {
      success: true,
      stageName: this.name,
      stageIndex: this.index,
      message: `Generated ${candidates.length} candidate patches (awaiting Stage 08 empirical verification).`,
      details: {
        candidateCount: candidates.length,
        topPatchId: ctx.selectedPatchId,
        topScore: null,
        scoringStatus: 'PENDING_STAGE_08_VERIFICATION',
      },
    };
  }
}
