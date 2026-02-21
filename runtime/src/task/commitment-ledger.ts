/**
 * CommitmentLedger - Tracks speculative commitments for the speculation system
 *
 * An off-chain data structure that tracks speculative commitments (results that
 * downstream tasks depend on but aren't yet proven on-chain). This enables
 * multi-level speculation with proper stake tracking and rollback scoping.
 *
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import { bytesToHex, hexToBytes } from "../utils/encoding.js";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Status of a speculative commitment's proof lifecycle.
 */
export type CommitmentStatus =
  | "pending" // Task executing, no proof yet
  | "executing" // Task is currently executing
  | "executed" // Execution complete, proof not started
  | "proof_generating" // Proof generation in progress
  | "proof_generated" // Proof ready, not submitted
  | "confirmed" // On-chain, finalized
  | "failed" // Generation or submission failed
  | "rolled_back"; // Rolled back due to ancestor failure

/**
 * A speculative commitment representing a task result that downstream
 * tasks may depend on before it's proven on-chain.
 */
export interface SpeculativeCommitment {
  /** Unique commitment ID */
  readonly id: string;

  /** The task whose result is being committed speculatively */
  readonly sourceTaskPda: PublicKey;
  readonly sourceTaskId: Uint8Array;

  /** The result/output hash being committed */
  readonly resultHash: Uint8Array;

  /** Current commitment status */
  status: CommitmentStatus;

  /** Tasks that depend on this commitment (downstream consumers) */
  dependentTaskPdas: PublicKey[];

  /** Timestamp when commitment was created (Unix ms) */
  readonly createdAt: number;

  /** Timestamp when proof was confirmed (null if not yet) */
  confirmedAt: number | null;

  /** Speculation depth (how many unconfirmed ancestors) */
  readonly depth: number;

  /** Economic risk: stake value at risk if this proof fails */
  readonly stakeAtRisk: bigint;

  /** Agent that produced this result */
  readonly producerAgent: PublicKey;
}

/**
 * Configuration for the CommitmentLedger.
 */
export interface CommitmentLedgerConfig {
  /** Maximum commitments to track (memory bound) */
  maxCommitments: number;

  /** Retention period for confirmed commitments (ms) */
  confirmedRetentionMs: number;

  /** Enable persistence to disk */
  persistToDisk: boolean;

  /** Path for disk persistence */
  persistPath?: string;
}

/**
 * Statistics about the commitment ledger state.
 */
export interface CommitmentLedgerStats {
  total: number;
  pending: number;
  executing: number;
  executed: number;
  proofGenerating: number;
  proofGenerated: number;
  confirmed: number;
  failed: number;
  rolledBack: number;
  totalStakeAtRisk: bigint;
  maxDepth: number;
}

/**
 * Result of validating a commitment ancestor chain.
 */
export interface ChainIntegrityResult {
  /** Whether the chain is valid. */
  valid: boolean;
  /** Node where validation failed. */
  brokenAt?: PublicKey;
  /** Reason the chain is invalid. */
  reason?: "missing_ancestor" | "failed_ancestor" | "rolled_back_ancestor";
}

/**
 * Mutation command for single-writer pattern.
 */
export type MutationCommand =
  | { type: "create"; commitment: SpeculativeCommitment }
  | { type: "updateStatus"; taskPda: PublicKey; status: CommitmentStatus }
  | { type: "addDependent"; commitmentId: string; dependentTaskPda: PublicKey }
  | { type: "markConfirmed"; taskPda: PublicKey }
  | { type: "markFailed"; taskPda: PublicKey };

/**
 * Serialized commitment for persistence.
 */
interface SerializedCommitment {
  id: string;
  sourceTaskPda: string;
  sourceTaskId: string;
  resultHash: string;
  status: CommitmentStatus;
  dependentTaskPdas: string[];
  createdAt: number;
  confirmedAt: number | null;
  depth: number;
  stakeAtRisk: string;
  producerAgent: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: CommitmentLedgerConfig = {
  maxCommitments: 10000,
  confirmedRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
  persistToDisk: false,
};

// ============================================================================
// CommitmentLedger Implementation
// ============================================================================

/**
 * Tracks speculative commitments for the speculation system.
 *
 * Provides the source of truth for commitment state, stake tracking,
 * and rollback scoping. Uses a single-writer pattern for safe concurrent access.
 *
 * @example
 * ```typescript
 * const ledger = new CommitmentLedger({
 *   maxCommitments: 1000,
 *   confirmedRetentionMs: 3600000,
 *   persistToDisk: false,
 * });
 *
 * // Create a commitment
 * const commitment = ledger.createCommitment(
 *   taskPda,
 *   taskId,
 *   resultHash,
 *   producerAgent,
 *   1000000n
 * );
 *
 * // Later, confirm it
 * ledger.markConfirmed(taskPda);
 * ```
 */
export class CommitmentLedger {
  private readonly config: CommitmentLedgerConfig;
  private commitments: Map<string, SpeculativeCommitment> = new Map();
  private byTask: Map<string, string> = new Map(); // taskPda -> commitmentId
  private byParentTask: Map<string, string> = new Map(); // taskPda -> parentTaskPda
  private byDepth: Map<number, Set<string>> = new Map(); // depth -> commitmentIds
  private mutationQueue: MutationCommand[] = [];

  /**
   * Creates a new CommitmentLedger instance.
   *
   * @param config - Configuration options (uses defaults for missing values)
   */
  constructor(config: Partial<CommitmentLedgerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Creates a new speculative commitment.
   *
   * @param taskPda - Task account PDA
   * @param taskId - Unique 32-byte task identifier
   * @param resultHash - Hash of the speculative result
   * @param producerAgent - Agent that produced the result
   * @param stakeAtRisk - Economic stake at risk if proof fails
   * @returns The created commitment
   * @throws Error if commitment for task already exists or max commitments reached
   */
  createCommitment(
    taskPda: PublicKey,
    taskId: Uint8Array,
    resultHash: Uint8Array,
    producerAgent: PublicKey,
    stakeAtRisk: bigint,
  ): SpeculativeCommitment {
    const taskKey = taskPda.toBase58();

    // Check if commitment already exists for this task
    if (this.byTask.has(taskKey)) {
      throw new Error(`Commitment already exists for task ${taskKey}`);
    }

    // Check max commitments limit
    if (this.commitments.size >= this.config.maxCommitments) {
      throw new Error(
        `Maximum commitments limit (${this.config.maxCommitments}) reached`,
      );
    }

    // Generate unique commitment ID
    const id = bytesToHex(randomBytes(16));

    // Calculate depth based on any parent commitments
    const depth = this.calculateDepth(taskPda);

    const commitment: SpeculativeCommitment = {
      id,
      sourceTaskPda: taskPda,
      sourceTaskId: taskId,
      resultHash,
      status: "pending",
      dependentTaskPdas: [],
      createdAt: Date.now(),
      confirmedAt: null,
      depth,
      stakeAtRisk,
      producerAgent,
    };

    // Store commitment
    this.commitments.set(id, commitment);
    this.byTask.set(taskKey, id);

    // Index by depth
    if (!this.byDepth.has(depth)) {
      this.byDepth.set(depth, new Set());
    }
    this.byDepth.get(depth)!.add(id);

    return commitment;
  }

  /**
   * Gets a commitment by task PDA.
   *
   * @param taskPda - Task account PDA
   * @returns The commitment or undefined if not found
   */
  getByTask(taskPda: PublicKey): SpeculativeCommitment | undefined {
    const taskKey = taskPda.toBase58();
    const commitmentId = this.byTask.get(taskKey);
    return commitmentId ? this.commitments.get(commitmentId) : undefined;
  }

  /**
   * Gets a commitment by ID.
   *
   * @param id - Commitment ID
   * @returns The commitment or undefined if not found
   */
  getById(id: string): SpeculativeCommitment | undefined {
    return this.commitments.get(id);
  }

  /**
   * Updates the status of a commitment.
   *
   * @param taskPda - Task account PDA
   * @param status - New commitment status
   * @throws Error if commitment not found
   */
  updateStatus(taskPda: PublicKey, status: CommitmentStatus): void {
    const commitment = this.getByTask(taskPda);
    if (!commitment) {
      throw new Error(`Commitment not found for task ${taskPda.toBase58()}`);
    }

    // Update status (mutates in place since we own the object)
    (commitment as { status: CommitmentStatus }).status = status;
  }

  /**
   * Adds a dependent task to a commitment.
   *
   * @param taskPda - Task PDA of the commitment being depended on
   * @param dependentTaskPda - PDA of the task that depends on this commitment
   * @throws Error if commitment not found
   */
  addDependent(taskPda: PublicKey, dependentTaskPda: PublicKey): void {
    const commitment = this.getByTask(taskPda);
    if (!commitment) {
      throw new Error(`Commitment not found for task ${taskPda.toBase58()}`);
    }

    // Avoid duplicate dependents
    const dependentKey = dependentTaskPda.toBase58();
    const exists = commitment.dependentTaskPdas.some(
      (pda) => pda.toBase58() === dependentKey,
    );

    if (!exists) {
      commitment.dependentTaskPdas.push(dependentTaskPda);
    }

    if (!this.byParentTask.has(dependentKey)) {
      this.byParentTask.set(dependentKey, taskPda.toBase58());
    }
  }

  /**
   * Marks a commitment as confirmed on-chain.
   *
   * @param taskPda - Task account PDA
   * @throws Error if commitment not found
   */
  markConfirmed(taskPda: PublicKey): void {
    const commitment = this.getByTask(taskPda);
    if (!commitment) {
      throw new Error(`Commitment not found for task ${taskPda.toBase58()}`);
    }

    (commitment as { status: CommitmentStatus }).status = "confirmed";
    (commitment as { confirmedAt: number | null }).confirmedAt = Date.now();
  }

  /**
   * Marks a commitment as failed and returns all affected commitments.
   *
   * This triggers a cascade - all downstream commitments that depend on
   * this one (directly or transitively) are also marked as rolled back.
   *
   * @param taskPda - Task account PDA that failed
   * @returns Array of affected commitments (including the failed one)
   * @throws Error if commitment not found
   */
  markFailed(taskPda: PublicKey): SpeculativeCommitment[] {
    const commitment = this.getByTask(taskPda);
    if (!commitment) {
      throw new Error(`Commitment not found for task ${taskPda.toBase58()}`);
    }

    // Get all affected commitments (including this one)
    const affected = this.getAffectedByFailure(taskPda);

    // Mark the source as failed
    (commitment as { status: CommitmentStatus }).status = "failed";

    // Mark all dependents as rolled back
    for (const affectedCommitment of affected) {
      if (affectedCommitment.id !== commitment.id) {
        (affectedCommitment as { status: CommitmentStatus }).status =
          "rolled_back";
      }
    }

    return affected;
  }

  /**
   * Gets all commitments that would be affected by a failure.
   *
   * Performs a breadth-first traversal of the dependency graph to find
   * all direct and transitive dependents.
   *
   * @param taskPda - Task account PDA that would fail
   * @returns Array of affected commitments (including the failed one)
   */
  getAffectedByFailure(taskPda: PublicKey): SpeculativeCommitment[] {
    const commitment = this.getByTask(taskPda);
    if (!commitment) {
      return [];
    }

    const affected: SpeculativeCommitment[] = [commitment];
    const visited = new Set<string>([commitment.id]);
    const queue: SpeculativeCommitment[] = [commitment];

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Find all commitments that depend on the current one
      for (const dependentPda of current.dependentTaskPdas) {
        const dependent = this.getByTask(dependentPda);
        if (dependent && !visited.has(dependent.id)) {
          visited.add(dependent.id);
          affected.push(dependent);
          queue.push(dependent);
        }
      }
    }

    return affected;
  }

  /**
   * Finds commitments that appear to be orphaned based on depth and ancestry data.
   *
   * @returns Commitments with depth > 0 but no discoverable parent commitment
   */
  findOrphanedCommitments(): SpeculativeCommitment[] {
    const orphans: SpeculativeCommitment[] = [];

    for (const commitment of this.commitments.values()) {
      if (
        commitment.status === "confirmed" ||
        commitment.status === "failed" ||
        commitment.status === "rolled_back"
      ) {
        continue;
      }

      if (commitment.depth <= 0) {
        continue;
      }

      const childKey = commitment.sourceTaskPda.toBase58();
      const parentKey = this.byParentTask.get(childKey);
      if (!parentKey) {
        orphans.push(commitment);
        continue;
      }

      const parentId = this.byTask.get(parentKey);
      const parentCommitment = parentId
        ? this.commitments.get(parentId)
        : undefined;
      if (!parentCommitment) {
        orphans.push(commitment);
      }
    }

    return orphans;
  }

  /**
   * Validates a commitment ancestry chain and returns the first broken node.
   *
   * @param taskPda - Task whose chain should be validated
   * @returns Validation result with optional broken node and reason
   */
  validateChainIntegrity(taskPda: PublicKey): ChainIntegrityResult {
    const commitment = this.getByTask(taskPda);
    if (!commitment) {
      return {
        valid: false,
        reason: "missing_ancestor",
        brokenAt: taskPda,
      };
    }

    const visited = new Set<string>();
    let current = commitment;

    while (current.depth > 0) {
      const currentKey = current.sourceTaskPda.toBase58();
      if (visited.has(currentKey)) {
        return {
          valid: false,
          reason: "missing_ancestor",
          brokenAt: current.sourceTaskPda,
        };
      }
      visited.add(currentKey);

      const parentKey = this.byParentTask.get(currentKey);
      if (!parentKey) {
        return {
          valid: false,
          reason: "missing_ancestor",
          brokenAt: current.sourceTaskPda,
        };
      }

      const parentId = this.byTask.get(parentKey);
      if (!parentId) {
        return {
          valid: false,
          reason: "missing_ancestor",
          brokenAt: current.sourceTaskPda,
        };
      }

      const parent = this.commitments.get(parentId);
      if (!parent) {
        return {
          valid: false,
          reason: "missing_ancestor",
          brokenAt: current.sourceTaskPda,
        };
      }

      if (parent.status === "failed") {
        return {
          valid: false,
          reason: "failed_ancestor",
          brokenAt: parent.sourceTaskPda,
        };
      }

      if (parent.status === "rolled_back") {
        return {
          valid: false,
          reason: "rolled_back_ancestor",
          brokenAt: parent.sourceTaskPda,
        };
      }

      current = parent;
    }

    return { valid: true };
  }

  /**
   * Calculates total stake at risk across all active commitments.
   *
   * @returns Total stake at risk in lamports
   */
  getTotalStakeAtRisk(): bigint {
    let total = 0n;

    for (const commitment of this.commitments.values()) {
      // Only count non-confirmed, non-failed commitments
      if (
        commitment.status !== "confirmed" &&
        commitment.status !== "failed" &&
        commitment.status !== "rolled_back"
      ) {
        total += commitment.stakeAtRisk;
      }
    }

    return total;
  }

  /**
   * Gets the maximum speculation depth across all active commitments.
   *
   * @returns Maximum depth (0 if no commitments)
   */
  getMaxDepth(): number {
    let maxDepth = 0;

    for (const commitment of this.commitments.values()) {
      if (
        commitment.status !== "confirmed" &&
        commitment.status !== "failed" &&
        commitment.status !== "rolled_back"
      ) {
        maxDepth = Math.max(maxDepth, commitment.depth);
      }
    }

    return maxDepth;
  }

  /**
   * Gets all commitments at a given depth.
   *
   * @param depth - Speculation depth to query
   * @returns Array of commitments at that depth
   */
  getByDepth(depth: number): SpeculativeCommitment[] {
    const ids = this.byDepth.get(depth);
    if (!ids) {
      return [];
    }

    const result: SpeculativeCommitment[] = [];
    for (const id of ids) {
      const commitment = this.commitments.get(id);
      if (commitment) {
        result.push(commitment);
      }
    }

    return result;
  }

  /**
   * Prunes old confirmed commitments based on retention period.
   *
   * @returns Number of commitments pruned
   */
  pruneConfirmed(): number {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, commitment] of this.commitments) {
      if (
        commitment.status === "confirmed" &&
        commitment.confirmedAt !== null &&
        now - commitment.confirmedAt > this.config.confirmedRetentionMs
      ) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      const commitment = this.commitments.get(id)!;
      const taskKey = commitment.sourceTaskPda.toBase58();

      // Remove from all indexes
      this.commitments.delete(id);
      this.byTask.delete(taskKey);

      const depthSet = this.byDepth.get(commitment.depth);
      if (depthSet) {
        depthSet.delete(id);
        if (depthSet.size === 0) {
          this.byDepth.delete(commitment.depth);
        }
      }

      const dependentTaskPdas = commitment.dependentTaskPdas;
      for (const dependentPda of dependentTaskPdas) {
        const dependentKey = dependentPda.toBase58();
        if (this.byParentTask.get(dependentKey) === taskKey) {
          this.byParentTask.delete(dependentKey);
        }
      }
      this.byParentTask.delete(taskKey);
    }

    return toRemove.length;
  }

  /**
   * Queues a mutation command for the single-writer pattern.
   *
   * @param command - Mutation command to queue
   */
  queueMutation(command: MutationCommand): void {
    this.mutationQueue.push(command);
  }

  /**
   * Processes all queued mutations. Called by scheduler event loop.
   */
  processMutations(): void {
    while (this.mutationQueue.length > 0) {
      const command = this.mutationQueue.shift()!;

      switch (command.type) {
        case "create":
          // Already created, just store
          this.commitments.set(command.commitment.id, command.commitment);
          break;
        case "updateStatus":
          this.updateStatus(command.taskPda, command.status);
          break;
        case "addDependent":
          const commitment = this.commitments.get(command.commitmentId);
          if (commitment) {
            this.addDependent(
              commitment.sourceTaskPda,
              command.dependentTaskPda,
            );
          }
          break;
        case "markConfirmed":
          this.markConfirmed(command.taskPda);
          break;
        case "markFailed":
          this.markFailed(command.taskPda);
          break;
      }
    }
  }

  /**
   * Persists the ledger to disk (if enabled).
   *
   * @throws Error if persistence is disabled or path not configured
   */
  async persist(): Promise<void> {
    if (!this.config.persistToDisk) {
      throw new Error("Disk persistence is not enabled");
    }

    if (!this.config.persistPath) {
      throw new Error("Persist path is not configured");
    }

    const serialized: SerializedCommitment[] = [];

    for (const commitment of this.commitments.values()) {
      serialized.push({
        id: commitment.id,
        sourceTaskPda: commitment.sourceTaskPda.toBase58(),
        sourceTaskId: bytesToHex(commitment.sourceTaskId),
        resultHash: bytesToHex(commitment.resultHash),
        status: commitment.status,
        dependentTaskPdas: commitment.dependentTaskPdas.map((pda) =>
          pda.toBase58(),
        ),
        createdAt: commitment.createdAt,
        confirmedAt: commitment.confirmedAt,
        depth: commitment.depth,
        stakeAtRisk: commitment.stakeAtRisk.toString(),
        producerAgent: commitment.producerAgent.toBase58(),
      });
    }

    await fs.writeFile(
      this.config.persistPath,
      JSON.stringify(serialized, null, 2),
    );
  }

  /**
   * Loads the ledger from disk (if enabled).
   *
   * @throws Error if persistence is disabled or path not configured
   */
  async load(): Promise<void> {
    if (!this.config.persistToDisk) {
      throw new Error("Disk persistence is not enabled");
    }

    if (!this.config.persistPath) {
      throw new Error("Persist path is not configured");
    }

    let data: string;
    try {
      data = await fs.readFile(this.config.persistPath, "utf-8");
    } catch (err) {
      // File doesn't exist - start fresh
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }

    const serialized: SerializedCommitment[] = JSON.parse(data);

    // Clear existing state
    this.commitments.clear();
    this.byTask.clear();
    this.byParentTask.clear();
    this.byDepth.clear();

    // Restore commitments
    for (const item of serialized) {
      const commitment: SpeculativeCommitment = {
        id: item.id,
        sourceTaskPda: new PublicKey(item.sourceTaskPda),
        sourceTaskId: hexToBytes(item.sourceTaskId),
        resultHash: hexToBytes(item.resultHash),
        status: item.status,
        dependentTaskPdas: item.dependentTaskPdas.map(
          (pda) => new PublicKey(pda),
        ),
        createdAt: item.createdAt,
        confirmedAt: item.confirmedAt,
        depth: item.depth,
        stakeAtRisk: BigInt(item.stakeAtRisk),
        producerAgent: new PublicKey(item.producerAgent),
      };

      this.commitments.set(commitment.id, commitment);
      this.byTask.set(commitment.sourceTaskPda.toBase58(), commitment.id);

      if (!this.byDepth.has(commitment.depth)) {
        this.byDepth.set(commitment.depth, new Set());
      }
      this.byDepth.get(commitment.depth)!.add(commitment.id);

      for (const dependentPda of commitment.dependentTaskPdas) {
        const dependentKey = dependentPda.toBase58();
        if (!this.byParentTask.has(dependentKey)) {
          this.byParentTask.set(
            dependentKey,
            commitment.sourceTaskPda.toBase58(),
          );
        }
      }
    }
  }

  /**
   * Gets statistics about the ledger state.
   *
   * @returns Ledger statistics
   */
  getStats(): CommitmentLedgerStats {
    const stats: CommitmentLedgerStats = {
      total: 0,
      pending: 0,
      executing: 0,
      executed: 0,
      proofGenerating: 0,
      proofGenerated: 0,
      confirmed: 0,
      failed: 0,
      rolledBack: 0,
      totalStakeAtRisk: 0n,
      maxDepth: 0,
    };

    for (const commitment of this.commitments.values()) {
      stats.total++;

      switch (commitment.status) {
        case "pending":
          stats.pending++;
          break;
        case "executing":
          stats.executing++;
          break;
        case "executed":
          stats.executed++;
          break;
        case "proof_generating":
          stats.proofGenerating++;
          break;
        case "proof_generated":
          stats.proofGenerated++;
          break;
        case "confirmed":
          stats.confirmed++;
          break;
        case "failed":
          stats.failed++;
          break;
        case "rolled_back":
          stats.rolledBack++;
          break;
      }

      // Track stake and depth for active commitments
      if (
        commitment.status !== "confirmed" &&
        commitment.status !== "failed" &&
        commitment.status !== "rolled_back"
      ) {
        stats.totalStakeAtRisk += commitment.stakeAtRisk;
        stats.maxDepth = Math.max(stats.maxDepth, commitment.depth);
      }
    }

    return stats;
  }

  /**
   * Gets all commitments (for testing/debugging).
   *
   * @returns Array of all commitments
   */
  getAllCommitments(): SpeculativeCommitment[] {
    return Array.from(this.commitments.values());
  }

  /**
   * Clears all commitments (for testing).
   */
  clear(): void {
    this.commitments.clear();
    this.byTask.clear();
    this.byParentTask.clear();
    this.byDepth.clear();
    this.mutationQueue = [];
  }

  /**
   * Calculates the depth for a new commitment.
   *
   * Currently returns 0 as the base depth. In a full implementation,
   * this would look up parent commitments and calculate based on ancestry.
   *
   * @param _taskPda - Task PDA (unused for now)
   * @returns Calculated depth
   */
  private calculateDepth(_taskPda: PublicKey): number {
    let depth = 0;
    const visited = new Set<string>();
    let currentKey = _taskPda.toBase58();

    while (true) {
      const parentTaskKey = this.byParentTask.get(currentKey);
      if (!parentTaskKey) {
        return depth;
      }

      if (visited.has(parentTaskKey)) {
        // Cycle detected in parent linkage
        return depth;
      }
      visited.add(parentTaskKey);
      depth += 1;

      const parentCommitmentId = this.byTask.get(parentTaskKey);
      if (!parentCommitmentId) {
        return depth;
      }

      const parentCommitment = this.commitments.get(parentCommitmentId);
      if (!parentCommitment) {
        return depth;
      }

      currentKey = parentCommitment.sourceTaskPda.toBase58();
    }
  }
}
