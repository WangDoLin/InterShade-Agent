import assert from 'node:assert';
import path from 'node:path';
import { AntiStubAstScanner } from '../engine/verification/AntiStubAstScanner.js';
import { MetricProvenanceValidator } from '../engine/guards/MetricProvenanceValidator.js';
import { ModelTournament } from '../engine/routing/ModelTournament.js';
import { CapabilityModelRegistry } from '../engine/routing/CapabilityModelRegistry.js';
import { PatchGenStage } from '../engine/pipeline/stages/06_PatchGenStage.js';
import { RootCauseStage } from '../engine/pipeline/stages/04_RootCauseStage.js';
import { SupplyChainExporter } from '../engine/verification/SupplyChainExporter.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import type { SessionConfig, UnifiedMessage } from '../types/index.js';

console.log('🧪 Starting Anti-Superficiality & Anti-Fake Metrics Verification Suite...');

// ==========================================
// TEST 1: AntiStubAstScanner Evasion Comments
// ==========================================
console.log('Test 1: AntiStubAstScanner detecting evasion comments');
const badSourceWithTodo = `
export function computeLoss(yTrue: number[], yPred: number[]) {
  // TODO: implement actual cross-entropy calculation
  return 0;
}
`;
const findings1 = AntiStubAstScanner.scanSource('test1.ts', badSourceWithTodo);
assert.ok(findings1.length > 0, 'Must detect evasion comment in source');
assert.ok(findings1.some((f) => f.kind === 'TODO_EVASION'), 'Finding must be of kind TODO_EVASION');
console.log('✔ Test 1 Passed: Detected TODO evasion comment.');

// ==========================================
// TEST 2: AntiStubAstScanner Dummy Literal Returns
// ==========================================
console.log('Test 2: AntiStubAstScanner detecting dummy return stubs');
const badSourceWithDummyReturn = `
export class AIModelTrainer {
  trainModel(dataset: unknown[]) {
    return 0.985;
  }
}
`;
const findings2 = AntiStubAstScanner.scanSource('test2.ts', badSourceWithDummyReturn);
assert.ok(findings2.length > 0, 'Must detect dummy return in trainModel');
assert.ok(findings2.some((f) => f.kind === 'DUMMY_RETURN'), 'Finding must be of kind DUMMY_RETURN');
console.log('✔ Test 2 Passed: Detected superficial dummy return stub.');

// ==========================================
// TEST 3: AntiStubAstScanner Empty Function Bodies
// ==========================================
console.log('Test 3: AntiStubAstScanner detecting empty function bodies');
const badSourceWithEmptyBody = `
export function optimizeWeights(layers: unknown[]) {
}
`;
const findings3 = AntiStubAstScanner.scanSource('test3.ts', badSourceWithEmptyBody);
assert.ok(findings3.length > 0, 'Must detect empty function body');
assert.ok(findings3.some((f) => f.kind === 'EMPTY_BODY'), 'Finding must be of kind EMPTY_BODY');
console.log('✔ Test 3 Passed: Detected empty function body.');

// ==========================================
// TEST 4: AntiStubAstScanner Passing on Real Code
// ==========================================
console.log('Test 4: AntiStubAstScanner passing on authentic complete logic');
const goodSource = `
export function computeMovingAverage(values: number[], windowSize: number): number[] {
  if (windowSize <= 0 || values.length === 0) return [];
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= windowSize) {
      sum -= values[i - windowSize];
    }
    if (i >= windowSize - 1) {
      result.push(sum / windowSize);
    }
  }
  return result;
}
`;
const findings4 = AntiStubAstScanner.scanSource('test4.ts', goodSource);
assert.strictEqual(findings4.length, 0, 'Authentic implementation must have 0 stub findings');
console.log('✔ Test 4 Passed: Authentic complete code passed cleanly.');

// ==========================================
// TEST 5: MetricProvenanceValidator Catching Unproven Claims
// ==========================================
console.log('Test 5: MetricProvenanceValidator flagging unproven fake claims');
const fakeAssistantContent = `
Tôi đã tối ưu hóa thuật toán thành công!
Kết quả đo lường:
- Tốc độ tăng tốc 4.5x so với phiên bản cũ.
- Tiết kiệm 450 MB RAM trong quá trình xử lý.
- Đạt 99.2% accuracy trên tập kiểm thử.
`;
const emptyMessages: UnifiedMessage[] = [
  { id: '1', role: 'user', content: 'Tối ưu hóa thuật toán đi', timestamp: Date.now() },
  { id: '2', role: 'assistant', content: fakeAssistantContent, timestamp: Date.now() },
];
const result5 = MetricProvenanceValidator.evaluate(fakeAssistantContent, emptyMessages);
assert.strictEqual(result5.isValid, false, 'Claims without tool evidence must be rejected');
assert.ok(result5.unprovenClaims.length >= 3, 'Must flag 4.5x, 450 MB, 99.2% as unproven');
assert.ok(result5.nudgePrompt?.includes('NO EVIDENCE, NO DONE'), 'Nudge prompt must cite NO EVIDENCE, NO DONE');
console.log('✔ Test 5 Passed: Successfully caught and rejected unproven fake metrics.');

// ==========================================
// TEST 6: MetricProvenanceValidator Passing on Proven Claims
// ==========================================
console.log('Test 6: MetricProvenanceValidator accepting claims backed by tool output');
const provenAssistantContent = `
Dựa trên kết quả benchmark thực tế vừa chạy:
- Tốc độ đo được tăng tốc 4.5x.
- Bộ nhớ tiết kiệm 450 MB RAM.
`;
const provenMessages: UnifiedMessage[] = [
  { id: '1', role: 'user', content: 'Chạy benchmark và báo cáo', timestamp: Date.now() },
  {
    id: '2',
    role: 'tool',
    content: JSON.stringify({
      speedup: '4.5x',
      memorySaved: '450 MB',
      p99LatencyMs: 14.2,
    }),
    timestamp: Date.now(),
  },
  { id: '3', role: 'assistant', content: provenAssistantContent, timestamp: Date.now() },
];
const result6 = MetricProvenanceValidator.evaluate(provenAssistantContent, provenMessages);
assert.strictEqual(result6.isValid, true, 'Proven claims with tool evidence must pass');
assert.strictEqual(result6.unprovenClaims.length, 0, 'No claims should be unproven');
console.log('✔ Test 6 Passed: Accepted claims backed by empirical tool results.');

// ==========================================
// TEST 7: QueryEngine Directive Injection
// ==========================================
console.log('Test 7: QueryEngine system prompt contains Anti-Superficiality directives');
const qe = new QueryEngine({
  cwd: path.resolve(process.cwd()),
  model: 'gemini-2.5-flash',
  provider: 'google',
  maxTokens: 8192,
  permissionMode: 'default',
});
const sysPrompt = qe.getMessages()[0].content;
assert.ok(
  sysPrompt.includes('Anti-Superficiality & Metric Provenance Directives'),
  'System prompt must contain Anti-Superficiality directive header'
);
assert.ok(
  sysPrompt.includes('NO LAZY CODING / NO MOCKING'),
  'System prompt must enforce NO LAZY CODING'
);
assert.ok(
  sysPrompt.includes('NO HALLUCINATED METRICS'),
  'System prompt must enforce NO HALLUCINATED METRICS'
);
console.log('✔ Test 7 Passed: QueryEngine system prompt primed with anti-fake directives.');

// ==========================================
// TEST 8: Honesty Fixes ENG-001..ENG-005 (No Fabricated Evidence)
// ==========================================
console.log('Test 8: Verifying ENG-001..ENG-005 anti-fake-evidence invariants');

// ENG-001: ModelTournament must disqualify candidates missing test results (never default to 10/10 pass)
const missingEvidenceTournament = ModelTournament.evaluateTournament(
  'ENG-001-CHECK',
  'Verify missing test results disqualification',
  [
    {
      modelId: 'untested-model',
      modelName: 'Untested Model',
      provider: 'openai',
      patchDescription: 'Patch without test run',
      modifiedFiles: ['cli/index.ts'],
      buildPassed: true,
    },
  ],
  process.cwd(),
  ['cli/index.ts'],
);
assert.strictEqual(
  missingEvidenceTournament.evaluations[0].verdict,
  'DISQUALIFIED',
  'Candidate without test results must be DISQUALIFIED (ENG-001)',
);
assert.ok(
  missingEvidenceTournament.evaluations[0].disqualificationReason?.includes('EVIDENCE_MISSING'),
  'Disqualification reason must cite EVIDENCE_MISSING (ENG-001)',
);

// ENG-002 & ENG-003: Stage 04 and Stage 06 must not fabricate scores or hide heuristic template status
const mockCtx: any = {
  userPrompt: 'Fix null token check in cli/index.ts',
  cwd: process.cwd(),
  scopeSpec: {
    intentSummary: 'Fix null check',
    inScopeFiles: ['cli/index.ts'],
    outOfBoundsFiles: [],
    acceptanceCriteria: [],
    targets: { files: ['cli/index.ts'], directories: [], symbols: [] },
    allowedOperations: ['modify'],
    forbiddenPaths: [],
    confidence: 0.9,
  },
  executionPlan: {
    steps: [
      {
        targetFile: 'cli/index.ts',
        action: 'modify',
        operation: 'replace',
        rationale: 'Add guard',
      },
    ],
  },
  appliedPatches: [],
  changeBudget: { maxFiles: 3, maxAddedLines: 50, maxDeletedLines: 50 },
  auditFindings: [],
  isAuditPassed: false,
  pipelineStatus: 'FAILED',
  logs: [],
};
await new RootCauseStage().execute(mockCtx);
assert.strictEqual(
  mockCtx.rootCauseReport.hypothesisSource,
  'heuristic-template',
  'Stage 04 must transparently label heuristic-template when no empirical repro output is present (ENG-003)',
);
await new PatchGenStage().execute(mockCtx);
for (const patch of mockCtx.candidatePatches) {
  assert.strictEqual(
    patch.scores,
    undefined,
    'Stage 06 must not assign hardcoded 96/89/86 scores before Stage 08 verification (ENG-002)',
  );
}

// ENG-004: CapabilityModelRegistry must not ship fabricated historicalPassRate
for (const profile of CapabilityModelRegistry.getAllModels()) {
  if (!profile.telemetryProvenance) {
    assert.strictEqual(
      profile.historicalPassRate,
      null,
      `Model ${profile.id} must have null historicalPassRate until empirical telemetry is recorded (ENG-004)`,
    );
    assert.strictEqual(profile.totalTasksExecuted, 0);
  }
}

// ENG-005: SupplyChainExporter must reject manifests missing evaluatorVersion
assert.throws(
  () =>
    SupplyChainExporter.exportSlsaProvenanceV12({
      protocolVersion: '1.0',
      policyVersion: '1.0',
      runId: 'run-missing-ver',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      overallPassed: true,
      score: 100,
      riskTier: 'LOW',
      changedFiles: [],
      gates: {},
      manifestHashSha256: 'a'.repeat(64),
      evaluatorVersion: '',
    } as any),
  /REJECT_MISSING_EVALUATOR_VERSION/,
  'SupplyChainExporter must reject empty/missing evaluatorVersion instead of fabricating 2.5.0-attested (ENG-005)',
);
console.log('✔ Test 8 Passed: All ENG-001..ENG-005 honesty invariants verified.');

console.log('\n🎉 ALL 8 ANTI-SUPERFICIALITY & ANTI-FAKE METRICS TESTS PASSED (100% EMPIRICAL PROOF)!');
