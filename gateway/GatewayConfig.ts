import crypto from 'node:crypto';

export const DEFAULT_GATEWAY_HOST = '127.0.0.1';
export const DEFAULT_GATEWAY_PORT = 3847;
export const DEFAULT_MAX_BODY_BYTES = 65_536;
export const DEFAULT_MAX_PROMPT_CHARS = 32_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX = 60;
export const DEFAULT_TELEGRAM_APPROVAL_TTL_SECONDS = 600;
export const DEFAULT_TELEGRAM_REPLAY_WINDOW = 1000;

export interface TelegramGatewayConfig {
  enabled: boolean;
  webhookSecretTokenEnv: string;
  webhookSecretHash?: string;
  allowedUserIds: number[];
  allowedChatIds: number[];
  approvalTtlSeconds: number;
  replayWindowUpdates: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  cors: {
    allowedOrigins: string[];
    allowCredentials: false;
  };
  auth: {
    mode: 'token' | 'none';
    tokenHash?: string;
  };
  limits: {
    maxBodyBytes: number;
    maxPromptChars: number;
    requestTimeoutMs: number;
  };
  rateLimit: {
    windowMs: number;
    maxPerWindow: number;
  };
  telegram: TelegramGatewayConfig;
}

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  workspaceDir: string;
  corsAllowedOrigins?: string[];
  authToken?: string;
  authMode?: 'token' | 'none';
  maxBodyBytes?: number;
  maxPromptChars?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxPerWindow?: number;
  telegram?: {
    enabled?: boolean;
    webhookSecretToken?: string;
    webhookSecretTokenEnv?: string;
    allowedUserIds?: number[];
    allowedChatIds?: number[];
    approvalTtlSeconds?: number;
    replayWindowUpdates?: number;
  };
}

/**
 * Computes a SHA-256 hex digest of an authentication token so raw tokens are never stored in memory.
 */
export function hashGatewayToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time verification of a bearer or webhook secret token against an expected SHA-256 token hash.
 */
export function verifyGatewayToken(candidateToken: string | undefined, expectedHash: string | undefined): boolean {
  if (!candidateToken || !expectedHash) return false;
  const candidateHash = hashGatewayToken(candidateToken);
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Resolves the effective GatewayConfig from options and environment variables.
 */
export function resolveGatewayConfig(options: GatewayServerOptions): GatewayConfig {
  const host = options.host ?? process.env.INTERSHADE_GATEWAY_HOST ?? DEFAULT_GATEWAY_HOST;
  const envPort = process.env.INTERSHADE_GATEWAY_PORT
    ? Number.parseInt(process.env.INTERSHADE_GATEWAY_PORT, 10)
    : undefined;
  const port = options.port !== undefined ? options.port : (Number.isFinite(envPort) ? envPort! : DEFAULT_GATEWAY_PORT);

  const rawToken = options.authToken ?? process.env.INTERSHADE_GATEWAY_TOKEN;
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const authMode = options.authMode ?? (rawToken ? 'token' : 'none');

  if (authMode === 'none' && !isLoopback) {
    throw new Error(
      `[REJECT_INSECURE_GATEWAY_BIND]: Binding GatewayServer to non-loopback host "${host}" requires authentication (set authToken or INTERSHADE_GATEWAY_TOKEN).`,
    );
  }

  const tgSecretEnvName = options.telegram?.webhookSecretTokenEnv ?? 'TELEGRAM_WEBHOOK_SECRET';
  const rawTelegramSecret =
    options.telegram?.webhookSecretToken ?? process.env[tgSecretEnvName];

  return {
    host,
    port,
    cors: {
      allowedOrigins: options.corsAllowedOrigins ?? [],
      allowCredentials: false,
    },
    auth: {
      mode: authMode,
      tokenHash: rawToken ? hashGatewayToken(rawToken) : undefined,
    },
    limits: {
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      maxPromptChars: options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    },
    rateLimit: {
      windowMs: options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
      maxPerWindow: options.rateLimitMaxPerWindow ?? DEFAULT_RATE_LIMIT_MAX,
    },
    telegram: {
      enabled: options.telegram?.enabled ?? Boolean(rawTelegramSecret),
      webhookSecretTokenEnv: tgSecretEnvName,
      webhookSecretHash: rawTelegramSecret ? hashGatewayToken(rawTelegramSecret) : undefined,
      allowedUserIds: options.telegram?.allowedUserIds ?? [],
      allowedChatIds: options.telegram?.allowedChatIds ?? [],
      approvalTtlSeconds: options.telegram?.approvalTtlSeconds ?? DEFAULT_TELEGRAM_APPROVAL_TTL_SECONDS,
      replayWindowUpdates: options.telegram?.replayWindowUpdates ?? DEFAULT_TELEGRAM_REPLAY_WINDOW,
    },
  };
}
