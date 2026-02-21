/**
 * ProofDeferralManager - Proof lifecycle management with ancestor-aware submission
 *
 * Extends ProofPipeline with the critical safety invariant: proofs are only
 * submitted when ALL ancestors are confirmed. Manages the complete lifecycle
 * of deferred proofs with tracking, timeout handling, and cascade failure support.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type {
  TaskExecutionResult,
  PrivateTaskExecutionResult,
  RetryPolicy,
} from "./types.js";
import type { CommitmentLedger } from "./commitment-ledger.js";
import type { DependencyGraph } from "./dependency-graph.js";
import type { ProofPipeline, ProofGenerationJob } from "./proof-pipeline.js";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Status of a deferred proof in the lifecycle.
 */
export type DeferredProofStatus =
  | "queued" // Queued for generation
  | "generating" // Proof generation in progress
  | "generated" // Proof ready, checking ancestors
  | "awaiting_ancestors" // Blocked waiting for ancestor confirmations
  | "submitting" // Proof submission in progress
  | "confirmed" // On-chain confirmation received
  | "failed" // Generation or submission failed
  | "timed_out" // Timed out waiting for ancestors
  | "cancelled"; // Cancelled due to ancestor failure

/**
 * A deferred proof tracking the full lifecycle with ancestor awareness.
 */
export interface DeferredProof {
  /** Task PDA address */
  readonly taskPda: PublicKey;
  /** Task ID (32 bytes) */
  readonly taskId: Uint8Array;
  /** Current status */
  status: DeferredProofStatus;
  /** Timestamp when queued (ms) */
  readonly queuedAt: number;
  /** When proof generation started (ms) */
  generationStartedAt?: number;
  /** When proof generation completed (ms) */
  generationCompletedAt?: number;
  /** When submission was attempted (ms) */
  submissionAttemptedAt?: number;
  /** When confirmed on-chain (ms) */
  confirmedAt?: number;
  /** When failed (ms) */
  failedAt?: number;
  /** Ancestors this proof is waiting for (PDAs) */
  pendingAncestors: PublicKey[];
  /** Number of retry attempts */
  retryCount: number;
  /** Error if failed */
  error?: Error;
  /** Generated proof bytes */
  proofBytes?: Uint8Array;
  /** Transaction signature if submitted */
  transactionSignature?: string;
  /** Execution result for proof generation */
  readonly executionResult: TaskExecutionResult | PrivateTaskExecutionResult;
}

/**
 * Configuration for the ProofDeferralManager.
 */
export interface ProofDeferralConfig {
  /** Maximum concurrent proof generation jobs. Default: 4 */
  maxConcurrentGenerations: number;
  /** Maximum concurrent proof submissions. Default: 2 */
  maxConcurrentSubmissions: number;
  /** Timeout for proof generation in milliseconds. Default: 60000 (1 min) */
  generationTimeoutMs: number;
  /** Timeout for proof submission in milliseconds. Default: 30000 (30 sec) */
  submissionTimeoutMs: number;
  /** Max time to wait for ancestor confirmation before voiding (ms). Default: 300000 (5 min) */
  ancestorTimeoutMs: number;
  /** Retry policy for transient failures */
  retryPolicy: RetryPolicy;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Event callbacks for proof deferral lifecycle events.
 */
export interface ProofDeferralEvents {
  /** Called when a proof is queued */
  onProofQueued?: (taskPda: PublicKey) => void;
  /** Called when proof generation starts */
  onProofGenerating?: (taskPda: PublicKey) => void;
  /** Called when proof is generated successfully */
  onProofGenerated?: (taskPda: PublicKey, proofSize: number) => void;
  /** Called when proof is awaiting ancestor confirmation */
  onProofAwaitingAncestors?: (
    taskPda: PublicKey,
    ancestorCount: number,
  ) => void;
  /** Called when proof submission starts */
  onProofSubmitting?: (taskPda: PublicKey) => void;
  /** Called when proof is confirmed on-chain */
  onProofConfirmed?: (taskPda: PublicKey, signature: string) => void;
  /** Called when a proof fails */
  onProofFailed?: (taskPda: PublicKey, error: Error, stage: string) => void;
  /** Called when a proof times out */
  onProofTimedOut?: (taskPda: PublicKey, stage: string) => void;
  /** Called when a proof is cancelled due to ancestor failure */
  onProofCancelled?: (taskPda: PublicKey, ancestorPda: PublicKey) => void;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: ProofDeferralConfig = {
  maxConcurrentGenerations: 4,
  maxConcurrentSubmissions: 2,
  generationTimeoutMs: 60_000,
  submissionTimeoutMs: 30_000,
  ancestorTimeoutMs: 300_000, // 5 minutes
  retryPolicy: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    jitter: true,
  },
};

// ============================================================================
// ProofDeferralManager Class
// ============================================================================

/**
 * Manages proof lifecycle with ancestor-aware submission gating.
 *
 * CRITICAL INVARIANT: Proofs are only submitted when ALL ancestors are confirmed.
 * This prevents invalid state transitions where a child proof is confirmed before
 * its parent, which would violate the dependency ordering on-chain.
 *
 * The manager:
 * - Queues proofs for generation with concurrency limits
 * - Tracks ancestor dependencies via DependencyGraph
 * - Blocks submission until all ancestors are confirmed
 * - Handles ancestor confirmation to unblock waiting proofs
 * - Handles ancestor failure with cascade cancellation
 * - Provides timeout handling for stuck proofs
 *
 * @example
 * ```typescript
 * const manager = new ProofDeferralManager(
 *   config,
 *   events,
 *   commitmentLedger,
 *   dependencyGraph,
 *   proofPipeline
 * );
 *
 * // Queue a proof
 * manager.queueProof(taskPda, result);
 *
 * // When an ancestor confirms, check if blocked proofs can proceed
 * await manager.onAncestorConfirmed(ancestorPda);
 *
 * // Get status of blocked proofs
 * const blocked = manager.getBlockedProofs();
 * ```
 */
export class ProofDeferralManager {
  private readonly config: ProofDeferralConfig;
  private readonly events: ProofDeferralEvents;
  private readonly commitmentLedger: CommitmentLedger;
  private readonly dependencyGraph: DependencyGraph;
  private readonly proofPipeline: ProofPipeline;
  private readonly logger: Logger;

  /** Map from task PDA (base58) to DeferredProof */
  private readonly deferredProofs: Map<string, DeferredProof> = new Map();

  /** Set of proofs currently awaiting ancestors (PDA base58) */
  private readonly awaitingAncestors: Set<string> = new Set();

  /** Map from ancestor PDA (base58) to set of waiting proof PDAs (base58) */
  private readonly ancestorWaiters: Map<string, Set<string>> = new Map();

  /** Whether the manager is shutting down */
  private isShuttingDown = false;

  /** Currently active submissions */
  private activeSubmissions = 0;

  constructor(
    config: Partial<ProofDeferralConfig>,
    events: ProofDeferralEvents,
    commitmentLedger: CommitmentLedger,
    dependencyGraph: DependencyGraph,
    proofPipeline: ProofPipeline,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events;
    this.commitmentLedger = commitmentLedger;
    this.dependencyGraph = dependencyGraph;
    this.proofPipeline = proofPipeline;
    this.logger = config.logger ?? silentLogger;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Queue a proof for generation.
   *
   * @param taskPda - Task account PDA
   * @param result - Execution result to generate proof from
   * @throws Error if proof already exists for this task
   */
  queueProof(
    taskPda: PublicKey,
    result: TaskExecutionResult | PrivateTaskExecutionResult,
  ): void {
    if (this.isShuttingDown) {
      throw new Error("Manager is shutting down, cannot queue new proofs");
    }

    const pdaKey = taskPda.toBase58();

    if (this.deferredProofs.has(pdaKey)) {
      throw new Error(`Proof already queued for task ${pdaKey}`);
    }

    // Get task node from dependency graph
    const taskNode = this.dependencyGraph.getNode(taskPda);
    const taskId = taskNode?.taskId ?? new Uint8Array(32);

    // Find unconfirmed ancestors
    const pendingAncestors = this.getUnconfirmedAncestors(taskPda);

    const deferredProof: DeferredProof = {
      taskPda,
      taskId,
      status: "queued",
      queuedAt: Date.now(),
      pendingAncestors,
      retryCount: 0,
      executionResult: result,
    };

    this.deferredProofs.set(pdaKey, deferredProof);

    this.logger.debug(
      `Proof queued for task ${pdaKey}, ${pendingAncestors.length} pending ancestors`,
    );
    this.events.onProofQueued?.(taskPda);

    // Start proof generation via the pipeline
    this.startProofGeneration(deferredProof);
  }

  /**
   * Attempt to submit a proof.
   *
   * INVARIANT: Only submits if ALL ancestors are confirmed.
   *
   * @param taskPda - Task account PDA
   * @returns True if submission started, false if blocked by ancestors
   */
  async trySubmit(taskPda: PublicKey): Promise<boolean> {
    const pdaKey = taskPda.toBase58();
    const proof = this.deferredProofs.get(pdaKey);

    if (!proof) {
      this.logger.warn(`No proof found for task ${pdaKey}`);
      return false;
    }

    // Can only submit if proof is generated
    if (proof.status !== "generated" && proof.status !== "awaiting_ancestors") {
      this.logger.debug(
        `Proof ${pdaKey} not ready for submission (status: ${proof.status})`,
      );
      return false;
    }

    // CRITICAL INVARIANT: Check that ALL ancestors are confirmed
    if (!this.enforceSubmissionOrdering(taskPda)) {
      // Move to awaiting_ancestors state
      proof.status = "awaiting_ancestors";
      this.awaitingAncestors.add(pdaKey);

      // Register as waiter for each pending ancestor
      for (const ancestorPda of proof.pendingAncestors) {
        const ancestorKey = ancestorPda.toBase58();
        if (!this.ancestorWaiters.has(ancestorKey)) {
          this.ancestorWaiters.set(ancestorKey, new Set());
        }
        this.ancestorWaiters.get(ancestorKey)!.add(pdaKey);
      }

      this.logger.debug(
        `Proof ${pdaKey} blocked waiting for ${proof.pendingAncestors.length} ancestors`,
      );
      this.events.onProofAwaitingAncestors?.(
        taskPda,
        proof.pendingAncestors.length,
      );

      return false;
    }

    // All ancestors confirmed - proceed with submission
    await this.submitProof(proof);
    return true;
  }

  /**
   * Cancel a pending proof (for rollback or manual cancellation).
   *
   * @param taskPda - Task account PDA
   * @returns True if proof was cancelled
   */
  cancel(taskPda: PublicKey): boolean {
    const pdaKey = taskPda.toBase58();
    const proof = this.deferredProofs.get(pdaKey);

    if (!proof) {
      return false;
    }

    // Can only cancel if not already confirmed or failed
    if (proof.status === "confirmed" || proof.status === "failed") {
      return false;
    }

    // Cancel in pipeline if generating
    if (proof.status === "queued" || proof.status === "generating") {
      this.proofPipeline.cancel(taskPda);
    }

    // Remove from awaiting ancestors
    if (proof.status === "awaiting_ancestors") {
      this.awaitingAncestors.delete(pdaKey);
      this.removeFromAncestorWaiters(pdaKey, proof.pendingAncestors);
    }

    // Update status
    proof.status = "cancelled";
    proof.failedAt = Date.now();
    proof.error = new Error("Cancelled");

    this.logger.debug(`Proof ${pdaKey} cancelled`);
    return true;
  }

  /**
   * Handle ancestor confirmation - unblocks waiting proofs.
   *
   * When an ancestor is confirmed, all proofs waiting on that ancestor
   * are updated and may become ready for submission.
   *
   * @param ancestorPda - Ancestor task PDA that was confirmed
   */
  async onAncestorConfirmed(ancestorPda: PublicKey): Promise<void> {
    const ancestorKey = ancestorPda.toBase58();

    this.logger.debug(`Ancestor confirmed: ${ancestorKey}`);

    // Get all proofs waiting on this ancestor
    const waiters = this.ancestorWaiters.get(ancestorKey);
    if (!waiters || waiters.size === 0) {
      return;
    }

    // Create a copy since we'll be modifying during iteration
    const waitersList = Array.from(waiters);
    this.ancestorWaiters.delete(ancestorKey);

    // Update each waiting proof
    for (const waiterKey of waitersList) {
      const proof = this.deferredProofs.get(waiterKey);
      if (!proof || proof.status !== "awaiting_ancestors") {
        continue;
      }

      // Remove this ancestor from pending list
      proof.pendingAncestors = proof.pendingAncestors.filter(
        (pda) => pda.toBase58() !== ancestorKey,
      );

      // Check if all ancestors are now confirmed
      if (proof.pendingAncestors.length === 0) {
        this.logger.debug(
          `All ancestors confirmed for proof ${waiterKey}, submitting`,
        );
        this.awaitingAncestors.delete(waiterKey);

        // Move back to generated state and attempt submission
        proof.status = "generated";
        await this.trySubmit(proof.taskPda);
      } else {
        this.logger.debug(
          `Proof ${waiterKey} still waiting for ${proof.pendingAncestors.length} ancestors`,
        );
      }
    }
  }

  /**
   * Handle ancestor failure - cancels all dependent proofs.
   *
   * When an ancestor fails, all proofs that depend on it (directly or
   * transitively) must be cancelled since they can never be submitted.
   *
   * @param ancestorPda - Ancestor task PDA that failed
   */
  onAncestorFailed(ancestorPda: PublicKey): void {
    const ancestorKey = ancestorPda.toBase58();

    this.logger.debug(`Ancestor failed: ${ancestorKey}`);

    // Get all descendants from dependency graph
    const descendants = this.dependencyGraph.getDescendants(ancestorPda);

    // Cancel all descendant proofs
    for (const descendant of descendants) {
      const descKey = descendant.taskPda.toBase58();
      const proof = this.deferredProofs.get(descKey);

      if (!proof) {
        continue;
      }

      // Skip if already terminal state
      if (
        proof.status === "confirmed" ||
        proof.status === "failed" ||
        proof.status === "cancelled"
      ) {
        continue;
      }

      // Clean up tracking before changing status
      const wasAwaiting = proof.status === "awaiting_ancestors";
      if (wasAwaiting) {
        this.awaitingAncestors.delete(descKey);
        this.removeFromAncestorWaiters(descKey, proof.pendingAncestors);
      }

      // Cancel the proof
      proof.status = "cancelled";
      proof.failedAt = Date.now();
      proof.error = new Error(`Ancestor ${ancestorKey} failed`);

      this.logger.debug(`Cancelled proof ${descKey} due to ancestor failure`);
      this.events.onProofCancelled?.(proof.taskPda, ancestorPda);
    }

    // Also cancel any proofs directly waiting on this ancestor
    const waiters = this.ancestorWaiters.get(ancestorKey);
    if (waiters) {
      for (const waiterKey of waiters) {
        const proof = this.deferredProofs.get(waiterKey);
        if (proof && proof.status === "awaiting_ancestors") {
          proof.status = "cancelled";
          proof.failedAt = Date.now();
          proof.error = new Error(`Ancestor ${ancestorKey} failed`);

          this.awaitingAncestors.delete(waiterKey);
          this.logger.debug(
            `Cancelled proof ${waiterKey} due to ancestor failure`,
          );
          this.events.onProofCancelled?.(proof.taskPda, ancestorPda);
        }
      }
      this.ancestorWaiters.delete(ancestorKey);
    }
  }

  /**
   * Get the status of a deferred proof.
   *
   * @param taskPda - Task account PDA
   * @returns Deferred proof status or undefined if not found
   */
  getStatus(taskPda: PublicKey): DeferredProof | undefined {
    return this.deferredProofs.get(taskPda.toBase58());
  }

  /**
   * Get all proofs blocked waiting for ancestors.
   *
   * @returns Array of deferred proofs in awaiting_ancestors state
   */
  getBlockedProofs(): DeferredProof[] {
    const blocked: DeferredProof[] = [];

    for (const pdaKey of this.awaitingAncestors) {
      const proof = this.deferredProofs.get(pdaKey);
      if (proof && proof.status === "awaiting_ancestors") {
        blocked.push(proof);
      }
    }

    return blocked;
  }

  /**
   * Force-void proofs that have waited too long for ancestors.
   *
   * @returns Array of proofs that were timed out
   */
  voidTimedOutProofs(): DeferredProof[] {
    const now = Date.now();
    const timedOut: DeferredProof[] = [];

    for (const pdaKey of this.awaitingAncestors) {
      const proof = this.deferredProofs.get(pdaKey);
      if (!proof) {
        continue;
      }

      // Check if proof has been waiting too long
      const waitTime = now - proof.queuedAt;
      if (waitTime > this.config.ancestorTimeoutMs) {
        proof.status = "timed_out";
        proof.failedAt = now;
        proof.error = new Error("Timeout waiting for ancestor confirmation");

        this.awaitingAncestors.delete(pdaKey);
        this.removeFromAncestorWaiters(pdaKey, proof.pendingAncestors);

        timedOut.push(proof);

        this.logger.warn(`Proof ${pdaKey} timed out waiting for ancestors`);
        this.events.onProofTimedOut?.(proof.taskPda, "awaiting_ancestors");
      }
    }

    return timedOut;
  }

  /**
   * Graceful shutdown - wait for in-flight work to complete.
   *
   * @returns Promise that resolves when shutdown is complete
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.info("ProofDeferralManager shutting down...");

    // Wait for the underlying pipeline to shut down
    await this.proofPipeline.shutdown();

    this.logger.info("ProofDeferralManager shutdown complete");
  }

  /**
   * Get statistics about the manager state.
   *
   * @returns Manager statistics
   */
  getStats(): {
    total: number;
    queued: number;
    generating: number;
    generated: number;
    awaitingAncestors: number;
    submitting: number;
    confirmed: number;
    failed: number;
    timedOut: number;
    cancelled: number;
  } {
    const stats = {
      total: 0,
      queued: 0,
      generating: 0,
      generated: 0,
      awaitingAncestors: 0,
      submitting: 0,
      confirmed: 0,
      failed: 0,
      timedOut: 0,
      cancelled: 0,
    };

    for (const proof of this.deferredProofs.values()) {
      stats.total++;
      switch (proof.status) {
        case "queued":
          stats.queued++;
          break;
        case "generating":
          stats.generating++;
          break;
        case "generated":
          stats.generated++;
          break;
        case "awaiting_ancestors":
          stats.awaitingAncestors++;
          break;
        case "submitting":
          stats.submitting++;
          break;
        case "confirmed":
          stats.confirmed++;
          break;
        case "failed":
          stats.failed++;
          break;
        case "timed_out":
          stats.timedOut++;
          break;
        case "cancelled":
          stats.cancelled++;
          break;
      }
    }

    return stats;
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  /**
   * Enforce the submission ordering invariant.
   *
   * CRITICAL: Returns true only if ALL ancestors are confirmed.
   *
   * @param taskPda - Task account PDA
   * @returns True if all ancestors are confirmed, false otherwise
   */
  private enforceSubmissionOrdering(taskPda: PublicKey): boolean {
    const pdaKey = taskPda.toBase58();
    const proof = this.deferredProofs.get(pdaKey);

    if (!proof) {
      return false;
    }

    // Get all ancestors from dependency graph
    const ancestors = this.dependencyGraph.getAncestors(taskPda);

    // Check each ancestor's commitment status
    for (const ancestor of ancestors) {
      const commitment = this.commitmentLedger.getByTask(ancestor.taskPda);

      if (!commitment || commitment.status !== "confirmed") {
        // NOT SAFE TO SUBMIT - ancestor not confirmed

        // Update pending ancestors list
        const ancestorKey = ancestor.taskPda.toBase58();
        const alreadyPending = proof.pendingAncestors.some(
          (pda) => pda.toBase58() === ancestorKey,
        );

        if (!alreadyPending) {
          proof.pendingAncestors.push(ancestor.taskPda);
        }

        this.logger.debug(
          `Submission blocked: ancestor ${ancestorKey} not confirmed (status: ${commitment?.status ?? "not found"})`,
        );
        return false;
      }
    }

    // All ancestors confirmed - safe to submit
    proof.pendingAncestors = [];
    return true;
  }

  /**
   * Get unconfirmed ancestors for a task.
   *
   * @param taskPda - Task account PDA
   * @returns Array of ancestor PDAs that are not yet confirmed
   */
  private getUnconfirmedAncestors(taskPda: PublicKey): PublicKey[] {
    const ancestors = this.dependencyGraph.getAncestors(taskPda);
    const unconfirmed: PublicKey[] = [];

    for (const ancestor of ancestors) {
      const commitment = this.commitmentLedger.getByTask(ancestor.taskPda);
      if (!commitment || commitment.status !== "confirmed") {
        unconfirmed.push(ancestor.taskPda);
      }
    }

    return unconfirmed;
  }

  /**
   * Start proof generation via the pipeline.
   *
   * @param deferredProof - The deferred proof to generate
   */
  private startProofGeneration(deferredProof: DeferredProof): void {
    const pdaKey = deferredProof.taskPda.toBase58();

    // Update status
    deferredProof.status = "generating";
    deferredProof.generationStartedAt = Date.now();

    this.logger.debug(`Starting proof generation for ${pdaKey}`);
    this.events.onProofGenerating?.(deferredProof.taskPda);

    // Enqueue in the proof pipeline
    try {
      const job = this.proofPipeline.enqueue(
        deferredProof.taskPda,
        deferredProof.taskId,
        deferredProof.executionResult,
      );

      // Wait for proof generation to complete
      this.handleProofJobCompletion(deferredProof, job);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleProofGenerationError(deferredProof, error);
    }
  }

  /**
   * Handle proof job completion from the pipeline.
   *
   * @param deferredProof - The deferred proof
   * @param _job - The proof generation job (unused, for future extensions)
   */
  private async handleProofJobCompletion(
    deferredProof: DeferredProof,
    _job: ProofGenerationJob,
  ): Promise<void> {
    const pdaKey = deferredProof.taskPda.toBase58();

    try {
      // Wait for the job to complete
      const completedJob = await this.proofPipeline.waitForConfirmation(
        deferredProof.taskPda,
        this.config.generationTimeoutMs,
      );

      // Job completed - check if it was confirmed via pipeline
      if (completedJob.status === "confirmed") {
        // Pipeline handled submission - update our tracking
        deferredProof.status = "confirmed";
        deferredProof.confirmedAt = Date.now();
        deferredProof.proofBytes = completedJob.proofBytes;
        deferredProof.transactionSignature = completedJob.transactionSignature;

        this.logger.info(
          `Proof confirmed for ${pdaKey} (${deferredProof.transactionSignature})`,
        );
        this.events.onProofConfirmed?.(
          deferredProof.taskPda,
          deferredProof.transactionSignature!,
        );
      }
    } catch (err) {
      // Check if the job generated a proof but hasn't submitted
      const latestJob = this.proofPipeline.getJob(deferredProof.taskPda);

      if (latestJob && latestJob.proofBytes) {
        // Proof was generated - we handle submission
        deferredProof.status = "generated";
        deferredProof.generationCompletedAt = Date.now();
        deferredProof.proofBytes = latestJob.proofBytes;

        this.logger.debug(`Proof generated for ${pdaKey}, checking ancestors`);
        this.events.onProofGenerated?.(
          deferredProof.taskPda,
          deferredProof.proofBytes.length,
        );

        // Attempt submission with ancestor checking
        await this.trySubmit(deferredProof.taskPda);
      } else {
        // Generation failed
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleProofGenerationError(deferredProof, error);
      }
    }
  }

  /**
   * Handle proof generation error.
   *
   * @param deferredProof - The deferred proof
   * @param error - The error that occurred
   */
  private handleProofGenerationError(
    deferredProof: DeferredProof,
    error: Error,
  ): void {
    const pdaKey = deferredProof.taskPda.toBase58();

    deferredProof.retryCount++;

    if (deferredProof.retryCount < this.config.retryPolicy.maxAttempts) {
      // Retry with backoff
      const delay = this.calculateRetryDelay(deferredProof.retryCount);
      this.logger.warn(
        `Proof generation failed for ${pdaKey}, retrying in ${delay}ms (attempt ${deferredProof.retryCount}/${this.config.retryPolicy.maxAttempts})`,
      );

      setTimeout(() => {
        if (!this.isShuttingDown) {
          deferredProof.status = "queued";
          this.startProofGeneration(deferredProof);
        }
      }, delay);
    } else {
      // Max retries exceeded
      deferredProof.status = "failed";
      deferredProof.failedAt = Date.now();
      deferredProof.error = error;

      this.logger.error(
        `Proof generation failed for ${pdaKey}: ${error.message}`,
      );
      this.events.onProofFailed?.(deferredProof.taskPda, error, "generating");
    }
  }

  /**
   * Submit a proof to the chain.
   *
   * @param proof - The deferred proof to submit
   */
  private async submitProof(proof: DeferredProof): Promise<void> {
    const pdaKey = proof.taskPda.toBase58();

    // Check concurrent submission limit
    if (this.activeSubmissions >= this.config.maxConcurrentSubmissions) {
      this.logger.debug(
        `Submission queued for ${pdaKey}, at concurrency limit`,
      );
      return;
    }

    this.activeSubmissions++;
    proof.status = "submitting";
    proof.submissionAttemptedAt = Date.now();

    this.logger.debug(`Submitting proof for ${pdaKey}`);
    this.events.onProofSubmitting?.(proof.taskPda);

    try {
      // The actual submission happens through the pipeline
      // Wait for confirmation with timeout
      const job = await this.proofPipeline.waitForConfirmation(
        proof.taskPda,
        this.config.submissionTimeoutMs,
      );

      if (job.status === "confirmed") {
        proof.status = "confirmed";
        proof.confirmedAt = Date.now();
        proof.transactionSignature = job.transactionSignature;

        this.logger.info(
          `Proof confirmed for ${pdaKey} (${proof.transactionSignature})`,
        );
        this.events.onProofConfirmed?.(
          proof.taskPda,
          proof.transactionSignature!,
        );
      } else {
        throw new Error(`Unexpected job status: ${job.status}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleSubmissionError(proof, error);
    } finally {
      this.activeSubmissions--;
    }
  }

  /**
   * Handle proof submission error.
   *
   * @param proof - The deferred proof
   * @param error - The error that occurred
   */
  private handleSubmissionError(proof: DeferredProof, error: Error): void {
    const pdaKey = proof.taskPda.toBase58();

    proof.retryCount++;

    if (proof.retryCount < this.config.retryPolicy.maxAttempts) {
      // Retry with backoff
      const delay = this.calculateRetryDelay(proof.retryCount);
      this.logger.warn(
        `Proof submission failed for ${pdaKey}, retrying in ${delay}ms (attempt ${proof.retryCount}/${this.config.retryPolicy.maxAttempts})`,
      );

      setTimeout(() => {
        if (!this.isShuttingDown && proof.status !== "cancelled") {
          proof.status = "generated";
          this.submitProof(proof);
        }
      }, delay);
    } else {
      // Max retries exceeded
      proof.status = "failed";
      proof.failedAt = Date.now();
      proof.error = error;

      this.logger.error(
        `Proof submission failed for ${pdaKey}: ${error.message}`,
      );
      this.events.onProofFailed?.(proof.taskPda, error, "submitting");
    }
  }

  /**
   * Calculate retry delay with exponential backoff and optional jitter.
   *
   * @param attempt - Retry attempt number (1-based)
   * @returns Delay in milliseconds
   */
  private calculateRetryDelay(attempt: number): number {
    const { baseDelayMs, maxDelayMs, jitter } = this.config.retryPolicy;
    const exponentialDelay = Math.min(
      baseDelayMs * Math.pow(2, attempt - 1),
      maxDelayMs,
    );

    if (jitter) {
      // Full jitter: cryptographically random value between 0 and exponentialDelay
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      return Math.floor((buf[0] / 0x100000000) * exponentialDelay);
    }

    return exponentialDelay;
  }

  /**
   * Remove a proof from ancestor waiter lists.
   *
   * @param proofKey - Proof PDA (base58)
   * @param ancestors - Ancestor PDAs to remove from
   */
  private removeFromAncestorWaiters(
    proofKey: string,
    ancestors: PublicKey[],
  ): void {
    for (const ancestorPda of ancestors) {
      const ancestorKey = ancestorPda.toBase58();
      const waiters = this.ancestorWaiters.get(ancestorKey);
      if (waiters) {
        waiters.delete(proofKey);
        if (waiters.size === 0) {
          this.ancestorWaiters.delete(ancestorKey);
        }
      }
    }
  }
}
