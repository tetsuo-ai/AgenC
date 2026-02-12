/**
 * TaskScanner - Discovers and filters available tasks
 *
 * Supports both polling-based and event-based task discovery.
 *
 * @module
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { Task, TaskStatus, TaskFilter } from './types.js';
import { Logger, silentLogger } from '../utils/logger.js';
import type { AgencCoordination } from '../types/agenc_coordination.js';

/**
 * Configuration for TaskScanner
 */
export interface TaskScannerConfig {
  connection: Connection;
  program: Program<AgencCoordination>;
  filter?: TaskFilter;
  logger?: Logger;
}

/**
 * Event subscription handle
 */
export interface TaskEventSubscription {
  unsubscribe(): Promise<void>;
}

/**
 * Callback for task created events
 */
export type TaskCreatedCallback = (task: Task, slot: number, signature: string) => void;

/**
 * Raw TaskCreated event from Anchor
 */
interface RawTaskCreatedEvent {
  taskId: number[] | Uint8Array;
  creator: PublicKey;
  requiredCapabilities: { toString: () => string } | bigint | number;
  rewardAmount: { toString: () => string } | bigint | number;
  taskType: number;
  deadline: { toNumber: () => number } | number;
  timestamp: { toNumber: () => number } | number;
}

/**
 * Scans the blockchain for available tasks matching filter criteria.
 *
 * Supports two discovery modes:
 * - **Polling**: Call `scan()` periodically to fetch all open tasks
 * - **Event-based**: Call `subscribeToNewTasks()` for real-time notifications
 *
 * @example
 * ```typescript
 * // Polling mode
 * const scanner = new TaskScanner({ connection, program });
 * const tasks = await scanner.scan();
 *
 * // Event-based mode
 * const subscription = scanner.subscribeToNewTasks((task, slot) => {
 *   console.log('New task:', task.pda.toBase58());
 * });
 * // Later: await subscription.unsubscribe();
 * ```
 */
export class TaskScanner {
  private readonly program: Program<AgencCoordination>;
  private readonly filter: TaskFilter;
  private readonly logger: Logger;

  // Cache of known task PDAs to avoid re-processing
  private readonly knownTaskPdas: Set<string> = new Set();

  constructor(config: TaskScannerConfig) {
    this.program = config.program;
    this.filter = config.filter ?? {};
    this.logger = config.logger ?? silentLogger;
  }

  /**
   * Scan for all open tasks matching the filter.
   *
   * This is a polling-based approach that fetches all task accounts.
   * For high-frequency updates, prefer `subscribeToNewTasks()`.
   */
  async scan(): Promise<Task[]> {
    this.logger.debug('Scanning for tasks...');

    try {
      // Fetch all task accounts
      const taskAccounts = await this.program.account.task.all();

      const tasks: Task[] = [];

      for (const account of taskAccounts) {
        const task = this.parseTaskAccount(account.publicKey, account.account);

        // Only consider open tasks
        if (task.status !== TaskStatus.Open) {
          continue;
        }

        // Check if task has available slots
        if (task.currentClaims >= task.maxWorkers) {
          continue;
        }

        // Apply filters
        if (this.matchesFilter(task)) {
          tasks.push(task);
          // Track known tasks
          this.knownTaskPdas.add(task.pda.toBase58());
        }
      }

      this.logger.debug(`Found ${tasks.length} matching tasks`);
      return tasks;
    } catch (error) {
      this.logger.error('Task scan failed:', error);
      return [];
    }
  }

  /**
   * Subscribe to new task creation events.
   *
   * This is more efficient than polling for real-time task discovery.
   * The callback is invoked whenever a new task is created that matches
   * the configured filter.
   *
   * @param callback - Function called when a new matching task is created
   * @returns Subscription handle for cleanup
   */
  subscribeToNewTasks(callback: TaskCreatedCallback): TaskEventSubscription {
    this.logger.debug('Subscribing to TaskCreated events...');

    const listenerId = this.program.addEventListener(
      'taskCreated',
      async (rawEvent: RawTaskCreatedEvent, slot: number, signature: string) => {
        try {
          // Derive task PDA from task ID
          const taskId = this.toUint8Array(rawEvent.taskId);
          const [taskPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('task'), taskId],
            this.program.programId
          );

          // Skip if we've already seen this task
          const pdaKey = taskPda.toBase58();
          if (this.knownTaskPdas.has(pdaKey)) {
            return;
          }
          this.knownTaskPdas.add(pdaKey);

          // Fetch full task account for complete data
          const task = await this.getTask(taskPda);
          if (!task) {
            this.logger.warn(`Could not fetch task ${pdaKey} after creation event`);
            return;
          }

          // Apply filters
          if (!this.matchesFilter(task)) {
            this.logger.debug(`Task ${pdaKey.slice(0, 8)} filtered out`);
            return;
          }

          callback(task, slot, signature);
        } catch (error) {
          this.logger.error('Error processing TaskCreated event:', error);
        }
      }
    );

    return {
      unsubscribe: async () => {
        await this.program.removeEventListener(listenerId);
        this.logger.debug('Unsubscribed from TaskCreated events');
      },
    };
  }

  /**
   * Get a specific task by PDA
   */
  async getTask(taskPda: PublicKey): Promise<Task | null> {
    try {
      const account = await this.program.account.task.fetch(taskPda);
      return this.parseTaskAccount(taskPda, account);
    } catch {
      return null;
    }
  }

  /**
   * Refresh a task's state from chain
   */
  async refreshTask(task: Task): Promise<Task | null> {
    return this.getTask(task.pda);
  }

  /**
   * Check if a task is still available to claim
   */
  async isTaskAvailable(task: Task): Promise<boolean> {
    const refreshed = await this.refreshTask(task);
    if (!refreshed) return false;
    return refreshed.status === TaskStatus.Open && refreshed.currentClaims < refreshed.maxWorkers;
  }

  /**
   * Clear the known tasks cache (useful after restart)
   */
  clearCache(): void {
    this.knownTaskPdas.clear();
  }

  /**
   * Check if a task matches the configured filter
   */
  matchesFilter(task: Task): boolean {
    const f = this.filter;

    // Capability filter - agent must have all required capabilities
    if (f.capabilities !== undefined) {
      if ((task.requiredCapabilities & f.capabilities) !== task.requiredCapabilities) {
        return false;
      }
    }

    // Reward filters
    if (f.minReward !== undefined && task.reward < f.minReward) {
      return false;
    }
    if (f.maxReward !== undefined && task.reward > f.maxReward) {
      return false;
    }

    // Creator filters
    if (f.trustedCreators !== undefined && f.trustedCreators.length > 0) {
      if (!f.trustedCreators.some((c) => c.equals(task.creator))) {
        return false;
      }
    }
    if (f.blockedCreators !== undefined) {
      if (f.blockedCreators.some((c) => c.equals(task.creator))) {
        return false;
      }
    }

    // Privacy filters
    const isPrivate = !this.isZeroHash(task.constraintHash);
    if (f.privateOnly && !isPrivate) {
      return false;
    }
    if (f.publicOnly && isPrivate) {
      return false;
    }

    // Mint filter
    if (f.acceptedMints !== undefined) {
      const taskMintKey = task.rewardMint?.toBase58() ?? null;
      const accepted = f.acceptedMints.some((m) => {
        if (m === null) return taskMintKey === null;
        return taskMintKey === m.toBase58();
      });
      if (!accepted) return false;
    }

    // Deadline filter - skip expired tasks
    if (task.deadline > 0 && task.deadline < Math.floor(Date.now() / 1000)) {
      return false;
    }

    // Custom filter
    if (f.custom && !f.custom(task)) {
      return false;
    }

    return true;
  }

  /**
   * Parse a task account into a Task object
   */
  private parseTaskAccount(pda: PublicKey, account: unknown): Task {
    const data = account as {
      taskId: number[] | Uint8Array;
      creator: PublicKey;
      requiredCapabilities: { toNumber?: () => number; toString?: () => string } | bigint | number;
      reward: { toNumber?: () => number; toString?: () => string } | bigint | number;
      description: number[] | Uint8Array;
      constraintHash: number[] | Uint8Array;
      deadline: { toNumber?: () => number } | bigint | number;
      maxWorkers: number;
      currentClaims: number;
      status:
        | { open?: unknown; inProgress?: unknown; completed?: unknown; cancelled?: unknown; disputed?: unknown }
        | number;
      rewardMint: PublicKey | null;
    };

    return {
      pda,
      taskId: this.toUint8Array(data.taskId),
      creator: data.creator,
      requiredCapabilities: this.toBigInt(data.requiredCapabilities),
      reward: this.toBigInt(data.reward),
      description: this.toUint8Array(data.description),
      constraintHash: this.toUint8Array(data.constraintHash),
      deadline: this.toNumber(data.deadline),
      maxWorkers: data.maxWorkers,
      currentClaims: data.currentClaims,
      status: this.parseStatus(data.status),
      rewardMint: data.rewardMint ?? null,
    };
  }

  private toUint8Array(value: number[] | Uint8Array): Uint8Array {
    if (value instanceof Uint8Array) return value;
    return new Uint8Array(value);
  }

  private toBigInt(value: { toNumber?: () => number; toString?: () => string } | bigint | number): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(value);
    if (value && typeof value.toString === 'function') {
      return BigInt(value.toString());
    }
    return 0n;
  }

  private toNumber(value: { toNumber?: () => number } | bigint | number): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (value && typeof value.toNumber === 'function') return value.toNumber();
    return 0;
  }

  private parseStatus(status: unknown): TaskStatus {
    if (typeof status === 'number') return status;
    if (status && typeof status === 'object') {
      if ('open' in status) return TaskStatus.Open;
      if ('inProgress' in status) return TaskStatus.InProgress;
      if ('completed' in status) return TaskStatus.Completed;
      if ('cancelled' in status) return TaskStatus.Cancelled;
      if ('disputed' in status) return TaskStatus.Disputed;
    }
    return TaskStatus.Open;
  }

  private isZeroHash(hash: Uint8Array): boolean {
    return hash.every((b) => b === 0);
  }

  /**
   * Update the filter
   */
  setFilter(filter: TaskFilter): void {
    Object.assign(this.filter, filter);
  }

  /**
   * Get the current filter
   */
  getFilter(): TaskFilter {
    return { ...this.filter };
  }
}
