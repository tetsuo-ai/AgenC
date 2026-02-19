/**
 * ProofPipeline - Async proof generation pipeline for speculative execution.
 *
 * Decouples proof generation from submission, enabling proofs to be generated
 * asynchronously while other work continues. Supports concurrent proof generation
 * with limits and dependency-aware submission ordering.
 *
 * @module
 */

import type { PublicKey } from '@solana/web3.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type {
  TaskExecutionResult,
  PrivateTaskExecutionResult,
  RetryPolicy,
  OnChainTask,
} from './types.js';
import { isPrivateExecutionResult } from './types.js';
import type { TaskOperations } from './operations.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Status of a proof generation job in the pipeline.
 */
export type ProofJobStatus =
  | 'queued'
  | 'generating'
  | 'generated'
  | 'submitting'
  | 'confirmed'
  | 'failed';

/**
 * A proof generation job tracking the full lifecycle from queue to confirmation.
 */
export interface ProofGenerationJob {
  /** Unique job identifier */
  readonly id: string;
  /** Task PDA address */
  readonly taskPda: PublicKey;
  /** Task ID (32 bytes) */
  readonly taskId: Uint8Array;
  /** Execution result to generate proof from */
  readonly executionResult: TaskExecutionResult | PrivateTaskExecutionResult;
  /** Current job status */
  status: ProofJobStatus;
  /** Job creation timestamp (ms) */
  readonly createdAt: number;
  /** When proof generation started (ms) */
  startedAt?: number;
  /** When the job completed (confirmed or failed) (ms) */
  completedAt?: number;
  /** Generated proof bytes (set after generation) */
  proofBytes?: Uint8Array;
  /** Transaction signature if submitted */
  transactionSignature?: string;
  /** Error if job failed */
  error?: Error;
  /** Number of retry attempts */
  retryCount: number;
  /** Whether this is a private (ZK) proof */
  readonly isPrivate: boolean;
}

/**
 * Configuration for the proof pipeline.
 */
export interface ProofPipelineConfig {
  /** Maximum concurrent proof generation jobs. Default: 4 */
  maxConcurrentProofs: number;
  /** Timeout for proof generation in milliseconds. Default: 60000 (1 min) */
  proofGenerationTimeoutMs: number;
  /** Retry policy for failed proof generation/submission */
  retryPolicy: RetryPolicy;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Event callbacks for proof pipeline lifecycle events.
 */
export interface ProofPipelineEvents {
  /** Called when a job is queued */
  onProofQueued?: (job: ProofGenerationJob) => void;
  /** Called when proof generation starts */
  onProofGenerating?: (job: ProofGenerationJob) => void;
  /** Called when proof is generated successfully */
  onProofGenerated?: (job: ProofGenerationJob) => void;
  /** Called when proof submission starts */
  onProofSubmitting?: (job: ProofGenerationJob) => void;
  /** Called when proof is confirmed on-chain */
  onProofConfirmed?: (job: ProofGenerationJob) => void;
  /** Called when a job fails */
  onProofFailed?: (job: ProofGenerationJob, error: Error) => void;
}

/**
 * Proof generator interface for extensibility.
 * Allows plugging in different proof generation backends.
 */
export interface ProofGenerator {
  /** Generate proof for public task */
  generatePublicProof(
    task: OnChainTask,
    result: TaskExecutionResult,
  ): Promise<Uint8Array>;
  /** Generate proof for private (ZK) task */
  generatePrivateProof(
    task: OnChainTask,
    result: PrivateTaskExecutionResult,
  ): Promise<Uint8Array>;
}

/**
 * Minimal dependency graph interface for ancestor checking.
 * Compatible with full DependencyGraph implementation.
 */
export interface DependencyGraphLike {
  /** Get unconfirmed ancestor task IDs for a given task */
  getUnconfirmedAncestors(taskId: Uint8Array): Array<{ taskId: Uint8Array }>;
  /** Check if a task is confirmed in the graph */
  isConfirmed(taskId: Uint8Array): boolean;
}

/**
 * Pipeline statistics snapshot.
 */
export interface ProofPipelineStats {
  /** Number of jobs in queue */
  queued: number;
  /** Number of jobs generating proofs */
  generating: number;
  /** Number of jobs awaiting submission (proof generated, waiting for ancestors) */
  awaitingSubmission: number;
  /** Number of confirmed jobs */
  confirmed: number;
  /** Number of failed jobs */
  failed: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: ProofPipelineConfig = {
  maxConcurrentProofs: 4,
  proofGenerationTimeoutMs: 60_000,
  retryPolicy: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    jitter: true,
  },
};

// ============================================================================
// ProofPipeline Class
// ============================================================================

/**
 * Manages async proof generation and submission pipeline.
 *
 * The pipeline supports:
 * - Concurrent proof generation with configurable limits
 * - Dependency-aware submission ordering (ancestors must be confirmed first)
 * - Job status tracking and events
 * - Graceful shutdown with in-flight job completion
 * - Retry logic for transient failures
 *
 * @example
 * ```typescript
 * const pipeline = new ProofPipeline(config, events, operations);
 *
 * // Queue a proof generation job
 * const job = pipeline.enqueue(taskPda, taskId, result);
 *
 * // Wait for confirmation
 * const confirmedJob = await pipeline.waitForConfirmation(taskPda);
 * ```
 */
export class ProofPipeline {
  private readonly config: ProofPipelineConfig;
  private readonly events: ProofPipelineEvents;
  private readonly operations: TaskOperations;
  private readonly logger: Logger;
  private readonly proofGenerator?: ProofGenerator;

  /** Queue of jobs waiting to start generation */
  private readonly queue: Map<string, ProofGenerationJob> = new Map();
  /** Jobs currently generating proofs */
  private readonly generating: Map<string, ProofGenerationJob> = new Map();
  /** Jobs with generated proofs awaiting submission */
  private readonly awaitingSubmission: Map<string, ProofGenerationJob> = new Map();
  /** Completed (confirmed) jobs */
  private readonly confirmed: Map<string, ProofGenerationJob> = new Map();
  /** Failed jobs */
  private readonly failed: Map<string, ProofGenerationJob> = new Map();

  /** Map from taskPda base58 to job for quick lookup */
  private readonly jobIndex: Map<string, ProofGenerationJob> = new Map();

  /** Promise resolvers for waitForConfirmation */
  private readonly waiters: Map<string, Array<{
    resolve: (job: ProofGenerationJob) => void;
    reject: (error: Error) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  }>> = new Map();

  /** Counter for generating unique job IDs */
  private jobCounter = 0;

  /** Whether the pipeline is shutting down */
  private isShuttingDown = false;

  /** Pending generation promises for tracking in-flight work */
  private readonly pendingGenerations: Set<Promise<void>> = new Set();

  constructor(
    config: Partial<ProofPipelineConfig>,
    events: ProofPipelineEvents,
    operations: TaskOperations,
    proofGenerator?: ProofGenerator,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events;
    this.operations = operations;
    this.proofGenerator = proofGenerator;
    this.logger = config.logger ?? silentLogger;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Queue a proof generation job.
   *
   * @param taskPda - Task account PDA
   * @param taskId - Task ID (32 bytes)
   * @param result - Execution result to generate proof from
   * @returns The created job
   */
  enqueue(
    taskPda: PublicKey,
    taskId: Uint8Array,
    result: TaskExecutionResult | PrivateTaskExecutionResult,
  ): ProofGenerationJob {
    if (this.isShuttingDown) {
      throw new Error('Pipeline is shutting down, cannot enqueue new jobs');
    }

    const pdaKey = taskPda.toBase58();

    // Check for duplicate
    if (this.jobIndex.has(pdaKey)) {
      throw new Error(`Job already exists for task ${pdaKey}`);
    }

    const job: ProofGenerationJob = {
      id: `proof-${++this.jobCounter}-${Date.now()}`,
      taskPda,
      taskId: new Uint8Array(taskId),
      executionResult: result,
      status: 'queued',
      createdAt: Date.now(),
      retryCount: 0,
      isPrivate: isPrivateExecutionResult(result),
    };

    this.queue.set(job.id, job);
    this.jobIndex.set(pdaKey, job);

    this.logger.debug(`Proof job queued: ${job.id} for task ${pdaKey}`);
    this.events.onProofQueued?.(job);

    // Try to start generation if we have capacity
    this.processQueue();

    return job;
  }

  /**
   * Get a job by task PDA.
   *
   * @param taskPda - Task account PDA
   * @returns The job or undefined if not found
   */
  getJob(taskPda: PublicKey): ProofGenerationJob | undefined {
    return this.jobIndex.get(taskPda.toBase58());
  }

  /**
   * Wait for a proof to be confirmed on-chain.
   *
   * @param taskPda - Task account PDA
   * @param timeoutMs - Timeout in milliseconds (default: no timeout)
   * @returns Promise resolving to the confirmed job
   * @throws Error if job not found, fails, or times out
   */
  waitForConfirmation(
    taskPda: PublicKey,
    timeoutMs?: number,
  ): Promise<ProofGenerationJob> {
    const pdaKey = taskPda.toBase58();
    const job = this.jobIndex.get(pdaKey);

    if (!job) {
      return Promise.reject(new Error(`No job found for task ${pdaKey}`));
    }

    // Already confirmed
    if (job.status === 'confirmed') {
      return Promise.resolve(job);
    }

    // Already failed
    if (job.status === 'failed') {
      return Promise.reject(job.error ?? new Error('Job failed'));
    }

    // Create a waiter
    return new Promise((resolve, reject) => {
      const waiter: {
        resolve: (job: ProofGenerationJob) => void;
        reject: (error: Error) => void;
        timeoutId?: ReturnType<typeof setTimeout>;
      } = { resolve, reject };

      // Set up timeout if specified
      if (timeoutMs !== undefined && timeoutMs > 0) {
        waiter.timeoutId = setTimeout(() => {
          this.removeWaiter(pdaKey, waiter);
          reject(new Error(`Timeout waiting for proof confirmation of ${pdaKey}`));
        }, timeoutMs);
      }

      // Add to waiters list
      if (!this.waiters.has(pdaKey)) {
        this.waiters.set(pdaKey, []);
      }
      this.waiters.get(pdaKey)!.push(waiter);
    });
  }

  /**
   * Check if all ancestor proofs are confirmed.
   *
   * @param taskPda - Task account PDA
   * @param graph - Dependency graph to check ancestors
   * @returns True if all ancestors are confirmed
   */
  areAncestorsConfirmed(taskPda: PublicKey, graph: DependencyGraphLike): boolean {
    const job = this.jobIndex.get(taskPda.toBase58());
    if (!job) {
      return false;
    }

    const unconfirmedAncestors = graph.getUnconfirmedAncestors(job.taskId);
    return unconfirmedAncestors.length === 0;
  }

  /**
   * Submit a generated proof when ancestors are confirmed.
   *
   * This method checks if all ancestors are confirmed before submitting.
   * If ancestors are not confirmed, the job remains in awaitingSubmission state.
   *
   * @param job - The proof generation job
   * @param graph - Dependency graph for ancestor checking
   * @throws Error if job is not in the correct state
   */
  async submitWhenReady(
    job: ProofGenerationJob,
    graph: DependencyGraphLike,
  ): Promise<void> {
    if (job.status !== 'generated') {
      throw new Error(`Cannot submit job in status: ${job.status}`);
    }

    if (!job.proofBytes) {
      throw new Error('Job has no proof bytes');
    }

    // Check if ancestors are confirmed
    if (!this.areAncestorsConfirmed(job.taskPda, graph)) {
      this.logger.debug(
        `Ancestors not confirmed for ${job.taskPda.toBase58()}, deferring submission`,
      );
      return;
    }

    // Submit the proof
    await this.submitProof(job);
  }

  /**
   * Cancel a queued or generating job.
   *
   * @param taskPda - Task account PDA
   * @returns True if the job was cancelled
   */
  cancel(taskPda: PublicKey): boolean {
    const pdaKey = taskPda.toBase58();
    const job = this.jobIndex.get(pdaKey);

    if (!job) {
      return false;
    }

    // Can only cancel queued or generating jobs
    if (job.status !== 'queued' && job.status !== 'generating') {
      return false;
    }

    // Remove from appropriate map
    if (job.status === 'queued') {
      this.queue.delete(job.id);
    } else {
      this.generating.delete(job.id);
    }

    // Mark as failed
    job.status = 'failed';
    job.error = new Error('Job cancelled');
    job.completedAt = Date.now();

    this.failed.set(job.id, job);
    this.notifyWaiters(pdaKey, job);

    this.logger.debug(`Proof job cancelled: ${job.id}`);
    this.events.onProofFailed?.(job, job.error);

    return true;
  }

  /**
   * Get pipeline statistics.
   *
   * @returns Current pipeline stats
   */
  getStats(): ProofPipelineStats {
    return {
      queued: this.queue.size,
      generating: this.generating.size,
      awaitingSubmission: this.awaitingSubmission.size,
      confirmed: this.confirmed.size,
      failed: this.failed.size,
    };
  }

  /**
   * Graceful shutdown - wait for in-flight proofs to complete.
   *
   * @returns Promise that resolves when all in-flight work is done
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.info('Proof pipeline shutting down...');

    // Wait for all pending generations to complete
    if (this.pendingGenerations.size > 0) {
      this.logger.info(
        `Waiting for ${this.pendingGenerations.size} in-flight proof generations`,
      );
      await Promise.allSettled(this.pendingGenerations);
    }

    // Clear waiters with error
    for (const [_pdaKey, waiters] of this.waiters) {
      for (const waiter of waiters) {
        if (waiter.timeoutId) {
          clearTimeout(waiter.timeoutId);
        }
        waiter.reject(new Error('Pipeline shutdown'));
      }
    }
    this.waiters.clear();

    this.logger.info('Proof pipeline shutdown complete');
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  /**
   * Process the queue, starting new generation jobs up to the concurrency limit.
   */
  private processQueue(): void {
    while (
      this.generating.size < this.config.maxConcurrentProofs &&
      this.queue.size > 0 &&
      !this.isShuttingDown
    ) {
      // Get next job from queue (FIFO)
      const [jobId, job] = this.queue.entries().next().value as [string, ProofGenerationJob];
      this.queue.delete(jobId);

      // Start generation
      this.startGeneration(job);
    }
  }

  /**
   * Start proof generation for a job.
   */
  private startGeneration(job: ProofGenerationJob): void {
    job.status = 'generating';
    job.startedAt = Date.now();
    this.generating.set(job.id, job);

    this.logger.debug(`Starting proof generation: ${job.id}`);
    this.events.onProofGenerating?.(job);

    // Create the generation promise
    const generationPromise = this.generateProof(job)
      .then(() => {
        this.pendingGenerations.delete(generationPromise);
        this.processQueue();
      })
      .catch(() => {
        this.pendingGenerations.delete(generationPromise);
        this.processQueue();
      });

    this.pendingGenerations.add(generationPromise);
  }

  /**
   * Generate proof for a job.
   */
  private async generateProof(job: ProofGenerationJob): Promise<void> {
    try {
      let proofBytes: Uint8Array;

      if (this.proofGenerator) {
        // Fetch the task for the proof generator
        const task = await this.operations.fetchTask(job.taskPda);
        if (!task) {
          throw new Error(`Task not found: ${job.taskPda.toBase58()}`);
        }

        // Use the pluggable proof generator
        if (job.isPrivate) {
          proofBytes = await this.proofGenerator.generatePrivateProof(
            task,
            job.executionResult as PrivateTaskExecutionResult,
          );
        } else {
          proofBytes = await this.proofGenerator.generatePublicProof(
            task,
            job.executionResult as TaskExecutionResult,
          );
        }
      } else {
        // Default: use the proof from the execution result (for private tasks)
        // or a placeholder for public tasks (real proof generation would happen here)
        if (job.isPrivate) {
          const privateResult = job.executionResult as PrivateTaskExecutionResult;
          proofBytes = privateResult.sealBytes;
        } else {
          // For public tasks, the "proof" is just the proof hash
          const publicResult = job.executionResult as TaskExecutionResult;
          proofBytes = publicResult.proofHash;
        }
      }

      // Update job state
      this.generating.delete(job.id);
      job.status = 'generated';
      job.proofBytes = proofBytes;
      this.awaitingSubmission.set(job.id, job);

      this.logger.debug(`Proof generated: ${job.id}`);
      this.events.onProofGenerated?.(job);

      // Auto-submit the proof (no dependency graph checking in simple mode)
      await this.submitProof(job);
    } catch (err) {
      this.handleGenerationError(job, err);
    }
  }

  /**
   * Handle proof generation error with retry logic.
   */
  private handleGenerationError(job: ProofGenerationJob, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));

    job.retryCount++;

    if (job.retryCount < this.config.retryPolicy.maxAttempts) {
      // Retry with backoff
      const delay = this.calculateRetryDelay(job.retryCount);
      this.logger.warn(
        `Proof generation failed for ${job.id}, retrying in ${delay}ms (attempt ${job.retryCount}/${this.config.retryPolicy.maxAttempts})`,
      );

      setTimeout(() => {
        if (!this.isShuttingDown) {
          this.generating.delete(job.id);
          job.status = 'queued';
          this.queue.set(job.id, job);
          this.processQueue();
        }
      }, delay);
    } else {
      // Max retries exceeded, mark as failed
      this.generating.delete(job.id);
      job.status = 'failed';
      job.error = error;
      job.completedAt = Date.now();
      this.failed.set(job.id, job);

      const pdaKey = job.taskPda.toBase58();
      this.notifyWaiters(pdaKey, job);

      this.logger.error(`Proof generation failed for ${job.id}: ${error.message}`);
      this.events.onProofFailed?.(job, error);
    }
  }

  /**
   * Submit a proof to the chain.
   */
  private async submitProof(job: ProofGenerationJob): Promise<void> {
    job.status = 'submitting';
    this.logger.debug(`Submitting proof: ${job.id}`);
    this.events.onProofSubmitting?.(job);

    try {
      // Fetch the task
      const task = await this.operations.fetchTask(job.taskPda);
      if (!task) {
        throw new Error(`Task not found: ${job.taskPda.toBase58()}`);
      }

      let result;
      if (job.isPrivate) {
        const privateResult = job.executionResult as PrivateTaskExecutionResult;
        const sealBytes = job.proofBytes ?? privateResult.sealBytes;
        result = await this.operations.completeTaskPrivate(
          job.taskPda,
          task,
          sealBytes,
          privateResult.journal,
          privateResult.imageId,
          privateResult.bindingValue,
          privateResult.nullifierSeed,
        );
      } else {
        const publicResult = job.executionResult as TaskExecutionResult;
        result = await this.operations.completeTask(
          job.taskPda,
          task,
          publicResult.proofHash,
          publicResult.resultData ?? null,
        );
      }

      // Mark as confirmed
      this.awaitingSubmission.delete(job.id);
      job.status = 'confirmed';
      job.transactionSignature = result.transactionSignature;
      job.completedAt = Date.now();
      this.confirmed.set(job.id, job);

      const pdaKey = job.taskPda.toBase58();
      this.notifyWaiters(pdaKey, job);

      this.logger.info(`Proof confirmed: ${job.id} (${result.transactionSignature})`);
      this.events.onProofConfirmed?.(job);
    } catch (err) {
      this.handleSubmissionError(job, err);
    }
  }

  /**
   * Handle proof submission error with retry logic.
   */
  private handleSubmissionError(job: ProofGenerationJob, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));

    job.retryCount++;

    if (job.retryCount < this.config.retryPolicy.maxAttempts) {
      // Retry with backoff
      const delay = this.calculateRetryDelay(job.retryCount);
      this.logger.warn(
        `Proof submission failed for ${job.id}, retrying in ${delay}ms (attempt ${job.retryCount}/${this.config.retryPolicy.maxAttempts})`,
      );

      setTimeout(() => {
        if (!this.isShuttingDown) {
          job.status = 'generated';
          this.submitProof(job);
        }
      }, delay);
    } else {
      // Max retries exceeded, mark as failed
      this.awaitingSubmission.delete(job.id);
      job.status = 'failed';
      job.error = error;
      job.completedAt = Date.now();
      this.failed.set(job.id, job);

      const pdaKey = job.taskPda.toBase58();
      this.notifyWaiters(pdaKey, job);

      this.logger.error(`Proof submission failed for ${job.id}: ${error.message}`);
      this.events.onProofFailed?.(job, error);
    }
  }

  /**
   * Calculate retry delay with exponential backoff and optional jitter.
   */
  private calculateRetryDelay(attempt: number): number {
    const { baseDelayMs, maxDelayMs, jitter } = this.config.retryPolicy;
    const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);

    if (jitter) {
      // Full jitter: random value between 0 and exponentialDelay
      return Math.floor(Math.random() * exponentialDelay);
    }

    return exponentialDelay;
  }

  /**
   * Notify waiters when a job completes (confirmed or failed).
   */
  private notifyWaiters(pdaKey: string, job: ProofGenerationJob): void {
    const waiters = this.waiters.get(pdaKey);
    if (!waiters) return;

    for (const waiter of waiters) {
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
      }

      if (job.status === 'confirmed') {
        waiter.resolve(job);
      } else if (job.status === 'failed') {
        waiter.reject(job.error ?? new Error('Job failed'));
      }
    }

    this.waiters.delete(pdaKey);
  }

  /**
   * Remove a specific waiter.
   */
  private removeWaiter(
    pdaKey: string,
    waiter: { resolve: (job: ProofGenerationJob) => void; reject: (error: Error) => void },
  ): void {
    const waiters = this.waiters.get(pdaKey);
    if (!waiters) return;

    const index = waiters.indexOf(waiter as typeof waiters[0]);
    if (index >= 0) {
      waiters.splice(index, 1);
    }

    if (waiters.length === 0) {
      this.waiters.delete(pdaKey);
    }
  }
}

// ============================================================================
// Default Proof Generator
// ============================================================================

/**
 * Default proof generator that uses execution results directly.
 * For public tasks, uses the proof hash. For private tasks, uses seal bytes.
 * Real implementations would generate actual ZK proofs.
 */
export class DefaultProofGenerator implements ProofGenerator {
  async generatePublicProof(
    _task: OnChainTask,
    result: TaskExecutionResult,
  ): Promise<Uint8Array> {
    // For public tasks, the "proof" is the proof hash
    return result.proofHash;
  }

  async generatePrivateProof(
    _task: OnChainTask,
    result: PrivateTaskExecutionResult,
  ): Promise<Uint8Array> {
    // For private tasks, use the pre-generated router seal bytes
    return result.sealBytes;
  }
}
