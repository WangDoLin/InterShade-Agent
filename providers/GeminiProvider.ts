import { BaseProvider, type ChatStreamParams } from './BaseProvider.js';
import type { StreamEvent } from '../types/index.js';
import { CompatibilityBridge } from './core/CompatibilityBridge.js';
import { GeminiAdapter } from './protocols/adapters/GeminiAdapter.js';

/**
 * Legacy compatibility facade delegating to GeminiAdapter via CompatibilityBridge (PROV-001).
 */
export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini';
  private readonly delegate: BaseProvider;

  constructor(_apiKey?: string) {
    super();
    this.delegate = CompatibilityBridge.create('google').provider;
  }

  streamChat(params: ChatStreamParams): AsyncGenerator<StreamEvent, void, unknown> {
    return this.delegate.streamChat(params);
  }

  static normalizeModelName(rawModel?: string): string {
    return GeminiAdapter.normalizeModelName(rawModel);
  }
}
