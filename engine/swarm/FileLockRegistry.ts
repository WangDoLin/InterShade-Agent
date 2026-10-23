import path from 'node:path';
import type { FileLease, SwarmRole } from './SwarmTypes.js';
import type { ClaudeAgentRoleType } from '../../services/agent/ClaudeAgentRoles.js';

interface LeaseWaiter {
  filePath: string;
  sessionId: string;
  role: SwarmRole | ClaudeAgentRoleType;
  ttlMs: number;
  resolve: (res: { acquired: boolean; fencingToken?: number; owner?: string; reason?: string }) => void;
  timer: NodeJS.Timeout;
}

export class FileLockRegistry {
  private static leases: Map<string, FileLease> = new Map();
  private static sessionScopes: Map<string, string[]> = new Map();
  private static waitQueues: Map<string, LeaseWaiter[]> = new Map();
  private static nextFencingToken = 1;

  /**
   * Register allowed file scopes (glob patterns) for a given session
   */
  static setSessionScope(sessionId: string, scopes: string[]): void {
    this.sessionScopes.set(sessionId, scopes.map((s) => s.trim()));
  }

  /**
   * Clear session scope registration
   */
  static clearSessionScope(sessionId: string): void {
    this.sessionScopes.delete(sessionId);
  }

  /**
   * Check if a file path is permitted within the session's assigned scopes (ENG-042).
   * Enforces strict path segment boundary and glob matching instead of naive substring inclusion.
   */
  static isFileInScope(filePath: string, scopes?: string[]): boolean {
    if (!scopes || scopes.length === 0 || scopes.includes('*')) {
      return true;
    }

    const rawNormalized = filePath.replace(/\\/g, '/').toLowerCase();
    // Reject traversal segments
    const segments = rawNormalized.split('/');
    if (segments.includes('..')) {
      return false;
    }

    const cwdPrefix = process.cwd().replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') + '/';
    const relPath = rawNormalized.startsWith(cwdPrefix)
      ? rawNormalized.slice(cwdPrefix.length)
      : rawNormalized.replace(/^\/+/, '');

    return scopes.some((pattern) => {
      const normalizedPattern = pattern.trim().replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '');
      if (!normalizedPattern) return false;

      if (normalizedPattern === '*' || normalizedPattern === '**' || normalizedPattern === '**/*') {
        return true;
      }

      // Directory recursive glob: "src/services/**" or "src/services/"
      if (normalizedPattern.endsWith('/**') || normalizedPattern.endsWith('/')) {
        const prefix = normalizedPattern.replace(/\/\*\*$/, '').replace(/\/+$/, '');
        return (
          relPath === prefix ||
          relPath.startsWith(prefix + '/') ||
          rawNormalized.includes('/' + prefix + '/')
        );
      }

      // Single-directory wildcard: "src/services/*"
      if (normalizedPattern.endsWith('/*')) {
        const prefix = normalizedPattern.slice(0, -2);
        if (relPath.startsWith(prefix + '/')) {
          const remainder = relPath.slice(prefix.length + 1);
          return remainder.length > 0 && !remainder.includes('/');
        }
        const marker = '/' + prefix + '/';
        const idx = rawNormalized.indexOf(marker);
        if (idx !== -1) {
          const remainder = rawNormalized.slice(idx + marker.length);
          return remainder.length > 0 && !remainder.includes('/');
        }
        return false;
      }

      // Extension wildcard: "*.ts" or "**/*.tsx"
      if (normalizedPattern.startsWith('*.') || normalizedPattern.startsWith('**/*.')) {
        const ext = normalizedPattern.slice(normalizedPattern.lastIndexOf('.'));
        return relPath.endsWith(ext);
      }

      // Exact path or segment-boundary suffix match (never arbitrary substring like "src/api" matching "src/api-evil/x.ts")
      return (
        relPath === normalizedPattern ||
        relPath.startsWith(normalizedPattern + '/') ||
        rawNormalized.endsWith('/' + normalizedPattern) ||
        rawNormalized.includes('/' + normalizedPattern + '/')
      );
    });
  }

  /**
   * Acquire an exclusive write lease on a target file with monotonic fencingToken (NEXT-C-03).
   */
  static acquireLease(
    filePath: string,
    sessionId: string,
    role: SwarmRole | ClaudeAgentRoleType,
    ttlMs: number = 60000
  ): { acquired: boolean; fencingToken?: number; owner?: string; reason?: string } {
    const normalized = path.resolve(filePath).toLowerCase();
    const now = Date.now();

    // Check scope permission if session has registered scopes
    const scopes = this.sessionScopes.get(sessionId);
    if (scopes && scopes.length > 0 && !this.isFileInScope(filePath, scopes)) {
      return {
        acquired: false,
        reason: `[SCOPE VIOLATION]: File "${filePath}" is outside the assigned scope for role "${role}" ([${scopes.join(', ')}]).`,
      };
    }

    // Clean up expired lease if exists
    const existing = this.leases.get(normalized);
    if (existing && existing.expiresAt <= now) {
      this.leases.delete(normalized);
    }

    const active = this.leases.get(normalized);
    if (active) {
      if (active.sessionId === sessionId) {
        // Renew lease for the same session
        active.expiresAt = now + ttlMs;
        return { acquired: true, fencingToken: active.fencingToken };
      }

      const timeLeftSec = Math.max(1, Math.ceil((active.expiresAt - now) / 1000));
      return {
        acquired: false,
        owner: `${active.role} (Session ${active.sessionId})`,
        reason: `[FILE LEASE CONFLICT]: File "${filePath}" is currently exclusively locked by ${active.role} (Session "${active.sessionId}"). Lease expires in ${timeLeftSec}s.`,
      };
    }

    // Grant new lease with strictly increasing fencingToken
    const fencingToken = this.nextFencingToken++;
    this.leases.set(normalized, {
      filePath,
      sessionId,
      role,
      fencingToken,
      grantedAt: now,
      expiresAt: now + ttlMs,
    });

    return { acquired: true, fencingToken };
  }

  /**
   * Renew an active lease via heartbeat (NEXT-C-03).
   * Validates both sessionId and optional fencingToken so stale holders cannot extend an expired lease.
   */
  static heartbeat(
    filePath: string,
    sessionId: string,
    fencingToken?: number,
    ttlMs: number = 60000
  ): { renewed: boolean; expiresAt?: number; fencingToken?: number; reason?: string } {
    const normalized = path.resolve(filePath).toLowerCase();
    const now = Date.now();
    const active = this.leases.get(normalized);

    if (!active || active.expiresAt <= now) {
      if (active) this.leases.delete(normalized);
      return {
        renewed: false,
        reason: `No active lease found on "${filePath}" for session "${sessionId}".`,
      };
    }

    if (active.sessionId !== sessionId) {
      return {
        renewed: false,
        reason: `Lease on "${filePath}" is owned by session "${active.sessionId}", not "${sessionId}".`,
      };
    }

    if (fencingToken !== undefined && active.fencingToken !== fencingToken) {
      return {
        renewed: false,
        reason: `Stale fencingToken ${fencingToken} (current lease token is ${active.fencingToken}).`,
      };
    }

    active.expiresAt = now + ttlMs;
    return {
      renewed: true,
      expiresAt: active.expiresAt,
      fencingToken: active.fencingToken,
    };
  }

  /**
   * Verify that a session still holds the current valid fencingToken for a file before writing (NEXT-C-03).
   */
  static verifyFencingToken(filePath: string, sessionId: string, fencingToken: number): boolean {
    const active = this.getLease(filePath);
    if (!active) return false;
    return active.sessionId === sessionId && active.fencingToken === fencingToken;
  }

  /**
   * Wait in a FIFO queue to acquire a file lease when contended (NEXT-C-04).
   */
  static waitForLease(
    filePath: string,
    sessionId: string,
    role: SwarmRole | ClaudeAgentRoleType,
    options: { timeoutMs?: number; ttlMs?: number } = {}
  ): Promise<{ acquired: boolean; fencingToken?: number; owner?: string; reason?: string }> {
    const ttlMs = options.ttlMs ?? 60000;
    const timeoutMs = options.timeoutMs ?? 5000;

    const immediate = this.acquireLease(filePath, sessionId, role, ttlMs);
    if (immediate.acquired || immediate.reason?.startsWith('[SCOPE VIOLATION]')) {
      return Promise.resolve(immediate);
    }

    const normalized = path.resolve(filePath).toLowerCase();
    return new Promise((resolve) => {
      const queue = this.waitQueues.get(normalized) ?? [];
      this.waitQueues.set(normalized, queue);

      // Also poll on lease expiration in case the holder crashes without calling releaseLease
      const active = this.leases.get(normalized);
      const timeUntilExpiry = active ? Math.max(10, active.expiresAt - Date.now() + 5) : 50;

      const expiryCheckTimer = setTimeout(() => {
        this.drainWaitQueue(normalized);
      }, Math.min(timeUntilExpiry, timeoutMs));
      expiryCheckTimer.unref?.();

      const timer = setTimeout(() => {
        clearTimeout(expiryCheckTimer);
        const q = this.waitQueues.get(normalized);
        if (q) {
          const idx = q.indexOf(waiter);
          if (idx !== -1) q.splice(idx, 1);
          if (q.length === 0) this.waitQueues.delete(normalized);
        }
        const retry = this.acquireLease(filePath, sessionId, role, ttlMs);
        resolve(retry);
      }, timeoutMs);
      timer.unref?.();

      const waiter: LeaseWaiter = {
        filePath,
        sessionId,
        role,
        ttlMs,
        timer,
        resolve: (res) => {
          clearTimeout(timer);
          clearTimeout(expiryCheckTimer);
          resolve(res);
        },
      };

      queue.push(waiter);
    });
  }

  private static drainWaitQueue(normalizedPath: string): void {
    const queue = this.waitQueues.get(normalizedPath);
    if (!queue || queue.length === 0) return;

    while (queue.length > 0) {
      const next = queue[0]!;
      const res = this.acquireLease(next.filePath, next.sessionId, next.role, next.ttlMs);
      if (res.acquired) {
        queue.shift();
        next.resolve(res);
        break;
      } else if (res.reason?.startsWith('[SCOPE VIOLATION]')) {
        queue.shift();
        next.resolve(res);
      } else {
        // Still locked by another active holder
        break;
      }
    }

    if (queue.length === 0) {
      this.waitQueues.delete(normalizedPath);
    }
  }

  /**
   * Release lease on a specific file held by a session and wake FIFO waiters
   */
  static releaseLease(filePath: string, sessionId: string): void {
    const normalized = path.resolve(filePath).toLowerCase();
    const active = this.leases.get(normalized);
    if (active && active.sessionId === sessionId) {
      this.leases.delete(normalized);
      this.drainWaitQueue(normalized);
    }
  }

  /**
   * Release all leases currently held by a given session
   */
  static releaseAllLeasesForSession(sessionId: string): number {
    let releasedCount = 0;
    const releasedPaths: string[] = [];
    for (const [key, lease] of this.leases.entries()) {
      if (lease.sessionId === sessionId) {
        this.leases.delete(key);
        releasedPaths.push(key);
        releasedCount++;
      }
    }
    this.sessionScopes.delete(sessionId);
    for (const key of releasedPaths) {
      this.drainWaitQueue(key);
    }
    return releasedCount;
  }

  /**
   * Query the current lease holder of a file
   */
  static getLease(filePath: string): FileLease | undefined {
    const normalized = path.resolve(filePath).toLowerCase();
    const lease = this.leases.get(normalized);
    if (lease && lease.expiresAt > Date.now()) {
      return lease;
    }
    if (lease && lease.expiresAt <= Date.now()) {
      this.leases.delete(normalized);
      this.drainWaitQueue(normalized);
    }
    return undefined;
  }

  /**
   * List all currently active leases
   */
  static listActiveLeases(): FileLease[] {
    const now = Date.now();
    const active: FileLease[] = [];
    for (const [key, lease] of this.leases.entries()) {
      if (lease.expiresAt > now) {
        active.push(lease);
      } else {
        this.leases.delete(key);
        this.drainWaitQueue(key);
      }
    }
    return active;
  }

  /**
   * Clear all leases (for test fixtures / teardown)
   */
  static clearAll(): void {
    for (const queue of this.waitQueues.values()) {
      for (const w of queue) {
        clearTimeout(w.timer);
      }
    }
    this.waitQueues.clear();
    this.leases.clear();
    this.sessionScopes.clear();
  }
}
