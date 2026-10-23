import { ModelResolver } from '../providers/catalog/ModelResolver.js';

export type ModelTier = 'fast_explorer' | 'deep_reasoner';

/**
 * DualLoopExecutor handles intelligent 2-tier cognitive routing.
 * Uses lightweight/fast models for search and discovery, and deep reasoning models for complex edits.
 * Backed by the unified ModelCatalogStore & ModelResolver (CAT-010).
 */
export class DualLoopExecutor {
  /**
   * Determine the optimal model tier based on the current tool execution stage.
   * If isSurgicalTask is true or isExplorationPhase is false, always preserves the requested deep model.
   */
  static selectModelTier(isExplorationPhase: boolean, requestedModel: string, isSurgicalTask?: boolean): string {
    if (!isExplorationPhase || isSurgicalTask) {
      return requestedModel;
    }

    return ModelResolver.resolveExplorationModel(requestedModel);
  }
}
