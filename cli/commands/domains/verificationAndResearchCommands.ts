import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { LocalCommand, CommandContext } from '../types.js';
import { ProofEngine } from '../../../engine/verification/ProofEngine.js';
import { ModelRouter } from '../../../orchestrator/ModelRouter.js';
import { SweBenchmarkRunner } from '../../../engine/benchmark/SweBenchmarkRunner.js';
import { InvariantFuzzEngine, type InvariantType } from '../../../engine/verification/InvariantFuzzEngine.js';

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
  },
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
      'DYNAMIC MULTI-MODEL ROUTER',
      `Prompt:      "${prompt}"`,
      `Category:    [${decision.category}]`,
      `Model:       ${decision.recommendedModel} (${decision.recommendedProvider})`,
      `Budget:      ${decision.thinkingBudget ? `${decision.thinkingBudget} tokens` : 'Standard'}`,
      `Rationale:   ${decision.rationale}`,
      `Fallbacks:   ${decision.fallbackChain.map((f) => `${f.model} (${f.provider})`).join(' -> ')}`,
    ].join('\n');
  },
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
        ...results.map(
          (r) =>
            `[${r.verdict}] ${r.taskId} - ${r.agentName}: Score ${r.empiricalScore}/100 (Red Phase Confirmed: ${r.redPhaseConfirmed}, Hidden Tests: ${r.hiddenTestsPassed ? 'PASS' : 'FAIL'})`
        ),
      ].join('\n');
    }
    const mode = modeArg === 'full' ? 'full' : 'quick';
    const report = SweBenchmarkRunner.run(mode);
    return report.scorecard;
  },
};

export const universalVerifyCommand: LocalCommand = {
  name: 'verify',
  description: 'Run 4-Ring Universal Verification Oracle (G1-G10, Anti-Tamper, Mutation, 14 Counterexamples)',
  type: 'local',
  aliases: ['oracle'],
  execute: async (ctx) => {
    const { UniversalVerificationAdapter } = await import('../../../engine/verification/UniversalVerificationAdapter.js');
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
  },
};

export const verifyProofCommand: LocalCommand = {
  name: 'verify-proof',
  description: 'Cryptographically verify an InterShader Proof directory on disk (ECDSA signature and SHA-256 hashes)',
  type: 'local',
  aliases: ['attest-check', 'check-proof'],
  execute: async (ctx) => {
    const { AttestationAuthority } = await import('../../../engine/verification/AttestationAuthority.js');
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
        'CRYPTOGRAPHIC PROOF VERIFICATION',
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
      'CRYPTOGRAPHIC PROOF VERIFICATION FAILED',
      `Proof Directory:    ${targetDir}`,
      `Verdict:            [${report.verdict}]`,
      `Errors:`,
      ...report.errors.map((e) => `  - ${e}`),
      `Status:             TAMPER OR FORGERY DETECTED. DO NOT TRUST THIS PROOF.`,
    ].join('\n');
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
    const { PromptEnhancerTool } = await import('../../../tools/agentic/PromptEnhancerTool.js');
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
    const { DependencyAuditTool } = await import('../../../tools/code/DependencyAuditTool.js');
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
      const { DepartmentBlackboard } = await import('../../../engine/swarm/DepartmentBlackboard.js');
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
      const { SwarmDepartmentCoordinator } = await import('../../../engine/swarm/SwarmDepartmentCoordinator.js');
      const coordinator = new SwarmDepartmentCoordinator();
      const report = await coordinator.executeMission({
        missionGoal: goal,
        baseCwd: ctx.cwd,
        maxingBudget: 16384,
        autoMerge: ctx.args.includes('--auto-merge'),
      });
      return report.summary;
    }

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
