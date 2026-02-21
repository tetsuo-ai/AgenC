/**
 * TaskDiscovery — flexible task discovery system supporting poll, event, and hybrid modes.
 *
 * Agents use TaskDiscovery to find available tasks matching their capabilities.
 * Three modes are available:
 * - **poll**: Timer-based periodic discovery via fetchClaimableTasks
 * - **event**: Reactive discovery via TaskCreated on-chain events
 * - **hybrid**: Both modes with cross-source deduplication
 *
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type { EventSubscription, TaskCreatedEvent } from "../events/types.js";
import { subscribeToTaskCreated } from "../events/task.js";
import type { TaskOperations } from "./operations.js";
import type { OnChainTask } from "./types.js";
import { matchesFilter } from "./filters.js";
import type { TaskFilterConfig } from "./types.js";
import { deriveTaskPda } from "./pda.js";

// ============================================================================
// Configuration & Interfaces
// ============================================================================

/**
 * Discovery mode: how tasks are found.
 */
export type TaskDiscoveryMode = "poll" | "event" | "hybrid";

/**
 * Configuration for TaskDiscovery.
 */
export interface TaskDiscoveryOptions {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** TaskOperations instance for querying tasks */
  operations: TaskOperations;
  /** Filter configuration for task matching */
  filter: TaskFilterConfig;
  /** Discovery mode */
  mode: TaskDiscoveryMode;
  /** Poll interval in milliseconds (default 5000) */
  pollIntervalMs?: number;
  /** Logger instance (defaults to silent logger) */
  logger?: Logger;
}

/**
 * A task discovered by the TaskDiscovery system.
 */
export interface TaskDiscoveryResult {
  /** Task account PDA */
  pda: PublicKey;
  /** Parsed on-chain task data */
  task: OnChainTask;
  /** Timestamp when the task was discovered */
  discoveredAt: number;
  /** Which discovery source found it */
  source: "poll" | "event";
}

/**
 * Callback for discovered tasks.
 */
export type TaskDiscoveryListener = (task: TaskDiscoveryResult) => void;

// ============================================================================
// TaskDiscovery Class
// ============================================================================

/**
 * Flexible task discovery system supporting poll, event, and hybrid modes.
 *
 * @example
 * ```typescript
 * const discovery = new TaskDiscovery({
 *   program,
 *   operations,
 *   filter: { minRewardLamports: 1_000_000n },
 *   mode: 'hybrid',
 * });
 *
 * discovery.onTaskDiscovered((task) => {
 *   console.log(`Found task: ${task.pda.toBase58()}`);
 * });
 *
 * await discovery.start(AgentCapabilities.COMPUTE);
 * ```
 */
export class TaskDiscovery {
  private readonly program: Program<AgencCoordination>;
  private readonly operations: TaskOperations;
  private readonly filter: TaskFilterConfig;
  private readonly mode: TaskDiscoveryMode;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;

  private readonly listeners: Set<TaskDiscoveryListener> = new Set();
  private readonly seenTaskPdas: Set<string> = new Set();
  private running = false;
  private paused = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private eventSubscription: EventSubscription | null = null;
  private agentCapabilities: bigint = 0n;

  constructor(config: TaskDiscoveryOptions) {
    this.program = config.program;
    this.operations = config.operations;
    this.filter = config.filter;
    this.mode = config.mode;
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.logger = config.logger ?? silentLogger;
  }

  // ==========================================================================
  // Listener Registration
  // ==========================================================================

  /**
   * Register a listener for discovered tasks.
   * Returns an unsubscribe function.
   */
  onTaskDiscovered(callback: TaskDiscoveryListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start discovering tasks for the given agent capabilities.
   * Idempotent — calling when already started is a no-op.
   */
  async start(agentCapabilities: bigint): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.agentCapabilities = agentCapabilities;

    if (this.mode === "poll" || this.mode === "hybrid") {
      // Run an initial poll immediately, then set up the interval
      void this.executePollCycle();
      this.pollTimer = setInterval(
        () => void this.executePollCycle(),
        this.pollIntervalMs,
      );
    }

    if (this.mode === "event" || this.mode === "hybrid") {
      this.setupEventDiscovery();
    }

    this.logger.info(`TaskDiscovery started in ${this.mode} mode`);
  }

  /**
   * Stop discovering tasks.
   * Idempotent — calling when already stopped is a no-op.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.paused = false;

    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.eventSubscription) {
      await this.eventSubscription.unsubscribe();
      this.eventSubscription = null;
    }

    this.logger.info("TaskDiscovery stopped");
  }

  /**
   * Check if discovery is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ==========================================================================
  // Pause / Resume (Backpressure)
  // ==========================================================================

  /**
   * Pause discovery. Poll cycles and event processing are suppressed until resumed.
   * Idempotent — calling when already paused is a no-op.
   */
  pause(): void {
    if (this.paused || !this.running) {
      return;
    }
    this.paused = true;
    this.logger.info("TaskDiscovery paused");
  }

  /**
   * Resume discovery after a pause.
   * Idempotent — calling when not paused is a no-op.
   */
  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.logger.info("TaskDiscovery resumed");
  }

  /**
   * Check if discovery is currently paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  // ==========================================================================
  // Manual Poll
  // ==========================================================================

  /**
   * Manually trigger a poll cycle for tasks matching the given capabilities.
   * Returns newly discovered tasks (not previously seen).
   */
  async poll(agentCapabilities: bigint): Promise<TaskDiscoveryResult[]> {
    const discovered: TaskDiscoveryResult[] = [];
    try {
      const claimable = await this.operations.fetchClaimableTasks();

      for (const { task, taskPda } of claimable) {
        if (this.isDuplicate(taskPda)) {
          continue;
        }

        if (!matchesFilter(task, agentCapabilities, this.filter)) {
          continue;
        }

        const result: TaskDiscoveryResult = {
          pda: taskPda,
          task,
          discoveredAt: Date.now(),
          source: "poll",
        };

        this.seenTaskPdas.add(taskPda.toBase58());
        discovered.push(result);
        this.notifyListeners(result);
      }
    } catch (error) {
      this.logger.error(`Manual poll failed: ${error}`);
    }

    return discovered;
  }

  // ==========================================================================
  // Monitoring
  // ==========================================================================

  /**
   * Get the count of unique tasks discovered so far.
   */
  getDiscoveredCount(): number {
    return this.seenTaskPdas.size;
  }

  /**
   * Clear the seen task set. Useful for testing or resetting discovery state.
   */
  clearSeen(): void {
    this.seenTaskPdas.clear();
  }

  // ==========================================================================
  // Private Implementation
  // ==========================================================================

  /**
   * Execute a poll cycle, fetching and filtering tasks.
   */
  private async executePollCycle(): Promise<void> {
    if (this.paused) {
      return;
    }
    try {
      const claimable = await this.operations.fetchClaimableTasks();

      for (const { task, taskPda } of claimable) {
        if (this.isDuplicate(taskPda)) {
          continue;
        }

        if (!matchesFilter(task, this.agentCapabilities, this.filter)) {
          continue;
        }

        const result: TaskDiscoveryResult = {
          pda: taskPda,
          task,
          discoveredAt: Date.now(),
          source: "poll",
        };

        this.seenTaskPdas.add(taskPda.toBase58());
        this.notifyListeners(result);
      }
    } catch (error) {
      this.logger.error(`Poll cycle failed: ${error}`);
    }
  }

  /**
   * Set up event-based discovery via TaskCreated subscription.
   */
  private setupEventDiscovery(): void {
    this.eventSubscription = subscribeToTaskCreated(
      this.program,
      (event: TaskCreatedEvent) => {
        if (this.paused) {
          return;
        }
        // Derive the task PDA from the event data
        const { address: taskPda } = deriveTaskPda(
          event.creator,
          event.taskId,
          this.program.programId,
        );

        if (this.isDuplicate(taskPda)) {
          return;
        }

        // Fetch the full task account to apply filters
        this.operations
          .fetchTask(taskPda)
          .then((task: OnChainTask | null) => {
            if (!task) {
              this.logger.warn(
                `Event-discovered task not found on-chain: ${taskPda.toBase58()}`,
              );
              return;
            }

            if (!matchesFilter(task, this.agentCapabilities, this.filter)) {
              return;
            }

            const result: TaskDiscoveryResult = {
              pda: taskPda,
              task,
              discoveredAt: Date.now(),
              source: "event",
            };

            this.seenTaskPdas.add(taskPda.toBase58());
            this.notifyListeners(result);
          })
          .catch((error: unknown) => {
            this.logger.warn(`Failed to fetch event-discovered task: ${error}`);
          });
      },
    );
  }

  /**
   * Check if a task PDA has already been seen.
   */
  private isDuplicate(taskPda: PublicKey): boolean {
    return this.seenTaskPdas.has(taskPda.toBase58());
  }

  /**
   * Notify all listeners of a discovered task.
   * Exception isolation: one listener failure doesn't affect others.
   */
  private notifyListeners(task: TaskDiscoveryResult): void {
    for (const listener of this.listeners) {
      try {
        listener(task);
      } catch (error) {
        this.logger.error(`Listener threw exception: ${error}`);
      }
    }
  }
}
