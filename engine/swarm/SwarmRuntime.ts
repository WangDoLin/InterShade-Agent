import { randomUUID } from 'node:crypto';
import { DepartmentBlackboard } from './DepartmentBlackboard.js';
import { MultiSessionPool, type SessionExecutorFactory } from './MultiSessionPool.js';
import { FileLockRegistry } from './FileLockRegistry.js';
import { DEFAULT_SWARM_POLICY, type SwarmPolicyConfig } from './SwarmPolicy.js';

export interface SwarmRuntimeOptions {
  missionId?: string;
  policy?: Partial<SwarmPolicyConfig>;
  executorFactory?: SessionExecutorFactory;
}

/**
 * Isolated per-mission runtime container (NEXT-C-02).
 * Replaces process-global singletons with a mission-scoped blackboard, session pool,
 * and policy configuration that cleans up all leases and worktree tabs on `dispose()`.
 */
export class SwarmRuntime {
  readonly missionId: string;
  readonly blackboard: DepartmentBlackboard;
  readonly sessionPool: MultiSessionPool;
  readonly policy: SwarmPolicyConfig;
  private readonly registeredSessions = new Set<string>();
  private disposed = false;

  constructor(options: SwarmRuntimeOptions = {}) {
    this.missionId = options.missionId || `mission-${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.blackboard = new DepartmentBlackboard();
    this.sessionPool = new MultiSessionPool(options.executorFactory);
    this.policy = {
      ...DEFAULT_SWARM_POLICY,
      ...(options.policy || {}),
      // Enforce P0 invariant: autoMerge is only enabled when explicitly true
      autoMerge: options.policy?.autoMerge === true,
    };

    this.sessionPool.on('tab_created', (tab: { id: string }) => {
      this.registeredSessions.add(tab.id);
    });
  }

  registerSession(sessionId: string): void {
    this.registeredSessions.add(sessionId);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Release all file leases held by sessions in this runtime, clear its blackboard,
   * and tear down all secondary session tabs.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sessionId of this.registeredSessions) {
      FileLockRegistry.releaseAllLeasesForSession(sessionId);
    }
    this.registeredSessions.clear();
    this.sessionPool.clearAll();
    this.blackboard.clear();
  }
}
