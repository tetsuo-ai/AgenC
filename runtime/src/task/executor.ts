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
  RetryPolicy,
  BackpressureConfig,
  DeadLetterEntry,
  DeadLetterStage,
} from './types.js';
import { isPrivateExecutionResult } from './types.js';
import { DeadLetterQueue } from './dlq.js';
import { deriveTaskPda } from './pda.js';
import { TaskTimeoutError, ClaimExpiredError, RetryExhaustedError } from '../types/errors.js';

// ============================================================================
// Retry Defaults
// ============================================================================

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: true,
};

const DEFAULT_BACKPRESSURE_CONFIG: BackpressureConfig = {
  highWaterMark: 100,
  lowWaterMark: 25,
  pauseDiscovery: true,
};

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
  private readonly taskTimeoutMs: number;
  private readonly claimExpiryBufferMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly backpressureConfig: BackpressureConfig;
  private readonly dlq: DeadLetterQueue;

  // Runtime state
  private running = false;
  private startedAt: number | null = null;
  private activeTasks: Map<string, AbortController> = new Map();
  private taskQueue: TaskDiscoveryResult[] = [];
  private events: TaskExecutorEvents = {};
  private discoveryUnsubscribe: (() => void) | null = null;
  private backpressureActive = false;

  // Metrics
  private metrics = {
    tasksDiscovered: 0,
    tasksClaimed: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    claimsFailed: 0,
    submitsFailed: 0,
    claimsExpired: 0,
    claimRetries: 0,
    submitRetries: 0,
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
    this.taskTimeoutMs = config.taskTimeoutMs ?? 300_000;
    this.claimExpiryBufferMs = config.claimExpiryBufferMs ?? 30_000;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retryPolicy };
    this.backpressureConfig = { ...DEFAULT_BACKPRESSURE_CONFIG, ...config.backpressure };
    this.dlq = new DeadLetterQueue(config.deadLetterQueue);
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

    // Clear queue and backpressure state
    this.taskQueue = [];
    this.backpressureActive = false;
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
      claimRetries: this.metrics.claimRetries,
      submitRetries: this.metrics.submitRetries,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      queueSize: this.taskQueue.length,
      backpressureActive: this.backpressureActive,
    };
  }

  /**
   * Get the current number of tasks waiting in the queue.
   */
  getQueueSize(): number {
    return this.taskQueue.length;
  }

  /**
   * Get the dead letter queue instance for inspection, retry, and management.
   */
  getDeadLetterQueue(): DeadLetterQueue {
    return this.dlq;
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
      this.checkHighWaterMark();
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
    this.checkLowWaterMark();
  }

  // ==========================================================================
  // Backpressure
  // ==========================================================================

  /**
   * If queue has reached the high-water mark, pause discovery.
   */
  private checkHighWaterMark(): void {
    if (
      !this.backpressureActive &&
      this.backpressureConfig.pauseDiscovery &&
      this.taskQueue.length >= this.backpressureConfig.highWaterMark
    ) {
      this.backpressureActive = true;
      this.discovery?.pause();
      this.events.onBackpressureActivated?.();
      this.logger.info(
        `Backpressure activated: queue size ${this.taskQueue.length} >= high-water mark ${this.backpressureConfig.highWaterMark}`,
      );
    }
  }

  /**
   * If queue has drained to the low-water mark, resume discovery.
   */
  private checkLowWaterMark(): void {
    if (
      this.backpressureActive &&
      this.taskQueue.length <= this.backpressureConfig.lowWaterMark
    ) {
      this.backpressureActive = false;
      this.discovery?.resume();
      this.events.onBackpressureReleased?.();
      this.logger.info(
        `Backpressure released: queue size ${this.taskQueue.length} <= low-water mark ${this.backpressureConfig.lowWaterMark}`,
      );
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
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimerId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let claimExpired = false;

    try {
      // Step 1: Claim (with retry)
      const claimResult = await this.retryStage(
        'claim',
        () => this.claimTaskStep(task),
        controller.signal,
      );

      // Step 2: Check claim deadline and set up deadline timer
      if (this.claimExpiryBufferMs > 0) {
        const claim = await this.operations.fetchClaim(task.pda);
        if (claim && claim.expiresAt > 0) {
          const nowMs = Date.now();
          const expiresAtMs = claim.expiresAt * 1000;
          const remainingMs = expiresAtMs - nowMs;
          const effectiveMs = remainingMs - this.claimExpiryBufferMs;

          if (effectiveMs <= 0) {
            // Not enough time remaining — abort immediately
            claimExpired = true;
            controller.abort();
            const expiredError = new ClaimExpiredError(claim.expiresAt, this.claimExpiryBufferMs);
            this.metrics.tasksFailed++;
            this.metrics.claimsExpired++;
            this.events.onClaimExpiring?.(expiredError, task.pda);
            this.events.onTaskFailed?.(expiredError, task.pda);
            this.sendToDeadLetterQueue(task, expiredError, 'claim', 1);
            this.logger.warn(`Task ${pda} claim deadline too close: remaining=${remainingMs}ms, buffer=${this.claimExpiryBufferMs}ms`);
            return;
          }

          // Set timer to abort before deadline
          deadlineTimerId = setTimeout(() => {
            claimExpired = true;
            controller.abort();
          }, effectiveMs);
        }
      }

      // Step 3: Set up per-task execution timeout
      if (this.taskTimeoutMs > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.taskTimeoutMs);
      }

      // Step 4: Execute handler
      const result = await this.executeTaskStep(task, claimResult, controller.signal);

      // Clear timers on success
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (deadlineTimerId !== null) {
        clearTimeout(deadlineTimerId);
        deadlineTimerId = null;
      }

      // Step 5: Submit result on-chain (with retry)
      await this.retryStage(
        'submit',
        () => this.submitTaskStep(task, result),
        controller.signal,
      );
    } catch (err) {
      // Clear timers if still pending
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (deadlineTimerId !== null) {
        clearTimeout(deadlineTimerId);
        deadlineTimerId = null;
      }

      if (claimExpired) {
        // Claim deadline expired during execution
        const claim = await this.operations.fetchClaim(task.pda).catch(() => null);
        const expiresAt = claim?.expiresAt ?? 0;
        const expiredError = new ClaimExpiredError(expiresAt, this.claimExpiryBufferMs);
        this.metrics.tasksFailed++;
        this.metrics.claimsExpired++;
        this.events.onClaimExpiring?.(expiredError, task.pda);
        this.events.onTaskFailed?.(expiredError, task.pda);
        this.sendToDeadLetterQueue(task, expiredError, 'execute', 1);
        this.logger.warn(`Task ${pda} aborted: claim deadline expiring`);
      } else if (timedOut) {
        // Timeout-specific handling: emit onTaskTimeout, increment tasksFailed
        const timeoutError = new TaskTimeoutError(this.taskTimeoutMs);
        this.metrics.tasksFailed++;
        this.events.onTaskTimeout?.(timeoutError, task.pda);
        this.events.onTaskFailed?.(timeoutError, task.pda);
        this.sendToDeadLetterQueue(task, timeoutError, 'execute', 1);
        this.logger.warn(`Task ${pda} timed out after ${this.taskTimeoutMs}ms`);
      } else if (controller.signal.aborted) {
        // Graceful shutdown — do not send to DLQ
        this.logger.debug(`Task ${pda} aborted`);
      } else {
        // Non-abort failure (handler crash, retry exhaustion, etc.)
        const error = err instanceof Error ? err : new Error(String(err));
        const stage = this.inferFailureStage(error);
        const attempts = error instanceof RetryExhaustedError ? error.attempts : 1;
        this.sendToDeadLetterQueue(task, error, stage, attempts);
      }
    } finally {
      this.activeTasks.delete(pda);
      this.drainQueue();
    }
  }

  /**
   * Execute an operation with retry according to the configured retry policy.
   * Respects the abort signal during backoff waits.
   */
  private async retryStage<T>(
    stage: 'claim' | 'submit',
    fn: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const policy = this.retryPolicy;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // If this was the last attempt, don't wait — fall through to throw
        if (attempt + 1 >= policy.maxAttempts) {
          break;
        }

        // If aborted, don't retry
        if (signal.aborted) {
          throw lastError;
        }

        const metricsKey = stage === 'claim' ? 'claimRetries' : 'submitRetries';
        this.metrics[metricsKey]++;

        const delay = computeBackoffDelay(attempt, policy);
        this.logger.warn(
          `Retry ${stage} attempt ${attempt + 1}/${policy.maxAttempts - 1} after ${delay}ms: ${lastError.message}`,
        );

        const completed = await sleepWithAbort(delay, signal);
        if (!completed) {
          // Aborted during wait
          throw lastError;
        }
      }
    }

    // All attempts exhausted
    throw new RetryExhaustedError(stage, policy.maxAttempts, lastError!);
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
      // If the signal was aborted (stop or timeout), let processTask handle metrics
      if (signal.aborted) {
        throw err;
      }
      this.metrics.tasksFailed++;
      this.events.onTaskFailed?.(err instanceof Error ? err : new Error(String(err)), task.pda);
      throw err;
    }
  }

  // ==========================================================================
  // Dead Letter Queue
  // ==========================================================================

  /**
   * Send a failed task to the dead letter queue and emit the onDeadLettered event.
   */
  private sendToDeadLetterQueue(
    task: TaskDiscoveryResult,
    error: Error,
    stage: DeadLetterStage,
    attempts: number,
  ): void {
    const entry: DeadLetterEntry = {
      taskPda: task.pda.toBase58(),
      task: task.task,
      error: error.message,
      errorCode: 'code' in error && typeof (error as Record<string, unknown>).code === 'string'
        ? (error as Record<string, unknown>).code as string
        : undefined,
      failedAt: Date.now(),
      stage,
      attempts,
      retryable: stage !== 'execute',
    };
    this.dlq.add(entry);
    this.events.onDeadLettered?.(entry);
    this.logger.debug(`Task ${entry.taskPda} sent to dead letter queue (stage=${stage}, attempts=${attempts})`);
  }

  /**
   * Infer the pipeline stage from the error type.
   */
  private inferFailureStage(error: Error): DeadLetterStage {
    if (error instanceof RetryExhaustedError) {
      return error.stage as DeadLetterStage;
    }
    if (error instanceof TaskTimeoutError) {
      return 'execute';
    }
    if (error instanceof ClaimExpiredError) {
      return 'execute';
    }
    // Handler failures and unknown errors default to 'execute'
    return 'execute';
  }

  // ==========================================================================
  // Pipeline Steps
  // ==========================================================================

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

/**
 * Compute the backoff delay for a given retry attempt.
 * Uses exponential backoff with optional full jitter (AWS style).
 *
 * @param attempt - Zero-based attempt index (0 = first retry)
 * @param policy - Retry policy configuration
 * @returns Delay in milliseconds
 */
function computeBackoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponentialDelay = Math.min(
    policy.baseDelayMs * Math.pow(2, attempt),
    policy.maxDelayMs,
  );
  if (policy.jitter) {
    return Math.floor(Math.random() * exponentialDelay);
  }
  return exponentialDelay;
}

/**
 * Sleep that can be interrupted by an AbortSignal.
 * Resolves to `true` if sleep completed normally, `false` if aborted.
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
