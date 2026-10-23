import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SecretScrubber } from '../security/SecretScrubber.js';
import { SecretRedactor } from '../security/SecretRedactor.js';
import { SecretSanitizer } from '../providers/security/SecretSanitizer.js';
import { Logger } from '../services/observability/Logger.js';
import { FtsMemoryService } from '../services/memory/FtsMemoryService.js';
import { TrajectoryRecorder } from '../services/memory/TrajectoryRecorder.js';
import { EvidenceStore } from '../engine/verification/EvidenceStore.js';
import { TelegramAdapter } from '../gateway/adapters/TelegramAdapter.js';
import { ApprovalStore } from '../gateway/ApprovalStore.js';
import { getDatabase } from '../state/Database.js';
import { buildCanarySecrets } from './fixtures/fake-secrets.js';

async function runSecretCanaryTests() {
  console.log('=== Running Unified SecretScrubber & 6-Surface Canary Tests (NEXT-B-06..08) ===\n');

  const canaries = buildCanarySecrets();
  const dynamicSecret = ['dyn', 'canary', 'secret', '99887766'].join('_');
  SecretScrubber.registerDynamicSecret(dynamicSecret);

  const combinedPayload = [
    ...canaries.map((c) => `${c.description}: ${c.value}`),
    `Dynamic Registered Token: ${dynamicSecret}`,
  ].join('\n');

  const rawValuesToAssertAbsent = [
    ...canaries.map((c) =>
      c.id === 'url-creds'
        ? 'SuperSecretPass999'
        : c.id === 'private-key-pem'
        ? 'MIIEpAIBAAKCAQEA0canarySyntheticKeyBodyData1234567890=='
        : c.value
    ),
    dynamicSecret,
  ];

  function assertNoCanaryLeak(surfaceName: string, content: string): void {
    for (const raw of rawValuesToAssertAbsent) {
      assert.strictEqual(
        content.includes(raw),
        false,
        `[LEAK DETECTED on ${surfaceName}] Raw canary fragment "${raw.slice(0, 12)}..." was found in output!`
      );
    }
  }

  // 1. Direct SecretScrubber & delegating wrappers (SecretRedactor / SecretSanitizer)
  console.log('1. Testing SecretScrubber.scrub, scrubObject, SecretRedactor, and SecretSanitizer...');
  const scrubRes = SecretScrubber.scrub(combinedPayload);
  assert.strictEqual(scrubRes.redactedCount >= canaries.length, true, 'Should redact all canary rules');
  assertNoCanaryLeak('SecretScrubber.scrub', scrubRes.text);
  assertNoCanaryLeak('SecretRedactor.redact', SecretRedactor.redact(combinedPayload).sanitized);
  assertNoCanaryLeak('SecretSanitizer.sanitize', SecretSanitizer.sanitize(combinedPayload));

  // Verify recursive object & circular reference safety
  const cyclicObj: any = {
    nested: {
      secretHeader: canaries[0]!.value,
      arr: [canaries[1]!.value, dynamicSecret],
    },
  };
  cyclicObj.self = cyclicObj;
  const scrubbedObj = SecretScrubber.scrubObject(cyclicObj);
  assertNoCanaryLeak('SecretScrubber.scrubObject', JSON.stringify({ nested: scrubbedObj.nested }));
  console.log('  [PASS] Direct scrubber, wrappers, and cyclic object scrubbing verified.');

  // 2. Surface 1: Structured JSONL Logger (`services/observability/Logger.ts`)
  console.log('2. Testing Surface 1: Structured JSONL Logger...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intershade-canary-'));
  Logger.setLogDirectory(tmpDir);
  Logger.info('ProviderEngine', 'Executing provider call with sensitive payload', {
    traceId: 'trace-canary-001',
    data: {
      payload: combinedPayload,
      apiKey: canaries[2]!.value,
    },
  });
  Logger.setLogDirectory(null);
  const logFile = path.join(tmpDir, 'intershader.jsonl');
  const logDiskContent = fs.readFileSync(logFile, 'utf-8');
  assertNoCanaryLeak('Surface 1 (Logger JSONL)', logDiskContent);
  assert.ok(logDiskContent.includes('trace-canary-001'), 'Logger must preserve traceId');
  console.log('  [PASS] Surface 1 (Structured JSONL Logger) verified.');

  // 3. Surface 2 & 3: SQLite FTS Memory, Trajectory table, and Markdown Export
  console.log('3. Testing Surface 2 & 3: SQLite FTS5 Memory, Trajectory DB & Markdown Export...');
  const projectId = `canary-proj-${Date.now()}`;
  const mem = FtsMemoryService.recordMemory({
    projectId,
    type: 'lesson',
    title: `Auth lesson with ${canaries[0]!.value}`,
    content: combinedPayload,
  });
  assertNoCanaryLeak('Surface 3 (FtsMemoryService.recordMemory return)', JSON.stringify(mem));

  const db = getDatabase();
  const dbRow = db.prepare('SELECT title, content, title_folded, content_folded FROM memories WHERE id = ?').get(mem.id);
  assertNoCanaryLeak('Surface 3 (SQLite memories row)', JSON.stringify(dbRow));

  const ftsRow = db.prepare('SELECT title, content, title_folded, content_folded FROM memories_fts WHERE id = ?').get(mem.id);
  assertNoCanaryLeak('Surface 3 (SQLite memories_fts row)', JSON.stringify(ftsRow));

  const traj = TrajectoryRecorder.recordTrajectory({
    sessionId: 'sess-canary',
    taskId: 'task-canary',
    intent: 'bug_fixing',
    prompt: combinedPayload,
    stagesExecuted: ['reproduce', 'verify'],
    changedFiles: ['auth.ts'],
    status: 'SUCCESS',
    reproEvidence: `Output contained ${canaries[3]!.value}`,
    tokensUsed: 100,
    durationMs: 50,
  });
  const trajRow = db.prepare('SELECT prompt, repro_evidence FROM trajectories WHERE id = ?').get(traj.id);
  assertNoCanaryLeak('Surface 3 (SQLite trajectories row)', JSON.stringify(trajRow));

  const exportedFile = FtsMemoryService.exportToMarkdown(tmpDir, projectId);
  const exportedMarkdown = fs.readFileSync(exportedFile, 'utf-8');
  assertNoCanaryLeak('Surface 2 (Markdown Export)', exportedMarkdown);
  console.log('  [PASS] Surface 2 & 3 (SQLite FTS, Trajectories, and Markdown Export) verified.');

  // 4. Surface 4: Gateway HTTP / Error Payload
  console.log('4. Testing Surface 4: Gateway HTTP Response / Error Scrubbing...');
  const fakeGatewayResponse = SecretScrubber.scrubObject({
    status: 'error',
    error: `Upstream failed with key ${canaries[1]!.value} and ${canaries[8]!.value}`,
    details: combinedPayload,
  });
  assertNoCanaryLeak('Surface 4 (Gateway HTTP JSON)', JSON.stringify(fakeGatewayResponse));
  console.log('  [PASS] Surface 4 (Gateway HTTP Response) verified.');

  // 5. Surface 5: Telegram Outbound Diff Preview & Message
  console.log('5. Testing Surface 5: Telegram Diff Preview & Outbound Message...');
  const tgFormatted = TelegramAdapter.formatApprovalRequest(
    998877,
    'task-canary-tg',
    `Deploy with ${canaries[0]!.value}`,
    combinedPayload,
    { nonce: 'abcdef1234567890' }
  );
  assertNoCanaryLeak('Surface 5 (Telegram Diff Preview)', tgFormatted.text);
  console.log('  [PASS] Surface 5 (Telegram Outbound Diff Preview) verified.');

  // 6. Surface 6: Proof Bundle Gate Log on Disk (`EvidenceStore.persistGateLog`)
  console.log('6. Testing Surface 6: Proof Bundle Gate Log on Disk...');
  const runId = `canary-proof-${Date.now()}`;
  const relLogPath = EvidenceStore.persistGateLog(
    tmpDir,
    runId,
    'tier1-tests.log',
    `${combinedPayload}\nSTDERR leak attempt: ${canaries[4]!.value}`
  );
  const fullGateLogPath = path.join(tmpDir, relLogPath);
  const gateLogContent = fs.readFileSync(fullGateLogPath, 'utf-8');
  assertNoCanaryLeak('Surface 6 (Proof Bundle Gate Log)', gateLogContent);
  console.log('  [PASS] Surface 6 (Proof Bundle Gate Log) verified.');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n=== All SecretScrubber & 6-Surface Canary Tests Passed! ===');
}

runSecretCanaryTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
