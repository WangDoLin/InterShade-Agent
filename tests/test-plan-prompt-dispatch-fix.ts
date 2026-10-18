import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { PlanManager } from '../state/PlanManager.js';
import { planCommand } from '../cli/commands/builtinCommands.js';

async function runTests() {
  console.log('🧪 Starting Plan Prompt Dispatch & Freeze Fix Verification...');

  const sessionId = `test-plan-dispatch-${randomUUID()}`;
  const mockState: Record<string, unknown> = {
    id: sessionId,
    permissionMode: 'default',
  };

  // 1. Test /plan on
  const onRes = await planCommand.execute({
    cwd: process.cwd(),
    sessionState: mockState as any,
    args: ['on'],
  });
  assert.strictEqual(mockState.permissionMode, 'plan', 'Permission mode should be plan');
  assert.ok(onRes.includes('[PLAN MODE ON]'));
  console.log('✔ /plan on correctly sets plan mode.');

  // 2. Test /plan off
  const offRes = await planCommand.execute({
    cwd: process.cwd(),
    sessionState: mockState as any,
    args: ['off'],
  });
  assert.strictEqual(mockState.permissionMode, 'default', 'Permission mode should be default');
  assert.ok(offRes.includes('[PLAN MODE OFF]'));
  console.log('✔ /plan off correctly restores default mode.');

  // 3. Test /plan with target scope
  const scopeRes = await planCommand.execute({
    cwd: process.cwd(),
    sessionState: mockState as any,
    args: ['tự', 'build', 'model', 'AI', 'mà', 'không', 'dựa', 'vào', 'model', 'của', 'brand', 'khác'],
  });
  assert.strictEqual(mockState.permissionMode, 'plan', 'Permission mode should switch to plan for planning task');
  assert.ok(scopeRes.includes('Target Scope: tự build model AI'));
  console.log('✔ /plan <scope> correctly switches to plan mode and records target scope.');

  // 4. Test PlanManager lifecycle
  PlanManager.createOrReplacePlan(sessionId, {
    title: 'Autonomous AI Model Builder Plan',
    steps: [
      { id: '1', title: 'Data Pipeline & Tokenizer Architecture' },
      { id: '2', title: 'Transformer Core from Scratch' },
    ],
  });

  const activePlan = PlanManager.getActivePlan(sessionId);
  assert.ok(activePlan);
  assert.strictEqual(activePlan.steps.length, 2);

  const viewRes = await planCommand.execute({
    cwd: process.cwd(),
    sessionState: mockState as any,
    args: ['view'],
  });
  assert.ok(viewRes.includes('Autonomous AI Model Builder Plan'));
  console.log('✔ PlanManager active plan view verified.');

  PlanManager.clearPlan(sessionId);
  assert.strictEqual(PlanManager.getActivePlan(sessionId), null);
  console.log('✔ PlanManager active plan reset verified.');

  console.log('\n🎉 ALL PLAN PROMPT DISPATCH TESTS PASSED (100% EMPIRICAL PROOF)!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
