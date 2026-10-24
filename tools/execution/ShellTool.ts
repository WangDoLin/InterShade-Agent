import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { exec } from 'child_process';

import { GitSafetyGuard } from '../../security/GitSafetyGuard.js';
import { WindowsCommandSemantics } from '../../security/WindowsCommandSemantics.js';

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+[\/\\]/i,
  /drop\s+database/i,
  /format\s+[c-z]:/i,
  /git\s+reset\s+--hard/i,
  /dd\s+if=/i,
  /:(){ :|:& };:/,
];

export class ShellTool extends BaseTool<{ command: string; timeoutMs?: number }, string> {
  readonly name = 'run_shell_command';
  readonly description = 'Execute a shell command within the terminal environment and capture stdout/stderr.';
  readonly isReadOnly = false;
  readonly isDestructive = true;
  readonly requiresPermission = true;

  readonly inputSchema = z.object({
    command: z.string().describe('The shell command to execute (e.g. "npm test", "git status")'),
    timeoutMs: z.number().optional().describe('Maximum execution timeout in milliseconds (default: 60000ms)'),
  });

  async execute(args: { command: string; timeoutMs?: number }, context: ToolExecutionContext): Promise<string> {
    if (context.permissionMode === 'plan') {
      throw new Error('[PLAN MODE ACTIVE]: Currently in Plan Mode (Read-Only). Shell execution is disabled.');
    }

    // Git Safety Check (bare repo & hook injection guard)
    const gitSafety = GitSafetyGuard.validateShellCommand(args.command);
    if (!gitSafety.isSafe) {
      throw new Error(gitSafety.reason);
    }

    const isDangerous = DANGEROUS_PATTERNS.some((p) => p.test(args.command));
    if (isDangerous && context.permissionMode !== 'bypassPermissions' && context.askConfirmation) {
      const confirmed = await context.askConfirmation(
        `Confirm execution of potentially destructive command: "${args.command}"?`
      );
      if (!confirmed) {
        throw new Error(`Execution rejected by user for command: "${args.command}".`);
      }
    }

    const timeout = args.timeoutMs || 60000;
    const shellToUse = process.platform === 'win32' ? 'powershell.exe' : undefined;

    return new Promise((resolve, reject) => {
      const child = exec(
        args.command,
        {
          cwd: context.cwd,
          timeout,
          maxBuffer: 5 * 1024 * 1024,
          windowsHide: true,
          shell: shellToUse,
        },
        (error, stdout, stderr) => {
          const rawStdout = stdout || '';
          const rawStderr = stderr || '';
          const exitCode = error ? (error.code as number) || 1 : 0;

          // Normalize Windows exit code semantics (e.g. rg/findstr exit 1 = no match, robocopy 0-7 = success)
          const semantic = WindowsCommandSemantics.evaluate(args.command, exitCode, rawStdout, rawStderr);

          if (!semantic.isError) {
            let output = rawStdout.trim();
            if (semantic.message && !output) {
              output = semantic.message;
            }
            resolve(output || '[Command completed successfully]');
            return;
          }

          let failureResult = '';
          if (rawStdout.trim()) {
            failureResult += `${rawStdout.trim()}\n`;
          }
          if (rawStderr.trim()) {
            failureResult += `[STDERR]:\n${rawStderr.trim()}\n`;
          }
          failureResult += `[Exit code ${exitCode}]: ${semantic.message || error?.message || 'Command failed'}`;
          resolve(failureResult.trim());
        }
      );

      if (context.signal) {
        context.signal.addEventListener('abort', () => {
          child.kill('SIGTERM');
          reject(new Error(`Command "${args.command}" was aborted.`));
        });
      }
    });
  }
}
