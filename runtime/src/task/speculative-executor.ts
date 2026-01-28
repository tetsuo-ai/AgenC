/**
 * SpeculativeExecutor - Single-level speculative execution with proof pipelining.
 *
 * Extends TaskExecutor to enable speculative execution of dependent tasks
 * while parent proofs are being generated. This reduces pipeline latency
 * by overlapping execution and proof generation.
 *
 * Key features:
 * - Single-level speculation (no chaining A->B->C)
 * - Proof submission gated on parent confirmation
 * - Automatic abort of speculative tasks when parent fails
 * - Configurable dependency type filtering
 *
 * @module
 */

import type { PublicKey } from '@solana/web3.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type { TaskOperations } from './operations.js';
import type { TaskDiscovery } from './discovery.js';
import type {
  TaskExecutionResult,
  PrivateTaskExecutionResult,
  TaskHandler,
  TaskExecutorConfig,
  TaskExecutorEvents,
  MetricsProvider,
  TracingProvider,
  OnChainTask,
  TaskExecutionContext,
} from './types.js';
import {
  DependencyGraph,
  DependencyType,
  type TaskNode,
} from './dependency-graph.js';
import {
  ProofPipeline,
  type ProofPipelineConfig,
  type ProofPipelineEvents,
  type ProofGenerationJob,
} from './proof-pipeline.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Status of a speculative task execution.
 */
export type SpeculativeTaskStatus =
  | 'pending'
  | 'executing'
  | 'executed'
  | 'proof_queued'
  | 'confirmed'
  | 'aborted'
  | 'failed';

/**
 * Tracks a speculatively executed task.
 */
export interface SpeculativeTask {
  /** Task PDA address */
  readonly taskPda: PublicKey;
  /** Task ID (32 bytes) */
  readonly taskId: Uint8Array;
  /** Parent task PDA that this depends on */
  readonly parentPda: PublicKey;
  /** Current speculative status */
  status: SpeculativeTaskStatus;
  /** Execution result (set after execution completes) */
  executionResult?: TaskExecutionResult | PrivateTaskExecutionResult;
  /** Timestamp when speculative execution started */
  readonly startedAt: number;
  /** Timestamp when completed or aborted */
  completedAt?: number;
  /** Abort reason if aborted */
  abortReason?: string;
  /** AbortController for cancellation */
  readonly controller: AbortController;
}

/**
 * Configuration for speculative execution.
 */
export interface SpeculativeExecutorConfig extends Omit<TaskExecutorConfig, 'discovery'> {
  /** TaskDiscovery instance (optional for speculative mode) */
  discovery?: TaskDiscovery;
  /** Enable single-level speculation. Default: true */
  enableSpeculation?: boolean;
  /** Maximum speculative tasks per parent. Default: 5 */
  maxSpeculativeTasksPerParent?: number;
  /** Dependency types eligible for speculation. Default: [Data, Order] */
  speculatableDependencyTypes?: DependencyType[];
  /** Abort speculative tasks if parent proof fails. Default: true */
  abortOnParentFailure?: boolean;
  /** Proof pipeline configuration */
  proofPipelineConfig?: Partial<ProofPipelineConfig>;
}

/**
 * Extended events for speculative execution lifecycle.
 */
export interface SpeculativeExecutorEvents extends TaskExecutorEvents {
  /** Called when speculative execution starts for a dependent task */
  onSpeculativeExecutionStarted?: (taskPda: PublicKey, parentPda: PublicKey) => void;
  /** Called when a speculative task's proof is confirmed on-chain */
  onSpeculativeExecutionConfirmed?: (taskPda: PublicKey) => void;
  /** Called when a speculative task is aborted (e.g., parent failed) */
  onSpeculativeExecutionAborted?: (taskPda: PublicKey, reason: string) => void;
  /** Called when parent proof is confirmed, enabling dependent submission */
  onParentProofConfirmed?: (parentPda: PublicKey) => void;
  /** Called when parent proof fails */
  onParentProofFailed?: (parentPda: PublicKey, error: Error) => void;
}

/**
 * Metrics for speculative execution tracking.
 */
export interface SpeculativeMetrics {
  /** Total speculative executions started */
  speculativeExecutionsStarted: number;
  /** Speculative executions that were confirmed */
  speculativeExecutionsConfirmed: number;
  /** Speculative executions that were aborted */
  speculativeExecutionsAborted: number;
  /** Total time saved by speculation (estimated, in ms) */
  estimatedTimeSavedMs: number;
}

/**
 * Status snapshot of the speculative executor.
 */
export interface SpeculativeExecutorStatus {
  /** Whether speculation is enabled */
  speculationEnabled: boolean;
  /** Number of active speculative tasks */
  activeSpeculativeTasks: number;
  /** Number of tasks awaiting parent confirmation */
  tasksAwaitingParent: number;
  /** Proof pipeline stats */
  proofPipelineStats: {
    queued: number;
    generating: number;
    awaitingSubmission: number;
    confirmed: number;
    failed: number;
  };
  /** Speculative execution metrics */
  metrics: SpeculativeMetrics;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_SPECULATIVE_CONFIG = {
  enableSpeculation: true,
  maxSpeculativeTasksPerParent: 5,
  speculatableDependencyTypes: [DependencyType.Data, DependencyType.Order],
  abortOnParentFailure: true,
};

// ============================================================================
// SpeculativeExecutor Class
// ============================================================================

/**
 * Executor with single-level speculative execution support.
 *
 * When a task completes execution, the executor:
 * 1. Queues proof generation (async)
 * 2. Identifies dependent tasks eligible for speculation
 * 3. Starts executing dependents speculatively
 * 4. Holds dependent proofs until parent proof confirms
 * 5. Aborts dependents if parent proof fails
 *
 * @example
 * ```typescript
 * const executor = new SpeculativeExecutor({
 *   operations,
 *   handler: async (ctx) => ({ proofHash: new Uint8Array(32).fill(1) }),
 *   agentId: myAgentId,
 *   agentPda: myAgentPda,
 *   enableSpeculation: true,
 *   maxSpeculativeTasksPerParent: 3,
 * });
 *
 * executor.on({
 *   onSpeculativeExecutionStarted: (taskPda, parentPda) => {
 *     console.log(`Speculating ${taskPda} based on ${parentPda}`);
 *   },
 * });
 *
 * // Execute a task and its dependents speculatively
 * await executor.executeWithSpeculation(taskPda, parentResult);
 * ```
 */
export class SpeculativeExecutor {
  private readonly operations: TaskOperations;
  private readonly handler: TaskHandler;
  private readonly agentId: Uint8Array;
  private readonly agentPda: PublicKey;
  private readonly logger: Logger;
  private readonly metricsProvider?: MetricsProvider;
  private readonly tracingProvider?: TracingProvider;

  // Speculation configuration
  private readonly speculationEnabled: boolean;
  private readonly maxSpeculativeTasksPerParent: number;
  private readonly speculatableDependencyTypes: Set<DependencyType>;
  private readonly abortOnParentFailure: boolean;

  // Core components
  private readonly dependencyGraph: DependencyGraph;
  private readonly proofPipeline: ProofPipeline;

  // Runtime state
  private readonly speculativeTasks: Map<string, SpeculativeTask> = new Map();
  private readonly parentToSpeculativeTasks: Map<string, Set<string>> = new Map();
  private events: SpeculativeExecutorEvents = {};

  // Metrics
  private metrics: SpeculativeMetrics = {
    speculativeExecutionsStarted: 0,
    speculativeExecutionsConfirmed: 0,
    speculativeExecutionsAborted: 0,
    estimatedTimeSavedMs: 0,
  };

  constructor(config: SpeculativeExecutorConfig) {
    this.operations = config.operations;
    this.handler = config.handler;
    this.agentId = new Uint8Array(config.agentId);
    this.agentPda = config.agentPda;
    this.logger = config.logger ?? silentLogger;
    this.metricsProvider = config.metrics;
    this.tracingProvider = config.tracing;

    // Speculation config with defaults
    this.speculationEnabled = config.enableSpeculation ?? DEFAULT_SPECULATIVE_CONFIG.enableSpeculation;
    this.maxSpeculativeTasksPerParent = config.maxSpeculativeTasksPerParent ?? DEFAULT_SPECULATIVE_CONFIG.maxSpeculativeTasksPerParent;
    this.speculatableDependencyTypes = new Set(
      config.speculatableDependencyTypes ?? DEFAULT_SPECULATIVE_CONFIG.speculatableDependencyTypes
    );
    this.abortOnParentFailure = config.abortOnParentFailure ?? DEFAULT_SPECULATIVE_CONFIG.abortOnParentFailure;

    // Initialize dependency graph
    this.dependencyGraph = new DependencyGraph();

    // Initialize proof pipeline with event handlers
    const pipelineEvents: ProofPipelineEvents = {
      onProofQueued: (job) => this.handleProofQueued(job),
      onProofGenerated: (job) => this.handleProofGenerated(job),
      onProofConfirmed: (job) => this.handleProofConfirmed(job),
      onProofFailed: (job, error) => this.handleProofFailed(job, error),
    };

    this.proofPipeline = new ProofPipeline(
      config.proofPipelineConfig ?? {},
      pipelineEvents,
      this.operations,
    );
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Register event callbacks for speculative execution lifecycle.
   */
  on(events: SpeculativeExecutorEvents): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * Get the dependency graph for external inspection or manipulation.
   */
  getDependencyGraph(): DependencyGraph {
    return this.dependencyGraph;
  }

  /**
   * Get the proof pipeline for external inspection.
   */
  getProofPipeline(): ProofPipeline {
    return this.proofPipeline;
  }

  /**
   * Get current speculative executor status.
   */
  getStatus(): SpeculativeExecutorStatus {
    let tasksAwaitingParent = 0;
    for (const task of this.speculativeTasks.values()) {
      if (task.status === 'proof_queued') {
        tasksAwaitingParent++;
      }
    }

    return {
      speculationEnabled: this.speculationEnabled,
      activeSpeculativeTasks: this.speculativeTasks.size,
      tasksAwaitingParent,
      proofPipelineStats: this.proofPipeline.getStats(),
      metrics: { ...this.metrics },
    };
  }

  /**
   * Get speculative metrics snapshot.
   */
  getMetrics(): SpeculativeMetrics {
    return { ...this.metrics };
  }

  /**
   * Add a task to the dependency graph.
   * Must be called before executing tasks that have dependencies.
   *
   * @param task - The on-chain task data
   * @param taskPda - Task account PDA
   * @param parentPda - Parent task PDA (null for root tasks)
   * @param dependencyType - Type of dependency
   */
  addTaskToGraph(
    task: OnChainTask,
    taskPda: PublicKey,
    parentPda: PublicKey | null = null,
    dependencyType: DependencyType = DependencyType.Data,
  ): void {
    if (parentPda) {
      this.dependencyGraph.addTaskWithParent(task, taskPda, parentPda, dependencyType);
    } else {
      this.dependencyGraph.addTask(task, taskPda);
    }
  }

  /**
   * Execute a task with speculative execution of dependents.
   *
   * When the task completes execution:
   * 1. Queues proof generation (async)
   * 2. Finds eligible dependent tasks
   * 3. Starts speculative execution of dependents
   *
   * @param taskPda - Task account PDA
   * @param parentResult - Optional parent execution result for data dependencies
   * @returns Execution result
   */
  async executeWithSpeculation(
    taskPda: PublicKey,
    parentResult?: TaskExecutionResult | PrivateTaskExecutionResult,
  ): Promise<TaskExecutionResult | PrivateTaskExecutionResult> {
    const pdaKey = taskPda.toBase58();
    this.logger.info(`Starting execution with speculation: ${pdaKey}`);

    // Mark task as executing in the graph
    this.dependencyGraph.updateStatus(taskPda, 'executing');

    // Execute the task
    const result = await this.executeTask(taskPda, parentResult);

    // Mark as completed in graph
    this.dependencyGraph.updateStatus(taskPda, 'completed');

    // Queue proof generation
    const task = await this.operations.fetchTask(taskPda);
    if (!task) {
      throw new Error(`Task not found: ${pdaKey}`);
    }

    this.proofPipeline.enqueue(taskPda, task.taskId, result);

    // Start speculative execution of dependents if enabled
    if (this.speculationEnabled) {
      await this.startSpeculativeExecutions(taskPda, result);
    }

    return result;
  }

  /**
   * Execute a task without speculation.
   * Used for root tasks or when speculation is disabled.
   *
   * @param taskPda - Task account PDA
   * @param parentResult - Optional parent execution result
   * @returns Execution result
   */
  async executeTask(
    taskPda: PublicKey,
    parentResult?: TaskExecutionResult | PrivateTaskExecutionResult,
  ): Promise<TaskExecutionResult | PrivateTaskExecutionResult> {
    const pdaKey = taskPda.toBase58();
    this.logger.debug(`Executing task: ${pdaKey}`);

    // Fetch task data
    const task = await this.operations.fetchTask(taskPda);
    if (!task) {
      throw new Error(`Task not found: ${pdaKey}`);
    }

    // Fetch claim data
    const claim = await this.operations.fetchClaim(taskPda);
    if (!claim) {
      throw new Error(`Claim not found for task: ${pdaKey}`);
    }

    // Create execution context
    const controller = new AbortController();
    const context: TaskExecutionContext = {
      task,
      taskPda,
      claimPda: taskPda, // Claim PDA is derived from task PDA
      agentId: this.agentId,
      agentPda: this.agentPda,
      logger: this.logger,
      signal: controller.signal,
    };

    // Add parent result to context if available (as custom property)
    if (parentResult) {
      (context as TaskExecutionContext & { parentResult?: typeof parentResult }).parentResult = parentResult;
    }

    // Start tracing span
    const span = this.tracingProvider?.startSpan('task.execute', {
      taskPda: pdaKey,
    });

    try {
      this.events.onTaskExecutionStarted?.(context);

      // Execute the handler
      const result = await this.handler(context);

      span?.setStatus('ok');
      this.logger.debug(`Task execution completed: ${pdaKey}`);

      return result;
    } catch (error) {
      span?.setStatus('error', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      span?.end();
    }
  }

  /**
   * Wait for a task's proof to be confirmed.
   *
   * @param taskPda - Task account PDA
   * @param timeoutMs - Timeout in milliseconds
   */
  async waitForProofConfirmation(taskPda: PublicKey, timeoutMs?: number): Promise<ProofGenerationJob> {
    return this.proofPipeline.waitForConfirmation(taskPda, timeoutMs);
  }

  /**
   * Cancel a speculative task.
   *
   * @param taskPda - Task account PDA
   * @param reason - Cancellation reason
   */
  cancelSpeculativeTask(taskPda: PublicKey, reason: string): boolean {
    const pdaKey = taskPda.toBase58();
    const specTask = this.speculativeTasks.get(pdaKey);

    if (!specTask) {
      return false;
    }

    this.abortSpeculativeTask(specTask, reason);
    return true;
  }

  /**
   * Graceful shutdown - wait for in-flight proofs.
   */
  async shutdown(): Promise<void> {
    this.logger.info('SpeculativeExecutor shutting down...');

    // Abort all speculative tasks
    for (const specTask of this.speculativeTasks.values()) {
      if (specTask.status === 'executing' || specTask.status === 'pending') {
        this.abortSpeculativeTask(specTask, 'shutdown');
      }
    }

    // Shutdown proof pipeline
    await this.proofPipeline.shutdown();

    this.logger.info('SpeculativeExecutor shutdown complete');
  }

  // ==========================================================================
  // Speculative Execution
  // ==========================================================================

  /**
   * Start speculative execution of dependent tasks.
   * Only speculates ONE level deep (direct dependents only).
   */
  private async startSpeculativeExecutions(
    parentPda: PublicKey,
    parentResult: TaskExecutionResult | PrivateTaskExecutionResult,
  ): Promise<void> {
    const parentKey = parentPda.toBase58();

    // Get direct dependents from the graph
    const dependents = this.dependencyGraph.getDependents(parentPda);

    if (dependents.length === 0) {
      this.logger.debug(`No dependents found for ${parentKey}`);
      return;
    }

    // Filter to speculatable dependency types
    const speculatable = dependents.filter((dep) =>
      this.speculatableDependencyTypes.has(dep.dependencyType)
    );

    if (speculatable.length === 0) {
      this.logger.debug(`No speculatable dependents for ${parentKey}`);
      return;
    }

    // Get existing speculative tasks for this parent
    const existingCount = this.parentToSpeculativeTasks.get(parentKey)?.size ?? 0;
    const remainingSlots = this.maxSpeculativeTasksPerParent - existingCount;

    if (remainingSlots <= 0) {
      this.logger.debug(`Max speculative tasks reached for parent ${parentKey}`);
      return;
    }

    // Take only up to remaining slots
    const toSpeculate = speculatable.slice(0, remainingSlots);

    this.logger.info(
      `Starting ${toSpeculate.length} speculative execution(s) for parent ${parentKey}`
    );

    // Start speculative execution for each eligible dependent
    for (const dependent of toSpeculate) {
      await this.startSpeculativeTask(dependent, parentPda, parentResult);
    }
  }

  /**
   * Start speculative execution of a single dependent task.
   */
  private async startSpeculativeTask(
    taskNode: TaskNode,
    parentPda: PublicKey,
    parentResult: TaskExecutionResult | PrivateTaskExecutionResult,
  ): Promise<void> {
    const pdaKey = taskNode.taskPda.toBase58();
    const parentKey = parentPda.toBase58();

    // Check if already speculating
    if (this.speculativeTasks.has(pdaKey)) {
      this.logger.debug(`Task ${pdaKey} already speculating`);
      return;
    }

    // Create speculative task tracker
    const controller = new AbortController();
    const specTask: SpeculativeTask = {
      taskPda: taskNode.taskPda,
      taskId: taskNode.taskId,
      parentPda,
      status: 'pending',
      startedAt: Date.now(),
      controller,
    };

    // Register in tracking maps
    this.speculativeTasks.set(pdaKey, specTask);
    if (!this.parentToSpeculativeTasks.has(parentKey)) {
      this.parentToSpeculativeTasks.set(parentKey, new Set());
    }
    this.parentToSpeculativeTasks.get(parentKey)!.add(pdaKey);

    // Update metrics
    this.metrics.speculativeExecutionsStarted++;
    this.metricsProvider?.counter('speculative_executions_started', 1);

    // Emit event
    this.events.onSpeculativeExecutionStarted?.(taskNode.taskPda, parentPda);

    // Execute speculatively (don't await - fire and forget)
    this.executeSpeculativeTask(specTask, parentResult).catch((error) => {
      this.logger.error(`Speculative execution failed for ${pdaKey}: ${error}`);
      specTask.status = 'failed';
      specTask.completedAt = Date.now();
      specTask.abortReason = error instanceof Error ? error.message : String(error);
    });
  }

  /**
   * Execute a speculative task and queue its proof.
   */
  private async executeSpeculativeTask(
    specTask: SpeculativeTask,
    parentResult: TaskExecutionResult | PrivateTaskExecutionResult,
  ): Promise<void> {
    const pdaKey = specTask.taskPda.toBase58();

    try {
      specTask.status = 'executing';

      // Check if aborted before starting
      if (specTask.controller.signal.aborted) {
        throw new Error('Aborted before execution');
      }

      // Update graph status
      this.dependencyGraph.updateStatus(specTask.taskPda, 'executing');

      // Execute the task with parent result context
      const result = await this.executeTask(specTask.taskPda, parentResult);

      // Check if aborted during execution
      if (specTask.controller.signal.aborted) {
        throw new Error('Aborted during execution');
      }

      // Store result
      specTask.executionResult = result;
      specTask.status = 'executed';

      // Update graph status
      this.dependencyGraph.updateStatus(specTask.taskPda, 'completed');

      // Fetch task data for proof pipeline
      const task = await this.operations.fetchTask(specTask.taskPda);
      if (!task) {
        throw new Error(`Task not found: ${pdaKey}`);
      }

      // Queue proof generation
      // The proof will NOT be submitted until parent is confirmed
      this.proofPipeline.enqueue(specTask.taskPda, task.taskId, result);
      specTask.status = 'proof_queued';

      this.logger.debug(`Speculative task ${pdaKey} executed, proof queued`);
    } catch (error) {
      if (specTask.controller.signal.aborted) {
        this.logger.debug(`Speculative task ${pdaKey} was aborted`);
        // Status already set by abortSpeculativeTask
      } else {
        specTask.status = 'failed';
        specTask.completedAt = Date.now();
        specTask.abortReason = error instanceof Error ? error.message : String(error);
        this.dependencyGraph.updateStatus(specTask.taskPda, 'failed');
        this.logger.error(`Speculative execution failed: ${pdaKey} - ${specTask.abortReason}`);
      }
    }
  }

  /**
   * Abort a speculative task.
   */
  private abortSpeculativeTask(specTask: SpeculativeTask, reason: string): void {
    const pdaKey = specTask.taskPda.toBase58();

    if (specTask.status === 'confirmed' || specTask.status === 'aborted') {
      return; // Already finalized
    }

    // Signal abort
    specTask.controller.abort();

    // Update state
    specTask.status = 'aborted';
    specTask.completedAt = Date.now();
    specTask.abortReason = reason;

    // Update graph
    this.dependencyGraph.updateStatus(specTask.taskPda, 'failed');

    // Cancel proof job if queued
    this.proofPipeline.cancel(specTask.taskPda);

    // Update metrics
    this.metrics.speculativeExecutionsAborted++;
    this.metricsProvider?.counter('speculative_executions_aborted', 1);

    // Emit event
    this.events.onSpeculativeExecutionAborted?.(specTask.taskPda, reason);

    this.logger.info(`Speculative task aborted: ${pdaKey} - ${reason}`);
  }

  // ==========================================================================
  // Proof Pipeline Event Handlers
  // ==========================================================================

  /**
   * Handle proof job queued event.
   */
  private handleProofQueued(job: ProofGenerationJob): void {
    this.logger.debug(`Proof queued: ${job.taskPda.toBase58()}`);
  }

  /**
   * Handle proof generated event.
   */
  private handleProofGenerated(job: ProofGenerationJob): void {
    this.logger.debug(`Proof generated: ${job.taskPda.toBase58()}`);
  }

  /**
   * Handle proof confirmed event.
   * When a parent proof is confirmed, check for speculative dependents
   * that can now have their proofs submitted.
   */
  private handleProofConfirmed(job: ProofGenerationJob): void {
    const pdaKey = job.taskPda.toBase58();
    this.logger.info(`Proof confirmed: ${pdaKey}`);

    // Check if this is a speculative task
    const specTask = this.speculativeTasks.get(pdaKey);
    if (specTask) {
      specTask.status = 'confirmed';
      specTask.completedAt = Date.now();

      // Calculate estimated time saved
      const timeSaved = specTask.startedAt ? Date.now() - specTask.startedAt : 0;
      this.metrics.estimatedTimeSavedMs += timeSaved;

      this.metrics.speculativeExecutionsConfirmed++;
      this.metricsProvider?.counter('speculative_executions_confirmed', 1);

      this.events.onSpeculativeExecutionConfirmed?.(job.taskPda);
    }

    // Emit parent confirmation event
    this.events.onParentProofConfirmed?.(job.taskPda);

    // Check if there are speculative dependents waiting for this parent
    const dependentKeys = this.parentToSpeculativeTasks.get(pdaKey);
    if (dependentKeys && dependentKeys.size > 0) {
      this.logger.debug(
        `Parent ${pdaKey} confirmed, ${dependentKeys.size} dependent(s) can now submit proofs`
      );

      // The proof pipeline will automatically submit queued proofs
      // when ancestors are confirmed (handled by ProofPipeline internals)
    }
  }

  /**
   * Handle proof failed event.
   * When a parent proof fails, abort all speculative dependents.
   */
  private handleProofFailed(job: ProofGenerationJob, error: Error): void {
    const pdaKey = job.taskPda.toBase58();
    this.logger.error(`Proof failed: ${pdaKey} - ${error.message}`);

    // Emit parent failure event
    this.events.onParentProofFailed?.(job.taskPda, error);

    // Check if this is a speculative task that failed
    const specTask = this.speculativeTasks.get(pdaKey);
    if (specTask && specTask.status !== 'confirmed' && specTask.status !== 'aborted') {
      specTask.status = 'failed';
      specTask.completedAt = Date.now();
      specTask.abortReason = `proof failed: ${error.message}`;
    }

    // If abort on parent failure is enabled, abort all speculative dependents
    if (this.abortOnParentFailure) {
      const dependentKeys = this.parentToSpeculativeTasks.get(pdaKey);
      if (dependentKeys && dependentKeys.size > 0) {
        this.logger.info(
          `Parent ${pdaKey} proof failed, aborting ${dependentKeys.size} speculative dependent(s)`
        );

        for (const depKey of dependentKeys) {
          const depTask = this.speculativeTasks.get(depKey);
          if (depTask) {
            this.abortSpeculativeTask(depTask, `parent proof failed: ${error.message}`);
          }
        }
      }
    }
  }
}
