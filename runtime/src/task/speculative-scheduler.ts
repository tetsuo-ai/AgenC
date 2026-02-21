/**
 * SpeculativeTaskScheduler - Central orchestrator for speculative execution
 *
 * Ties together DependencyGraph, CommitmentLedger, ProofDeferralManager, and
 * RollbackController to enable multi-level speculative execution with safety
 * invariants.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import {
  DependencyGraph,
  DependencyType,
  type TaskNode,
} from "./dependency-graph.js";
import {
  CommitmentLedger,
  type CommitmentLedgerConfig,
  type SpeculativeCommitment,
} from "./commitment-ledger.js";
import {
  ProofDeferralManager,
  type ProofDeferralConfig,
  type DeferredProof,
} from "./proof-deferral.js";
import {
  RollbackController,
  type RollbackConfig,
  type RollbackResult,
  type RollbackReason,
} from "./rollback-controller.js";
import type { ProofPipeline } from "./proof-pipeline.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Configuration for the SpeculativeTaskScheduler.
 */
export interface SpeculativeSchedulerConfig {
  /** Maximum depth of unconfirmed proof ancestors (default: 3) */
  maxSpeculationDepth: number;

  /** Maximum total stake at risk from speculative execution (lamports) */
  maxSpeculativeStake: bigint;

  /** Allow speculative execution of private (ZK) tasks */
  allowPrivateSpeculation: boolean;

  /** Minimum reputation score to trust speculative results (0-1000) */
  minReputationForSpeculation: number;

  /** Time budget: max ms to wait for proof before force-voiding */
  proofTimeoutMs: number;

  /** Strategy for ordering speculative execution */
  schedulingStrategy: "fifo" | "priority" | "reward-weighted";

  /** Only speculate on these dependency types */
  speculatableDependencyTypes: DependencyType[];

  /** Auto-disable speculation if rollback rate exceeds threshold (0-100) */
  maxRollbackRatePercent: number;

  /** Global enable/disable for speculation */
  enableSpeculation: boolean;

  /** CommitmentLedger configuration */
  commitmentLedger: Partial<CommitmentLedgerConfig>;

  /** ProofDeferralManager configuration */
  proofDeferral: Partial<ProofDeferralConfig>;

  /** RollbackController configuration */
  rollback: Partial<RollbackConfig>;

  /** Logger instance */
  logger?: Logger;
}

/**
 * Decision about whether to speculate on a task.
 */
export interface SpeculationDecision {
  /** Whether speculation is allowed */
  allowed: boolean;
  /** Reason if not allowed */
  reason?: SpeculationDenialReason;
}

/**
 * Reasons speculation may be denied.
 */
export type SpeculationDenialReason =
  | "disabled" // Speculation globally disabled
  | "dependency_type_not_speculatable" // Dependency type not in allowed list
  | "depth_limit" // Max speculation depth reached
  | "stake_limit" // Max stake at risk reached
  | "private_speculation_disabled" // Private task speculation not allowed
  | "low_reputation" // Agent reputation too low
  | "rollback_rate_exceeded" // Auto-disabled due to high rollback rate
  | "task_not_found"; // Task not in dependency graph

/**
 * Event callbacks for the speculative scheduler.
 */
export interface SpeculativeSchedulerEvents {
  /** Called when speculation starts for a task */
  onSpeculationStarted?: (taskPda: PublicKey, depth: number) => void;
  /** Called when a speculative result is confirmed */
  onSpeculationConfirmed?: (taskPda: PublicKey) => void;
  /** Called when speculation fails (proof rejected) */
  onSpeculationFailed?: (taskPda: PublicKey, reason: string) => void;
  /** Called when rollback begins */
  onRollbackStarted?: (rootTaskPda: PublicKey, affectedCount: number) => void;
  /** Called when rollback completes */
  onRollbackCompleted?: (result: RollbackResult) => void;
  /** Called when depth limit blocks speculation */
  onDepthLimitReached?: (
    taskPda: PublicKey,
    currentDepth: number,
    maxDepth: number,
  ) => void;
  /** Called when stake limit blocks speculation */
  onStakeLimitReached?: (totalAtRisk: bigint, limit: bigint) => void;
  /** Called when speculation is auto-disabled */
  onSpeculationDisabled?: (reason: string) => void;
  /** Called when speculation is re-enabled */
  onSpeculationEnabled?: () => void;
}

/**
 * Current status of the speculative scheduler.
 */
export interface SpeculativeSchedulerStatus {
  /** Whether the scheduler is running */
  running: boolean;
  /** Whether speculation is currently enabled */
  speculationEnabled: boolean;
  /** Number of active speculative executions */
  activeSpeculations: number;
  /** Maximum depth currently reached */
  maxDepthReached: number;
  /** Configured max depth limit */
  currentMaxDepth: number;
  /** Total stake at risk from speculative executions */
  totalStakeAtRisk: bigint;
  /** Number of proofs pending submission */
  pendingProofs: number;
  /** Number of proofs awaiting ancestor confirmation */
  awaitingAncestors: number;
}

/**
 * Metrics about speculative execution performance.
 */
export interface SpeculationMetrics {
  /** Total tasks executed speculatively */
  speculativeExecutions: number;
  /** Tasks where speculation was correct (proof passed) */
  speculativeHits: number;
  /** Tasks rolled back due to proof failure */
  speculativeMisses: number;
  /** Hit rate percentage (0-100) */
  hitRate: number;
  /** Total compute time saved by speculation (estimated ms) */
  estimatedTimeSaved: number;
  /** Total compute time wasted on rollbacks (ms) */
  timeWastedOnRollbacks: number;
  /** Rollback rate (0-100) for auto-disable check */
  rollbackRate: number;
}

/**
 * Reason for speculative cancellation.
 */
export type CancellationReason =
  | "creator_cancelled"
  | "deadline_expired"
  | "manual"
  | "policy_violation";

/**
 * Result of speculative cancellation.
 */
export interface SpeculativeCancellationResult {
  /** Task that initiated cancellation */
  cancelledTaskPda: PublicKey;
  /** Cancellation reason */
  reason: CancellationReason;
  /** Descendant tasks that were canceled */
  abortedDescendants: PublicKey[];
  /** Deferred proofs canceled by the deferral manager */
  cancelledProofs: number;
  /** Stake released by releasing commitments */
  stakeReleased: bigint;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: SpeculativeSchedulerConfig = {
  maxSpeculationDepth: 3,
  maxSpeculativeStake: 10_000_000_000n, // 10 SOL
  allowPrivateSpeculation: false,
  minReputationForSpeculation: 500,
  proofTimeoutMs: 300_000, // 5 minutes
  schedulingStrategy: "fifo",
  speculatableDependencyTypes: [DependencyType.Data, DependencyType.Order],
  maxRollbackRatePercent: 20,
  enableSpeculation: true,
  commitmentLedger: {},
  proofDeferral: {},
  rollback: {},
};

// ============================================================================
// SpeculativeTaskScheduler Implementation
// ============================================================================

/**
 * Central orchestrator for speculative execution.
 *
 * Coordinates DependencyGraph, CommitmentLedger, ProofDeferralManager, and
 * RollbackController to enable safe multi-level speculation with:
 * - Depth limiting (max unconfirmed ancestors)
 * - Stake limiting (max economic risk)
 * - Auto-disable on high rollback rate
 * - Private task speculation policy
 * - Reputation-based gating
 *
 * @example
 * ```typescript
 * const scheduler = new SpeculativeTaskScheduler(
 *   { maxSpeculationDepth: 3, maxSpeculativeStake: 10_000_000_000n },
 *   events,
 *   dependencyGraph,
 *   proofPipeline
 * );
 *
 * scheduler.start();
 *
 * // Check if task can speculate
 * const decision = scheduler.shouldSpeculate(taskPda);
 * if (decision.allowed) {
 *   // Execute speculatively...
 * }
 *
 * // When proof confirmed
 * scheduler.onProofConfirmed(taskPda);
 *
 * // When proof failed
 * scheduler.onProofFailed(taskPda);
 *
 * scheduler.stop();
 * ```
 */
export class SpeculativeTaskScheduler {
  private readonly config: SpeculativeSchedulerConfig;
  private readonly events: SpeculativeSchedulerEvents;
  private readonly logger: Logger;

  // Core components
  private readonly dependencyGraph: DependencyGraph;
  private readonly commitmentLedger: CommitmentLedger;
  private readonly proofDeferralManager: ProofDeferralManager;
  private readonly rollbackController: RollbackController;

  // State
  private running: boolean = false;
  private speculationEnabled: boolean;

  // Metrics
  private metrics: SpeculationMetrics = {
    speculativeExecutions: 0,
    speculativeHits: 0,
    speculativeMisses: 0,
    hitRate: 0,
    estimatedTimeSaved: 0,
    timeWastedOnRollbacks: 0,
    rollbackRate: 0,
  };

  // Tracking for active speculations
  private activeSpeculations: Map<
    string,
    { startedAt: number; depth: number }
  > = new Map();

  /**
   * Creates a new SpeculativeTaskScheduler instance.
   *
   * @param config - Configuration options
   * @param events - Event callbacks for observability
   * @param dependencyGraph - Pre-existing DependencyGraph instance
   * @param proofPipeline - ProofPipeline for proof generation/submission
   */
  constructor(
    config: Partial<SpeculativeSchedulerConfig>,
    events: SpeculativeSchedulerEvents,
    dependencyGraph: DependencyGraph,
    proofPipeline: ProofPipeline,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events;
    this.logger = config.logger ?? silentLogger;
    this.speculationEnabled = this.config.enableSpeculation;

    // Use provided dependency graph
    this.dependencyGraph = dependencyGraph;

    // Create commitment ledger
    this.commitmentLedger = new CommitmentLedger(this.config.commitmentLedger);

    // Create proof deferral manager with wired events
    this.proofDeferralManager = new ProofDeferralManager(
      {
        ...this.config.proofDeferral,
        ancestorTimeoutMs: this.config.proofTimeoutMs,
        logger: this.logger,
      },
      {
        onProofConfirmed: (taskPda, _sig) => this.handleProofConfirmed(taskPda),
        onProofFailed: (taskPda, error, _stage) =>
          this.handleProofFailed(taskPda, error.message),
        onProofTimedOut: (taskPda, _stage) =>
          this.handleProofFailed(taskPda, "timeout"),
        onProofCancelled: (taskPda, _ancestorPda) =>
          this.handleProofFailed(taskPda, "ancestor_failed"),
      },
      this.commitmentLedger,
      this.dependencyGraph,
      proofPipeline,
    );

    // Create rollback controller with wired events
    this.rollbackController = new RollbackController(
      {
        ...this.config.rollback,
        enableEvents: true,
      },
      this.dependencyGraph,
      this.commitmentLedger,
      {
        onRollbackStarted: (rootTaskPda, affectedCount) => {
          this.events.onRollbackStarted?.(rootTaskPda, affectedCount);
        },
        onRollbackCompleted: (result) => {
          this.updateMetricsOnRollback(result);
          this.events.onRollbackCompleted?.(result);
        },
      },
    );
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Starts the speculative scheduler.
   */
  start(): void {
    if (this.running) {
      this.logger.warn("Scheduler already running");
      return;
    }

    this.running = true;
    this.logger.info("SpeculativeTaskScheduler started");
  }

  /**
   * Stops the scheduler gracefully.
   *
   * Does not accept new speculative executions but allows pending proofs
   * to complete.
   */
  stop(): void {
    if (!this.running) {
      this.logger.warn("Scheduler not running");
      return;
    }

    this.running = false;
    this.logger.info("SpeculativeTaskScheduler stopped");
  }

  // ==========================================================================
  // Speculation Policy
  // ==========================================================================

  /**
   * Determines whether a task should be executed speculatively.
   *
   * Checks all policy constraints:
   * 1. Global speculation enabled
   * 2. Dependency type allowed
   * 3. Depth limit
   * 4. Stake limit
   * 5. Private task policy
   * 6. Reputation threshold
   * 7. Rollback rate threshold
   *
   * @param taskPda - Task account PDA
   * @param taskNode - Optional task node (fetched if not provided)
   * @param isPrivate - Whether this is a private (ZK) task
   * @param agentReputation - Agent's reputation score (0-1000)
   * @returns Decision about whether to speculate
   */
  shouldSpeculate(
    taskPda: PublicKey,
    taskNode?: TaskNode,
    isPrivate: boolean = false,
    agentReputation: number = 1000,
  ): SpeculationDecision {
    // 1. Check global enable
    if (!this.speculationEnabled) {
      return { allowed: false, reason: "disabled" };
    }

    // Get task node if not provided
    const node = taskNode ?? this.dependencyGraph.getNode(taskPda);
    if (!node) {
      return { allowed: false, reason: "task_not_found" };
    }

    // 2. Check dependency type
    if (
      !this.config.speculatableDependencyTypes.includes(node.dependencyType)
    ) {
      return { allowed: false, reason: "dependency_type_not_speculatable" };
    }

    // 3. Check depth limit
    const depth = this.dependencyGraph.getDepth(taskPda);
    if (depth >= this.config.maxSpeculationDepth) {
      this.events.onDepthLimitReached?.(
        taskPda,
        depth,
        this.config.maxSpeculationDepth,
      );
      return { allowed: false, reason: "depth_limit" };
    }

    // 4. Check stake limit
    const currentStake = this.commitmentLedger.getTotalStakeAtRisk();
    if (currentStake >= this.config.maxSpeculativeStake) {
      this.events.onStakeLimitReached?.(
        currentStake,
        this.config.maxSpeculativeStake,
      );
      return { allowed: false, reason: "stake_limit" };
    }

    // 5. Check private task policy
    if (isPrivate && !this.config.allowPrivateSpeculation) {
      return { allowed: false, reason: "private_speculation_disabled" };
    }

    // 6. Check reputation threshold
    if (agentReputation < this.config.minReputationForSpeculation) {
      return { allowed: false, reason: "low_reputation" };
    }

    // 7. Check rollback rate (auto-disable)
    if (this.metrics.rollbackRate > this.config.maxRollbackRatePercent) {
      this.disableSpeculation("rollback_rate_exceeded");
      return { allowed: false, reason: "rollback_rate_exceeded" };
    }

    return { allowed: true };
  }

  /**
   * Registers the start of a speculative execution.
   *
   * Call this when beginning speculative execution of a task.
   *
   * @param taskPda - Task account PDA
   * @param depth - Speculation depth
   */
  registerSpeculationStart(taskPda: PublicKey, depth: number): void {
    const pdaKey = taskPda.toBase58();

    this.activeSpeculations.set(pdaKey, {
      startedAt: Date.now(),
      depth,
    });

    this.metrics.speculativeExecutions++;
    this.events.onSpeculationStarted?.(taskPda, depth);

    this.logger.debug(`Speculation started for ${pdaKey} at depth ${depth}`);
  }

  // ==========================================================================
  // Proof Lifecycle Handlers
  // ==========================================================================

  /**
   * Called when a proof is confirmed on-chain.
   *
   * Updates metrics and triggers downstream proof submissions.
   *
   * @param taskPda - Task account PDA
   */
  onProofConfirmed(taskPda: PublicKey): void {
    this.handleProofConfirmed(taskPda);
  }

  /**
   * Called when a proof fails (verification failed, timeout, etc).
   *
   * Triggers rollback of all dependent speculative work.
   *
   * @param taskPda - Task account PDA
   * @param reason - Optional reason for failure
   */
  onProofFailed(taskPda: PublicKey, reason?: string): void {
    this.handleProofFailed(taskPda, reason ?? "proof_failed");
  }

  /**
   * Force rollback a specific task.
   *
   * @param taskPda - Task account PDA to roll back
   * @param reason - Reason for rollback
   * @returns Rollback result
   */
  async forceRollback(
    taskPda: PublicKey,
    reason: RollbackReason = "manual",
  ): Promise<RollbackResult> {
    return this.rollbackController.rollback(taskPda, reason);
  }

  /**
   * Cancel speculative work for a task subtree without rollback accounting.
   *
   * Unlike rollback, cancellation does not increment rollback metrics
   * and does not slash stake.
   *
   * @param taskPda - Task PDA to cancel
   * @param reason - Why the cancellation was requested
   * @returns Cancellation result
   */
  cancelSpeculation(
    taskPda: PublicKey,
    reason: CancellationReason,
  ): SpeculativeCancellationResult {
    const cancelledTaskKey = taskPda.toBase58();
    const descendants = this.dependencyGraph.getDescendants(taskPda);

    const abortedDescendants: PublicKey[] = [];
    let stakeReleased = 0n;

    // Cancel active speculations across descendants
    for (const descendant of descendants) {
      const descendantKey = descendant.taskPda.toBase58();
      if (this.activeSpeculations.delete(descendantKey)) {
        abortedDescendants.push(descendant.taskPda);
      }

      const commitment = this.commitmentLedger.getByTask(descendant.taskPda);
      if (
        commitment &&
        commitment.status !== "confirmed" &&
        commitment.status !== "failed"
      ) {
        stakeReleased += commitment.stakeAtRisk;
        this.commitmentLedger.updateStatus(descendant.taskPda, "rolled_back");
      }

      this.dependencyGraph.updateStatus(descendant.taskPda, "failed");
    }

    // Cancel the root task itself
    this.activeSpeculations.delete(cancelledTaskKey);
    const rootCommitment = this.commitmentLedger.getByTask(taskPda);
    if (
      rootCommitment &&
      rootCommitment.status !== "confirmed" &&
      rootCommitment.status !== "failed"
    ) {
      stakeReleased += rootCommitment.stakeAtRisk;
      this.commitmentLedger.updateStatus(taskPda, "rolled_back");
    }
    this.dependencyGraph.updateStatus(taskPda, "failed");

    // Cancel proofs waiting on this ancestry chain (best-effort)
    const subtreeKeys = new Set(descendants.map((n) => n.taskPda.toBase58()));
    subtreeKeys.add(cancelledTaskKey);
    const blockedProofs = this.proofDeferralManager.getBlockedProofs();
    const cancelledProofs = blockedProofs.filter((proof) =>
      subtreeKeys.has(proof.taskPda.toBase58()),
    ).length;
    this.proofDeferralManager.onAncestorFailed(taskPda);

    return {
      cancelledTaskPda: taskPda,
      reason,
      abortedDescendants,
      cancelledProofs,
      stakeReleased,
    };
  }

  // ==========================================================================
  // Status and Metrics
  // ==========================================================================

  /**
   * Gets the current scheduler status.
   */
  getStatus(): SpeculativeSchedulerStatus {
    const stats = this.commitmentLedger.getStats();
    const deferralStats = this.proofDeferralManager.getStats();

    return {
      running: this.running,
      speculationEnabled: this.speculationEnabled,
      activeSpeculations: this.activeSpeculations.size,
      maxDepthReached: this.commitmentLedger.getMaxDepth(),
      currentMaxDepth: this.config.maxSpeculationDepth,
      totalStakeAtRisk: stats.totalStakeAtRisk,
      pendingProofs: deferralStats.queued + deferralStats.generating,
      awaitingAncestors: deferralStats.awaitingAncestors,
    };
  }

  /**
   * Gets speculation metrics.
   */
  getMetrics(): SpeculationMetrics {
    return { ...this.metrics };
  }

  /**
   * Gets all active speculative commitments.
   *
   * Returns commitments that are not yet confirmed, failed, or rolled back.
   */
  getActiveCommitments(): SpeculativeCommitment[] {
    return this.commitmentLedger
      .getAllCommitments()
      .filter(
        (c) =>
          c.status !== "confirmed" &&
          c.status !== "failed" &&
          c.status !== "rolled_back",
      );
  }

  /**
   * Gets all proofs awaiting ancestor confirmation.
   */
  getBlockedProofs(): DeferredProof[] {
    return this.proofDeferralManager.getBlockedProofs();
  }

  // ==========================================================================
  // Speculation Control
  // ==========================================================================

  /**
   * Enables speculation (if previously disabled).
   */
  enableSpeculation(): void {
    if (!this.speculationEnabled) {
      this.speculationEnabled = true;
      this.events.onSpeculationEnabled?.();
      this.logger.info("Speculation enabled");
    }
  }

  /**
   * Disables speculation.
   *
   * @param reason - Reason for disabling
   */
  disableSpeculation(reason: string): void {
    if (this.speculationEnabled) {
      this.speculationEnabled = false;
      this.events.onSpeculationDisabled?.(reason);
      this.logger.warn(`Speculation disabled: ${reason}`);
    }
  }

  /**
   * Checks if speculation is currently enabled.
   */
  isSpeculationEnabled(): boolean {
    return this.speculationEnabled;
  }

  // ==========================================================================
  // Component Accessors
  // ==========================================================================

  /**
   * Gets the dependency graph.
   */
  getDependencyGraph(): DependencyGraph {
    return this.dependencyGraph;
  }

  /**
   * Gets the commitment ledger.
   */
  getCommitmentLedger(): CommitmentLedger {
    return this.commitmentLedger;
  }

  /**
   * Gets the proof deferral manager.
   */
  getProofDeferralManager(): ProofDeferralManager {
    return this.proofDeferralManager;
  }

  /**
   * Gets the rollback controller.
   */
  getRollbackController(): RollbackController {
    return this.rollbackController;
  }

  // ==========================================================================
  // Internal Handlers
  // ==========================================================================

  private handleProofConfirmed(taskPda: PublicKey): void {
    const pdaKey = taskPda.toBase58();

    // Update speculation tracking
    const speculation = this.activeSpeculations.get(pdaKey);
    if (speculation) {
      // Calculate time saved (estimated as time from start to now)
      const timeTaken = Date.now() - speculation.startedAt;
      this.metrics.estimatedTimeSaved += timeTaken;
      this.metrics.speculativeHits++;

      this.activeSpeculations.delete(pdaKey);
    }

    // Update commitment ledger
    try {
      this.commitmentLedger.markConfirmed(taskPda);
    } catch {
      // Commitment may not exist if task wasn't speculative
    }

    // Update dependency graph
    this.dependencyGraph.updateStatus(taskPda, "completed");

    // Recalculate hit rate
    this.updateHitRate();

    // Fire event
    this.events.onSpeculationConfirmed?.(taskPda);

    this.logger.debug(`Proof confirmed for ${pdaKey}`);

    // Notify proof deferral manager to unblock waiting proofs
    this.proofDeferralManager.onAncestorConfirmed(taskPda);
  }

  private handleProofFailed(taskPda: PublicKey, reason: string): void {
    const pdaKey = taskPda.toBase58();

    // Update speculation tracking
    const speculation = this.activeSpeculations.get(pdaKey);
    if (speculation) {
      this.metrics.speculativeMisses++;
      this.activeSpeculations.delete(pdaKey);
    }

    // Trigger rollback of all dependents
    this.rollbackController.rollback(taskPda, "proof_failed");

    // Notify proof deferral manager to cancel waiting proofs
    this.proofDeferralManager.onAncestorFailed(taskPda);

    // Recalculate metrics
    this.updateHitRate();
    this.updateRollbackRate();

    // Fire event
    this.events.onSpeculationFailed?.(taskPda, reason);

    this.logger.warn(`Proof failed for ${pdaKey}: ${reason}`);
  }

  private updateMetricsOnRollback(result: RollbackResult): void {
    this.metrics.timeWastedOnRollbacks += result.wastedComputeMs;
    this.updateRollbackRate();
  }

  private updateHitRate(): void {
    const total = this.metrics.speculativeHits + this.metrics.speculativeMisses;
    this.metrics.hitRate =
      total > 0 ? (this.metrics.speculativeHits / total) * 100 : 0;
  }

  private updateRollbackRate(): void {
    const total = this.metrics.speculativeExecutions;
    this.metrics.rollbackRate =
      total > 0 ? (this.metrics.speculativeMisses / total) * 100 : 0;
  }
}
