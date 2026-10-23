import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_SWARM_POLICY, resolveAutoMerge } from '../engine/swarm/SwarmPolicy.js';
import { SwarmRuntime } from '../engine/swarm/SwarmRuntime.js';
import { FileLockRegistry } from '../engine/swarm/FileLockRegistry.js';
import {
  DepartmentBlackboard,
  BlackboardVersionConflictError,
} from '../engine/swarm/DepartmentBlackboard.js';
import { SwarmIntegrator } from '../engine/swarm/SwarmIntegrator.js';
import { CompactionPipeline } from '../context/CompactionPipeline.js';
import type { SessionExecutor } from '../engine/swarm/MultiSessionPool.js';
import type { UnifiedMessage } from '../types/index.js';

class MockSessionExecutor extends EventEmitter implements SessionExecutor {
  private readonly id: string;
  private readonly cwd: string;
  aborted = false;

  constructor(id: string, cwd: string) {
    super();
    this.id = id;
    this.cwd = cwd;
  }

  getSessionState(): { id: string; cwd: string } {
    return { id: this.id, cwd: this.cwd };
  }

  abort(): void {
    this.aborted = true;
  }
}

function collectTsFiles(dirPath: string, out: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return out;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

async function runSwarmRuntimeAndLeasesTests() {
  console.log('=== Running SwarmPolicy AutoMerge Grep-Gate, SwarmRuntime, Leases & CompactionPipeline Tests (NEXT-C-37, NEXT-C-01..07) ===\n');

  // 1. NEXT-C-37: SwarmPolicy.autoMerge default false & Grep-Gate
  console.log('1. Testing SwarmPolicy.autoMerge === false and codebase grep-gate (NEXT-C-37)...');
  assert.strictEqual(DEFAULT_SWARM_POLICY.autoMerge, false);
  assert.strictEqual(resolveAutoMerge(undefined), false);
  assert.strictEqual(resolveAutoMerge(false), false);
  assert.strictEqual(resolveAutoMerge(true), true);

  const rootDir = process.cwd();
  const scanDirs = ['engine', 'orchestrator', 'tools', 'cli'];
  const forbiddenPatterns = [
    /autoMerge\s*!==\s*false/,
    /autoMerge\s*:\s*boolean\s*=\s*true/,
    /autoMerge\s*:.*default\(\s*true\s*\)/,
  ];
  for (const d of scanDirs) {
    for (const file of collectTsFiles(path.join(rootDir, d))) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pat of forbiddenPatterns) {
        assert.strictEqual(
          pat.test(content),
          false,
          `[GREP-GATE VIOLATION in ${path.relative(rootDir, file)}]: Found forbidden autoMerge default-true pattern ${pat}`
        );
      }
    }
  }
  console.log('  [PASS] SwarmPolicy.autoMerge and codebase grep-gate verified.');

  // 2. NEXT-C-03 & NEXT-C-04: FileLockRegistry fencingToken, heartbeat & FIFO waitForLease
  console.log('2. Testing FileLockRegistry fencingToken, heartbeat, and FIFO waitForLease (NEXT-C-03..04)...');
  FileLockRegistry.clearAll();
  const targetFile = path.join(rootDir, 'src', 'shared-module.ts');

  const lease1 = FileLockRegistry.acquireLease(targetFile, 'sess-A', 'backend', 5000);
  assert.strictEqual(lease1.acquired, true);
  assert.ok(typeof lease1.fencingToken === 'number' && lease1.fencingToken >= 1);
  assert.strictEqual(FileLockRegistry.verifyFencingToken(targetFile, 'sess-A', lease1.fencingToken!), true);
  assert.strictEqual(FileLockRegistry.verifyFencingToken(targetFile, 'sess-A', lease1.fencingToken! + 99), false);

  // Heartbeat with matching fencingToken succeeds; stale fencingToken fails
  const hbGood = FileLockRegistry.heartbeat(targetFile, 'sess-A', lease1.fencingToken!, 5000);
  assert.strictEqual(hbGood.renewed, true);
  const hbStale = FileLockRegistry.heartbeat(targetFile, 'sess-A', lease1.fencingToken! - 1, 5000);
  assert.strictEqual(hbStale.renewed, false);

  // FIFO waitForLease: sess-B and sess-C queue up in order
  const acquireOrder: string[] = [];
  const waiterB = FileLockRegistry.waitForLease(targetFile, 'sess-B', 'frontend', {
    timeoutMs: 2000,
    ttlMs: 5000,
  }).then((res) => {
    acquireOrder.push('sess-B');
    return res;
  });

  const waiterC = FileLockRegistry.waitForLease(targetFile, 'sess-C', 'tester', {
    timeoutMs: 2000,
    ttlMs: 5000,
  }).then((res) => {
    acquireOrder.push('sess-C');
    return res;
  });

  // Release sess-A -> wakes sess-B immediately
  FileLockRegistry.releaseLease(targetFile, 'sess-A');
  const resB = await waiterB;
  assert.strictEqual(resB.acquired, true);
  assert.ok(resB.fencingToken! > lease1.fencingToken!, 'Fencing token must increase monotonically');

  // Release sess-B -> wakes sess-C in FIFO order
  FileLockRegistry.releaseLease(targetFile, 'sess-B');
  const resC = await waiterC;
  assert.strictEqual(resC.acquired, true);
  assert.ok(resC.fencingToken! > resB.fencingToken!, 'Fencing token must increase monotonically');
  assert.deepStrictEqual(acquireOrder, ['sess-B', 'sess-C']);
  FileLockRegistry.releaseLease(targetFile, 'sess-C');
  console.log('  [PASS] FileLockRegistry fencingToken, heartbeat, and FIFO waitForLease verified.');

  // 3. NEXT-C-06: DepartmentBlackboard monotonic version & optimistic concurrency
  console.log('3. Testing DepartmentBlackboard optimistic concurrency version checks (NEXT-C-06)...');
  const bb = new DepartmentBlackboard();
  const v1 = bb.postEntry({
    key: 'api:users',
    category: 'endpoint',
    authorRole: 'backend',
    data: { method: 'GET', path: '/v1/users' },
  });
  assert.strictEqual(v1.version, 1);

  const v2 = bb.postEntry({
    key: 'api:users',
    category: 'endpoint',
    authorRole: 'backend',
    data: { method: 'POST', path: '/v1/users' },
    expectedVersion: 1,
  });
  assert.strictEqual(v2.version, 2);

  assert.throws(
    () =>
      bb.postEntry({
        key: 'api:users',
        category: 'endpoint',
        authorRole: 'frontend',
        data: { stale: true },
        expectedVersion: 1,
      }),
    BlackboardVersionConflictError,
    'Stale expectedVersion must throw BlackboardVersionConflictError'
  );
  console.log('  [PASS] DepartmentBlackboard optimistic concurrency verified.');

  // 4. NEXT-C-01 & NEXT-C-02: SwarmRuntime isolation & SessionExecutor decoupling
  console.log('4. Testing SwarmRuntime isolation and SessionExecutor decoupling (NEXT-C-01..02)...');
  const runtime1 = new SwarmRuntime({
    missionId: 'mission-alpha',
    executorFactory: (cfg) => new MockSessionExecutor(cfg.sessionId || 'mock', cfg.cwd || rootDir),
  });
  const runtime2 = new SwarmRuntime({
    missionId: 'mission-beta',
    executorFactory: (cfg) => new MockSessionExecutor(cfg.sessionId || 'mock', cfg.cwd || rootDir),
  });

  runtime1.blackboard.postEntry({
    key: 'state:alpha',
    category: 'state',
    authorRole: 'architect',
    data: { ready: true },
  });
  assert.strictEqual(runtime2.blackboard.getEntry('state:alpha'), undefined, 'SwarmRuntime blackboards must be isolated');

  runtime1.registerSession('sess-rt1');
  FileLockRegistry.acquireLease(targetFile, 'sess-rt1', 'backend', 10000);
  assert.ok(FileLockRegistry.getLease(targetFile));
  runtime1.dispose();
  assert.strictEqual(FileLockRegistry.getLease(targetFile), undefined, 'dispose() must release all mission leases');
  runtime2.dispose();
  console.log('  [PASS] SwarmRuntime isolation and disposal verified.');

  // 5. NEXT-C-05: SwarmIntegrator.createMergeProposal
  console.log('5. Testing SwarmIntegrator.createMergeProposal (NEXT-C-05)...');
  const emptyProposal = await SwarmIntegrator.createMergeProposal([], 'HEAD', rootDir);
  assert.strictEqual(emptyProposal.collisionCheckPassed, true);
  assert.strictEqual(emptyProposal.candidateBranches.length, 0);
  console.log('  [PASS] SwarmIntegrator.createMergeProposal verified.');

  // 6. NEXT-C-07: CompactionPipeline 3-stage context compaction
  console.log('6. Testing CompactionPipeline 3-stage context compaction (NEXT-C-07)...');
  const verboseLines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: Verbose tool diagnostic output data...`).join('\n');
  const sampleMessages: UnifiedMessage[] = [
    { id: 'sys-1', role: 'system', content: 'System architecture rules.', timestamp: 1 },
    { id: 'pin-1', role: 'user', content: 'CRITICAL PINNED REQUIREMENT: Never auto-merge.', timestamp: 2, isPinned: true },
    ...Array.from({ length: 10 }, (_, idx) => ({
      id: `msg-${idx}`,
      role: (idx % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${idx} discussion:\n${verboseLines}`,
      timestamp: 10 + idx,
    })),
  ];

  const compacted = CompactionPipeline.run(sampleMessages, {
    targetTokens: 400,
    reconstruction: {
      activeTasksSummary: '- [x] Verify CompactionPipeline',
      recentlyTouchedFiles: ['context/CompactionPipeline.ts'],
    },
  });
  assert.ok(compacted.finalTokens < compacted.initialTokens, 'CompactionPipeline must reduce tokens');
  assert.ok(compacted.stagesExecuted.length >= 2, 'Should run multiple compaction stages when over targetTokens');
  assert.ok(
    compacted.messages.some((m) => m.id === 'pin-1'),
    'Pinned messages must be preserved across all 3 compaction stages'
  );
  console.log('  [PASS] CompactionPipeline 3-stage compaction verified.');

  console.log('\n=== All SwarmRuntime, Leases, Blackboard & CompactionPipeline Tests Passed! ===');
}

runSwarmRuntimeAndLeasesTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
