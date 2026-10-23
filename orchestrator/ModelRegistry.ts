import { ModelResolver } from '../providers/catalog/ModelResolver.js';

export type ProviderName = 'google' | 'anthropic' | 'openai' | 'deepseek';

export interface ModelCapabilityRatings {
  readonly coding: number;     // 1 - 10
  readonly reasoning: number;  // 1 - 10
  readonly review: number;     // 1 - 10
  readonly speed: number;      // 1 - 10
}

export interface ModelFeatures {
  readonly thinkingModes?: ('low' | 'medium' | 'high')[];
  readonly computerUse?: boolean;
  readonly functionCalling?: boolean;
  readonly codeExecution?: boolean;
}

export interface ModelProfile {
  readonly modelId: string;
  readonly provider: ProviderName;
  readonly contextWindow: number;
  readonly ratings: ModelCapabilityRatings;
  readonly features: ModelFeatures;
  readonly costPer1MInput: number;   // USD
  readonly costPer1MOutput: number;  // USD
  readonly isDeprecated?: boolean;
  readonly statusNote?: string;
}

export interface ModelSelectionCriteria {
  readonly minContextTokens?: number;
  readonly primarySkill: 'coding' | 'reasoning' | 'review' | 'speed';
  readonly costPreference?: 'economy' | 'balanced' | 'performance';
  readonly preferredProvider?: ProviderName;
  readonly requireThinking?: boolean;
  readonly requireComputerUse?: boolean;
}

export class ModelRegistry {
  private static profiles: Map<string, ModelProfile> = new Map();

  static {
    // 1. Google Next-Gen Suite: Gemini 3.8 Flash (Long-Horizon SWE & Autonomous Agent specialized)
    this.register({
      modelId: 'gemini-3.8-flash',
      provider: 'google',
      contextWindow: 1_048_576, // 1M context
      ratings: { coding: 9, reasoning: 9, review: 8, speed: 10 },
      features: {
        thinkingModes: ['low', 'medium', 'high'],
        computerUse: true,
        functionCalling: true,
        codeExecution: true,
      },
      costPer1MInput: 0.15,
      costPer1MOutput: 0.60,
      statusNote: 'Active flagship for long-horizon autonomous software engineering',
    });

    // 2. Anthropic Hybrid Thinking: Claude 3.7 Sonnet
    this.register({
      modelId: 'claude-3-7-sonnet',
      provider: 'anthropic',
      contextWindow: 200_000,
      ratings: { coding: 10, reasoning: 10, review: 9, speed: 7 },
      features: {
        thinkingModes: ['low', 'medium', 'high'],
        functionCalling: true,
        computerUse: true,
      },
      costPer1MInput: 3.0,
      costPer1MOutput: 15.0,
      statusNote: 'Top-tier deep architectural reasoning & high thinking budget',
    });

    // 3. OpenAI Reasoning Flagship: o3-mini
    this.register({
      modelId: 'o3-mini',
      provider: 'openai',
      contextWindow: 200_000,
      ratings: { coding: 9, reasoning: 10, review: 8, speed: 8 },
      features: {
        thinkingModes: ['low', 'medium', 'high'],
        functionCalling: true,
      },
      costPer1MInput: 1.10,
      costPer1MOutput: 4.40,
      statusNote: 'High efficiency reasoning for algorithmic and race condition analysis',
    });

    // 4. OpenAI Multimodal/Coding Standard: GPT-4o
    this.register({
      modelId: 'gpt-4o',
      provider: 'openai',
      contextWindow: 128_000,
      ratings: { coding: 8, reasoning: 8, review: 8, speed: 8 },
      features: {
        functionCalling: true,
      },
      costPer1MInput: 2.50,
      costPer1MOutput: 10.0,
    });

    // 5. DeepSeek High-Value Model: DeepSeek-Chat
    this.register({
      modelId: 'deepseek-chat',
      provider: 'deepseek',
      contextWindow: 64_000,
      ratings: { coding: 8, reasoning: 8, review: 7, speed: 8 },
      features: {
        functionCalling: true,
      },
      costPer1MInput: 0.14,
      costPer1MOutput: 0.28,
      statusNote: 'High efficiency budget coding model',
    });

    // 6. Deprecated Catalog Marker: Gemini 2.0 Flash
    this.register({
      modelId: 'gemini-2.0-flash',
      provider: 'google',
      contextWindow: 1_048_576,
      ratings: { coding: 7, reasoning: 7, review: 6, speed: 9 },
      features: {},
      costPer1MInput: 0.10,
      costPer1MOutput: 0.40,
      isDeprecated: true,
      statusNote: 'Catalog shutdown - migrated to gemini-3.8-flash',
    });
  }

  static register(profile: ModelProfile): void {
    this.profiles.set(profile.modelId.toLowerCase(), profile);
  }

  static get(modelId: string): ModelProfile | undefined {
    return this.profiles.get(modelId.toLowerCase());
  }

  static listAll(includeDeprecated = false): ModelProfile[] {
    const all = Array.from(this.profiles.values());
    return includeDeprecated ? all : all.filter((p) => !p.isDeprecated);
  }

  /**
   * Intelligently resolve the optimal model matching criteria without hardcoding
   */
  static selectOptimalModel(criteria: ModelSelectionCriteria): ModelProfile {
    const candidates = this.listAll(false).filter((m) => {
      if (criteria.minContextTokens && m.contextWindow < criteria.minContextTokens) {
        return false;
      }
      if (criteria.requireThinking && (!m.features.thinkingModes || m.features.thinkingModes.length === 0)) {
        return false;
      }
      if (criteria.requireComputerUse && !m.features.computerUse) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      // Fallback to active flagship
      return this.get('gemini-3.8-flash') || this.listAll(false)[0];
    }

    // Rank candidates by composite skill score & cost preference
    const scored = candidates.map((m) => {
      const skillScore = m.ratings[criteria.primarySkill] || 5;
      let costScore = 1.0;

      if (criteria.costPreference === 'economy') {
        costScore = 1.0 / (m.costPer1MInput + 0.1);
      } else if (criteria.costPreference === 'performance') {
        costScore = 1.0;
      }

      let providerBonus = 0;
      if (criteria.preferredProvider && m.provider === criteria.preferredProvider) {
        providerBonus = 2.0;
      }

      const totalRank = skillScore * 2 + costScore * 0.5 + providerBonus;
      return { profile: m, rank: totalRank };
    });

    scored.sort((a, b) => b.rank - a.rank);
    return scored[0].profile;
  }

  /**
   * Intelligently resolves the maximum context window for a given model string
   * using the unified ModelResolver & ModelCatalogStore (CAT-001..030).
   */
  static resolveModelContextWindow(model: string, explicitMax?: number): number {
    if (explicitMax && explicitMax > 0) return explicitMax;
    const direct = this.get(model);
    if (direct?.contextWindow) return direct.contextWindow;
    return ModelResolver.resolveContextWindow(model, explicitMax);
  }
}

