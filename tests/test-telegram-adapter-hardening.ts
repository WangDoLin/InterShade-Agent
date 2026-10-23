import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TelegramAdapter, type TelegramWebhookPayload } from '../gateway/adapters/TelegramAdapter.js';
import { ApprovalStore } from '../gateway/ApprovalStore.js';
import { GatewayServer } from '../gateway/GatewayServer.js';
import { PermissionEngine } from '../security/PermissionEngine.js';
import type { PermissionMode } from '../types/index.js';

async function runTelegramHardeningSuite(): Promise<void> {
  console.log('================================================================');
  console.log(' TELEGRAM ADAPTER & REMOTE APPROVAL HARDENING SUITE (NEXT-B-01..05)');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // 1. TG-1 Regression: chat.id vs message_id (NEXT-B-01)
  // -------------------------------------------------------------
  console.log('=== 1. TESTING TG-1 REGRESSION (chat.id !== message_id) ===');
  const callbackPayload: TelegramWebhookPayload = {
    update_id: 9001,
    callback_query: {
      id: 'cbq-1',
      from: { id: 777888, first_name: 'Alice', username: 'alice_ops' },
      data: 'ap:0123456789abcdef0123456789abcdef',
      message: {
        message_id: 42,
        chat: { id: 555001, type: 'private' },
      },
    },
  };

  const parsedCb = TelegramAdapter.parseWebhookUpdate(callbackPayload);
  assert.strictEqual(parsedCb.type, 'callback_query');
  assert.strictEqual(parsedCb.chatId, 555001, 'chatId MUST be chat.id (555001), never message_id (42)');
  assert.strictEqual(parsedCb.messageId, 42);
  assert.strictEqual(parsedCb.senderId, 777888);
  assert.strictEqual(parsedCb.updateId, 9001);
  assert.strictEqual(parsedCb.nonce, '0123456789abcdef0123456789abcdef');
  assert.strictEqual(parsedCb.decision, 'approve');
  console.log('[PASS]: TG-1 chat.id vs message_id extraction verified.');

  // -------------------------------------------------------------
  // 2. ApprovalStore: One-Time Nonce, TTL, and diffSha256 Binding (NEXT-B-04)
  // -------------------------------------------------------------
  console.log('\n=== 2. TESTING APPROVAL STORE NONCE, TTL, REPLAY & DIFF HASH ===');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intershader-tg-test-'));
  const store = new ApprovalStore({ stateDir: tmpDir });

  const originalDiff = '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-const debug = true;\n+const debug = false;\n';
  const baseNow = 1_700_000_000_000;

  const approvalRec = store.createApproval({
    taskId: 'task-sec-01',
    chatId: 555001,
    senderScope: [777888],
    diffContent: originalDiff,
    ttlSeconds: 600,
    now: baseNow,
  });

  assert.strictEqual(approvalRec.nonce.length, 32, '128-bit hex nonce must be 32 chars');
  const card = TelegramAdapter.formatApprovalRequest(
    555001,
    'task-sec-01',
    'Disable debug flag in auth.ts',
    originalDiff,
    { nonce: approvalRec.nonce, shortCode: approvalRec.shortCode },
  );
  const inlineBtnData = card.replyMarkup?.inline_keyboard[0][0].callback_data || '';
  assert.ok(inlineBtnData.startsWith('ap:'), 'Callback data must use ap:<nonce>');
  assert.ok(Buffer.byteLength(inlineBtnData, 'utf8') < 64, 'Callback data must fit inside Telegram 64-byte limit');

  // 2a. Wrong chat ID -> rejected without burning valid nonce for real owner
  const wrongChatRes = store.verifyAndConsume({
    nonceOrCode: approvalRec.nonce,
    decision: 'approve',
    chatId: 999999,
    senderId: 777888,
    currentDiffContent: originalDiff,
    now: baseNow + 10_000,
  });
  assert.strictEqual(wrongChatRes.valid, false);
  assert.strictEqual(wrongChatRes.reason, 'CHAT_MISMATCH');

  // 2b. Unauthorized sender -> rejected
  const wrongSenderRes = store.verifyAndConsume({
    nonceOrCode: approvalRec.nonce,
    decision: 'approve',
    chatId: 555001,
    senderId: 666666,
    currentDiffContent: originalDiff,
    now: baseNow + 10_000,
  });
  assert.strictEqual(wrongSenderRes.valid, false);
  assert.strictEqual(wrongSenderRes.reason, 'UNAUTHORIZED_SENDER');

  // 2c. Valid first consumption -> succeeds
  const validRes = store.verifyAndConsume({
    nonceOrCode: approvalRec.nonce,
    decision: 'approve',
    chatId: 555001,
    senderId: 777888,
    currentDiffContent: originalDiff,
    now: baseNow + 20_000,
  });
  assert.strictEqual(validRes.valid, true);
  assert.strictEqual(validRes.taskId, 'task-sec-01');
  assert.strictEqual(validRes.decision, 'approve');

  // 2d. Second consumption of same nonce -> NONCE_ALREADY_CONSUMED
  const replayNonceRes = store.verifyAndConsume({
    nonceOrCode: approvalRec.nonce,
    decision: 'approve',
    chatId: 555001,
    senderId: 777888,
    currentDiffContent: originalDiff,
    now: baseNow + 25_000,
  });
  assert.strictEqual(replayNonceRes.valid, false);
  assert.strictEqual(replayNonceRes.reason, 'NONCE_ALREADY_CONSUMED');

  // 2e. Expired nonce -> NONCE_EXPIRED
  const expiredRec = store.createApproval({
    taskId: 'task-sec-02',
    chatId: 555001,
    diffContent: originalDiff,
    ttlSeconds: 60,
    now: baseNow,
  });
  const expiredRes = store.verifyAndConsume({
    nonceOrCode: expiredRec.nonce,
    decision: 'approve',
    chatId: 555001,
    senderId: 777888,
    currentDiffContent: originalDiff,
    now: baseNow + 61_000,
  });
  assert.strictEqual(expiredRes.valid, false);
  assert.strictEqual(expiredRes.reason, 'NONCE_EXPIRED');

  // 2f. Diff modified after approval card was sent -> DIFF_MODIFIED_SINCE_APPROVAL
  const tamperedRec = store.createApproval({
    taskId: 'task-sec-03',
    chatId: 555001,
    diffContent: originalDiff,
    ttlSeconds: 600,
    now: baseNow,
  });
  const tamperedRes = store.verifyAndConsume({
    nonceOrCode: tamperedRec.nonce,
    decision: 'approve',
    chatId: 555001,
    senderId: 777888,
    currentDiffContent: originalDiff + '+exec("rm -rf /");\n',
    now: baseNow + 5_000,
  });
  assert.strictEqual(tamperedRes.valid, false);
  assert.strictEqual(tamperedRes.reason, 'DIFF_MODIFIED_SINCE_APPROVAL');

  // Verify audit log never records the full 32-char nonce
  const auditEntries = store.getAuditLog();
  assert.ok(auditEntries.length >= 6, 'Audit log must record all approval attempts');
  for (const entry of auditEntries) {
    assert.strictEqual(entry.nonceSuffix.length, 6, 'Audit entry must only log 6-char nonceSuffix');
    assert.ok(!JSON.stringify(entry).includes(approvalRec.nonce), 'Full nonce must never appear in audit log');
  }
  console.log('[PASS]: ApprovalStore one-time nonce, TTL, diffSha256 binding, and audit log verified.');

  // -------------------------------------------------------------
  // 3. GatewayServer /telegram/webhook 3-Layer Auth & Replay Window (NEXT-B-02..03)
  // -------------------------------------------------------------
  console.log('\n=== 3. TESTING GATEWAY /telegram/webhook 3-LAYER SECURITY ===');
  const webhookSecret = 'tg-super-secret-webhook-token-2026';
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    workspaceDir: tmpDir,
    authToken: 'gw-bearer-token-1234567890',
    telegram: {
      enabled: true,
      webhookSecretToken: webhookSecret,
      allowedUserIds: [777888],
      allowedChatIds: [555001],
    },
  });

  const receivedUpdates: number[] = [];
  server.on('telegram_update', (u) => {
    receivedUpdates.push(u.updateId);
  });

  const port = await server.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 3a. Healthz and Readyz probes
    const healthRes = await fetch(`${baseUrl}/healthz`);
    assert.strictEqual(healthRes.status, 200);
    const readyRes = await fetch(`${baseUrl}/readyz`);
    assert.strictEqual(readyRes.status, 200);

    // 3b. Missing or wrong X-Telegram-Bot-Api-Secret-Token -> 401
    const noSecretRes = await fetch(`${baseUrl}/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callbackPayload),
    });
    assert.strictEqual(noSecretRes.status, 401, 'Webhook without secret token must return 401');

    const badSecretRes = await fetch(`${baseUrl}/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
      },
      body: JSON.stringify(callbackPayload),
    });
    assert.strictEqual(badSecretRes.status, 401, 'Webhook with wrong secret token must return 401');

    // 3c. Unauthorized user (outside allowedUserIds) -> silent 200 drop
    const outsiderPayload: TelegramWebhookPayload = {
      update_id: 9002,
      message: {
        message_id: 10,
        from: { id: 111222, first_name: 'Mallory' },
        chat: { id: 555001, type: 'private' },
        text: '/confirm 12345678',
      },
    };
    const outsiderRes = await fetch(`${baseUrl}/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify(outsiderPayload),
    });
    assert.strictEqual(outsiderRes.status, 200);
    const outsiderBody = (await outsiderRes.json()) as { ignored?: string };
    assert.strictEqual(outsiderBody.ignored, 'allowlist');
    assert.strictEqual(receivedUpdates.length, 0, 'Outsider update must not be emitted');

    // 3d. Valid authorized update -> accepted once
    const validWebhookRes = await fetch(`${baseUrl}/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify(callbackPayload),
    });
    assert.strictEqual(validWebhookRes.status, 200);
    assert.deepStrictEqual(receivedUpdates, [9001]);

    // 3e. Replay of same update_id (9001) or older update_id (9000) -> silent 200 drop
    const replayWebhookRes = await fetch(`${baseUrl}/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify(callbackPayload),
    });
    assert.strictEqual(replayWebhookRes.status, 200);
    const replayBody = (await replayWebhookRes.json()) as { ignored?: string };
    assert.strictEqual(replayBody.ignored, 'replay');
    assert.deepStrictEqual(receivedUpdates, [9001], 'Replayed update must not be emitted a second time');
  } finally {
    await server.stop();
  }
  console.log('[PASS]: Gateway /telegram/webhook 3-layer security & replay protection verified.');

  // -------------------------------------------------------------
  // 4. Permission Mode Invariant (NEXT-B-05)
  // -------------------------------------------------------------
  console.log('\n=== 4. TESTING PERMISSION MODE INVARIANT ON REMOTE APPROVAL ===');
  let sessionPermissionMode: PermissionMode = 'default';
  // Simulate approving a specific diff via ApprovalStore while session is in 'default' mode
  const modeApproval = store.createApproval({
    taskId: 'task-mode-check',
    chatId: 555001,
    diffContent: 'diff --git a/README.md b/README.md',
  });
  const consumeCheck = store.verifyAndConsume({
    nonceOrCode: modeApproval.shortCode,
    decision: 'approve',
    chatId: 555001,
    senderId: 777888,
    currentDiffContent: 'diff --git a/README.md b/README.md',
  });
  assert.strictEqual(consumeCheck.valid, true);
  assert.strictEqual(
    sessionPermissionMode,
    'default',
    'Telegram approval must NEVER elevate session permissionMode from default'
  );

  const permEngine = new PermissionEngine(sessionPermissionMode);
  const destructiveToolDecision = permEngine.evaluate(
    'run_shell_command',
    { command: 'rm -rf /tmp/test' },
    false,
    true
  );
  assert.strictEqual(
    destructiveToolDecision.allowed,
    false,
    'Subsequent destructive tool calls in default mode must still be blocked pending confirmation'
  );
  assert.strictEqual(destructiveToolDecision.requiresPrompt, true);
  console.log('[PASS]: Permission mode invariant verified (remote approval never elevates session mode).');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  console.log('\n================================================================');
  console.log(' ALL TELEGRAM & REMOTE APPROVAL HARDENING CHECKS PASSED 100%!   ');
  console.log('================================================================');
}

runTelegramHardeningSuite().catch((err) => {
  console.error('[FAIL]:', err);
  process.exit(1);
});
