import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type TestGroup = 'UNIT' | 'INT' | 'E2E' | 'ADV' | 'PERF' | 'CONTRACT' | 'HELPER';
export type TestTier = 'tier1' | 'tier2' | 'tier-live' | 'quarantine' | 'delegate' | 'helper';

export interface ManifestEntry {
  file: string;
  group: TestGroup;
  tier: TestTier;
  timeoutMs: number;
  serial?: boolean;
  perfMode?: 'assert' | 'report';
  delegatesTo?: string;
}

export interface TestRunResult {
  file: string;
  tier: TestTier;
  group: TestGroup;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stderrSnippet: string;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_STDERR_SNIPPET = 1200;

/**
 * Parses CLI arguments to determine target tiers, filter patterns, and concurrency.
 */
function parseArgs(argv: string[]): {
  tiers: Set<string>;
  filter?: string;
  concurrency: number;
} {
  let rawTier = 'tier1';
  let filter: string | undefined;
  let concurrency = DEFAULT_CONCURRENCY;

  for (const arg of argv) {
    if (arg.startsWith('--tier=')) {
      rawTier = arg.slice('--tier='.length);
    } else if (arg.startsWith('--filter=')) {
      filter = arg.slice('--filter='.length);
    } else if (arg.startsWith('--concurrency=')) {
      const parsed = Number.parseInt(arg.slice('--concurrency='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        concurrency = parsed;
      }
    } else if (!arg.startsWith('-')) {
      rawTier = arg;
    }
  }

  const tiers = new Set<string>();
  for (const token of rawTier.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (token === 'all') {
      tiers.add('tier1');
      tiers.add('tier2');
    } else {
      tiers.add(token);
    }
  }

  return { tiers, filter, concurrency };
}

/**
 * Verifies that every test file on disk is registered in tests/manifest.json (Rule 5.4.6 #1).
 */
function verifyManifestCompleteness(testsDir: string, entries: ManifestEntry[]): void {
  const registered = new Set(entries.map((entry) => entry.file));
  const diskFiles = fs
    .readdirSync(testsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.ts'))
    .map((dirent) => dirent.name);

  const unregistered = diskFiles.filter((file) => !registered.has(file));
  if (unregistered.length > 0) {
    throw new Error(
      `Unregistered test files found in tests/ (must be added to tests/manifest.json): ${unregistered.join(', ')}`,
    );
  }
}

/**
 * Spawns a single test file via local tsx CLI with a strict per-file timeout.
 */
function runSingleTest(repoRoot: string, entry: ManifestEntry): Promise<TestRunResult> {
  return new Promise((resolve) => {
    const startMs = performance.now();
    const testPath = path.join(repoRoot, 'tests', entry.file);
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

    const child = spawn(process.execPath, [tsxCli, testPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        INTERSHADER_TEST_MODE: entry.tier === 'tier-live' ? 'live' : (process.env.INTERSHADER_TEST_MODE ?? 'mock'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    let stdoutTail = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, entry.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutTail = (stdoutTail + chunk.toString('utf8')).slice(-MAX_STDERR_SNIPPET);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-MAX_STDERR_SNIPPET);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - startMs);
      const passed = !timedOut && code === 0;
      resolve({
        file: entry.file,
        tier: entry.tier,
        group: entry.group,
        passed,
        exitCode: code,
        timedOut,
        durationMs,
        stderrSnippet: passed ? '' : (stderrBuf || stdoutTail).trim(),
      });
    });
  });
}

/**
 * Runs a list of test entries with bounded concurrency.
 */
async function runBatch(
  repoRoot: string,
  entries: ManifestEntry[],
  concurrency: number,
): Promise<TestRunResult[]> {
  const results: TestRunResult[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const index = cursor++;
      const entry = entries[index];
      const result = await runSingleTest(repoRoot, entry);
      const statusTag = result.passed ? '[PASS]' : result.timedOut ? '[TIMEOUT]' : '[FAIL]';
      const secs = (result.durationMs / 1000).toFixed(2);
      console.log(`${statusTag.padEnd(9)} ${entry.file.padEnd(54)} (${secs}s) [${entry.group}/${entry.tier}]`);
      if (!result.passed && result.stderrSnippet) {
        console.error(`  └─ ${result.stderrSnippet.split('\n').slice(-6).join('\n     ')}`);
      }
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const manifestPath = path.join(repoRoot, 'tests', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    tests: ManifestEntry[];
  };

  verifyManifestCompleteness(path.join(repoRoot, 'tests'), manifest.tests);

  const { tiers, filter, concurrency } = parseArgs(process.argv.slice(2));
  const selected = manifest.tests.filter((entry) => {
    if (!tiers.has(entry.tier)) return false;
    if (filter && !entry.file.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  if (selected.length === 0) {
    console.log(`No tests matched tiers=[${Array.from(tiers).join(', ')}] filter=${filter ?? '*'}`);
    process.exit(0);
  }

  const parallelEntries = selected.filter((entry) => !entry.serial);
  const serialEntries = selected.filter((entry) => entry.serial);

  console.log(
    `Running ${selected.length} test(s) (parallel=${parallelEntries.length} @ ${concurrency} workers, serial=${serialEntries.length})...`,
  );
  const overallStart = performance.now();

  const parallelResults = await runBatch(repoRoot, parallelEntries, concurrency);
  const serialResults = await runBatch(repoRoot, serialEntries, 1);

  const allResults = [...parallelResults, ...serialResults];
  const passedCount = allResults.filter((r) => r.passed).length;
  const failedResults = allResults.filter((r) => !r.passed);
  const totalSecs = ((performance.now() - overallStart) / 1000).toFixed(2);

  const reportDir = path.join(repoRoot, 'test-results');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, 'last-run.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        tiers: Array.from(tiers),
        total: allResults.length,
        passed: passedCount,
        failed: failedResults.length,
        durationSeconds: Number(totalSecs),
        results: allResults,
      },
      null,
      2,
    ),
  );

  console.log(`\nSummary: ${passedCount}/${allResults.length} passed in ${totalSecs}s`);
  if (failedResults.length > 0) {
    console.error('Failed tests:');
    for (const f of failedResults) {
      console.error(`  - ${f.file} (exit=${f.exitCode}, timedOut=${f.timedOut})`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[TEST-RUNNER ERROR]:', error);
  process.exit(1);
});
