/**
 * Centralized policy constants for Swarm orchestration, file leases, and branch integration.
 * Enforces ENG-045 / NEXT-C-37: autoMerge must default to false across all entrypoints.
 */
export const SwarmPolicy = {
  /**
   * Never auto-merge background worktree branches into main unless explicitly opted in.
   * Instead, generate MergeProposals for human or verifier review.
   */
  autoMerge: false,
  /**
   * Default file lock lease TTL in milliseconds (60 seconds).
   */
  defaultLeaseTtlMs: 60_000,
  /**
   * Heartbeat interval factor (renews every ttlMs / 3 = 20 seconds).
   */
  heartbeatDivisor: 3,
  /**
   * Default FIFO queue wait timeout when acquiring contested file leases (120 seconds).
   */
  defaultWaitTimeoutMs: 120_000,
  /**
   * Expiration window for undecided MergeProposals (7 days).
   */
  proposalRetentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export const DEFAULT_SWARM_POLICY = SwarmPolicy;

export interface SwarmPolicyConfig {
  autoMerge: boolean;
  defaultLeaseTtlMs: number;
  heartbeatDivisor: number;
  defaultWaitTimeoutMs: number;
  proposalRetentionMs: number;
}

/**
 * Resolves the effective autoMerge setting from an optional caller flag.
 * Returns true ONLY when the caller explicitly passes `true`; otherwise returns `SwarmPolicy.autoMerge` (`false`).
 */
export function resolveAutoMerge(explicitValue?: boolean): boolean {
  return explicitValue === true ? true : SwarmPolicy.autoMerge;
}
