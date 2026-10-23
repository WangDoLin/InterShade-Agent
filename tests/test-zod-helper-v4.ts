import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  zodToJsonSchema,
  attachRawJsonSchema,
  formatZodError,
  UnsupportedZodSchemaError,
} from '../providers/zodHelper.js';
import { runZodUsageAudit } from '../scripts/audit-zod-usage.js';
import { SwarmPolicy, resolveAutoMerge } from '../engine/swarm/SwarmPolicy.js';
import { DecomposeAndDispatchTool } from '../tools/agentic/DecomposeAndDispatchTool.js';
import { MaxingDepartmentTool } from '../tools/agentic/MaxingDepartmentTool.js';

enum SampleNumericEnum {
  Low = 1,
  High = 2,
}

async function runZodHelperV4AndPolicyTests(): Promise<void> {
  console.log('================================================================');
  console.log(' ZOD HELPER V4 CONFORMANCE & SWARM POLICY GATE SUITE            ');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // 1. Hand-Crafted 16-Schema Conformance Matrix (NEXT-A-05)
  // -------------------------------------------------------------
  console.log('=== 1. TESTING 16 HAND-CRAFTED ZOD SCHEMAS ===');

  // Schema 1: Simple flat object with required & optional primitives
  const s1 = z.object({
    path: z.string().describe('Target file path'),
    line: z.number().optional().describe('Line number'),
    force: z.boolean(),
  });
  assert.deepStrictEqual(zodToJsonSchema(s1), {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Target file path' },
      line: { type: 'number', description: 'Line number' },
      force: { type: 'boolean' },
    },
    required: ['path', 'force'],
  });

  // Schema 2: Nested object with required inner fields
  const s2 = z.object({
    auth: z
      .object({
        token: z.string(),
        ttlSeconds: z.number().optional(),
      })
      .describe('Authentication block'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s2), {
    type: 'object',
    properties: {
      auth: {
        type: 'object',
        description: 'Authentication block',
        properties: {
          token: { type: 'string' },
          ttlSeconds: { type: 'number' },
        },
        required: ['token'],
      },
    },
    required: ['auth'],
  });

  // Schema 3: Nullable field
  const s3 = z.object({
    tag: z.string().nullable().describe('Nullable tag'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s3), {
    type: 'object',
    properties: {
      tag: { type: 'string', nullable: true, description: 'Nullable tag' },
    },
    required: ['tag'],
  });

  // Schema 4: Default value field (must not be in required, must include default)
  const s4 = z.object({
    retries: z.number().default(3).describe('Retry count'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s4), {
    type: 'object',
    properties: {
      retries: { type: 'number', default: 3, description: 'Retry count' },
    },
  });

  // Schema 5: Deeply chained optional + nullable + default + description
  const s5 = z.object({
    mode: z.string().describe('Execution mode').nullable().optional().default('safe'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s5), {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        nullable: true,
        default: 'safe',
        description: 'Execution mode',
      },
    },
  });

  // Schema 6: ZodEnum
  const s6 = z.object({
    role: z.enum(['architect', 'backend', 'tester']).describe('Swarm role'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s6), {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['architect', 'backend', 'tester'],
        description: 'Swarm role',
      },
    },
    required: ['role'],
  });

  // Schema 7: ZodNativeEnum
  const s7 = z.object({
    priority: z.nativeEnum(SampleNumericEnum),
  });
  assert.deepStrictEqual(zodToJsonSchema(s7), {
    type: 'object',
    properties: {
      priority: {
        type: 'number',
        enum: [1, 2],
      },
    },
    required: ['priority'],
  });

  // Schema 8: ZodLiteral (string, number, boolean)
  const s8 = z.object({
    version: z.literal('v4'),
    code: z.literal(200),
    ok: z.literal(true),
  });
  assert.deepStrictEqual(zodToJsonSchema(s8), {
    type: 'object',
    properties: {
      version: { type: 'string', const: 'v4', enum: ['v4'] },
      code: { type: 'number', const: 200, enum: [200] },
      ok: { type: 'boolean', const: true, enum: [true] },
    },
    required: ['version', 'code', 'ok'],
  });

  // Schema 9: ZodArray of objects
  const s9 = z.object({
    steps: z
      .array(
        z.object({
          id: z.string(),
          done: z.boolean().optional(),
        })
      )
      .describe('Ordered steps'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s9), {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered steps',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            done: { type: 'boolean' },
          },
          required: ['id'],
        },
      },
    },
    required: ['steps'],
  });

  // Schema 10: ZodUnion
  const s10 = z.object({
    target: z.union([z.string(), z.number()]).describe('ID or name'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s10), {
    type: 'object',
    properties: {
      target: {
        anyOf: [{ type: 'string' }, { type: 'number' }],
        description: 'ID or name',
      },
    },
    required: ['target'],
  });

  // Schema 11: ZodDiscriminatedUnion
  const s11 = z.object({
    event: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), body: z.string() }),
      z.object({ kind: z.literal('code'), lines: z.number() }),
    ]),
  });
  const s11Json = zodToJsonSchema(s11);
  assert.ok(Array.isArray((s11Json.properties as any).event.anyOf), 'DiscriminatedUnion must produce anyOf');
  assert.strictEqual((s11Json.properties as any).event.anyOf.length, 2);

  // Schema 12: ZodRecord with typed value schema
  const s12 = z.object({
    headers: z.record(z.string(), z.string()).describe('HTTP headers'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s12), {
    type: 'object',
    properties: {
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'HTTP headers',
      },
    },
    required: ['headers'],
  });

  // Schema 13: ZodRecord with z.unknown() value schema
  const s13 = z.object({
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  assert.deepStrictEqual(zodToJsonSchema(s13), {
    type: 'object',
    properties: {
      metadata: {
        type: 'object',
        additionalProperties: true,
      },
    },
  });

  // Schema 14: ZodTuple
  const s14 = z.object({
    range: z.tuple([z.number(), z.number()]).describe('Line range [start, end]'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s14), {
    type: 'object',
    properties: {
      range: {
        type: 'array',
        prefixItems: [{ type: 'number' }, { type: 'number' }],
        minItems: 2,
        maxItems: 2,
        description: 'Line range [start, end]',
      },
    },
    required: ['range'],
  });

  // Schema 15: ZodEffects (.refine / .transform)
  const s15 = z.object({
    port: z
      .number()
      .refine((n) => n > 0 && n < 65536, 'Valid TCP port')
      .describe('Listening port'),
  });
  assert.deepStrictEqual(zodToJsonSchema(s15), {
    type: 'object',
    properties: {
      port: { type: 'number', description: 'Listening port' },
    },
    required: ['port'],
  });

  // Schema 16: Attached Raw MCP JSON Schema (NEXT-A-15)
  const upstreamMcpSchema = {
    type: 'object',
    properties: {
      pdbId: { type: 'string', description: '4-character PDB accession' },
      chain: { type: 'string', default: 'A' },
    },
    required: ['pdbId'],
  };
  const s16 = attachRawJsonSchema(z.record(z.string(), z.unknown()), upstreamMcpSchema);
  assert.deepStrictEqual(zodToJsonSchema(s16), upstreamMcpSchema);

  console.log('[PASS]: All 16 hand-crafted Zod schemas converted accurately.');

  // -------------------------------------------------------------
  // 2. Fail-Loud Verification (No Fail-Open { type: 'string' })
  // -------------------------------------------------------------
  console.log('\n=== 2. TESTING FAIL-LOUD BEHAVIOR ON UNSUPPORTED SCHEMAS ===');
  assert.throws(
    () => zodToJsonSchema({ notAZodSchema: true } as unknown as z.ZodType<unknown>),
    UnsupportedZodSchemaError,
    'Non-Zod object must throw UnsupportedZodSchemaError'
  );
  assert.throws(
    () => zodToJsonSchema(z.object({ badField: z.symbol() }), { strict: true, schemaName: 'test_tool' }),
    UnsupportedZodSchemaError,
    'Unsupported z.symbol() field must throw UnsupportedZodSchemaError instead of failing open'
  );
  console.log('[PASS]: Fail-loud behavior verified (no silent fallback to { type: "string" }).');

  // -------------------------------------------------------------
  // 3. formatZodError Helper (NEXT-A-06)
  // -------------------------------------------------------------
  console.log('\n=== 3. TESTING formatZodError HELPER ===');
  const parseFail = s1.safeParse({ path: 123 });
  assert.strictEqual(parseFail.success, false);
  const formattedError = formatZodError(parseFail.error);
  assert.ok(formattedError.includes('path'), 'Formatted error must include offending field path');
  assert.ok(formattedError.includes('force'), 'Formatted error must include missing required field');
  console.log('[PASS]: formatZodError output verified:', formattedError);

  // -------------------------------------------------------------
  // 4. Repository-Wide Zod Audit & Golden Snapshot Gate (NEXT-A-03..05)
  // -------------------------------------------------------------
  console.log('\n=== 4. RUNNING REPOSITORY-WIDE ZOD USAGE AUDIT & SNAPSHOT CHECK ===');
  const { report, toolSchemas } = runZodUsageAudit(process.cwd());
  assert.strictEqual(
    report.findings.length,
    0,
    `Expected 0 forbidden Zod patterns (_def, isOptional, single-arg z.record), found: ${JSON.stringify(report.findings)}`
  );
  assert.ok(report.toolCount >= 25, `Expected at least 25 registered tools, got ${report.toolCount}`);

  const snapshotPath = path.join(process.cwd(), 'tests', 'fixtures', 'tool-schemas-snapshot.json');
  assert.ok(fs.existsSync(snapshotPath), 'Golden tool schema snapshot must exist');
  const goldenSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
  assert.deepStrictEqual(
    toolSchemas,
    goldenSnapshot,
    'Current tool JSON schemas must match tests/fixtures/tool-schemas-snapshot.json'
  );
  console.log(`[PASS]: Repository audit clean (0 forbidden patterns across ${report.scannedFiles} files, ${report.toolCount} tool schemas match golden snapshot).`);

  // -------------------------------------------------------------
  // 5. SwarmPolicy.autoMerge = false & Grep-Gate (NEXT-C-37)
  // -------------------------------------------------------------
  console.log('\n=== 5. VERIFYING SWARM POLICY AUTO-MERGE = FALSE & GREP-GATE ===');
  assert.strictEqual(SwarmPolicy.autoMerge, false, 'SwarmPolicy.autoMerge must be false');
  assert.strictEqual(resolveAutoMerge(undefined), false, 'resolveAutoMerge(undefined) must be false');
  assert.strictEqual(resolveAutoMerge(false), false, 'resolveAutoMerge(false) must be false');
  assert.strictEqual(resolveAutoMerge(true), true, 'resolveAutoMerge(true) must be true');

  const dispatchTool = new DecomposeAndDispatchTool();
  const parsedDispatch = dispatchTool.inputSchema.parse({
    overallGoal: 'Test default autoMerge',
    subtasks: [{ id: '1', title: 'T1', role: 'backend', prompt: 'Do work' }],
  });
  assert.strictEqual(parsedDispatch.autoMerge, false, 'DecomposeAndDispatchTool must default autoMerge to false');

  const deptTool = new MaxingDepartmentTool();
  const parsedDept = deptTool.inputSchema.parse({
    overallGoal: 'Test default autoMerge in department tool',
  });
  assert.strictEqual(parsedDept.autoMerge, false, 'MaxingDepartmentTool must default autoMerge to false');

  // Grep-gate: ensure no swarm coordinator or agentic tool reintroduces `autoMerge !== false` or `autoMerge: boolean = true`
  const guardedFiles = [
    'engine/swarm/SwarmCoordinator.ts',
    'engine/swarm/SwarmDepartmentCoordinator.ts',
    'engine/swarm/SubagentOrchestrator.ts',
    'tools/agentic/DecomposeAndDispatchTool.ts',
    'tools/agentic/MaxingDepartmentTool.ts',
  ];
  for (const relFile of guardedFiles) {
    const content = fs.readFileSync(path.join(process.cwd(), relFile), 'utf-8');
    assert.ok(
      !content.includes('autoMerge !== false'),
      `${relFile} must not use unsafe 'autoMerge !== false' default`
    );
    assert.ok(
      !/autoMerge\s*:\s*boolean\s*=\s*true/.test(content),
      `${relFile} must not declare 'autoMerge: boolean = true'`
    );
    assert.ok(
      !content.includes('.default(true)'),
      `${relFile} must not set '.default(true)' on schema fields`
    );
  }
  console.log('[PASS]: SwarmPolicy.autoMerge === false enforced across all 5 swarm/tool entrypoints.');

  console.log('\n================================================================');
  console.log(' ALL ZOD V4 & SWARM POLICY CHECKS PASSED 100%!                  ');
  console.log('================================================================');
}

runZodHelperV4AndPolicyTests().catch((err) => {
  console.error('[FAIL]:', err);
  process.exit(1);
});
