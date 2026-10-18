import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

// Multi-path .env resolution hierarchy:
// 1. Current working directory .env
// 2. Child InterShade-code-agent .env (if running from parent workspace)
// 3. Package root directory .env
// 4. Global user directory ~/.intershade/.env
const candidateEnvPaths = [
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), 'InterShade-code-agent', '.env'),
  path.join(packageRoot, '.env'),
  path.join(os.homedir(), '.intershade', '.env'),
];

for (const envPath of candidateEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

export interface AppConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  deepseekApiKey?: string;
  geminiApiKey?: string;
  defaultProvider: 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'deepseek';
  defaultModel: string;
  maxContextTokens: number;
  autoCompactThreshold: number;
  maxTurns: number;
  dataDir: string;
}

const homeDir = os.homedir();
const intershaderDataDir = path.join(homeDir, '.intershade');

if (!fs.existsSync(intershaderDataDir)) {
  fs.mkdirSync(intershaderDataDir, { recursive: true });
}

export const config: AppConfig = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  defaultProvider: (process.env.DEFAULT_PROVIDER as AppConfig['defaultProvider']) || 'anthropic',
  defaultModel: process.env.DEFAULT_MODEL || 'claude-3-7-sonnet-20250219',
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '160000', 10),
  autoCompactThreshold: parseFloat(process.env.AUTO_COMPACT_THRESHOLD || '0.75'),
  maxTurns: (() => {
    const raw = (process.env.MAX_TURNS || '100').toLowerCase().trim();
    if (['unlimited', 'inf', 'infinite', '0', 'none', 'continuous'].includes(raw)) {
      return 0;
    }
    const parsed = parseInt(raw, 10);
    return isNaN(parsed) ? 100 : parsed;
  })(),
  dataDir: intershaderDataDir,
};

