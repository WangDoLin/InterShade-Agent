/**
 * Synthetic canary secret generator (NEXT-B-08).
 * Constructs fake tokens at runtime by joining fragments so static secret scanners
 * (GitHub push protection / gitleaks) never flag test fixtures.
 */
export interface CanarySecretFixture {
  id: string;
  description: string;
  value: string;
}

export function buildCanarySecrets(): CanarySecretFixture[] {
  const repeat = (ch: string, n: number) => ch.repeat(n);
  return [
    {
      id: 'openai-key',
      description: 'Synthetic OpenAI Project Key',
      value: ['sk', 'proj', repeat('A1b2', 7)].join('-'),
    },
    {
      id: 'anthropic-key',
      description: 'Synthetic Anthropic API Key',
      value: ['sk', 'ant', 'api03', repeat('X9y8', 7)].join('-'),
    },
    {
      id: 'gemini-key',
      description: 'Synthetic Google Gemini Key',
      value: ['AI', 'zaSy', repeat('G7h6J5k4', 4), 'L3m'].join(''),
    },
    {
      id: 'github-pat',
      description: 'Synthetic GitHub Classic PAT',
      value: ['ghp', repeat('Z9x8C7v6B5n4', 3)].join('_'),
    },
    {
      id: 'github-fine-grained',
      description: 'Synthetic GitHub Fine-Grained PAT',
      value: ['github', 'pat', repeat('Q1w2E3r4T5y6', 3)].join('_'),
    },
    {
      id: 'slack-token',
      description: 'Synthetic Slack Bot Token',
      value: ['xoxb', '123456789012', '987654321098', repeat('AbCdEf', 4)].join('-'),
    },
    {
      id: 'telegram-bot-token',
      description: 'Synthetic Telegram Bot Token',
      value: ['1234567890', ':', 'AA', repeat('H1j2K3l4M5n', 3)].join(''),
    },
    {
      id: 'aws-access-key',
      description: 'Synthetic AWS Access Key ID',
      value: ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join(''),
    },
    {
      id: 'jwt-bearer',
      description: 'Synthetic JWT Token',
      value: [
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkNhbmFyeSJ9',
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      ].join('.'),
    },
    {
      id: 'private-key-pem',
      description: 'Synthetic PEM Private Key Block',
      value: [
        ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
        'MIIEpAIBAAKCAQEA0canarySyntheticKeyBodyData1234567890==',
        ['-----END', 'RSA PRIVATE KEY-----'].join(' '),
      ].join('\n'),
    },
    {
      id: 'url-creds',
      description: 'Synthetic URL Embedded Credentials',
      value: ['https://admin:', 'SuperSecretPass999', '@internal.intershade.local/api'].join(''),
    },
  ];
}
