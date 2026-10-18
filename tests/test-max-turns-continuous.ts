import assert from 'node:assert';
import { config } from '../config/index.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import { CommandRegistry } from '../cli/commands/CommandRegistry.js';
import { registerBuiltinCommands, turnsCommand, statusCommand } from '../cli/commands/builtinCommands.js';

console.log('=== Test 1: Config Max Turns Default & Robust Parsing ===');
assert.strictEqual(typeof config.maxTurns, 'number');
assert.ok(config.maxTurns >= 0, 'Default max turns should be >= 0');
console.log(`[PASS] Config maxTurns default: ${config.maxTurns}`);

console.log('=== Test 2: QueryEngine Max Turns Lifecycle & SessionState Sync ===');
const engine = new QueryEngine({
  provider: 'openai',
  model: 'gpt-4o',
  cwd: process.cwd(),
  maxTokens: 100000,
  permissionMode: 'default',
  resumeSession: false,
});

assert.strictEqual(engine.getMaxTurns(), config.maxTurns);
assert.strictEqual(engine.getSessionState().maxTurns, config.maxTurns);

engine.updateMaxTurns(150);
assert.strictEqual(engine.getMaxTurns(), 150);
assert.strictEqual(engine.getSessionState().maxTurns, 150);

engine.updateMaxTurns(0);
assert.strictEqual(engine.getMaxTurns(), 0);
assert.strictEqual(engine.getSessionState().maxTurns, 0);
console.log('[PASS] QueryEngine maxTurns get/update operational and synchronized with getSessionState()');

console.log('=== Test 3: turnsCommand Execution & Multi-Language Aliases ===');
const fakeSessionState: Record<string, unknown> = {
  maxTurns: 100,
};

// 3a. Query current limit
const res1 = turnsCommand.execute({
  args: [],
  cwd: process.cwd(),
  sessionState: fakeSessionState,
});
assert.ok(typeof res1 === 'string' && res1.includes('100 turns'));
console.log(`[PASS] Query returns: ${res1}`);

// 3b. Update limit to 75
const res2 = turnsCommand.execute({
  args: ['75'],
  cwd: process.cwd(),
  sessionState: fakeSessionState,
});
assert.strictEqual(fakeSessionState.maxTurns, 75);
assert.ok(typeof res2 === 'string' && res2.includes('75 turns'));
console.log(`[PASS] Update returns: ${res2}`);

// 3c. Update to unlimited
const res3 = turnsCommand.execute({
  args: ['unlimited'],
  cwd: process.cwd(),
  sessionState: fakeSessionState,
});
assert.strictEqual(fakeSessionState.maxTurns, 0);
assert.ok(typeof res3 === 'string' && res3.includes('Unlimited'));
console.log(`[PASS] Unlimited returns: ${res3}`);

// 3d. Update to 0 (also unlimited)
fakeSessionState.maxTurns = 50;
const res4 = turnsCommand.execute({
  args: ['0'],
  cwd: process.cwd(),
  sessionState: fakeSessionState,
});
assert.strictEqual(fakeSessionState.maxTurns, 0);
assert.ok(typeof res4 === 'string' && res4.includes('Unlimited'));
console.log(`[PASS] 0 returns: ${res4}`);

// 3e. Update via Vietnamese: "vô hạn"
fakeSessionState.maxTurns = 50;
const res5 = turnsCommand.execute({
  args: ['vô', 'hạn'],
  cwd: process.cwd(),
  sessionState: fakeSessionState,
});
assert.strictEqual(fakeSessionState.maxTurns, 0);
assert.ok(typeof res5 === 'string' && res5.includes('Unlimited'));
console.log(`[PASS] "vô hạn" returns: ${res5}`);

// 3f. Update via Vietnamese: "vo han"
fakeSessionState.maxTurns = 50;
const res6 = turnsCommand.execute({
  args: ['vo', 'han'],
  cwd: process.cwd(),
  sessionState: fakeSessionState,
});
assert.strictEqual(fakeSessionState.maxTurns, 0);
assert.ok(typeof res6 === 'string' && res6.includes('Unlimited'));
console.log(`[PASS] "vo han" returns: ${res6}`);

// 3g. Update via "continuous"
fakeSessionState.maxTurns = 50;
const res7 = turnsCommand.execute({
  args: ['continuous'],
  cwd: process.cwd(),
  sessionState: fakeSessionState,
});
assert.strictEqual(fakeSessionState.maxTurns, 0);
assert.ok(typeof res7 === 'string' && res7.includes('Unlimited'));
console.log(`[PASS] "continuous" returns: ${res7}`);

console.log('=== Test 4: Command Registry Integration & Unprefixed Matching ===');
const registry = new CommandRegistry();
registerBuiltinCommands(registry);

// 4a. /turns 200
const p1 = registry.parseInput('/turns 200');
assert.ok(p1);
assert.strictEqual(p1?.commandName, 'turns');
assert.deepStrictEqual(p1?.args, ['200']);

// 4b. /turn unlimited
const p2 = registry.parseInput('/turn unlimited');
assert.ok(p2);
assert.strictEqual(p2?.commandName, 'turn');
assert.deepStrictEqual(p2?.args, ['unlimited']);
assert.strictEqual(registry.get('turn')?.name, 'turns');

// 4c. /unlimited
const p3 = registry.parseInput('/unlimited');
assert.ok(p3);
assert.strictEqual(p3?.commandName, 'unlimited');
assert.strictEqual(registry.get('unlimited')?.name, 'turns');

// 4d. Unprefixed "turns unlimited"
const p4 = registry.parseInput('turns unlimited');
assert.ok(p4);
assert.strictEqual(p4?.commandName, 'turns');
assert.deepStrictEqual(p4?.args, ['unlimited']);

// 4e. Unprefixed "turn unlimited"
const p5 = registry.parseInput('turn unlimited');
assert.ok(p5);
assert.strictEqual(p5?.commandName, 'turn');
assert.deepStrictEqual(p5?.args, ['unlimited']);

// 4f. Unprefixed "unlimited"
const p6 = registry.parseInput('unlimited');
assert.ok(p6);
assert.strictEqual(p6?.commandName, 'unlimited');

console.log('[PASS] All turns aliases and unprefixed commands matched in CommandRegistry');

console.log('=== Test 5: statusCommand Reflects Unlimited Turn Limit ===');
fakeSessionState.maxTurns = 0;
const statusOut = statusCommand.execute({
  args: [],
  cwd: process.cwd(),
  sessionState: fakeSessionState,
});
assert.ok(typeof statusOut === 'string');
assert.ok(statusOut.includes('Unlimited (Continuous)'), `Status output must display Unlimited: ${statusOut}`);
console.log('[PASS] statusCommand correctly reflects Unlimited (Continuous) turn limit');

console.log('\nAll Max Turns & Continuous Execution Tests PASSED (100%)! 🎉');
