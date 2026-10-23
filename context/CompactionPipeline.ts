import type { UnifiedMessage } from '../types/index.js';
import { TokenCounter } from './TokenCounter.js';
import {
  MultiTierCompactor,
  type CompactionReport,
  type PostCompactReconstruction,
} from './MultiTierCompactor.js';

export interface CompactionPipelineOptions {
  targetTokens: number;
  preserveRecentTurns?: number;
  maxToolResultLines?: number;
  reconstruction?: PostCompactReconstruction;
}

export interface CompactionPipelineResult {
  messages: UnifiedMessage[];
  initialTokens: number;
  finalTokens: number;
  totalTokensSaved: number;
  stagesExecuted: Array<'prune_tool_outputs' | 'summarize_intermediate_turns' | 'pin_and_reconstruct'>;
  reports: CompactionReport[];
}

/**
 * Three-Stage Context Compaction Pipeline (NEXT-C-07):
 * 1. `prune_tool_outputs`: Truncates verbose old tool outputs while preserving headers and recent turns.
 * 2. `summarize_intermediate_turns`: Collapses older conversational turns into structured summaries.
 * 3. `pin_and_reconstruct`: Executes executive auto-compaction while pinning system messages, `isPinned` messages, and active plan/task state.
 */
export class CompactionPipeline {
  static run(
    messages: UnifiedMessage[],
    options: CompactionPipelineOptions
  ): CompactionPipelineResult {
    const initialTokens = TokenCounter.estimateMessagesTokens(messages);
    let currentMessages = [...messages];
    const stagesExecuted: CompactionPipelineResult['stagesExecuted'] = [];
    const reports: CompactionReport[] = [];

    if (initialTokens <= options.targetTokens) {
      return {
        messages: currentMessages,
        initialTokens,
        finalTokens: initialTokens,
        totalTokensSaved: 0,
        stagesExecuted,
        reports,
      };
    }

    // Stage 1: Prune oversized old tool outputs
    const stage1 = MultiTierCompactor.applyMicroCompact(
      currentMessages,
      options.preserveRecentTurns ?? 2,
      options.maxToolResultLines ?? 12
    );
    currentMessages = stage1.messages;
    stagesExecuted.push('prune_tool_outputs');
    reports.push(stage1.report);

    // Stage 2: Summarize intermediate turns if still above targetTokens
    if (TokenCounter.estimateMessagesTokens(currentMessages) > options.targetTokens) {
      const stage2 = MultiTierCompactor.applyContextCollapse(currentMessages);
      currentMessages = stage2.messages;
      stagesExecuted.push('summarize_intermediate_turns');
      reports.push(stage2.report);
    }

    // Stage 3: Pin architectural decisions & reconstruct executive summary if still above targetTokens
    if (TokenCounter.estimateMessagesTokens(currentMessages) > options.targetTokens) {
      const stage3 = MultiTierCompactor.applyAutoCompact(currentMessages, options.reconstruction);
      currentMessages = stage3.messages;
      stagesExecuted.push('pin_and_reconstruct');
      reports.push(stage3.report);
    }

    const finalTokens = TokenCounter.estimateMessagesTokens(currentMessages);
    return {
      messages: currentMessages,
      initialTokens,
      finalTokens,
      totalTokensSaved: Math.max(0, initialTokens - finalTokens),
      stagesExecuted,
      reports,
    };
  }
}
