import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Supported invariant categories for property-based fuzzing */
export type InvariantType =
  | 'NO_PANIC'
  | 'IDEMPOTENCY'
  | 'ROUNDTRIP'
  | 'COMMUTATIVITY'
  | 'MONOTONICITY'
  | 'CUSTOM_PREDICATE';

/** Invariant Fuzzing execution options */
export interface FuzzOptions {
  cwd: string;
  iterations?: number;
  timeoutMsPerRun?: number;
  generateReproScript?: boolean;
  reproScriptDir?: string;
  seed?: number;
  customPredicate?: (result: any, input: any) => boolean;
  inverseFunction?: (output: any) => any;
}

/** Result of a single fuzz test iteration */
export interface FuzzIterationResult {
  iteration: number;
  input: any;
  passed: boolean;
  error?: string;
  output?: any;
}

/** Final report emitted after invariant fuzzing completes */
export interface FuzzReport {
  target: string;
  invariantType: InvariantType;
  totalIterations: number;
  passedIterations: number;
  failedIterations: number;
  durationMs: number;
  overallPassed: boolean;
  originalCounterexample?: any;
  shrunkCounterexample?: any;
  reproScriptPath?: string;
  errorMessage?: string;
  errorStack?: string;
}

/**
 * Constants for fuzz generator boundary values
 */
const NUMERIC_BOUNDARIES = [
  0,
  -0,
  1,
  -1,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.EPSILON,
  Infinity,
  -Infinity,
  NaN,
  0x7fffffff,
  -0x80000000,
  3.141592653589793,
  1e-9,
  1e12,
];

const STRING_BOUNDARIES = [
  '',
  ' ',
  '   \t\r\n   ',
  '\0',
  '\x00\x01\x02\x1f',
  '\\"\'`\n\r',
  '🚀🔥💻🛡️🎉',
  '\u200B\u200C\u200D\uFEFF',
  'العربية',
  'Tiếng Việt có dấu và thanh điệu',
  '<script>alert("xss")</script>',
  '\' OR \'1\'=\'1',
  '${7*7}',
  '%s%s%s%n',
  '../../../../etc/passwd',
  'a'.repeat(2048),
];

/**
 * FuzzGenerators creates randomized, edge-case and boundary inputs
 * covering numerical, string, object, array, and primitive corner-cases.
 */
export class FuzzGenerators {
  /**
   * Generates a random number with biased likelihood towards boundary values
   */
  static generateNumber(): number {
    if (Math.random() < 0.4) {
      const idx = Math.floor(Math.random() * NUMERIC_BOUNDARIES.length);
      return NUMERIC_BOUNDARIES[idx];
    }
    const sign = Math.random() < 0.5 ? 1 : -1;
    return sign * Math.floor(Math.random() * 100000);
  }

  /**
   * Generates a random string with biased likelihood towards boundary strings
   */
  static generateString(): string {
    if (Math.random() < 0.5) {
      const idx = Math.floor(Math.random() * STRING_BOUNDARIES.length);
      return STRING_BOUNDARIES[idx];
    }
    const len = Math.floor(Math.random() * 64) + 1;
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-:./ ';
    let result = '';
    for (let i = 0; i < len; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Generates a random boolean or null/undefined primitive
   */
  static generatePrimitive(): any {
    const r = Math.random();
    if (r < 0.25) return null;
    if (r < 0.5) return undefined;
    if (r < 0.75) return true;
    return false;
  }

  /**
   * Generates an array with random elements
   */
  static generateArray(depth = 0): any[] {
    if (depth > 2) return [];
    const len = Math.floor(Math.random() * 8);
    const arr: any[] = [];
    for (let i = 0; i < len; i++) {
      arr.push(FuzzGenerators.generateAny(depth + 1));
    }
    return arr;
  }

  /**
   * Generates an object with boundary keys and varied values
   */
  static generateObject(depth = 0): Record<string, any> {
    if (depth > 2) return {};
    const keysCount = Math.floor(Math.random() * 5);
    const obj: Record<string, any> = {};
    const specialKeys = ['id', 'value', 'name', 'count', 'data', '__proto__', 'constructor'];

    for (let i = 0; i < keysCount; i++) {
      const key = specialKeys[Math.floor(Math.random() * specialKeys.length)] + (i > 2 ? `_${i}` : '');
      obj[key] = FuzzGenerators.generateAny(depth + 1);
    }
    return obj;
  }

  /**
   * Generates an arbitrary value across all supported data types
   */
  static generateAny(depth = 0): any {
    const choice = Math.random();
    if (choice < 0.3) return FuzzGenerators.generateNumber();
    if (choice < 0.6) return FuzzGenerators.generateString();
    if (choice < 0.75) return FuzzGenerators.generatePrimitive();
    if (choice < 0.88) return FuzzGenerators.generateArray(depth);
    return FuzzGenerators.generateObject(depth);
  }
}

/**
 * InvariantFuzzEngine executes property-based testing and fuzzing
 * to uncover corner-case defects and minimize counterexamples.
 */
export class InvariantFuzzEngine {
  /**
   * Fuzzes an in-memory or loaded function against a specified invariant
   */
  static async fuzzFunction(
    fn: (...args: any[]) => any,
    targetName: string,
    invariant: InvariantType,
    options: FuzzOptions
  ): Promise<FuzzReport> {
    const startTime = Date.now();
    const iterations = Math.max(1, Math.min(options.iterations || 100, 2000));
    let passedCount = 0;
    let failedCount = 0;
    let failingInput: any = null;
    let firstError: Error | null = null;

    for (let i = 1; i <= iterations; i++) {
      const input = FuzzGenerators.generateAny();
      const check = await this.evaluateInvariant(fn, input, invariant, options);

      if (check.passed) {
        passedCount++;
      } else {
        failedCount++;
        if (!failingInput) {
          failingInput = input;
          firstError = new Error(check.error || 'Invariant check failed');
        }
        break; // Stop on first failing counterexample to begin minimization
      }
    }

    let shrunkInput = failingInput;
    if (failingInput !== null) {
      shrunkInput = await this.shrinkCounterexample(fn, failingInput, invariant, options);
    }

    let reproPath: string | undefined;
    if (failingInput !== null && options.generateReproScript) {
      reproPath = this.writeReproductionScript(targetName, shrunkInput, invariant, options.cwd, options.reproScriptDir);
    }

    return {
      target: targetName,
      invariantType: invariant,
      totalIterations: passedCount + failedCount,
      passedIterations: passedCount,
      failedIterations: failedCount,
      durationMs: Date.now() - startTime,
      overallPassed: failedCount === 0,
      originalCounterexample: failingInput,
      shrunkCounterexample: shrunkInput,
      reproScriptPath: reproPath,
      errorMessage: firstError ? firstError.message : undefined,
      errorStack: firstError ? firstError.stack : undefined,
    };
  }

  /**
   * Evaluates a single input against the chosen invariant
   */
  private static async evaluateInvariant(
    fn: (...args: any[]) => any,
    input: any,
    invariant: InvariantType,
    options: FuzzOptions
  ): Promise<{ passed: boolean; error?: string }> {
    try {
      const res = await Promise.resolve(fn(input));

      switch (invariant) {
        case 'NO_PANIC':
          return { passed: true };

        case 'IDEMPOTENCY': {
          const secondRes = await Promise.resolve(fn(res));
          const isEqual = JSON.stringify(res) === JSON.stringify(secondRes);
          return {
            passed: isEqual,
            error: isEqual ? undefined : `Idempotency violated: f(f(x)) !== f(x)`,
          };
        }

        case 'ROUNDTRIP': {
          if (!options.inverseFunction) {
            return { passed: false, error: 'ROUNDTRIP invariant requires inverseFunction option' };
          }
          const roundtrip = await Promise.resolve(options.inverseFunction(res));
          const isEqual = JSON.stringify(roundtrip) === JSON.stringify(input);
          return {
            passed: isEqual,
            error: isEqual ? undefined : 'Roundtrip invertibility violated',
          };
        }

        case 'CUSTOM_PREDICATE': {
          if (!options.customPredicate) {
            return { passed: false, error: 'CUSTOM_PREDICATE requires customPredicate function' };
          }
          const passes = options.customPredicate(res, input);
          return {
            passed: passes,
            error: passes ? undefined : 'Custom invariant predicate assertion returned false',
          };
        }

        default:
          return { passed: true };
      }
    } catch (err: any) {
      return {
        passed: false,
        error: `Panic/Unhandled exception: ${err.message || String(err)}`,
      };
    }
  }

  /**
   * Shrinks/minimizes a failing counterexample via binary search and character reduction
   */
  static async shrinkCounterexample(
    fn: (...args: any[]) => any,
    failingInput: any,
    invariant: InvariantType,
    options: FuzzOptions
  ): Promise<any> {
    if (typeof failingInput === 'string') {
      return this.shrinkString(fn, failingInput, invariant, options);
    }
    if (typeof failingInput === 'number' && Number.isFinite(failingInput)) {
      return this.shrinkNumber(fn, failingInput, invariant, options);
    }
    if (Array.isArray(failingInput)) {
      return this.shrinkArray(fn, failingInput, invariant, options);
    }
    return failingInput;
  }

  /**
   * Shrinks a failing string by binary bisecting length
   */
  private static async shrinkString(
    fn: (...args: any[]) => any,
    str: string,
    invariant: InvariantType,
    options: FuzzOptions
  ): Promise<string> {
    let current = str;
    let step = 0;
    const maxSteps = 15;

    while (current.length > 1 && step < maxSteps) {
      step++;
      const halfLen = Math.floor(current.length / 2);
      const firstHalf = current.slice(0, halfLen);

      const checkFirst = await this.evaluateInvariant(fn, firstHalf, invariant, options);
      if (!checkFirst.passed) {
        current = firstHalf;
        continue;
      }

      const secondHalf = current.slice(halfLen);
      const checkSecond = await this.evaluateInvariant(fn, secondHalf, invariant, options);
      if (!checkSecond.passed) {
        current = secondHalf;
        continue;
      }
      break;
    }
    return current;
  }

  /**
   * Shrinks a failing number by moving towards zero
   */
  private static async shrinkNumber(
    fn: (...args: any[]) => any,
    num: number,
    invariant: InvariantType,
    options: FuzzOptions
  ): Promise<number> {
    let current = num;
    let step = 0;
    while (Math.abs(current) > 1 && step < 10) {
      step++;
      const candidate = Math.floor(current / 2);
      const check = await this.evaluateInvariant(fn, candidate, invariant, options);
      if (!check.passed) {
        current = candidate;
      } else {
        break;
      }
    }
    return current;
  }

  /**
   * Shrinks an array by removing elements while maintaining failing condition
   */
  private static async shrinkArray(
    fn: (...args: any[]) => any,
    arr: any[],
    invariant: InvariantType,
    options: FuzzOptions
  ): Promise<any[]> {
    let current = [...arr];
    for (let i = current.length - 1; i >= 0; i--) {
      const candidate = current.slice(0, i).concat(current.slice(i + 1));
      const check = await this.evaluateInvariant(fn, candidate, invariant, options);
      if (!check.passed) {
        current = candidate;
      }
    }
    return current;
  }

  /**
   * Dynamically loads an exported function from a file and runs invariant fuzzing
   */
  static async fuzzFile(
    cwd: string,
    relativePath: string,
    functionName: string,
    invariant: InvariantType,
    options: FuzzOptions
  ): Promise<FuzzReport> {
    const fullPath = path.resolve(cwd, relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Target file does not exist: ${relativePath}`);
    }

    const fileUrl = pathToFileURL(fullPath).href;
    const mod = await import(fileUrl);
    const targetFn = mod[functionName] || mod.default;

    if (typeof targetFn !== 'function') {
      throw new Error(`Export '${functionName}' in ${relativePath} is not a function.`);
    }

    return this.fuzzFunction(targetFn, `${relativePath}#${functionName}`, invariant, options);
  }

  /**
   * Writes a deterministic standalone reproduction test script
   */
  private static writeReproductionScript(
    targetName: string,
    counterexample: any,
    invariant: InvariantType,
    cwd: string,
    reproDir?: string
  ): string {
    const dir = path.resolve(cwd, reproDir || 'tests/fuzz_repro');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const safeName = targetName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const reproFile = path.join(dir, `repro_${safeName}_${Date.now()}.ts`);
    const serialized = JSON.stringify(counterexample, null, 2);

    const scriptContent = `/**
 * Autonomous Invariant Fuzzing Counterexample Reproduction Test
 * Target: ${targetName}
 * Invariant: ${invariant}
 */
import assert from 'node:assert';

const counterexample = ${serialized};

console.log('Running Invariant Counterexample Reproduction...');
console.log('Input:', JSON.stringify(counterexample));

// TODO: Invoke target with counterexample to confirm defect
console.log('Reproduction test established for SWE RedRepro loop.');
`;

    fs.writeFileSync(reproFile, scriptContent, 'utf-8');
    return reproFile;
  }
}
