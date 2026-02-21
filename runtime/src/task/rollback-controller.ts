/**
 * RollbackController - Cascade rollback handling for speculative execution
 *
 * When an optimistically deferred proof fails, all speculative work built on
 * that result must be unwound. This controller handles:
 * - BFS traversal through DependencyGraph to find affected tasks
 * - Aborting executing tasks via AbortController
 * - Canceling pending proofs
 * - Marking commitments as failed
 * - Tracking rollback metrics (wasted compute, stake lost)
 *
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import { DependencyGraph, type TaskNode } from './dependency-graph.js';
import { CommitmentLedger } from './commitment-ledger.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Reason for triggering a rollback.
 */
export type RollbackReason =
  | 'proof_failed' // Proof verification failed on-chain
  | 'proof_timeout' // Proof generation timed out
  | 'ancestor_failed' // Ancestor task proof failed (cascade)
  | 'manual'; // Manual rollback requested

/**
 * State of a task when it was rolled back.
 */
export type RolledBackTaskState =
  | 'executing' // Task was still executing
  | 'executed' // Task execution completed, no proof yet
  | 'proof_generating' // Proof generation was in progress
  | 'proof_generated'; // Proof was ready but not submitted

/**
 * Action taken to roll back a task.
 */
export type RolledBackTaskAction =
  | 'aborted' // Execution was aborted via AbortController
  | 'discarded' // Result was discarded (no abort needed)
  | 'cancelled'; // Pending proof was cancelled

/**
 * Configuration for the RollbackController.
 */
export interface RollbackConfig {
  /** Allow retrying the failed task after rollback */
  allowRetry: boolean;

  /** Maximum retry attempts for failed tasks */
  maxRetries: number;

  /** Delay before retry (ms) */
  retryDelayMs: number;

  /** Whether to emit events for observability */
  enableEvents: boolean;
}

/**
 * Information about a task that was rolled back.
 */
export interface RolledBackTask {
  /** Task account PDA */
  taskPda: PublicKey;

  /** Unique 32-byte task identifier */
  taskId: Uint8Array;

  /** State the task was in when rolled back */
  state: RolledBackTaskState;

  /** Action taken to roll back the task */
  action: RolledBackTaskAction;

  /** Compute time wasted (ms) */
  computeTimeMs: number;

  /** Stake that was at risk */
  stakeAtRisk: bigint;
}

/**
 * Result of a rollback operation.
 */
export interface RollbackResult {
  /** Task that triggered the rollback */
  rootTaskPda: PublicKey;

  /** Reason for rollback */
  reason: RollbackReason;

  /** All tasks that were rolled back (not including root) */
  rolledBackTasks: RolledBackTask[];

  /** Total compute time wasted (ms) */
  wastedComputeMs: number;

  /** Total stake that was at risk */
  stakeAtRisk: bigint;

  /** Timestamp when rollback was executed */
  timestamp: number;
}

/**
 * Validation details for a completed rollback chain.
 */
export interface RollbackChainValidation {
  /** Whether the rollback was complete (no orphaned descendants). */
  valid: boolean;
  /** Orphaned task PDAs that were not rolled back. */
  orphans: PublicKey[];
  /** Descendants already in terminal state. */
  alreadyTerminal: PublicKey[];
  /** Maximum depth among descendants. */
  maxChainDepth: number;
}

/**
 * Event callbacks for rollback operations.
 */
export interface RollbackEvents {
  /** Called when a rollback operation starts */
  onRollbackStarted?: (rootTaskPda: PublicKey, affectedCount: number) => void;

  /** Called for each task that is rolled back */
  onTaskRolledBack?: (task: RolledBackTask) => void;

  /** Called when a rollback operation completes */
  onRollbackCompleted?: (result: RollbackResult) => void;

  /** Called when a retry is scheduled */
  onRetryScheduled?: (
    taskPda: PublicKey,
    retryCount: number,
    delayMs: number
  ) => void;
}

/**
 * Internal tracking for active task execution.
 */
interface ActiveTaskEntry {
  /** AbortController to abort execution */
  abortController: AbortController;

  /** Timestamp when execution started */
  startedAt: number;

  /** Associated commitment ID (if any) */
  commitmentId?: string;
}

/**
 * Statistics about rollback operations.
 */
export interface RollbackStats {
  /** Total number of rollbacks executed */
  totalRollbacks: number;

  /** Total number of tasks rolled back across all operations */
  totalTasksRolledBack: number;

  /** Total compute time wasted across all rollbacks (ms) */
  totalWastedComputeMs: number;

  /** Total stake that was at risk across all rollbacks */
  totalStakeLost: bigint;

  /** Number of rollbacks by reason */
  rollbacksByReason: Record<RollbackReason, number>;
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Maximum number of rollback history entries to retain. */
const DEFAULT_MAX_HISTORY_SIZE = 1000;

const DEFAULT_CONFIG: RollbackConfig = {
  allowRetry: false,
  maxRetries: 0,
  retryDelayMs: 1000,
  enableEvents: true,
};

// ============================================================================
// RollbackController Implementation
// ============================================================================

/**
 * Handles cascade rollback of speculative execution when proofs fail.
 *
 * Uses BFS traversal through the DependencyGraph to find all affected
 * downstream tasks, then aborts executing tasks, cancels pending proofs,
 * and marks commitments as failed.
 *
 * Rollbacks are idempotent - rolling back an already-rolled-back task
 * returns the cached result.
 *
 * @example
 * ```typescript
 * const controller = new RollbackController(
 *   { allowRetry: true, maxRetries: 3, retryDelayMs: 1000, enableEvents: true },
 *   dependencyGraph,
 *   commitmentLedger
 * );
 *
 * // Register active task
 * const abortController = new AbortController();
 * controller.registerActiveTask(taskPda, abortController);
 *
 * // Later, if proof fails
 * const result = await controller.rollback(taskPda, 'proof_failed');
 * console.log(`Rolled back ${result.rolledBackTasks.length} tasks`);
 * ```
 */
export class RollbackController {
  private readonly config: RollbackConfig;
  private readonly dependencyGraph: DependencyGraph;
  private readonly commitmentLedger: CommitmentLedger;
  private readonly events: RollbackEvents;

  /** Map from task PDA (base58) to active task entry */
  private activeTasks: Map<string, ActiveTaskEntry> = new Map();

  /** Set of task PDAs (base58) that have been rolled back */
  private rolledBackTasks: Set<string> = new Set();

  /** Map from root task PDA (base58) to rollback result */
  private rollbackResults: Map<string, RollbackResult> = new Map();

  /** Promises for rollback operations currently in progress by root task */
  private rollbackInFlight: Map<string, Promise<RollbackResult>> = new Map();

  /** History of rollback results (newest first) */
  private rollbackHistory: RollbackResult[] = [];

  /** Maximum history entries to keep */
  private readonly maxHistorySize: number = DEFAULT_MAX_HISTORY_SIZE;

  /** Cumulative statistics */
  private stats: RollbackStats = {
    totalRollbacks: 0,
    totalTasksRolledBack: 0,
    totalWastedComputeMs: 0,
    totalStakeLost: 0n,
    rollbacksByReason: {
      proof_failed: 0,
      proof_timeout: 0,
      ancestor_failed: 0,
      manual: 0,
    },
  };

  /**
   * Creates a new RollbackController instance.
   *
   * @param config - Configuration options (uses defaults for missing values)
   * @param dependencyGraph - The dependency graph for task relationships
   * @param commitmentLedger - The commitment ledger for tracking speculative results
   * @param events - Optional event callbacks for observability
   */
  constructor(
    config: Partial<RollbackConfig>,
    dependencyGraph: DependencyGraph,
    commitmentLedger: CommitmentLedger,
    events: RollbackEvents = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dependencyGraph = dependencyGraph;
    this.commitmentLedger = commitmentLedger;
    this.events = events;
  }

  /**
   * Registers an active task's AbortController for potential cancellation.
   *
   * Call this when a task begins executing speculatively so that the
   * RollbackController can abort it if needed.
   *
   * @param taskPda - Task account PDA
   * @param abortController - AbortController for the task's execution
   * @param commitmentId - Optional commitment ID associated with this task
   */
  registerActiveTask(
    taskPda: PublicKey,
    abortController: AbortController,
    commitmentId?: string
  ): void {
    const key = taskPda.toBase58();
    this.activeTasks.set(key, {
      abortController,
      startedAt: Date.now(),
      commitmentId,
    });
  }

  /**
   * Unregisters a completed task.
   *
   * Call this when a task completes execution (successfully or not).
   *
   * @param taskPda - Task account PDA
   */
  unregisterActiveTask(taskPda: PublicKey): void {
    this.activeTasks.delete(taskPda.toBase58());
  }

  /**
   * Checks if a task has been rolled back.
   *
   * @param taskPda - Task account PDA
   * @returns True if the task has been rolled back
   */
  isRolledBack(taskPda: PublicKey): boolean {
    return this.rolledBackTasks.has(taskPda.toBase58());
  }

  /**
   * Executes a cascade rollback from a failed task.
   *
   * Idempotent: rolling back an already-rolled-back task returns
   * the cached result from the original rollback.
   *
   * @param rootTaskPda - Task PDA that triggered the rollback
   * @param reason - Reason for the rollback
   * @returns RollbackResult with all affected tasks
   */
  async rollback(
    rootTaskPda: PublicKey,
    reason: RollbackReason
  ): Promise<RollbackResult> {
    const rootKey = rootTaskPda.toBase58();

    const inFlight = this.rollbackInFlight.get(rootKey);
    if (inFlight) {
      return inFlight;
    }

    // Idempotency check - return cached result if already rolled back
    const existingResult = this.rollbackResults.get(rootKey);
    if (existingResult) {
      return existingResult;
    }

    const executeRollback = async (): Promise<RollbackResult> => {
      // Get all affected tasks via BFS through dependency graph
      const affectedNodes = this.getAffectedTasks(rootTaskPda);

      // Emit start event
      if (this.config.enableEvents && this.events.onRollbackStarted) {
        this.events.onRollbackStarted(rootTaskPda, affectedNodes.length);
      }

      // Process each affected task, deepest-first to avoid partial state.
      const orderedNodes = [...affectedNodes].sort(
        (a, b) => b.depth - a.depth
      );
      const rolledBackTasks: RolledBackTask[] = [];

      for (const node of orderedNodes) {
        const rolledBack = await this.rollbackTask(node, reason);
        if (rolledBack) {
          rolledBackTasks.push(rolledBack);

          // Emit per-task event
          if (this.config.enableEvents && this.events.onTaskRolledBack) {
            this.events.onTaskRolledBack(rolledBack);
          }
        }
      }

      // Mark the root task as rolled back too
      this.rolledBackTasks.add(rootKey);

      // Mark root commitment as failed
      try {
        this.commitmentLedger.markFailed(rootTaskPda);
      } catch {
        // Commitment may not exist for root task
      }

      // Update root task status in graph
      this.dependencyGraph.updateStatus(rootTaskPda, 'failed');

      // Post-rollback validation and orphan cleanup
      const validation = this.validateRollbackChain(rootTaskPda);
      if (!validation.valid) {
        const cleanedUp = await this.cleanupOrphans(validation.orphans);
        rolledBackTasks.push(...cleanedUp);
      }

      // Calculate totals
      const wastedComputeMs = rolledBackTasks.reduce(
        (sum, t) => sum + t.computeTimeMs,
        0
      );
      const stakeAtRisk = rolledBackTasks.reduce(
        (sum, t) => sum + t.stakeAtRisk,
        0n
      );

      // Build result
      const result: RollbackResult = {
        rootTaskPda,
        reason,
        rolledBackTasks,
        wastedComputeMs,
        stakeAtRisk,
        timestamp: Date.now(),
      };

      // Cache result for idempotency
      this.rollbackResults.set(rootKey, result);

      // Add to history
      this.rollbackHistory.unshift(result);
      if (this.rollbackHistory.length > this.maxHistorySize) {
        this.rollbackHistory.pop();
      }

      // Update stats
      this.stats.totalRollbacks++;
      this.stats.totalTasksRolledBack += rolledBackTasks.length;
      this.stats.totalWastedComputeMs += wastedComputeMs;
      this.stats.totalStakeLost += stakeAtRisk;
      this.stats.rollbacksByReason[reason]++;

      // Emit completion event
      if (this.config.enableEvents && this.events.onRollbackCompleted) {
        this.events.onRollbackCompleted(result);
      }

      return result;
    };

    const rollbackPromise = executeRollback();
    this.rollbackInFlight.set(rootKey, rollbackPromise);

    try {
      return await rollbackPromise;
    } finally {
      this.rollbackInFlight.delete(rootKey);
    }
  }

  /**
   * Validates rollback chain integrity after rollback completion.
   *
   * @param rootTaskPda - Root task that initiated the rollback
   * @returns RollbackChainValidation with orphan/terminal details
   */
  validateRollbackChain(rootTaskPda: PublicKey): RollbackChainValidation {
    const descendants = this.dependencyGraph.getDescendants(rootTaskPda);

    const orphans: PublicKey[] = [];
    const alreadyTerminal: PublicKey[] = [];
    let maxChainDepth = 0;

    for (const desc of descendants) {
      const descKey = desc.taskPda.toBase58();
      maxChainDepth = Math.max(maxChainDepth, desc.depth);

      if (desc.status === 'completed' || desc.status === 'failed') {
        alreadyTerminal.push(desc.taskPda);
        continue;
      }

      if (!this.rolledBackTasks.has(descKey)) {
        orphans.push(desc.taskPda);
      }
    }

    return {
      valid: orphans.length === 0,
      orphans,
      alreadyTerminal,
      maxChainDepth,
    };
  }

  /**
   * Attempts best-effort orphan cleanup after rollback by explicitly processing
   * any descendants that remained active in the dependency graph.
   *
   * @param orphans - Orphaned tasks to clean up
   * @returns Rollback results for tasks cleaned up via this path
   */
  async cleanupOrphans(orphans: PublicKey[]): Promise<RolledBackTask[]> {
    const results: RolledBackTask[] = [];

    for (const orphanPda of orphans) {
      const node = this.dependencyGraph.getNode(orphanPda);
      if (!node) {
        continue;
      }

      const rolledBack = await this.rollbackTask(node, 'ancestor_failed');
      if (rolledBack) {
        results.push(rolledBack);
      }
    }

    return results;
  }

  /**
   * Gets the rollback history.
   *
   * @param limit - Maximum number of entries to return (default: 100)
   * @returns Array of RollbackResults, newest first
   */
  getRollbackHistory(limit: number = 100): RollbackResult[] {
    return this.rollbackHistory.slice(0, limit);
  }

  /**
   * Gets cumulative statistics about rollback operations.
   *
   * @returns RollbackStats object
   */
  getStats(): RollbackStats {
    return { ...this.stats };
  }

  /**
   * Clears all state (for testing).
   */
  clear(): void {
    this.activeTasks.clear();
    this.rolledBackTasks.clear();
    this.rollbackResults.clear();
    this.rollbackInFlight.clear();
    this.rollbackHistory = [];
    this.stats = {
      totalRollbacks: 0,
      totalTasksRolledBack: 0,
      totalWastedComputeMs: 0,
      totalStakeLost: 0n,
      rollbacksByReason: {
        proof_failed: 0,
        proof_timeout: 0,
        ancestor_failed: 0,
        manual: 0,
      },
    };
  }

  /**
   * Gets all tasks affected by a failure, using BFS traversal.
   *
   * @param rootTaskPda - The task that failed
   * @returns Array of affected TaskNodes (excluding the root)
   */
  private getAffectedTasks(rootTaskPda: PublicKey): TaskNode[] {
    // Use DependencyGraph's getDescendants which does BFS
    return this.dependencyGraph.getDescendants(rootTaskPda);
  }

  /**
   * Rolls back a single task.
   *
   * @param node - The task node to roll back
   * @param reason - Reason for the rollback
   * @returns RolledBackTask info or null if task already rolled back
   */
  private async rollbackTask(
    node: TaskNode,
    _reason: RollbackReason
  ): Promise<RolledBackTask | null> {
    const key = node.taskPda.toBase58();

    // Skip if already rolled back
    if (this.rolledBackTasks.has(key)) {
      return null;
    }

    // Mark as rolled back
    this.rolledBackTasks.add(key);

    // Get commitment info
    const commitment = this.commitmentLedger.getByTask(node.taskPda);

    // Determine state and action
    let state: RolledBackTaskState;
    let action: RolledBackTaskAction;
    let computeTimeMs = 0;
    let stakeAtRisk = 0n;

    // Check if task is actively executing
    const activeEntry = this.activeTasks.get(key);

    if (activeEntry) {
      // Task is actively executing - abort it
      state = 'executing';
      action = 'aborted';
      computeTimeMs = Date.now() - activeEntry.startedAt;
      activeEntry.abortController.abort();
      this.activeTasks.delete(key);
    } else if (commitment) {
      // Task has a commitment - determine state from commitment status
      switch (commitment.status) {
        case 'pending':
        case 'executing':
          state = 'executing';
          action = 'aborted';
          break;
        case 'executed':
          state = 'executed';
          action = 'discarded';
          break;
        case 'proof_generating':
          state = 'proof_generating';
          action = 'cancelled';
          break;
        case 'proof_generated':
          state = 'proof_generated';
          action = 'cancelled';
          break;
        default:
          state = 'executed';
          action = 'discarded';
      }

      // Get stake from commitment
      stakeAtRisk = commitment.stakeAtRisk;

      // Calculate compute time from commitment creation
      computeTimeMs = Date.now() - commitment.createdAt;
    } else {
      // No commitment - task was pending but not started
      state = 'executing';
      action = 'discarded';
    }

    // Update commitment status to rolled_back
    if (commitment) {
      try {
        // Mark the commitment as rolled back by marking its source as failed
        // This will cascade to dependents via markFailed
        this.commitmentLedger.updateStatus(node.taskPda, 'rolled_back');
      } catch {
        // May already be in a terminal state
      }
    }

    // Update task status in dependency graph
    this.dependencyGraph.updateStatus(node.taskPda, 'failed');

    return {
      taskPda: node.taskPda,
      taskId: node.taskId,
      state,
      action,
      computeTimeMs,
      stakeAtRisk,
    };
  }
}
