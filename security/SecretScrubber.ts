import { SECRET_PATTERN_RULES, type SecretPatternRule } from './secret-patterns.js';

export interface ScrubResult {
  text: string;
  redactedCount: number;
  matchedRuleIds: string[];
  matchedRuleNames: string[];
}

/**
 * Unified SecretScrubber (NEXT-B-06..08).
 * Combines audit-counted pattern scrubbing (legacy SecretRedactor) with dynamic secret
 * registration, boundary-aware short secret matching, and recursive object/Error sanitization
 * (legacy SecretSanitizer).
 */
export class SecretScrubber {
  private static readonly dynamicSecrets = new Set<string>();

  /**
   * Registers a runtime secret (3+ characters) for dynamic redaction across all outbound surfaces.
   */
  static registerSecret(secret: string): void {
    if (secret && typeof secret === 'string' && secret.trim().length >= 3) {
      this.dynamicSecrets.add(secret.trim());
    }
  }

  /**
   * Alias for registerSecret (NEXT-B-06).
   */
  static registerDynamicSecret(secret: string): void {
    this.registerSecret(secret);
  }

  /**
   * Clears all dynamically registered secrets (primarily used in test teardown).
   */
  static clearRegisteredSecrets(): void {
    this.dynamicSecrets.clear();
  }

  /**
   * Returns a snapshot of currently registered dynamic secrets count.
   */
  static getRegisteredSecretCount(): number {
    return this.dynamicSecrets.size;
  }

  /**
   * Scrubs text against all static pattern rules and dynamically registered secrets,
   * returning both the sanitized string and audit metadata (`redactedCount`, `matchedRuleIds`).
   */
  static scrub(text: string): ScrubResult {
    if (!text || typeof text !== 'string') {
      return {
        text: text ?? '',
        redactedCount: 0,
        matchedRuleIds: [],
        matchedRuleNames: [],
      };
    }

    let sanitized = text;
    let redactedCount = 0;
    const matchedIds = new Set<string>();
    const matchedNames = new Set<string>();

    // Note: URL embedded credentials must run before short dynamic secrets when a short secret is inside user:pass@
    const urlRule = SECRET_PATTERN_RULES.find((r) => r.id === 'url-embedded-credentials');
    if (urlRule) {
      const urlRegex = new RegExp(urlRule.pattern.source, urlRule.pattern.flags);
      const urlMatches = sanitized.match(urlRegex);
      if (urlMatches && urlMatches.length > 0) {
        redactedCount += urlMatches.length;
        matchedIds.add(urlRule.id);
        matchedNames.add(urlRule.name);
        sanitized = sanitized.replace(urlRegex, urlRule.mask);
      }
    }

    // Tier 1: Dynamically registered secrets
    for (const secret of this.dynamicSecrets) {
      if (secret.length >= 8) {
        if (sanitized.includes(secret)) {
          const occurrences = sanitized.split(secret).length - 1;
          redactedCount += occurrences;
          matchedIds.add('registered-dynamic-secret');
          matchedNames.add('Registered Secret');
          sanitized = sanitized.replaceAll(secret, '[REDACTED_REGISTERED_SECRET]');
        }
      } else {
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lookaroundRegex = new RegExp(`(?<=^|[^a-zA-Z0-9_])${escaped}(?=[^a-zA-Z0-9_]|$)`, 'g');
        const matches = sanitized.match(lookaroundRegex);
        if (matches && matches.length > 0) {
          redactedCount += matches.length;
          matchedIds.add('registered-dynamic-secret');
          matchedNames.add('Registered Secret');
          sanitized = sanitized.replace(lookaroundRegex, '[REDACTED_REGISTERED_SECRET]');
        }
      }
    }

    // Tier 2: Static pattern rules
    for (const rule of SECRET_PATTERN_RULES) {
      if (rule.id === 'url-embedded-credentials') continue;
      const regexCopy = new RegExp(rule.pattern.source, rule.pattern.flags);
      const matches = sanitized.match(regexCopy);
      if (matches && matches.length > 0) {
        redactedCount += matches.length;
        matchedIds.add(rule.id);
        matchedNames.add(rule.name);
        sanitized = sanitized.replace(regexCopy, rule.mask);
      }
    }

    return {
      text: sanitized,
      redactedCount,
      matchedRuleIds: Array.from(matchedIds),
      matchedRuleNames: Array.from(matchedNames),
    };
  }

  /**
   * Convenience wrapper returning only the scrubbed text string.
   */
  static sanitize(text: string): string {
    if (!text || typeof text !== 'string') return text;
    return this.scrub(text).text;
  }

  /**
   * Deeply scrubs all string fields inside an object or array (cycle-safe).
   */
  static scrubObject<T>(value: T, seen = new WeakSet<object>()): T {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string') {
      return this.sanitize(value) as unknown as T;
    }
    if (typeof value === 'object') {
      if (seen.has(value as object)) {
        return '[Circular]' as unknown as T;
      }
      seen.add(value as object);
      if (Array.isArray(value)) {
        return value.map((item) => this.scrubObject(item, seen)) as unknown as T;
      }
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.scrubObject(val, seen);
      }
      return result as T;
    }
    return value;
  }

  /**
   * Recursively scrubs an Error instance including message, stack, cause, and AggregateError children.
   */
  static scrubError<T extends Error>(err: T): T {
    if (!err) return err;
    if (typeof err.message === 'string') {
      const sanitized = this.sanitize(err.message);
      try {
        err.message = sanitized;
      } catch {
        try {
          Object.defineProperty(err, 'message', {
            value: sanitized,
            writable: true,
            configurable: true,
            enumerable: false,
          });
        } catch {
          // Non-configurable property
        }
      }
    }
    if (typeof err.stack === 'string') {
      const sanitizedStack = this.sanitize(err.stack);
      try {
        err.stack = sanitizedStack;
      } catch {
        try {
          Object.defineProperty(err, 'stack', {
            value: sanitizedStack,
            writable: true,
            configurable: true,
            enumerable: false,
          });
        } catch {
          // Non-configurable property
        }
      }
    }
    const anyErr = err as unknown as { cause?: unknown; errors?: unknown[] };
    if (anyErr.cause) {
      if (anyErr.cause instanceof Error) {
        this.scrubError(anyErr.cause);
      } else if (typeof anyErr.cause === 'string') {
        anyErr.cause = this.sanitize(anyErr.cause);
      }
    }
    if (Array.isArray(anyErr.errors)) {
      for (const subErr of anyErr.errors) {
        if (subErr instanceof Error) {
          this.scrubError(subErr);
        }
      }
    }
    return err;
  }

  /**
   * Fast per-call check (without shared RegExp lastIndex state) for whether text contains any secret.
   */
  static containsSecret(text: string): boolean {
    if (!text || typeof text !== 'string') {
      return false;
    }
    for (const secret of this.dynamicSecrets) {
      if (secret.length >= 8) {
        if (text.includes(secret)) return true;
      } else {
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lookaroundRegex = new RegExp(`(?<=^|[^a-zA-Z0-9_])${escaped}(?=[^a-zA-Z0-9_]|$)`);
        if (lookaroundRegex.test(text)) return true;
      }
    }
    for (const rule of SECRET_PATTERN_RULES) {
      const testRegex = new RegExp(rule.pattern.source, rule.pattern.flags);
      if (testRegex.test(text)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Exposes the unified rule catalog for inspection/testing.
   */
  static getRules(): readonly SecretPatternRule[] {
    return SECRET_PATTERN_RULES;
  }
}
