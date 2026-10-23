import type { SignedCapabilityManifest } from './CapabilityEvidenceManifest.js';

export type Modality = 'text' | 'image' | 'audio' | 'video';

export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown';

export interface ModelCapabilities {
  streaming: CapabilityStatus;
  toolCalling: CapabilityStatus;
  structuredOutput: CapabilityStatus;
  reasoningControl: CapabilityStatus;
  promptCaching: CapabilityStatus;
  computerUse: CapabilityStatus;
}

export type CapabilitySource =
  | 'verified-catalog'
  | 'provider-api'
  | 'user-override'
  | 'heuristic-speculation'
  | 'unverified';

export type ModelLifecycle = 'stable' | 'preview' | 'deprecated' | 'unknown';

export interface CapabilityProvenance {
  verifiedAt: number;
  verifierAuthority: string;
  configurationVersion: string;
  verifiedHash?: string;
}

/**
 * Standardized pricing expressed in USD per 1,000,000 tokens (CAT-020).
 */
export interface ModelPricing {
  readonly inputPer1MUsd: number;
  readonly outputPer1MUsd: number;
  readonly cachedInputPer1MUsd?: number;
  readonly effectiveAt: string;
}

/**
 * Tier metadata for dual-loop exploration & reasoning routing (CAT-010).
 */
export interface ModelTierMapping {
  readonly explorationModelId?: string;
  readonly reasoningTier?: 'fast' | 'balanced' | 'deep';
}

export interface ModelSkillRatings {
  readonly coding: number;
  readonly reasoning: number;
  readonly review: number;
  readonly speed: number;
}

export interface ModelDescriptor {
  providerId: string;
  modelId: string;
  aliases?: string[];
  inputModalities: Modality[];
  outputModalities: Modality[];
  capabilities: ModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  lifecycle: ModelLifecycle;
  capabilitySource: CapabilitySource;
  pricing?: ModelPricing;
  tiers?: ModelTierMapping;
  ratings?: ModelSkillRatings;
  statusNote?: string;
  provenance?: CapabilityProvenance;
  signedManifest?: SignedCapabilityManifest;
}

export interface ModelRequirements {
  inputModalities?: Modality[];
  outputModalities?: Modality[];
  toolCalling?: 'required' | 'preferred' | 'optional';
  streaming?: 'required' | 'preferred' | 'optional';
  structuredOutput?: 'required' | 'preferred' | 'optional';
  reasoningControl?: 'required' | 'preferred' | 'optional';
  minContextWindow?: number;
  allowUnverified?: boolean;
}
