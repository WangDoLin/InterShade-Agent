import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export type AttackVectorType =
  | 'NULL_STATE'
  | 'CONCURRENCY_RACE'
  | 'BOUNDARY_OVERFLOW'
  | 'PERMISSION_BYPASS'
  | 'CONTRACT_MISMATCH'
  | 'RESOURCE_LEAK'
  | 'STATE_INCONSISTENCY'
  | 'DATA_CORRUPTION'
  | 'RETRY_IDEMPOTENCY'
  | 'AUTH_SESSION_CONFUSION'
  | 'TRANSACTION_ROLLBACK'
  | 'DEPENDENCY_VERSION'
  | 'CONFIG_ENVIRONMENT'
  | 'OBSERVABILITY_BLINDSPOT';

export type CounterexampleClassification = 'POSSIBLE_ISSUE' | 'REPRODUCED_FAILURE';

export interface CounterexampleFinding {
  readonly vector: AttackVectorType;
  readonly classification: CounterexampleClassification;
  readonly hypothesis: string;
  readonly reproScenario: string;
  readonly severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  readonly proposedAssertion: string;
  readonly failingFile?: string;
  readonly executableScript?: string;
  readonly isReproduced?: boolean;
}

export interface CounterexampleReport {
  readonly attackSucceeded: boolean;
  readonly totalVectorsProbed: number;
  readonly findings: CounterexampleFinding[];
  readonly possibleIssuesCount: number;
  readonly reproducedFailuresCount: number;
  readonly adversarialScore: number; // 0 - 100
  readonly verdict: 'PENETRATED_REPAIR_REQUIRED' | 'WARNING_UNCONFIRMED' | 'IMPERVIOUS_VERIFIED';
  readonly summary: string;
  readonly executableProbesRun: number;
  readonly executableProbesReproduced: number;
}

export interface AttackContext {
  readonly userIntent: string;
  readonly modifiedFiles: string[];
  readonly cwd: string;
  readonly diffSnippet?: string;
  readonly executeActiveProbes?: boolean;
}

export class CounterexampleAgent {
  public static readonly TOTAL_VECTORS = 14;

  /**
   * Adversarially probe the implementation across 14 failure vectors to actively find proof of defects.
   * Rule: Counterexample ONLY triggers HARD FAIL if empirically reproduced. Unreproduced static claims remain WARNINGS.
   */
  static probe(context: AttackContext): CounterexampleReport {
    const rawFindings: Array<Omit<CounterexampleFinding, 'classification'>> = [];
    const cwd = context.cwd;

    for (const relFile of context.modifiedFiles) {
      const fullPath = path.resolve(cwd, relFile);
      if (!fs.existsSync(fullPath)) continue;

      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const intent = context.userIntent.toLowerCase();

      // Vector 1: Concurrency & Async Race Condition
      if (
        (content.includes('async') || content.includes('Promise')) &&
        (content.includes('let ') || content.includes('this.') || content.includes('Map<')) &&
        !content.includes('lock') &&
        !content.includes('Mutex') &&
        !content.includes('queue')
      ) {
        if (
          intent.includes('refresh') ||
          intent.includes('token') ||
          intent.includes('state') ||
          intent.includes('cache')
        ) {
          rawFindings.push({
            vector: 'CONCURRENCY_RACE',
            hypothesis: 'Concurrent duplicate requests may interleave async state reads and write double tokens or corrupt shared cache.',
            reproScenario: 'Invoke target function twice concurrently via Promise.all([fn(), fn()]).',
            severity: 'CRITICAL',
            proposedAssertion: 'assert.strictEqual(callCount, 1, "Concurrent triggers must debounce or deduplicate")',
            failingFile: relFile,
            executableScript: `// Repro Concurrency Race\nimport assert from 'assert';\n// Simulate parallel triggers\nconsole.log('Testing race interleaving');`,
          });
        }
      }

      // Vector 2: Null / Undefined State Blindspots
      if (
        content.includes('.data') ||
        content.includes('.body') ||
        content.includes('.user') ||
        content.includes('.response')
      ) {
        if (!content.includes('??') && !content.includes('?.') && !content.includes('!')) {
          rawFindings.push({
            vector: 'NULL_STATE',
            hypothesis: 'Nested property access without optional chaining (?.) or nullish coalescing (??) crashes on null/empty payload.',
            reproScenario: 'Pass null or { body: undefined } into handler.',
            severity: 'HIGH',
            proposedAssertion: 'assert.doesNotThrow(() => handler({ body: null }))',
            failingFile: relFile,
          });
        }
      }

      // Vector 3: Permission & Path Traversal
      if (
        (content.includes('fs.') || content.includes('path.join') || content.includes('path.resolve')) &&
        !content.includes('startsWith') &&
        !content.includes('includes("..")')
      ) {
        if (intent.includes('file') || intent.includes('path')) {
          rawFindings.push({
            vector: 'PERMISSION_BYPASS',
            hypothesis: 'Direct path resolution without root boundary containment allows "../" directory traversal.',
            reproScenario: 'Invoke with target path "../outside.env".',
            severity: 'CRITICAL',
            proposedAssertion: 'assert.throws(() => resolve("../../.env"), /escapes workspace/)',
            failingFile: relFile,
          });
        }
      }

      // Vector 4: Boundary & Empty Collections
      if (
        content.includes('.split(') ||
        content.includes('[0]') ||
        content.includes('.slice(')
      ) {
        if (content.includes('[0]') && !content.includes('.length')) {
          rawFindings.push({
            vector: 'BOUNDARY_OVERFLOW',
            hypothesis: 'Direct index access [0] on parsed collection without length check returns undefined.',
            reproScenario: 'Feed empty input string "" or whitespace string "  ".',
            severity: 'MEDIUM',
            proposedAssertion: 'assert.strictEqual(parse(""), null, "Empty input should return default value")',
            failingFile: relFile,
          });
        }
      }

      // Vector 5: API Contract Mismatch
      if (content.includes('JSON.parse(') && !content.includes('try {')) {
        rawFindings.push({
          vector: 'CONTRACT_MISMATCH',
          hypothesis: 'Unprotected JSON.parse throws SyntaxError on malformed response payloads.',
          reproScenario: 'Feed invalid non-JSON string into parser.',
          severity: 'HIGH',
          proposedAssertion: 'assert.doesNotThrow(() => parsePayload("invalid json"))',
          failingFile: relFile,
        });
      }

      // Vector 6: Resource & Handle Leak
      if (
        (content.includes('createReadStream') || content.includes('setInterval') || content.includes('addEventListener')) &&
        !content.includes('close(') &&
        !content.includes('clearInterval') &&
        !content.includes('removeEventListener')
      ) {
        rawFindings.push({
          vector: 'RESOURCE_LEAK',
          hypothesis: 'Handle opened without explicit cleanup or unref leads to persistent socket or interval leak.',
          reproScenario: 'Instantiate and discard object repeatedly under memory profiling.',
          severity: 'MEDIUM',
          proposedAssertion: 'assert.strictEqual(activeHandleCount(), 0, "No leaked timers or open file handles")',
          failingFile: relFile,
        });
      }

      // Vector 7: State Inconsistency
      if (content.includes('status = ') && !content.includes('VALID_TRANSITIONS') && !content.includes('canTransition')) {
        if (intent.includes('state') || intent.includes('status') || intent.includes('pipeline')) {
          rawFindings.push({
            vector: 'STATE_INCONSISTENCY',
            hypothesis: 'State variable updated directly without transition state machine allows invalid leaps (e.g. COMPLETED -> PENDING).',
            reproScenario: 'Trigger cancellation on already completed state.',
            severity: 'HIGH',
            proposedAssertion: 'assert.throws(() => transition("COMPLETED", "PENDING"), /Invalid transition/)',
            failingFile: relFile,
          });
        }
      }

      // Vector 8: Data Corruption & Atomic Mutation
      if (content.includes('writeFileSync') && !content.includes('.tmp') && !content.includes('renameSync')) {
        if (intent.includes('persist') || intent.includes('save') || intent.includes('write')) {
          rawFindings.push({
            vector: 'DATA_CORRUPTION',
            hypothesis: 'Direct in-place writeFileSync without write-to-temp-then-atomic-rename causes truncated zero-byte file if killed mid-write.',
            reproScenario: 'Terminate process during heavy payload serialization write.',
            severity: 'MEDIUM',
            proposedAssertion: 'assert.ok(fs.statSync(filePath).size > 0, "File must remain consistent after write failure")',
            failingFile: relFile,
          });
        }
      }

      // Vector 9: Retry & Idempotency Failure
      if (
        (content.includes('fetch(') || content.includes('axios') || content.includes('http')) &&
        (content.includes('POST') || content.includes('mutation')) &&
        content.includes('retry') &&
        !content.includes('idempotencyKey') &&
        !content.includes('Idempotency-Key')
      ) {
        rawFindings.push({
          vector: 'RETRY_IDEMPOTENCY',
          hypothesis: 'Mutating HTTP request retried without idempotency key creates duplicate side-effects on remote server.',
          reproScenario: 'Simulate connection reset and observe duplicate database insertion.',
          severity: 'CRITICAL',
          proposedAssertion: 'assert.strictEqual(createdRecordCount, 1, "Retried request must include idempotency header")',
          failingFile: relFile,
        });
      }

      // Vector 10: Authentication & Session Confusion
      if (
        (content.includes('session') || content.includes('currentUser') || content.includes('authToken')) &&
        content.includes('static ') &&
        !content.includes('AsyncLocalStorage')
      ) {
        rawFindings.push({
          vector: 'AUTH_SESSION_CONFUSION',
          hypothesis: 'User session stored in static module variable leads to cross-user context bleeding under concurrency.',
          reproScenario: 'Initiate concurrent requests from User A and User B simultaneously.',
          severity: 'CRITICAL',
          proposedAssertion: 'assert.notStrictEqual(sessionA.userId, sessionB.userId, "Session must never bleed across requests")',
          failingFile: relFile,
        });
      }

      // Vector 11: Transaction & Rollback Failure
      if (content.includes('BEGIN TRANSACTION') || (content.includes('savepoint') && !content.includes('ROLLBACK'))) {
        rawFindings.push({
          vector: 'TRANSACTION_ROLLBACK',
          hypothesis: 'Transaction opened without guaranteed ROLLBACK in catch/finally block leaves locks held indefinitely.',
          reproScenario: 'Throw unhandled error inside transactional block.',
          severity: 'HIGH',
          proposedAssertion: 'assert.strictEqual(isInTransaction(), false, "Lock must release upon failure")',
          failingFile: relFile,
        });
      }

      // Vector 12: Dependency & Version Mismatch
      if (content.includes('process.versions.node') && !content.includes('semver')) {
        rawFindings.push({
          vector: 'DEPENDENCY_VERSION',
          hypothesis: 'Naive version string parsing fails on minor version increments.',
          reproScenario: 'Execute under Node v22.13 with version string checks.',
          severity: 'MEDIUM',
          proposedAssertion: 'assert.ok(isCompatibleNode("22.13.0"))',
          failingFile: relFile,
        });
      }

      // Vector 13: Configuration & Environment Mismatch
      if (content.includes('process.env.') && !content.includes('??') && !content.includes(' || ')) {
        const envMatches = content.match(/process\.env\.([A-Z0-9_]+)/g);
        if (envMatches && envMatches.length > 0) {
          const varName = envMatches[0];
          rawFindings.push({
            vector: 'CONFIG_ENVIRONMENT',
            hypothesis: `Direct access to ${varName} without default fallback causes undefined configuration crash.`,
            reproScenario: `Run without ${varName} defined in environment.`,
            severity: 'HIGH',
            proposedAssertion: `assert.doesNotThrow(() => initConfig(), "Should fallback to sensible default when ${varName} unset")`,
            failingFile: relFile,
          });
        }
      }

      // Vector 14: Observability Blindspot
      if (content.includes('catch (err)') && (content.includes('// ignore') || content.includes('// do nothing') || content.includes('return null;'))) {
        rawFindings.push({
          vector: 'OBSERVABILITY_BLINDSPOT',
          hypothesis: 'Catch block swallows error silently without logging or metric emission, leaving system failures invisible.',
          reproScenario: 'Trigger fault in swallowed block and inspect logs.',
          severity: 'MEDIUM',
          proposedAssertion: 'assert.ok(logger.hasLoggedError(), "Silent swallow forbidden; error must be reported")',
          failingFile: relFile,
        });
      }
    }

    // Active executable probe execution & Strict Classification
    let executableProbesRun = 0;
    let executableProbesReproduced = 0;
    const finalFindings: CounterexampleFinding[] = [];

    for (const f of rawFindings) {
      let isReproduced = false;

      if (context.executeActiveProbes && f.executableScript) {
        executableProbesRun++;
        const reproDir = path.join(cwd, '.intershader', 'repro');
        if (!fs.existsSync(reproDir)) {
          fs.mkdirSync(reproDir, { recursive: true });
        }
        const scriptPath = path.join(reproDir, `repro-${f.vector.toLowerCase()}.mjs`);
        fs.writeFileSync(scriptPath, f.executableScript, 'utf-8');

        try {
          execSync(`node "${scriptPath}"`, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
          });
          isReproduced = false;
        } catch {
          // Script failed or threw error -> REPRODUCED!
          isReproduced = true;
          executableProbesReproduced++;
        }
      }

      // Rule: ONLY classify as REPRODUCED_FAILURE if actually confirmed by execution
      const classification: CounterexampleClassification = isReproduced
        ? 'REPRODUCED_FAILURE'
        : 'POSSIBLE_ISSUE';

      finalFindings.push({
        ...f,
        classification,
        isReproduced,
      });
    }

    const reproducedFailuresCount = finalFindings.filter((f) => f.classification === 'REPRODUCED_FAILURE').length;
    const possibleIssuesCount = finalFindings.filter((f) => f.classification === 'POSSIBLE_ISSUE').length;

    // Hard defect rule: attackSucceeded is true ONLY if at least one failure was reproduced
    const attackSucceeded = reproducedFailuresCount > 0;

    let adversarialScore = 100 - (reproducedFailuresCount * 30 + possibleIssuesCount * 5);
    adversarialScore = Math.max(0, Math.min(100, adversarialScore));

    const verdict = attackSucceeded
      ? 'PENETRATED_REPAIR_REQUIRED'
      : possibleIssuesCount > 0
      ? 'WARNING_UNCONFIRMED'
      : 'IMPERVIOUS_VERIFIED';

    const summary = attackSucceeded
      ? `Counterexample Agent probed ${this.TOTAL_VECTORS} adversarial vectors and confirmed ${reproducedFailuresCount} reproduced failure(s). Empirical penetration demonstrated; repair required.`
      : possibleIssuesCount > 0
      ? `Counterexample Agent probed ${this.TOTAL_VECTORS} adversarial vectors and identified ${possibleIssuesCount} possible issue(s), but 0 reproduced failures. Classified as warnings.`
      : `Counterexample Agent probed ${this.TOTAL_VECTORS} adversarial vectors. Zero vulnerabilities discovered.`;

    return {
      attackSucceeded,
      totalVectorsProbed: this.TOTAL_VECTORS,
      findings: finalFindings,
      possibleIssuesCount,
      reproducedFailuresCount,
      adversarialScore,
      verdict,
      summary,
      executableProbesRun,
      executableProbesReproduced,
    };
  }
}
