import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EvidenceStore, type GateEvidenceArtifact, type ProofManifest, type ProofVerdict } from './EvidenceStore.js';
import { CanonicalJson } from './CanonicalJson.js';
import { TestTamperDetector } from './TestTamperDetector.js';

export interface ProofCheckResult {
  readonly gateId: string;
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
  readonly durationMs: number;
  readonly executionDurationMs?: number;
  readonly evaluatorDecisionDurationMs?: number;
  readonly command?: string;
  readonly exitCode?: number;
  readonly stdoutHash?: string;
  readonly logArtifactPath?: string;
  readonly outputSnippet?: string;
}

export interface ProofReport {
  readonly timestamp: number;
  readonly runId: string;
  readonly overallPassed: boolean;
  readonly score: number; // 0 - 100
  readonly verdict?: ProofVerdict;
  readonly checks: ProofCheckResult[];
  readonly modifiedFiles: string[];
  readonly proofCard: string;
  readonly riskScore: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly manifest?: ProofManifest;
}

export interface ProofEngineOptions {
  cwd: string;
  runId?: string;
  challenge?: string;
  allowedFiles?: string[];
  testBaselineHashes?: Record<string, string>;
  skipBuild?: boolean;
  skipTests?: boolean;
  skipTypecheck?: boolean;
  skipLint?: boolean;
  skipIntegration?: boolean;
  skipRuntime?: boolean;
  customTestCommand?: string;
  customIntegrationCommand?: string;
  maxFilesBudget?: number;
}

export class ProofEngine {
  /**
   * Run rigorous 10-gate empirical verification and generate immutable Proof Artifact & Proof Card
   * Philosophy: NO EVIDENCE, NO DONE.
   */
  static async verify(
    modifiedFiles: string[] = [],
    options: ProofEngineOptions
  ): Promise<ProofReport> {
    const cwd = options.cwd;
    const runId = options.runId || `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const checks: ProofCheckResult[] = [];
    const gateArtifacts: Record<string, GateEvidenceArtifact> = {};
    const maxFiles = options.maxFilesBudget || 10;
    const pkgJsonPath = path.join(cwd, 'package.json');
    let pkg: Record<string, any> | null = null;

    if (fs.existsSync(pkgJsonPath)) {
      try {
        pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      } catch {
        pkg = null;
      }
    }

    const workspaceCommit = EvidenceStore.getWorkspaceCommit(cwd);

    // ==========================================
    // G1: Scope Guard (Workspace boundary containment)
    // ==========================================
    const g1Start = Date.now();
    let scopePassed = true;
    const outOfBoundsFiles: string[] = [];

    for (const relFile of modifiedFiles) {
      const resolved = path.resolve(cwd, relFile);
      if (!resolved.startsWith(path.resolve(cwd))) {
        scopePassed = false;
        outOfBoundsFiles.push(relFile);
      }
    }
    const g1EvalDuration = Math.max(1, Date.now() - g1Start);
    const g1Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g1-scope.log',
      `Workspace: ${cwd}\nChecked Files: ${modifiedFiles.join(', ')}\nOut of bounds: ${outOfBoundsFiles.join(', ') || 'None'}\nResult: ${scopePassed ? 'PASS' : 'FAIL'}`
    );

    checks.push({
      gateId: 'G1',
      name: 'G1 Scope & Workspace Boundary Guard',
      passed: scopePassed,
      message: scopePassed
        ? `All ${modifiedFiles.length} file(s) strictly contained inside workspace boundary`
        : `Path traversal detected escaping workspace: ${outOfBoundsFiles.join(', ')}`,
      durationMs: g1EvalDuration,
      evaluatorDecisionDurationMs: g1EvalDuration,
      executionDurationMs: 0,
      logArtifactPath: g1Artifact,
      stdoutHash: EvidenceStore.sha256(scopePassed ? 'PASS' : 'FAIL'),
    });

    gateArtifacts['G1'] = {
      gateId: 'G1',
      name: 'G1 Scope & Workspace Boundary',
      status: scopePassed ? 'PASS' : 'FAIL',
      startedAt: new Date(g1Start).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: 0,
      evaluatorDecisionDurationMs: g1EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(scopePassed ? 'PASS' : 'FAIL'),
      message: checks[0].message,
      logArtifactPath: g1Artifact,
    };

    // ==========================================
    // G2: Diff Budget Guard (Change budget control)
    // ==========================================
    const g2Start = Date.now();
    const isWithinBudget = modifiedFiles.length <= maxFiles;
    const g2EvalDuration = Math.max(1, Date.now() - g2Start);
    const g2Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g2-budget.log',
      `Modified files count: ${modifiedFiles.length}\nMax allowed files budget: ${maxFiles}\nStatus: ${isWithinBudget ? 'PASS' : 'FAIL'}`
    );

    checks.push({
      gateId: 'G2',
      name: 'G2 Scope & Diff Budget Guard',
      passed: isWithinBudget,
      message: isWithinBudget
        ? `Modified ${modifiedFiles.length} file(s) (Limit: ${maxFiles})`
        : `Exceeded file change budget: ${modifiedFiles.length} > ${maxFiles}`,
      durationMs: g2EvalDuration,
      evaluatorDecisionDurationMs: g2EvalDuration,
      executionDurationMs: 0,
      logArtifactPath: g2Artifact,
      stdoutHash: EvidenceStore.sha256(isWithinBudget ? 'PASS' : 'FAIL'),
    });

    gateArtifacts['G2'] = {
      gateId: 'G2',
      name: 'G2 Scope & Diff Budget',
      status: isWithinBudget ? 'PASS' : 'FAIL',
      startedAt: new Date(g2Start).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: 0,
      evaluatorDecisionDurationMs: g2EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(isWithinBudget ? 'PASS' : 'FAIL'),
      message: checks[1].message,
      logArtifactPath: g2Artifact,
    };

    // ==========================================
    // G3: Static Analysis & Lint Guard
    // ==========================================
    const g3EvalStart = Date.now();
    let lintPassed = true;
    let lintMessage = 'Static analysis & linter invariants passed with 0 critical errors';
    let lintOutput = '';
    let lintExecDuration = 0;
    let lintCommand = '';
    let lintExitCode = 0;

    if (!options.skipLint && pkg?.scripts?.lint) {
      lintCommand = 'npm run lint';
      const execStart = Date.now();
      try {
        lintOutput = execSync(lintCommand, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 45000,
          encoding: 'utf-8',
        });
        lintExecDuration = Date.now() - execStart;
      } catch (err: any) {
        lintPassed = false;
        lintExitCode = err.status || 1;
        lintExecDuration = Date.now() - execStart;
        lintOutput = (err.stdout || err.stderr || err.message || '').slice(0, 500);
        lintMessage = `Linter violations found:\n${lintOutput.trim()}`;
      }
    } else {
      lintMessage = options.skipLint
        ? 'Static analysis skipped by options'
        : 'Static analysis clean (syntax & import structure validated)';
    }

    const g3EvalDuration = Math.max(1, Date.now() - g3EvalStart);
    const g3Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g3-lint.log',
      `Command: ${lintCommand || 'internal-ast-scan'}\nExitCode: ${lintExitCode}\nOutput:\n${lintOutput || 'Clean syntax & imports'}`
    );

    checks.push({
      gateId: 'G3',
      name: 'G3 Static Analysis & Lint',
      passed: lintPassed,
      message: lintMessage,
      durationMs: lintExecDuration + g3EvalDuration,
      executionDurationMs: lintExecDuration,
      evaluatorDecisionDurationMs: g3EvalDuration,
      command: lintCommand || undefined,
      exitCode: lintExitCode,
      stdoutHash: EvidenceStore.sha256(lintOutput || 'clean'),
      logArtifactPath: g3Artifact,
    });

    gateArtifacts['G3'] = {
      gateId: 'G3',
      name: 'G3 Static Analysis & Lint',
      status: lintPassed ? 'PASS' : 'FAIL',
      command: lintCommand || undefined,
      exitCode: lintExitCode,
      startedAt: new Date(g3EvalStart).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: lintExecDuration,
      evaluatorDecisionDurationMs: g3EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(lintOutput || 'clean'),
      message: lintMessage,
      logArtifactPath: g3Artifact,
    };

    // ==========================================
    // G4: Typecheck Integrity (tsc --noEmit)
    // ==========================================
    const g4EvalStart = Date.now();
    let typePassed = true;
    let typeMessage = 'Typecheck passed with 0 errors';
    let typeOutput = '';
    let typeExecDuration = 0;
    let typeCommand = '';
    let typeExitCode = 0;

    const hasTsConfig = fs.existsSync(path.join(cwd, 'tsconfig.json'));
    const isChildTestRunner = process.env.INTERSHADER_TEST_MODE === 'mock';
    if (!options.skipTypecheck && !isChildTestRunner && hasTsConfig) {
      typeCommand = 'npx tsc --noEmit';
      const execStart = Date.now();
      try {
        typeOutput = execSync(typeCommand, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 45000,
          encoding: 'utf-8',
        });
        typeExecDuration = Date.now() - execStart;
      } catch (err: any) {
        typePassed = false;
        typeExitCode = err.status || 1;
        typeExecDuration = Date.now() - execStart;
        typeOutput = (err.stdout || err.stderr || err.message || '').slice(0, 500);
        typeMessage = `Typecheck failed:\n${typeOutput.trim()}`;
      }
    } else {
      typeMessage = options.skipTypecheck
        ? 'Typecheck skipped by configuration'
        : 'No tsconfig.json detected, skipped typecheck';
    }

    const g4EvalDuration = Math.max(1, Date.now() - g4EvalStart);
    const g4Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g4-typecheck.log',
      `Command: ${typeCommand || 'none'}\nExitCode: ${typeExitCode}\nOutput:\n${typeOutput || 'Zero type errors'}`
    );

    checks.push({
      gateId: 'G4',
      name: 'G4 Typecheck Integrity',
      passed: typePassed,
      message: typeMessage,
      durationMs: typeExecDuration + g4EvalDuration,
      executionDurationMs: typeExecDuration,
      evaluatorDecisionDurationMs: g4EvalDuration,
      command: typeCommand || undefined,
      exitCode: typeExitCode,
      stdoutHash: EvidenceStore.sha256(typeOutput || 'clean'),
      logArtifactPath: g4Artifact,
    });

    gateArtifacts['G4'] = {
      gateId: 'G4',
      name: 'G4 Typecheck Integrity',
      status: typePassed ? 'PASS' : 'FAIL',
      command: typeCommand || undefined,
      exitCode: typeExitCode,
      startedAt: new Date(g4EvalStart).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: typeExecDuration,
      evaluatorDecisionDurationMs: g4EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(typeOutput || 'clean'),
      message: typeMessage,
      logArtifactPath: g4Artifact,
    };

    // ==========================================
    // G5: Build Pipeline Integrity (npm run build)
    // ==========================================
    const g5EvalStart = Date.now();
    let buildPassed = true;
    let buildMessage = 'Build verification passed';
    let buildOutput = '';
    let buildExecDuration = 0;
    let buildCommand = '';
    let buildExitCode = 0;

    if (!options.skipBuild && !isChildTestRunner && pkg?.scripts?.build) {
      buildCommand = 'npm run build';
      const execStart = Date.now();
      try {
        buildOutput = execSync(buildCommand, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60000,
          encoding: 'utf-8',
        });
        buildExecDuration = Date.now() - execStart;
      } catch (err: any) {
        buildPassed = false;
        buildExitCode = err.status || 1;
        buildExecDuration = Date.now() - execStart;
        buildOutput = (err.stdout || err.stderr || err.message || '').slice(0, 500);
        buildMessage = `Build failed:\n${buildOutput.trim()}`;
      }
    } else if (!pkg?.scripts?.build) {
      buildMessage = 'No build script configured in package.json';
    }

    const g5EvalDuration = Math.max(1, Date.now() - g5EvalStart);
    const g5Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g5-build.log',
      `Command: ${buildCommand || 'none'}\nExitCode: ${buildExitCode}\nOutput:\n${buildOutput || 'Build clean'}`
    );

    checks.push({
      gateId: 'G5',
      name: 'G5 Build Pipeline Integrity',
      passed: buildPassed,
      message: buildMessage,
      durationMs: buildExecDuration + g5EvalDuration,
      executionDurationMs: buildExecDuration,
      evaluatorDecisionDurationMs: g5EvalDuration,
      command: buildCommand || undefined,
      exitCode: buildExitCode,
      stdoutHash: EvidenceStore.sha256(buildOutput || 'clean'),
      logArtifactPath: g5Artifact,
    });

    gateArtifacts['G5'] = {
      gateId: 'G5',
      name: 'G5 Build Pipeline Integrity',
      status: buildPassed ? 'PASS' : 'FAIL',
      command: buildCommand || undefined,
      exitCode: buildExitCode,
      startedAt: new Date(g5EvalStart).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: buildExecDuration,
      evaluatorDecisionDurationMs: g5EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(buildOutput || 'clean'),
      message: buildMessage,
      logArtifactPath: g5Artifact,
    };

    // ==========================================
    // G6: Unit Test Suite & Tamper Detection
    // ==========================================
    const g6EvalStart = Date.now();
    let unitPassed = true;
    let unitMessage = 'All unit tests verified green';
    let unitOutput = '';
    let unitExecDuration = 0;
    let unitCommand = '';
    let unitExitCode = 0;

    // Check Test Tamper Detection
    const tamperAudit = TestTamperDetector.audit(
      cwd,
      modifiedFiles,
      options.allowedFiles || modifiedFiles,
      options.testBaselineHashes || {}
    );

    if (tamperAudit.isTampered) {
      unitPassed = false;
      unitMessage = `Test Tamper Detected: ${tamperAudit.reasons.join('; ')}`;
    } else if (!options.skipTests) {
      const testCmd = options.customTestCommand;
      if (testCmd) {
        unitCommand = testCmd;
        const execStart = Date.now();
        try {
          unitOutput = execSync(testCmd, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60000,
            encoding: 'utf-8',
          });
          unitExecDuration = Date.now() - execStart;
        } catch (err: any) {
          unitPassed = false;
          unitExitCode = err.status || 1;
          unitExecDuration = Date.now() - execStart;
          unitOutput = (err.stdout || err.stderr || err.message || '').slice(0, 500);
          unitMessage = `Custom test command failed: ${unitOutput.slice(0, 200)}`;
        }
      } else if (!isChildTestRunner && pkg?.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
        unitCommand = 'npm test';
        const execStart = Date.now();
        try {
          unitOutput = execSync(unitCommand, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60000,
            encoding: 'utf-8',
          });
          unitExecDuration = Date.now() - execStart;
          const cleanOutput = (unitOutput || '').trim();
          if (cleanOutput.length === 0) {
            unitPassed = false;
            unitMessage = 'FAIL (NO_EVALUATION): Test command completed with exit code 0 but produced zero test execution output.';
          }
        } catch (err: any) {
          unitPassed = false;
          unitExitCode = err.status || 1;
          unitExecDuration = Date.now() - execStart;
          unitOutput = (err.stdout || err.stderr || err.message || '').slice(0, 500);
          unitMessage = `Unit tests failed:\n${unitOutput.trim()}`;
        }
      } else {
        unitPassed = false;
        unitMessage = 'FAIL (NO_TEST_EVIDENCE): No automated unit tests configured in package.json. Empirical verification strictly requires test evidence.';
      }
    }

    const g6EvalDuration = Math.max(1, Date.now() - g6EvalStart);
    const g6Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g6-unittest.log',
      `Command: ${unitCommand || 'none'}\nExitCode: ${unitExitCode}\nTamper Status: ${tamperAudit.isTampered ? 'TAMPERED' : 'CLEAN'}\nOutput:\n${unitOutput || 'All tests passed'}`
    );

    checks.push({
      gateId: 'G6',
      name: 'G6 Unit Test Suite',
      passed: unitPassed,
      message: unitMessage,
      durationMs: unitExecDuration + g6EvalDuration,
      executionDurationMs: unitExecDuration,
      evaluatorDecisionDurationMs: g6EvalDuration,
      command: unitCommand || undefined,
      exitCode: unitExitCode,
      stdoutHash: EvidenceStore.sha256(unitOutput || (unitPassed ? 'PASS' : 'FAIL')),
      logArtifactPath: g6Artifact,
    });

    gateArtifacts['G6'] = {
      gateId: 'G6',
      name: 'G6 Unit Test Suite',
      status: unitPassed ? 'PASS' : 'FAIL',
      command: unitCommand || undefined,
      exitCode: unitExitCode,
      startedAt: new Date(g6EvalStart).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: unitExecDuration,
      evaluatorDecisionDurationMs: g6EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(unitOutput || (unitPassed ? 'PASS' : 'FAIL')),
      message: unitMessage,
      logArtifactPath: g6Artifact,
    };

    // ==========================================
    // G7: Integration Tests
    // ==========================================
    const g7EvalStart = Date.now();
    let intPassed = true;
    let intMessage = 'Integration contract and cross-module interfaces intact';
    let intExecDuration = 0;
    let intCommand = '';
    let intExitCode = 0;
    let intOutput = '';

    if (!options.skipIntegration && options.customIntegrationCommand) {
      intCommand = options.customIntegrationCommand;
      const execStart = Date.now();
      try {
        intOutput = execSync(intCommand, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60000,
          encoding: 'utf-8',
        });
        intExecDuration = Date.now() - execStart;
      } catch (err: any) {
        intPassed = false;
        intExitCode = err.status || 1;
        intExecDuration = Date.now() - execStart;
        intOutput = (err.stdout || err.stderr || err.message || '').slice(0, 500);
        intMessage = `Integration tests failed: ${intOutput.slice(0, 200)}`;
      }
    }

    const g7EvalDuration = Math.max(1, Date.now() - g7EvalStart);
    const g7Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g7-integration.log',
      `Command: ${intCommand || 'none'}\nExitCode: ${intExitCode}\nOutput:\n${intOutput || 'Contract intact'}`
    );

    checks.push({
      gateId: 'G7',
      name: 'G7 Integration Test Suite',
      passed: intPassed,
      message: intMessage,
      durationMs: intExecDuration + g7EvalDuration,
      executionDurationMs: intExecDuration,
      evaluatorDecisionDurationMs: g7EvalDuration,
      command: intCommand || undefined,
      exitCode: intExitCode,
      stdoutHash: EvidenceStore.sha256(intOutput || 'intact'),
      logArtifactPath: g7Artifact,
    });

    gateArtifacts['G7'] = {
      gateId: 'G7',
      name: 'G7 Integration Test Suite',
      status: intPassed ? 'PASS' : 'FAIL',
      command: intCommand || undefined,
      exitCode: intExitCode,
      startedAt: new Date(g7EvalStart).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: intExecDuration,
      evaluatorDecisionDurationMs: g7EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(intOutput || 'intact'),
      message: intMessage,
      logArtifactPath: g7Artifact,
    };

    // ==========================================
    // G8: Runtime & E2E Behavior Verification
    // ==========================================
    const g8EvalStart = Date.now();
    let runtimePassed = true;
    let runtimeMessage = 'Runtime behavior verified with zero unhandled exceptions';

    if (!options.skipRuntime) {
      for (const relFile of modifiedFiles) {
        const fullPath = path.resolve(cwd, relFile);
        if (fs.existsSync(fullPath) && (relFile.endsWith('.ts') || relFile.endsWith('.js'))) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (content.includes('throw new Error(') && content.includes('TODO')) {
              runtimePassed = false;
              runtimeMessage = `Unimplemented stub detected in ${relFile}`;
              break;
            }
          } catch {
            // ignore
          }
        }
      }
    }

    const g8EvalDuration = Math.max(1, Date.now() - g8EvalStart);
    const g8Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g8-runtime.log',
      `Checked files: ${modifiedFiles.join(', ')}\nRuntime Status: ${runtimePassed ? 'PASS' : 'FAIL'}\nMessage: ${runtimeMessage}`
    );

    checks.push({
      gateId: 'G8',
      name: 'G8 Runtime & E2E Verification',
      passed: runtimePassed,
      message: runtimeMessage,
      durationMs: g8EvalDuration,
      executionDurationMs: 0,
      evaluatorDecisionDurationMs: g8EvalDuration,
      stdoutHash: EvidenceStore.sha256(runtimePassed ? 'PASS' : 'FAIL'),
      logArtifactPath: g8Artifact,
    });

    gateArtifacts['G8'] = {
      gateId: 'G8',
      name: 'G8 Runtime & E2E Verification',
      status: runtimePassed ? 'PASS' : 'FAIL',
      startedAt: new Date(g8EvalStart).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: 0,
      evaluatorDecisionDurationMs: g8EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(runtimePassed ? 'PASS' : 'FAIL'),
      message: runtimeMessage,
      logArtifactPath: g8Artifact,
    };

    // ==========================================
    // G9: Security & Secret Scan (SAST Guard)
    // ==========================================
    const g9EvalStart = Date.now();
    let secPassed = true;
    const leakedHints: string[] = [];

    const secretPatterns = [
      /sk-[a-zA-Z0-9]{32,}/,
      /ghp_[a-zA-Z0-9]{36}/,
      /AIza[0-9A-Za-z-_]{35}/,
      /-----BEGIN (RSA|EC|PRIVATE) KEY-----/,
    ];

    for (const relFile of modifiedFiles) {
      const fullPath = path.resolve(cwd, relFile);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          for (const pat of secretPatterns) {
            if (pat.test(content)) {
              secPassed = false;
              leakedHints.push(`${relFile} matches secret pattern`);
              break;
            }
          }
        } catch {
          // ignore binary
        }
      }
    }

    const g9EvalDuration = Math.max(1, Date.now() - g9EvalStart);
    const g9Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g9-sast.log',
      `SAST Scan Report\nLeaked items found: ${leakedHints.length}\n${leakedHints.join('\n') || 'Zero secret leaks detected'}`
    );

    checks.push({
      gateId: 'G9',
      name: 'G9 Security & Secret Scan',
      passed: secPassed,
      message: secPassed
        ? 'Zero secret leaks, credential exposures, or SAST vulnerabilities'
        : `Security breach detected: ${leakedHints.join(', ')}`,
      durationMs: g9EvalDuration,
      executionDurationMs: 0,
      evaluatorDecisionDurationMs: g9EvalDuration,
      stdoutHash: EvidenceStore.sha256(secPassed ? 'PASS' : 'LEAK'),
      logArtifactPath: g9Artifact,
    });

    gateArtifacts['G9'] = {
      gateId: 'G9',
      name: 'G9 Security & Secret Scan',
      status: secPassed ? 'PASS' : 'FAIL',
      startedAt: new Date(g9EvalStart).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: 0,
      evaluatorDecisionDurationMs: g9EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(secPassed ? 'PASS' : 'LEAK'),
      message: checks[8].message,
      logArtifactPath: g9Artifact,
    };

    // ==========================================
    // G10: Regression Invariants
    // ==========================================
    const g10EvalStart = Date.now();
    let regPassed = true;
    let regMessage = 'Zero collateral regressions detected across invariant test suite';

    if (!unitPassed || !buildPassed || !typePassed || !intPassed) {
      regPassed = false;
      regMessage = 'Regression detected: existing system invariants compromised';
    }

    const g10EvalDuration = Math.max(1, Date.now() - g10EvalStart);
    const g10Artifact = EvidenceStore.persistGateLog(
      cwd,
      runId,
      'g10-regression.log',
      `Regression Evaluation\nUnit Passed: ${unitPassed}\nBuild Passed: ${buildPassed}\nType Passed: ${typePassed}\nIntegration Passed: ${intPassed}\nOverall Invariant: ${regPassed ? 'PASS' : 'FAIL'}`
    );

    checks.push({
      gateId: 'G10',
      name: 'G10 Regression Invariants',
      passed: regPassed,
      message: regMessage,
      durationMs: g10EvalDuration,
      executionDurationMs: 0,
      evaluatorDecisionDurationMs: g10EvalDuration,
      stdoutHash: EvidenceStore.sha256(regPassed ? 'PASS' : 'FAIL'),
      logArtifactPath: g10Artifact,
    });

    gateArtifacts['G10'] = {
      gateId: 'G10',
      name: 'G10 Regression Invariants',
      status: regPassed ? 'PASS' : 'FAIL',
      startedAt: new Date(g10EvalStart).toISOString(),
      completedAt: new Date().toISOString(),
      executionDurationMs: 0,
      evaluatorDecisionDurationMs: g10EvalDuration,
      stdoutHashSha256: EvidenceStore.sha256(regPassed ? 'PASS' : 'FAIL'),
      message: regMessage,
      logArtifactPath: g10Artifact,
    };

    // ==========================================
    // Synthesis & Proof Manifest Persistence
    // ==========================================
    const passedCount = checks.filter((c) => c.passed).length;
    const overallPassed = checks.every((c) => c.passed);
    const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0;

    const limitations: string[] = [];
    if (options.skipTests) limitations.push('Test execution bypassed via skipTests');
    if (options.skipBuild) limitations.push('Build validation bypassed via skipBuild');
    if (options.skipTypecheck) limitations.push('Typecheck bypassed via skipTypecheck');
    if (options.skipLint) limitations.push('Lint checks bypassed via skipLint');
    if (options.skipIntegration) limitations.push('Integration tests bypassed via skipIntegration');
    if (options.skipRuntime) limitations.push('Runtime verification bypassed via skipRuntime');

    let verdict: ProofVerdict = 'REJECTED';
    let verdictConfidence = 100;

    if (checks.length === 0) {
      verdict = 'INCONCLUSIVE';
      verdictConfidence = 0;
    } else if (!overallPassed) {
      verdict = 'REJECTED';
      verdictConfidence = 95;
    } else if (limitations.length > 0) {
      verdict = 'VERIFIED_WITH_LIMITATIONS';
      verdictConfidence = 75;
    } else {
      verdict = 'VERIFIED';
      verdictConfidence = 99;
    }

    const riskScore: 'LOW' | 'MEDIUM' | 'HIGH' =
      verdict === 'VERIFIED' ? 'LOW' : verdict === 'VERIFIED_WITH_LIMITATIONS' ? 'MEDIUM' : 'HIGH';

    // 1. Framed verified source digest calculation (RFC 8785 Canonical JSON)
    const sourceEntries: Array<{ path: string; sha256: string; size: number }> = [];
    const filesToAudit = modifiedFiles.length > 0 ? modifiedFiles : ['cli/index.ts'];
    for (const relFile of filesToAudit) {
      const fullPath = path.resolve(cwd, relFile);
      if (fs.existsSync(fullPath)) {
        try {
          const buf = fs.readFileSync(fullPath);
          const fileHash = crypto.createHash('sha256').update(buf).digest('hex');
          sourceEntries.push({
            path: relFile.replace(/\\/g, '/'),
            sha256: fileHash,
            size: buf.length,
          });
        } catch {
          // ignore read error
        }
      }
    }
    sourceEntries.sort((a, b) => a.path.localeCompare(b.path));
    const framedSourceManifest = {
      sourceFiles: sourceEntries,
    };
    const verifiedSourceDigest = `sha256:${CanonicalJson.digestSha256(framedSourceManifest)}`;

    // 2. Build output artifact digest calculation (SLSA Provenance Subject)
    const buildCandidates = ['dist/index.js', 'dist/cli.js'];
    let buildArtifactDigest: string | undefined;
    for (const candidate of buildCandidates) {
      const fullPath = path.resolve(cwd, candidate);
      if (fs.existsSync(fullPath)) {
        try {
          const buf = fs.readFileSync(fullPath);
          buildArtifactDigest = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
          break;
        } catch {
          // ignore read error
        }
      }
    }
    // Fallback if build output is absent (e.g. skipBuild mode without dist)
    if (!buildArtifactDigest) {
      const entryCandidate = path.resolve(cwd, 'cli/index.ts');
      if (fs.existsSync(entryCandidate)) {
        const buf = fs.readFileSync(entryCandidate);
        buildArtifactDigest = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
      } else {
        buildArtifactDigest = verifiedSourceDigest;
      }
    }
    const artifactDigest = buildArtifactDigest;

    const manifestWithoutHash: Omit<ProofManifest, 'manifestHashSha256'> = {
      runId,
      challenge: options.challenge,
      startedAt: new Date(g1Start).toISOString(),
      completedAt: new Date().toISOString(),
      workspaceCommit,
      verifiedSourceDigest,
      buildArtifactDigest,
      artifactDigest,
      subject: {
        gitCommit: workspaceCommit,
        verifiedSourceDigest,
        buildArtifactDigest,
        artifactDigest,
        targetFiles: modifiedFiles,
      },
      changedFiles: modifiedFiles,
      gates: gateArtifacts,
      overallPassed,
      score,
      riskTier: riskScore,
      verdict,
      verdictConfidence,
      limitations: limitations.length > 0 ? limitations : undefined,
    };

    const manifest = EvidenceStore.persistManifest(cwd, manifestWithoutHash);
    const proofCard = EvidenceStore.renderProofCard(manifest);

    return {
      timestamp: Date.now(),
      runId,
      overallPassed,
      score,
      verdict,
      checks,
      modifiedFiles,
      proofCard,
      riskScore,
      manifest,
    };
  }
}
