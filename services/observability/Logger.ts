import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ensureDataDir } from '../../config/index.js';
import { SecretScrubber } from '../../security/SecretScrubber.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  event: string;
  sessionId?: string;
  traceId?: string;
  data?: Record<string, unknown>;
}

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB per rotated file

/**
 * Local-first structured JSONL Logger with traceId propagation and mandatory SecretScrubber filtering (§C4.2).
 */
export class Logger {
  private static customLogDir: string | null = null;
  private static maxBytes = DEFAULT_MAX_LOG_BYTES;

  static setLogDirectory(dirPath: string | null): void {
    this.customLogDir = dirPath;
  }

  static createTraceId(): string {
    return `tr_${crypto.randomBytes(8).toString('hex')}`;
  }

  static log(entry: Omit<StructuredLogEntry, 'ts'> & { ts?: string }): StructuredLogEntry {
    const fullEntry: StructuredLogEntry = {
      ts: entry.ts ?? new Date().toISOString(),
      level: entry.level,
      component: SecretScrubber.sanitize(entry.component),
      event: SecretScrubber.sanitize(entry.event),
      ...(entry.sessionId ? { sessionId: SecretScrubber.sanitize(entry.sessionId) } : {}),
      ...(entry.traceId ? { traceId: SecretScrubber.sanitize(entry.traceId) } : {}),
      ...(entry.data ? { data: SecretScrubber.scrubObject(entry.data) } : {}),
    };

    try {
      const logDir = this.customLogDir ?? path.join(ensureDataDir(config.dataDir), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'intershader.jsonl');

      if (fs.existsSync(logPath)) {
        const stat = fs.statSync(logPath);
        if (stat.size >= this.maxBytes) {
          const rotatedPath = path.join(logDir, 'intershader.1.jsonl');
          try {
            fs.renameSync(logPath, rotatedPath);
          } catch {
            // Ignore rotation race
          }
        }
      }

      fs.appendFileSync(logPath, JSON.stringify(fullEntry) + '\n', 'utf8');
    } catch {
      // Never crash application flow if local disk log write fails
    }

    return fullEntry;
  }

  static info(
    component: string,
    event: string,
    opts?: { sessionId?: string; traceId?: string; data?: Record<string, unknown> }
  ): StructuredLogEntry {
    return this.log({ level: 'info', component, event, ...opts });
  }

  static warn(
    component: string,
    event: string,
    opts?: { sessionId?: string; traceId?: string; data?: Record<string, unknown> }
  ): StructuredLogEntry {
    return this.log({ level: 'warn', component, event, ...opts });
  }

  static error(
    component: string,
    event: string,
    err?: unknown,
    opts?: { sessionId?: string; traceId?: string; data?: Record<string, unknown> }
  ): StructuredLogEntry {
    const errMessage =
      err instanceof Error
        ? SecretScrubber.scrubError(err).message
        : err !== undefined
        ? SecretScrubber.sanitize(String(err))
        : undefined;
    return this.log({
      level: 'error',
      component,
      event,
      ...opts,
      data: {
        ...opts?.data,
        ...(errMessage ? { error: errMessage } : {}),
      },
    });
  }
}
