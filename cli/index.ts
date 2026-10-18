#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { App } from '../ui/App.js';
import { QueryEngine } from '../orchestrator/QueryEngine.js';
import type { SessionConfig, PermissionMode } from '../types/index.js';
import { config } from '../config/index.js';
import { i18n } from '../services/i18n/index.js';
import { ConnectionConfigLoader } from '../providers/core/ConnectionConfigLoader.js';
import { ConnectionRegistry } from '../providers/core/ConnectionRegistry.js';
import { GatewayFormatter } from '../providers/catalog/GatewayFormatter.js';
import { ProviderHealthChecker } from '../providers/reliability/ProviderHealthChecker.js';
import { ModelDiscovery } from '../providers/catalog/ModelDiscovery.js';
import { ModelProbeEngine } from '../providers/reliability/ModelProbeEngine.js';
import { SerenaSemanticEngine } from '../engine/semantic/SerenaSemanticEngine.js';
import { AgentReachRouter } from '../engine/reach/AgentReachRouter.js';
import { ReachHealthDoctor } from '../engine/reach/ReachHealthDoctor.js';
import { OrcaWorktreeOrchestrator } from '../engine/orchestration/OrcaWorktreeOrchestrator.js';
import { SkillRegistry } from '../services/skills/SkillRegistry.js';
import { SkillLockfile } from '../services/skills/SkillLockfile.js';
import { SkillAllowlist } from '../services/skills/SkillAllowlist.js';
import { SkillSecurityAuditor } from '../services/skills/SkillSecurityAuditor.js';


// Load user-defined connection profiles on CLI startup
ConnectionConfigLoader.loadFromFile();

const program = new Command();

program
  .name('intershader')
  .description('InterShader - CLI coding agent and model gateway')
  .version('1.0.0');

// Subcommand: models list / inspect / probe
const modelsCmd = program
  .command('models')
  .description('Model gateway catalog inspection, live discovery, and availability probe');

modelsCmd
  .command('list')
  .description('List registered models in catalog (use --live to query provider APIs)')
  .option('-p, --provider <provider>', 'Filter by provider ID')
  .option('--live', 'Fetch live model list directly from provider API endpoint', false)
  .action(async (cmdOptions: { provider?: string; live?: boolean }) => {
    const providerArg = cmdOptions.provider || program.opts().provider;
    if (cmdOptions.live) {
      const prov = providerArg || config.defaultProvider || 'google';
      const conn = ConnectionRegistry.findByProvider(prov) || ConnectionRegistry.getDefault();
      try {
        await ModelDiscovery.discover(conn);
      } catch (err: unknown) {
        console.error(`Warning: Live discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(GatewayFormatter.formatModelsList(providerArg));
    process.exit(0);
  });

modelsCmd
  .command('probe [model]')
  .description('Probe live model availability and check if request succeeds with provider API')
  .option('-p, --provider <provider>', 'Provider ID (anthropic, openai, deepseek, gemini, etc.)')
  .option('--all', 'Probe all registered models in catalog', false)
  .action(async (modelArg?: string, cmdOptions?: { provider?: string; all?: boolean }) => {
    if (cmdOptions?.all) {
      console.log('Probing all models live against provider APIs...');
      const results = await ModelProbeEngine.probeAll({ providerId: cmdOptions.provider });
      console.log(GatewayFormatter.formatModelProbeResults(results));
    } else {
      const prov = cmdOptions?.provider || program.opts().provider || config.defaultProvider || 'google';
      const conn = ConnectionRegistry.findByProvider(prov) || ConnectionRegistry.getDefault();
      const model = modelArg || conn.defaultModelId || 'claude-3-7-sonnet-20250219';
      console.log(`Probing model '${model}' on provider '${conn.providerId}'...`);
      const res = await ModelProbeEngine.probeModel(conn, model);
      console.log(GatewayFormatter.formatModelProbeResults([res]));
    }
    process.exit(0);
  });

modelsCmd
  .command('inspect [provider] [model]')
  .description('Inspect model capabilities and metadata')
  .option('--provider <provider>', 'Provider ID')
  .option('--model <model>', 'Model ID')
  .action((providerArg?: string, modelArg?: string, cmdOptions?: { provider?: string; model?: string }) => {
    const prov = providerArg || cmdOptions?.provider;
    const mod = modelArg || cmdOptions?.model;
    if (!prov || !mod) {
      console.error('Usage: intershader models inspect <provider> <model> (or --provider <p> --model <m>)');
      process.exit(1);
    }
    console.log(GatewayFormatter.formatModelInspect(prov, mod));
    process.exit(0);
  });

// Subcommand: providers list / test
const providersCmd = program
  .command('providers')
  .description('Connection profiles management and health checks');

providersCmd
  .command('list')
  .description('List configured connection profiles')
  .action(() => {
    console.log(GatewayFormatter.formatProvidersList());
    process.exit(0);
  });

providersCmd
  .command('test [connection]')
  .description('Test connectivity and latency to connection endpoint')
  .option('--connection <connection>', 'Specific connection profile to test')
  .action(async (connectionArg?: string, cmdOptions?: { connection?: string }) => {
    const target = typeof connectionArg === 'string' && connectionArg ? connectionArg : cmdOptions?.connection;
    if (target) {
      const conn = ConnectionRegistry.get(target) || ConnectionRegistry.findByProvider(target);
      if (!conn) {
        console.error(`Error: Connection '${target}' not found.`);
        process.exit(1);
      }
      const res = await ProviderHealthChecker.check(conn);
      console.log(GatewayFormatter.formatHealthCheck(res));
    } else {
      const results = await ProviderHealthChecker.checkAll();
      for (const r of results) {
        console.log(GatewayFormatter.formatHealthCheck(r));
        console.log('-'.repeat(40));
      }
    }
    process.exit(0);
  });

// Subcommand: semantic (Serena Semantic Engine)
const semanticCmd = program
  .command('semantic')
  .description('Serena semantic code intelligence, AST symbol outline, and diagnostics');

semanticCmd
  .command('outline <file>')
  .description('Inspect AST symbol outline of a source file')
  .action((file: string) => {
    const symbols = SerenaSemanticEngine.getSymbolOutline(file);
    if (symbols.length === 0) {
      console.log(`No symbols found in ${file}.`);
    } else {
      console.log(`Symbol Outline: ${file} (${symbols.length} symbols)`);
      for (const s of symbols) {
        const exp = s.isExported ? '[EXPORT] ' : '';
        console.log(`- ${exp}${s.kind.toUpperCase()} "${s.name}" (lines ${s.startLine}-${s.endLine})`);
      }
    }
    process.exit(0);
  });

semanticCmd
  .command('diag <file>')
  .description('Inspect compiler diagnostics and syntax errors for a file')
  .action((file: string) => {
    const diags = SerenaSemanticEngine.getDiagnostics(file);
    if (diags.length === 0) {
      console.log(`No errors or warnings found in ${file}.`);
    } else {
      console.log(`Compiler Diagnostics: ${file} (${diags.length} issues)`);
      for (const d of diags) {
        console.log(`[${d.category.toUpperCase()} TS${d.code}] Line ${d.line}:${d.character} - ${d.message}`);
      }
    }
    process.exit(0);
  });

// Subcommand: reach (Agent Reach Internet & Research Router)
const reachCmd = program
  .command('reach')
  .description('Agent Reach internet access, clean markdown reader, and health diagnostics');

reachCmd
  .command('doctor')
  .description('Run diagnostic checks across internet channels (Web Reader, GitHub API, DNS, Proxy)')
  .action(async () => {
    const report = await ReachHealthDoctor.diagnose();
    console.log(ReachHealthDoctor.formatReport(report));
    process.exit(0);
  });

reachCmd
  .command('read <url>')
  .description('Read public web page or doc into clean LLM-ready Markdown via Jina Reader')
  .action(async (url: string) => {
    const res = await AgentReachRouter.webRead(url);
    console.log(`Reach Web Read (${res.source.toUpperCase()}) | ${res.latencyMs}ms`);
    console.log(`URL: ${res.url}\n`);
    console.log(res.markdown);
    process.exit(0);
  });

reachCmd
  .command('search <query>')
  .description('Search the web for technical documentation, libraries, or error solutions')
  .option('-n, --num <number>', 'Number of results to return', '5')
  .action(async (query: string, cmdOptions: { num: string }) => {
    const maxResults = parseInt(cmdOptions.num, 10) || 5;
    const res = await AgentReachRouter.webSearch(query, { maxResults });
    console.log(`Reach Web Search (${res.source.toUpperCase()}) | ${res.latencyMs}ms`);
    console.log(`Query: "${res.query}" (${res.results.length} results)\n`);
    res.results.forEach((item, idx) => {
      console.log(`${idx + 1}. ${item.title}`);
      console.log(`   URL: ${item.url}`);
      if (item.snippet) console.log(`   ${item.snippet}`);
      console.log('');
    });
    process.exit(0);
  });

// Subcommand: worktree (Orca Worktree Orchestrator)
const worktreeCmd = program
  .command('worktree')
  .description('Orca isolated git worktree orchestration for parallel agent tasks');

worktreeCmd
  .command('list')
  .description('List all git worktrees and detect InterShade-managed ones')
  .action(async () => {
    const items = await OrcaWorktreeOrchestrator.listWorktrees();
    console.log('Active Git Worktrees');
    console.log(`${'BRANCH'.padEnd(25)} ${'MANAGED'.padEnd(10)} ${'HEAD'.padEnd(10)} ${'PATH'}`);
    console.log('-'.repeat(80));
    for (const item of items) {
      const managed = item.isInterShadeManaged ? 'YES' : 'NO';
      console.log(`${item.branch.padEnd(25)} ${managed.padEnd(10)} ${item.headCommit.substring(0, 8).padEnd(10)} ${item.worktreePath}`);
    }
    process.exit(0);
  });

worktreeCmd
  .command('create <id> [baseBranch]')
  .description('Create an isolated git worktree for exploration')
  .action(async (id: string, baseBranch?: string) => {
    const res = await OrcaWorktreeOrchestrator.createWorktree(id, baseBranch || 'HEAD');
    console.log(`Worktree created: ID=${id}, Branch=${res.branch}, Path=${res.worktreePath}`);
    process.exit(0);
  });

worktreeCmd
  .command('diff <id> [baseBranch]')
  .description('View diff of changes made within an isolated worktree')
  .action(async (id: string, baseBranch?: string) => {
    const diff = await OrcaWorktreeOrchestrator.getWorktreeDiff(id, baseBranch || 'HEAD');
    console.log(diff || 'No changes detected.');
    process.exit(0);
  });

worktreeCmd
  .command('cleanup <id>')
  .description('Safely remove an isolated worktree and delete its branch')
  .action(async (id: string) => {
    await OrcaWorktreeOrchestrator.cleanupWorktree(id, true);
    console.log(`Worktree '${id}' cleaned up.`);
    process.exit(0);
  });

// Subcommand: skill list / audit / verify / activate
const skillCmd = program
  .command('skill')
  .description('Agent Skill management, multi-tier discovery, static security audit, and lockfile verification');

skillCmd
  .command('list')
  .description('List all discovered agent skills across discovery tiers (Built-in, User, Workspace)')
  .action(async () => {
    const registry = new SkillRegistry(process.cwd());
    const skills = registry.getSkillCatalog();
    console.log(`Discovered ${skills.length} skills across tiers:\n`);
    for (const s of skills) {
      console.log(`- ${s.name} (v${s.version}, Tier: ${s.tier}, License: ${s.license})`);
      console.log(`  Description: ${s.description}`);
      console.log(`  Capabilities: script=${s.capabilities.scriptExecution}, net=${s.capabilities.networkAccess}, fs=${s.capabilities.filesystemWrite}`);
      if (s.tags && s.tags.length > 0) {
        console.log(`  Tags: ${s.tags.join(', ')}`);
      }
      console.log('');
    }
    process.exit(0);
  });

skillCmd
  .command('audit [name]')
  .description('Run static security audit on registered skills (Snyk Agent Scan model)')
  .action(async (name?: string) => {
    const registry = new SkillRegistry(process.cwd());
    const skills = registry.discoverAllSkills();
    const targets = name ? skills.filter((s) => s.metadata.name === name) : skills;
    if (targets.length === 0) {
      console.log(`No skill matching '${name || ''}' found.`);
      process.exit(1);
    }
    console.log(`Auditing ${targets.length} skill(s)...\n`);
    let hasFailures = false;
    for (const skill of targets) {
      const report = SkillSecurityAuditor.auditSkill(skill);
      const mark = report.passed ? '[PASS]' : '[FAIL]';
      console.log(`${mark} ${skill.metadata.name} (Max Severity: ${report.maxSeverity})`);
      if (report.findings.length > 0) {
        hasFailures = hasFailures || !report.passed;
        for (const f of report.findings) {
          console.log(`  - [${f.severity}] [${f.category}] ${f.message}`);
          if (f.sample) console.log(`    Sample: "${f.sample}"`);
        }
      } else {
        console.log(`  0 security findings.`);
      }
      console.log('');
    }
    process.exit(hasFailures ? 1 : 0);
  });

skillCmd
  .command('verify')
  .description('Verify integrity of all registered skills against skills.lock.json')
  .action(async () => {
    const root = process.cwd();
    const lockData = SkillLockfile.readLockfile(root);
    if (!lockData) {
      console.error('Error: skills.lock.json not found in workspace.');
      process.exit(1);
    }
    const registry = new SkillRegistry(root);
    const skills = registry.discoverAllSkills();
    let allValid = true;
    console.log(`Verifying ${skills.length} skills against skills.lock.json...\n`);
    for (const s of skills) {
      const check = SkillLockfile.verifySkillIntegrity(s, lockData);
      if (check.valid) {
        console.log(`[PASS] ${s.metadata.name} - SHA-256 integrity verified`);
      } else {
        allValid = false;
        console.error(`[FAIL] ${s.metadata.name} - Integrity error: ${check.reason}`);
      }
    }
    process.exit(allValid ? 0 : 1);
  });

skillCmd
  .command('activate <name>')
  .description('Verify and activate an approved skill into agent context')
  .action(async (name: string) => {
    const registry = new SkillRegistry(process.cwd());
    const res = registry.activateSkill(name, true);
    if (!res.success) {
      console.error(`[REJECTED]: ${res.error}`);
      process.exit(1);
    }
    console.log(`[ACTIVATED] ${res.skillName} (Tier: ${res.tier})`);
    console.log(`\nInstructions\n${res.instructions}`);
    process.exit(0);
  });



// Subcommand: setup / install (InterShader Onboarding Setup Wizard)
program
  .command('setup')
  .alias('install')
  .description('Run interactive onboarding setup wizard (InterShader diagnostics & workspace init)')
  .action(async () => {
    const { runSetupWizard } = await import('./commands/setupCommand.js');
    await runSetupWizard();
    process.exit(0);
  });

// Default interactive coding agent action
program
  .option('-m, --model <model>', 'LLM model name (e.g. claude-3-7-sonnet-20250219, gpt-4o, deepseek-chat, gemini-2.0-flash)')
  .option('-p, --provider <provider>', 'Provider (anthropic, openai, deepseek, gemini, ollama)')
  .option('-l, --lang <locale>', 'UI language locale (en, vi, ja, zh, es, fr, de, ko, ru)')
  .option('--plan', 'Launch agent in Plan Mode (Read-Only)', false)
  .option('--proof', 'Launch agent in Proof Mode (Strict empirical verification before done)', false)
  .option('-y, --yes', 'Automatically grant all permissions without confirmation prompts', false)
  .option('--bypass-permissions', 'Bypass all permission checks and confirmation prompts', false)
  .option('--all-perms', 'Grant all permissions (alias for --bypass-permissions)', false)
  .option('--yolo', 'YOLO mode: give agent all permissions without asking', false)
  .option('-n, --new', 'Start a fresh new session instead of resuming previous', false)
  .option('-r, --resume [id]', 'Resume a previous session (id, latest, or omit for latest)')
  .option('--session <id>', 'Resume a specific session ID')
  .option('-c, --cwd <path>', 'Working directory path', process.cwd())
  .option('-t, --max-turns <number>', 'Maximum turns per prompt (0 for unlimited continuous execution)', undefined)
  .argument('[prompt...]', 'Initial coding prompt or instruction')
  .action(async (promptArgs: string[], options) => {
    if (options.lang) {
      i18n.setLocale(options.lang);
    }

    const targetCwd = options.cwd || process.cwd();
    const initialPrompt = promptArgs && promptArgs.length > 0 ? promptArgs.join(' ') : undefined;
    const isBypass = Boolean(options.yes || options.bypassPermissions || options.allPerms || options.yolo);
    const permissionMode: PermissionMode = options.plan ? 'plan' : isBypass ? 'bypassPermissions' : 'default';

    const defaultProvider = config.defaultProvider;
    const defaultModel = config.defaultModel;

    let parsedMaxTurns = config.maxTurns;
    if (options.maxTurns !== undefined) {
      const optStr = String(options.maxTurns).toLowerCase().trim();
      if (['unlimited', 'inf', 'infinite', '0', 'none', 'continuous'].includes(optStr)) {
        parsedMaxTurns = 0;
      } else {
        const num = parseInt(optStr, 10);
        parsedMaxTurns = isNaN(num) ? config.maxTurns : num;
      }
    }

    const requestedSessionId =
      typeof options.resume === 'string' && options.resume.toLowerCase() !== 'true'
        ? options.resume
        : options.session;

    const sessionConfig: SessionConfig = {
      sessionId: requestedSessionId,
      resumeSession: Boolean(options.resume) || !options.new,
      provider: (options.provider as SessionConfig['provider']) || defaultProvider,
      model: options.model || (options.provider ? config.defaultModel : defaultModel),
      cwd: targetCwd,
      maxTokens: config.maxContextTokens,
      maxTurns: parsedMaxTurns,
      permissionMode,
      proofMode: Boolean(options.proof),
    };

    const queryEngine = new QueryEngine(sessionConfig);

    // Safe stdout proxy to ensure Ink respects physical terminal dimensions
    // with a reliable fallback when rows or columns is undefined or 0 (e.g. non-TTY).
    const safeStdout = new Proxy(process.stdout, {
      get(target, prop, receiver) {
        if (prop === 'rows') {
          return typeof target.rows === 'number' && target.rows > 0 ? target.rows : 24;
        }
        if (prop === 'columns') {
          return typeof target.columns === 'number' && target.columns > 0 ? target.columns : 80;
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    // Launch Ink Terminal UI
    render(React.createElement(App, { queryEngine, initialPrompt }), {
      stdout: safeStdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    });

  });

program.parse(process.argv);
