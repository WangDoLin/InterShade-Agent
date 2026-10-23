import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MiB

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdoutSha256: string;
}

export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessResult>;
  runSync(spec: Omit<ProcessSpec, 'signal'>): ProcessResult;
}

function resolvePlatformCommand(command: string): { cmd: string; useShell: boolean } {
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    return { cmd: `${command}.cmd`, useShell: true };
  }
  return { cmd: command, useShell: false };
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Default Node.js implementation of ProcessRunner (ENG-010).
 * Replaces ad-hoc execSync string interpolation with structured argument arrays,
 * mandatory timeouts, bounded output buffers, and SHA-256 output digests.
 */
export class NodeProcessRunner implements ProcessRunner {
  async run(spec: ProcessSpec): Promise<ProcessResult> {
    const startMs = Date.now();
    const maxBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const { cmd, useShell } = resolvePlatformCommand(spec.command);

    return new Promise<ProcessResult>((resolve) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(cmd, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true,
      });

      const finish = (exitCode: number, sig: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (spec.signal) {
          spec.signal.removeEventListener('abort', onAbort);
        }
        resolve({
          exitCode,
          signal: sig,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          timedOut,
          durationMs: Date.now() - startMs,
          stdoutSha256: sha256Hex(stdoutBuf),
        });
      };

      const onAbort = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Process already exited
        }
        finish(130, 'SIGTERM');
      };

      if (spec.signal) {
        if (spec.signal.aborted) {
          onAbort();
          return;
        }
        spec.signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already exited
        }
      }, spec.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stdoutBuf, 'utf8') < maxBytes) {
          stdoutBuf += chunk.toString('utf8').slice(0, maxBytes - Buffer.byteLength(stdoutBuf, 'utf8'));
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stderrBuf, 'utf8') < maxBytes) {
          stderrBuf += chunk.toString('utf8').slice(0, maxBytes - Buffer.byteLength(stderrBuf, 'utf8'));
        }
      });

      child.on('error', (err) => {
        stderrBuf += `\n${err.message}`;
        finish(1, null);
      });

      child.on('close', (code, sig) => {
        finish(code ?? (timedOut ? 124 : 1), sig);
      });
    });
  }

  runSync(spec: Omit<ProcessSpec, 'signal'>): ProcessResult {
    const startMs = Date.now();
    const maxBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const { cmd, useShell } = resolvePlatformCommand(spec.command);

    const res = spawnSync(cmd, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      encoding: 'utf8',
      timeout: spec.timeoutMs,
      maxBuffer: maxBytes,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
    });

    const stdout = res.stdout ?? '';
    const stderr = res.stderr ?? (res.error ? res.error.message : '');
    const timedOut = Boolean(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');

    return {
      exitCode: res.status ?? (timedOut ? 124 : 1),
      signal: res.signal ?? null,
      stdout,
      stderr,
      timedOut,
      durationMs: Date.now() - startMs,
      stdoutSha256: sha256Hex(stdout),
    };
  }
}

export const defaultProcessRunner: ProcessRunner = new NodeProcessRunner();
