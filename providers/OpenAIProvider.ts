import { BaseProvider, type ChatStreamParams } from './BaseProvider.js';
import type { StreamEvent } from '../types/index.js';
import { CompatibilityBridge } from './core/CompatibilityBridge.js';

/**
 * Legacy compatibility facade delegating to OpenAIChatAdapter via CompatibilityBridge (PROV-001).
 */
export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';
  private readonly delegate: BaseProvider;

  constructor(_apiKey?: string, _baseURL?: string) {
    super();
    this.delegate = CompatibilityBridge.create('openai').provider;
  }

  streamChat(params: ChatStreamParams): AsyncGenerator<StreamEvent, void, unknown> {
    return this.delegate.streamChat(params);
  }
}
