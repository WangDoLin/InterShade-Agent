import { randomUUID } from 'node:crypto';
import { getDatabase } from '../../state/Database.js';
import { ModelCatalogStore } from '../../providers/catalog/ModelCatalogStore.js';

export type ModelCapability =
  | 'complex_reasoning'
  | 'fast_scan'
  | 'computer_use'
  | 'large_context'
  | 'ast_surgical_edit'
  | 'tool_calling'
  | 'security_audit';

export interface TelemetryProvenance {
  readonly computedFrom: string;
  readonly computedAt: string;
}

export interface ModelProfile {
  readonly id: string;
  readonly name: string;
  readonly provider: 'anthropic' | 'gemini' | 'openai' | 'deepseek' | 'ollama';
  readonly contextWindow: number;
  readonly capabilities: Set<ModelCapability>;
  readonly costPer1kInputUsd: number;
  readonly costPer1kOutputUsd: number;
  readonly latencyTier: 'ULTRA_LOW' | 'LOW' | 'MEDIUM' | 'HIGH';
  /**
   * Empirical pass rate (0 - 100) recorded from real benchmark/verification runs,
   * or null when no verified telemetry has been recorded yet (ENG-004: no fabricated numbers).
   */
  historicalPassRate: number | null;
  totalTasksExecuted: number;
  telemetryProvenance?: TelemetryProvenance;
}

export interface ModelStatInput {
  sessionId?: string;
  modelId: string;
  provider?: string;
  taskType?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
  toolCallSuccess: boolean;
  proofGatePassed?: boolean;
  computedFrom?: string;
}

export interface AggregatedModelStats {
  modelId: string;
  totalRuns: number;
  avgLatencyMs: number;
  toolCallSuccessRate: number;
  proofPassRate: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export interface TaskRequirements {
  readonly prompt: string;
  readonly estimatedTokens?: number;
  readonly fileCount?: number;
  readonly isSecurityAudit?: boolean;
  readonly requiresComputerUse?: boolean;
  readonly budgetConstraint?: 'CHEAPEST' | 'BALANCED' | 'MAX_QUALITY';
  readonly latencyTolerance?: 'LOW' | 'NORMAL';
}

export class CapabilityModelRegistry {
  private static models: Map<string, ModelProfile> = new Map([
    [
      'gemini-3.8-flash',
      {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash (Agentic & Computer Use)',
        provider: 'gemini',
        contextWindow: 1_048_576,
        capabilities: new Set(['fast_scan', 'large_context', 'tool_calling', 'computer_use', 'ast_surgical_edit']),
        costPer1kInputUsd: 0.00015,
        costPer1kOutputUsd: 0.0006,
        latencyTier: 'ULTRA_LOW',
        historicalPassRate: null,
        totalTasksExecuted: 0,
      },
    ],
    [
      'claude-3-7-sonnet-20250219',
      {
        id: 'claude-3-7-sonnet-20250219',
        name: 'Claude 3.7 Sonnet (Hybrid Thinking SWE)',
        provider: 'anthropic',
        contextWindow: 200_000,
        capabilities: new Set(['complex_reasoning', 'ast_surgical_edit', 'security_audit', 'tool_calling']),
        costPer1kInputUsd: 0.003,
        costPer1kOutputUsd: 0.015,
        latencyTier: 'MEDIUM',
        historicalPassRate: null,
        totalTasksExecuted: 0,
      },
    ],
    [
      'deepseek-chat',
      {
        id: 'deepseek-chat',
        name: 'DeepSeek-V3 (Cost-Efficient Coding)',
        provider: 'deepseek',
        contextWindow: 64_000,
        capabilities: new Set(['fast_scan', 'ast_surgical_edit', 'tool_calling']),
        costPer1kInputUsd: 0.00014,
        costPer1kOutputUsd: 0.00028,
        latencyTier: 'LOW',
        historicalPassRate: null,
        totalTasksExecuted: 0,
      },
    ],
    [
      'gpt-4o',
      {
        id: 'gpt-4o',
        name: 'OpenAI GPT-4o (General Multimodal Agent)',
        provider: 'openai',
        contextWindow: 128_000,
        capabilities: new Set(['complex_reasoning', 'tool_calling', 'security_audit']),
        costPer1kInputUsd: 0.0025,
        costPer1kOutputUsd: 0.01,
        latencyTier: 'LOW',
        historicalPassRate: null,
        totalTasksExecuted: 0,
      },
    ],
    [
      'o3-mini',
      {
        id: 'o3-mini',
        name: 'OpenAI o3-mini (High-Fidelity Reasoning)',
        provider: 'openai',
        contextWindow: 200_000,
        capabilities: new Set(['complex_reasoning', 'security_audit']),
        costPer1kInputUsd: 0.0011,
        costPer1kOutputUsd: 0.0044,
        latencyTier: 'HIGH',
        historicalPassRate: null,
        totalTasksExecuted: 0,
      },
    ],
  ]);

  /**
   * Calculate token cost in USD using the unified ModelCatalogStore pricing source of truth (NEXT-C-19).
   */
  static calculateCostUsd(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number = 0
  ): number {
    const desc = ModelCatalogStore.findByModelId(modelId);
    if (desc?.pricing) {
      const regularInput = Math.max(0, inputTokens - cachedInputTokens);
      const cachedRate = desc.pricing.cachedInputPer1MUsd ?? desc.pricing.inputPer1MUsd;
      const cost =
        (regularInput / 1_000_000) * desc.pricing.inputPer1MUsd +
        (cachedInputTokens / 1_000_000) * cachedRate +
        (outputTokens / 1_000_000) * desc.pricing.outputPer1MUsd;
      return Number(cost.toFixed(8));
    }

    const profile = this.models.get(modelId);
    if (profile) {
      const cost =
        (inputTokens / 1000) * profile.costPer1kInputUsd +
        (outputTokens / 1000) * profile.costPer1kOutputUsd;
      return Number(cost.toFixed(8));
    }

    return 0;
  }

  /**
   * Register or update model profile
   */
  static registerModel(profile: ModelProfile): void {
    this.models.set(profile.id, profile);
  }

  /**
   * Persist a real model execution telemetry record into SQLite `model_stats` and update in-memory profile (NEXT-C-18).
   */
  static recordModelStat(stat: ModelStatInput): string {
    const id = randomUUID();
    const profile = this.models.get(stat.modelId);
    const provider = stat.provider || profile?.provider || 'unknown';
    const taskType = stat.taskType || 'general';
    const costUsd =
      stat.costUsd ??
      this.calculateCostUsd(
        stat.modelId,
        stat.inputTokens,
        stat.outputTokens,
        stat.cachedInputTokens ?? 0
      );

    try {
      const db = getDatabase();
      db.prepare(`
        INSERT INTO model_stats (
          id, session_id, model_id, provider, task_type,
          latency_ms, input_tokens, output_tokens, cost_usd,
          tool_call_success, proof_gate_passed, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        stat.sessionId || null,
        stat.modelId,
        provider,
        taskType,
        Math.max(0, Math.round(stat.latencyMs)),
        Math.max(0, Math.round(stat.inputTokens)),
        Math.max(0, Math.round(stat.outputTokens)),
        costUsd,
        stat.toolCallSuccess ? 1 : 0,
        stat.proofGatePassed === undefined ? null : stat.proofGatePassed ? 1 : 0,
        Date.now()
      );
    } catch {
      // Non-blocking if DB is unavailable
    }

    if (profile && stat.proofGatePassed !== undefined) {
      const prevTotal = profile.totalTasksExecuted;
      const prevPassed =
        profile.historicalPassRate !== null ? (profile.historicalPassRate / 100) * prevTotal : 0;
      const nextTotal = prevTotal + 1;
      const nextPassed = prevPassed + (stat.proofGatePassed ? 1 : 0);
      profile.totalTasksExecuted = nextTotal;
      profile.historicalPassRate = Number(((nextPassed / nextTotal) * 100).toFixed(2));
      profile.telemetryProvenance = {
        computedFrom: stat.computedFrom || `model_stats:${id}`,
        computedAt: new Date().toISOString(),
      };
    }

    return id;
  }

  /**
   * Query aggregated empirical telemetry from SQLite `model_stats` for a model (NEXT-C-18).
   */
  static getAggregatedStats(modelId: string): AggregatedModelStats {
    try {
      const db = getDatabase();
      const row = db
        .prepare(`
          SELECT
            COUNT(*) as totalRuns,
            AVG(latency_ms) as avgLatencyMs,
            AVG(tool_call_success) as toolCallSuccessRatio,
            AVG(CASE WHEN proof_gate_passed IS NOT NULL THEN proof_gate_passed END) as proofPassRatio,
            SUM(input_tokens) as totalInputTokens,
            SUM(output_tokens) as totalOutputTokens,
            SUM(cost_usd) as totalCostUsd
          FROM model_stats
          WHERE model_id = ?
        `)
        .get(modelId) as {
        totalRuns: number;
        avgLatencyMs: number | null;
        toolCallSuccessRatio: number | null;
        proofPassRatio: number | null;
        totalInputTokens: number | null;
        totalOutputTokens: number | null;
        totalCostUsd: number | null;
      };

      const totalRuns = Number(row?.totalRuns || 0);
      return {
        modelId,
        totalRuns,
        avgLatencyMs: totalRuns > 0 ? Math.round(Number(row.avgLatencyMs || 0)) : 0,
        toolCallSuccessRate:
          totalRuns > 0 ? Number((Number(row.toolCallSuccessRatio || 0) * 100).toFixed(2)) : 0,
        proofPassRate:
          row?.proofPassRatio !== null && row?.proofPassRatio !== undefined
            ? Number((Number(row.proofPassRatio) * 100).toFixed(2))
            : null,
        totalInputTokens: Number(row?.totalInputTokens || 0),
        totalOutputTokens: Number(row?.totalOutputTokens || 0),
        totalCostUsd: Number(Number(row?.totalCostUsd || 0).toFixed(8)),
      };
    } catch {
      return {
        modelId,
        totalRuns: 0,
        avgLatencyMs: 0,
        toolCallSuccessRate: 0,
        proofPassRate: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
      };
    }
  }

  /**
   * Record an empirical task execution outcome with explicit provenance.
   */
  static recordEmpiricalOutcome(modelId: string, passed: boolean, computedFrom: string): void {
    this.recordModelStat({
      modelId,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCallSuccess: passed,
      proofGatePassed: passed,
      computedFrom,
    });
  }

  /**
   * Get all registered candidate models
   */
  static getAllModels(): ModelProfile[] {
    return Array.from(this.models.values());
  }

  /**
   * Dynamically match best candidate model according to task capability requirements
   */
  static selectBestModel(req: TaskRequirements): ModelProfile {
    const candidates = this.getAllModels();

    let bestModel = candidates[0];
    let highestScore = -Infinity;

    for (const m of candidates) {
      let score = 0;

      // Large context requirement
      if (req.estimatedTokens && req.estimatedTokens > 150_000) {
        if (m.capabilities.has('large_context') && m.contextWindow >= req.estimatedTokens) {
          score += 60;
        } else {
          score -= 100;
        }
      }

      // Computer use requirement
      if (req.requiresComputerUse) {
        if (m.capabilities.has('computer_use')) score += 60;
        else score -= 80;
      }

      // Security audit requirement
      if (req.isSecurityAudit) {
        if (m.capabilities.has('security_audit')) score += 40;
        if (m.capabilities.has('ast_surgical_edit')) score += 15;
      }

      // Complex multi-file refactoring
      if (req.fileCount && req.fileCount > 5) {
        if (m.capabilities.has('complex_reasoning')) score += 35;
      }

      // Latency preference
      if (req.latencyTolerance === 'LOW') {
        if (m.latencyTier === 'ULTRA_LOW') score += 25;
        else if (m.latencyTier === 'LOW') score += 15;
      }

      // Budget preference
      if (req.budgetConstraint === 'CHEAPEST') {
        score -= (m.costPer1kInputUsd + m.costPer1kOutputUsd) * 1000;
      } else if (req.budgetConstraint === 'MAX_QUALITY') {
        if (m.capabilities.has('complex_reasoning')) score += 25;
        if (m.historicalPassRate !== null) {
          score += m.historicalPassRate * 0.5;
        }
      }

      // Empirical track record weight (only applied when backed by real telemetry)
      if (m.historicalPassRate !== null && m.totalTasksExecuted > 0) {
        score += (m.historicalPassRate - 90) * 5;
      }

      if (score > highestScore) {
        highestScore = score;
        bestModel = m;
      }
    }

    return bestModel;
  }

  /**
   * Select top N diverse models for Model Tournament
   */
  static selectTournamentCandidates(req: TaskRequirements, count = 3): ModelProfile[] {
    const all = this.getAllModels();
    const sorted = [...all].sort((a, b) => {
      const rateA = a.historicalPassRate ?? 0;
      const rateB = b.historicalPassRate ?? 0;
      if (rateB !== rateA) return rateB - rateA;
      return b.capabilities.size - a.capabilities.size;
    });
    const selected: ModelProfile[] = [];
    const usedProviders = new Set<string>();

    for (const m of sorted) {
      if (!usedProviders.has(m.provider) || selected.length >= count) {
        selected.push(m);
        usedProviders.add(m.provider);
        if (selected.length === count) break;
      }
    }

    return selected.length > 0 ? selected : sorted.slice(0, count);
  }
}
