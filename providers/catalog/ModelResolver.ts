import { ModelCatalogStore } from './ModelCatalogStore.js';
import type { ModelDescriptor, ModelPricing } from './ModelDescriptor.js';

/**
 * Unified resolver for model aliases, exploration tiers, pricing, and context windows (CAT-001..030).
 */
export class ModelResolver {
  static resolveDescriptor(modelIdOrAlias: string): ModelDescriptor | undefined {
    const direct = ModelCatalogStore.findByModelId(modelIdOrAlias);
    if (direct) return direct;

    const baseName = modelIdOrAlias.includes('/')
      ? modelIdOrAlias.split('/').pop() || modelIdOrAlias
      : modelIdOrAlias;
    return ModelCatalogStore.findByModelId(baseName);
  }

  static resolveExplorationModel(requestedModel: string): string {
    const desc = ModelResolver.resolveDescriptor(requestedModel);
    if (desc?.tiers?.explorationModelId) {
      return desc.tiers.explorationModelId;
    }

    if (requestedModel.includes('claude-3-7') || requestedModel.includes('claude-3-5-sonnet')) {
      return 'claude-3-5-haiku-20241022';
    }
    if (requestedModel.includes('gpt-4o') || requestedModel.includes('o3-mini') || requestedModel.includes('o1')) {
      return 'gpt-4o-mini';
    }
    if (
      requestedModel.includes('gemini-2.5-pro') ||
      requestedModel.includes('gemini-1.5-pro') ||
      requestedModel.includes('gemini-2.0-pro')
    ) {
      return 'gemini-2.5-flash';
    }
    if (requestedModel.includes('deepseek-reasoner')) {
      return 'deepseek-chat';
    }

    return requestedModel;
  }

  static resolvePricing(modelIdOrAlias: string): ModelPricing | undefined {
    return ModelResolver.resolveDescriptor(modelIdOrAlias)?.pricing;
  }

  static resolveContextWindow(modelIdOrAlias: string, explicitMax?: number): number {
    if (explicitMax && explicitMax > 0) return explicitMax;
    const desc = ModelResolver.resolveDescriptor(modelIdOrAlias);
    if (desc?.contextWindow) return desc.contextWindow;

    const m = modelIdOrAlias.toLowerCase();
    if (m.includes('gemini-1.5') || m.includes('gemini-2.0') || m.includes('gemini-2.5') || m.includes('gemini-3')) {
      return 1_048_576;
    }
    if (m.includes('claude-3-7') || m.includes('claude-3-5') || m.includes('claude-3')) {
      return 200_000;
    }
    if (m.includes('gpt-4o') || m.includes('o1') || m.includes('o3')) {
      return 128_000;
    }
    if (m.includes('deepseek')) {
      return 64_000;
    }
    return 160_000;
  }
}
