import assert from 'assert';
import { TaskManager, taskEvents } from '../state/TaskManager.js';
import { PlanManager } from '../state/PlanManager.js';
import { tasksCommand } from '../cli/commands/builtinCommands.js';
import { SessionStore } from '../state/SessionStore.js';
import { randomUUID } from 'crypto';

async function runTests() {
  console.log('=== TEST SUITE: TASK MANAGER & CHECKLIST FIXES ===\n');

  const testSessionId = `test-fix-${randomUUID()}`;
  SessionStore.createSession({
    sessionId: testSessionId,
    cwd: process.cwd(),
    model: 'test',
    provider: 'test',
    maxTokens: 4096,
    permissionMode: 'default',
  });

  // 1. Test TaskManager.createTaskWithId
  console.log('1. Testing TaskManager.createTaskWithId...');
  const t1 = TaskManager.createTaskWithId(testSessionId, {
    id: '1',
    subject: 'Setup initial database',
    description: 'Create SQLite schema',
    status: 'pending',
  });
  assert.strictEqual(t1.id, '1');
  assert.strictEqual(t1.status, 'pending');

  const t2 = TaskManager.createTaskWithId(testSessionId, {
    id: '2',
    subject: 'Implement authentication API',
    description: 'Add JWT verify endpoints',
    status: 'pending',
  });
  assert.strictEqual(t2.id, '2');

  const allTasks = TaskManager.listTasks(testSessionId);
  assert.strictEqual(allTasks.length, 2);
  console.log('  [PASS] Tasks created with explicit IDs successfully.');

  // 2. Test /tasks command: tick / done
  console.log('\n2. Testing /tasks done <id> command...');
  const tickResult = await tasksCommand.execute({
    args: ['done', '1'],
    sessionState: { id: testSessionId },
    cwd: process.cwd(),
  });
  assert.ok(tickResult.includes('COMPLETED'));
  assert.ok(tickResult.includes('#1'));

  const updatedT1 = TaskManager.getTask(testSessionId, '1');
  assert.strictEqual(updatedT1?.status, 'completed');
  console.log('  [PASS] /tasks done 1 successfully marked task as completed.');

  // 3. Test /tasks untick command
  console.log('\n3. Testing /tasks untick <id> command...');
  const untickResult = await tasksCommand.execute({
    args: ['untick', '1'],
    sessionState: { id: testSessionId },
    cwd: process.cwd(),
  });
  assert.ok(untickResult.includes('PENDING'));
  const untickedT1 = TaskManager.getTask(testSessionId, '1');
  assert.strictEqual(untickedT1?.status, 'pending');
  console.log('  [PASS] /tasks untick 1 successfully restored task to pending.');

  // 4. Test PlanManager auto-sync to TaskManager
  console.log('\n4. Testing PlanManager auto-sync to TaskManager...');
  const planSessionId = `test-plan-${randomUUID()}`;
  SessionStore.createSession({
    sessionId: planSessionId,
    cwd: process.cwd(),
    model: 'test',
    provider: 'test',
    maxTokens: 4096,
    permissionMode: 'default',
  });
  PlanManager.createOrReplacePlan(planSessionId, {
    title: 'Authentication Module',
    steps: [
      { id: '1', title: 'Scaffold auth middleware', status: 'completed' },
      { id: '2', title: 'Write token generator', status: 'pending' },
    ],
  });

  const syncedTasks = TaskManager.listTasks(planSessionId);
  assert.strictEqual(syncedTasks.length, 2);
  assert.strictEqual(syncedTasks[0].id, '1');
  assert.strictEqual(syncedTasks[0].status, 'completed');
  assert.strictEqual(syncedTasks[1].id, '2');
  assert.strictEqual(syncedTasks[1].status, 'pending');
  console.log('  [PASS] PlanManager steps automatically synchronized to TaskManager.');

  // 5. Test extractPlanFromText with completion markers
  console.log('\n5. Testing PlanManager.extractPlanFromText with completion markers...');
  const sampleAssistantMarkdown = `
# Implementation Plan: Microservices Migration
### Implementation Steps:
1. [x] Setup Docker compose environment
   - Details: Configure redis and postgres
2. [Completed] Write gateway router
   - Details: Reverse proxy routing
3. [in_progress] Implement user service
   - Details: User CRUD APIs
4. Deploy to Kubernetes
   - Details: Helm chart deployment
`;
  const extracted = PlanManager.extractPlanFromText(sampleAssistantMarkdown);
  assert.ok(extracted);
  assert.strictEqual(extracted.steps.length, 4);
  assert.strictEqual(extracted.steps[0].status, 'completed');
  assert.strictEqual(extracted.steps[0].title, 'Setup Docker compose environment');
  assert.strictEqual(extracted.steps[1].status, 'completed');
  assert.strictEqual(extracted.steps[1].title, 'Write gateway router');
  assert.strictEqual(extracted.steps[2].status, 'in_progress');
  assert.strictEqual(extracted.steps[2].title, 'Implement user service');
  assert.strictEqual(extracted.steps[3].status, 'pending');
  console.log('  [PASS] Natural language completion tags [x] and [Completed] correctly extracted as completed status.');

  // 6. Test /tasks prune / clear completed
  console.log('\n6. Testing /tasks clear completed...');
  // In planSessionId, task 1 is completed, task 2 is pending
  const pruneResult = await tasksCommand.execute({
    args: ['clear', 'completed'],
    sessionState: { id: planSessionId },
    cwd: process.cwd(),
  });
  assert.ok(pruneResult.includes('Cleared 1 completed task(s)'));

  const remainingAfterPrune = TaskManager.listTasks(planSessionId);
  assert.strictEqual(remainingAfterPrune.length, 1);
  assert.strictEqual(remainingAfterPrune[0].id, '2');
  console.log('  [PASS] Completed tasks successfully disappeared after clear completed.');

  // 7. Test TaskTool partial update with only status (SQLite parameter binding hardening)
  console.log('\n7. Testing TaskTool update with partial fields (no SQLite parameter binding errors)...');
  const { TaskTool } = await import('../tools/task/TaskTool.js');
  const taskTool = new TaskTool();
  const partialSessionId = `test-partial-${randomUUID()}`;
  SessionStore.createSession({
    sessionId: partialSessionId,
    cwd: process.cwd(),
    model: 'test',
    provider: 'test',
    maxTokens: 4096,
    permissionMode: 'default',
  });

  const createdTask = TaskManager.createTask(partialSessionId, {
    subject: 'Initial partial update test subject',
    description: 'Initial description',
  });

  // Updating only status should succeed and preserve subject/description without throwing parameter binding error
  const statusOnlyUpdate = await taskTool.execute(
    {
      action: 'update',
      taskId: createdTask.id,
      status: 'completed',
    },
    { sessionId: partialSessionId } as any
  );
  assert.ok(statusOnlyUpdate.includes('[x]'));
  assert.ok(statusOnlyUpdate.includes('Initial partial update test subject'));
  assert.ok(statusOnlyUpdate.includes('[All Tasks Completed]'));

  const reloadedTask = TaskManager.getTask(partialSessionId, createdTask.id);
  assert.strictEqual(reloadedTask?.status, 'completed');
  assert.strictEqual(reloadedTask?.subject, 'Initial partial update test subject');
  assert.strictEqual(reloadedTask?.description, 'Initial description');

  // Updating only subject should preserve status and description
  const subjectOnlyUpdate = await taskTool.execute(
    {
      action: 'update',
      taskId: createdTask.id,
      subject: 'Updated subject title',
    },
    { sessionId: partialSessionId } as any
  );
  assert.ok(subjectOnlyUpdate.includes('Updated subject title'));
  const reloadedTask2 = TaskManager.getTask(partialSessionId, createdTask.id);
  assert.strictEqual(reloadedTask2?.subject, 'Updated subject title');
  assert.strictEqual(reloadedTask2?.status, 'completed');
  assert.strictEqual(reloadedTask2?.description, 'Initial description');

  console.log('  [PASS] TaskTool partial updates succeed cleanly with parameter binding hardening.');

  // Cleanup
  TaskManager.clearAllTasks(testSessionId);
  TaskManager.clearAllTasks(planSessionId);
  TaskManager.clearAllTasks(partialSessionId);
  PlanManager.clearPlan(planSessionId);

  console.log('\n=== ALL TASK MANAGER TESTS PASSED SUCCESSFULLY! [100%] ===');
}

runTests().catch((err) => {
  console.error('[TEST FAILURE]:', err);
  process.exit(1);
});
