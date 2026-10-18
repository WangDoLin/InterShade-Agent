import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import type { SessionConfig } from '../types/index.js';

console.log('🧪 Starting Mode Max 2.0 Power Upgrade Verification...');

const testCwd = path.resolve(process.cwd());

const baseConfig: SessionConfig = {
  cwd: testCwd,
  model: 'gemini-2.5-pro',
  provider: 'google',
  maxTokens: 8192,
  permissionMode: 'default',
  thinkingBudget: 2048,
};

const qe = new QueryEngine(baseConfig);

// 1. Verify Deep Repo Graph generation
console.log('Test 1: Deep Repo Graph generation');
const graphDigest = qe.getDeepRepoGraphDigest(testCwd);
assert.ok(typeof graphDigest === 'string', 'Graph digest must be a string');
assert.ok(
  graphDigest.includes('[MODE MAX: DEEP REPOSITORY ARCHITECTURAL GRAPH]'),
  'Graph digest must include header'
);
assert.ok(
  graphDigest.includes('### `') || graphDigest.includes('```ts'),
  'Graph digest must contain extracted AST skeletons'
);
console.log('✔ Test 1 Passed: getDeepRepoGraphDigest correctly constructs AST skeleton map.');

// 2. Verify Mode Max prompt injection
console.log('Test 2: Mode Max Prompt Injection');
const initialMessages = qe.getMessages();
const initialSys = initialMessages[0].content;
assert.ok(
  !initialSys.includes('Super-Intelligence Protocol Active'),
  'Initial system prompt without Mode Max must NOT contain Mode Max directive'
);
assert.ok(
  !initialSys.includes('[MODE MAX: DEEP REPOSITORY ARCHITECTURAL GRAPH]'),
  'Initial system prompt without Mode Max must NOT contain deep repo graph'
);

// Toggle Mode Max ON
qe.setMaxingMode(true, 32768);
const maxMessages = qe.getMessages();
const maxSys = maxMessages[0].content;

assert.ok(
  maxSys.includes('Super-Intelligence Protocol Active'),
  'Mode Max prompt must include Super-Intelligence Protocol directive'
);
assert.ok(
  maxSys.includes('[MODE MAX: DEEP REPOSITORY ARCHITECTURAL GRAPH]'),
  'Mode Max prompt must include Deep Repository Architectural Graph'
);
console.log('✔ Test 2 Passed: Enabling Maxing Mode immediately injects Mode Max directive and Deep Repo Graph into system prompt.');

// 3. Verify Mode Max toggles back OFF cleanly
console.log('Test 3: Mode Max Clean Revert');
qe.setMaxingMode(false);
const revertedMessages = qe.getMessages();
const revertedSys = revertedMessages[0].content;

assert.ok(
  !revertedSys.includes('Super-Intelligence Protocol Active'),
  'Reverted system prompt must NOT contain Mode Max directive'
);
assert.ok(
  !revertedSys.includes('[MODE MAX: DEEP REPOSITORY ARCHITECTURAL GRAPH]'),
  'Reverted system prompt must NOT contain deep repo graph'
);
console.log('✔ Test 3 Passed: Disabling Maxing Mode cleanly reverts prompt to standard baseline.');

console.log('🎉 ALL MODE MAX 2.0 POWER UPGRADE TESTS PASSED!');
