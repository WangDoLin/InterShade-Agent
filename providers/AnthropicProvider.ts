import { BaseProvider, type ChatStreamParams } from './BaseProvider.js';
import type { StreamEvent } from '../types/index.js';
import { CompatibilityBridge } from './core/CompatibilityBridge.js';

/**
 * Legacy compatibility facade delegating to AnthropicAdapter via CompatibilityBridge (PROV-001).
 */
export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  private readonly delegate: BaseProvider;

  constructor(_apiKey?: string) {
    super();
    this.delegate = CompatibilityBridge.create('anthropic').provider;
  }

  streamChat(params: ChatStreamParams): AsyncGenerator<StreamEvent, void, unknown> {
    return this.delegate.streamChat(params);
  }
}
