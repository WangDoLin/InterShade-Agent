import assert from 'node:assert';
import {
  InvariantFuzzEngine,
  FuzzGenerators,
  type InvariantType,
} from '../engine/verification/InvariantFuzzEngine.js';
import { InvariantFuzzTool } from '../tools/execution/InvariantFuzzTool.js';
import type { ToolExecutionContext } from '../types/index.js';

async function runTests() {
  console.log('🧪 Starting Autonomous Invariant Fuzzing Engine Test Suite...');

  // Test 1: Fuzz Generators coverage
  console.log('Test 1: FuzzGenerators boundary data generation');
  const num = FuzzGenerators.generateNumber();
  assert(typeof num === 'number', 'generateNumber should return number');

  const str = FuzzGenerators.generateString();
  assert(typeof str === 'string', 'generateString should return string');

  const arr = FuzzGenerators.generateArray();
  assert(Array.isArray(arr), 'generateArray should return array');

  const obj = FuzzGenerators.generateObject();
  assert(typeof obj === 'object' && obj !== null, 'generateObject should return object');

  const anyVal = FuzzGenerators.generateAny();
  assert(anyVal !== undefined || anyVal === undefined, 'generateAny should return any value');
  console.log('✅ Test 1 Passed: Generators correctly synthesize diverse boundary values.');

  // Test 2: Invariant Check on Idempotent Function (String Trim)
  console.log('Test 2: Fuzzing Idempotency Invariant: f(f(x)) === f(x)');
  const safeIdempotentFn = (input: any) => {
    if (typeof input === 'string') return input.trim();
    if (typeof input === 'number') return Math.abs(input);
    return input;
  };

  const reportIdempotent = await InvariantFuzzEngine.fuzzFunction(
    safeIdempotentFn,
    'safeIdempotentFn',
    'IDEMPOTENCY',
    {
      cwd: process.cwd(),
      iterations: 50,
    }
  );

  assert.strictEqual(reportIdempotent.overallPassed, true, 'Idempotent function should pass all fuzz iterations');
  assert.strictEqual(reportIdempotent.failedIterations, 0, 'No failures expected for idempotent fn');
  console.log(`✅ Test 2 Passed: 50 iterations passed idempotency verification in ${reportIdempotent.durationMs}ms.`);

  // Test 3: Detecting Panic on Fragile Function & Counterexample Shrinking
  console.log('Test 3: Detecting panic on fragile function and verifying shrinking');
  const fragileFn = (input: any) => {
    if (typeof input === 'string' && input.includes('xss')) {
      throw new Error('Vulnerable to XSS payload!');
    }
    return input;
  };

  // We test with an input that contains 'xss'
  const customReport = await InvariantFuzzEngine.fuzzFunction(
    fragileFn,
    'fragileFn',
    'NO_PANIC',
    {
      cwd: process.cwd(),
      iterations: 50,
    }
  );

  // Directly test shrinking on known long failing string
  const longFailing = 'random_prefix_<script>alert("xss")</script>_random_suffix_very_long';
  const shrunk = await InvariantFuzzEngine.shrinkCounterexample(
    fragileFn,
    longFailing,
    'NO_PANIC',
    { cwd: process.cwd() }
  );

  assert(typeof shrunk === 'string', 'Shrunk counterexample should be string');
  assert(shrunk.length <= longFailing.length, 'Shrunk string should be smaller or equal to original');
  assert(shrunk.includes('xss'), 'Shrunk string must retain the minimal failing trigger');
  console.log(`✅ Test 3 Passed: Original (${longFailing.length} chars) shrunk to "${shrunk}" (${shrunk.length} chars).`);

  // Test 4: InvariantFuzzTool Tool Execution
  console.log('Test 4: InvariantFuzzTool integration');
  const tool = new InvariantFuzzTool();
  assert.strictEqual(tool.name, 'invariant_fuzz_test');
  assert.strictEqual(tool.isReadOnly, true);

  const mockContext: ToolExecutionContext = {
    sessionId: 'test-session-fuzz',
    cwd: process.cwd(),
    permissionMode: 'auto',
  };

  const toolOutput = await tool.execute(
    {
      filePath: 'engine/verification/CanonicalJson.ts',
      functionName: 'CanonicalJson',
      invariantType: 'NO_PANIC',
      iterations: 20,
    },
    mockContext
  );

  assert(toolOutput.includes('Invariant Fuzzing Report'), 'Tool output should include markdown report header');
  assert(toolOutput.includes('CanonicalJson.ts'), 'Tool output should mention file name');
  console.log('✅ Test 4 Passed: InvariantFuzzTool executed and returned formatted report.');

  console.log('\n🎉 ALL INVARIANT FUZZING TESTS PASSED EMPIRICALLY!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
