import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MemoryRecordTool } from '../tools/search/MemoryRecordTool.js';
import { TaskTool } from '../tools/task/TaskTool.js';
import { TaskManager } from '../state/TaskManager.js';
import { SessionStore } from '../state/SessionStore.js';
import { ToolExecutionGate } from '../providers/security/ToolExecutionGate.js';
import { AutonomousContinuationGuard } from '../engine/guards/AutonomousContinuationGuard.js';
import type { ToolExecutionContext, UnifiedMessage } from '../types/index.js';

async function runAutoHaltingPreventionSuite() {
  console.log('=== TEST SUITE: Auto-Halting Prevention & Resilient Execution ===\n');

  // -------------------------------------------------------------
  // 1. MemoryRecordTool Resilience
  // -------------------------------------------------------------
  console.log('[Test 1] MemoryRecordTool: Schema accepts string tags, extra keys, and content aliases');
  const memoryTool = new MemoryRecordTool();
  const testSessionId = `test-halt-mem-${randomUUID()}`;
  SessionStore.createSession({
    sessionId: testSessionId,
    cwd: process.cwd(),
    model: 'test',
    provider: 'test',
    maxTokens: 4096,
    permissionMode: 'auto',
  });
  const mockContext: ToolExecutionContext = {
    sessionId: testSessionId,
    cwd: process.cwd(),
    permissionMode: 'auto',
  };

  // Case A: string tags + text + notes + extra arbitrary keys
  const parsedA = memoryTool.inputSchema.safeParse({
    type: 'architecture',
    title: 'Rune Native AOT Architecture Review',
    text: 'AOT compiler uses LLVM IR codegen.',
    tags: 'aot, native, compiler',
    extraMetadata: { priority: 'high', score: 98 },
    notes: 'Remember invariant boundary conditions',
  });
  assert.ok(parsedA.success, 'Schema must parse successfully with string tags and extra keys');

  const execResA = await memoryTool.execute(parsedA.data, mockContext);
  assert.ok(execResA.includes('[Memory Recorded Successfully]'), 'Execution succeeds with string tags and text alias');
  console.log('  ✔ MemoryRecordTool accepts string tags and content aliases without throwing.');

  // Case B: object content and numeric title
  const parsedB = memoryTool.inputSchema.safeParse({
    name: 12345,
    details: { subsystem: 'llvm', flags: ['-O3', '-mavx2'] },
  });
  assert.ok(parsedB.success, 'Schema accepts numeric title and object details');
  const execResB = await memoryTool.execute(parsedB.data, mockContext);
  assert.ok(execResB.includes('[Memory Recorded Successfully]'), 'Execution succeeds with object details');
  console.log('  ✔ MemoryRecordTool auto-serializes objects and numbers safely.');

  // -------------------------------------------------------------
  // 2. TaskTool Resilience
  // -------------------------------------------------------------
  console.log('\n[Test 2] TaskTool: Accepts numeric taskId, numeric blocks, and id/title aliases');
  const taskTool = new TaskTool();
  const taskSessionId = `test-halt-tasks-${randomUUID()}`;
  SessionStore.createSession({
    sessionId: taskSessionId,
    cwd: process.cwd(),
    model: 'test',
    provider: 'test',
    maxTokens: 4096,
    permissionMode: 'auto',
  });
  const taskCtx: ToolExecutionContext = {
    sessionId: taskSessionId,
    cwd: process.cwd(),
    permissionMode: 'auto',
  };

  // Create Task 1 using title alias
  const createRes1 = await taskTool.execute(
    {
      action: 'create',
      title: 'Setup AST Compiler Skeleton',
      description: 'Initial AST nodes',
    } as any,
    taskCtx
  );
  assert.ok(createRes1.includes('Created Task #1'), 'Task 1 created using title alias');

  // Create Task 2 blocked by numeric 1
  const createRes2 = await taskTool.execute(
    {
      action: 'create',
      subject: 'Generate LLVM IR',
      description: 'Emit LLVM IR from AST',
      blockedBy: 1 as any, // Numeric blockedBy
    } as any,
    taskCtx
  );
  assert.ok(createRes2.includes('Created Task #2'), 'Task 2 created with numeric blockedBy');

  // Update Task 1 status using numeric id
  const updateRes = await taskTool.execute(
    {
      action: 'update',
      id: 1 as any, // Numeric id alias
      status: 'completed',
    } as any,
    taskCtx
  );
  assert.ok(updateRes.includes('status -> completed'), 'Task 1 updated to completed with numeric id');
  console.log('  ✔ TaskTool seamlessly coerces numeric taskIds and alias fields.');

  // -------------------------------------------------------------
  // 3. ToolExecutionGate Smart Pre-Coercion
  // -------------------------------------------------------------
  console.log('\n[Test 3] ToolExecutionGate: Auto-coerces string->array and number->string');
  const sampleSchema = z.object({
    id: z.string(),
    tags: z.array(z.string()),
    retries: z.number(),
  });

  const dummyTool = {
    name: 'sample_tool',
    description: 'A sample tool',
    inputSchema: sampleSchema,
  };

  // Tool call with mismatches: id is number (101), tags is string ("a, b"), retries is string ("3")
  const callWithMismatches = {
    id: 'call-1',
    name: 'sample_tool',
    arguments: {
      id: 101,
      tags: 'alpha, beta, gamma',
      retries: '3',
    },
  };

  ToolExecutionGate.validateToolCall(callWithMismatches as any, [dummyTool as any]);
  assert.strictEqual(callWithMismatches.arguments.id, '101', 'Coerced number id to string');
  assert.deepStrictEqual(callWithMismatches.arguments.tags, ['alpha', 'beta', 'gamma'], 'Coerced string tags to array');
  assert.strictEqual(callWithMismatches.arguments.retries, 3, 'Coerced string retries to number');
  console.log('  ✔ ToolExecutionGate auto-coerces common LLM parameter mismatches.');

  // -------------------------------------------------------------
  // 4. AutonomousContinuationGuard Pending Roadmap Tasks Check
  // -------------------------------------------------------------
  console.log('\n[Test 4] AutonomousContinuationGuard: Never halts when TaskManager roadmap has pending tasks');
  const guard = new AutonomousContinuationGuard(3);

  // In taskSessionId, Task 1 is completed, but Task 2 is still pending!
  const pendingTasks = TaskManager.listTasks(taskSessionId).filter((t) => t.status !== 'completed');
  assert.strictEqual(pendingTasks.length, 1, 'Task 2 must be pending in TaskManager');

  // Assistant just finished Step 1 and says "Đã hoàn thành bước 1. Tất cả các bước đã xong."
  // Without our fix, COMPLETION_PATTERNS would prematurely halt the agent here!
  const decision = guard.evaluateTurn({
    assistantContent: 'Đã hoàn thành bước 1. Tôi đã ghi nhận đánh giá kiến trúc vào tài liệu.',
    pendingToolCallsCount: 0,
    lastToolTurnHadError: false,
    modifiedFilesCount: 0,
    isProofModeActive: false,
    isPlanModeActive: false,
    sessionId: taskSessionId,
  });

  assert.strictEqual(decision.shouldContinue, true, 'Guard MUST continue autonomously when roadmap tasks are pending');
  assert.strictEqual(decision.reason, 'PENDING_ROADMAP_TASKS');
  assert.ok(decision.nudgePrompt?.includes('Nhiệm vụ #2'), 'Nudge prompt points to pending Task #2');
  console.log('  ✔ Guard successfully prevents premature halting and directs agent to Task #2.');

  // Now complete Task 2
  TaskManager.updateTask(taskSessionId, '2', { status: 'completed' });
  const remainingAfter = TaskManager.listTasks(taskSessionId).filter((t) => t.status !== 'completed');
  assert.strictEqual(remainingAfter.length, 0, 'All tasks are completed now');

  // Now that all tasks are complete, the final walkthrough response concludes naturally
  const finalDecision = guard.evaluateTurn({
    assistantContent: 'Tất cả các thay đổi đã xong. Dưới đây là walkthrough tổng kết toàn bộ tiến độ.',
    pendingToolCallsCount: 0,
    lastToolTurnHadError: false,
    modifiedFilesCount: 0,
    isProofModeActive: false,
    isPlanModeActive: false,
    sessionId: taskSessionId,
  });

  assert.strictEqual(finalDecision.shouldContinue, false, 'Guard concludes naturally when all tasks are complete');
  assert.strictEqual(finalDecision.reason, 'NONE');
  console.log('  ✔ Guard concludes cleanly when 100% of roadmap tasks are completed.');

  // -------------------------------------------------------------
  // 5. User Question & Informational Guard Protection Remains Active
  // -------------------------------------------------------------
  console.log('\n[Test 5] Protection Remains: Yields when assistant asks question or user asks conceptual Q&A');
  // Even if tasks are pending, if the assistant asks the human a question, it MUST yield
  TaskManager.createTask(taskSessionId, { subject: 'Bonus Step', description: 'Optional step' });
  const questionTurn = guard.evaluateTurn({
    assistantContent: 'Bạn có muốn tôi áp dụng cấu hình tối ưu này không?',
    pendingToolCallsCount: 0,
    lastToolTurnHadError: false,
    modifiedFilesCount: 0,
    isProofModeActive: false,
    isPlanModeActive: false,
    sessionId: taskSessionId,
  });
  assert.strictEqual(questionTurn.shouldContinue, false, 'Must yield to user when question is asked');

  const informationalMsg: UnifiedMessage = {
    id: 'msg-1',
    role: 'user',
    content: 'Tại sao TypeScript lại chậm hơn C++?',
    timestamp: Date.now(),
  };
  const infoTurn = guard.evaluateTurn({
    assistantContent: 'TypeScript chạy trên V8 engine trong khi C++ biên dịch trực tiếp ra machine code.',
    pendingToolCallsCount: 0,
    lastToolTurnHadError: false,
    modifiedFilesCount: 0,
    isProofModeActive: false,
    isPlanModeActive: false,
    sessionId: taskSessionId,
    recentMessages: [informationalMsg],
  });
  assert.strictEqual(infoTurn.shouldContinue, false, 'Must yield to user when answering conceptual questions');
  console.log('  ✔ User interactive authority is strictly preserved.');

  // Clean up
  TaskManager.clearAllTasks(taskSessionId);
  TaskManager.clearAllTasks(testSessionId);

  console.log('\nALL AUTO-HALTING & RESILIENCE PREVENTIONS PASSED WITH 100% EVIDENCE!');
}

runAutoHaltingPreventionSuite().catch((err) => {
  console.error('[FAILED]:', err);
  process.exit(1);
});
