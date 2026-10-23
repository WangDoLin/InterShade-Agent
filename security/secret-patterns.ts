export interface SecretPatternRule {
  id: string;
  name: string;
  pattern: RegExp;
  mask: string;
  severity: 'credential' | 'token' | 'contextual';
}

/**
 * Single source of truth for secret redaction patterns across InterShader (NEXT-B-06).
 * Combines all rules from legacy SecretRedactor and SecretSanitizer, plus PEM, JWT,
 * Telegram Bot API tokens, and x-goog-api-key headers (SEC-001).
 */
export const SECRET_PATTERN_RULES: readonly SecretPatternRule[] = [
  {
    id: 'pem-private-key',
    name: 'Private Key',
    pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
    mask: '[REDACTED_PRIVATE_KEY]',
    severity: 'credential',
  },
  {
    id: 'anthropic-api-key',
    name: 'Anthropic API Key',
    pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
    mask: '[REDACTED_API_KEY]',
    severity: 'credential',
  },
  {
    id: 'openai-api-key',
    name: 'OpenAI API Key',
    pattern: /sk-[a-zA-Z0-9_-]{20,}/g,
    mask: '[REDACTED_API_KEY]',
    severity: 'credential',
  },
  {
    id: 'google-api-key',
    name: 'Google API Key',
    pattern: /AIza[0-9A-Za-z_-]{30,}/g,
    mask: '[REDACTED_API_KEY]',
    severity: 'credential',
  },
  {
    id: 'google-oauth-token',
    name: 'Google OAuth Token',
    pattern: /ya29\.[0-9A-Za-z_-]{25,}/g,
    mask: '[REDACTED_GOOGLE_TOKEN]',
    severity: 'token',
  },
  {
    id: 'github-token',
    name: 'GitHub Token',
    pattern: /(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{22,})/g,
    mask: '[REDACTED_GITHUB_TOKEN]',
    severity: 'token',
  },
  {
    id: 'slack-token',
    name: 'Slack Token',
    pattern: /xox[baprs]-[0-9A-Za-z-]{10,}/g,
    mask: '[REDACTED_SLACK_TOKEN]',
    severity: 'token',
  },
  {
    id: 'telegram-bot-token',
    name: 'Telegram Bot Token',
    pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
    mask: '[REDACTED_TELEGRAM_BOT_TOKEN]',
    severity: 'credential',
  },
  {
    id: 'aws-session-token',
    name: 'AWS Session Token',
    pattern: /ASIA[0-9A-Z]{16,}/g,
    mask: '[REDACTED_AWS_SESSION_TOKEN]',
    severity: 'token',
  },
  {
    id: 'aws-access-key',
    name: 'AWS Access Key',
    pattern: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}/g,
    mask: '[REDACTED_AWS_KEY]',
    severity: 'credential',
  },
  {
    id: 'aws-secret-key',
    name: 'AWS Secret Access Key',
    pattern: /((?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*)[A-Za-z0-9/+=]{40}/gi,
    mask: '$1[REDACTED_AWS_SECRET_KEY]',
    severity: 'credential',
  },
  {
    id: 'azure-account-key',
    name: 'Azure Account Key',
    pattern: /((?:AccountKey|api-key)\s*[:=]\s*)[A-Za-z0-9+/=]{30,}/gi,
    mask: '$1[REDACTED_AZURE_KEY]',
    severity: 'credential',
  },
  {
    id: 'jwt-token',
    name: 'JWT Token',
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    mask: '[REDACTED_JWT_TOKEN]',
    severity: 'token',
  },
  {
    id: 'url-embedded-credentials',
    name: 'URL Credentials',
    pattern: /(https?:\/\/)[^:/\s@]+:[^@/\s]+@/gi,
    mask: '$1[REDACTED_AUTH]@',
    severity: 'credential',
  },
  {
    id: 'bearer-token',
    name: 'Bearer Token',
    pattern: /Bearer\s+[a-zA-Z0-9_\-.]{16,}/gi,
    mask: 'Bearer [REDACTED_TOKEN]',
    severity: 'token',
  },
  {
    id: 'authorization-header',
    name: 'Authorization Header',
    pattern: /(authorization:\s*)[^\r\n]+/gi,
    mask: '$1[REDACTED_AUTH_HEADER]',
    severity: 'contextual',
  },
  {
    id: 'x-goog-api-key-header',
    name: 'Google API Key Header',
    pattern: /(x-goog-api-key:\s*)[^\r\n\s,;]+/gi,
    mask: '$1[REDACTED_API_KEY]',
    severity: 'credential',
  },
  {
    id: 'query-string-secret',
    name: 'Query String Secret',
    pattern: /((?:api_?key|token|secret|password)=)[a-zA-Z0-9_\-.]{8,}/gi,
    mask: '$1[REDACTED_SECRET]',
    severity: 'contextual',
  },
];
