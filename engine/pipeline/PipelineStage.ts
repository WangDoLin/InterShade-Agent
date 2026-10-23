export interface SymbolContext {
  name: string;
  kind: 'class' | 'function' | 'method' | 'interface' | 'variable';
  file: string;
  line: number;
}

export interface ScopeSpecification {
  intentSummary: string;
  inScopeFiles: string[];
  outOfBoundsFiles: string[];
  acceptanceCriteria: string[];
  targets: {
    files: string[];
    directories: string[];
    symbols: string[];
  };
  allowedOperations: ('modify' | 'create' | 'delete')[];
  forbiddenPaths: string[];
  confidence: number;
}

export interface ReconManifest {
  relevantFiles: string[];
  astSummary: string;
  dependencies: string[];
  symbols: SymbolContext[];
  relatedTests: string[];
  dirtyGitFiles: string[];
}

export interface HypothesisCandidate {
  hypothesis: string;
  evidence: string[];
  confidence: number;
  affectedSymbols: string[];
}

export interface RootCauseReport {
  hypothesis: string;
  hypothesisSource?: 'heuristic-template' | 'empirical-repro' | 'llm-reasoner';
  invariantViolated: string;
  proposedArchitecture: string;
  hypotheses: HypothesisCandidate[];
  topConfidence: number | null;
}

export interface AtomicExecutionStep {
  targetFile: string;
  action: 'modify' | 'create' | 'delete';
  targetSymbol?: string;
  operation: 'replace' | 'insert' | 'append';
  rationale: string;
  preconditions?: string[];
  postconditions?: string[];
}

export interface AtomicExecutionPlan {
  steps: AtomicExecutionStep[];
}

export interface CandidatePatch {
  id: string;
  targetFile: string;
  findContent: string;
  replaceContent: string;
  rationale: string;
  estimatedDiffLines: number;
  confidence: number;
  scores?: {
    correctness: number;
    minimalDiff: number;
    overall: number;
  };
}

export interface AppliedPatchRecord {
  patchId: string;
  targetFile: string;
  linesChanged: number;
  appliedAt: number;
}

export interface ChangeBudget {
  maxFiles: number;
  maxAddedLines: number;
  maxDeletedLines: number;
}

export interface AuditFinding {
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  category: 'LOGIC' | 'SECURITY' | 'MEMORY' | 'TYPE' | 'DIFF_SCOPE' | 'BUDGET';
  message: string;
  file?: string;
}

export type PipelineStatus = 'SUCCESS' | 'FAILED' | 'ROLLED_BACK' | 'REJECTED';

export interface PipelineContext {
  userPrompt: string;
  cwd: string;
  scopeSpec?: ScopeSpecification;
  reconManifest?: ReconManifest;
  reproductionScriptPath?: string;
  reproductionVerifiedRed?: boolean;
  reproductionFailureOutput?: string;
  rootCauseReport?: RootCauseReport;
  executionPlan?: AtomicExecutionPlan;
  candidatePatches?: CandidatePatch[];
  selectedPatchId?: string;
  appliedSavepointId?: string;
  appliedPatches: AppliedPatchRecord[];
  changeBudget: ChangeBudget;
  reproductionVerifiedGreen?: boolean;
  auditFindings: AuditFinding[];
  isAuditPassed: boolean;
  pipelineStatus: PipelineStatus;
  finalDiff?: string;
  finalSummary?: string;
  logs: string[];
}

export interface StageResult {
  success: boolean;
  stageName: string;
  stageIndex: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface PipelineStage {
  readonly index: number;
  readonly name: string;
  readonly description: string;
  execute(ctx: PipelineContext): Promise<StageResult>;
}
