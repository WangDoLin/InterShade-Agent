import assert from 'assert';
import { GatewayServer } from '../gateway/GatewayServer.js';
import { TelegramAdapter } from '../gateway/adapters/TelegramAdapter.js';
import { McpClientManager } from '../services/mcp/McpClientManager.js';

console.log('[TEST]: Starting Headless Multi-Channel Gateway Daemon & Security Hardening verification...');

const workspaceDir = process.cwd();
const server = new GatewayServer({ port: 0, workspaceDir });

async function runTests() {
  // 1. Start Gateway Server on dynamic port and verify loopback default bind (GW-T8)
  const port = await server.start();
  assert.ok(port > 0, 'Dynamic port must be assigned');
  const addr = server.getAddress();
  assert.strictEqual(addr?.address, '127.0.0.1', 'Gateway must bind to 127.0.0.1 by default (GW-T8)');
  console.log(`[PASS]: Gateway Server started on ${addr?.address}:${port} (loopback bound)`);

  // 2. Verify endpoint /api/status does not leak workspaceDir (GW-T5)
  const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.strictEqual(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.strictEqual(statusData.success, true);
  assert.strictEqual(statusData.data.status, 'RUNNING');
  assert.strictEqual(statusData.data.workspaceDir, undefined, '/api/status must not expose workspaceDir (GW-T5)');
  console.log('[PASS]: Endpoint /api/status returned status RUNNING without leaking workspaceDir');

  // 3. Verify CORS rejection for untrusted Origin (GW-T1)
  const corsRes = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example' },
  });
  assert.strictEqual(corsRes.status, 403, 'Disallowed CORS preflight must return 403 (GW-T1)');
  assert.strictEqual(corsRes.headers.get('access-control-allow-origin'), null);
  console.log('[PASS]: Untrusted CORS preflight rejected with 403');

  // 4. Verify endpoint /api/skills
  const skillsRes = await fetch(`http://127.0.0.1:${port}/api/skills`);
  assert.strictEqual(skillsRes.status, 200);
  const skillsData = await skillsRes.json();
  assert.strictEqual(skillsData.success, true);
  assert.ok(Array.isArray(skillsData.skills));
  console.log(`[PASS]: Endpoint /api/skills returned skills catalog (${skillsData.skills.length} skills)`);

  // 5. Verify event dispatch on remote prompt
  let receivedPrompt = '';
  let receivedApprovalFlag = false;
  server.on('user_prompt', (msg) => {
    receivedPrompt = msg.prompt;
    receivedApprovalFlag = Boolean(msg.requiresApprovalForDestructiveTools);
  });

  const promptRes = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'sess-remote-001',
      source: 'telegram',
      prompt: 'Refactor login module',
    }),
  });
  assert.strictEqual(promptRes.status, 200);
  const promptData = await promptRes.json();
  assert.strictEqual(promptData.success, true);
  assert.strictEqual(receivedPrompt, 'Refactor login module');
  assert.strictEqual(receivedApprovalFlag, true, 'Remote prompt must require approval for destructive tools (GW-T7)');
  console.log('[PASS]: Dispatched remote prompt via REST API with destructive-tool approval guard');

  // 6. Verify body size ceiling 64 KiB (GW-T3)
  const oversizedBody = JSON.stringify({
    sessionId: 'sess-oversized',
    source: 'webhook',
    prompt: 'x'.repeat(70_000),
  });
  const largeRes = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: oversizedBody,
  });
  assert.strictEqual(largeRes.status, 413, 'Payload exceeding 64 KiB must return 413 (GW-T3)');
  console.log('[PASS]: Oversized payload rejected with 413 TOO_LARGE');

  // 7. Verify malformed JSON returns generic BAD_REQUEST without internal stack/message (GW-T6)
  const badJsonRes = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid-json',
  });
  assert.strictEqual(badJsonRes.status, 400);
  const badJsonData = await badJsonRes.json();
  assert.strictEqual(badJsonData.error, 'BAD_REQUEST');
  console.log('[PASS]: Malformed JSON handled safely with BAD_REQUEST code');

  await server.stop();

  // 8. Verify Token Authentication & Rate Limiting on protected GatewayServer (GW-T2, GW-T4)
  const authServer = new GatewayServer({
    port: 0,
    workspaceDir,
    authToken: 'secret-gateway-token-999',
    rateLimitMaxPerWindow: 5,
  });
  const authPort = await authServer.start();

  const unauthRes = await fetch(`http://127.0.0.1:${authPort}/api/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', source: 'webhook', prompt: 'hello' }),
  });
  assert.strictEqual(unauthRes.status, 401, 'Missing bearer token must return 401 (GW-T2)');

  const authedRes = await fetch(`http://127.0.0.1:${authPort}/api/skills`, {
    headers: { Authorization: 'Bearer secret-gateway-token-999' },
  });
  assert.strictEqual(authedRes.status, 200, 'Valid bearer token must pass authentication');

  // Trigger rate limit (maxPerWindow=5, 1 already used by /api/skills, /api/prompt costs 5 -> 6 > 5)
  const rateLimitedRes = await fetch(`http://127.0.0.1:${authPort}/api/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret-gateway-token-999',
    },
    body: JSON.stringify({ sessionId: 's1', source: 'webhook', prompt: 'hello' }),
  });
  assert.strictEqual(rateLimitedRes.status, 429, 'Exceeding rate limit window must return 429 (GW-T4)');
  await authServer.stop();
  console.log('[PASS]: Token authentication (401) and rate limiting (429) verified');

  // 9. Verify TelegramAdapter (including TG-1 fix: chat.id vs message_id, senderId, updateId)
  const tgMsg = TelegramAdapter.formatApprovalRequest(
    123456,
    'task-001',
    'Add OAuth login',
    '+ const token = await auth();',
  );
  assert.strictEqual(tgMsg.chatId, 123456);
  assert.ok(tgMsg.text.includes('InterShader Approval Request'));
  assert.ok(tgMsg.replyMarkup?.inline_keyboard[0][0].callback_data.includes('approve:task-001'));

  const parsedUpdate = TelegramAdapter.parseWebhookUpdate({
    update_id: 42,
    callback_query: {
      id: 'cb-1',
      from: { id: 999, first_name: 'Admin' },
      data: 'approve:task-001',
      message: {
        message_id: 777,
        chat: { id: -100555666, type: 'supergroup' },
      },
    },
  });
  assert.strictEqual(parsedUpdate.type, 'callback_query');
  assert.strictEqual(parsedUpdate.action, 'approve:task-001');
  assert.strictEqual(parsedUpdate.chatId, -100555666, 'callback_query chatId must come from message.chat.id, not message_id (GW-007)');
  assert.strictEqual(parsedUpdate.messageId, 777);
  assert.strictEqual(parsedUpdate.senderId, 999);
  assert.strictEqual(parsedUpdate.updateId, 42);
  console.log('[PASS]: TelegramAdapter extracted chat.id, messageId, senderId, and updateId accurately');

  // 10. Verify MCP environment sanitization (SVC-MCP-01)
  const sanitizedEnv = McpClientManager.buildSafeMcpEnv(
    { CUSTOM_MCP_VAR: 'allowed' },
    {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-secret-do-not-leak',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      GITHUB_TOKEN: 'ghp_secret',
    },
  );
  assert.strictEqual(sanitizedEnv.PATH, '/usr/bin');
  assert.strictEqual(sanitizedEnv.CUSTOM_MCP_VAR, 'allowed');
  assert.strictEqual(sanitizedEnv.OPENAI_API_KEY, undefined, 'Ambient OPENAI_API_KEY must be stripped from MCP child env');
  assert.strictEqual(sanitizedEnv.ANTHROPIC_API_KEY, undefined, 'Ambient ANTHROPIC_API_KEY must be stripped from MCP child env');
  assert.strictEqual(sanitizedEnv.GITHUB_TOKEN, undefined, 'Ambient GITHUB_TOKEN must be stripped from MCP child env');
  console.log('[PASS]: McpClientManager environment allowlist stripped ambient secrets');

  console.log('[SUCCESS]: ALL HEADLESS GATEWAY, TELEGRAM & MCP SECURITY TESTS PASSED 100%!');
}

runTests().catch((err) => {
  console.error('[FAIL]:', err);
  process.exit(1);
});
