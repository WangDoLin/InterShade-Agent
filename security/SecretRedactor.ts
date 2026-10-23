import { SecretScrubber } from './SecretScrubber.js';

/**
 * @deprecated Use `SecretScrubber` from `security/SecretScrubber.js` instead (NEXT-B-07).
 * Maintained as a thin compatibility wrapper delegating to the unified SecretScrubber engine.
 */
export class SecretRedactor {
  /**
   * Scans and sanitizes sensitive secrets from string content
   */
  static redact(content: string): { sanitized: string; redactedCount: number; matchedTypes: string[] } {
    if (!content) return { sanitized: '', redactedCount: 0, matchedTypes: [] };
    const result = SecretScrubber.scrub(content);
    return {
      sanitized: result.text,
      redactedCount: result.redactedCount,
      matchedTypes: result.matchedRuleNames,
    };
  }

  /**
   * Fast check if a string contains any secret
   */
  static containsSecret(content: string): boolean {
    return SecretScrubber.containsSecret(content);
  }
}
