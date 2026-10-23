import { EventEmitter } from 'node:events';
import type { DepartmentContract, DepartmentBlackboardEntry, SwarmRole } from './SwarmTypes.js';

export class BlackboardVersionConflictError extends Error {
  readonly key: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(key: string, expectedVersion: number, actualVersion: number) {
    super(
      `[BLACKBOARD VERSION CONFLICT]: Key "${key}" expected version ${expectedVersion} but current version is ${actualVersion}.`
    );
    this.name = 'BlackboardVersionConflictError';
    this.key = key;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * DepartmentBlackboard provides real-time transactional shared memory and contract exchange
 * between concurrent agents operating inside a multi-threaded Software Engineering Department.
 * Supports optimistic concurrency control via monotonic `version` numbers per key (NEXT-C-06).
 */
export class DepartmentBlackboard extends EventEmitter {
  private static instance: DepartmentBlackboard | null = null;
  private contracts = new Map<string, DepartmentContract>();
  private entries = new Map<string, DepartmentBlackboardEntry>();

  constructor() {
    super();
  }

  static getInstance(): DepartmentBlackboard {
    if (!this.instance) {
      this.instance = new DepartmentBlackboard();
    }
    return this.instance;
  }

  /**
   * Publishes an interface contract or schema established by the Architect or Specialist
   */
  publishContract(contract: DepartmentContract): void {
    this.contracts.set(contract.id, contract);
    this.contracts.set(contract.name, contract);

    const existing = this.entries.get(`contract:${contract.name}`);
    const nextVersion = (existing?.version ?? 0) + 1;

    const entry: DepartmentBlackboardEntry = {
      key: `contract:${contract.name}`,
      category: 'contract',
      authorRole: contract.sourceRole,
      data: contract,
      version: nextVersion,
      timestamp: contract.publishedAt || Date.now(),
    };
    this.entries.set(entry.key, entry);

    this.emit('contract_published', contract);
    this.emit('entry_posted', entry);
  }

  /**
   * Retrieves an interface contract by name or ID
   */
  getContract(nameOrId: string): DepartmentContract | undefined {
    return this.contracts.get(nameOrId);
  }

  /**
   * Lists all published contracts
   */
  getContracts(): DepartmentContract[] {
    const unique = new Set<DepartmentContract>(this.contracts.values());
    return Array.from(unique);
  }

  /**
   * Posts a shared data entry with optional optimistic concurrency check (`expectedVersion`, NEXT-C-06).
   */
  postEntry(
    entry: Omit<DepartmentBlackboardEntry, 'timestamp' | 'version'> & { expectedVersion?: number }
  ): DepartmentBlackboardEntry {
    const existing = this.entries.get(entry.key);
    const currentVersion = existing?.version ?? 0;

    if (entry.expectedVersion !== undefined && entry.expectedVersion !== currentVersion) {
      throw new BlackboardVersionConflictError(entry.key, entry.expectedVersion, currentVersion);
    }

    const nextVersion = currentVersion + 1;
    const { expectedVersion: _exp, ...rest } = entry;
    const fullEntry: DepartmentBlackboardEntry = {
      ...rest,
      version: nextVersion,
      timestamp: Date.now(),
    };
    this.entries.set(fullEntry.key, fullEntry);
    this.emit('entry_posted', fullEntry);
    this.emit(`category:${fullEntry.category}`, fullEntry);
    return fullEntry;
  }

  /**
   * Retrieves an entry by key
   */
  getEntry(key: string): DepartmentBlackboardEntry | undefined {
    return this.entries.get(key);
  }

  /**
   * Lists entries filtered optionally by category
   */
  getEntries(category?: DepartmentBlackboardEntry['category']): DepartmentBlackboardEntry[] {
    const all = Array.from(this.entries.values());
    if (!category) return all;
    return all.filter((e) => e.category === category);
  }

  /**
   * Exports an overview summary of the current blackboard state
   */
  getDigest(): string {
    const contracts = this.getContracts();
    const allEntries = Array.from(this.entries.values());

    const lines: string[] = [
      `### Department Blackboard Digest`,
      `- **Active Contracts**: ${contracts.length}`,
      `- **Shared Entries**: ${allEntries.length}`,
      '',
    ];

    if (contracts.length > 0) {
      lines.push('#### Published Interface Contracts:');
      contracts.forEach((c, idx) => {
        lines.push(`${idx + 1}. **\`${c.name}\`** (by ${c.sourceRole}) -> Targets: [${c.targetRoles.join(', ')}]`);
      });
      lines.push('');
    }

    if (allEntries.length > 0) {
      lines.push('#### Shared Knowledge & Findings:');
      allEntries.slice(0, 10).forEach((e, idx) => {
        lines.push(`${idx + 1}. [${e.category.toUpperCase()}] **${e.key}** (v${e.version ?? 1}) by ${e.authorRole}`);
      });
    }

    return lines.join('\n');
  }

  /**
   * Clears blackboard state
   */
  clear(): void {
    this.contracts.clear();
    this.entries.clear();
    this.emit('cleared');
  }
}
