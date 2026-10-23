import fs from 'node:fs';
import path from 'node:path';
import { AstSkeletonExtractor } from '../../context/AstSkeletonExtractor.js';
import { SerenaSemanticEngine } from '../../engine/semantic/SerenaSemanticEngine.js';
import { InvariantFuzzEngine } from '../../engine/verification/InvariantFuzzEngine.js';

const MAX_GRAPH_FILES = 15;
const GRAPH_CACHE_TTL_MS = 30000;
const FUZZ_ITERATIONS_PER_FN = 20;
const FUZZ_TIMEOUT_PER_FN_MS = 150;
const MAX_FUZZ_FNS_PER_FILE = 3;

/**
 * Provides AST skeleton repository graph construction and property-based fuzz shielding
 * for Mode Max (ORCH-001).
 */
export class MaxingRepoGraphService {
  private deepRepoGraphCache: { cwd: string; timestamp: number; content: string } | null = null;

  getDeepRepoGraphDigest(cwd: string): string {
    const now = Date.now();
    if (
      this.deepRepoGraphCache &&
      this.deepRepoGraphCache.cwd === cwd &&
      now - this.deepRepoGraphCache.timestamp < GRAPH_CACHE_TTL_MS
    ) {
      return this.deepRepoGraphCache.content;
    }
    const content = MaxingRepoGraphService.buildDeepRepoGraphDigest(cwd);
    this.deepRepoGraphCache = { cwd, timestamp: now, content };
    return content;
  }

  async runMaxingInvariantFuzzShield(
    cwd: string,
    modifiedFiles: string[]
  ): Promise<{ passed: boolean; defectNotice?: string }> {
    return MaxingRepoGraphService.runInvariantFuzzShield(cwd, modifiedFiles);
  }
  static formatFileAstSkeleton(filePath: string, cwd: string): string | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const skeleton = AstSkeletonExtractor.extract(filePath, content);
      const relPath = path.relative(cwd, filePath).replace(/\\/g, '/');
      const lines = skeleton.skeletonContent
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => {
          const t = l.trim();
          return (
            t.startsWith('export ') ||
            t.startsWith('interface ') ||
            t.startsWith('class ') ||
            t.startsWith('type ') ||
            t.startsWith('def ') ||
            t.startsWith('fn ')
          );
        })
        .slice(0, 10);

      if (lines.length === 0) return null;
      return `### \`${relPath}\` (${skeleton.language}):\n\`\`\`ts\n${lines.join('\n')}\n\`\`\``;
    } catch {
      return null;
    }
  }

  static discoverKeySourceFiles(rootDir: string, maxFiles = MAX_GRAPH_FILES): string[] {
    const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs']);
    const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.intershade', 'coverage', '.cache']);
    const files: string[] = [];

    const scan = (dir: string, depth = 0) => {
      if (depth > 5 || files.length >= maxFiles) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (files.length >= maxFiles) break;
          if (entry.name.startsWith('.') && entry.name !== '.env') continue;
          if (entry.isDirectory() && !ignoreDirs.has(entry.name)) {
            scan(path.join(dir, entry.name), depth + 1);
          } else if (entry.isFile() && codeExts.has(path.extname(entry.name).toLowerCase())) {
            files.push(path.join(dir, entry.name));
          }
        }
      } catch {
        // Ignore unreadable directories
      }
    };

    scan(rootDir);
    return files;
  }

  static buildDeepRepoGraphDigest(cwd: string): string {
    const keyFiles = this.discoverKeySourceFiles(cwd, MAX_GRAPH_FILES);
    if (keyFiles.length === 0) return '';

    const snippets: string[] = [];
    for (const f of keyFiles) {
      const snippet = this.formatFileAstSkeleton(f, cwd);
      if (snippet) snippets.push(snippet);
    }

    return [
      '# [MODE MAX: DEEP REPOSITORY ARCHITECTURAL GRAPH]',
      'The following high-density structural AST skeleton provides omniscient awareness of key workspace symbols and signatures:',
      ...snippets,
    ].join('\n\n');
  }

  static async runInvariantFuzzShield(
    cwd: string,
    modifiedFiles: string[]
  ): Promise<{ passed: boolean; defectNotice?: string }> {
    const codeFiles = modifiedFiles.filter((f) => {
      const lower = f.toLowerCase();
      return (
        (lower.endsWith('.ts') || lower.endsWith('.js')) &&
        !lower.endsWith('.d.ts') &&
        !lower.includes('test') &&
        !lower.includes('spec')
      );
    });

    if (codeFiles.length === 0) return { passed: true };

    for (const filePath of codeFiles) {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      if (!fs.existsSync(fullPath)) continue;

      const symbols = SerenaSemanticEngine.getSymbolOutline(fullPath);
      const targetFunctions = symbols
        .filter((s) => s.isExported && (s.kind === 'function' || s.kind === 'method'))
        .slice(0, MAX_FUZZ_FNS_PER_FILE);

      for (const fn of targetFunctions) {
        try {
          const relPath = path.relative(cwd, fullPath);
          const report = await InvariantFuzzEngine.fuzzFile(cwd, relPath, fn.name, 'NO_PANIC', {
            cwd,
            iterations: FUZZ_ITERATIONS_PER_FN,
            timeoutMsPerRun: FUZZ_TIMEOUT_PER_FN_MS,
          });

          if (!report.overallPassed && report.errorMessage) {
            const counter = JSON.stringify(report.shrunkCounterexample ?? report.originalCounterexample);
            const defectNotice = `[MODE MAX INVARIANT SHIELD DEFECT]: Boundary fuzzing detected an unhandled crash in function '${report.target}':\nError: ${report.errorMessage}\nCounterexample input: ${counter}\n\nPlease harden the function against boundary inputs (null, undefined, empty, or numeric boundaries).`;
            return { passed: false, defectNotice };
          }
        } catch {
          // Dynamic import or environment-specific module: proceed gracefully
        }
      }
    }

    return { passed: true };
  }
}
