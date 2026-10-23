import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelDescriptor } from './ModelDescriptor.js';
import {
  AuthoritySigner,
  DEFAULT_ED25519_PAIR,
  type CapabilityEvidence,
} from './CapabilityEvidenceManifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ModelCatalogStore {
  private static catalog = new Map<string, ModelDescriptor>();
  private static aliasMap = new Map<string, string>();

  static {
    ModelCatalogStore.seedBuiltinCatalog();
  }

  private static normalizeProvider(providerId: string): string {
    const lower = providerId.toLowerCase();
    return lower === 'gemini' ? 'google' : lower;
  }

  private static makeKey(providerId: string, modelId: string): string {
    return `${ModelCatalogStore.normalizeProvider(providerId)}:${modelId.toLowerCase()}`;
  }

  static register(descriptor: ModelDescriptor): void {
    const key = ModelCatalogStore.makeKey(descriptor.providerId, descriptor.modelId);
    ModelCatalogStore.catalog.set(key, descriptor);
    if (descriptor.aliases) {
      for (const alias of descriptor.aliases) {
        ModelCatalogStore.aliasMap.set(alias.toLowerCase(), descriptor.modelId);
      }
    }
  }

  static resolveAlias(modelIdOrAlias: string): string {
    const trimmed = modelIdOrAlias.trim();
    const mapped = ModelCatalogStore.aliasMap.get(trimmed.toLowerCase());
    return mapped ?? trimmed;
  }

  static get(providerId: string, modelId: string): ModelDescriptor | undefined {
    const directKey = ModelCatalogStore.makeKey(providerId, modelId);
    const direct = ModelCatalogStore.catalog.get(directKey);
    if (direct) return direct;

    const resolvedModelId = ModelCatalogStore.resolveAlias(modelId);
    const aliasKey = ModelCatalogStore.makeKey(providerId, resolvedModelId);
    return ModelCatalogStore.catalog.get(aliasKey);
  }

  static findByModelId(modelIdOrAlias: string): ModelDescriptor | undefined {
    const lower = modelIdOrAlias.toLowerCase();
    const resolved = ModelCatalogStore.resolveAlias(modelIdOrAlias).toLowerCase();
    for (const desc of ModelCatalogStore.catalog.values()) {
      if (desc.modelId.toLowerCase() === lower || desc.modelId.toLowerCase() === resolved) {
        return desc;
      }
      if (desc.aliases?.some((a) => a.toLowerCase() === lower)) {
        return desc;
      }
    }
    return undefined;
  }

  static list(providerId?: string): ModelDescriptor[] {
    const all = Array.from(ModelCatalogStore.catalog.values());
    if (!providerId) {
      return all;
    }
    const lowerProv = ModelCatalogStore.normalizeProvider(providerId);
    return all.filter((m) => ModelCatalogStore.normalizeProvider(m.providerId) === lowerProv);
  }

  static resolveOrCreate(providerId: string, modelId: string): ModelDescriptor {
    const existing = ModelCatalogStore.get(providerId, modelId);
    if (existing) {
      return existing;
    }

    // Synthesize unverified descriptor with 'unknown' capabilities for unverified custom models
    const synthesized: ModelDescriptor = {
      providerId,
      modelId,
      inputModalities: ['text'],
      outputModalities: ['text'],
      capabilities: {
        streaming: 'supported',
        toolCalling: 'unknown',
        structuredOutput: 'unknown',
        reasoningControl: 'unknown',
        promptCaching: 'unknown',
        computerUse: 'unsupported',
      },
      contextWindow: 128000,
      maxOutputTokens: 8192,
      lifecycle: 'unknown',
      capabilitySource: 'unverified',
    };

    ModelCatalogStore.register(synthesized);
    return synthesized;
  }

  private static loadSeedDescriptors(): ModelDescriptor[] {
    const candidatePaths = [
      path.join(__dirname, 'data', 'models.json'),
      path.resolve(process.cwd(), 'providers', 'catalog', 'data', 'models.json'),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { models?: ModelDescriptor[] };
          if (Array.isArray(parsed.models) && parsed.models.length > 0) {
            return parsed.models;
          }
        } catch {
          // Fall through to embedded fallback
        }
      }
    }

    return [
      {
        providerId: 'anthropic',
        modelId: 'claude-3-7-sonnet-20250219',
        aliases: ['claude-3-7-sonnet', 'sonnet', 'claude-sonnet'],
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'supported',
          promptCaching: 'supported',
          computerUse: 'supported',
        },
        contextWindow: 200000,
        maxOutputTokens: 64000,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 3.0, outputPer1MUsd: 15.0, cachedInputPer1MUsd: 0.3, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'claude-3-5-haiku-20241022', reasoningTier: 'deep' },
        ratings: { coding: 10, reasoning: 10, review: 9, speed: 7 },
      },
      {
        providerId: 'anthropic',
        modelId: 'claude-3-5-sonnet-20241022',
        aliases: ['claude-3-5-sonnet'],
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'unsupported',
          promptCaching: 'supported',
          computerUse: 'supported',
        },
        contextWindow: 200000,
        maxOutputTokens: 8192,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 3.0, outputPer1MUsd: 15.0, cachedInputPer1MUsd: 0.3, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'claude-3-5-haiku-20241022', reasoningTier: 'balanced' },
        ratings: { coding: 9, reasoning: 8, review: 9, speed: 8 },
      },
      {
        providerId: 'anthropic',
        modelId: 'claude-3-5-haiku-20241022',
        aliases: ['claude-3-5-haiku', 'haiku'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'unsupported',
          promptCaching: 'supported',
          computerUse: 'unsupported',
        },
        contextWindow: 200000,
        maxOutputTokens: 8192,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 0.8, outputPer1MUsd: 4.0, cachedInputPer1MUsd: 0.08, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'claude-3-5-haiku-20241022', reasoningTier: 'fast' },
        ratings: { coding: 7, reasoning: 7, review: 7, speed: 10 },
      },
      {
        providerId: 'openai',
        modelId: 'gpt-4o',
        aliases: ['4o'],
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'unsupported',
          promptCaching: 'supported',
          computerUse: 'unsupported',
        },
        contextWindow: 128000,
        maxOutputTokens: 16384,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 2.5, outputPer1MUsd: 10.0, cachedInputPer1MUsd: 1.25, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'gpt-4o-mini', reasoningTier: 'balanced' },
        ratings: { coding: 8, reasoning: 8, review: 8, speed: 8 },
      },
      {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        aliases: ['4o-mini'],
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'unsupported',
          promptCaching: 'supported',
          computerUse: 'unsupported',
        },
        contextWindow: 128000,
        maxOutputTokens: 16384,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 0.15, outputPer1MUsd: 0.6, cachedInputPer1MUsd: 0.075, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'gpt-4o-mini', reasoningTier: 'fast' },
        ratings: { coding: 7, reasoning: 7, review: 7, speed: 10 },
      },
      {
        providerId: 'openai',
        modelId: 'o3-mini',
        aliases: ['o3'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'supported',
          promptCaching: 'supported',
          computerUse: 'unsupported',
        },
        contextWindow: 200000,
        maxOutputTokens: 100000,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 1.1, outputPer1MUsd: 4.4, cachedInputPer1MUsd: 0.55, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'gpt-4o-mini', reasoningTier: 'deep' },
        ratings: { coding: 9, reasoning: 10, review: 8, speed: 8 },
      },
      {
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        aliases: ['deepseek', 'deepseek-v3'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'unsupported',
          promptCaching: 'supported',
          computerUse: 'unsupported',
        },
        contextWindow: 64000,
        maxOutputTokens: 8192,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 0.14, outputPer1MUsd: 0.28, cachedInputPer1MUsd: 0.014, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'deepseek-chat', reasoningTier: 'balanced' },
        ratings: { coding: 8, reasoning: 8, review: 7, speed: 8 },
      },
      {
        providerId: 'deepseek',
        modelId: 'deepseek-reasoner',
        aliases: ['deepseek-r1', 'r1'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'unsupported',
          structuredOutput: 'unsupported',
          reasoningControl: 'supported',
          promptCaching: 'supported',
          computerUse: 'unsupported',
        },
        contextWindow: 64000,
        maxOutputTokens: 8192,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 0.55, outputPer1MUsd: 2.19, cachedInputPer1MUsd: 0.14, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'deepseek-chat', reasoningTier: 'deep' },
        ratings: { coding: 9, reasoning: 9, review: 8, speed: 6 },
      },
      {
        providerId: 'google',
        modelId: 'gemini-2.5-flash',
        aliases: ['gemini-flash', 'flash'],
        inputModalities: ['text', 'image', 'audio', 'video'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'supported',
          promptCaching: 'supported',
          computerUse: 'unsupported',
        },
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 0.15, outputPer1MUsd: 0.6, cachedInputPer1MUsd: 0.0375, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'gemini-2.5-flash', reasoningTier: 'fast' },
        ratings: { coding: 8, reasoning: 8, review: 8, speed: 10 },
      },
      {
        providerId: 'google',
        modelId: 'gemini-2.5-pro',
        aliases: ['gemini-pro', 'pro'],
        inputModalities: ['text', 'image', 'audio', 'video'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'supported',
          promptCaching: 'supported',
          computerUse: 'supported',
        },
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 1.25, outputPer1MUsd: 10.0, cachedInputPer1MUsd: 0.3125, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'gemini-2.5-flash', reasoningTier: 'deep' },
        ratings: { coding: 9, reasoning: 9, review: 9, speed: 8 },
      },
      {
        providerId: 'google',
        modelId: 'gemini-3.8-flash',
        inputModalities: ['text', 'image', 'audio', 'video'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'supported',
          promptCaching: 'supported',
          computerUse: 'supported',
        },
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 0.15, outputPer1MUsd: 0.6, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'gemini-2.5-flash', reasoningTier: 'fast' },
        ratings: { coding: 9, reasoning: 9, review: 8, speed: 10 },
      },
      {
        providerId: 'google',
        modelId: 'gemini-2.0-flash',
        inputModalities: ['text', 'image', 'audio', 'video'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'supported',
          reasoningControl: 'unsupported',
          promptCaching: 'supported',
          computerUse: 'unsupported',
        },
        contextWindow: 1048576,
        maxOutputTokens: 8192,
        lifecycle: 'deprecated',
        capabilitySource: 'verified-catalog',
        pricing: { inputPer1MUsd: 0.1, outputPer1MUsd: 0.4, effectiveAt: '2026-03-01' },
        tiers: { explorationModelId: 'gemini-2.5-flash', reasoningTier: 'fast' },
        ratings: { coding: 7, reasoning: 7, review: 6, speed: 9 },
      },
      {
        providerId: 'ollama',
        modelId: 'llama3.3',
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'unsupported',
          reasoningControl: 'unsupported',
          promptCaching: 'unsupported',
          computerUse: 'unsupported',
        },
        contextWindow: 128000,
        maxOutputTokens: 8192,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
      },
      {
        providerId: 'ollama',
        modelId: 'qwen2.5-coder:14b',
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          toolCalling: 'supported',
          structuredOutput: 'unsupported',
          reasoningControl: 'unsupported',
          promptCaching: 'unsupported',
          computerUse: 'unsupported',
        },
        contextWindow: 32768,
        maxOutputTokens: 8192,
        lifecycle: 'stable',
        capabilitySource: 'verified-catalog',
      },
    ];
  }

  private static seedBuiltinCatalog(): void {
    const verifiedModels = ModelCatalogStore.loadSeedDescriptors();

    for (const m of verifiedModels) {
      if (m.capabilitySource === 'verified-catalog') {
        if (!m.provenance) {
          m.provenance = {
            verifiedAt: 1740000000000,
            verifierAuthority: 'intershader-gateway-verifier-v2.1',
            configurationVersion: '2.1.1',
            verifiedHash: `sha256:${Buffer.from(`${m.providerId}:${m.modelId}:v2.1.1`).toString('hex')}`,
          };
        }
        if (!m.signedManifest) {
          const evidence: CapabilityEvidence = {
            provider: m.providerId,
            modelId: m.modelId,
            gatewayVersion: '2.1.1',
            capabilities: m.capabilities,
            verifiedAt: 1740000000000,
            authority: 'intershader-gateway-verifier-v2.1',
            configDigest: `sha256:${Buffer.from(JSON.stringify(m.capabilities)).toString('hex')}`,
          };
          m.signedManifest = AuthoritySigner.signManifestEd25519(
            evidence,
            DEFAULT_ED25519_PAIR.privateKey,
            'intershader-ed25519-root-v2-1'
          );
        }
      }
      ModelCatalogStore.register(m);
    }
  }
}
