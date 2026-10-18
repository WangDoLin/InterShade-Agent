import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import {
  InvariantFuzzEngine,
  type InvariantType,
  type FuzzReport,
} from '../../engine/verification/InvariantFuzzEngine.js';

export class InvariantFuzzTool extends BaseTool<
  {
    filePath: string;
    functionName: string;
    invariantType?: InvariantType;
    iterations?: number;
    generateReproScript?: boolean;
    customPredicate?: string;
  },
  string
> {
  readonly name = 'invariant_fuzz_test';
  readonly description =
    'Run autonomous property-based fuzzing and invariant testing against any exported module function to uncover corner cases, unhandled panics, idempotency violations, or boundary crashes, and automatically shrink failing counterexamples.';
  readonly isReadOnly = true;
  readonly isDestructive = false;
  readonly requiresPermission = false;

  readonly inputSchema = z.object({
    filePath: z
      .string()
      .describe('Relative path to the TypeScript or JavaScript file containing the function to fuzz.'),
    functionName: z
      .string()
      .describe('Name of the exported function to test (or "default" for default export).'),
    invariantType: z
      .enum([
        'NO_PANIC',
        'IDEMPOTENCY',
        'ROUNDTRIP',
        'COMMUTATIVITY',
        'MONOTONICITY',
        'CUSTOM_PREDICATE',
      ])
      .optional()
      .describe(
        'The invariant property to verify across randomized inputs. Default: "NO_PANIC".'
      ),
    iterations: z
      .number()
      .optional()
      .describe('Number of randomized boundary inputs to generate (default: 100, max: 2000).'),
    generateReproScript: z
      .boolean()
      .optional()
      .describe(
        'If true, writes a standalone reproduction test script when a counterexample is found (default: true).'
      ),
    customPredicate: z
      .string()
      .optional()
      .describe(
        'Optional JavaScript predicate string `(result, input) => boolean` for CUSTOM_PREDICATE checks.'
      ),
  });

  async execute(
    args: {
      filePath: string;
      functionName: string;
      invariantType?: InvariantType;
      iterations?: number;
      generateReproScript?: boolean;
      customPredicate?: string;
    },
    context: ToolExecutionContext
  ): Promise<string> {
    const invariant: InvariantType = args.invariantType || 'NO_PANIC';
    const iterations = args.iterations || 100;
    const generateRepro = args.generateReproScript !== false;

    let predicateFn: ((result: any, input: any) => boolean) | undefined;
    if (args.customPredicate) {
      try {
        // Safe evaluation of pure predicate expression
        const fn = new Function('result', 'input', `return (${args.customPredicate})(result, input);`);
        predicateFn = (res, inp) => Boolean(fn(res, inp));
      } catch (err: any) {
        throw new Error(`Invalid customPredicate syntax: ${err.message}`);
      }
    }

    const report: FuzzReport = await InvariantFuzzEngine.fuzzFile(
      context.cwd,
      args.filePath,
      args.functionName,
      invariant,
      {
        cwd: context.cwd,
        iterations,
        generateReproScript: generateRepro,
        customPredicate: predicateFn,
      }
    );

    return this.formatReport(report);
  }

  /**
   * Formats FuzzReport into human and agent-readable markdown
   */
  private formatReport(report: FuzzReport): string {
    const lines: string[] = [];
    lines.push(`## 🔬 Invariant Fuzzing Report: ${report.target}`);
    lines.push(`- **Invariant Property**: \`${report.invariantType}\``);
    lines.push(`- **Tested Iterations**: ${report.totalIterations}`);
    lines.push(
      `- **Passed**: ${report.passedIterations} | **Failed**: ${report.failedIterations}`
    );
    lines.push(`- **Duration**: ${report.durationMs}ms`);
    lines.push(
      `- **Verdict**: ${report.overallPassed ? '✅ ALL INVARIANTS SATISFIED' : '❌ INVARIANT VIOLATION DETECTED'}`
    );

    if (!report.overallPassed) {
      lines.push('\n### 💥 Counterexample Detected:');
      if (report.errorMessage) {
        lines.push(`- **Error**: \`${report.errorMessage}\``);
      }
      lines.push('```json');
      lines.push(JSON.stringify(report.shrunkCounterexample, null, 2));
      lines.push('```');

      if (report.reproScriptPath) {
        lines.push(`\n- **Automated Repro Script Created**: \`${report.reproScriptPath}\``);
        lines.push('  *(Ready for use in SWE RedRepro causal loop)*');
      }
    }

    return lines.join('\n');
  }
}
