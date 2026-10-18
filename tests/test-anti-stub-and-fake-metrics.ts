import assert from 'node:assert';
import path from 'node:path';
import { AntiStubAstScanner } from '../engine/verification/AntiStubAstScanner.js';
import { MetricProvenanceValidator } from '../engine/guards/MetricProvenanceValidator.js';
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

console.log('\n🎉 ALL 7 ANTI-SUPERFICIALITY & ANTI-FAKE METRICS TESTS PASSED (100% EMPIRICAL PROOF)!');
