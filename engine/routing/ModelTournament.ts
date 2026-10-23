import { AgentJudge, type JudgeSubmission, type JudgeEvaluationReport } from '../../services/agent/AgentJudge.js';
import { type ProofReport } from '../verification/ProofEngine.js';
import { CounterexampleAgent, type CounterexampleReport } from '../../services/agent/CounterexampleAgent.js';

export interface CandidatePatch {
  modelId: string;
  modelName: string;
  provider: string;
  patchDescription: string;
  modifiedFiles: string[];
  diffContent?: string;
  testResults?: { total: number; passed: number; failed: number };
  /** @deprecated Use testResults backed by actual test runner output. */
  simulatedTestResults?: { total: number; passed: number; failed: number };
  buildPassed?: boolean;
}

export interface CandidateEvaluation {
  candidate: CandidatePatch;
  proofReport?: ProofReport;
  counterexampleReport: CounterexampleReport;
  judgeReport: JudgeEvaluationReport;
  compositeEvidenceScore: number; // 0 - 100
  verdict: 'WINNER' | 'DISQUALIFIED' | 'RUNNER_UP';
  disqualificationReason?: string;
}

export interface TournamentReport {
  taskId: string;
  taskTitle: string;
  totalCompetitors: number;
  winnerModelId: string;
  winnerModelName: string;
  winnerPatch: CandidatePatch;
  evaluations: CandidateEvaluation[];
  tournamentSummary: string;
}

export class ModelTournament {
  /**
   * Runs competitive empirical tournament across candidate patches.
   * Candidates missing empirical test results are strictly disqualified (ENG-001: NO EVIDENCE, NO DONE).
   */
  static evaluateTournament(
    taskId: string,
    taskTitle: string,
    candidates: CandidatePatch[],
    cwd: string,
    allowedFiles: string[] = [],
  ): TournamentReport {
    if (candidates.length === 0) {
      throw new Error('Tournament requires at least one candidate patch.');
    }

    const evaluations: CandidateEvaluation[] = [];

    for (const cand of candidates) {
      // 1. Run Adversarial Counterexample probe
      const counterReport = CounterexampleAgent.probe({
        userIntent: taskTitle,
        modifiedFiles: cand.modifiedFiles,
        cwd,
        diffSnippet: cand.diffContent,
      });

      const resolvedTestResults = cand.testResults ?? cand.simulatedTestResults;
      const hasValidTestEvidence =
        resolvedTestResults !== undefined &&
        typeof resolvedTestResults.total === 'number' &&
        resolvedTestResults.total > 0;

      // 2. Prepare Judge Submission (never fabricate 10/10 pass when test results are missing)
      const submission: JudgeSubmission = {
        userIntent: taskTitle,
        modifiedFiles: cand.modifiedFiles,
        allowedFiles: allowedFiles.length > 0 ? allowedFiles : cand.modifiedFiles,
        testResults: hasValidTestEvidence
          ? resolvedTestResults!
          : { total: 0, passed: 0, failed: 1 },
        buildPassed: cand.buildPassed === true,
        secretLeaksDetected: 0,
        counterexampleBreachDetected: counterReport.attackSucceeded,
      };

      const judgeReport = AgentJudge.evaluate(submission);

      // 3. Composite Evidence Score
      let compositeScore = judgeReport.overallScore * 0.6 + counterReport.adversarialScore * 0.4;
      let verdict: CandidateEvaluation['verdict'] = 'RUNNER_UP';
      let disqualificationReason: string | undefined;

      if (!hasValidTestEvidence) {
        compositeScore = 0;
        verdict = 'DISQUALIFIED';
        disqualificationReason =
          'EVIDENCE_MISSING: Candidate patch did not provide empirical test execution results.';
      } else if (!judgeReport.isAccepted) {
        compositeScore = 0;
        verdict = 'DISQUALIFIED';
        disqualificationReason =
          judgeReport.criticalDefects.join('; ') || 'Hard constraints violated';
      }

      evaluations.push({
        candidate: cand,
        counterexampleReport: counterReport,
        judgeReport,
        compositeEvidenceScore: Math.round(compositeScore),
        verdict,
        disqualificationReason,
      });
    }

    // Sort by composite evidence score descending
    evaluations.sort((a, b) => b.compositeEvidenceScore - a.compositeEvidenceScore);

    // Determine winner
    const top = evaluations[0];
    if (top.compositeEvidenceScore > 0 && top.judgeReport.isAccepted && top.verdict !== 'DISQUALIFIED') {
      top.verdict = 'WINNER';
    } else {
      top.verdict = 'DISQUALIFIED';
      if (!top.disqualificationReason) {
        top.disqualificationReason = 'No candidate passed all non-negotiable Hard Constraints.';
      }
    }

    for (let i = 1; i < evaluations.length; i++) {
      if (evaluations[i].compositeEvidenceScore === 0 && evaluations[i].verdict !== 'DISQUALIFIED') {
        evaluations[i].verdict = 'DISQUALIFIED';
        evaluations[i].disqualificationReason =
          evaluations[i].judgeReport.criticalDefects.join('; ') || 'Hard constraints violated';
      }
    }

    const winner = evaluations[0];
    const summary =
      winner.verdict === 'WINNER'
        ? `Model Tournament completed. Winner: ${winner.candidate.modelName} (Score: ${winner.compositeEvidenceScore}/100) based on verified pass rate and zero adversarial breaches.`
        : 'Model Tournament completed with zero verified winners. All candidate patches breached Hard Constraints or lacked test evidence.';

    return {
      taskId,
      taskTitle,
      totalCompetitors: candidates.length,
      winnerModelId: winner.candidate.modelId,
      winnerModelName: winner.candidate.modelName,
      winnerPatch: winner.candidate,
      evaluations,
      tournamentSummary: summary,
    };
  }
}
