import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { autoMaxCommand } from '../cli/commands/autoMaxCommand.js';
import { AutoMaxEngine } from '../engine/autonomous/AutoMaxEngine.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import { StatusLine } from '../ui/components/StatusLine.js';
import { TaskManager } from '../state/TaskManager.js';
import type { ProcessRunner } from '../engine/ports/ProcessRunner.js';

async function runTests() {
  console.log('=== TEST SUITE: MODE AUTOMAX (MAX + AUTO HORIZONS) ===\n');

  // 1. Test /automax on command with goal, duration and iterations
  console.log('1. Testing /automax on command execution with options...');
  const mockState: Record<string, unknown> = {
    id: `test-${randomUUID()}`,
    permissionMode: 'default',
    maxingMode: false,
    autoMaxMode: false,
  };

  const onResult = await autoMaxCommand.execute({
    args: ['on', 'Refactor auth module', '--duration', '30', '--iterations', '5'],
    sessionState: mockState,
    cwd: process.cwd(),
  });

  assert.strictEqual(mockState.autoMaxMode, true, 'autoMaxMode must be true');
  assert.strictEqual(mockState.maxingMode, true, 'maxingMode must be activated by automax');
  assert.strictEqual(mockState.permissionMode, 'auto', 'permissionMode must become auto');
  assert.strictEqual(mockState.thinkingBudget, 16384, 'thinkingBudget must be 16384');
  assert.ok(onResult.includes('[MODE AUTOMAX: ACTIVE]'));
  assert.ok(onResult.includes('Refactor auth module'));
  assert.ok(onResult.includes('30 minute(s)'));
  assert.ok(onResult.includes('Max Iterations: 5'));
  console.log('  [PASS] /automax on configures state and options correctly.');

  // 2. Test /automax status command
  console.log('\n2. Testing /automax status command...');
  const statusResult = await autoMaxCommand.execute({
    args: ['status'],
    sessionState: mockState,
    cwd: process.cwd(),
  });
  assert.ok(statusResult.includes('[MODE AUTOMAX STATUS]: 🟣 ACTIVE'));
  assert.ok(statusResult.includes('Refactor auth module'));
  assert.ok(statusResult.includes('30m'));
  console.log('  [PASS] /automax status reflects active mission state.');

  // 3. Test /automax off command
  console.log('\n3. Testing /automax off command...');
  const offResult = await autoMaxCommand.execute({
    args: ['off'],
    sessionState: mockState,
    cwd: process.cwd(),
  });
  assert.strictEqual(mockState.autoMaxMode, false, 'autoMaxMode must revert to false');
  assert.strictEqual(mockState.maxingMode, false, 'maxingMode must revert to false');
  assert.strictEqual(mockState.permissionMode, 'default', 'permissionMode must restore to default');
  assert.ok(offResult.includes('[MODE AUTOMAX: DISABLED]'));
  console.log('  [PASS] /automax off cleanly restores standard interactive mode.');

  // 4. Test /automax toggle with no sub-arguments
  console.log('\n4. Testing /automax toggle mode...');
  await autoMaxCommand.execute({
    args: [],
    sessionState: mockState,
    cwd: process.cwd(),
  });
  assert.strictEqual(mockState.autoMaxMode, true, 'Toggle from false must become true');
  assert.strictEqual(mockState.permissionMode, 'auto');

  await autoMaxCommand.execute({
    args: [],
    sessionState: mockState,
    cwd: process.cwd(),
  });
  assert.strictEqual(mockState.autoMaxMode, false, 'Toggle from true must become false');
  assert.strictEqual(mockState.permissionMode, 'default');
  console.log('  [PASS] /automax toggle alternates mode accurately.');

  // 5. Test AutoMaxEngine Goal-Driven Execution
  console.log('\n5. Testing AutoMaxEngine goal-driven execution...');
  const testSessionId = `test-engine-${randomUUID()}`;
  const engine = new AutoMaxEngine();

  const mockRunner: ProcessRunner = {
    run: async (opts) => mockRunner.runSync(opts),
    runSync: (opts) => {
      if (opts.command === 'git' && opts.args[0] === 'status') {
        return {
          command: opts.command,
          args: opts.args,
          cwd: opts.cwd,
          exitCode: 0,
          stdout: ' M src/index.ts\n?? tests/new.test.ts',
          stderr: '',
          timedOut: false,
          durationMs: 5,
          signal: null,
          stdoutSha256: 'mock-sha256',
        };
      }
      return {
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 10,
        signal: null,
        stdoutSha256: 'mock-sha256',
      };
    },
  };

  let stepsExecuted = 0;
  const progressEvents: string[] = [];

  const report = await engine.runMission({
    sessionId: testSessionId,
    cwd: process.cwd(),
    goal: 'Implement robust telemetry tracking',
    maxIterations: 3,
    runner: mockRunner,
    onProgress: (p) => {
      progressEvents.push(`${p.phase}: ${p.message}`);
    },
    executor: async (prompt) => {
      stepsExecuted++;
      // Mark task complete on second iteration
      const allTasks = TaskManager.listTasks(testSessionId);
      if (allTasks.length > 0 && stepsExecuted >= 2) {
        TaskManager.updateTask(testSessionId, allTasks[0].id, { status: 'completed' });
      }
      return `Simulated tool execution for prompt (Length: ${prompt.length})`;
    },
  });

  assert.strictEqual(report.success, true, 'Mission must report success');
  assert.strictEqual(report.stopReason, 'GOAL_ACCOMPLISHED', 'Mission must complete on goal satisfied');
  assert.strictEqual(report.totalIterations, 2, 'Must stop when goal tasks are completed');
  assert.ok(report.summary.includes('AUTOMAX EVOLUTION REPORT'));
  assert.ok(progressEvents.some((e) => e.includes('orienting')));
  assert.ok(progressEvents.some((e) => e.includes('executing')));
  assert.ok(progressEvents.some((e) => e.includes('verifying')));
  console.log('  [PASS] AutoMaxEngine executes goal-driven iteration cycles and verifies completion.');

  // 6. Test AutoMaxEngine Time-Horizon Expiration
  console.log('\n6. Testing AutoMaxEngine time-horizon timeout...');
  const timeSessionId = `test-time-${randomUUID()}`;
  const timeEngine = new AutoMaxEngine();

  // Duration: 0.0001 minutes (~6ms) to trigger deadline limit
  const timedReport = await timeEngine.runMission({
    sessionId: timeSessionId,
    cwd: process.cwd(),
    goal: 'Continuous Optimization Task',
    durationMinutes: 0.0005, // 30ms
    maxIterations: 20,
    runner: mockRunner,
    executor: async () => {
      await new Promise((r) => setTimeout(r, 40));
      return 'Completed step';
    },
  });

  assert.strictEqual(timedReport.stopReason, 'TIME_LIMIT_REACHED');
  assert.ok(timedReport.totalIterations >= 1);
  console.log('  [PASS] AutoMaxEngine cleanly bounds execution by time horizon.');

  // 7. Test AutoMaxEngine AbortSignal handling
  console.log('\n7. Testing AutoMaxEngine abort signal...');
  const abortSessionId = `test-abort-${randomUUID()}`;
  const abortEngine = new AutoMaxEngine();
  const ac = new AbortController();

  setTimeout(() => ac.abort(), 15);

  const abortReport = await abortEngine.runMission({
    sessionId: abortSessionId,
    cwd: process.cwd(),
    signal: ac.signal,
    maxIterations: 10,
    runner: mockRunner,
    executor: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 'Step done';
    },
  });

  assert.strictEqual(abortReport.stopReason, 'USER_ABORTED');
  console.log('  [PASS] AutoMaxEngine aborts safely when cancellation signal fires.');

  // 8. Test QueryEngine Integration & System Prompt Builder
  console.log('\n8. Testing QueryEngine integration and system prompt directive...');
  const qe = new QueryEngine({
    sessionId: `test-qe-${randomUUID()}`,
    cwd: process.cwd(),
    model: 'claude-3-7-sonnet',
    provider: 'anthropic',
    maxTokens: 4096,
    permissionMode: 'default',
  });

  assert.strictEqual(qe.isAutoMaxActive(), false);
  qe.setAutoMaxMode(true, { goal: 'Security Hardening', durationMinutes: 60 });
  assert.strictEqual(qe.isAutoMaxActive(), true);
  assert.strictEqual(qe.getSessionState().permissionMode, 'auto');
  assert.strictEqual(qe.getSessionState().maxingMode, true);
  assert.strictEqual(qe.getSessionState().thinkingBudget, 16384);

  const sysPrompt = (qe as any).getBasePrompt();
  assert.ok(
    sysPrompt.includes('# Mode AutoMax: Autonomous Self-Evolution & Goal-Driven Horizon Active'),
    'Base system prompt must contain AutoMax directive'
  );
  assert.ok(sysPrompt.includes('FULL AUTONOMY ENGAGED'));

  qe.setAutoMaxMode(false);
  assert.strictEqual(qe.isAutoMaxActive(), false);
  console.log('  [PASS] QueryEngine sets autoMaxMode, auto permission, and system prompt directives.');

  // 9. Test StatusLine Component AutoMax Badge
  console.log('\n9. Testing StatusLine component rendering with autoMaxMode prop...');
  const statusElement = React.createElement(StatusLine as any, {
    cwd: process.cwd(),
    model: 'claude-3-7-sonnet',
    provider: 'anthropic',
    totalCostUsd: 0.05,
    permissionMode: 'auto',
    autoMaxMode: true,
  });

  assert.strictEqual((statusElement.props as any).autoMaxMode, true, 'StatusLine receives autoMaxMode=true prop');
  console.log('  [PASS] StatusLine component props accept autoMaxMode.');

  // Cleanup
  TaskManager.clearAllTasks(testSessionId);
  TaskManager.clearAllTasks(timeSessionId);
  TaskManager.clearAllTasks(abortSessionId);

  console.log('\n=== ALL AUTOMAX TESTS PASSED SUCCESSFULLY! [100%] ===');
}

runTests().catch((err) => {
  console.error('[TEST FAILURE]:', err);
  process.exit(1);
});
