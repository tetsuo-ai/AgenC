/**
 * InMemoryCheckpointStore — default in-memory implementation of CheckpointStore.
 *
 * Persists pipeline-stage checkpoints in a Map keyed by task PDA (base58).
 * Suitable for single-process runtimes; swap with a durable backend
 * (file, SQLite, etc.) for production crash recovery across restarts.
 *
 * @module
 */

import type { TaskCheckpoint, CheckpointStore } from './types.js';

/**
 * In-memory checkpoint store backed by a simple Map.
 *
 * @example
 * ```typescript
 * const store = new InMemoryCheckpointStore();
 * await store.save({ taskPda: 'abc', stage: 'claimed', claimResult, createdAt: Date.now(), updatedAt: Date.now() });
 * const cp = await store.load('abc');
 * ```
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly store: Map<string, TaskCheckpoint> = new Map();

  async save(checkpoint: TaskCheckpoint): Promise<void> {
    this.store.set(checkpoint.taskPda, checkpoint);
  }

  async load(taskPda: string): Promise<TaskCheckpoint | null> {
    return this.store.get(taskPda) ?? null;
  }

  async remove(taskPda: string): Promise<void> {
    this.store.delete(taskPda);
  }

  async listPending(): Promise<TaskCheckpoint[]> {
    return Array.from(this.store.values());
  }
}
