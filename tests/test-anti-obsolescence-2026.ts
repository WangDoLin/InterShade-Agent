import assert from 'node:assert';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import { DeveloperHabitService } from '../services/memory/DeveloperHabitService.js';
import { DependencyAuditTool } from '../tools/code/DependencyAuditTool.js';
import { AlphaGenomeTool } from '../tools/science/AlphaGenomeTool.js';
import { EncodeCcresTool } from '../tools/science/EncodeCcresTool.js';
import { MLCausalEngine } from '../engine/ml/MLCausalEngine.js';

console.log('================================================================');
console.log('   INTERSHADE 2026 ANTI-OBSOLESCENCE VERIFICATION SUITE         ');
console.log('================================================================\n');

// TEST 1: Temporal Anchor 2026 in QueryEngine
console.log('=== TEST 1: TEMPORAL ANCHOR 2026 IN QUERYENGINE ===');
const engine = new QueryEngine({
  provider: 'gemini',
  model: 'gemini-1.5-pro',
  cwd: process.cwd(),
  maxTokens: 4096,
  permissionMode: 'default',
});
const prompt = (engine as any).getBasePrompt();
assert.ok(prompt.includes('2026 Modern Engineering Invariants & Anti-Obsolescence Standards'), 'Must include 2026 standards header');
assert.ok(prompt.includes("Use 'uv' exclusively"), 'Must mandate uv for Python');
assert.ok(prompt.includes('torch.compile()'), 'Must mandate PyTorch 2.4+ compile');
assert.ok(prompt.includes('Strictly use ESM'), 'Must mandate ESM over CommonJS');
assert.ok(prompt.includes('AlphaGenome'), 'Must mandate AlphaGenome over hallucinated effect scores');
console.log('QueryEngine 2026 Temporal Anchor: PASS\n');

// TEST 2: DeveloperHabitService 2026 Habit Detection
console.log('=== TEST 2: DEVELOPER HABIT 2026 DETECTION ===');
const habitUv = DeveloperHabitService.detectAndPersistHabit('chúng ta dùng modern python với uv nhé', 'test-proj');
assert.ok(habitUv, 'Must detect modern uv toolchain');
assert.strictEqual(habitUv?.category, 'Modern 2026 Toolchain Invariant');

const habitBio = DeveloperHabitService.detectAndPersistHabit('dự đoán variant effect với alphagenome', 'test-proj');
assert.ok(habitBio, 'Must detect biological foundation model habit');
assert.strictEqual(habitBio?.category, 'Scientific Foundation Model Invariant');
console.log('DeveloperHabitService 2026 Detection: PASS\n');

// TEST 3: DependencyAuditTool Freshness 2026
console.log('=== TEST 3: DEPENDENCY AUDIT FRESHNESS 2026 ===');
const auditTool = new DependencyAuditTool();
assert.ok(auditTool.inputSchema.shape.scanTypes, 'scanTypes schema must exist');
console.log('DependencyAuditTool 2026 ScanTypes: PASS\n');

// TEST 4: AlphaGenome & ENCODE Grounding Summaries
console.log('=== TEST 4: SCIENTIFIC ORACLES GROUNDING FORMATTERS ===');
const agSummary = AlphaGenomeTool.formatGroundingSummary('chr7:140753336:A>T', {
  effectScore: -0.42,
  tracks: ['DNASE', 'ChIP:H3K27ac'],
  interpretation: 'High confidence regulatory disruption in promoter',
});
assert.ok(agSummary.includes('AlphaGenome Empirical Grounding'), 'Must contain grounding title');
assert.ok(agSummary.includes('1Mbp regulatory field'), 'Must state 1Mbp context');
assert.ok(agSummary.includes('DNASE, ChIP:H3K27ac'), 'Must list affected tracks');

const encodeSummary = EncodeCcresTool.formatCcreGroundingSummary('EH38E2941922', {
  group: 'Promoter-like (PLS)',
  nearbyGenes: ['BRCA1', 'NBR2'],
  biosamples: ['K562', 'HepG2'],
});
assert.ok(encodeSummary.includes('ENCODE SCREEN cCRE Grounding'), 'Must contain SCREEN grounding title');
assert.ok(encodeSummary.includes('BRCA1, NBR2'), 'Must list regulated nearby genes');
console.log('Scientific Oracles Grounding Summaries: PASS\n');

// TEST 5: MLCausalEngine SOTA Literature & Bio Grounding
console.log('=== TEST 5: ML CAUSAL ENGINE SOTA & BIO GROUNDING ===');
const mlEngine = new MLCausalEngine('Predict genomic splicing delta', 'bio_sequence');
mlEngine.groundWithModernLiterature([
  {
    title: 'State Space Mamba-2 for Long Genomic Sequences',
    doi: '10.1038/s41586-2026-001',
    year: 2026,
    architecture: 'Mamba-2 + Bidirectional SSM',
  },
]);
mlEngine.injectBioOracleGroundTruth('AlphaGenome', 'chr11:5205263', 'High disruption on splicing acceptor site');
const summary = mlEngine.getSummary();
assert.ok(summary.includes('State Space Mamba-2'), 'Must include 2026 literature baseline');
assert.ok(summary.includes('AlphaGenome'), 'Must include AlphaGenome domain oracle');
console.log('MLCausalEngine SOTA & Bio Grounding: PASS\n');

console.log('================================================================');
console.log(' ALL 2026 ANTI-OBSOLESCENCE VERIFICATION TESTS PASSED (100%)     ');
console.log('================================================================');
