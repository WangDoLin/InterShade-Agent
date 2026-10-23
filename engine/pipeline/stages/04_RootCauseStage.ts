import fs from 'node:fs';
import path from 'node:path';
import type { PipelineStage, PipelineContext, StageResult, HypothesisCandidate } from '../PipelineStage.js';

export class RootCauseStage implements PipelineStage {
  readonly index = 4;
  readonly name = 'Root Cause Reasoning & Architectural Hypothesis';
  readonly description = 'Traces data flows and formulates an explicit heuristic or empirical root-cause hypothesis.';

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const prompt = ctx.userPrompt;
    const targetFile = ctx.scopeSpec?.inScopeFiles?.[0] || 'target file';
    const targetSymbols = (ctx.reconManifest?.symbols || []).map((s) => s.name);

    // 1. Evidence gathering from prompt, target file content, and Stage 03 red reproduction output
    const evidence: string[] = [
      `User prompt requirement: "${prompt.slice(0, 120)}"`,
      `In-scope target: ${targetFile}`,
      ctx.reproductionVerifiedRed
        ? 'Pre-patch reproduction verified invariant violation (RED phase confirmed).'
        : 'Baseline behavior inspected (no pre-patch failure observed).',
    ];

    if (ctx.reproductionFailureOutput) {
      evidence.push(`Stage 03 reproduction error excerpt: ${ctx.reproductionFailureOutput.slice(0, 200)}`);
    }

    if (targetSymbols.length > 0) {
      evidence.push(`Identified relevant code symbols: ${targetSymbols.slice(0, 3).join(', ')}`);
    }

    let nullableParamDetected = false;
    const resolvedTarget = path.resolve(ctx.cwd, targetFile);
    if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isFile()) {
      const sourceText = fs.readFileSync(resolvedTarget, 'utf8');
      if (/\|\s*null|\|\s*undefined|\?:/.test(sourceText)) {
        nullableParamDetected = true;
        evidence.push(`Static inspection of ${targetFile} detected nullable/optional parameter signature.`);
      }
    }

    const hypothesisSource = ctx.reproductionFailureOutput ? 'empirical-repro' : 'heuristic-template';

    // 2. Hypothesis generation labeled transparently by source (ENG-003)
    const hypotheses: HypothesisCandidate[] = [
      {
        hypothesis: nullableParamDetected
          ? `Unchecked nullable parameter or missing boundary guard in ${targetFile} (${prompt.slice(0, 60)})`
          : `Missing invariant guard or safety validation in ${targetFile} (${prompt.slice(0, 60)})`,
        evidence: [
          ...evidence,
          `[Source: ${hypothesisSource}] Target function accepts edge-case input without guard clause.`,
        ],
        confidence: nullableParamDetected ? 0.75 : 0.5,
        affectedSymbols: targetSymbols.slice(0, 2),
      },
      {
        hypothesis: `State mutation or unhandled edge-case branch in ${targetFile}`,
        evidence: [...evidence, `[Source: ${hypothesisSource}] Secondary structural candidate.`],
        confidence: 0.35,
        affectedSymbols: targetSymbols.slice(0, 1),
      },
    ];

    const topHypothesis = hypotheses[0];

    ctx.rootCauseReport = {
      hypothesis: topHypothesis.hypothesis,
      hypothesisSource,
      invariantViolated: 'Target module does not enforce required boundary condition or safety guard.',
      proposedArchitecture: 'Apply isolated minimal diff with exact substring replacement.',
      hypotheses,
      topConfidence: topHypothesis.confidence,
    };

    ctx.logs.push(
      `Architectural approach established (${hypothesisSource}): ${ctx.rootCauseReport.hypothesis}`,
    );

    return {
      success: true,
      stageName: this.name,
      stageIndex: this.index,
      message: `Root cause hypothesis formulated (source: ${hypothesisSource}).`,
      details: {
        hypothesis: ctx.rootCauseReport.hypothesis,
        hypothesisSource,
        confidence: topHypothesis.confidence,
        hypothesesCount: hypotheses.length,
      },
    };
  }
}
