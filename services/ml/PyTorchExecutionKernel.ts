import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  defaultProcessRunner,
  type ProcessRunner,
} from '../../engine/ports/ProcessRunner.js';
import { SecretScrubber } from '../../security/SecretScrubber.js';

export interface PyTorchRunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  dependencies?: string[];
  packageAllowlist?: string[];
  runId?: string;
  runner?: ProcessRunner;
  onProgress?: (line: string) => void;
}

export interface PyTorchRunResult {
  runId: string;
  runManifestPath: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  metrics: Record<string, number>;
  remediation?: MLRemediationPlan;
}

export interface MLRemediationPlan {
  detectedError: 'CUDA_OOM' | 'SHAPE_MISMATCH' | 'NAN_LOSS' | 'GENERAL_RUNTIME';
  rootCause: string;
  recommendedAction: string;
  suggestedPatch: string;
}

export const DEFAULT_ML_PACKAGE_ALLOWLIST = new Set([
  'torch',
  'torchvision',
  'torchaudio',
  'numpy',
  'scipy',
  'pandas',
  'scikit-learn',
  'transformers',
  'datasets',
  'accelerate',
  'peft',
  'timm',
  'einops',
  'safetensors',
  'biopython',
  'matplotlib',
  'tqdm',
]);

const SAFE_ENV_KEYS = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'CUDA_VISIBLE_DEVICES',
  'CUDA_HOME',
  'CUDA_PATH',
  'UV_CACHE_DIR',
];

const PACKAGE_SPEC_REGEX = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:==([a-zA-Z0-9._+-]+))?$/;

/**
 * PyTorchExecutionKernel manages supervised local execution of PyTorch scripts via `uv run`
 * using structured ProcessRunner argument arrays, package allowlist enforcement, minimal
 * credential-scrubbed environments, per-run manifest persistence (`state/ml-runs/<runId>/run.json`),
 * and self-healing diagnostic analysis (NEXT-B-13..14).
 *
 * Note: `uv run` provides Python virtual environment dependency isolation, not OS-level kernel/network sandboxing.
 */
export class PyTorchExecutionKernel {
  /**
   * Validates requested Python dependencies against the package allowlist and strict syntax rules (NEXT-B-14).
   */
  static validateDependencies(
    dependencies: string[],
    customAllowlist?: string[]
  ): { valid: boolean; reason?: string; sanitizedDeps: string[] } {
    const allowed = customAllowlist
      ? new Set([...DEFAULT_ML_PACKAGE_ALLOWLIST, ...customAllowlist.map((p) => p.toLowerCase())])
      : DEFAULT_ML_PACKAGE_ALLOWLIST;

    const sanitizedDeps: string[] = [];
    for (const rawDep of dependencies) {
      const dep = rawDep.trim();
      const match = PACKAGE_SPEC_REGEX.exec(dep);
      if (!match) {
        return {
          valid: false,
          reason: `Rejected unsafe package specification "${rawDep}". Only standard package names with optional exact "==version" pins are allowed.`,
          sanitizedDeps: [],
        };
      }
      const pkgName = match[1]!.toLowerCase();
      if (!allowed.has(pkgName)) {
        return {
          valid: false,
          reason: `Package "${pkgName}" is not in the supervised ML execution allowlist.`,
          sanitizedDeps: [],
        };
      }
      sanitizedDeps.push(dep);
    }

    return { valid: true, sanitizedDeps };
  }

  /**
   * Builds a minimal environment for supervised local ML execution, stripping API keys and secrets (NEXT-B-14).
   */
  static buildSafeMlEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
    const safeEnv: NodeJS.ProcessEnv = {
      PYTHONUNBUFFERED: '1',
    };
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        safeEnv[key] = process.env[key];
      }
    }
    if (extraEnv) {
      for (const [k, v] of Object.entries(extraEnv)) {
        if (!/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) {
          safeEnv[k] = v;
        }
      }
    }
    return safeEnv;
  }

  /**
   * Executes a Python script with PyTorch dependencies via supervised local `uv run` through ProcessRunner.
   */
  static async runScript(
    scriptPath: string,
    options: PyTorchRunOptions = {}
  ): Promise<PyTorchRunResult> {
    const timeoutMs = options.timeoutMs || 300000;
    const cwd = options.cwd || process.cwd();
    const deps = options.dependencies || ['torch', 'numpy'];
    const runId = options.runId || `mlrun-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const runner = options.runner || defaultProcessRunner;

    const runDir = path.join(cwd, 'state', 'ml-runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    const runManifestPath = path.join(runDir, 'run.json');
    const startedAt = new Date().toISOString();

    const depCheck = this.validateDependencies(deps, options.packageAllowlist);
    if (!depCheck.valid) {
      const errorMsg = depCheck.reason || 'Dependency validation failed';
      const remediation = this.diagnoseError(errorMsg);
      const manifest = {
        runId,
        executionModel: 'supervised-local-execution',
        scriptPath,
        dependencies: deps,
        startedAt,
        completedAt: new Date().toISOString(),
        exitCode: 1,
        success: false,
        error: errorMsg,
      };
      fs.writeFileSync(runManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      return {
        runId,
        runManifestPath,
        success: false,
        stdout: '',
        stderr: errorMsg,
        exitCode: 1,
        metrics: {},
        remediation,
      };
    }

    const args: string[] = ['run'];
    for (const d of depCheck.sanitizedDeps) {
      args.push('--with', d);
    }
    args.push('python', scriptPath);

    const safeEnv = this.buildSafeMlEnv(options.env);
    const procRes = await runner.run({
      command: 'uv',
      args,
      cwd,
      env: safeEnv,
      timeoutMs,
      maxOutputBytes: 10 * 1024 * 1024,
    });

    const rawStdout = SecretScrubber.sanitize(procRes.stdout || '');
    const rawStderr = SecretScrubber.sanitize(procRes.stderr || '');
    const exitCode = procRes.exitCode;
    const success = exitCode === 0 && !procRes.timedOut;

    if (options.onProgress && rawStdout) {
      options.onProgress(rawStdout);
    }

    const metrics = this.extractMetrics(rawStdout);
    let remediation: MLRemediationPlan | undefined;
    if (!success) {
      remediation = this.diagnoseError(rawStderr || rawStdout);
    }

    const manifest = {
      runId,
      executionModel: 'supervised-local-execution',
      scriptPath,
      dependencies: depCheck.sanitizedDeps,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: procRes.durationMs,
      exitCode,
      timedOut: procRes.timedOut,
      success,
      stdoutSha256: procRes.stdoutSha256,
      metrics,
      remediation,
    };
    fs.writeFileSync(runManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    return {
      runId,
      runManifestPath,
      success,
      stdout: rawStdout,
      stderr: rawStderr,
      exitCode,
      metrics,
      remediation,
    };
  }

  /**
   * Diagnoses ML runtime errors (CUDA OOM, Shape Mismatch, NaN Loss) and formulates remediation
   */
  static diagnoseError(output: string): MLRemediationPlan {
    // 1. CUDA Out of Memory
    if (/CUDA out of memory|torch\.cuda\.OutOfMemoryError/i.test(output)) {
      return {
        detectedError: 'CUDA_OOM',
        rootCause: 'GPU VRAM exhausted during forward/backward pass or tensor allocation.',
        recommendedAction: 'Halve batch size, double gradient accumulation steps, and enable mixed precision (AMP).',
        suggestedPatch: `
# Remediation: Reduce batch size and increase gradient accumulation
batch_size = max(1, batch_size // 2)
gradient_accumulation_steps = gradient_accumulation_steps * 2
torch.cuda.empty_cache()
scaler = torch.amp.GradScaler('cuda')
`.trim(),
      };
    }

    // 2. Tensor Shape Mismatch
    const shapeMatch =
      /RuntimeError: The size of tensor a \((\d+)\) must match the size of tensor b \((\d+)\)/i.exec(
        output
      ) || /size mismatch, m1: \[(\d+) x (\d+)\], m2: \[(\d+) x (\d+)\]/i.exec(output);

    if (shapeMatch) {
      return {
        detectedError: 'SHAPE_MISMATCH',
        rootCause: `Tensor dimension mismatch detected: ${shapeMatch[0]}. Layer projections do not align.`,
        recommendedAction:
          'Insert an adaptive pooling layer or adjust the linear projection in_features to match output dimension.',
        suggestedPatch: `
# Remediation: Adjust linear layer projection or use adaptive pooling
# e.g.: nn.Linear(in_features=${shapeMatch[2] || shapeMatch[1]}, out_features=...)
# or:   x = nn.functional.adaptive_avg_pool2d(x, (1, 1)).flatten(1)
`.trim(),
      };
    }

    // 3. NaN / Inf Loss or Gradient Explosion
    if (/Loss is NaN|Loss is Inf|gradient.*nan/i.test(output)) {
      return {
        detectedError: 'NAN_LOSS',
        rootCause: 'Numerical instability or exploding gradients encountered during backpropagation.',
        recommendedAction: 'Apply gradient norm clipping (e.g. clip_grad_norm_ <= 1.0) and reduce initial learning rate.',
        suggestedPatch: `
# Remediation: Gradient clipping and numerical stability guards
torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
optimizer.param_groups[0]['lr'] = optimizer.param_groups[0]['lr'] * 0.5
`.trim(),
      };
    }

    return {
      detectedError: 'GENERAL_RUNTIME',
      rootCause: 'General Python or PyTorch runtime exception.',
      recommendedAction: 'Inspect stack trace call sites and verify dependencies.',
      suggestedPatch: '# Review trace for module imports and input data format.',
    };
  }

  /**
   * Extracts quantitative metric pairs from training output
   */
  private static extractMetrics(output: string): Record<string, number> {
    const metrics: Record<string, number> = {};
    const metricRegex =
      /\b(loss|val_loss|accuracy|acc|auroc|auc|f1|f1_score|rmse|mae|r2|epoch|step)\b[:=]\s*([0-9.]+)/gi;
    let match: RegExpExecArray | null;

    while ((match = metricRegex.exec(output)) !== null) {
      const key = match[1].toLowerCase();
      const val = parseFloat(match[2]);
      if (!isNaN(val)) {
        metrics[key] = val;
      }
    }
    return metrics;
  }
}
