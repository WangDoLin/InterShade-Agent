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
        costPer1kInputUsd: 0.0001,
        costPer1kOutputUsd: 0.0004,
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
   * Register or update model profile
   */
  static registerModel(profile: ModelProfile): void {
    this.models.set(profile.id, profile);
  }

  /**
   * Record an empirical task execution outcome with explicit provenance.
   */
  static recordEmpiricalOutcome(modelId: string, passed: boolean, computedFrom: string): void {
    const profile = this.models.get(modelId);
    if (!profile) return;
    const prevTotal = profile.totalTasksExecuted;
    const prevPassed = profile.historicalPassRate !== null ? (profile.historicalPassRate / 100) * prevTotal : 0;
    const nextTotal = prevTotal + 1;
    const nextPassed = prevPassed + (passed ? 1 : 0);
    profile.totalTasksExecuted = nextTotal;
    profile.historicalPassRate = Number(((nextPassed / nextTotal) * 100).toFixed(2));
    profile.telemetryProvenance = {
      computedFrom,
      computedAt: new Date().toISOString(),
    };
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
