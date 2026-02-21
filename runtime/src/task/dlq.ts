/**
 * DeadLetterQueue — in-memory queue for capturing failed tasks with full context.
 *
 * Tasks that fail after retry exhaustion are placed in the DLQ for inspection,
 * manual retry, and alerting. The queue has a configurable max size and evicts
 * the oldest entries (FIFO) when full.
 *
 * @module
 */

import type { DeadLetterEntry, DeadLetterQueueConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_DLQ_CONFIG: DeadLetterQueueConfig = {
  maxSize: 1000,
};

// ============================================================================
// DeadLetterQueue Class
// ============================================================================

/**
 * In-memory dead letter queue for failed tasks.
 *
 * @example
 * ```typescript
 * const dlq = new DeadLetterQueue({ maxSize: 500 });
 *
 * dlq.add({
 *   taskPda: 'abc123...',
 *   task: onChainTask,
 *   error: 'RPC timeout',
 *   failedAt: Date.now(),
 *   stage: 'claim',
 *   attempts: 3,
 *   retryable: true,
 * });
 *
 * console.log(dlq.size()); // 1
 * const entries = dlq.getAll();
 * ```
 */
export class DeadLetterQueue {
  private readonly maxSize: number;
  private readonly entries: DeadLetterEntry[] = [];

  constructor(config?: Partial<DeadLetterQueueConfig>) {
    this.maxSize = config?.maxSize ?? DEFAULT_DLQ_CONFIG.maxSize;
  }

  /**
   * Add a failed task entry to the DLQ.
   * If the queue is at max capacity, the oldest entry is evicted (FIFO).
   */
  add(entry: DeadLetterEntry): void {
    if (this.entries.length >= this.maxSize) {
      this.entries.shift();
    }
    this.entries.push(entry);
  }

  /**
   * Get all entries in the DLQ, ordered from oldest to newest.
   */
  getAll(): DeadLetterEntry[] {
    return [...this.entries];
  }

  /**
   * Get a specific entry by task PDA (base58 string).
   * Returns undefined if not found.
   */
  getByTaskId(taskPda: string): DeadLetterEntry | undefined {
    return this.entries.find((e) => e.taskPda === taskPda);
  }

  /**
   * Remove and return an entry by task PDA for retry.
   * Returns the entry if found and removed, undefined otherwise.
   */
  retry(taskPda: string): DeadLetterEntry | undefined {
    const index = this.entries.findIndex((e) => e.taskPda === taskPda);
    if (index === -1) {
      return undefined;
    }
    return this.entries.splice(index, 1)[0];
  }

  /**
   * Remove an entry by task PDA without returning it.
   * Returns true if the entry was found and removed.
   */
  remove(taskPda: string): boolean {
    const index = this.entries.findIndex((e) => e.taskPda === taskPda);
    if (index === -1) {
      return false;
    }
    this.entries.splice(index, 1);
    return true;
  }

  /**
   * Get the current number of entries in the DLQ.
   */
  size(): number {
    return this.entries.length;
  }

  /**
   * Remove all entries from the DLQ.
   */
  clear(): void {
    this.entries.length = 0;
  }
}
