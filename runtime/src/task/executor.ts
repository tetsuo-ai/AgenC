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

import type { PublicKey } from "@solana/web3.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { sleep } from "../utils/async.js";
import type { TaskOperations } from "./operations.js";
import type { TaskDiscovery, TaskDiscoveryResult } from "./discovery.js";
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
  CheckpointStore,
  TaskCheckpoint,
  MetricsProvider,
  TracingProvider,
  TaskScorer,
  DiscoveredTask,
} from "./types.js";
import { isPrivateExecutionResult } from "./types.js";
import { DeadLetterQueue } from "./dlq.js";
import { NoopMetrics, NoopTracing, METRIC_NAMES } from "./metrics.js";
import type { MetricsSnapshot } from "./metrics.js";
import { deriveTaskPda } from "./pda.js";
import { PriorityQueue } from "./priority-queue.js";
import { defaultTaskScorer } from "./filters.js";
import {
  TaskTimeoutError,
  ClaimExpiredError,
  RetryExhaustedError,
} from "../types/errors.js";

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

interface PipelineRuntimeState {
  timeoutId: ReturnType<typeof setTimeout> | null;
  deadlineTimerId: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
  claimExpired: boolean;
}

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
  private readonly checkpointStore: CheckpointStore | null;
  private readonly metricsProvider: MetricsProvider;
  private readonly tracingProvider: TracingProvider;
  private readonly scorer: TaskScorer;
  private readonly rescoreIntervalMs: number;

  // Runtime state
  private running = false;
  private startedAt: number | null = null;
  private activeTasks: Map<string, AbortController> = new Map();
  private taskQueue: PriorityQueue<TaskDiscoveryResult>;
  private events: TaskExecutorEvents = {};
  private discoveryUnsubscribe: (() => void) | null = null;
  private backpressureActive = false;
  private rescoreTimerId: ReturnType<typeof setInterval> | null = null;

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
    this.mode = config.mode ?? "autonomous";
    this.maxConcurrentTasks = config.maxConcurrentTasks ?? 1;
    this.logger = config.logger ?? silentLogger;
    this.discovery = config.discovery ?? null;
    this.agentId = new Uint8Array(config.agentId);
    this.agentPda = config.agentPda;
    this.batchTasks = config.batchTasks ?? [];
    this.taskTimeoutMs = config.taskTimeoutMs ?? 300_000;
    this.claimExpiryBufferMs = config.claimExpiryBufferMs ?? 30_000;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retryPolicy };
    this.backpressureConfig = {
      ...DEFAULT_BACKPRESSURE_CONFIG,
      ...config.backpressure,
    };
    this.dlq = new DeadLetterQueue(config.deadLetterQueue);
    this.checkpointStore = config.checkpointStore ?? null;
    this.metricsProvider = config.metrics ?? new NoopMetrics();
    this.tracingProvider = config.tracing ?? new NoopTracing();
    this.scorer = config.scorer ?? defaultTaskScorer;
    this.rescoreIntervalMs = config.rescoreIntervalMs ?? 0;
    this.taskQueue = new PriorityQueue<TaskDiscoveryResult>(
      config.priorityQueueCapacity ?? Infinity,
    );
  }

  /**
   * Score a TaskDiscoveryResult using the configured scorer.
   * Adapts the TaskDiscoveryResult to the DiscoveredTask interface expected by TaskScorer.
   */
  private scoreTask(task: TaskDiscoveryResult): number {
    const discovered: DiscoveredTask = {
      task: task.task,
      relevanceScore: 0,
      canClaim: true,
    };
    return this.scorer(discovered);
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
      throw new Error("TaskExecutor is already running");
    }

    this.running = true;
    this.startedAt = Date.now();
    this.logger.info(`TaskExecutor starting in ${this.mode} mode`);

    // Recover pending checkpoints from a previous run
    await this.recoverCheckpoints();

    if (this.mode === "autonomous") {
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
    this.logger.info("TaskExecutor stopping");

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
    await this.waitForActiveTasks();

    // Stop rescore timer
    if (this.rescoreTimerId !== null) {
      clearInterval(this.rescoreTimerId);
      this.rescoreTimerId = null;
    }

    // Clear queue and backpressure state
    this.taskQueue.clear();
    this.backpressureActive = false;
    this.startedAt = null;

    this.logger.info("TaskExecutor stopped");
  }

  /**
   * Wait for all active tasks to finish or abort, with a timeout safety net.
   */
  private async waitForActiveTasks(timeoutMs = 5000): Promise<void> {
    if (this.activeTasks.size === 0) return;
    await new Promise<void>((resolve) => {
      const checkDone = () => {
        if (this.activeTasks.size === 0) {
          resolve();
        } else {
          setTimeout(checkDone, 50);
        }
      };
      // Timeout safety: resolve after timeoutMs regardless
      setTimeout(resolve, timeoutMs);
      checkDone();
    });
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
      queueSize: this.taskQueue.size,
      backpressureActive: this.backpressureActive,
      topScores: this.taskQueue.getTopN(10).map((e) => e.score),
    };
  }

  /**
   * Get the current number of tasks waiting in the queue.
   */
  getQueueSize(): number {
    return this.taskQueue.size;
  }

  /**
   * Get the dead letter queue instance for inspection, retry, and management.
   */
  getDeadLetterQueue(): DeadLetterQueue {
    return this.dlq;
  }

  /**
   * Get an OpenTelemetry-compatible metrics snapshot.
   * Returns `null` if the configured metrics provider does not support snapshots
   * (i.e., it is not a {@link MetricsCollector}).
   */
  getMetricsSnapshot(): MetricsSnapshot | null {
    if (
      "getSnapshot" in this.metricsProvider &&
      typeof (this.metricsProvider as Record<string, unknown>).getSnapshot ===
        "function"
    ) {
      return (
        this.metricsProvider as { getSnapshot(): MetricsSnapshot }
      ).getSnapshot();
    }
    return null;
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
  // Checkpoint Recovery
  // ==========================================================================

  /**
   * On startup, load any incomplete checkpoints from the store and resume
   * each task from its last persisted stage. Stale checkpoints (expired claims)
   * are cleaned up instead of resumed.
   */
  private async recoverCheckpoints(): Promise<void> {
    if (!this.checkpointStore) return;

    const pending = await this.checkpointStore.listPending();
    if (pending.length === 0) return;

    this.logger.info(`Recovering ${pending.length} checkpointed task(s)`);

    for (const checkpoint of pending) {
      if (!this.running) break;

      try {
        // Verify claim is still valid on-chain before resuming
        const claim = await this.operations.fetchClaim({
          toBase58: () => checkpoint.taskPda,
        } as unknown as PublicKey);

        if (claim && claim.expiresAt > 0) {
          const nowSec = Math.floor(Date.now() / 1000);
          if (nowSec >= claim.expiresAt) {
            // Claim has expired — clean up and skip
            this.logger.warn(
              `Checkpoint for ${checkpoint.taskPda} is stale (claim expired), removing`,
            );
            await this.checkpointStore.remove(checkpoint.taskPda);
            continue;
          }
        }

        // Re-fetch task to get current on-chain state
        const task = await this.operations.fetchTask({
          toBase58: () => checkpoint.taskPda,
        } as unknown as PublicKey);

        if (!task) {
          this.logger.warn(
            `Checkpoint task ${checkpoint.taskPda} not found on-chain, removing`,
          );
          await this.checkpointStore.remove(checkpoint.taskPda);
          continue;
        }

        const pda = {
          toBase58: () => checkpoint.taskPda,
        } as unknown as PublicKey;
        const discoveryResult: TaskDiscoveryResult = {
          pda,
          task,
          discoveredAt: checkpoint.createdAt,
          source: "poll",
        };

        this.logger.info(
          `Resuming task ${checkpoint.taskPda} from stage '${checkpoint.stage}'`,
        );
        this.launchRecoveredTask(discoveryResult, checkpoint);
      } catch (err) {
        this.logger.warn(
          `Failed to recover checkpoint ${checkpoint.taskPda}: ${err}`,
        );
        await this.checkpointStore.remove(checkpoint.taskPda);
      }
    }
  }

  /**
   * Launch a recovered task that resumes from its checkpointed stage.
   */
  private launchRecoveredTask(
    task: TaskDiscoveryResult,
    checkpoint: TaskCheckpoint,
  ): void {
    const pda = task.pda.toBase58();
    const controller = new AbortController();
    this.activeTasks.set(pda, controller);
    void this.processRecoveredTask(task, pda, controller, checkpoint);
  }

  /**
   * Process a recovered task, skipping stages that were already completed
   * according to the checkpoint.
   */
  private async processRecoveredTask(
    task: TaskDiscoveryResult,
    pda: string,
    controller: AbortController,
    checkpoint: TaskCheckpoint,
  ): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimerId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let claimExpired = false;

    try {
      let claimResult: ClaimResult;
      let executionResult: TaskExecutionResult | PrivateTaskExecutionResult;

      if (checkpoint.stage === "claimed" && checkpoint.claimResult) {
        // Already claimed — skip claim, run execute + submit
        claimResult = checkpoint.claimResult;
        this.logger.info(`Task ${pda}: skipping claim (recovered)`);

        // Set up deadline timer
        ({ deadlineTimerId, claimExpired } = await this.setupDeadlineTimer(
          task,
          controller,
          deadlineTimerId,
          claimExpired,
          pda,
        ));
        if (claimExpired) return;

        // Set up execution timeout
        if (this.taskTimeoutMs > 0) {
          timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, this.taskTimeoutMs);
        }

        executionResult = await this.executeTaskStep(
          task,
          claimResult,
          controller.signal,
        );

        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (deadlineTimerId !== null) {
          clearTimeout(deadlineTimerId);
          deadlineTimerId = null;
        }

        // Checkpoint after execution
        await this.saveCheckpoint(
          pda,
          "executed",
          claimResult,
          executionResult,
          checkpoint.createdAt,
        );
      } else if (
        checkpoint.stage === "executed" &&
        checkpoint.claimResult &&
        checkpoint.executionResult
      ) {
        // Already claimed + executed — skip to submit
        claimResult = checkpoint.claimResult;
        executionResult = checkpoint.executionResult;
        this.logger.info(`Task ${pda}: skipping claim+execute (recovered)`);
      } else {
        // Unexpected state — clean up
        this.logger.warn(
          `Checkpoint for ${pda} in unexpected state '${checkpoint.stage}', removing`,
        );
        await this.checkpointStore!.remove(pda);
        return;
      }

      // Submit
      await this.retryStage(
        "submit",
        () => this.submitTaskStep(task, executionResult),
        controller.signal,
      );

      // Success — remove checkpoint
      await this.checkpointStore!.remove(pda);
    } catch (err) {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (deadlineTimerId !== null) clearTimeout(deadlineTimerId);

      if (claimExpired) {
        const claim = await this.operations
          .fetchClaim(task.pda)
          .catch(() => null);
        const expiresAt = claim?.expiresAt ?? 0;
        const expiredError = new ClaimExpiredError(
          expiresAt,
          this.claimExpiryBufferMs,
        );
        this.metrics.tasksFailed++;
        this.metrics.claimsExpired++;
        this.events.onClaimExpiring?.(expiredError, task.pda);
        this.events.onTaskFailed?.(expiredError, task.pda);
        this.sendToDeadLetterQueue(task, expiredError, "execute", 1);
      } else if (timedOut) {
        const timeoutError = new TaskTimeoutError(this.taskTimeoutMs);
        this.metrics.tasksFailed++;
        this.events.onTaskTimeout?.(timeoutError, task.pda);
        this.events.onTaskFailed?.(timeoutError, task.pda);
        this.sendToDeadLetterQueue(task, timeoutError, "execute", 1);
      } else if (controller.signal.aborted) {
        this.logger.debug(`Recovered task ${pda} aborted`);
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        const stage = this.inferFailureStage(error);
        const attempts =
          error instanceof RetryExhaustedError ? error.attempts : 1;
        this.sendToDeadLetterQueue(task, error, stage, attempts);
      }

      // Clean up checkpoint on failure (the DLQ captures the failure context)
      await this.checkpointStore!.remove(pda).catch((err: unknown) => {
        this.logger.warn("Failed to remove checkpoint", err);
      });
    } finally {
      this.activeTasks.delete(pda);
      this.drainQueue();
    }
  }

  /**
   * Set up the claim deadline timer. Returns updated flags.
   */
  private async setupDeadlineTimer(
    task: TaskDiscoveryResult,
    controller: AbortController,
    _deadlineTimerId: ReturnType<typeof setTimeout> | null,
    _claimExpired: boolean,
    pda: string,
  ): Promise<{
    deadlineTimerId: ReturnType<typeof setTimeout> | null;
    claimExpired: boolean;
  }> {
    let deadlineTimerId: ReturnType<typeof setTimeout> | null = null;
    let claimExpired = false;

    if (this.claimExpiryBufferMs > 0) {
      const claim = await this.operations.fetchClaim(task.pda);
      if (claim && claim.expiresAt > 0) {
        const nowMs = Date.now();
        const expiresAtMs = claim.expiresAt * 1000;
        const remainingMs = expiresAtMs - nowMs;
        const effectiveMs = remainingMs - this.claimExpiryBufferMs;

        if (effectiveMs <= 0) {
          claimExpired = true;
          controller.abort();
          const expiredError = new ClaimExpiredError(
            claim.expiresAt,
            this.claimExpiryBufferMs,
          );
          this.metrics.tasksFailed++;
          this.metrics.claimsExpired++;
          this.events.onClaimExpiring?.(expiredError, task.pda);
          this.events.onTaskFailed?.(expiredError, task.pda);
          this.sendToDeadLetterQueue(task, expiredError, "claim", 1);
          this.logger.warn(
            `Task ${pda} claim deadline too close: remaining=${remainingMs}ms, buffer=${this.claimExpiryBufferMs}ms`,
          );
          return { deadlineTimerId, claimExpired };
        }

        deadlineTimerId = setTimeout(() => {
          claimExpired = true;
          controller.abort();
        }, effectiveMs);
      }
    }

    return { deadlineTimerId, claimExpired };
  }

  // ==========================================================================
  // Autonomous Mode
  // ==========================================================================

  private async autonomousLoop(): Promise<void> {
    if (!this.discovery) {
      throw new Error("TaskDiscovery is required for autonomous mode");
    }

    // Register discovery callback
    this.discoveryUnsubscribe = this.discovery.onTaskDiscovered(
      (task: TaskDiscoveryResult) => {
        this.metrics.tasksDiscovered++;
        this.metricsProvider.counter(METRIC_NAMES.TASKS_DISCOVERED);
        this.events.onTaskDiscovered?.(task);
        this.handleDiscoveredTask(task);
      },
    );

    // Start periodic re-scoring if configured
    if (this.rescoreIntervalMs > 0) {
      this.rescoreTimerId = setInterval(() => {
        this.taskQueue.rescore((task) => this.scoreTask(task));
      }, this.rescoreIntervalMs);
    }

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
      this.metricsProvider.counter(METRIC_NAMES.TASKS_DISCOVERED);
      this.events.onTaskDiscovered?.(task);

      if (this.activeTasks.size < this.maxConcurrentTasks) {
        this.launchTask(task);
      } else {
        this.taskQueue.push(task, this.scoreTask(task));
      }
    }

    // Drain remaining queued tasks
    this.drainQueue();

    // Wait for all active tasks to complete
    while (this.activeTasks.size > 0 || this.taskQueue.size > 0) {
      await sleep(50);
    }
  }

  private async resolveBatchItem(
    item: BatchTaskItem,
  ): Promise<TaskDiscoveryResult | null> {
    let taskPda: PublicKey | undefined = item.taskPda;

    // Derive PDA from creator + taskId if not directly provided
    if (!taskPda && item.creator && item.taskId) {
      const { address } = deriveTaskPda(item.creator, item.taskId);
      taskPda = address;
    }

    if (!taskPda) {
      this.logger.warn("Batch item missing taskPda or creator+taskId");
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
      source: "poll",
    };
  }

  // ==========================================================================
  // Concurrency Management
  // ==========================================================================

  private handleDiscoveredTask(task: TaskDiscoveryResult): void {
    if (
      this.activeTasks.size < this.maxConcurrentTasks &&
      this.taskQueue.size === 0
    ) {
      this.launchTask(task);
    } else {
      this.taskQueue.push(task, this.scoreTask(task));
      this.checkHighWaterMark();
    }
  }

  private drainQueue(): void {
    while (
      this.running &&
      this.activeTasks.size < this.maxConcurrentTasks &&
      this.taskQueue.size > 0
    ) {
      const task = this.taskQueue.pop()!;
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
      this.taskQueue.size >= this.backpressureConfig.highWaterMark
    ) {
      this.backpressureActive = true;
      this.discovery?.pause();
      this.events.onBackpressureActivated?.();
      this.logger.info(
        `Backpressure activated: queue size ${this.taskQueue.size} >= high-water mark ${this.backpressureConfig.highWaterMark}`,
      );
    }
  }

  /**
   * If queue has drained to the low-water mark, resume discovery.
   */
  private checkLowWaterMark(): void {
    if (
      this.backpressureActive &&
      this.taskQueue.size <= this.backpressureConfig.lowWaterMark
    ) {
      this.backpressureActive = false;
      this.discovery?.resume();
      this.events.onBackpressureReleased?.();
      this.logger.info(
        `Backpressure released: queue size ${this.taskQueue.size} <= low-water mark ${this.backpressureConfig.lowWaterMark}`,
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
    const state: PipelineRuntimeState = {
      timeoutId: null,
      deadlineTimerId: null,
      timedOut: false,
      claimExpired: false,
    };

    const pipelineStart = Date.now();
    const span = this.tracingProvider.startSpan("agenc.task.pipeline", {
      taskPda: pda,
    });

    // Update gauges at pipeline entry
    this.metricsProvider.gauge(
      METRIC_NAMES.ACTIVE_COUNT,
      this.activeTasks.size,
    );
    this.metricsProvider.gauge(METRIC_NAMES.QUEUE_SIZE, this.taskQueue.size);

    try {
      const pipeline = await this.runClaimAndExecutePipeline(
        task,
        pda,
        controller,
        state,
        span,
      );
      if (!pipeline) {
        return;
      }

      // Step 5: Submit result on-chain (with retry)
      const submitStart = Date.now();
      await this.retryStage(
        "submit",
        () => this.submitTaskStep(task, pipeline.result),
        controller.signal,
      );
      this.metricsProvider.histogram(
        METRIC_NAMES.SUBMIT_DURATION,
        Date.now() - submitStart,
        { taskPda: pda },
      );
      span.setAttribute("submit.duration_ms", Date.now() - submitStart);

      // Full pipeline duration
      this.metricsProvider.histogram(
        METRIC_NAMES.PIPELINE_DURATION,
        Date.now() - pipelineStart,
        { taskPda: pda },
      );
      span.setStatus("ok");

      // Submission succeeded — remove checkpoint
      await this.removeCheckpoint(pda);
    } catch (err) {
      await this.handlePipelineFailure(task, pda, controller, state, err, span);
    } finally {
      this.clearPipelineTimers(state);
      span.end();
      this.activeTasks.delete(pda);
      // Update gauges at pipeline exit
      this.metricsProvider.gauge(
        METRIC_NAMES.ACTIVE_COUNT,
        this.activeTasks.size,
      );
      this.metricsProvider.gauge(METRIC_NAMES.QUEUE_SIZE, this.taskQueue.size);
      this.drainQueue();
    }
  }

  private async runClaimAndExecutePipeline(
    task: TaskDiscoveryResult,
    pda: string,
    controller: AbortController,
    state: PipelineRuntimeState,
    span: ReturnType<TracingProvider["startSpan"]>,
  ): Promise<{
    result: TaskExecutionResult | PrivateTaskExecutionResult;
  } | null> {
    const claimStart = Date.now();
    const claimResult = await this.retryStage(
      "claim",
      () => this.claimTaskStep(task),
      controller.signal,
    );
    this.metricsProvider.histogram(
      METRIC_NAMES.CLAIM_DURATION,
      Date.now() - claimStart,
      { taskPda: pda },
    );
    span.setAttribute("claim.duration_ms", Date.now() - claimStart);

    const checkpointCreatedAt = Date.now();
    await this.saveCheckpoint(
      pda,
      "claimed",
      claimResult,
      undefined,
      checkpointCreatedAt,
    );

    const canExecute = await this.setupClaimDeadlineGuard(
      task,
      pda,
      controller,
      state,
      span,
    );
    if (!canExecute) {
      return null;
    }

    this.startExecutionTimeout(controller, state);

    const executeStart = Date.now();
    const result = await this.executeTaskStep(
      task,
      claimResult,
      controller.signal,
    );
    this.metricsProvider.histogram(
      METRIC_NAMES.EXECUTE_DURATION,
      Date.now() - executeStart,
      { taskPda: pda },
    );
    span.setAttribute("execute.duration_ms", Date.now() - executeStart);

    // Execute completed — stop timeout/deadline guards before submit stage.
    this.clearPipelineTimers(state);

    await this.saveCheckpoint(
      pda,
      "executed",
      claimResult,
      result,
      checkpointCreatedAt,
    );
    return { result };
  }

  private startExecutionTimeout(
    controller: AbortController,
    state: PipelineRuntimeState,
  ): void {
    if (this.taskTimeoutMs <= 0) {
      return;
    }
    state.timeoutId = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, this.taskTimeoutMs);
  }

  private clearPipelineTimers(state: PipelineRuntimeState): void {
    if (state.timeoutId !== null) {
      clearTimeout(state.timeoutId);
      state.timeoutId = null;
    }
    if (state.deadlineTimerId !== null) {
      clearTimeout(state.deadlineTimerId);
      state.deadlineTimerId = null;
    }
  }

  private async setupClaimDeadlineGuard(
    task: TaskDiscoveryResult,
    pda: string,
    controller: AbortController,
    state: PipelineRuntimeState,
    span: ReturnType<TracingProvider["startSpan"]>,
  ): Promise<boolean> {
    if (this.claimExpiryBufferMs <= 0) {
      return true;
    }

    const claim = await this.operations.fetchClaim(task.pda);
    if (!claim || claim.expiresAt <= 0) {
      return true;
    }

    const nowMs = Date.now();
    const expiresAtMs = claim.expiresAt * 1000;
    const remainingMs = expiresAtMs - nowMs;
    const effectiveMs = remainingMs - this.claimExpiryBufferMs;

    if (effectiveMs <= 0) {
      state.claimExpired = true;
      controller.abort();
      const expiredError = new ClaimExpiredError(
        claim.expiresAt,
        this.claimExpiryBufferMs,
      );
      this.metrics.tasksFailed++;
      this.metrics.claimsExpired++;
      this.metricsProvider.counter(METRIC_NAMES.TASKS_FAILED);
      this.metricsProvider.counter(METRIC_NAMES.CLAIMS_EXPIRED);
      this.events.onClaimExpiring?.(expiredError, task.pda);
      this.events.onTaskFailed?.(expiredError, task.pda);
      this.sendToDeadLetterQueue(task, expiredError, "claim", 1);
      this.logger.warn(
        `Task ${pda} claim deadline too close: remaining=${remainingMs}ms, buffer=${this.claimExpiryBufferMs}ms`,
      );
      span.setStatus("error", "claim deadline too close");
      return false;
    }

    state.deadlineTimerId = setTimeout(() => {
      state.claimExpired = true;
      controller.abort();
    }, effectiveMs);
    return true;
  }

  private async handlePipelineFailure(
    task: TaskDiscoveryResult,
    pda: string,
    controller: AbortController,
    state: PipelineRuntimeState,
    error: unknown,
    span: ReturnType<TracingProvider["startSpan"]>,
  ): Promise<void> {
    if (state.claimExpired) {
      // Claim deadline expired during execution
      const claim = await this.operations
        .fetchClaim(task.pda)
        .catch(() => null);
      const expiresAt = claim?.expiresAt ?? 0;
      const expiredError = new ClaimExpiredError(
        expiresAt,
        this.claimExpiryBufferMs,
      );
      this.metrics.tasksFailed++;
      this.metrics.claimsExpired++;
      this.metricsProvider.counter(METRIC_NAMES.TASKS_FAILED);
      this.metricsProvider.counter(METRIC_NAMES.CLAIMS_EXPIRED);
      this.events.onClaimExpiring?.(expiredError, task.pda);
      this.events.onTaskFailed?.(expiredError, task.pda);
      this.sendToDeadLetterQueue(task, expiredError, "execute", 1);
      this.logger.warn(`Task ${pda} aborted: claim deadline expiring`);
      span.setStatus("error", "claim deadline expired");
      return;
    }

    if (state.timedOut) {
      // Timeout-specific handling: emit onTaskTimeout, increment tasksFailed
      const timeoutError = new TaskTimeoutError(this.taskTimeoutMs);
      this.metrics.tasksFailed++;
      this.metricsProvider.counter(METRIC_NAMES.TASKS_FAILED);
      this.events.onTaskTimeout?.(timeoutError, task.pda);
      this.events.onTaskFailed?.(timeoutError, task.pda);
      this.sendToDeadLetterQueue(task, timeoutError, "execute", 1);
      this.logger.warn(`Task ${pda} timed out after ${this.taskTimeoutMs}ms`);
      span.setStatus("error", "timeout");
      return;
    }

    if (controller.signal.aborted) {
      // Graceful shutdown — do not send to DLQ
      this.logger.debug(`Task ${pda} aborted`);
      span.setStatus("error", "aborted");
      return;
    }

    // Non-abort failure (handler crash, retry exhaustion, etc.)
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    const stage = this.inferFailureStage(normalizedError);
    const attempts =
      normalizedError instanceof RetryExhaustedError
        ? normalizedError.attempts
        : 1;
    this.sendToDeadLetterQueue(task, normalizedError, stage, attempts);
    span.setStatus("error", normalizedError.message);
  }

  /**
   * Execute an operation with retry according to the configured retry policy.
   * Respects the abort signal during backoff waits.
   */
  private async retryStage<T>(
    stage: "claim" | "submit",
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

        const metricsKey = stage === "claim" ? "claimRetries" : "submitRetries";
        this.metrics[metricsKey]++;
        this.metricsProvider.counter(
          stage === "claim"
            ? METRIC_NAMES.CLAIM_RETRIES
            : METRIC_NAMES.SUBMIT_RETRIES,
        );

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
      this.metricsProvider.counter(METRIC_NAMES.TASKS_CLAIMED);
      this.events.onTaskClaimed?.(result);
      return result;
    } catch (err) {
      this.metrics.claimsFailed++;
      this.metricsProvider.counter(METRIC_NAMES.CLAIMS_FAILED);
      this.events.onClaimFailed?.(
        err instanceof Error ? err : new Error(String(err)),
        task.pda,
      );
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
      this.metricsProvider.counter(METRIC_NAMES.TASKS_FAILED);
      this.events.onTaskFailed?.(
        err instanceof Error ? err : new Error(String(err)),
        task.pda,
      );
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
      errorCode:
        "code" in error &&
        typeof (error as Record<string, unknown>).code === "string"
          ? ((error as Record<string, unknown>).code as string)
          : undefined,
      failedAt: Date.now(),
      stage,
      attempts,
      retryable: stage !== "execute",
    };
    this.dlq.add(entry);
    this.events.onDeadLettered?.(entry);
    this.logger.debug(
      `Task ${entry.taskPda} sent to dead letter queue (stage=${stage}, attempts=${attempts})`,
    );
  }

  /**
   * Infer the pipeline stage from the error type.
   */
  private inferFailureStage(error: Error): DeadLetterStage {
    if (error instanceof RetryExhaustedError) {
      return error.stage as DeadLetterStage;
    }
    if (error instanceof TaskTimeoutError) {
      return "execute";
    }
    if (error instanceof ClaimExpiredError) {
      return "execute";
    }
    // Handler failures and unknown errors default to 'execute'
    return "execute";
  }

  // ==========================================================================
  // Checkpoint Persistence
  // ==========================================================================

  /**
   * Persist a checkpoint after a stage transition (no-op if no store configured).
   */
  private async saveCheckpoint(
    taskPda: string,
    stage: TaskCheckpoint["stage"],
    claimResult?: ClaimResult,
    executionResult?: TaskExecutionResult | PrivateTaskExecutionResult,
    createdAt?: number,
  ): Promise<void> {
    if (!this.checkpointStore) return;
    const now = Date.now();
    await this.checkpointStore.save({
      taskPda,
      stage,
      claimResult,
      executionResult,
      createdAt: createdAt ?? now,
      updatedAt: now,
    });
  }

  /**
   * Remove a checkpoint after successful submission (no-op if no store configured).
   */
  private async removeCheckpoint(taskPda: string): Promise<void> {
    if (!this.checkpointStore) return;
    await this.checkpointStore.remove(taskPda);
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
          result.sealBytes,
          result.journal,
          result.imageId,
          result.bindingSeed,
          result.nullifierSeed,
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
      this.metricsProvider.counter(METRIC_NAMES.TASKS_COMPLETED);
      this.events.onTaskCompleted?.(completeResult);
      return completeResult;
    } catch (err) {
      this.metrics.submitsFailed++;
      this.metricsProvider.counter(METRIC_NAMES.SUBMITS_FAILED);
      this.events.onSubmitFailed?.(
        err instanceof Error ? err : new Error(String(err)),
        task.pda,
      );
      throw err;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

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
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
