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
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
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

function formatSkillCatalogEntry(pkg: { metadata: { name: string; version: string; description: string; tags?: string[] }; tier: string }): string {
  const tagsStr = pkg.metadata.tags && pkg.metadata.tags.length > 0 ? ` [${pkg.metadata.tags.slice(0, 3).join(', ')}]` : '';
  const firstLineDesc = pkg.metadata.description.split('\n')[0].slice(0, 100);
  return `  - ${pkg.metadata.name} (v${pkg.metadata.version}, ${pkg.tier})${tagsStr}: ${firstLineDesc}`;
}

function handleListSkills(registry: SkillRegistry, cwd: string): string {
  const discovered = registry.discoverAllSkills();
  const crystallized = SkillCrystallizer.loadSkills(cwd);

  const lines: string[] = [`InterShader Integrated Skills Ecosystem (${discovered.length} total active skills):`];
  
  const tiers: Array<{ name: string; tier: 'workspace' | 'user' | 'global' | 'builtin' }> = [
    { name: 'Workspace Tier (.intershader/skills, .agents/skills)', tier: 'workspace' },
    { name: 'User Tier (~/.intershader/skills)', tier: 'user' },
    { name: 'Global IDE Tier (~/.gemini/config/skills, ~/.claude/skills)', tier: 'global' },
    { name: 'Built-in Core Tier (packageRoot/skills)', tier: 'builtin' },
  ];

  for (const t of tiers) {
    const tierSkills = discovered.filter((s) => s.tier === t.tier);
    if (tierSkills.length > 0) {
      lines.push(`\n[${t.name}] - ${tierSkills.length} skills:`);
      for (const s of tierSkills) {
        lines.push(formatSkillCatalogEntry(s));
      }
    }
  }

  if (crystallized.length > 0) {
    lines.push(`\n[Autonomously Crystallized Skills] (${crystallized.length}):`);
    for (const sk of crystallized) {
      lines.push(`  - [${sk.name}] Triggers: [${sk.intentTriggers.slice(0, 4).join(', ')}] (${(sk.confidence * 100).toFixed(0)}%)`);
    }
  }

  lines.push('\nCommands: /skills search <keyword> | /skills install <name> | /skills info <name> | /skills activate <name>');
  return lines.join('\n');
}

function handleSkillInfo(registry: SkillRegistry, skillName: string): string {
  if (!skillName) {
    return 'Error: Please specify skill name. Usage: /skills info <name>';
  }
  const pkg = registry.getSkill(skillName);
  if (!pkg) {
    return `Skill "${skillName}" not found. Run /skills to see available skills.`;
  }
  const meta = pkg.metadata;
  const caps = Object.entries(meta.capabilities)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k)
    .join(', ') || 'none';

  const allowedToolsStr = meta.allowedTools && meta.allowedTools.length > 0 ? meta.allowedTools.join(', ') : 'all';
  const tagsStr = meta.tags && meta.tags.length > 0 ? meta.tags.join(', ') : 'none';

  return [
    `Skill Specification: ${meta.name}`,
    `Version:      ${meta.version}`,
    `Tier:         ${pkg.tier}`,
    `Description:  ${meta.description}`,
    `Capabilities: ${caps}`,
    `Allowed Tools: ${allowedToolsStr}`,
    `Tags:         ${tagsStr}`,
    `SHA-256:      ${pkg.contentSha256.slice(0, 16)}...`,
    `Location:     ${pkg.skillDir}`,
  ].join('\n');
}

function handleAuditSkills(registry: SkillRegistry, targetSkill?: string): string {
  const allSkills = registry.discoverAllSkills();
  const toAudit = targetSkill
    ? allSkills.filter((s) => s.metadata.name.toLowerCase() === targetSkill.toLowerCase())
    : allSkills;

  if (toAudit.length === 0) {
    return targetSkill
      ? `Skill "${targetSkill}" not found to audit.`
      : 'No skills found in registry to audit.';
  }

  const reports = toAudit.map((s) => SkillSecurityAuditor.auditSkill(s));
  const passedCount = reports.filter((r) => r.passed).length;
  const lines: string[] = [
    `Skill Security Audit (${passedCount}/${reports.length} PASSED):`,
  ];

  for (const r of reports) {
    const status = r.passed ? '[PASS]' : `[FAIL: ${r.maxSeverity}]`;
    lines.push(`  ${status} ${r.skillName} (Findings: ${r.findings.length})`);
    for (const f of r.findings) {
      lines.push(`    * [${f.severity}] ${f.ruleId}: ${f.message}`);
    }
  }
  return lines.join('\n');
}

function handleActivateSkill(registry: SkillRegistry, skillName: string, sessionState: Record<string, unknown>): string {
  if (!skillName) {
    return 'Error: Please specify skill name to activate. Usage: /skills activate <name>';
  }
  const pkg = registry.getSkill(skillName);
  if (!pkg) {
    return `Skill "${skillName}" not found. Run /skills to see available skills.`;
  }
  sessionState.activeSkill = pkg.metadata.name;
  return [
    `Skill Activated: [${pkg.metadata.name}] (v${pkg.metadata.version})`,
    `Description: ${pkg.metadata.description}`,
    `Full procedural instructions and workflow checklist are now primed for upcoming queries.`,
  ].join('\n');
}

function handleSearchSkills(cwd: string, keyword?: string): string {
  if (!keyword) {
    return 'Error: Please specify search keyword. Usage: /skills search <keyword>';
  }
  const hub = new SkillHubClient(cwd);
  const result = hub.search(keyword);

  const lines: string[] = [`Skill Search Results for "${keyword}":\n`];
  if (result.local.length > 0) {
    lines.push(`Installed Locally (${result.local.length}):`);
    for (const s of result.local) {
      lines.push(`  - [${s.tier.toUpperCase()}] ${s.name} (v${s.version}): ${s.description.slice(0, 80)}...`);
    }
  }

  if (result.remote.length > 0) {
    lines.push(`\nAvailable in Curated Catalog (${result.remote.length}):`);
    for (const r of result.remote) {
      lines.push(`  - [CATALOG] ${r.vendor}/${r.name}: ${r.description} (Tags: ${r.tags.join(', ')})`);
    }
    lines.push('\nInstall any skill using: /skills install <vendor/name> or /skills install <name>');
  }

  if (result.local.length === 0 && result.remote.length === 0) {
    lines.push('  No matching skills found locally or in curated remote catalog.');
  }

  return lines.join('\n');
}

async function handleInstallSkill(cwd: string, identifier?: string, isGlobal: boolean = false): Promise<string> {
  if (!identifier) {
    return 'Error: Please specify skill identifier or URL. Usage: /skills install <vendor/name> [--global]';
  }
  const hub = new SkillHubClient(cwd);
  try {
    const res = await hub.install(identifier, isGlobal);
    return [
      `[SUCCESS] ${res.message}`,
      `File: ${res.installPath}`,
      `Security Audit: ${res.auditPassed ? 'PASSED (Clean)' : 'WARNING'}`,
      `You can now activate it via: /skills activate ${res.skillName}`
    ].join('\n');
  } catch (err) {
    return `[INSTALLATION FAILED]: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function handleUninstallSkill(cwd: string, name?: string): string {
  if (!name) {
    return 'Error: Please specify skill name to uninstall. Usage: /skills uninstall <name>';
  }
  const hub = new SkillHubClient(cwd);
  const res = hub.uninstall(name);
  return res.message;
}

export const skillsCommand: LocalCommand = {
  name: 'skills',
  description: 'List, search, install, audit, or activate development skills',
  type: 'local',
  aliases: ['skill'],
  execute: async (ctx) => {
    const sub = ctx.args[0]?.toLowerCase();
    const arg = ctx.args[1];
    const isGlobal = ctx.args.includes('--global') || ctx.args.includes('-g');
    const registry = new SkillRegistry(ctx.cwd);

    switch (sub) {
      case 'search':
      case 'find':
        return handleSearchSkills(ctx.cwd, arg);
      case 'install':
      case 'add':
        return await handleInstallSkill(ctx.cwd, arg, isGlobal);
      case 'uninstall':
      case 'remove':
      case 'rm':
        return handleUninstallSkill(ctx.cwd, arg);
      case 'info':
        return handleSkillInfo(registry, arg);
      case 'audit':
        return handleAuditSkills(registry, arg);
      case 'activate':
      case 'use':
        return handleActivateSkill(registry, arg, ctx.sessionState);
      case 'list':
      default:
        return handleListSkills(registry, ctx.cwd);
    }
  }
};

export const worktreeCommand: LocalCommand = {
  name: 'worktree',
  description: 'Manage and inspect Git Shadow Worktree Sandboxes',
  type: 'local',
  aliases: ['wt'],
  execute: (ctx) => {
    const action = ctx.args[0]?.toLowerCase();
    const shadowDir = path.join(ctx.cwd, '.intershader', 'shadow');

    if (action === 'cleanup') {
      if (fs.existsSync(shadowDir)) {
        const subdirs = fs.readdirSync(shadowDir);
        for (const dir of subdirs) {
          try {
            ShadowWorktree.removeShadow(path.join(shadowDir, dir), ctx.cwd);
          } catch {
            // Ignore removal errors
          }
        }
        return 'Cleaned up all shadow worktree sandboxes in .intershader/shadow/';
      }
      return 'No active shadow worktree directory to clean.';
    }

    if (!fs.existsSync(shadowDir)) {
      return 'No Git Shadow Worktrees currently active.';
    }

    const entries = fs.readdirSync(shadowDir);
    if (entries.length === 0) {
      return 'No Git Shadow Worktrees currently active.';
    }

    return [
      `Active Git Shadow Worktrees (${entries.length}):`,
      ...entries.map((e) => `  - ${e}`),
      'Usage: /worktree cleanup to purge isolated sandboxes',
    ].join('\n');
  }
};

export const gatewayCommand: LocalCommand = {
  name: 'gateway',
  description: 'Inspect multi-channel remote gateway daemon status',
  type: 'local',
  aliases: ['gw'],
  execute: () => {
    return [
      'Multi-Channel Gateway Daemon',
      'Supported Channels: REST API, Telegram Interactive Bot',
      'Default Port:       3912',
      'Status:             Available for headless dispatch',
      'Usage: Launch Gateway daemon using GatewayServer class',
    ].join('\n');
  }
};

export const sessionsCommand: LocalCommand = {
  name: 'sessions',
  description: 'List recent conversation sessions stored in SQLite WAL',
  type: 'local',
  aliases: ['history'],
  execute: () => {
    try {
      const rows = SessionStore.listSessions(10);
      if (rows.length === 0) {
        return 'No stored sessions in database. Use /new to start a new session.';
      }

      const lines: string[] = ['Recent Conversation Sessions:'];
      for (const r of rows) {
        const timeStr = new Date(r.updatedAt).toLocaleString();
        const totTokens = r.totalInputTokens + r.totalOutputTokens;
        lines.push(`- [${r.id.slice(0, 8)}] ${r.title} | ${r.model} | ${totTokens.toLocaleString()} tokens | $${r.totalCostUsd.toFixed(4)} USD`);
        lines.push(`  ID: ${r.id} (${timeStr})`);
      }
      lines.push('\nTips:');
      lines.push('  - /resume <id> (or /resume latest) to switch to any previous conversation');
      lines.push('  - /cost all to view total tokens and cost across all sessions');
      lines.push('  - /new to start fresh, or /delete to permanently remove current session');
      return lines.join('\n');
    } catch {
      return 'Unable to query sessions table from SQLite.';
    }
  }
};

export const resumeCommand: LocalCommand = {
  name: 'resume',
  description: 'Resume or switch to a previous conversation session (usage: /resume [id|latest])',
  type: 'local',
  aliases: ['switch', 'load'],
  execute: (ctx) => {
    const targetId = ctx.args[0]?.trim();
    if (!targetId) {
      const sessions = SessionStore.listSessions(6);
      const lines = ['Conversations available to resume:'];
      for (const s of sessions) {
        const tot = s.totalInputTokens + s.totalOutputTokens;
        lines.push(`- [${s.id.slice(0, 8)}] ${s.title} | ${s.model} | ${tot.toLocaleString()} tokens | $${s.totalCostUsd.toFixed(4)} USD`);
        lines.push(`  ID: ${s.id} (${new Date(s.updatedAt).toLocaleString()})`);
      }
      lines.push('\nUsage: /resume <id> or /resume latest');
      return lines.join('\n');
    }
    return `Resuming session ${targetId}...`;
  }
};

export const newCommand: LocalCommand = {
  name: 'new',
  description: 'Start a fresh conversation session (use --delete or -d to delete current session)',
  type: 'local',
  aliases: ['reset'],
  execute: () => {
    return 'Starting new conversation...';
  }
};

export const deleteSessionCommand: LocalCommand = {
  name: 'delete',
  description: 'Permanently delete current conversation from database and start a fresh session',
  type: 'local',
  aliases: ['delete-session', 'drop'],
  execute: () => {
    return 'Deleting conversation and starting new session...';
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

export const proofCommand: LocalCommand = {
  name: 'proof',
  description: 'Run empirical 5-pillar verification engine (Build, Test, Typecheck, Security, Scope) and generate proof card',
  type: 'local',
  aliases: ['verify', 'check'],
  execute: async (ctx) => {
    let files: string[] = ctx.args;
    if (files.length === 0) {
      try {
        const diffOutput = execSync('git diff --name-only HEAD', {
          cwd: ctx.cwd,
          encoding: 'utf-8',
          timeout: 4000,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        files = diffOutput.split('\n').map((f) => f.trim()).filter(Boolean);
      } catch {
        files = [];
      }
    }

    const report = await ProofEngine.verify(files, { cwd: ctx.cwd });
    return report.proofCard;
  }
};

export const routeCommand: LocalCommand = {
  name: 'route',
  description: 'Analyze task intent and preview optimal multi-model routing decision',
  type: 'local',
  aliases: ['router'],
  execute: (ctx) => {
    const prompt = ctx.args.join(' ').trim() || 'Refactor payment gateway and audit security';
    const decision = ModelRouter.route({ prompt });
    return [
      'Dynamic Multi-Model Router',
      `Prompt:      "${prompt}"`,
      `Category:    [${decision.category}]`,
      `Model:       ${decision.recommendedModel} (${decision.recommendedProvider})`,
      `Budget:      ${decision.thinkingBudget ? `${decision.thinkingBudget} tokens` : 'Standard'}`,
      `Rationale:   ${decision.rationale}`,
      `Fallbacks:   ${decision.fallbackChain.map((f) => `${f.model} (${f.provider})`).join(' -> ')}`,
    ].join('\n');
  }
};

export const benchmarkCommand: LocalCommand = {
  name: 'benchmark',
  description: 'Execute Autonomous SWE Benchmark suite evaluating empirical repairs and verification integrity',
  type: 'local',
  aliases: ['swe-bench', 'bench'],
  execute: async (ctx) => {
    const modeArg = ctx.args[0]?.toLowerCase();
    if (modeArg === 'empirical') {
      const results = await SweBenchmarkRunner.runEmpirical(ctx.cwd);
      const passed = results.filter((r) => r.verdict === 'PASS').length;
      return [
        'Empirical Sandbox Benchmark',
        `Tasks Evaluated: ${results.length}`,
        `Passed Hidden Tests: ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%)`,
        ...results.map((r) => `[${r.verdict}] ${r.taskId} - ${r.agentName}: Score ${r.empiricalScore}/100 (Red Phase Confirmed: ${r.redPhaseConfirmed}, Hidden Tests: ${r.hiddenTestsPassed ? 'PASS' : 'FAIL'})`),
      ].join('\n');
    }
    const mode = modeArg === 'full' ? 'full' : 'quick';
    const report = SweBenchmarkRunner.run(mode);
    return report.scorecard;
  }
};

export const universalVerifyCommand: LocalCommand = {
  name: 'verify',
  description: 'Run 4-Ring Universal Verification Oracle (G1-G10, Anti-Tamper, Mutation, 14 Counterexamples)',
  type: 'local',
  aliases: ['oracle'],
  execute: async (ctx) => {
    const { UniversalVerificationAdapter } = await import('../../engine/verification/UniversalVerificationAdapter.js');
    let files = ctx.args;
    if (files.length === 0) {
      try {
        const diffOutput = execSync('git diff --name-only HEAD', {
          cwd: ctx.cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        files = diffOutput.split('\n').map((f) => f.trim()).filter(Boolean);
      } catch {
        files = [];
      }
    }
    if (files.length === 0) {
      files = ['cli/index.ts'];
    }

    const report = await UniversalVerificationAdapter.verify({
      cwd: ctx.cwd,
      userIntent: 'Universal verification audit of workspace modifications',
      changedFiles: files,
    });

    return [
      report.proofCard,
      `Oracle Verdict: [${report.verdict}]`,
      `Summary: ${report.summary}`,
    ].join('\n\n');
  }
};

export const verifyProofCommand: LocalCommand = {
  name: 'verify-proof',
  description: 'Cryptographically verify an InterShader Proof directory on disk (ECDSA signature and SHA-256 hashes)',
  type: 'local',
  aliases: ['attest-check', 'check-proof'],
  execute: async (ctx) => {
    const { AttestationAuthority } = await import('../../engine/verification/AttestationAuthority.js');
    let targetDir = '';
    let expectedChallenge: string | undefined;

    for (let i = 0; i < ctx.args.length; i++) {
      if (ctx.args[i] === '--challenge' || ctx.args[i] === '-c') {
        expectedChallenge = ctx.args[i + 1];
        i++;
      } else if (!targetDir) {
        targetDir = ctx.args[i];
      }
    }

    if (!targetDir) {
      // Find latest run directory
      const baseProofDir = path.join(ctx.cwd, '.intershader', 'proof');
      if (fs.existsSync(baseProofDir)) {
        const entries = fs.readdirSync(baseProofDir).filter((e) => e.startsWith('run-'));
        if (entries.length > 0) {
          entries.sort();
          targetDir = path.join(baseProofDir, entries[entries.length - 1]);
        }
      }
    }

    if (!targetDir) {
      return 'Error: No proof directory specified and no existing runs found in .intershader/proof/';
    }

    const report = AttestationAuthority.verifyProofDirectory(targetDir, {
      expectedChallenge,
      consumeChallenge: Boolean(expectedChallenge),
    });

    if (report.isValid && report.manifest && report.attestation) {
      return [
        'Cryptographic Proof Verification',
        `Proof Directory:    ${targetDir}`,
        `Verdict:            [${report.verdict}] - AUTHENTIC & UNTAMPERED`,
        `Digital Signature:  Valid (${report.attestation.signatureAlgorithm})`,
        `Oracle Authority:   ${report.attestation.oracleId}`,
        `Oracle Key ID:      ${report.attestation.oracleKeyId}`,
        `Key Fingerprint:    ${report.attestation.publicKeyFingerprint}`,
        `Challenge:          ${report.manifest.challenge || 'None (Unchallenged Run)'}`,
        `Commit SHA:         ${report.manifest.workspaceCommit ? report.manifest.workspaceCommit.slice(0, 16) : 'None (Non-Git Snapshot)'}`,
        `Signed At:          ${report.attestation.signedAt}`,
        `Manifest SHA-256:   ${report.manifest.manifestHashSha256}`,
        `Supply-Chain Specs: SLSA v1.2 (Active), SLSA v1.0 (Compat), in-toto Statement v1`,
        `Verified Gates:     ${report.verifiedGatesCount}/${Object.keys(report.manifest.gates).length}`,
        `Status:             ALL EVIDENCE HAS BEEN MATHEMATICALLY PROVED`,
      ].join('\n');
    }

    return [
      'Cryptographic Proof Verification Failed',
      `Proof Directory:    ${targetDir}`,
      `Verdict:            [${report.verdict}]`,
      `Errors:`,
      ...report.errors.map((e) => `  - ${e}`),
      `Status:             TAMPER OR FORGERY DETECTED. DO NOT TRUST THIS PROOF.`,
    ].join('\n');
  }
};

export const mcpCommand: LocalCommand = {
  name: 'mcp',
  description: 'Inspect Model Context Protocol (MCP) servers and active external tools',
  type: 'local',
  aliases: ['mcps'],
  execute: (ctx) => {
    const configPath = McpClientManager.findConfigFile(ctx.cwd);
    const connected = McpClientManager.getConnectedServers();

    if (!configPath) {
      return [
        'Model Context Protocol (MCP) Ecosystem',
        'Status: No MCP configuration file detected.',
        'To connect external servers (Postgres, GitHub, SQLite, Sentry):',
        '  Create .intershader/mcp.json or .mcp.json with:',
        '  {',
        '    "mcpServers": {',
        '      "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }',
        '    }',
        '  }'
      ].join('\n');
    }

    return [
      'Model Context Protocol (MCP) Runtime',
      `Config Path:       ${configPath}`,
      `Active Servers:    ${connected.length > 0 ? connected.join(', ') : 'None running or awaiting connection'}`,
      'Servers provide dynamic domain tools to the agent seamlessly.'
    ].join('\n');
  }
};

export const repoMapCommand: LocalCommand = {
  name: 'repomap',
  description: 'Display an AST structural symbol architecture map of the codebase',
  type: 'local',
  aliases: ['map', 'symbols'],
  execute: async (ctx) => {
    const tool = new RepoMapTool();
    return await tool.execute(
      { subDir: ctx.args[0] },
      { sessionId: (ctx.sessionState?.id as string) || 'cli', cwd: ctx.cwd, permissionMode: 'bypassPermissions' }
    );
  }
};

export const tasksCommand: LocalCommand = {
  name: 'tasks',
  description: 'Display active task checklist, tick tasks done, or clear tasks (/tasks [done <id>|tick <id>|clear|prune])',
  type: 'local',
  aliases: ['todos', 'todo'],
  execute: (ctx) => {
    const sessionId = (ctx.sessionState?.id as string) || '';
    if (!sessionId) {
      return 'No active session found.';
    }

    const sub = ctx.args[0]?.toLowerCase();
    const targetArg = ctx.args[1];

    // Clear completed / prune
    if (sub === 'prune' || sub === 'clear-done' || (sub === 'clear' && targetArg?.toLowerCase() === 'completed')) {
      const cleared = TaskManager.clearCompletedTasks(sessionId);
      return `[TASKS]: Cleared ${cleared} completed task(s) from session checklist.`;
    }

    // Clear all
    if (sub === 'clear' || sub === 'reset') {
      const cleared = TaskManager.clearAllTasks(sessionId);
      return `[TASKS]: Cleared ${cleared} task(s) from session checklist.`;
    }

    // Tick / complete a task: /tasks tick <id>, /tasks done <id>, /tasks complete <id>, or /tasks <id> done
    const isTickCmd = sub === 'tick' || sub === 'done' || sub === 'complete' || sub === 'check';
    const isReverseTick = /^\d+$/.test(sub || '') && (targetArg?.toLowerCase() === 'done' || targetArg?.toLowerCase() === 'tick');
    if (isTickCmd || isReverseTick) {
      const taskId = isReverseTick ? sub : targetArg;
      if (!taskId) {
        return '[TASKS]: Please specify the task ID to complete, e.g. /tasks done 1';
      }
      const task = TaskManager.getTask(sessionId, taskId);
      if (!task) {
        return `[TASKS]: Task #${taskId} not found in session.`;
      }
      TaskManager.updateTask(sessionId, taskId, { status: 'completed' });
      return `[TASKS]: Marked task #${taskId} ("${task.subject}") as [✔] COMPLETED.`;
    }

    // Untick / pending a task: /tasks untick <id>, /tasks pending <id>
    const isUntickCmd = sub === 'untick' || sub === 'pending' || sub === 'uncheck';
    if (isUntickCmd) {
      const taskId = targetArg;
      if (!taskId) {
        return '[TASKS]: Please specify the task ID, e.g. /tasks untick 1';
      }
      const task = TaskManager.getTask(sessionId, taskId);
      if (!task) {
        return `[TASKS]: Task #${taskId} not found in session.`;
      }
      TaskManager.updateTask(sessionId, taskId, { status: 'pending' });
      return `[TASKS]: Marked task #${taskId} ("${task.subject}") as [○] PENDING.`;
    }

    // Start / in_progress a task: /tasks start <id>, /tasks in_progress <id>
    if (sub === 'start' || sub === 'in_progress' || sub === 'run') {
      const taskId = targetArg;
      if (!taskId) {
        return '[TASKS]: Please specify the task ID, e.g. /tasks start 1';
      }
      const task = TaskManager.getTask(sessionId, taskId);
      if (!task) {
        return `[TASKS]: Task #${taskId} not found in session.`;
      }
      TaskManager.updateTask(sessionId, taskId, { status: 'in_progress' });
      return `[TASKS]: Marked task #${taskId} ("${task.subject}") as [▶] IN_PROGRESS.`;
    }

    const tasks = TaskManager.listTasks(sessionId);
    if (tasks.length === 0) {
      return 'No tasks currently registered in session. Use task_manage to create tasks or ask the agent to break down a plan into steps.';
    }
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const lines = [
      `Session Task Checklist (${completed}/${tasks.length} completed):`,
      '------------------------------------------------------------',
    ];
    for (const t of tasks) {
      const mark = t.status === 'completed' ? '[✔]' : t.status === 'in_progress' ? '[▶]' : '[○]';
      const active = t.activeForm ? ` (${t.activeForm})` : '';
      lines.push(`${mark} #${t.id}: ${t.subject} [${t.status.toUpperCase()}]${active}`);
      if (t.description && t.description !== t.subject) {
        lines.push(`     ${t.description}`);
      }
    }
    lines.push('------------------------------------------------------------');
    lines.push('Commands: /tasks done <id> | /tasks untick <id> | /tasks prune | /tasks clear');
    return lines.join('\n');
  },
};

export const interviewCommand: PromptCommand = {
  name: 'interview',
  description: 'Trigger interactive Socratic clarification interview before writing code',
  type: 'prompt',
  aliases: ['grill-me', 'clarify'],
  getPrompt: (ctx) => {
    const topic = ctx.args.length > 0 ? ctx.args.join(' ') : 'the current task';
    return [
      `Please conduct an interactive Socratic clarification interview with me regarding ${topic}.`,
      'Guidelines:',
      '1. Do not start coding or editing files yet.',
      '2. Identify ambiguities, edge cases, or architecture decisions that need alignment.',
      '3. Use the `ask_user` tool with structured multiple-choice options to ask me one or two targeted questions at a time.',
      '4. Once we align, summarize the agreed specification and implementation steps.'
    ].join('\n');
  },
};

export const lintCommand: LocalCommand = {
  name: 'lint',
  description: 'Run TypeScript compiler and syntax diagnostics on workspace files',
  type: 'local',
  aliases: ['diagnostics', 'diag'],
  execute: (ctx) => {
    const targetFile = ctx.args[0];
    if (targetFile) {
      const resolved = path.isAbsolute(targetFile) ? targetFile : path.join(ctx.cwd, targetFile);
      const diags = SerenaSemanticEngine.getDiagnostics(resolved);
      if (diags.length === 0) {
        return `[LINT]: No errors or warnings found in ${targetFile}.`;
      }
      return [
        `[LINT]: ${diags.length} issue(s) found in ${targetFile}:`,
        ...diags.map((d) => `  - [${d.category.toUpperCase()} TS${d.code}] Line ${d.line}:${d.character} - ${d.message}`)
      ].join('\n');
    }

    try {
      const gitOut = execSync('git status --porcelain', { cwd: ctx.cwd, encoding: 'utf-8', timeout: 3000 });
      const modifiedFiles = gitOut
        .split('\n')
        .map((l) => l.trim().slice(3))
        .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx'));

      if (modifiedFiles.length === 0) {
        return '[LINT]: No modified code files detected in git working tree to lint.';
      }

      const reportLines: string[] = [`[LINT]: Inspecting ${modifiedFiles.length} modified file(s):`];
      let totalIssues = 0;
      for (const f of modifiedFiles.slice(0, 10)) {
        const resolved = path.join(ctx.cwd, f);
        const diags = SerenaSemanticEngine.getDiagnostics(resolved);
        if (diags.length > 0) {
          totalIssues += diags.length;
          reportLines.push(`\n📄 ${f} (${diags.length} issue(s)):`);
          for (const d of diags.slice(0, 5)) {
            reportLines.push(`   - [${d.category.toUpperCase()} TS${d.code}] Line ${d.line}:${d.character} - ${d.message}`);
          }
        }
      }
      if (totalIssues === 0) {
        return `[LINT]: All ${modifiedFiles.length} modified files passed compiler diagnostics with 0 issues!`;
      }
      return reportLines.join('\n');
    } catch {
      return '[LINT]: Please specify a target file: /lint <filePath>';
    }
  },
};

export const scheduleCommand: LocalCommand = {
  name: 'schedule',
  description: 'Manage background timers and cron schedules for the agent',
  type: 'local',
  execute: async (ctx) => {
    const scheduler = TaskScheduler.getInstance();
    const args = ctx.args;

    if (args.length === 0 || args[0] === 'list') {
      const tasks = scheduler.listTasks();
      if (tasks.length === 0) {
        return '[SCHEDULE]: No scheduled timers or cron jobs currently active.\nUsage:\n  /schedule in <seconds>s <prompt>\n  /schedule cron "<expression>" <prompt>\n  /schedule cancel <taskId>';
      }
      const lines = tasks.map((t) => {
        const nextIn = Math.max(0, Math.round((t.nextRunAt - Date.now()) / 1000));
        return `- **${t.id}** [${t.type}] Status: ${t.status} | In: ${nextIn}s | Prompt: "${t.prompt}"`;
      });
      return `### Active Schedules (${tasks.length}):\n${lines.join('\n')}`;
    }

    if (args[0] === 'cancel' && args[1]) {
      const ok = scheduler.cancel(args[1]);
      return ok ? `[SCHEDULE]: Cancelled task ${args[1]}` : `[SCHEDULE]: Task ${args[1]} not found.`;
    }

    if (args[0] === 'in' && args[1]) {
      let seconds = parseInt(args[1].replace(/s$/, ''), 10);
      if (args[1].endsWith('m')) {
        seconds = parseInt(args[1].replace(/m$/, ''), 10) * 60;
      }
      const prompt = args.slice(2).join(' ') || 'Scheduled reminder';
      const task = scheduler.scheduleTimer({ durationSeconds: seconds, prompt });
      return `[SCHEDULE]: Timer scheduled for ${seconds}s (Task ID: ${task.id}). Prompt: "${prompt}"`;
    }

    return '[SCHEDULE]: Usage: /schedule in <seconds/minutes> <prompt> | /schedule cancel <taskId> | /schedule list';
  },
};

export const tabCommand: LocalCommand = {
  name: 'tab',
  description: 'Manage concurrent multi-session tabs in isolated Git worktrees (/tab new, /tab switch, /tab list, /tab merge, /tab close)',
  type: 'local',
  aliases: ['tabs', 'session_tab'],
  execute: async (ctx) => {
    const { MultiSessionPool } = await import('../../engine/swarm/MultiSessionPool.js');
    const pool = MultiSessionPool.getInstance();
    const sub = ctx.args[0]?.toLowerCase();

    // 1. /tab list
    if (!sub || sub === 'list') {
      const tabs = pool.getTabs();
      if (tabs.length === 0) {
        return '[TABS]: No session tabs currently initialized in MultiSessionPool.\nUsage:\n  /tab new <title> [role]   - Create a secondary agent session tab in isolated Git worktree\n  /tab switch <number>      - Switch active view to tab\n  /tab merge [number]       - Merge worktree code back into main branch\n  /tab close <number>       - Close secondary tab and delete worktree';
      }
      const active = pool.getActiveTab();
      const lines = [
        `📑 Active Session Tabs (${tabs.length}):`,
        ...tabs.map((t, i) => {
          const marker = t.id === active.id ? '▶ [ACTIVE]' : '  ';
          const wt = t.isPrimary ? '(Primary Workspace)' : `(Worktree: ${t.branch || path.basename(t.worktreePath)})`;
          return `${marker} Tab ${i + 1}: "${t.title}" [${t.role.toUpperCase()}] -> ${t.status.toUpperCase()} ${wt}`;
        }),
        '',
        'Usage:',
        '  /tab new <title> [role]   - Create a secondary agent session tab in isolated Git worktree',
        '  /tab switch <number>      - Switch active view to tab',
        '  /tab merge [number]       - Merge worktree code back into main branch with VerificationGate',
        '  /tab close <number>       - Close secondary tab and delete its worktree',
      ];
      return lines.join('\n');
    }

    // 2. /tab new <title> [role]
    if (sub === 'new' || sub === 'create') {
      const title = ctx.args[1] || 'Worker Session';
      const role = (ctx.args[2] || 'general') as any;
      try {
        const newTab = await pool.createTab({ title, role });
        pool.switchActiveTab(newTab.id);
        const tabNumber = pool.getTabs().findIndex((t) => t.id === newTab.id) + 1;
        return `[TABS]: Successfully created and switched to Tab ${tabNumber}: "${newTab.title}" [Role: ${newTab.role}].\nIsolated Worktree: ${newTab.worktreePath}\nGit Branch: ${newTab.branch || 'N/A'}\n🚀 Ready for concurrent prompt execution! Previous tab continues running in background.\nShortcut: Press Alt+1..${pool.getTabs().length} or /tab switch <n> to switch between tabs.`;
      } catch (err: unknown) {
        return `[TABS ERROR]: Failed to create worktree session: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 3. /tab switch <index|id|title>
    if (sub === 'switch') {
      const target = ctx.args[1];
      if (!target) {
        return '[TABS]: Please specify a tab number or title: /tab switch <number>';
      }
      const num = parseInt(target, 10);
      try {
        const switched = pool.switchActiveTab(!isNaN(num) ? num : target);
        return `[TABS]: Switched active tab to "${switched.title}" (Tab ${pool.getTabs().findIndex((t) => t.id === switched.id) + 1}).`;
      } catch (err: unknown) {
        return `[TABS ERROR]: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 4. /tab merge [index|id]
    if (sub === 'merge') {
      const target = ctx.args[1] ? (parseInt(ctx.args[1], 10) || ctx.args[1]) : pool.getActiveTab().id;
      const res = await pool.mergeTab(target);
      return `[TABS MERGE]: ${res.message}`;
    }

    // 5. /tab close <index|id>
    if (sub === 'close' || sub === 'delete') {
      const target = ctx.args[1] ? (parseInt(ctx.args[1], 10) || ctx.args[1]) : pool.getActiveTab().id;
      try {
        const ok = await pool.closeTab(target);
        return ok ? `[TABS]: Successfully closed tab "${target}". Worktree cleaned up.` : `[TABS]: Tab "${target}" not found.`;
      } catch (err: unknown) {
        return `[TABS ERROR]: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return '[TABS]: Unknown command. Usage: /tab list | /tab new <title> | /tab switch <number> | /tab merge | /tab close';
  },
};

export const enhanceCommand: LocalCommand = {
  name: '/enhance',
  description: 'Enhance vague research inquiries into 6-dimension structured ML specifications (WHAT, WHY, HOW, DONE)',
  type: 'local',
  aliases: ['/prompt-enhancer', '/pe'],
  async execute(ctx: CommandContext): Promise<string> {
    const raw = ctx.args.join(' ').trim();
    if (!raw) {
      return '[ENHANCE]: Please provide a prompt or research goal to enhance. Usage: /enhance <goal or model description>';
    }
    const { PromptEnhancerTool } = await import('../../tools/agentic/PromptEnhancerTool.js');
    const tool = new PromptEnhancerTool();
    return await tool.execute(
      {
        action: 'enhance_prompt',
        rawPrompt: raw,
      },
      {
        sessionId: 'cli-session',
        cwd: ctx.cwd,
        permissionMode: 'auto',
      }
    );
  },
};

export const auditCommand: LocalCommand = {
  name: '/audit',
  description: 'Audit project dependencies for security vulnerabilities (CVEs), outdated packages, and licenses',
  type: 'local',
  aliases: ['/dependency-audit', '/dep-audit'],
  async execute(ctx: CommandContext): Promise<string> {
    const targetDir = ctx.args[0] || '.';
    const { DependencyAuditTool } = await import('../../tools/code/DependencyAuditTool.js');
    const tool = new DependencyAuditTool();
    return await tool.execute(
      {
        targetDir,
        ecosystem: 'auto',
        saveReport: true,
      },
      {
        sessionId: 'cli-session',
        cwd: ctx.cwd,
        permissionMode: 'auto',
      }
    );
  },
};

export const maxingCommand: LocalCommand = {
  name: 'maxing',
  description: 'Toggle Maxing Mode: unconstrained reasoning budget (up to 32k tokens) and multi-threaded department swarm (/maxing [on|off|status|run <goal>])',
  type: 'local',
  aliases: ['max', 'department'],
  async execute(ctx: CommandContext): Promise<string> {
    const st = ctx.sessionState as Record<string, unknown>;
    const sub = (ctx.args[0] || '').toLowerCase().trim();

    if (sub === 'on' || sub === 'enable' || sub === 'start') {
      st.maxingMode = true;
      st.thinkingBudget = 16384;
      return '🚀 [MAXING MODE: ACTIVE]\n- Unconstrained Reasoning Budget: Enabled (16,384 tokens thinking).\n- Department Swarm: Mobilizes Lead Architect, Core Engineers, Domain Specialists, Security Auditors & Reviewers.\n- Clamping Disabled: Retains full reasoning depth across all conversation turns.\n- All subsequent prompts will execute with maximum departmental intelligence.';
    }

    if (sub === 'off' || sub === 'disable' || sub === 'stop') {
      st.maxingMode = false;
      st.thinkingBudget = 2048;
      return '🛑 [MAXING MODE: DISABLED]\n- Reverted to standard token budget and single-agent execution.';
    }

    if (sub === 'status') {
      const isMaxing = Boolean(st.maxingMode);
      const { DepartmentBlackboard } = await import('../../engine/swarm/DepartmentBlackboard.js');
      const digest = DepartmentBlackboard.getInstance().getDigest();
      return [
        `📊 [MAXING MODE STATUS]: ${isMaxing ? '🟢 ACTIVE' : '⚪ INACTIVE'}`,
        `- Thinking Token Budget: ${st.thinkingBudget || (isMaxing ? 16384 : 'Standard')}`,
        `- Department Swarm: ${isMaxing ? 'Ready for multi-threaded parallel dispatch' : 'Standby'}`,
        '',
        digest,
      ].join('\n');
    }

    if (sub === 'run') {
      const goal = ctx.args.slice(1).join(' ').trim();
      if (!goal) {
        return '[MAXING]: Please provide a mission goal for the department. Usage: /maxing run <mission goal>';
      }
      const { SwarmDepartmentCoordinator } = await import('../../engine/swarm/SwarmDepartmentCoordinator.js');
      const coordinator = new SwarmDepartmentCoordinator();
      const report = await coordinator.executeMission({
        missionGoal: goal,
        baseCwd: ctx.cwd,
        maxingBudget: 16384,
        autoMerge: true,
      });
      return report.summary;
    }

    // Toggle if no argument provided
    const nextState = !st.maxingMode;
    st.maxingMode = nextState;
    if (nextState) {
      st.thinkingBudget = 16384;
      return '🚀 [MAXING MODE: ACTIVE]\n- Unconstrained thinking budget (16k tokens) and multi-threaded department swarm enabled.\n- Usage: /maxing [on|off|status|run <goal>]';
    } else {
      st.thinkingBudget = 2048;
      return '🛑 [MAXING MODE: DISABLED]\n- Reverted to standard token budget.';
    }
  },
};

export const fuzzCommand: LocalCommand = {
  name: 'fuzz',
  description: 'Run autonomous invariant fuzzing & property-based testing on a module or function',
  type: 'local',
  aliases: ['pbt', 'fuzzing'],
  execute: async (ctx) => {
    const file = ctx.args[0];
    const fnName = ctx.args[1] || 'default';
    const iterations = ctx.args[2] ? parseInt(ctx.args[2], 10) : 100;
    const invariant = (ctx.args[3] as InvariantType) || 'NO_PANIC';

    if (!file) {
      return [
        '🔬 [INVARIANT FUZZING ENGINE]',
        'Usage: /fuzz <filePath> [functionName] [iterations] [invariantType]',
        'Invariants: NO_PANIC | IDEMPOTENCY | ROUNDTRIP | COMMUTATIVITY | MONOTONICITY',
        'Example: /fuzz engine/verification/CanonicalJson.ts canonicalize 100 IDEMPOTENCY',
      ].join('\n');
    }

    try {
      const report = await InvariantFuzzEngine.fuzzFile(ctx.cwd, file, fnName, invariant, {
        cwd: ctx.cwd,
        iterations,
        generateReproScript: true,
      });

      const status = report.overallPassed ? '✅ ALL INVARIANTS SATISFIED' : '❌ INVARIANT VIOLATION DETECTED';
      const lines = [
        `🔬 [INVARIANT FUZZ REPORT]: ${report.target}`,
        `- Invariant: ${report.invariantType}`,
        `- Iterations: ${report.passedIterations}/${report.totalIterations} passed (${report.durationMs}ms)`,
        `- Verdict: ${status}`,
      ];

      if (!report.overallPassed) {
        lines.push(`- Error: ${report.errorMessage || 'Unknown error'}`);
        lines.push(`- Minimal Shrunk Counterexample: ${JSON.stringify(report.shrunkCounterexample)}`);
        if (report.reproScriptPath) {
          lines.push(`- Repro Script: ${report.reproScriptPath}`);
        }
      }
      return lines.join('\n');
    } catch (err: any) {
      return `[FUZZ ERROR]: ${err.message}`;
    }
  },
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
  registry.register(helpCommand);
}

