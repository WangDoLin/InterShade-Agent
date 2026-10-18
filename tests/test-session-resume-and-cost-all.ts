import assert from 'assert';
import { SessionStore } from '../state/SessionStore.js';
import {
  CommandRegistry,
  registerBuiltinCommands,
  costCommand,
  statsCommand,
  resumeCommand,
  sessionsCommand,
} from '../cli/commands/index.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';

console.log('[TEST]: Starting Session Resume & Cost/Token Tracking Test Suite...');

async function runTests() {
  // 1. Verify CommandRegistry registration
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);

  assert.ok(registry.has('cost'), 'Registry should contain cost command');
  assert.ok(registry.has('pricing'), 'Registry should resolve alias pricing -> cost');
  assert.ok(registry.has('billing'), 'Registry should resolve alias billing -> cost');
  assert.ok(registry.has('stats'), 'Registry should contain stats command');
  assert.ok(registry.has('tokens'), 'Registry should resolve alias tokens -> stats');
  assert.ok(registry.has('usage'), 'Registry should resolve alias usage -> stats');
  assert.ok(registry.has('resume'), 'Registry should contain resume command');
  assert.ok(registry.has('switch'), 'Registry should resolve alias switch -> resume');
  assert.ok(registry.has('load'), 'Registry should resolve alias load -> resume');
  assert.ok(registry.has('sessions'), 'Registry should contain sessions command');
  assert.ok(registry.has('history'), 'Registry should resolve alias history -> sessions');
  console.log('[PASS]: 1. Command registry and aliases verified.');

  // 2. Test SessionStore.getTotalUsage() and listSessions()
  const totalUsage = SessionStore.getTotalUsage();
  assert.ok(typeof totalUsage.totalSessions === 'number', 'totalSessions should be a number');
  assert.ok(typeof totalUsage.totalInputTokens === 'number', 'totalInputTokens should be a number');
  assert.ok(typeof totalUsage.totalOutputTokens === 'number', 'totalOutputTokens should be a number');
  assert.ok(typeof totalUsage.totalCostUsd === 'number', 'totalCostUsd should be a number');
  assert.ok(totalUsage.totalTokens === totalUsage.totalInputTokens + totalUsage.totalOutputTokens, 'totalTokens = input + output');
  console.log(`[PASS]: 2. Total usage query verified: ${totalUsage.totalTokens.toLocaleString()} tokens, $${totalUsage.totalCostUsd.toFixed(4)} USD.`);

  const sessionList = SessionStore.listSessions(5);
  assert.ok(Array.isArray(sessionList), 'listSessions should return an array');
  console.log(`[PASS]: 2b. listSessions returned ${sessionList.length} recent sessions.`);

  // 3. Test Prefix ID lookup in SessionStore.getSession
  if (sessionList.length > 0) {
    const firstSession = sessionList[0];
    const prefix = firstSession.id.slice(0, 6);
    const foundByPrefix = SessionStore.getSession(prefix);
    assert.ok(foundByPrefix, `Should find session by prefix ${prefix}`);
    assert.strictEqual(foundByPrefix?.id, firstSession.id, 'Prefix should resolve to correct session');
    console.log(`[PASS]: 3. Prefix matching verified: ${prefix} -> ${foundByPrefix?.id}`);
  }

  // 4. Test costCommand execution modes:
  const mockCtx = {
    cwd: process.cwd(),
    sessionState: {
      id: 'mock-test-session-123456',
      totalInputTokens: 100000,
      totalOutputTokens: 20000,
      totalCostUsd: 0.60,
    },
    args: [] as string[],
  };

  // 4a. /cost current
  const costCurrent = await costCommand.execute(mockCtx);
  assert.ok(costCurrent.includes('Estimated Session Cost:'), 'Current cost should include Estimated Session Cost:');
  assert.ok(costCurrent.includes('$0.6000 USD'), 'Current cost should show calculated or recorded cost');
  console.log('[PASS]: 4a. /cost current session verified.');

  // 4b. /cost all
  mockCtx.args = ['all'];
  const costAll = await costCommand.execute(mockCtx);
  assert.ok(costAll.includes('Total Historical Cost & Token Summary'), 'Cost all should display header');
  assert.ok(costAll.includes('Total Estimated Cost:'), 'Cost all should include Total Estimated Cost');
  console.log('[PASS]: 4b. /cost all verified.');

  // 4c. /cost <id>
  if (sessionList.length > 0) {
    mockCtx.args = [sessionList[0].id.slice(0, 8)];
    const costSingle = await costCommand.execute(mockCtx);
    assert.ok(costSingle.includes('Session Cost ['), 'Single session cost should display session cost header');
    console.log('[PASS]: 4c. /cost <id> verified.');
  }

  // 5. Test statsCommand execution modes:
  mockCtx.args = [];
  const statsCurrent = await statsCommand.execute(mockCtx);
  assert.ok(statsCurrent.includes('Input Tokens:  100,000'), 'Current stats should display input tokens');
  assert.ok(statsCurrent.includes('Output Tokens: 20,000'), 'Current stats should display output tokens');

  mockCtx.args = ['all'];
  const statsAll = await statsCommand.execute(mockCtx);
  assert.ok(statsAll.includes('Total Historical Token Statistics'), 'Stats all should display header');
  assert.ok(statsAll.includes('Total Tokens:'), 'Stats all should display total tokens');
  console.log('[PASS]: 5. statsCommand (/tokens, /usage) all & current verified.');

  // 6. Test resumeCommand execution
  mockCtx.args = [];
  const resumeHelp = await resumeCommand.execute(mockCtx);
  assert.ok(resumeHelp.includes('Conversations available to resume:'), 'Resume command with no args should list sessions');

  // 7. Test QueryEngine switchSession
  const engine = new QueryEngine({
    cwd: process.cwd(),
    model: 'gemini-2.5-flash',
    provider: 'google',
    resumeSession: false,
    maxTokens: 160000,
    permissionMode: 'default',
  });

  const initialId = engine.getSessionState().id;
  if (sessionList.length > 0) {
    const target = sessionList[0];
    const switchRes = engine.switchSession(target.id.slice(0, 8));
    assert.ok(switchRes.success, 'switchSession should succeed');
    assert.strictEqual(engine.getSessionState().id, target.id, 'Engine session ID should match resumed target');
    console.log(`[PASS]: 7. QueryEngine.switchSession from ${initialId} to ${target.id} succeeded.`);
  }

  console.log('\n[SUCCESS]: All Session Resume & Cost/Token Tracking Tests PASSED!');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('[FAIL]: Test error:', err);
  process.exit(1);
});
