import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { foldVietnameseText, getDatabase } from '../state/Database.js';
import { FtsMemoryService } from '../services/memory/FtsMemoryService.js';
import { MemoryWriteQueue } from '../services/memory/MemoryWriteQueue.js';
import { PlanManager } from '../state/PlanManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runVietnameseFtsAndMemoryTests() {
  console.log('=== Running Vietnamese Folded FTS5, Golden BM25, WriteQueue & PlanRevisions Tests (NEXT-C-08..14) ===\n');

  // 1. Verify foldVietnameseText helper
  console.log('1. Testing foldVietnameseText (NFD + combining mark strip + đ/Đ -> d)...');
  assert.strictEqual(
    foldVietnameseText('Tối ưu hóa bộ nhớ ĐA LUỒNG và điều phối đồng bộ'),
    'toi uu hoa bo nho da luong va dieu phoi dong bo'
  );
  console.log('  [PASS] foldVietnameseText verified.');

  // 2. Load 30 Golden Queries & Corpus (NEXT-C-08..10)
  console.log('2. Testing 30 Golden Bilingual Queries (Exact + Folded RRF)...');
  const fixturePath = path.join(__dirname, 'fixtures', 'golden-queries.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
    corpus: Array<{
      key: string;
      type: 'decision' | 'lesson' | 'architecture' | 'bug_pattern' | 'skill';
      title: string;
      content: string;
    }>;
    queries: Array<{
      id: string;
      query: string;
      expectedKey: string;
      category: string;
    }>;
  };

  assert.strictEqual(fixture.queries.length, 30, 'Fixture must contain exactly 30 golden queries');

  const projectId = `golden-fts-${Date.now()}`;
  const writeQueue = new MemoryWriteQueue({ maxBatchSize: 20 });
  const idToKey = new Map<string, string>();

  // Enqueue via MemoryWriteQueue (NEXT-C-11)
  const enqueuePromises = fixture.corpus.map((doc) =>
    writeQueue.enqueue({
      projectId,
      type: doc.type,
      title: doc.title,
      content: doc.content,
    })
  );
  writeQueue.flushSync();
  const insertedEntries = await Promise.all(enqueuePromises);
  insertedEntries.forEach((entry, idx) => {
    idToKey.set(entry.id, fixture.corpus[idx]!.key);
  });

  let hitsAt1 = 0;
  let hitsAt3 = 0;
  let reciprocalRankSum = 0;

  for (const q of fixture.queries) {
    const results = FtsMemoryService.searchMemories(q.query, { projectId, limit: 5 });
    const rankIdx = results.findIndex((r) => idToKey.get(r.id) === q.expectedKey);
    if (rankIdx === 0) {
      hitsAt1++;
      hitsAt3++;
      reciprocalRankSum += 1.0;
    } else if (rankIdx > 0 && rankIdx < 3) {
      hitsAt3++;
      reciprocalRankSum += 1.0 / (rankIdx + 1);
    } else if (rankIdx >= 3) {
      reciprocalRankSum += 1.0 / (rankIdx + 1);
    } else {
      console.error(`  [MISS] Query ${q.id} ("${q.query}") did not find ${q.expectedKey}`);
    }
  }

  const recallAt1 = hitsAt1 / fixture.queries.length;
  const recallAt3 = hitsAt3 / fixture.queries.length;
  const mrr = reciprocalRankSum / fixture.queries.length;

  console.log(
    `  Golden Suite Metrics (30 queries): Recall@1=${(recallAt1 * 100).toFixed(1)}%, Recall@3=${(
      recallAt3 * 100
    ).toFixed(1)}%, MRR=${mrr.toFixed(3)}`
  );
  assert.ok(recallAt3 >= 0.9, `Recall@3 must be >= 0.90, got ${recallAt3}`);
  assert.ok(mrr >= 0.85, `MRR must be >= 0.85, got ${mrr}`);
  console.log('  [PASS] 30 Golden Bilingual Queries (Vietnamese accented/unaccented + English) passed.');

  // 3. Test token-budgeted formatMemoriesForContext (NEXT-C-14)
  console.log('3. Testing token-budgeted formatMemoriesForContext (NEXT-C-14)...');
  const budgeted = FtsMemoryService.formatMemoriesForContext(projectId, 'bảo mật telegram', 80);
  assert.ok(budgeted.length <= 80 * 4 + 64, 'Context injection must respect maxTokens budget');
  console.log('  [PASS] Token-budgeted context formatting verified.');

  // 4. Test retention pruning pruneOldMemories (NEXT-C-12)
  console.log('4. Testing pruneOldMemories retention policy (NEXT-C-12)...');
  const deletedCount = FtsMemoryService.pruneOldMemories(projectId, 8);
  assert.strictEqual(deletedCount, 4, 'Should prune oldest 4 of 12 memories');
  const remaining = FtsMemoryService.getMemoriesForProject(projectId);
  assert.strictEqual(remaining.length, 8, 'Should retain 8 newest memories');
  console.log('  [PASS] Memory retention pruning verified.');

  // 5. Test normalized plan_revisions table in PlanManager (NEXT-C-13)
  console.log('5. Testing normalized plan_revisions table in PlanManager (NEXT-C-13)...');
  const db = getDatabase();
  const sessionId = `sess-plan-rev-${Date.now()}`;
  db.prepare(`
    INSERT INTO sessions (id, title, model, provider, cwd, permission_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, 'Plan Revisions Test Session', 'gpt-4o', 'openai', process.cwd(), 'default', Date.now(), Date.now());
  const session = { id: sessionId };

  PlanManager.createOrReplacePlan(session.id, {
    title: 'Wave 7 Upgrade Plan',
    overview: 'Normalized revisions test',
    steps: [
      { id: '1', title: 'Create schema v2' },
      { id: '2', title: 'Add RRF search' },
    ],
    acceptanceCriteria: ['All 30 golden queries pass'],
  });

  PlanManager.mergePlan(session.id, {
    additionsOrChangesText: 'Add step 3 for pruning',
    steps: [
      { id: '1', title: 'Create schema v2', status: 'completed' },
      { id: '2', title: 'Add RRF search', status: 'in_progress' },
      { id: '3', title: 'Add memory pruning', status: 'pending' },
    ],
  });

  const dbRevisions = PlanManager.getRevisions(session.id);
  assert.strictEqual(dbRevisions.length, 2, 'plan_revisions table should store both v1 and v2');
  assert.strictEqual(dbRevisions[0]!.version, 1);
  assert.strictEqual(dbRevisions[1]!.version, 2);
  assert.strictEqual(dbRevisions[1]!.steps.length, 3);

  // Verify session_plans.revisions_json only keeps the latest revision to avoid unbounded bloat
  const planRow = db
    .prepare('SELECT revisions_json FROM session_plans WHERE session_id = ?')
    .get(session.id) as { revisions_json: string };
  const inlineRevs = JSON.parse(planRow.revisions_json);
  assert.strictEqual(
    inlineRevs.length,
    1,
    'session_plans.revisions_json should only retain latest summary while plan_revisions stores full history'
  );

  PlanManager.clearPlan(session.id);
  assert.strictEqual(PlanManager.getRevisions(session.id).length, 0, 'clearPlan should remove plan_revisions rows');
  console.log('  [PASS] Normalized plan_revisions table verified.');

  console.log('\n=== All Vietnamese FTS5, Golden BM25, WriteQueue & PlanRevisions Tests Passed! ===');
}

runVietnameseFtsAndMemoryTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
