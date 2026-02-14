/**
 * DAGSubmitter — Sequential on-chain task creation for workflow DAGs.
 *
 * Submits tasks in topological order, creating root tasks via `createTask`
 * and dependent tasks via `createDependentTask`. Respects on-chain rate
 * limits with automatic retry on cooldown errors.
 *
 * @module
 */

import { SystemProgram } from '@solana/web3.js';
import type { PublicKey } from '@solana/web3.js';
import anchor, { type Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { generateAgentId, toAnchorBytes } from '../utils/encoding.js';
import { findAgentPda, findProtocolPda } from '../agent/pda.js';
import { findTaskPda, findEscrowPda } from '../task/pda.js';
import { isAnchorError, AnchorErrorCodes } from '../types/errors.js';
import { buildCreateTaskTokenAccounts } from '../utils/token.js';
import type { WorkflowState, WorkflowEdge } from './types.js';
import { WorkflowNodeStatus, OnChainDependencyType } from './types.js';
import { WorkflowSubmissionError } from './errors.js';
import { topologicalSort } from './validation.js';

/** Default retry delay in ms */
const DEFAULT_RETRY_DELAY_MS = 1000;
/** Default max retries */
const DEFAULT_MAX_RETRIES = 3;
/** Rate limit cooldown wait in ms (slightly over 1s to account for clock skew) */
const RATE_LIMIT_WAIT_MS = 1500;

export interface DAGSubmitterConfig {
  program: Program<AgencCoordination>;
  agentId: Uint8Array;
  logger?: Logger;
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Submits workflow tasks on-chain in topological order.
 *
 * Root tasks (no incoming edges) use `createTask`.
 * Dependent tasks use `createDependentTask` with `parentTask` account.
 */
export class DAGSubmitter {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly logger: Logger;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly agentPda;
  private readonly protocolPda;

  constructor(config: DAGSubmitterConfig) {
    this.program = config.program;
    this.agentId = config.agentId;
    this.logger = config.logger ?? silentLogger;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.agentPda = findAgentPda(this.agentId, this.program.programId);
    this.protocolPda = findProtocolPda(this.program.programId);
  }

  /**
   * Submit all workflow tasks on-chain in topological order.
   *
   * Mutates `state.nodes` in place as tasks are created. On failure,
   * already-created tasks remain in their `Created` state.
   *
   * @param state - Workflow state with all nodes in Pending status
   * @param cancelOnFailure - If true, mark uncreated descendants as Cancelled on failure
   * @returns Updated workflow state
   * @throws WorkflowSubmissionError if a task creation fails after retries
   */
  async submitAll(state: WorkflowState, cancelOnFailure: boolean): Promise<WorkflowState> {
    const order = topologicalSort(state.definition);
    const edgeMap = this.buildEdgeMap(state.definition.edges);
    const creator = this.program.provider.publicKey!;
    const defaultRewardMint = state.definition.defaultRewardMint ?? null;

    for (const name of order) {
      const node = state.nodes.get(name)!;

      // Skip if already created or cancelled
      if (node.status !== WorkflowNodeStatus.Pending) {
        continue;
      }

      // Generate task ID and derive PDAs
      const taskId = generateAgentId(); // random 32-byte ID
      const taskPda = findTaskPda(creator, taskId, this.program.programId);
      const escrowPda = findEscrowPda(taskPda, this.program.programId);

      node.taskId = taskId;
      node.taskPda = taskPda;
      node.status = WorkflowNodeStatus.Creating;

      // Resolve parent PDA if this is a dependent task
      const edge = edgeMap.get(name);
      if (edge) {
        const parentNode = state.nodes.get(edge.from)!;
        node.parentName = edge.from;
        node.parentPda = parentNode.taskPda;
        node.dependencyType = edge.dependencyType;
      }

      try {
        const txSig = await this.submitWithRetry(
          node, creator, taskId, taskPda, escrowPda, defaultRewardMint
        );
        node.status = WorkflowNodeStatus.Created;
        node.transactionSignature = txSig;
        node.createdAt = Date.now();
        this.logger.info(`Created workflow node "${name}" — tx: ${txSig}`);
      } catch (err) {
        node.status = WorkflowNodeStatus.Failed;
        node.error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(`Failed to create node "${name}": ${node.error.message}`);

        if (cancelOnFailure) {
          this.cascadeCancel(state, name);
        }

        throw new WorkflowSubmissionError(name, node.error.message);
      }
    }

    return state;
  }

  /**
   * Submit a single task with retry and rate-limit backoff.
   */
  private async submitWithRetry(
    node: import('./types.js').WorkflowNode,
    creator: import('@solana/web3.js').PublicKey,
    taskId: Uint8Array,
    taskPda: import('@solana/web3.js').PublicKey,
    escrowPda: import('@solana/web3.js').PublicKey,
    defaultRewardMint: PublicKey | null,
  ): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (node.parentPda) {
          return await this.createDependentTask(
            taskId,
            node.template,
            taskPda,
            escrowPda,
            node.parentPda,
            node.dependencyType,
            creator,
            defaultRewardMint,
          );
        } else {
          return await this.createRootTask(
            taskId,
            node.template,
            taskPda,
            escrowPda,
            creator,
            defaultRewardMint,
          );
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // On rate limit errors, wait and retry
        if (
          isAnchorError(err, AnchorErrorCodes.RateLimitExceeded) ||
          isAnchorError(err, AnchorErrorCodes.CooldownNotElapsed)
        ) {
          this.logger.warn(
            `Rate limit hit for node "${node.name}", waiting ${RATE_LIMIT_WAIT_MS}ms (attempt ${attempt + 1}/${this.maxRetries + 1})`
          );
          await sleep(RATE_LIMIT_WAIT_MS);
          continue;
        }

        // For other errors, apply exponential backoff
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          this.logger.warn(
            `Retrying node "${node.name}" in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries + 1})`
          );
          await sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('Unknown submission error');
  }

  /**
   * Create a root task (no parent dependency).
   */
  private async createRootTask(
    taskId: Uint8Array,
    template: import('./types.js').TaskTemplate,
    taskPda: import('@solana/web3.js').PublicKey,
    escrowPda: import('@solana/web3.js').PublicKey,
    creator: import('@solana/web3.js').PublicKey,
    defaultRewardMint: PublicKey | null,
  ): Promise<string> {
    const constraintHash = template.constraintHash
      ? Array.from(template.constraintHash)
      : null;
    const mint = template.rewardMint ?? defaultRewardMint;
    const tokenAccounts = buildCreateTaskTokenAccounts(mint, escrowPda, creator);

    return this.program.methods
      .createTask(
        toAnchorBytes(taskId),
        new anchor.BN(template.requiredCapabilities.toString()),
        toAnchorBytes(template.description),
        new anchor.BN(template.rewardAmount.toString()),
        template.maxWorkers,
        new anchor.BN(template.deadline),
        template.taskType,
        constraintHash,
        template.minReputation ?? 0,
        mint,
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: this.protocolPda,
        creatorAgent: this.agentPda,
        authority: creator,
        creator,
        systemProgram: SystemProgram.programId,
        ...tokenAccounts,
      })
      .rpc();
  }

  /**
   * Create a dependent task with parent reference.
   */
  private async createDependentTask(
    taskId: Uint8Array,
    template: import('./types.js').TaskTemplate,
    taskPda: import('@solana/web3.js').PublicKey,
    escrowPda: import('@solana/web3.js').PublicKey,
    parentTaskPda: import('@solana/web3.js').PublicKey,
    dependencyType: OnChainDependencyType,
    creator: import('@solana/web3.js').PublicKey,
    defaultRewardMint: PublicKey | null,
  ): Promise<string> {
    const constraintHash = template.constraintHash
      ? Array.from(template.constraintHash)
      : null;
    const mint = template.rewardMint ?? defaultRewardMint;
    const tokenAccounts = buildCreateTaskTokenAccounts(mint, escrowPda, creator);

    return this.program.methods
      .createDependentTask(
        toAnchorBytes(taskId),
        new anchor.BN(template.requiredCapabilities.toString()),
        toAnchorBytes(template.description),
        new anchor.BN(template.rewardAmount.toString()),
        template.maxWorkers,
        new anchor.BN(template.deadline),
        template.taskType,
        constraintHash,
        dependencyType,
        template.minReputation ?? 0,
        mint,
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        parentTask: parentTaskPda,
        protocolConfig: this.protocolPda,
        creatorAgent: this.agentPda,
        authority: creator,
        creator,
        systemProgram: SystemProgram.programId,
        ...tokenAccounts,
      })
      .rpc();
  }

  /**
   * Build a map from child task name to the edge defining its parent.
   * Assumes validation has already confirmed single-parent constraint.
   */
  private buildEdgeMap(edges: ReadonlyArray<WorkflowEdge>): Map<string, WorkflowEdge> {
    const map = new Map<string, WorkflowEdge>();
    for (const edge of edges) {
      map.set(edge.to, edge);
    }
    return map;
  }

  /**
   * Mark all descendants of a failed node as Cancelled.
   */
  private cascadeCancel(state: WorkflowState, failedName: string): void {
    // Build parent->children adjacency
    const children = new Map<string, string[]>();
    for (const edge of state.definition.edges) {
      if (!children.has(edge.from)) {
        children.set(edge.from, []);
      }
      children.get(edge.from)!.push(edge.to);
    }

    // BFS from failed node
    const queue = [failedName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const kids = children.get(current);
      if (!kids) continue;
      for (const kid of kids) {
        const kidNode = state.nodes.get(kid)!;
        if (
          kidNode.status === WorkflowNodeStatus.Pending ||
          kidNode.status === WorkflowNodeStatus.Creating
        ) {
          kidNode.status = WorkflowNodeStatus.Cancelled;
          kidNode.error = new Error(`Parent node "${failedName}" failed`);
          this.logger.info(`Cancelled descendant node "${kid}" due to parent "${failedName}" failure`);
        }
        queue.push(kid);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
