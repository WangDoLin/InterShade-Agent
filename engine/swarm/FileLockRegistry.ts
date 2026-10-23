import path from 'node:path';
import type { FileLease, SwarmRole } from './SwarmTypes.js';
import type { ClaudeAgentRoleType } from '../../services/agent/ClaudeAgentRoles.js';

export class FileLockRegistry {
  private static leases: Map<string, FileLease> = new Map();
  private static sessionScopes: Map<string, string[]> = new Map();

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
   * Acquire an exclusive write lease on a target file
   */
  static acquireLease(
    filePath: string,
    sessionId: string,
    role: SwarmRole | ClaudeAgentRoleType,
    ttlMs: number = 60000
  ): { acquired: boolean; owner?: string; reason?: string } {
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
        return { acquired: true };
      }

      const timeLeftSec = Math.max(1, Math.ceil((active.expiresAt - now) / 1000));
      return {
        acquired: false,
        owner: `${active.role} (Session ${active.sessionId})`,
        reason: `[FILE LEASE CONFLICT]: File "${filePath}" is currently exclusively locked by ${active.role} (Session "${active.sessionId}"). Lease expires in ${timeLeftSec}s.`,
      };
    }

    // Grant new lease
    this.leases.set(normalized, {
      filePath,
      sessionId,
      role,
      grantedAt: now,
      expiresAt: now + ttlMs,
    });

    return { acquired: true };
  }

  /**
   * Release lease on a specific file held by a session
   */
  static releaseLease(filePath: string, sessionId: string): void {
    const normalized = path.resolve(filePath).toLowerCase();
    const active = this.leases.get(normalized);
    if (active && active.sessionId === sessionId) {
      this.leases.delete(normalized);
    }
  }

  /**
   * Release all leases currently held by a given session
   */
  static releaseAllLeasesForSession(sessionId: string): number {
    let releasedCount = 0;
    for (const [key, lease] of this.leases.entries()) {
      if (lease.sessionId === sessionId) {
        this.leases.delete(key);
        releasedCount++;
      }
    }
    this.sessionScopes.delete(sessionId);
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
      }
    }
    return active;
  }

  /**
   * Clear all leases (for test fixtures / teardown)
   */
  static clearAll(): void {
    this.leases.clear();
    this.sessionScopes.clear();
  }
}
