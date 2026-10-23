import fs from 'fs';
import path from 'path';
import { defaultProcessRunner, type ProcessRunner } from './ports/ProcessRunner.js';

export interface VerificationResult {
  passed: boolean;
  checkType: 'ast' | 'typecheck' | 'test' | 'linter';
  errorDetails?: string;
  diagnostics?: Array<{ file: string; line?: number; message: string }>;
  stdoutSha256?: string;
  durationMs?: number;
}

const TYPECHECK_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 45_000;

/**
 * VerificationGate enforces evidence-based task completion.
 * Verifies code syntax and tests via ProcessRunner before declaring tasks done (ENG-010..012).
 */
export class VerificationGate {
  /**
   * Run syntax and TypeScript compile check in the workspace
   */
  static verifyTypeScript(cwd: string, runner: ProcessRunner = defaultProcessRunner): VerificationResult {
    const tsconfigPath = path.join(cwd, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) {
      return { passed: true, checkType: 'typecheck' };
    }

    const result = runner.runSync({
      command: 'npx',
      args: ['tsc', '--noEmit'],
      cwd,
      timeoutMs: TYPECHECK_TIMEOUT_MS,
    });

    if (result.exitCode === 0 && !result.timedOut) {
      return {
        passed: true,
        checkType: 'typecheck',
        stdoutSha256: result.stdoutSha256,
        durationMs: result.durationMs,
      };
    }

    const errorOutput = result.stdout || result.stderr || '';
    const diagnostics = this.parseTscErrors(errorOutput);

    return {
      passed: false,
      checkType: 'typecheck',
      errorDetails: errorOutput.slice(0, 1000),
      diagnostics,
      stdoutSha256: result.stdoutSha256,
      durationMs: result.durationMs,
    };
  }

  /**
   * Run project test suite if package.json has a test script
   */
  static verifyTests(cwd: string, runner: ProcessRunner = defaultProcessRunner): VerificationResult {
    const pkgPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return {
        passed: false,
        checkType: 'test',
        errorDetails: 'NO_TEST_EVIDENCE: package.json not found in workspace. Verification requires verifiable test evidence.',
      };
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (!pkg.scripts?.test || pkg.scripts.test.includes('no test specified')) {
        return {
          passed: false,
          checkType: 'test',
          errorDetails: 'NO_TEST_EVIDENCE: No automated test suite configured in package.json. Policy requires real test evidence.',
        };
      }

      const result = runner.runSync({
        command: 'npm',
        args: ['test'],
        cwd,
        timeoutMs: TEST_TIMEOUT_MS,
      });

      if (result.exitCode !== 0 || result.timedOut) {
        const output = result.stdout || result.stderr || '';
        return {
          passed: false,
          checkType: 'test',
          errorDetails: output.slice(0, 1000),
          stdoutSha256: result.stdoutSha256,
          durationMs: result.durationMs,
        };
      }

      const cleanOut = (result.stdout || '').trim();
      if (cleanOut.length === 0) {
        return {
          passed: false,
          checkType: 'test',
          errorDetails: 'NO_EVALUATION: Test command exited with code 0 but produced zero test execution output.',
          stdoutSha256: result.stdoutSha256,
          durationMs: result.durationMs,
        };
      }

      return {
        passed: true,
        checkType: 'test',
        stdoutSha256: result.stdoutSha256,
        durationMs: result.durationMs,
      };
    } catch (err: unknown) {
      const output = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        checkType: 'test',
        errorDetails: output.slice(0, 1000),
      };
    }
  }

  private static parseTscErrors(output: string): Array<{ file: string; line?: number; message: string }> {
    const lines = output.split('\n');
    const errors: Array<{ file: string; line?: number; message: string }> = [];

    const regex = /^(.+)\((\d+),\d+\):\s+(error\s+TS\d+:\s+.+)$/;

    for (const line of lines) {
      const match = line.match(regex);
      if (match) {
        errors.push({
          file: match[1].trim(),
          line: parseInt(match[2], 10),
          message: match[3].trim(),
        });
      }
    }

    return errors.slice(0, 5);
  }
}
