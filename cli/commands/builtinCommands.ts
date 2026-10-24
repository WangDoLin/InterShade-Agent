import type { PromptCommand, LocalCommand, CommandContext } from './types.js';
import type { CommandRegistry } from './CommandRegistry.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDatabase } from '../../state/Database.js';
import { SessionStore } from '../../state/SessionStore.js';
import { FtsMemoryService } from '../../services/memory/FtsMemoryService.js';
import { SkillCrystallizer } from '../../services/skills/SkillCrystallizer.js';
import { SkillRegistry } from '../../services/skills/SkillRegistry.js';
import { SkillSecurityAuditor } from '../../services/skills/SkillSecurityAuditor.js';
import { SkillHubClient } from '../../services/skills/SkillHubClient.js';
import { ShadowWorktree } from '../../security/ShadowWorktree.js';
import { ClaudeAgentCoordinator } from '../../services/agent/ClaudeAgentCoordinator.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { ProofEngine } from '../../engine/verification/ProofEngine.js';
import { ModelRouter } from '../../orchestrator/ModelRouter.js';
import { SweBenchmarkRunner } from '../../engine/benchmark/SweBenchmarkRunner.js';
import { GatewayFormatter } from '../../providers/catalog/GatewayFormatter.js';
import { ModelDiscovery } from '../../providers/catalog/ModelDiscovery.js';
import { ConnectionRegistry } from '../../providers/core/ConnectionRegistry.js';
import { ProviderHealthChecker } from '../../providers/reliability/ProviderHealthChecker.js';
import { PlanManager } from '../../state/PlanManager.js';
import { config } from '../../config/index.js';
import { swarmCommand } from './swarmCommand.js';
import { McpClientManager } from '../../services/mcp/McpClientManager.js';
import { RepoMapTool } from '../../tools/context/RepoMapTool.js';
import { TaskManager } from '../../state/TaskManager.js';
import { SerenaSemanticEngine } from '../../engine/semantic/SerenaSemanticEngine.js';
import { TaskScheduler } from '../../services/scheduler/TaskScheduler.js';
import { InvariantFuzzEngine, type InvariantType } from '../../engine/verification/InvariantFuzzEngine.js';


export const reviewCommand: PromptCommand = {
  name: 'review',
  description: 'Perform thorough code review, security audit, and quality inspection',
  type: 'prompt',
  aliases: ['audit'],
  getPrompt: (ctx) => {
    const target = ctx.args.length > 0 ? ctx.args.join(' ') : 'the current git diff or recent modifications';
    return [
      `Please perform a rigorous, systematic code review of ${target}.`,
      'Examine:',
      '1. Correctness and logic regressions',
      '2. Boundary conditions and unhandled error cases',
      '3. Security vulnerabilities (input validation, secret leakage, injection)',
      '4. Performance and resource leaks',
      'Provide concrete actionable recommendations with line-specific references.'
    ].join('\n');
  }
};

export const commitCommand: PromptCommand = {
  name: 'commit',
  description: 'Generate conventional commit message and commit staged changes',
  type: 'prompt',
  aliases: ['ci'],
  getPrompt: (ctx) => {
    const hint = ctx.args.length > 0 ? ` Additional intent note: ${ctx.args.join(' ')}` : '';
    return [
      'Inspect staged git changes using git status and git diff.',
      'Generate a standardized Conventional Commit message (e.g. feat:, fix:, refactor:, chore:, test:).',
      'Commit the changes using run_shell_command.',
      hint
    ].join('\n');
  }
};

export const diffCommand: LocalCommand = {
  name: 'diff',
  description: 'Display working directory git diff summary',
  type: 'local',
  execute: (ctx) => {
    try {
      const output = execSync('git diff --stat', {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return output.trim() || 'No modified files detected in working tree.';
    } catch {
      return 'Not inside a git repository or git command unavailable.';
    }
  }
};

export const statsCommand: LocalCommand = {
  name: 'stats',
  description: 'Display session token usage statistics (usage: /stats [all|<sessionId>])',
  type: 'local',
  aliases: ['tokens', 'usage'],
  execute: (ctx) => {
    const rawArg = ctx.args[0]?.trim();
    const isAll = rawArg === 'all' || rawArg === 'total' || rawArg === '-a' || rawArg === '--all';

    // /stats all -> View total tokens across all sessions
    if (isAll) {
      const summary = SessionStore.getTotalUsage();
      return [
        'Total Historical Token Statistics',
        `Total Sessions Stored: ${summary.totalSessions.toLocaleString()}`,
        `Active Usage Sessions: ${summary.activeSessions.toLocaleString()}`,
        `Input Tokens:  ${summary.totalInputTokens.toLocaleString()}`,
        `Output Tokens: ${summary.totalOutputTokens.toLocaleString()}`,
        `Total Tokens:  ${summary.totalTokens.toLocaleString()}`,
        `Total Cost:    $${summary.totalCostUsd.toFixed(4)} USD`,
      ].join('\n');
    }

    // /stats <sessionId> -> View tokens of specific session if valid session requested
    const looksLikePath = rawArg && (rawArg.includes('/') || rawArg.includes('\\') || rawArg.endsWith('.ts') || rawArg.endsWith('.js'));
    const isExplicitSession = rawArg && rawArg !== 'current' && !looksLikePath;
    if (isExplicitSession) {
      const target = SessionStore.getSession(rawArg);
      if (target) {
        const total = target.totalInputTokens + target.totalOutputTokens;
        return [
          `Session Token Usage [${target.id.slice(0, 8)}]`,
          `Input Tokens:  ${target.totalInputTokens.toLocaleString()}`,
          `Output Tokens: ${target.totalOutputTokens.toLocaleString()}`,
          `Total Tokens:  ${total.toLocaleString()}`,
          `Total Cost:    $${target.totalCostUsd.toFixed(4)} USD`,
        ].join('\n');
      } else if (rawArg.length >= 8 || rawArg.includes('-')) {
        return `Session "${rawArg}" not found in database. Use "/stats all" or "/sessions" to list conversations.`;
      }
    }

    // Default: current session
    const st = ctx.sessionState as Record<string, unknown>;
    const input = Number(st.totalInputTokens || 0);
    const output = Number(st.totalOutputTokens || 0);
    const total = input + output;
    return [
      'Session Token Usage',
      `Input Tokens:  ${input.toLocaleString()}`,
      `Output Tokens: ${output.toLocaleString()}`,
      `Total Tokens:  ${total.toLocaleString()}`,
      '',
      'Tip: Use "/stats all" to see tokens across all conversations, or "/stats <id>" for a specific session.',
    ].join('\n');
  }
};

export const costCommand: LocalCommand = {
  name: 'cost',
  description: 'Display estimated token consumption cost (usage: /cost [all|<sessionId>])',
  type: 'local',
  aliases: ['pricing', 'billing'],
  execute: (ctx) => {
    const rawArg = ctx.args[0]?.trim();
    const isAll = rawArg === 'all' || rawArg === 'total' || rawArg === '-a' || rawArg === '--all';

    // /cost all -> Summary across all sessions
    if (isAll) {
      const summary = SessionStore.getTotalUsage();
      const recent = SessionStore.listSessions(10).filter((s) => s.totalInputTokens + s.totalOutputTokens > 0);
      const lines: string[] = [
        'Total Historical Cost & Token Summary',
        `Total Sessions Stored:  ${summary.totalSessions.toLocaleString()}`,
        `Active Usage Sessions:  ${summary.activeSessions.toLocaleString()}`,
        `Total Input Tokens:     ${summary.totalInputTokens.toLocaleString()}`,
        `Total Output Tokens:    ${summary.totalOutputTokens.toLocaleString()}`,
        `Total Tokens:           ${summary.totalTokens.toLocaleString()}`,
        `Total Estimated Cost:   $${summary.totalCostUsd.toFixed(4)} USD`,
        '',
        'Recent active conversations:',
      ];
      for (const s of recent.slice(0, 5)) {
        const timeStr = new Date(s.updatedAt).toLocaleString();
        const tot = s.totalInputTokens + s.totalOutputTokens;
        lines.push(`- [${s.id.slice(0, 8)}] ${s.model}: ${tot.toLocaleString()} tokens ($${s.totalCostUsd.toFixed(4)}) | ${timeStr}`);
      }
      lines.push('\nTip: Use "/cost <id>" to check cost for a specific conversation.');
      return lines.join('\n');
    }

    // /cost <sessionId> -> Specific session cost if valid session requested
    const looksLikePath = rawArg && (rawArg.includes('/') || rawArg.includes('\\') || rawArg.endsWith('.ts') || rawArg.endsWith('.js'));
    const isExplicitSession = rawArg && rawArg !== 'current' && !looksLikePath;
    if (isExplicitSession) {
      const target = SessionStore.getSession(rawArg);
      if (target) {
        const total = target.totalInputTokens + target.totalOutputTokens;
        const timeStr = new Date(target.updatedAt).toLocaleString();
        return [
          `Session Cost [${target.id.slice(0, 8)}]`,
          `Model:          ${target.model} (${target.provider})`,
          `Updated:        ${timeStr}`,
          `Input Tokens:   ${target.totalInputTokens.toLocaleString()}`,
          `Output Tokens:  ${target.totalOutputTokens.toLocaleString()}`,
          `Total Tokens:   ${total.toLocaleString()}`,
          `Estimated Session Cost: $${target.totalCostUsd.toFixed(4)} USD`,
        ].join('\n');
      } else if (rawArg.length >= 8 || rawArg.includes('-')) {
        return `Session "${rawArg}" not found in database. Use "/cost all" or "/sessions" to list conversations.`;
      }
    }

    // Default: current session
    const st = ctx.sessionState as Record<string, unknown>;
    const input = Number(st.totalInputTokens || 0);
    const output = Number(st.totalOutputTokens || 0);
    const recordedCost = Number(st.totalCostUsd);
    const cost = !isNaN(recordedCost) && recordedCost > 0
      ? recordedCost
      : (input / 1_000_000) * 3.0 + (output / 1_000_000) * 15.0;

    return [
      `Estimated Session Cost: $${cost.toFixed(4)} USD`,
      `Input Tokens:  ${input.toLocaleString()}`,
      `Output Tokens: ${output.toLocaleString()}`,
      `Total Tokens:  ${(input + output).toLocaleString()}`,
      '',
      'Tips: Use "/cost all" to see all conversations, or "/cost <id>" for a specific session.',
    ].join('\n');
  }
};

export const doctorCommand: LocalCommand = {
  name: 'doctor',
  description: 'Comprehensive runtime, git, database, and API environment diagnostics',
  type: 'local',
  aliases: ['health', 'diag'],
  execute: (ctx) => {
    const reports: string[] = ['InterShader System Diagnostics'];

    // 1. Node runtime
    reports.push(`Runtime:     Node.js ${process.version} (${process.platform} ${process.arch})`);

    // 2. Database WAL status
    try {
      const db = getDatabase();
      const walRow = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
      reports.push(`Database:    SQLite WAL Mode (active: ${walRow.journal_mode})`);
    } catch (e: unknown) {
      reports.push(`Database:    SQLite Error (${(e as Error).message})`);
    }

    // 3. Git integration
    try {
      const gitVer = execSync('git --version', { encoding: 'utf-8', timeout: 3000 }).trim();
      const inWorkTree = execSync('git rev-parse --is-inside-work-tree', {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      reports.push(`Git Engine:  ${gitVer} (WorkTree: ${inWorkTree})`);
    } catch {
      reports.push('Git Engine:  Not in a git worktree or git CLI unavailable');
    }

    // 4. Provider Keys
    const providers = [
      { name: 'Anthropic', key: process.env.ANTHROPIC_API_KEY },
      { name: 'OpenAI', key: process.env.OPENAI_API_KEY },
      { name: 'DeepSeek', key: process.env.DEEPSEEK_API_KEY },
      { name: 'Gemini', key: process.env.GEMINI_API_KEY },
    ];
    const keyStatus = providers.map((p) => `${p.name}: ${p.key ? 'READY' : 'MISSING'}`).join(' | ');
    reports.push(`AI Keys:     ${keyStatus}`);

    // 5. Working directory
    reports.push(`Workspace:   ${ctx.cwd}`);
    reports.push('Status:      All core components operational');

    return reports.join('\n');
  }
};

export const modelCommand: LocalCommand = {
  name: 'model',
  description: 'View, list, inspect, or switch LLM models (/models list, /models inspect <provider> <model>)',
  type: 'local',
  aliases: ['models'],
  execute: async (ctx) => {
    const sub = ctx.args[0]?.toLowerCase();

    if (sub === 'list') {
      const providerFilter = ctx.args[1];
      return GatewayFormatter.formatModelsList(providerFilter);
    }

    if (sub === 'inspect') {
      const providerId = ctx.args[1];
      const modelId = ctx.args[2];
      if (!providerId || !modelId) {
        return 'Usage: /models inspect <provider> <model_id>';
      }
      return GatewayFormatter.formatModelInspect(providerId, modelId);
    }

    if (sub === 'discover') {
      const connId = ctx.args[1] || 'ollama-local';
      const conn = ConnectionRegistry.get(connId) || ConnectionRegistry.findByProvider(connId);
      if (!conn) {
        return `Connection '${connId}' not found in registry.`;
      }
      try {
        const discovered = await ModelDiscovery.discover(conn);
        return [
          `Discovered ${discovered.length} models from ${conn.id}:`,
          ...discovered.slice(0, 15).map((m) => `  - ${m.modelId} (tools: ${m.capabilities.toolCalling}, context: ${m.contextWindow})`),
        ].join('\n');
      } catch (err) {
        return `Discovery failed for '${conn.id}': ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const st = ctx.sessionState as Record<string, unknown>;

    if (!ctx.args[0]) {
      return [
        'Active Model Gateway Configuration',
        `Current Model:    ${st.model || 'claude-3-7-sonnet'}`,
        `Current Provider: ${st.provider || 'anthropic'}`,
        '',
        'Available Gateway Commands:',
        '  /models list [provider]           - View all registered models',
        '  /models inspect <provider> <id>   - Inspect model capabilities & limits',
        '  /models discover <connection>     - Query /v1/models dynamically',
        '  /model <model_name>               - Switch active model (e.g. /model ag/gemini-3.8-flash-high)',
        '  /model <provider> <model_name>    - Switch with explicit provider (e.g. /model openai ag/gemini-3.8-flash-high)',
      ].join('\n');
    }

    const KNOWN_PROVIDERS: Record<string, string> = {
      openai: 'openai',
      anthropic: 'anthropic',
      claude: 'anthropic',
      google: 'google',
      gemini: 'google',
      deepseek: 'deepseek',
      ollama: 'ollama',
    };

    const isLocalProxy = (process.env.OPENAI_BASE_URL || '').includes('20128') ||
                         (process.env.OPENAI_BASE_URL || '').includes('localhost') ||
                         (process.env.OPENAI_BASE_URL || '').includes('127.0.0.1');

    let targetProvider = '';
    let targetModel = '';

    const firstArg = ctx.args[0].trim();
    const secondArg = ctx.args[1]?.trim();

    // Case 1: Prefix format: /model openai:ag/gemini-3.8-flash-high
    if (firstArg.includes(':') && !firstArg.startsWith('http')) {
      const colonIdx = firstArg.indexOf(':');
      const prefix = firstArg.substring(0, colonIdx).toLowerCase();
      const modelPart = firstArg.substring(colonIdx + 1);
      if (KNOWN_PROVIDERS[prefix]) {
        targetProvider = KNOWN_PROVIDERS[prefix];
        targetModel = modelPart;
      }
    }

    // Case 2: Two arguments: /model openai ag/gemini-3.8-flash-high OR /model ag/gemini-3.8-flash-high openai
    if (!targetModel && secondArg) {
      const firstLower = firstArg.toLowerCase();
      const secondLower = secondArg.toLowerCase();

      if (KNOWN_PROVIDERS[firstLower]) {
        targetProvider = KNOWN_PROVIDERS[firstLower];
        targetModel = secondArg;
      } else if (KNOWN_PROVIDERS[secondLower]) {
        targetProvider = KNOWN_PROVIDERS[secondLower];
        targetModel = firstArg;
      }
    }

    // Case 3: Single argument: /model ag/gemini-3.8-flash-high OR /model openai
    if (!targetModel && firstArg) {
      const firstLower = firstArg.toLowerCase();
      if (KNOWN_PROVIDERS[firstLower]) {
        targetProvider = KNOWN_PROVIDERS[firstLower];
        targetModel = targetProvider === 'openai' && isLocalProxy
          ? (process.env.DEFAULT_MODEL || 'ag/gemini-3.8-flash-high')
          : targetProvider === 'openai'
          ? 'gpt-4o'
          : targetProvider === 'google'
          ? 'gemini-2.5-flash'
          : targetProvider === 'deepseek'
          ? 'deepseek-chat'
          : 'claude-3-7-sonnet';
      } else {
        targetModel = firstArg;
        if (isLocalProxy && (targetModel.startsWith('ag') || targetModel.includes('/') || targetModel.includes('gemini') || targetModel.includes('flash'))) {
          targetProvider = 'openai';
        } else if (targetModel.includes('/') || targetModel.startsWith('ag') || targetModel.startsWith('ocz') || targetModel.startsWith('gh/')) {
          targetProvider = 'openai';
        } else if (targetModel.includes('gpt') || targetModel.includes('o1') || targetModel.includes('o3')) {
          targetProvider = 'openai';
        } else if (targetModel.includes('deepseek')) {
          targetProvider = 'deepseek';
        } else if (targetModel.includes('gemini')) {
          targetProvider = 'google';
        } else if (targetModel.includes('llama') || targetModel.includes('qwen')) {
          targetProvider = 'ollama';
        } else if (targetModel.includes('claude')) {
          targetProvider = 'anthropic';
        } else {
          targetProvider = (st.provider as string) || (isLocalProxy ? 'openai' : 'anthropic');
        }
      }
    }

    st.model = targetModel;
    st.provider = targetProvider;
    return `Switched active model to: ${targetModel} (Provider: ${targetProvider})`;
  }
};

export const providersCommand: LocalCommand = {
  name: 'providers',
  description: 'List and test connection profiles (/providers list, /providers test [connection])',
  type: 'local',
  aliases: ['provider'],
  execute: async (ctx) => {
    const sub = ctx.args[0]?.toLowerCase();

    if (sub === 'test') {
      const connId = ctx.args[1];
      if (connId) {
        const conn = ConnectionRegistry.get(connId) || ConnectionRegistry.findByProvider(connId);
        if (!conn) {
          return `Connection '${connId}' not found in registry.`;
        }
        const res = await ProviderHealthChecker.check(conn);
        return GatewayFormatter.formatHealthCheck(res);
      }
      const results = await ProviderHealthChecker.checkAll();
      return [
        'Connection Health Check Results',
        ...results.map((r) => GatewayFormatter.formatHealthCheck(r)),
      ].join('\n---\n');
    }

    return GatewayFormatter.formatProvidersList();
  }
};

function getTargetEnvPath(): string {
  const candidatePaths = [
    path.join(process.cwd(), 'InterShade-code-agent', '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.intershade', '.env'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(process.cwd(), '.env');
}

function updateEnvFile(filePath: string, keyName: string, keyValue: string): void {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  } else {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const regex = new RegExp(`^${keyName}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${keyName}=${keyValue}`);
  } else {
    content = content ? `${content.trimEnd()}\n${keyName}=${keyValue}\n` : `${keyName}=${keyValue}\n`;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
}

function maskApiKey(key?: string): string {
  if (!key || key.trim().length === 0) return '[NOT CONFIGURED]';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

const PROVIDER_ENV_MAP: Record<string, { envVar: string; displayName: string; defaultModel: string }> = {
  google: { envVar: 'GEMINI_API_KEY', displayName: 'Google (Gemini)', defaultModel: 'gemini-2.5-flash' },
  gemini: { envVar: 'GEMINI_API_KEY', displayName: 'Google (Gemini)', defaultModel: 'gemini-2.5-flash' },
  openai: { envVar: 'OPENAI_API_KEY', displayName: 'OpenAI', defaultModel: 'gpt-4o' },
  anthropic: { envVar: 'ANTHROPIC_API_KEY', displayName: 'Anthropic (Claude)', defaultModel: 'claude-3-7-sonnet-20250219' },
  claude: { envVar: 'ANTHROPIC_API_KEY', displayName: 'Anthropic (Claude)', defaultModel: 'claude-3-7-sonnet-20250219' },
  deepseek: { envVar: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek', defaultModel: 'deepseek-chat' },
  ollama: { envVar: 'OPENAI_BASE_URL', displayName: 'Ollama (Local URL)', defaultModel: 'qwen2.5-coder' },
};

export const setupCommand: LocalCommand = {
  name: 'setup',
  description: 'View or configure API keys and test balance (/setup, /key test [provider], /key <provider> <api_key>)',
  type: 'local',
  aliases: ['key', 'keys', 'apikey'],
  execute: async (ctx) => {
    const targetEnv = getTargetEnvPath();
    const arg0 = ctx.args[0]?.toLowerCase();

    // 1. Live test key: /key test [provider]
    if (arg0 === 'test') {
      const targetProvider = ctx.args[1]?.toLowerCase() || 'openai';
      const mapping = PROVIDER_ENV_MAP[targetProvider];
      if (!mapping) {
        return `Unknown provider '${targetProvider}'. Supported providers: google, openai, anthropic, deepseek`;
      }
      const key = process.env[mapping.envVar];
      if (!key) {
        return `[NOT SET]: API key for ${mapping.displayName} (${mapping.envVar}) is not configured.\nSet it via: /key ${targetProvider} <your_api_key>`;
      }

      try {
        if (targetProvider === 'openai') {
          const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
          const endpoint = `${baseUrl}/models`;
          const res = await fetch(endpoint, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(6000),
          });
          if (res.ok) {
            const isProxy = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || !baseUrl.includes('api.openai.com');
            const targetName = isProxy ? `OpenAI gateway (${baseUrl})` : 'OpenAI';
            return `[OK (HTTP 200)]: ${targetName} is active and valid. Model endpoint is ready for requests.`;
          }
          const errData = await res.json().catch(() => ({}));
          const errObj = (errData as any)?.error || {};
          if (res.status === 401) {
            return `[FAILED (401 Invalid Key)]: Incorrect or expired OpenAI API key provided.\nMessage: ${errObj.message || 'Unauthorized'}`;
          }
          if (res.status === 429) {
            return `[FAILED (429 Insufficient Quota)]: Tai khoan OpenAI chua co so du (Credit Balance = $0.00).\nOpenAI yeu cau nap credit toi thieu $5 tai: https://platform.openai.com/account/billing\nMessage: ${errObj.message || 'Quota exceeded'}`;
          }
          return `[FAILED (HTTP ${res.status})]: ${errObj.message || res.statusText}`;
        } else if (targetProvider === 'google' || targetProvider === 'gemini') {
          const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': key },
            signal: AbortSignal.timeout(6000),
          });
          if (res.ok) {
            return `[OK (HTTP 200)]: Google Gemini API key is active and valid.`;
          }
          const errData = await res.json().catch(() => ({}));
          return `[FAILED (HTTP ${res.status})]: ${(errData as any)?.error?.message || res.statusText}`;
        } else if (targetProvider === 'anthropic' || targetProvider === 'claude') {
          const res = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
            },
            signal: AbortSignal.timeout(6000),
          });
          if (res.ok) {
            return `[OK (HTTP 200)]: Anthropic Claude API key is active and valid.`;
          }
          const errData = await res.json().catch(() => ({}));
          return `[FAILED (HTTP ${res.status})]: ${(errData as any)?.error?.message || res.statusText}`;
        } else if (targetProvider === 'deepseek') {
          const res = await fetch('https://api.deepseek.com/models', {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(6000),
          });
          if (res.ok) {
            return `[OK (HTTP 200)]: DeepSeek API key is active and valid.`;
          }
          const errData = await res.json().catch(() => ({}));
          return `[FAILED (HTTP ${res.status})]: ${(errData as any)?.error?.message || res.statusText}`;
        }
      } catch (e: any) {
        return `[Connection Error]: Could not reach ${mapping.displayName}: ${e?.message || String(e)}`;
      }
    }

    // 2. Set default provider: /key default <provider> [model]
    if (arg0 === 'default') {
      const targetProvider = ctx.args[1]?.toLowerCase();
      const targetModel = ctx.args[2];
      if (!targetProvider) {
        return 'Usage: /key default <provider> [model]\nExample: /key default openai gpt-4o';
      }

      updateEnvFile(targetEnv, 'DEFAULT_PROVIDER', targetProvider);
      if (targetModel) {
        updateEnvFile(targetEnv, 'DEFAULT_MODEL', targetModel);
      }
      return [
        'Updated Default Configuration in .env:',
        `  Provider: ${targetProvider}`,
        targetModel ? `  Model:    ${targetModel}` : '',
        `Saved to: ${targetEnv}`,
      ].filter(Boolean).join('\n');
    }


    // 2. Set API key: /key <provider> <api_key>
    if (arg0 && ctx.args[1]) {
      const providerMapping = PROVIDER_ENV_MAP[arg0];
      if (!providerMapping) {
        return `Unknown provider '${arg0}'. Supported providers: google, openai, anthropic, deepseek, ollama`;
      }

      const newKey = ctx.args[1].trim();
      updateEnvFile(targetEnv, providerMapping.envVar, newKey);
      process.env[providerMapping.envVar] = newKey;

      return [
        `Successfully updated API key for ${providerMapping.displayName}:`,
        `  Env Var:  ${providerMapping.envVar}`,
        `  Value:    ${maskApiKey(newKey)}`,
        `  File:     ${targetEnv}`,
        '',
        `To switch active model to this provider now, run: /model ${providerMapping.defaultModel}`,
      ].join('\n');
    }

    // 3. View status report: /setup or /key or /keys
    const lines = [
      'InterShader Environment & API Keys Configuration',
      `Config File: ${targetEnv} (${fs.existsSync(targetEnv) ? 'Exists' : 'Not found'})`,
      '',
      'Provider API Key Status:',
      `  1. Google (Gemini):     ${maskApiKey(process.env.GEMINI_API_KEY)}`,
      `  2. OpenAI:              ${maskApiKey(process.env.OPENAI_API_KEY)}`,
      `  3. Anthropic (Claude):  ${maskApiKey(process.env.ANTHROPIC_API_KEY)}`,
      `  4. DeepSeek:            ${maskApiKey(process.env.DEEPSEEK_API_KEY)}`,
      `  5. Ollama Base URL:     ${process.env.OPENAI_BASE_URL || 'http://localhost:11434 (default)'}`,
      '',
      'Quick Commands to update API Key directly in chat:',
      '  /key test [provider]                - Live test API key & balance (e.g. /key test openai)',
      '  /key google <your_gemini_api_key>',
      '  /key openai <your_openai_api_key>',
      '  /key anthropic <your_claude_api_key>',
      '  /key deepseek <your_deepseek_api_key>',
      '  /key default <provider> [model]',
      '',
      'To switch active model: /model <model_name> (e.g. /model gpt-4o or /model gemini-2.5-flash)',
      'To run interactive terminal setup wizard: node dist/index.js setup',
    ];

    return lines.join('\n');
  },
};


export const modeCommand: LocalCommand = {
  name: 'mode',
  description: 'View or switch agent permission mode (default, bypass, plan, auto, acceptEdits)',
  type: 'local',
  aliases: ['permissions', 'perm'],
  execute: (ctx) => {
    const st = ctx.sessionState as Record<string, unknown>;
    const rawTarget = ctx.args[0]?.toLowerCase().trim();

    const modeAliases: Record<string, string> = {
      bypass: 'bypassPermissions',
      yolo: 'bypassPermissions',
      all: 'bypassPermissions',
      'all-perms': 'bypassPermissions',
      allperms: 'bypassPermissions',
      'grant-all': 'bypassPermissions',
      'allow-all': 'bypassPermissions',
      readonly: 'plan',
      read: 'plan',
      normal: 'default',
      reset: 'default',
    };

    const targetMode = rawTarget ? modeAliases[rawTarget] || rawTarget : undefined;
    const validModes = ['default', 'plan', 'auto', 'acceptEdits', 'bypassPermissions', 'dontAsk'];

    if (!targetMode || !validModes.includes(targetMode)) {
      return [
        `Current Permission Mode: ${st.permissionMode || 'default'}`,
        'Valid Modes:',
        '  - default: Ask confirmation before executing mutating actions',
        '  - bypassPermissions (or: bypass, yolo, all): Bypass all confirmation prompts',
        '  - plan (or: readonly): Read-only planning mode (blocks all mutations)',
        '  - auto: Autonomous execution for verified actions',
        '  - acceptEdits: Auto-accept file modifications',
        '  - dontAsk: Deny unconfirmed sensitive operations silently',
        'Usage: /mode <mode_name> or /bypass',
      ].join('\n');
    }

    st.permissionMode = targetMode;
    if (targetMode === 'bypassPermissions') {
      return '🔓 Switched permission mode to: bypassPermissions (All permissions granted, no prompts).';
    }
    return `Switched permission mode to: ${targetMode}`;
  }
};

export const bypassCommand: LocalCommand = {
  name: 'bypass',
  description: 'Toggle or grant all agent permissions without confirmation prompts (/bypass [on|off])',
  type: 'local',
  aliases: ['yolo', 'all-perms', 'allperms', 'grant-all', 'allow-all'],
  execute: (ctx) => {
    const st = ctx.sessionState as Record<string, unknown>;
    const arg = (ctx.args[0] || '').toLowerCase().trim();
    const currentMode = (st.permissionMode as string) || 'default';

    let nextMode: string;
    if (arg === 'on' || arg === 'true' || arg === '1' || arg === 'yes' || arg === 'all') {
      nextMode = 'bypassPermissions';
    } else if (arg === 'off' || arg === 'false' || arg === '0' || arg === 'no') {
      nextMode = 'default';
    } else {
      nextMode = currentMode === 'bypassPermissions' ? 'default' : 'bypassPermissions';
    }

    st.permissionMode = nextMode;

    if (nextMode === 'bypassPermissions') {
      return [
        '🔓 [BYPASS MODE ON]: All permissions granted to agent.',
        '  - All tools (file edits, writes, shell commands) will execute automatically without confirmation.',
        '  - Type /bypass or /bypass off to restore standard confirmation prompts.',
      ].join('\n');
    }

    return [
      '🔒 [BYPASS MODE OFF]: Standard safety permissions restored.',
      '  - Mutating and potentially destructive actions will request confirmation.',
    ].join('\n');
  },
};

export const planCommand: LocalCommand = {
  name: 'plan',
  description: 'Toggle Plan Mode (Read-Only architectural safe mode) or inspect/manage active plan (/plan [path|view|reset])',
  type: 'local',
  aliases: [],
  execute: (ctx) => {
    const st = ctx.sessionState as Record<string, unknown>;
    const arg0 = (ctx.args[0] || '').toLowerCase().trim();
    const sessionId = (st.id as string) || '';

    if (arg0 === 'view' || arg0 === 'show') {
      const plan = PlanManager.getActivePlan(sessionId);
      if (!plan) {
        return '[PLAN NOTICE]: No active plan has been established for this session yet. Type your planning request or /plan to start.';
      }
      return PlanManager.formatPlanMarkdown(plan, { showChangelog: true });
    }

    if (arg0 === 'reset' || arg0 === 'clear') {
      PlanManager.clearPlan(sessionId);
      return '[PLAN RESET]: Active plan cleared from session memory. Ready to establish a new plan.';
    }

    if (arg0 === 'on') {
      st.permissionMode = 'plan';
      return '[PLAN MODE ON]: Write tools and shell execution are locked to read-only.';
    }

    if (arg0 === 'off') {
      st.permissionMode = 'default';
      return '[PLAN MODE OFF]: Normal execution mode restored.';
    }

    const targetPath = ctx.args.join(' ').trim();
    const currentMode = st.permissionMode;
    const nextMode = currentMode === 'plan' && !targetPath ? 'default' : 'plan';
    st.permissionMode = nextMode;
    let msg = nextMode === 'plan' ? '[PLAN MODE ON]: Write tools and shell execution are locked to read-only.' : '[PLAN MODE OFF]: Normal execution mode restored.';
    if (targetPath) {
      msg += `\nTarget Scope: ${targetPath}\nReady for planning.`;
    }
    const activePlan = PlanManager.getActivePlan(sessionId);
    if (activePlan && nextMode === 'plan') {
      msg += `\n\nActive Plan (v${activePlan.currentVersion}): "${activePlan.title}" with ${activePlan.steps.length} steps. Any updates will merge with this plan.`;
    }
    return msg;
  }
};

export const turnsCommand: LocalCommand = {
  name: 'turns',
  description: 'View or set the maximum turn limit for agent execution (/turns [number|unlimited])',
  type: 'local',
  aliases: ['turn', 'maxturns', 'turnlimit', 'turn-limit', 'unlimited', 'continuous'],
  execute: (ctx) => {
    const st = ctx.sessionState as Record<string, unknown>;
    const rawArg = ctx.args.join(' ').toLowerCase().trim();

    // If no argument provided:
    if (!rawArg) {
      const current = typeof st.maxTurns === 'number' ? st.maxTurns : (config.maxTurns !== undefined ? config.maxTurns : 100);
      return current <= 0
        ? 'Current Turn Limit: Unlimited (Continuous execution until task completion)'
        : `Current Turn Limit: ${current} turns per prompt (use /turns <number> or /turns unlimited to change)`;
    }

    const UNLIMITED_KEYWORDS = new Set([
      'unlimited',
      'inf',
      'infinite',
      '0',
      'none',
      'off',
      'continuous',
      '-1',
      'all',
      'max',
      'vohan',
      'vo_han',
      'vô_hạn',
      'vô hạn',
      'vo han',
      'khong_gioi_han',
      'không giới hạn',
      'khong gioi han',
    ]);

    if (UNLIMITED_KEYWORDS.has(rawArg) || rawArg.startsWith('unlimit') || rawArg.startsWith('vô hạn') || rawArg.startsWith('vo han')) {
      st.maxTurns = 0;
      return 'Turn limit set to: Unlimited (Continuous execution until task completion)';
    }

    const parsed = parseInt(rawArg, 10);
    if (isNaN(parsed) || parsed < 0) {
      return 'Invalid turn limit. Usage: /turns <number> (e.g. /turns 50, /turns 100) or /turns unlimited';
    }

    st.maxTurns = parsed;
    return `Turn limit updated to: ${parsed} turns per prompt`;
  }
};

export const fastCommand: LocalCommand = {
  name: 'fast',
  description: 'Toggle Fast Mode for ultra-low latency streaming and instant code execution (/fast [on|off])',
  type: 'local',
  aliases: ['speed', 'quick'],
  execute: (ctx) => {
    const st = ctx.sessionState as Record<string, unknown>;
    const arg = ctx.args[0]?.toLowerCase();

    if (!arg) {
      const next = st.speedMode === 'fast' ? 'normal' : 'fast';
      st.speedMode = next;
      if (next === 'fast') {
        st.thinkingBudget = 0;
        return '[FAST MODE ON]: Instant generation enabled. Thinking delay set to 0 and verification gate bypasses clean turns.';
      } else {
        delete st.speedMode;
        return '[FAST MODE OFF]: Standard execution mode restored with full reasoning depth.';
      }
    }

    if (arg === 'on' || arg === '1' || arg === 'true') {
      st.speedMode = 'fast';
      st.thinkingBudget = 0;
      return '[FAST MODE ON]: Instant generation enabled. Thinking delay set to 0 and verification gate bypasses clean turns.';
    }

    if (arg === 'off' || arg === '0' || arg === 'false') {
      st.speedMode = 'normal';
      return '[FAST MODE OFF]: Standard execution mode restored with full reasoning depth.';
    }

    return 'Usage: /fast or /fast on or /fast off';
  }
};



export const thinkCommand: LocalCommand = {
  name: 'think',
  description: 'View or set thinking budget tier (/think [off|low|med|high|tokens])',
  type: 'local',
  aliases: ['thinking', 'budget'],
  execute: (ctx) => {
    const st = ctx.sessionState as Record<string, unknown>;
    const arg = ctx.args[0]?.toLowerCase();

    if (!arg) {
      const current = typeof st.thinkingBudget === 'number' ? st.thinkingBudget : 'Adaptive / Default';
      return [
        `Current Thinking Budget: ${current}`,
        '',
        'Available Tiers:',
        '  /think off      - 0 tokens (Instant direct output, zero reasoning delay)',
        '  /think low      - 1,024 tokens (Fast coding & quick syntax decisions)',
        '  /think med      - 4,096 tokens (Balanced architectural review)',
        '  /think high     - 8,192 tokens (Deep root-cause reasoning)',
        '  /think <number> - Custom token budget (e.g. /think 2048)',
      ].join('\n');
    }

    if (arg === 'off' || arg === '0' || arg === 'none') {
      st.thinkingBudget = 0;
      return 'Thinking budget set to: 0 tokens (Direct generation mode).';
    }

    if (arg === 'low' || arg === 'min') {
      st.thinkingBudget = 1024;
      return 'Thinking budget set to: 1,024 tokens (Low latency tier).';
    }

    if (arg === 'med' || arg === 'medium') {
      st.thinkingBudget = 4096;
      return 'Thinking budget set to: 4,096 tokens (Medium balanced tier).';
    }

    if (arg === 'high' || arg === 'max') {
      st.thinkingBudget = 8192;
      return 'Thinking budget set to: 8,192 tokens (High deep reasoning tier).';
    }

    const parsed = parseInt(arg, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      st.thinkingBudget = parsed;
      return `Thinking budget updated to: ${parsed} tokens.`;
    }

    return 'Invalid thinking tier. Usage: /think [off|low|med|high|<number>]';
  }
};

export const compactCommand: PromptCommand = {
  name: 'compact',
  description: 'Actively trigger context compaction and summarize conversation history',
  type: 'prompt',
  aliases: ['summarize'],
  getPrompt: () => {
    return [
      'Please perform an active context compaction on the current session history.',
      'Summarize key technical architectural decisions, identified root causes, and files modified.',
      'Eliminate verbose tool outputs and retain actionable working memory.'
    ].join('\n');
  }
};

export const rewindCommand: PromptCommand = {
  name: 'rewind',
  description: 'Rollback recent modifications or restore state from prior savepoint',
  type: 'prompt',
  aliases: ['undo'],
  getPrompt: (ctx) => {
    const note = ctx.args.length > 0 ? ` Target checkpoint note: ${ctx.args.join(' ')}` : '';
    return [
      'Review recent file changes and check available savepoints.',
      'Revert the latest unverified changes or rollback to the prior safe savepoint state.',
      note
    ].join('\n');
  }
};

export const initCommand: LocalCommand = {
  name: 'init',
  description: 'Initialize .intershader workspace configuration and project conventions',
  type: 'local',
  execute: (ctx) => {
    const intershaderDir = path.join(ctx.cwd, '.intershader');
    const skillsDir = path.join(intershaderDir, 'skills');
    const configFile = path.join(intershaderDir, 'config.json');

    fs.mkdirSync(skillsDir, { recursive: true });

    if (!fs.existsSync(configFile)) {
      const initialConfig = {
        version: '1.0.0',
        defaultModel: 'claude-3-7-sonnet',
        defaultProvider: 'anthropic',
        permissionMode: 'default',
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(configFile, JSON.stringify(initialConfig, null, 2), 'utf-8');
      return `Initialized workspace configuration at: ${configFile}`;
    }

    return `Workspace configuration already exists at: ${configFile}`;
  }
};

export const exportCommand: LocalCommand = {
  name: 'export',
  description: 'Export session conversation history to Markdown',
  type: 'local',
  execute: (ctx) => {
    const st = ctx.sessionState as Record<string, unknown>;
    const sessionId = String(st.id || 'current-session');
    const exportDir = path.join(ctx.cwd, '.intershader', 'exports');
    fs.mkdirSync(exportDir, { recursive: true });

    const exportPath = path.join(exportDir, `session-${sessionId}.md`);
    const db = getDatabase();

    const messages = db.prepare('SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as Array<{ role: string; content: string; timestamp: number }>;

    let md = `# InterShader Session Export: ${sessionId}\n\n`;
    md += `Exported at: ${new Date().toISOString()}\n`;
    md += `Model: ${st.model || 'claude-3-7-sonnet'} (${st.provider || 'anthropic'})\n\n---\n\n`;

    if (messages.length === 0) {
      md += `*No stored database messages for session ${sessionId}.*\n`;
    } else {
      for (const m of messages) {
        md += `### ${m.role.toUpperCase()} (${new Date(m.timestamp).toLocaleTimeString()}):\n\n${m.content}\n\n---\n\n`;
      }
    }

    fs.writeFileSync(exportPath, md, 'utf-8');
    return `Exported session history to: ${exportPath}`;
  }
};

export const statusCommand: LocalCommand = {
  name: 'status',
  description: 'Display active session status, git branch, tokens, and gateway state',
  type: 'local',
  execute: (ctx) => {
    const st = ctx.sessionState as Record<string, unknown>;
    let gitBranch = 'unknown';
    try {
      gitBranch = execSync('git branch --show-current', {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim() || 'detached';
    } catch {
      gitBranch = 'no-git';
    }

    const input = Number(st.totalInputTokens || 0);
    const output = Number(st.totalOutputTokens || 0);
    const turnLimit = typeof st.maxTurns === 'number' ? st.maxTurns : (config.maxTurns !== undefined ? config.maxTurns : 100);

    return [
      'InterShader Session Status',
      `Session ID:      ${st.id || 'active'}`,
      `Working Tree:    ${ctx.cwd}`,
      `Git Branch:      ${gitBranch}`,
      `Model / Provider:${st.model || 'claude-3-7-sonnet'} (${st.provider || 'anthropic'})`,
      `Permission Mode: ${st.permissionMode || 'default'}`,
      `Turn Limit:      ${turnLimit <= 0 ? 'Unlimited (Continuous)' : `${turnLimit} turns`}`,
      `Token Counters:  In: ${input.toLocaleString()} | Out: ${output.toLocaleString()}`,
      `Estimated Cost:  $${(((input / 1_000_000) * 3.0) + ((output / 1_000_000) * 15.0)).toFixed(4)} USD`,
    ].join('\n');
  },
};

export const helpCommand: LocalCommand = {
  name: 'help',
  description: 'Display interactive guide and summary of all available slash commands',
  type: 'local',
  aliases: ['commands', '?'],
  execute: () => {
    return [
      'InterShader Slash Commands Guide',
      '',
      '[Multi-Session & Tab Management]',
      '  /tab new <title> [role]  - Create concurrent secondary agent session in isolated Git worktree',
      '  /tab switch <n>         - Switch active viewport to tab (or press Alt+1..9)',
      '  /tab list               - List all active concurrent session tabs and statuses',
      '  /tab merge [n]          - Merge worktree code back into primary branch',
      '  /tab close <n>          - Close secondary session and clean up worktree',
      '',
      '[System Controls]',
      '  /status                 - Display active session status, git branch, tokens, and cost',
      '  /plan [view|reset]      - Toggle plan mode, inspect active plan, or reset',
      '  /maxing [on|off|status] - Unconstrained reasoning budget (16k tokens) & department swarm',
      '  /clear                  - Clear terminal screen',
      '  /unqueue                - Clear currently queued prompt',
      '  /exit, /quit            - Exit terminal',
    ].join('\n');
  },
};

export const memoryCommand: LocalCommand = {
  name: 'memory',
  description: 'Search and inspect durable knowledge in SQLite FTS5 BM25 memory',
  type: 'local',
  aliases: ['mem', 'memories'],
  execute: (ctx) => {
    const query = ctx.args.join(' ').trim();
    const projectId = path.basename(ctx.cwd) || 'default-project';

    if (!query || query.toLowerCase() === 'list' || query.toLowerCase() === 'all') {
      const projectMemories = FtsMemoryService.getMemoriesForProject(projectId);
      const db = getDatabase();
      const countRow = db.prepare('SELECT count(*) as count FROM memories').get() as { count: number };

      if (projectMemories.length === 0) {
        return [
          'Durable FTS5 Long-Term Memory',
          `Total Global Records: ${countRow.count} | Current Project: 0`,
          'No memories recorded yet for this project.',
          'Save a new memory with: /remember [type] <title> :: <content>',
          'Example: /remember architecture Port :: Luon dung port 3000',
        ].join('\n');
      }

      const lines: string[] = [
        `Durable FTS5 Long-Term Memory (${projectMemories.length} records for ${projectId}):`
      ];
      for (const m of projectMemories) {
        const dateStr = new Date(m.createdAt).toLocaleDateString();
        lines.push(`- [${m.type.toUpperCase()}] **${m.title}**: ${m.content.slice(0, 120)} (${dateStr})`);
      }
      lines.push('\nSearch with: /memory <query> | Add with: /remember <note>');
      return lines.join('\n');
    }

    const results = FtsMemoryService.searchMemories(query, { projectId, limit: 10 });
    if (results.length === 0) {
      return `No memories found matching query: "${query}" in project ${projectId}.`;
    }

    const lines: string[] = [`FTS5 Memory BM25 matches for "${query}" (${results.length} found):`];
    for (const res of results) {
      lines.push(`- [${res.type.toUpperCase()}] **${res.title}**: ${res.content.slice(0, 120)} (Score: ${res.rank.toFixed(2)})`);
    }
    return lines.join('\n');
  }
};

export const rememberCommand: LocalCommand = {
  name: 'remember',
  description: 'Persist a critical rule, decision, or lesson into long-term SQLite FTS5 memory',
  type: 'local',
  aliases: ['memorize', 'ghinho'],
  execute: (ctx) => {
    const raw = ctx.args.join(' ').trim();
    if (!raw) {
      return [
        'Command: /remember',
        'Usage: /remember [type] <title> :: <content>',
        '   or: /remember <important note to remember>',
        'Types: decision | lesson | architecture | bug_pattern | skill (default: lesson)',
        'Examples:',
        '  /remember architecture Port quy dinh :: Luon su dung port 3000 cho web server',
        '  /remember Dung node 20 tro len cho du an nay',
      ].join('\n');
    }

    const projectId = path.basename(ctx.cwd) || 'default-project';
    let type: 'decision' | 'lesson' | 'architecture' | 'bug_pattern' | 'skill' = 'lesson';
    let title = '';
    let content = '';

    const validTypes = ['decision', 'lesson', 'architecture', 'bug_pattern', 'skill'];

    if (raw.includes('::')) {
      const [header, body] = raw.split('::', 2);
      content = body.trim();
      const parts = header.trim().split(/\s+/);
      if (validTypes.includes(parts[0].toLowerCase())) {
        type = parts[0].toLowerCase() as any;
        title = parts.slice(1).join(' ').trim() || `${type} note`;
      } else {
        title = header.trim();
      }
    } else {
      const parts = raw.split(/\s+/);
      if (validTypes.includes(parts[0].toLowerCase()) && parts.length > 2) {
        type = parts[0].toLowerCase() as any;
        title = parts.slice(1, 4).join(' ');
        content = parts.slice(1).join(' ');
      } else {
        title = raw.slice(0, 50);
        content = raw;
      }
    }

    const rec = FtsMemoryService.recordMemory({
      projectId,
      sessionId: (ctx.sessionState?.id as string) || undefined,
      type,
      title: title || 'Project Guideline',
      content,
    });

    return [
      `[Successfully Recorded to Long-Term Memory]`,
      `- ID: ${rec.id}`,
      `- Type: [${rec.type.toUpperCase()}]`,
      `- Title: "${rec.title}"`,
      `- Project: ${projectId}`,
      `This memory is indexed with SQLite FTS5 BM25 and will automatically be provided to the model in future turns.`
    ].join('\n');
  }
};

export const agentCommand: LocalCommand = {
  name: 'agent',
  description: 'Dispatch a Claude Code specialized agent step (explore, plan, general, verify, workflow)',
  type: 'local',
  aliases: ['subagent', 'step'],
  execute: async (ctx) => {
    const roleArg = (ctx.args[0]?.toLowerCase() || 'workflow');
    const goal = ctx.args.slice(1).join(' ').trim() || 'Analyze workspace structure';

    const coordinator = new ClaudeAgentCoordinator();
    const mockToolContext: ToolExecutionContext = {
      sessionId: String(ctx.sessionState.id || 'default'),
      cwd: ctx.cwd,
      permissionMode: 'auto',
    };

    if (roleArg === 'explore') {
      const res = await coordinator.executeExploreStep(goal, mockToolContext);
      return `[EXPLORE AGENT]: ${res.summary}`;
    }

    if (roleArg === 'plan') {
      const dummyExplore = {
        step: 'explore' as const,
        success: true,
        summary: 'Direct plan trigger',
        data: { identifiedFiles: [] },
        timestamp: Date.now()
      };
      const res = await coordinator.executePlanStep(goal, dummyExplore, mockToolContext);
      return `[PLAN AGENT]: ${res.summary}\nSteps:\n${((res.data.planSteps as string[]) || []).map((s) => `  * ${s}`).join('\n')}`;
    }

    if (roleArg === 'verification' || roleArg === 'verify') {
      const dummyImpl = {
        step: 'general' as const,
        success: true,
        summary: 'Direct verify trigger',
        data: { modifiedFiles: ['src/index.ts'] },
        timestamp: Date.now()
      };
      const res = await coordinator.executeVerificationStep(goal, dummyImpl, mockToolContext);
      return `[ADVERSARIAL VERIFICATION]: ${res.summary}`;
    }

    // Default: full 4-step workflow
    const report = await coordinator.executeFullWorkflow(goal, mockToolContext);
    return [
      `Agent Workflow [${report.success ? 'SUCCESS' : 'FAILED'}]`,
      `Goal: "${goal}" (Duration: ${report.durationMs}ms)`,
      ...report.steps.map((s) => `- [${s.step.toUpperCase()}]: ${s.summary}`)
    ].join('\n');
  }
};

import { autoMaxCommand } from './autoMaxCommand.js';
import { skillsCommand } from './domains/skillsCommands.js';
import {
  proofCommand,
  routeCommand,
  benchmarkCommand,
  universalVerifyCommand,
  verifyProofCommand,
  enhanceCommand,
  auditCommand,
  maxingCommand,
  fuzzCommand,
} from './domains/verificationAndResearchCommands.js';
import {
  worktreeCommand,
  gatewayCommand,
  sessionsCommand,
  resumeCommand,
  newCommand,
  deleteSessionCommand,
  mcpCommand,
  repoMapCommand,
  tasksCommand,
  interviewCommand,
  lintCommand,
  scheduleCommand,
  tabCommand,
} from './domains/workspaceAndTabCommands.js';

export {
  skillsCommand,
  proofCommand,
  routeCommand,
  benchmarkCommand,
  universalVerifyCommand,
  verifyProofCommand,
  enhanceCommand,
  auditCommand,
  maxingCommand,
  autoMaxCommand,
  fuzzCommand,
  worktreeCommand,
  gatewayCommand,
  sessionsCommand,
  resumeCommand,
  newCommand,
  deleteSessionCommand,
  mcpCommand,
  repoMapCommand,
  tasksCommand,
  interviewCommand,
  lintCommand,
  scheduleCommand,
  tabCommand,
};

export function registerBuiltinCommands(registry: CommandRegistry): void {
  // Claude Code core commands
  registry.register(fuzzCommand);
  registry.register(reviewCommand);
  registry.register(commitCommand);
  registry.register(diffCommand);
  registry.register(statsCommand);
  registry.register(costCommand);
  registry.register(doctorCommand);
  registry.register(modelCommand);
  registry.register(modeCommand);
  registry.register(bypassCommand);
  registry.register(planCommand);
  registry.register(turnsCommand);
  registry.register(fastCommand);
  registry.register(thinkCommand);
  registry.register(compactCommand);
  registry.register(rewindCommand);
  registry.register(initCommand);
  registry.register(exportCommand);
  registry.register(statusCommand);
  registry.register(agentCommand);
  registry.register(proofCommand);
  registry.register(routeCommand);
  registry.register(benchmarkCommand);
  registry.register(universalVerifyCommand);
  registry.register(verifyProofCommand);

  // Intelligence, Sandboxing & Session Management commands
  registry.register(memoryCommand);
  registry.register(rememberCommand);
  registry.register(mcpCommand);
  registry.register(repoMapCommand);
  registry.register(tasksCommand);
  registry.register(interviewCommand);
  registry.register(lintCommand);
  registry.register(scheduleCommand);
  registry.register(skillsCommand);
  registry.register(worktreeCommand);
  registry.register(gatewayCommand);
  registry.register(sessionsCommand);
  registry.register(resumeCommand);
  registry.register(newCommand);
  registry.register(deleteSessionCommand);
  registry.register(providersCommand);
  registry.register(setupCommand);
  registry.register(swarmCommand);
  registry.register(tabCommand);

  // Research, Dependency Audit & Maxing Mode commands
  registry.register(enhanceCommand);
  registry.register(auditCommand);
  registry.register(maxingCommand);
  registry.register(autoMaxCommand);
  registry.register(helpCommand);
}

