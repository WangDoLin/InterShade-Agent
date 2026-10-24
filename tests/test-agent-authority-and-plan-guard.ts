import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { AutonomousContinuationGuard } from '../engine/guards/AutonomousContinuationGuard.js';
import { VerifyOnStopGuard } from '../engine/guards/VerifyOnStopGuard.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import { PlanModeTool } from '../tools/agentic/PlanModeTool.js';
import type { ToolExecutionContext } from '../types/index.js';

async function runAuthorityTests() {
  console.log('=== TEST SUITE: Agent Authority & Plan Mode Protection ===');

  const guard = new AutonomousContinuationGuard(3);

  // 1. Assistant asks a question to user -> MUST NOT trigger autonomous continuation
  console.log('\n[Test 1] User Question Protection: Assistant asks question in Vietnamese');
  const questionResult = guard.evaluateTurn({
    assistantContent:
      'Dưới đây là roadmap 4 tier.\nBạn có muốn điều chỉnh base model ưu tiên hoặc muốn bắt đầu ngay từ Giai đoạn 1 & Model HERMES không?',
    pendingToolCallsCount: 0,
    lastToolTurnHadError: false,
    modifiedFilesCount: 0,
    isProofModeActive: false,
    isPlanModeActive: false,
  });
  assert.strictEqual(questionResult.shouldContinue, false, 'Question ending with "không?" must yield to human user');
  assert.strictEqual(questionResult.reason, 'NONE');
  console.log('  ✔ Correctly yields to human user when assistant asks a question.');

  // 2. Assistant gives advice to user ("Bạn chỉ cần...") -> MUST NOT detect as assistant forward intent
  console.log('\n[Test 2] User Advice Protection: Assistant suggests what user can do');
  const adviceResult = guard.evaluateTurn({
    assistantContent:
      'Nếu muốn đưa lên GitHub cá nhân: Bạn chỉ cần tạo repo trên GitHub rồi liên kết remote URL vào là xong.',
    pendingToolCallsCount: 0,
    lastToolTurnHadError: false,
    modifiedFilesCount: 0,
    isProofModeActive: false,
    isPlanModeActive: false,
  });
  assert.strictEqual(adviceResult.shouldContinue, false, 'Advice to user ("Bạn chỉ cần...") must not trigger continuation');
  console.log('  ✔ Advice directed at the user is not misinterpreted as assistant forward intent.');

  // 3. Plan Mode active -> MUST NOT force tool execution or plan execution nudges
  console.log('\n[Test 3] Plan Mode Safe Guard: Strict read-only protection in Plan Mode');
  const planModeTurnResult = guard.evaluateTurn({
    assistantContent:
      'Kế hoạch triển khai:\nBước 1: Khởi tạo cấu trúc dự án.\nBước 2: Cài đặt dependencies.',
    pendingToolCallsCount: 0,
    lastToolTurnHadError: false,
    modifiedFilesCount: 0,
    isProofModeActive: false,
    isPlanModeActive: true,
  });
  assert.strictEqual(planModeTurnResult.shouldContinue, false, 'In Plan Mode, steps must not trigger tool execution nudge');
  console.log('  ✔ Autonomous tool execution nudges are strictly suppressed in Plan Mode.');

  // 4. QueryEngine.isExecutionDirective ignores synthetic prompts and roadmap queries
  console.log('\n[Test 4] QueryEngine: isExecutionDirective guards against synthetic messages');
  const syntheticContinuation =
    '[AUTONOMOUS CONTINUATION]: You declared intent to take action ("cần bắt đầu từng giai đoạn"), but no tool call was executed.';
  const syntheticVerify =
    '[VERIFY-ON-STOP GUARD POLICY]: You modified files in this session. Under NO EVIDENCE, NO DONE policy, please verify.';
  const roadmapQuery = 'plan roadmap để build model AI từ file models.txt';
  const realFixDirective = 'fix lỗi agent tự động vượt quyền';
  const realStartDirective = 'bắt đầu làm tính năng này đi';

  assert.strictEqual(QueryEngine.isExecutionDirective(syntheticContinuation), false, 'Synthetic continuation prompt is ignored');
  assert.strictEqual(QueryEngine.isExecutionDirective(syntheticVerify), false, 'Synthetic verify prompt is ignored');
  assert.strictEqual(QueryEngine.isExecutionDirective(roadmapQuery), false, 'Roadmap planning query is ignored');
  assert.strictEqual(QueryEngine.isExecutionDirective(realFixDirective), true, 'Real user fix directive recognized');
  assert.strictEqual(QueryEngine.isExecutionDirective(realStartDirective), true, 'Real user start directive recognized');
  console.log('  ✔ Synthetic guard prompts and planning queries never auto-transition out of Plan Mode.');

  // 5. PlanModeTool: Agent cannot unilaterally exit Plan Mode without user approval
  console.log('\n[Test 5] PlanModeTool: Gated exit requiring user confirmation');
  const planTool = new PlanModeTool();
  let userApproval = false;
  const toolContext: ToolExecutionContext = {
    sessionId: `test-authority-${randomUUID()}`,
    cwd: process.cwd(),
    permissionMode: 'plan',
    askConfirmation: async () => userApproval,
  };

  // Attempt exit without approval
  const exitDeclined = await planTool.execute({ action: 'exit', planTitle: 'AI Ecosystem' }, toolContext);
  assert.strictEqual(toolContext.permissionMode, 'plan', 'Permission mode must remain "plan" when user declines');
  assert.ok(exitDeclined.includes('[PLAN MODE REMAIN ACTIVE]'), 'Response reflects Plan Mode remains active');

  // Attempt exit with user approval
  userApproval = true;
  const exitApproved = await planTool.execute({ action: 'exit', planTitle: 'AI Ecosystem' }, toolContext);
  assert.strictEqual(toolContext.permissionMode, 'default', 'Permission mode transitions to "default" when user approves');
  assert.ok(exitApproved.includes('[PLAN MODE OFF]'), 'Response reflects execution unlocked');
  console.log('  ✔ Agent cannot unilaterally exit Plan Mode without explicit user confirmation.');

  // 6. VerifyOnStopGuard: Does not block when 0 files modified in the current turn
  console.log('\n[Test 6] VerifyOnStopGuard: Turn-scoped evaluation');
  const verifyGuard = new VerifyOnStopGuard();
  const conversationalTurnResult = verifyGuard.evaluate([], 0);
  assert.strictEqual(conversationalTurnResult.shouldBlock, false, 'Must not block conversational turns with 0 turn modifications');

  const modifyingTurnResult = verifyGuard.evaluate(['src/index.ts'], Date.now());
  assert.strictEqual(modifyingTurnResult.shouldBlock, true, 'Blocks turn where code files were actually modified without verification');
  console.log('  ✔ VerifyOnStopGuard correctly distinguishes conversational turns from modification turns.');

  // 7. Informational Q&A Protection: User asks "tại sao...", assistant answers with numbered points -> MUST NOT trigger continuation
  console.log('\n[Test 7] Informational Q&A Protection: Conceptual question must not trigger autonomous continuation');
  const informationalUserMsg = {
    id: 'user-q1',
    role: 'user' as const,
    content: 'tại sao mã nguồn được viết bởi typescript liệu có tối ưu hơn c++ ?',
    timestamp: Date.now(),
  };

  const informationalAnswer = `
TypeScript không bao giờ tối ưu hơn C++ về hiệu năng thực thi.
1. Trường hợp phổ biến: Xây dựng Trình thông dịch (Interpreter)
C++ chạy trực tiếp mã máy, còn TypeScript chạy qua máy ảo V8.
2. Trường hợp ngoại lệ: Trình biên dịch (Compiler)
Biên dịch AOT tạo binary ngang ngửa.
Dưới đây là ví dụ minh họa:
\`\`\`typescript
function benchmark() { return 42; }
\`\`\`
`;

  const informationalResult = guard.evaluateTurn({
    assistantContent: informationalAnswer,
    pendingToolCallsCount: 0,
    lastToolTurnHadError: false,
    modifiedFilesCount: 0,
    isProofModeActive: false,
    isPlanModeActive: false,
    recentMessages: [informationalUserMsg],
  });

  assert.strictEqual(
    informationalResult.shouldContinue,
    false,
    'Informational explanation with numbered points and illustrative code block must NOT trigger continuation'
  );
  assert.strictEqual(informationalResult.reason, 'NONE');
  console.log('  ✔ Informational Q&A is cleanly delivered to user without autonomous tool hijacking.');

  console.log('\n===============================================================');
  console.log('🎉 ALL AGENT AUTHORITY & PLAN GUARD TESTS PASSED (7/7 PASS)');
  console.log('===============================================================\n');
}

runAuthorityTests().catch((err) => {
  console.error('[TEST FAILURE]:', err);
  process.exit(1);
});
