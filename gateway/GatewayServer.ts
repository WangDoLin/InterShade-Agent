import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SkillCrystallizer } from '../services/skills/SkillCrystallizer.js';
import { FtsMemoryService } from '../services/memory/FtsMemoryService.js';
import { TrajectoryRecorder } from '../services/memory/TrajectoryRecorder.js';
import { SecretScrubber } from '../security/SecretScrubber.js';
import { TelegramAdapter, type TelegramWebhookPayload } from './adapters/TelegramAdapter.js';
import { ApprovalStore } from './ApprovalStore.js';
import {
  type GatewayConfig,
  type GatewayServerOptions,
  resolveGatewayConfig,
  verifyGatewayToken,
} from './GatewayConfig.js';

export interface GatewayMessage {
  sessionId: string;
  source: 'cli' | 'telegram' | 'webhook';
  prompt: string;
  senderId?: string;
  requiresApprovalForDestructiveTools?: boolean;
}

export interface GatewayResponse<T = Record<string, unknown>> {
  success: boolean;
  message?: string;
  error?: string;
  requestId?: string;
  data?: T;
}

/**
 * Fixed-window rate limiter per client key to protect local gateway endpoints.
 */
export class FixedWindowRateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly maxPerWindow: number,
  ) {}

  allow(key: string, cost = 1, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: cost, resetAt: now + this.windowMs });
      return cost <= this.maxPerWindow;
    }
    if (entry.count + cost > this.maxPerWindow) {
      return false;
    }
    entry.count += cost;
    return true;
  }
}

/**
 * Reads an incoming HTTP request body with a strict byte ceiling to prevent memory exhaustion.
 */
function readBodyWithLimit(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(Object.assign(new Error('TOO_LARGE'), { statusCode: 413, errorCode: 'TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!aborted) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

export class GatewayServer extends EventEmitter {
  private server: http.Server | null = null;
  private config: GatewayConfig;
  private port: number;
  private workspaceDir: string;
  private isRunning = false;
  private rateLimiter: FixedWindowRateLimiter;
  private approvalStore: ApprovalStore;
  private seenUpdateIds: number[] = [];
  private highWaterUpdateId = -1;
  private replayStateFile: string;

  constructor(options: GatewayServerOptions) {
    super();
    this.config = resolveGatewayConfig(options);
    this.port = this.config.port;
    this.workspaceDir = options.workspaceDir;
    this.rateLimiter = new FixedWindowRateLimiter(
      this.config.rateLimit.windowMs,
      this.config.rateLimit.maxPerWindow,
    );
    const stateDir = path.join(this.workspaceDir, '.intershader', 'state');
    this.approvalStore = new ApprovalStore({ stateDir });
    this.replayStateFile = path.join(stateDir, 'telegram-replay-window.json');
    this.loadReplayState();
  }

  getApprovalStore(): ApprovalStore {
    return this.approvalStore;
  }

  private loadReplayState(): void {
    try {
      if (fs.existsSync(this.replayStateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.replayStateFile, 'utf8')) as {
          highWaterUpdateId?: number;
          seenUpdateIds?: number[];
        };
        if (typeof raw.highWaterUpdateId === 'number') {
          this.highWaterUpdateId = raw.highWaterUpdateId;
        }
        if (Array.isArray(raw.seenUpdateIds)) {
          this.seenUpdateIds = raw.seenUpdateIds.slice(-this.config.telegram.replayWindowUpdates);
        }
      }
    } catch {
      // Ignore corrupt or missing replay state file
    }
  }

  private persistReplayUpdateId(updateId: number): void {
    this.seenUpdateIds.push(updateId);
    if (this.seenUpdateIds.length > this.config.telegram.replayWindowUpdates) {
      this.seenUpdateIds.shift();
    }
    if (updateId > this.highWaterUpdateId) {
      this.highWaterUpdateId = updateId;
    }
    try {
      fs.mkdirSync(path.dirname(this.replayStateFile), { recursive: true });
      fs.writeFileSync(
        this.replayStateFile,
        JSON.stringify({
          highWaterUpdateId: this.highWaterUpdateId,
          seenUpdateIds: this.seenUpdateIds,
        }),
        'utf8',
      );
    } catch {
      // Non-fatal in ephemeral test directories
    }
  }

  /**
   * Applies strict CORS allowlist checks. Rejects disallowed browser preflights with 403.
   */
  private applyCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const origin = req.headers.origin;
    if (!origin) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return false;
      }
      return true;
    }

    if (!this.config.cors.allowedOrigins.includes(origin)) {
      if (req.method === 'OPTIONS') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'CORS_ORIGIN_FORBIDDEN' }));
        return false;
      }
      return true;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return false;
    }
    return true;
  }

  /**
   * Extracts and verifies bearer authentication when token mode is enabled.
   */
  private isRequestAuthenticated(req: http.IncomingMessage): boolean {
    if (this.config.auth.mode === 'none') {
      return true;
    }
    const authHeader = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    const token = match?.[1]?.trim();
    return verifyGatewayToken(token, this.config.auth.tokenHash);
  }

  /**
   * Sends a JSON response scrubbed through SecretScrubber so no secret ever leaves the gateway boundary (NEXT-B-08).
   */
  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    const scrubbedBody = SecretScrubber.scrubObject(body);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scrubbedBody));
  }

  /**
   * Starts the headless Gateway HTTP daemon bound to the configured host (127.0.0.1 by default).
   */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const requestId = crypto.randomUUID();
        res.setHeader('X-Request-Id', requestId);

        if (!this.applyCors(req, res)) {
          return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const isStatusRoute = req.method === 'GET' && url.pathname === '/api/status';
        const isHealthzRoute = req.method === 'GET' && url.pathname === '/healthz';
        const isReadyzRoute = req.method === 'GET' && url.pathname === '/readyz';
        const isTelegramWebhookRoute = req.method === 'POST' && url.pathname === '/telegram/webhook';
        const isAuthenticated = this.isRequestAuthenticated(req);

        // Liveness probe (/healthz) and Readiness probe (/readyz) (Section C4)
        if (isHealthzRoute) {
          this.sendJson(res, 200, {
            status: 'ok',
            uptimeMs: Math.round(process.uptime() * 1000),
            timestamp: Date.now(),
            requestId,
          });
          return;
        }

        if (isReadyzRoute) {
          let dbReady = true;
          try {
            FtsMemoryService.searchMemories('healthcheck', { limit: 1 });
          } catch {
            dbReady = false;
          }
          const status = dbReady && this.isRunning ? 200 : 503;
          this.sendJson(res, status, {
            ready: status === 200,
            components: {
              gateway: this.isRunning ? 'up' : 'down',
              sqliteFts: dbReady ? 'up' : 'down',
              telegramWebhook: this.config.telegram.enabled ? 'enabled' : 'disabled',
            },
            timestamp: Date.now(),
            requestId,
          });
          return;
        }

        // Dedicated 3-layer authentication for Telegram Webhook (NEXT-B-02..03)
        if (isTelegramWebhookRoute) {
          const tgHeader = req.headers['x-telegram-bot-api-secret-token'];
          const candidateSecret = Array.isArray(tgHeader) ? tgHeader[0] : tgHeader;
          if (!verifyGatewayToken(candidateSecret, this.config.telegram.webhookSecretHash)) {
            this.sendJson(res, 401, { success: false, error: 'UNAUTHORIZED_TELEGRAM_WEBHOOK', requestId });
            return;
          }

          let rawBody: string;
          try {
            rawBody = await readBodyWithLimit(req, this.config.limits.maxBodyBytes);
          } catch (readErr: unknown) {
            const statusCode = (readErr as { statusCode?: number })?.statusCode ?? 400;
            this.sendJson(res, statusCode, {
              success: false,
              error: statusCode === 413 ? 'TOO_LARGE' : 'BAD_REQUEST',
              requestId,
            });
            return;
          }

          let payload: TelegramWebhookPayload;
          try {
            payload = JSON.parse(rawBody || '{}') as TelegramWebhookPayload;
          } catch {
            this.sendJson(res, 400, { success: false, error: 'BAD_REQUEST', requestId });
            return;
          }

          const parsed = TelegramAdapter.parseWebhookUpdate(payload);

          // Layer 2: User & Chat Allowlist (silent 200 drop on unauthorized user/chat)
          const { allowedUserIds, allowedChatIds } = this.config.telegram;
          if (
            (allowedUserIds.length > 0 && (parsed.senderId === undefined || !allowedUserIds.includes(parsed.senderId))) ||
            (allowedChatIds.length > 0 && (parsed.chatId === undefined || !allowedChatIds.includes(parsed.chatId)))
          ) {
            this.emit('telegram_audit', {
              event: 'allowlist_drop',
              senderId: parsed.senderId,
              chatId: parsed.chatId,
              updateId: parsed.updateId,
            });
            this.sendJson(res, 200, { ok: true, ignored: 'allowlist', requestId });
            return;
          }

          // Layer 3: Replay window & monotonic update_id check
          if (
            typeof parsed.updateId !== 'number' ||
            this.seenUpdateIds.includes(parsed.updateId) ||
            parsed.updateId <= this.highWaterUpdateId
          ) {
            this.emit('telegram_audit', {
              event: 'replay_drop',
              senderId: parsed.senderId,
              chatId: parsed.chatId,
              updateId: parsed.updateId,
            });
            this.sendJson(res, 200, { ok: true, ignored: 'replay', requestId });
            return;
          }
          this.persistReplayUpdateId(parsed.updateId);

          this.emit('telegram_update', parsed);
          this.sendJson(res, 200, { ok: true, updateId: parsed.updateId, requestId });
          return;
        }

        // Enforce authentication before rate-limiting (Plan §4.8.4 #2) for all protected routes
        if (!isStatusRoute && !isAuthenticated) {
          this.sendJson(res, 401, { success: false, error: 'UNAUTHORIZED', requestId });
          return;
        }

        const clientIp = req.socket.remoteAddress || '127.0.0.1';
        const rateLimitKey = `${clientIp}:${this.config.auth.tokenHash?.slice(0, 8) || 'anon'}`;
        const isPromptRoute = req.method === 'POST' && url.pathname === '/api/prompt';
        const rateCost = isPromptRoute ? 5 : 1;

        if (!this.rateLimiter.allow(rateLimitKey, rateCost)) {
          this.sendJson(res, 429, { success: false, error: 'RATE_LIMITED', requestId });
          return;
        }

        try {
          // 1. Health check & status (safe unauthenticated summary: never leaks workspaceDir without auth)
          if (isStatusRoute) {
            const skills = SkillCrystallizer.loadSkills(this.workspaceDir);
            const recentTrajs = TrajectoryRecorder.getRecentSuccessful(5);

            const data: Record<string, unknown> = {
              status: 'RUNNING',
              port: this.port,
              crystallizedSkillsCount: skills.length,
              recentSuccessfulRuns: recentTrajs.length,
              timestamp: Date.now(),
            };

            if (this.config.auth.mode === 'token' && isAuthenticated) {
              data.authenticated = true;
            }

            const payload: GatewayResponse = {
              success: true,
              message: 'InterShader Gateway Server Operational',
              requestId,
              data,
            };

            this.sendJson(res, 200, payload);
            return;
          }

          // 2. Crystallized Skills registry
          if (req.method === 'GET' && url.pathname === '/api/skills') {
            const skills = SkillCrystallizer.loadSkills(this.workspaceDir);
            this.sendJson(res, 200, { success: true, skills, requestId });
            return;
          }

          // 3. FTS5 Memory Search
          if (req.method === 'GET' && url.pathname === '/api/memories/search') {
            const q = (url.searchParams.get('q') || '').slice(0, 512);
            const results = FtsMemoryService.searchMemories(q, { limit: 10 });
            this.sendJson(res, 200, { success: true, results, requestId });
            return;
          }

          // 4. Prompt submission & dispatch
          if (req.method === 'POST' && url.pathname === '/api/prompt') {
            let rawBody: string;
            try {
              rawBody = await readBodyWithLimit(req, this.config.limits.maxBodyBytes);
            } catch (readErr: unknown) {
              const statusCode = (readErr as { statusCode?: number })?.statusCode ?? 400;
              const errorCode = statusCode === 413 ? 'TOO_LARGE' : 'BAD_REQUEST';
              this.sendJson(res, statusCode, { success: false, error: errorCode, requestId });
              return;
            }

            let parsedBody: Record<string, unknown>;
            try {
              parsedBody = JSON.parse(rawBody || '{}') as Record<string, unknown>;
            } catch {
              this.sendJson(res, 400, { success: false, error: 'BAD_REQUEST', requestId });
              return;
            }

            const promptText = typeof parsedBody.prompt === 'string' ? parsedBody.prompt.trim() : '';
            if (!promptText) {
              this.sendJson(res, 400, {
                success: false,
                error: 'BAD_REQUEST',
                message: 'Missing prompt in request body.',
                requestId,
              });
              return;
            }

            if (promptText.length > this.config.limits.maxPromptChars) {
              this.sendJson(res, 413, { success: false, error: 'TOO_LARGE', requestId });
              return;
            }

            const rawSource = parsedBody.source;
            const source: GatewayMessage['source'] =
              rawSource === 'cli' || rawSource === 'telegram' || rawSource === 'webhook'
                ? rawSource
                : 'webhook';

            const msg: GatewayMessage = {
              sessionId: typeof parsedBody.sessionId === 'string' ? parsedBody.sessionId : 'gateway-default',
              source,
              prompt: SecretScrubber.sanitize(promptText),
              senderId: typeof parsedBody.senderId === 'string' ? parsedBody.senderId : undefined,
              // Remote prompts never inherit local bypassPermissions without explicit approval
              requiresApprovalForDestructiveTools: source !== 'cli',
            };

            this.emit('user_prompt', msg);

            this.sendJson(res, 200, {
              success: true,
              message: 'Prompt enqueued for processing.',
              sessionId: msg.sessionId,
              requestId,
            });
            return;
          }

          this.sendJson(res, 404, { success: false, error: 'NOT_FOUND', requestId });
        } catch {
          if (!res.headersSent) {
            this.sendJson(res, 500, { success: false, error: 'INTERNAL', requestId });
          }
        }
      });

      this.server.listen(this.port, this.config.host, () => {
        this.isRunning = true;
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve(this.port);
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Returns the bound socket address and port when running.
   */
  getAddress(): { address: string; port: number } | null {
    if (!this.server || !this.isRunning) return null;
    const addr = this.server.address();
    if (addr && typeof addr === 'object') {
      return { address: addr.address, port: addr.port };
    }
    return { address: this.config.host, port: this.port };
  }

  /**
   * Gracefully stops the Gateway server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server && this.isRunning) {
        this.server.closeAllConnections?.();
        this.server.close(() => {
          this.isRunning = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
