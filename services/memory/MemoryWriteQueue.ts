import { runInTransaction } from '../../state/Database.js';
import { FtsMemoryService, MemoryEntry } from './FtsMemoryService.js';

export interface MemoryWriteQueueOptions {
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueDepth?: number;
}

/**
 * Bounded write queue for SQLite FTS memory writes (NEXT-C-11).
 * Batches multiple writes into a single atomic SQLite transaction to eliminate
 * SQLITE_BUSY contention during multi-worker Swarm execution.
 */
export class MemoryWriteQueue {
  private queue: Array<{
    entry: Omit<MemoryEntry, 'id' | 'createdAt'>;
    resolve: (res: MemoryEntry) => void;
    reject: (err: unknown) => void;
  }> = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueDepth: number;

  constructor(options: MemoryWriteQueueOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 50;
    this.maxBatchSize = options.maxBatchSize ?? 32;
    this.maxQueueDepth = options.maxQueueDepth ?? 512;
  }

  /**
   * Enqueue a memory record for batched transactional persistence.
   */
  enqueue(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryEntry> {
    if (this.queue.length >= this.maxQueueDepth) {
      this.flushSync();
    }

    return new Promise<MemoryEntry>((resolve, reject) => {
      this.queue.push({ entry, resolve, reject });
      if (this.queue.length >= this.maxBatchSize) {
        this.flushSync();
      } else if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flushSync();
        }, this.flushIntervalMs);
        this.timer.unref?.();
      }
    });
  }

  /**
   * Synchronously flush all queued memory writes in a single transaction.
   */
  flushSync(): MemoryEntry[] {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) {
      return [];
    }

    const batch = this.queue.splice(0, this.queue.length);
    try {
      const results = runInTransaction(() => {
        return batch.map((item) => FtsMemoryService.recordMemory(item.entry));
      });
      batch.forEach((item, idx) => item.resolve(results[idx]!));
      return results;
    } catch (err) {
      batch.forEach((item) => item.reject(err));
      throw err;
    }
  }

  getPendingCount(): number {
    return this.queue.length;
  }
}
