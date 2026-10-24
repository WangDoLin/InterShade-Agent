import type { UnifiedMessage } from '../types/index.js';
import { MultiTierCompactor, type CompactionReport, type PostCompactReconstruction } from './MultiTierCompactor.js';
import { TokenCounter } from './TokenCounter.js';
import { TrajectoryCompressor } from './TrajectoryCompressor.js';

export interface MicroCompactorOptions {
  maxContextTokens?: number;
  autoCompactThreshold?: number; // default 0.70 (70% of context window)
  microCompactIntervalTurns?: number; // micro-compact verbose tool outputs every N turns
}

export interface ContextOptimizationResult {
  messages: UnifiedMessage[];
  wasCompacted: boolean;
  layer?: 'micro' | 'trajectory' | 'collapse' | 'auto' | 'reactive';
  originalTokens: number;
  newTokens: number;
  tokensSaved: number;
  actionTaken?: string;
}

/**
 * ContextMicroCompactor provides progressive, multi-tier context compression
 * inspired by Hermes Agent context_compressor.py and micro_compaction.py.
 *
 * Strategies:
 * 1. Micro-compact: Truncates verbose older tool outputs (>12 lines) while keeping head & tail lines.
 * 2. Trajectory Distillation: Semantic distillation of middle turns into an executive ledger.
 * 3. Auto-compaction: Executive compression when token count exceeds 70% of context window.
 * 4. Reactive Compaction: Emergency purge for HTTP 413 context overflow errors.
 */
export class ContextMicroCompactor {
  private maxContextTokens: number;
  private autoCompactThreshold: number;

  constructor(options: MicroCompactorOptions = {}) {
    this.maxContextTokens = options.maxContextTokens ?? 128000;
    this.autoCompactThreshold = options.autoCompactThreshold ?? 0.70;
  }

  public setMaxContextTokens(maxTokens: number): void {
    if (maxTokens > 0) {
      this.maxContextTokens = maxTokens;
    }
  }

  /**
   * Optimize the conversation message list before dispatching to the provider API.
   * Runs micro-compaction on tool results first, and if tokens exceed threshold,
   * runs trajectory distillation or auto-compaction.
   */
  optimize(
    messages: UnifiedMessage[],
    reconstruction?: PostCompactReconstruction
  ): ContextOptimizationResult {
    const originalTokens = TokenCounter.estimateMessagesTokens(messages);
    const tokenLimit = this.maxContextTokens * this.autoCompactThreshold;

    // Step 1: Always apply micro-compaction on older verbose tool outputs if we have >= 6 messages
    let currentMessages = messages;
    let totalSaved = 0;
    let appliedLayer: ContextOptimizationResult['layer'] | undefined;
    let actionSummary = '';

    if (messages.length >= 6) {
      const microResult = MultiTierCompactor.applyMicroCompact(currentMessages, 1, 12);
      if (microResult.report.tokensSaved > 0) {
        currentMessages = microResult.messages;
        totalSaved += microResult.report.tokensSaved;
        appliedLayer = 'micro';
        actionSummary = microResult.report.actionTaken;
      }
    }

    const midTokens = TokenCounter.estimateMessagesTokens(currentMessages);

    // Step 2: If tokens still exceed the threshold, run semantic trajectory distillation / auto-compaction
    if (midTokens >= tokenLimit && currentMessages.length >= 8) {
      const trajResult = TrajectoryCompressor.compressIfNeeded(
        currentMessages,
        this.maxContextTokens,
        this.autoCompactThreshold
      );

      if (trajResult.compressed) {
        currentMessages = trajResult.messages;
        const trajTokens = TokenCounter.estimateMessagesTokens(currentMessages);
        totalSaved += Math.max(0, midTokens - trajTokens);
        appliedLayer = 'trajectory';
        actionSummary = `Distilled middle trajectory into semantic checkpoint; preserved head and recent turns.`;
      } else {
        // Fallback to Layer 3 Auto-compaction
        const autoResult = MultiTierCompactor.applyAutoCompact(currentMessages, reconstruction);
        currentMessages = autoResult.messages;
        totalSaved += autoResult.report.tokensSaved;
        appliedLayer = 'auto';
        actionSummary = autoResult.report.actionTaken;
      }
    }

    const finalTokens = TokenCounter.estimateMessagesTokens(currentMessages);

    return {
      messages: currentMessages,
      wasCompacted: totalSaved > 0,
      layer: appliedLayer,
      originalTokens,
      newTokens: finalTokens,
      tokensSaved: Math.max(0, originalTokens - finalTokens),
      actionTaken: actionSummary || undefined,
    };
  }

  /**
   * Emergency compaction invoked upon HTTP 413 context overflow.
   */
  emergencyCompact(
    messages: UnifiedMessage[],
    reconstruction?: PostCompactReconstruction
  ): ContextOptimizationResult {
    const originalTokens = TokenCounter.estimateMessagesTokens(messages);
    const reactiveResult = MultiTierCompactor.applyReactiveCompact(messages, reconstruction);
    const finalTokens = TokenCounter.estimateMessagesTokens(reactiveResult.messages);

    return {
      messages: reactiveResult.messages,
      wasCompacted: true,
      layer: 'reactive',
      originalTokens,
      newTokens: finalTokens,
      tokensSaved: Math.max(0, originalTokens - finalTokens),
      actionTaken: reactiveResult.report.actionTaken,
    };
  }
}
