import { SecretScrubber } from '../../security/SecretScrubber.js';

/**
 * @deprecated Use `SecretScrubber` from `security/SecretScrubber.js` instead (NEXT-B-07).
 * Maintained as a thin compatibility wrapper delegating to the unified SecretScrubber engine.
 */
export class SecretSanitizer {
  static registerSecret(secret: string): void {
    SecretScrubber.registerSecret(secret);
  }

  static clearRegisteredSecrets(): void {
    SecretScrubber.clearRegisteredSecrets();
  }

  static sanitize(text: string): string {
    return SecretScrubber.sanitize(text);
  }

  static sanitizeObject<T>(value: T): T {
    return SecretScrubber.scrubObject(value);
  }

  static sanitizeError<T extends Error>(err: T): T {
    return SecretScrubber.scrubError(err);
  }

  static containsSecret(text: string): boolean {
    return SecretScrubber.containsSecret(text);
  }
}
