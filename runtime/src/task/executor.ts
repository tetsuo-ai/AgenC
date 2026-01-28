/**
 * TaskExecutor — main orchestration class for the Discovery → Claim → Execute → Submit pipeline.
 *
 * Supports two operating modes:
 * - **autonomous**: Continuously discover tasks via TaskDiscovery, claim, execute, and submit results.
 * - **batch**: Process a pre-selected list of tasks, then resolve.
 *
 * Features:
 * - Concurrency control with configurable maxConcurrentTasks and task queue
 * - Separate execution paths for private (ZK) vs public tasks
 * - AbortController per active task for graceful cancellation
 * - 7 event callbacks emitted at correct pipeline stages
 * - 6-counter metrics tracking
 *
 * @module
 */

import type { PublicKey } from '@solana/web3.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type { TaskOperations } from './operations.js';
import type { TaskDiscovery, TaskDiscoveryResult } from './discovery.js';
import type {
  TaskExecutionContext,
  TaskExecutionResult,
  PrivateTaskExecutionResult,
  TaskHandler,
  ClaimResult,
  CompleteResult,
  TaskExecutorConfig,
  TaskExecutorStatus,
  TaskExecutorEvents,
  OperatingMode,
  BatchTaskItem,
} from './types.js';
import { isPrivateExecutionResult } from './types.js';
import { deriveTaskPda } from './pda.js';

// ============================================================================
// TaskExecutor Class
// ============================================================================

/**
 * Main orchestration class that ties together the complete task execution pipeline:
 * Discovery → Claim → Execute → Submit.
 *
 * @example
 * ```typescript
 * const executor = new TaskExecutor({
 *   operations,
 *   handler: async (ctx) => {
 *     // ... process task ...
 *     return { proofHash: new Uint8Array(32).fill(1) };
 *   },
 *   discovery,
 *   agentId: myAgentId,
 *   agentPda: myAgentPda,
 *   mode: 'autonomous',
 *   maxConcurrentTasks: 3,
 * });
 *
 * executor.on({
 *   onTaskCompleted: (result) => console.log('Completed:', result.taskId),
 *   onTaskFailed: (err) => console.error('Failed:', err),
 * });
 *
 * await executor.start();
 * ```
 */
export class TaskExecutor {
  private readonly operations: TaskOperations;
  private readonly handler: TaskHandler;
  private readonly mode: OperatingMode;
  private readonly maxConcurrentTasks: number;
  private readonly logger: Logger;
  private readonly discovery: TaskDiscovery | null;
  private readonly agentId: Uint8Array;
  private readonly agentPda: PublicKey;
  private readonly batchTasks: BatchTaskItem[];

  // Runtime state
  private running = false;
  private startedAt: number | null = null;
  private activeTasks: Map<string, AbortController> = new Map();
  private taskQueue: TaskDiscoveryResult[] = [];
  private events: TaskExecutorEvents = {};
  private discoveryUnsubscribe: (() => void) | null = null;

  // Metrics
  private metrics = {
    tasksDiscovered: 0,
    tasksClaimed: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    claimsFailed: 0,
    submitsFailed: 0,
  };

  constructor(config: TaskExecutorConfig) {
    this.operations = config.operations;
    this.handler = config.handler;
    this.mode = config.mode ?? 'autonomous';
    this.maxConcurrentTasks = config.maxConcurrentTasks ?? 1;
    this.logger = config.logger ?? silentLogger;
    this.discovery = config.discovery ?? null;
    this.agentId = new Uint8Array(config.agentId);
    this.agentPda = config.agentPda;
    this.batchTasks = config.batchTasks ?? [];
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start the executor.
   *
   * In autonomous mode, sets up discovery and enters the processing loop.
   * In batch mode, processes all batch tasks and resolves when complete.
   *
   * @throws Error if already running
   * @throws Error if autonomous mode lacks a discovery instance
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('TaskExecutor is already running');
    }

    this.running = true;
    this.startedAt = Date.now();
    this.logger.info(`TaskExecutor starting in ${this.mode} mode`);

    if (this.mode === 'autonomous') {
      await this.autonomousLoop();
    } else {
      await this.batchLoop();
    }
  }

  /**
   * Stop the executor gracefully.
   *
   * Stops discovery, aborts all in-progress task handlers, waits for active tasks,
   * and clears the queue. Does NOT cancel on-chain claims (they expire naturally).
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.logger.info('TaskExecutor stopping');

    // Stop discovery listener first (synchronous)
    if (this.discoveryUnsubscribe) {
      this.discoveryUnsubscribe();
      this.discoveryUnsubscribe = null;
    }

    // Abort all in-progress handlers immediately
    for (const controller of this.activeTasks.values()) {
      controller.abort();
    }

    // Stop discovery (async)
    if (this.discovery) {
      await this.discovery.stop();
    }

    // Wait for active tasks to finish/abort
    if (this.activeTasks.size > 0) {
      await new Promise<void>((resolve) => {
        const checkDone = () => {
          if (this.activeTasks.size === 0) {
            resolve();
          } else {
            setTimeout(checkDone, 50);
          }
        };
        // Timeout safety: resolve after 5 seconds regardless
        setTimeout(resolve, 5000);
        checkDone();
      });
    }

    // Clear queue
    this.taskQueue = [];
    this.startedAt = null;

    this.logger.info('TaskExecutor stopped');
  }

  /**
   * Check if the executor is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ==========================================================================
  // Status & Metrics
  // ==========================================================================

  /**
   * Get a snapshot of the executor's current status and metrics.
   */
  getStatus(): TaskExecutorStatus {
    return {
      running: this.running,
      mode: this.mode,
      tasksDiscovered: this.metrics.tasksDiscovered,
      tasksClaimed: this.metrics.tasksClaimed,
      tasksInProgress: this.activeTasks.size,
      tasksCompleted: this.metrics.tasksCompleted,
      tasksFailed: this.metrics.tasksFailed,
      claimsFailed: this.metrics.claimsFailed,
      submitsFailed: this.metrics.submitsFailed,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  // ==========================================================================
  // Event Registration
  // ==========================================================================

  /**
   * Register event callbacks for pipeline stage notifications.
   * Replaces any previously registered callbacks.
   */
  on(events: TaskExecutorEvents): void {
    this.events = { ...this.events, ...events };
  }

  // ==========================================================================
  // Autonomous Mode
  // ==========================================================================

  private async autonomousLoop(): Promise<void> {
    if (!this.discovery) {
      throw new Error('TaskDiscovery is required for autonomous mode');
    }

    // Register discovery callback
    this.discoveryUnsubscribe = this.discovery.onTaskDiscovered((task: TaskDiscoveryResult) => {
      this.metrics.tasksDiscovered++;
      this.events.onTaskDiscovered?.(task);
      this.handleDiscoveredTask(task);
    });

    // Start discovery (pass agent capabilities of 0n; the filter config handles matching)
    await this.discovery.start(0n);

    // Keep running until stopped — discovery callbacks drive task processing
    while (this.running) {
      this.drainQueue();
      await sleep(100);
    }
  }

  // ==========================================================================
  // Batch Mode
  // ==========================================================================

  private async batchLoop(): Promise<void> {
    const results: TaskDiscoveryResult[] = [];

    for (const item of this.batchTasks) {
      if (!this.running) break;

      try {
        const resolved = await this.resolveBatchItem(item);
        if (resolved) {
          results.push(resolved);
        }
      } catch (err) {
        this.logger.warn(`Failed to resolve batch task: ${err}`);
      }
    }

    // Process all resolved batch tasks
    for (const task of results) {
      if (!this.running) break;

      this.metrics.tasksDiscovered++;
      this.events.onTaskDiscovered?.(task);

      if (this.activeTasks.size < this.maxConcurrentTasks) {
        this.launchTask(task);
      } else {
        this.taskQueue.push(task);
      }
    }

    // Drain remaining queued tasks
    this.drainQueue();

    // Wait for all active tasks to complete
    while (this.activeTasks.size > 0 || this.taskQueue.length > 0) {
      await sleep(50);
    }
  }

  private async resolveBatchItem(item: BatchTaskItem): Promise<TaskDiscoveryResult | null> {
    let taskPda: PublicKey | undefined = item.taskPda;

    // Derive PDA from creator + taskId if not directly provided
    if (!taskPda && item.creator && item.taskId) {
      const { address } = deriveTaskPda(item.creator, item.taskId);
      taskPda = address;
    }

    if (!taskPda) {
      this.logger.warn('Batch item missing taskPda or creator+taskId');
      return null;
    }

    const task = await this.operations.fetchTask(taskPda);
    if (!task) {
      this.logger.warn(`Batch task not found: ${taskPda.toBase58()}`);
      return null;
    }

    return {
      pda: taskPda,
      task,
      discoveredAt: Date.now(),
      source: 'poll',
    };
  }

  // ==========================================================================
  // Concurrency Management
  // ==========================================================================

  private handleDiscoveredTask(task: TaskDiscoveryResult): void {
    if (this.activeTasks.size < this.maxConcurrentTasks && this.taskQueue.length === 0) {
      this.launchTask(task);
    } else {
      this.taskQueue.push(task);
    }
  }

  private drainQueue(): void {
    while (
      this.running &&
      this.activeTasks.size < this.maxConcurrentTasks &&
      this.taskQueue.length > 0
    ) {
      const task = this.taskQueue.shift()!;
      this.launchTask(task);
    }
  }

  /**
   * Register a task in activeTasks synchronously, then fire processTask asynchronously.
   * This ensures the concurrency counter is accurate before the next handleDiscoveredTask call.
   */
  private launchTask(task: TaskDiscoveryResult): void {
    const pda = task.pda.toBase58();
    const controller = new AbortController();
    this.activeTasks.set(pda, controller);
    void this.processTask(task, pda, controller);
  }

  // ==========================================================================
  // Pipeline: Claim → Execute → Submit
  // ==========================================================================

  private async processTask(
    task: TaskDiscoveryResult,
    pda: string,
    controller: AbortController,
  ): Promise<void> {

    try {
      // Step 1: Claim
      const claimResult = await this.claimTaskStep(task);

      // Step 2: Execute handler
      const result = await this.executeTaskStep(task, claimResult, controller.signal);

      // Step 3: Submit result on-chain
      await this.submitTaskStep(task, result);
    } catch (err) {
      // Check if aborted (graceful shutdown)
      if (controller.signal.aborted) {
        this.logger.debug(`Task ${pda} aborted`);
      }
      // Error already handled in individual steps; just ensure metrics are right
    } finally {
      this.activeTasks.delete(pda);
      this.drainQueue();
    }
  }

  private async claimTaskStep(task: TaskDiscoveryResult): Promise<ClaimResult> {
    try {
      const result = await this.operations.claimTask(task.pda, task.task);
      this.metrics.tasksClaimed++;
      this.events.onTaskClaimed?.(result);
      return result;
    } catch (err) {
      this.metrics.claimsFailed++;
      this.events.onClaimFailed?.(err instanceof Error ? err : new Error(String(err)), task.pda);
      throw err;
    }
  }

  private async executeTaskStep(
    task: TaskDiscoveryResult,
    claimResult: ClaimResult,
    signal: AbortSignal,
  ): Promise<TaskExecutionResult | PrivateTaskExecutionResult> {
    const context: TaskExecutionContext = {
      task: task.task,
      taskPda: task.pda,
      claimPda: claimResult.claimPda,
      agentId: new Uint8Array(this.agentId),
      agentPda: this.agentPda,
      logger: this.logger,
      signal,
    };

    this.events.onTaskExecutionStarted?.(context);

    try {
      return await this.handler(context);
    } catch (err) {
      this.metrics.tasksFailed++;
      this.events.onTaskFailed?.(err instanceof Error ? err : new Error(String(err)), task.pda);
      throw err;
    }
  }

  private async submitTaskStep(
    task: TaskDiscoveryResult,
    result: TaskExecutionResult | PrivateTaskExecutionResult,
  ): Promise<CompleteResult> {
    try {
      let completeResult: CompleteResult;

      if (isPrivateExecutionResult(result)) {
        completeResult = await this.operations.completeTaskPrivate(
          task.pda,
          task.task,
          result.proof,
          result.constraintHash,
          result.outputCommitment,
          result.expectedBinding,
        );
      } else {
        completeResult = await this.operations.completeTask(
          task.pda,
          task.task,
          result.proofHash,
          result.resultData ?? null,
        );
      }

      this.metrics.tasksCompleted++;
      this.events.onTaskCompleted?.(completeResult);
      return completeResult;
    } catch (err) {
      this.metrics.submitsFailed++;
      this.events.onSubmitFailed?.(err instanceof Error ? err : new Error(String(err)), task.pda);
      throw err;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
