import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProofGateRegistry } from '../engine/verification/gates/ProofGateRegistry.js';
import { VerifyCore } from '../engine/verification/VerifyCore.js';
import { ProofEngine } from '../engine/verification/ProofEngine.js';
import { ChallengeRegistry } from '../engine/verification/AttestationAuthority.js';
import { CapabilityModelRegistry } from '../engine/routing/CapabilityModelRegistry.js';
import { SweBenchmarkRunner } from '../engine/benchmark/SweBenchmarkRunner.js';
import { Logger } from '../services/observability/Logger.js';
import { getDatabase } from '../state/Database.js';

async function runTests(): Promise<void> {
  console.log('[TEST]: Starting Wave 5-7 Proof Gate Registry, VerifyCore & Empirical Model Stats Suite...');

  // 1. ProofGateRegistry (NEXT-B-16..17)
  {
    const allGates = ProofGateRegistry.listGates();
    assert.strictEqual(allGates.length, 10, 'ProofGateRegistry must define all 10 canonical gates (G1..G10)');

    const g1 = ProofGateRegistry.getGate('G1');
    assert.ok(g1 && g1.critical === true, 'G1 must be registered as a critical boundary gate');

    const requiredIds = ProofGateRegistry.getRequiredGateIds();
    assert.deepStrictEqual(
      requiredIds,
      ['G1', 'G4', 'G5', 'G6', 'G9', 'G10'],
      'Critical gates must match G1, G4, G5, G6, G9, G10'
    );

    const totalWeight = allGates.reduce((acc, g) => acc + g.weight, 0);
    assert.strictEqual(totalWeight, 100, 'Total weight across all 10 gates must equal 100');
    console.log('  ✓ ProofGateRegistry (10 canonical gates G1..G10 + critical gate enforcement) verified');
  }

  // 2. VerifyCore bi-directional cross-verification + ChallengeRegistry locking (NEXT-B-18..20)
  {
    const testChallenge = crypto.randomBytes(16).toString('hex');
    assert.strictEqual(ChallengeRegistry.isConsumed(testChallenge), false, 'Fresh challenge must not be consumed');

    const cwd = process.cwd();
    const proofReport = await ProofEngine.verify(['cli/index.ts'], {
      cwd,
      challenge: testChallenge,
      skipBuild: true,
      skipTests: true,
      skipTypecheck: true,
      maxFilesBudget: 5,
    });
    assert.strictEqual(proofReport.overallPassed, true, 'ProofEngine.verify should pass');

    const proofDir = path.join(cwd, '.intershader', 'proof', proofReport.runId);
    try {
      const unifiedResult = VerifyCore.verifyProofBundle(proofDir, {
        expectedChallenge: testChallenge,
        consumeChallenge: true,
        enforceCriticalGates: true,
      });

      assert.strictEqual(unifiedResult.isValid, true, `VerifyCore must accept valid proof bundle: ${unifiedResult.errors.join('; ')}`);
      assert.strictEqual(unifiedResult.crossVerified, true, 'VerifyCore must confirm AttestationAuthority and StandaloneVerifier agreement');
      assert.ok(unifiedResult.standaloneBundleReport?.isAccepted, 'StandaloneVerifier export bundle check must pass');
      assert.strictEqual(ChallengeRegistry.isConsumed(testChallenge), true, 'Challenge must be recorded as consumed after verification');

      // Replay attempt with the same challenge nonce must fail because consumeChallenge consumed it
      const replayResult = VerifyCore.verifyProofBundle(proofDir, {
        expectedChallenge: testChallenge,
        consumeChallenge: true,
      });
      assert.strictEqual(replayResult.isValid, false, 'Consumed challenge nonce must reject replay');
      assert.strictEqual(replayResult.attestationReport.verdict, 'REPLAY_ATTACK_DETECTED');
    } finally {
      fs.rmSync(proofDir, { recursive: true, force: true });
    }
    console.log('  ✓ VerifyCore bi-directional cross-verification & ChallengeRegistry atomic lock verified');
  }

  // 3. CapabilityModelRegistry empirical model_stats & canonical cost calculation (NEXT-C-17..19)
  {
    const db = getDatabase();
    const testModelId = 'claude-3-7-sonnet-20250219';
    db.prepare(`DELETE FROM model_stats WHERE session_id LIKE 'sess-wave7-test-%'`).run();
    try {
      // Record 4 empirical runs for claude-3-7-sonnet-20250219
      for (let i = 0; i < 4; i++) {
        const cost = CapabilityModelRegistry.calculateCostUsd(testModelId, 10_000, 2_000);
        assert.ok(cost > 0, 'Catalog/profile pricing must compute positive USD cost');
        CapabilityModelRegistry.recordModelStat({
          sessionId: `sess-wave7-test-${i}`,
          modelId: testModelId,
          provider: 'anthropic',
          taskType: 'CODE_GENERATION',
          latencyMs: 1200 + i * 100,
          inputTokens: 10_000,
          outputTokens: 2_000,
          costUsd: cost,
          toolCallSuccess: true,
          proofGatePassed: true,
        });
      }

      const agg = CapabilityModelRegistry.getAggregatedStats(testModelId);
      assert.ok(agg.totalRuns >= 4, 'Aggregated model_stats must include the 4 recorded runs');
      assert.strictEqual(agg.toolCallSuccessRate, 100);
      assert.strictEqual(agg.proofPassRate, 100);
      assert.ok(agg.totalInputTokens >= 40_000);
      assert.ok(agg.totalCostUsd > 0);

      const unknownCost = CapabilityModelRegistry.calculateCostUsd('unknown-unpriced-model-xyz', 1000, 1000);
      assert.strictEqual(unknownCost, 0, 'Unknown model must return 0 cost rather than fabricated pricing');
    } finally {
      db.prepare(`DELETE FROM model_stats WHERE session_id LIKE 'sess-wave7-test-%'`).run();
    }
    console.log('  ✓ CapabilityModelRegistry empirical SQLite model_stats & catalog pricing verified');
  }

  // 4. SweBenchmarkRunner schema validation & synthetic baseline marker (NEXT-C-15..16)
  {
    const quickValidation = SweBenchmarkRunner.validateTasks(SweBenchmarkRunner.getTasks('quick'));
    assert.strictEqual(quickValidation.valid, true, `Quick benchmark tasks must be valid: ${quickValidation.errors.join(', ')}`);
    assert.strictEqual(quickValidation.taskCount, 10);

    const fullValidation = SweBenchmarkRunner.validateTasks(SweBenchmarkRunner.getTasks('full'));
    assert.strictEqual(fullValidation.valid, true, 'Full 100-task benchmark suite must pass schema validation');
    assert.strictEqual(fullValidation.taskCount, 100);

    const report = SweBenchmarkRunner.run('quick');
    assert.strictEqual(report.syntheticReference, true, 'Static benchmark report must explicitly set syntheticReference=true');
    console.log('  ✓ SweBenchmarkRunner task schema validation & syntheticReference flag verified');
  }

  // 5. Structured JSONL Logger with traceId & secret scrubbing (NEXT-C-20..21)
  {
    const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intershade-logger-'));
    Logger.setLogDirectory(tmpLogDir);
    try {
      const traceId = Logger.createTraceId();
      const fakeSecret = 'sk-proj-' + 'Z'.repeat(48);
      const entry = Logger.info('ProofVerifier', 'Verification completed', {
        traceId,
        sessionId: 'sess-obs-1',
        data: { leakedToken: fakeSecret, gateCount: 10 },
      });
      assert.strictEqual(entry.traceId, traceId);
      assert.strictEqual(entry.component, 'ProofVerifier');

      const logFile = path.join(tmpLogDir, 'intershader.jsonl');
      const rawDisk = fs.readFileSync(logFile, 'utf-8').trim();
      assert.ok(!rawDisk.includes(fakeSecret), 'JSONL Logger must scrub secrets before writing to disk');
      const parsed = JSON.parse(rawDisk);
      assert.strictEqual(parsed.traceId, traceId);
      assert.strictEqual(parsed.data.gateCount, 10);
    } finally {
      Logger.setLogDirectory(null);
      fs.rmSync(tmpLogDir, { recursive: true, force: true });
    }
    console.log('  ✓ Structured JSONL Logger with traceId & SecretScrubber verified');
  }

  console.log('[PASS]: All Wave 5-7 Proof Gate Registry, VerifyCore & Empirical Model Stats tests passed!');
}

runTests().catch((err) => {
  console.error('[FAIL]:', err);
  process.exit(1);
});
