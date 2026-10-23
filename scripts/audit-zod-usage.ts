import fs from 'node:fs';
import path from 'node:path';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { zodToJsonSchema } from '../providers/zodHelper.js';

export interface ZodAuditFinding {
  file: string;
  line: number;
  patternId: string;
  snippet: string;
}

export interface ZodAuditReport {
  generatedAt: string;
  scannedFiles: number;
  findings: ZodAuditFinding[];
  toolCount: number;
}

const FORBIDDEN_PATTERNS: Array<{ id: string; regex: RegExp }> = [
  { id: 'internal-_def', regex: /\._def\b/ },
  { id: 'method-isOptional', regex: /\.isOptional\(\)/ },
  { id: 'single-arg-record', regex: /z\.record\(\s*z\.[a-zA-Z0-9_]+\([^)]*\)\s*\)/ },
  { id: 'deprecated-error-format', regex: /\.(?:format|flatten)\(\)/ },
  { id: 'legacy-error-params', regex: /\b(?:invalid_type_error|required_error|errorMap)\s*:/ },
  { id: 'deprecated-strict-merge', regex: /\.(?:nonstrict|deepPartial)\(\)/ },
];

function collectTsFiles(dirPath: string, out: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return out;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

export function runZodUsageAudit(rootDir: string = process.cwd()): {
  report: ZodAuditReport;
  toolSchemas: Record<string, Record<string, unknown>>;
} {
  const targetDirs = ['providers', 'tools', 'services'].map((d) => path.join(rootDir, d));
  const files: string[] = [];
  for (const d of targetDirs) {
    collectTsFiles(d, files);
  }

  const findings: ZodAuditFinding[] = [];
  for (const filePath of files) {
    const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      for (const pat of FORBIDDEN_PATTERNS) {
        if (pat.regex.test(lineText)) {
          findings.push({
            file: rel,
            line: idx + 1,
            patternId: pat.id,
            snippet: trimmed,
          });
        }
      }
    });
  }

  const registry = new ToolRegistry();
  const allTools = registry.getAll();
  const toolSchemas: Record<string, Record<string, unknown>> = {};
  for (const tool of [...allTools].sort((a, b) => a.name.localeCompare(b.name))) {
    toolSchemas[tool.name] = zodToJsonSchema(tool.inputSchema, {
      strict: true,
      schemaName: tool.name,
    });
  }

  const report: ZodAuditReport = {
    generatedAt: new Date().toISOString(),
    scannedFiles: files.length,
    findings,
    toolCount: Object.keys(toolSchemas).length,
  };

  return { report, toolSchemas };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('audit-zod-usage.ts');
if (isMain) {
  const rootDir = process.cwd();
  const { report, toolSchemas } = runZodUsageAudit(rootDir);

  const fixturesDir = path.join(rootDir, 'tests', 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });
  const snapshotPath = path.join(fixturesDir, 'tool-schemas-snapshot.json');

  if (process.argv.includes('--write-snapshot') || !fs.existsSync(snapshotPath)) {
    fs.writeFileSync(snapshotPath, JSON.stringify(toolSchemas, null, 2) + '\n', 'utf-8');
    console.log(`[ZOD AUDIT]: Wrote golden JSON Schema snapshot for ${report.toolCount} tools to ${snapshotPath}`);
  }

  console.log(`[ZOD AUDIT]: Scanned ${report.scannedFiles} files across providers/, tools/, services/.`);
  console.log(`[ZOD AUDIT]: Tool schemas verified: ${report.toolCount}`);
  console.log(`[ZOD AUDIT]: Forbidden pattern findings: ${report.findings.length}`);

  if (report.findings.length > 0) {
    for (const f of report.findings) {
      console.error(`  - [${f.patternId}] ${f.file}:${f.line} -> ${f.snippet}`);
    }
    process.exit(1);
  }
}
