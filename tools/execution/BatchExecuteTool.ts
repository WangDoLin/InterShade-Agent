import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import type { ToolRegistry } from '../ToolRegistry.js';
import { ZeroTurnBatcher } from '../../engine/ZeroTurnBatcher.js';

const BatchOperationSchema = z.object({
  id: z.string().describe('Unique identifier for this operation in the batch'),
  tool: z.string().describe('Name of the tool to execute (e.g. file_read, file_edit, grep_search)'),
  args: z.record(z.string(), z.unknown()).describe('Arguments object to pass to the tool'),
});

const BatchExecuteInputSchema = z.object({
  operations: z.array(BatchOperationSchema).min(1).describe('Ordered array of tool operations to execute atomically'),
  atomic: z.boolean().optional().describe('If true, any failure triggers an automatic rollback of all changes in this batch (default: true)'),
});

type BatchExecuteInput = z.infer<typeof BatchExecuteInputSchema>;

export class BatchExecuteTool extends BaseTool<BatchExecuteInput, string> {
  readonly name = 'batch_execute';
  readonly description =
    'Zero-turn atomic batch tool executor. Runs multiple read and edit tool operations in a single round-trip, saving 60-80% token costs and eliminating round-trip latency.';
  readonly inputSchema = BatchExecuteInputSchema;
  readonly isReadOnly = false;
  readonly isDestructive = true;
  readonly requiresPermission = true;

  constructor(private registry: ToolRegistry) {
    super();
  }

  async execute(args: BatchExecuteInput, context: ToolExecutionContext): Promise<string> {
    const summary = await ZeroTurnBatcher.executeBatch(
      args.operations,
      this.registry,
      context,
      args.atomic ?? true
    );

    const lines: string[] = [
      `### Zero-Turn Batch Execution Summary`,
      `- **Total Operations**: ${summary.totalOperations}`,
      `- **Succeeded**: ${summary.succeededCount}`,
      `- **Failed**: ${summary.failedCount}`,
      `- **Estimated Tokens Saved**: ~${summary.estimatedTokensSaved} tokens`,
    ];

    if (summary.isAtomicRollback) {
      lines.push(`- **Atomic Status**: ROLLED_BACK (Failure detected, all modifications restored)`);
    } else {
      lines.push(`- **Atomic Status**: COMMITTED`);
    }

    lines.push('\n**Operation Details:**');
    for (const r of summary.results) {
      const statusTag = r.success ? '[OK]' : '[FAILED]';
      lines.push(`- ${statusTag} \`${r.id}\` (\`${r.tool}\`, ${r.durationMs}ms):`);
      if (r.output) {
        lines.push(`  Output: ${r.output.slice(0, 300)}${r.output.length > 300 ? '...' : ''}`);
      }
      if (r.error) {
        lines.push(`  Error: ${r.error}`);
      }
    }

    return lines.join('\n');
  }
}
