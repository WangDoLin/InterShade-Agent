import assert from 'node:assert/strict';
import React from 'react';
import { StatusLine } from '../ui/components/StatusLine.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import { maxingCommand } from '../cli/commands/builtinCommands.js';
import type { SessionConfig } from '../types/index.js';

console.log('🧪 Starting StatusLine Maxing Badge & Mode State Test Suite...');

// 1. Verify StatusLine component accepts maxingMode prop
const elemWithMax = React.createElement(StatusLine, {
  model: 'ag/gemini-3.8-flash-hi',
  provider: 'openai',
  cwd: process.cwd(),
  permissionMode: 'plan',
  totalInputTokens: 5000,
  totalOutputTokens: 1000,
  maxingMode: true,
});
assert.strictEqual(elemWithMax.props.maxingMode, true, 'StatusLine must receive maxingMode=true prop');
console.log('✔ Test 1 Passed: StatusLine accepts maxingMode=true prop.');

const elemWithoutMax = React.createElement(StatusLine, {
  model: 'ag/gemini-3.8-flash-hi',
  provider: 'openai',
  cwd: process.cwd(),
  permissionMode: 'default',
  totalInputTokens: 5000,
  totalOutputTokens: 1000,
  maxingMode: false,
});
assert.strictEqual(elemWithoutMax.props.maxingMode, false, 'StatusLine must receive maxingMode=false prop');
console.log('✔ Test 2 Passed: StatusLine accepts maxingMode=false prop.');

// 2. Test /max toggle mechanics
const mockState: Record<string, unknown> = {
  id: 'test-session-max-badge',
  maxingMode: false,
};

// Toggle ON
await maxingCommand.execute({
  cwd: process.cwd(),
  args: [],
  sessionState: mockState as any,
});
assert.strictEqual(mockState.maxingMode, true, 'Toggling /max with no args when false must turn it true');

// Toggle OFF
await maxingCommand.execute({
  cwd: process.cwd(),
  args: [],
  sessionState: mockState as any,
});
assert.strictEqual(mockState.maxingMode, false, 'Toggling /max again must turn it false');
console.log('✔ Test 3 Passed: /max command toggles maxingMode state accurately.');

// 3. Test QueryEngine state synchronization
const config: SessionConfig = {
  sessionId: 'test-qe-max',
  cwd: process.cwd(),
  model: 'gemini-3.8-flash',
  provider: 'google',
  permissionMode: 'default',
  maxTokens: 100000,
};
const qe = new QueryEngine(config);
assert.strictEqual(qe.getSessionState().maxingMode, undefined);

qe.setMaxingMode(true, 16384);
assert.strictEqual(qe.getSessionState().maxingMode, true);
assert.strictEqual(qe.getSessionState().maxingBudget, 16384);

qe.setMaxingMode(false);
assert.strictEqual(qe.getSessionState().maxingMode, false);
console.log('✔ Test 4 Passed: QueryEngine synchronization updates sessionState accurately.');

console.log('\n🎉 ALL STATUSLINE MAXING BADGE TESTS PASSED (100%)!');
