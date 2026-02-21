/**
 * TaskOperations - On-chain task query and transaction operations.
 *
 * Provides methods for fetching tasks/claims from the chain and submitting
 * claim/complete transactions. Independent of AgentManager — takes a program
 * instance directly.
 *
 * @module
 */

import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  HASH_SIZE,
  RISC0_IMAGE_ID_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_SEAL_BORSH_LEN,
  TRUSTED_RISC0_SELECTOR,
} from "@agenc/sdk";
import { toAnchorBytes } from "../utils/encoding.js";
import anchor, { type Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type {
  OnChainTask,
  OnChainTaskClaim,
  ClaimResult,
  CompleteResult,
} from "./types.js";
import {
  parseOnChainTask,
  parseOnChainTaskClaim,
  OnChainTaskStatus,
} from "./types.js";
import { deriveTaskPda, deriveClaimPda, deriveEscrowPda } from "./pda.js";
import { deriveAgentPda, findProtocolPda } from "../agent/pda.js";
import { fetchTreasury } from "../utils/treasury.js";
import { buildCompleteTaskTokenAccounts } from "../utils/token.js";
import {
  isAnchorError,
  parseAnchorError,
  TaskNotClaimableError,
  TaskSubmissionError,
  AnchorErrorCodes,
  validateByteLength,
  validateNonZeroBytes,
} from "../types/errors.js";
import { encodeStatusByte, queryWithFallback } from "../utils/query.js";

// ============================================================================
// Account Layout Constants
// ============================================================================

/**
 * Byte offset of the `status` field in the on-chain Task account.
 *
 * Layout: 8 (discriminator) + 32 (task_id) + 32 (creator) + 8 (required_capabilities)
 *       + 64 (description) + 32 (constraint_hash) + 8 (reward_amount)
 *       + 1 (max_workers) + 1 (current_workers) = 186
 */
export const TASK_STATUS_OFFSET = 186;

const BINDING_SPEND_SEED = Buffer.from("binding_spend");
const NULLIFIER_SPEND_SEED = Buffer.from("nullifier_spend");
const ROUTER_SEED = Buffer.from("router");
const VERIFIER_SEED = Buffer.from("verifier");
const TRUSTED_RISC0_ROUTER_PROGRAM_ID = new PublicKey(
  "6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7",
);
const TRUSTED_RISC0_VERIFIER_PROGRAM_ID = new PublicKey(
  "THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge",
);

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for TaskOperations class.
 */
export interface TaskOpsConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** Agent ID (32 bytes) for deriving agent PDA */
  agentId: Uint8Array;
  /** Logger instance (defaults to silent logger) */
  logger?: Logger;
}

// ============================================================================
// TaskOperations Class
// ============================================================================

/**
 * On-chain task query and transaction operations.
 *
 * Provides methods for:
 * - Querying tasks and claims from the chain
 * - Submitting claim, complete, and completePrivate transactions
 * - Caching PDAs and protocol treasury for efficiency
 *
 * @example
 * ```typescript
 * const ops = new TaskOperations({
 *   program,
 *   agentId: myAgentId,
 * });
 *
 * const task = await ops.fetchTask(taskPda);
 * if (task) {
 *   const result = await ops.claimTask(taskPda, task);
 * }
 * ```
 */
export class TaskOperations {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly logger: Logger;

  // Cached PDAs
  private cachedAgentPda: PublicKey | null = null;
  private cachedProtocolTreasury: PublicKey | null = null;

  constructor(config: TaskOpsConfig) {
    this.program = config.program;
    this.agentId = new Uint8Array(config.agentId);
    this.logger = config.logger ?? silentLogger;
  }

  // ==========================================================================
  // Query Operations
  // ==========================================================================

  /**
   * Fetch a single task by its PDA address.
   *
   * @param taskPda - Task account PDA
   * @returns Parsed task or null if not found
   */
  async fetchTask(taskPda: PublicKey): Promise<OnChainTask | null> {
    try {
      const raw = await this.program.account.task.fetch(taskPda);
      return parseOnChainTask(raw);
    } catch (err) {
      if (isAccountNotFoundError(err)) {
        return null;
      }
      this.logger.error(`Failed to fetch task ${taskPda.toBase58()}: ${err}`);
      throw err;
    }
  }

  /**
   * Fetch a task by creator and task ID, also returning the derived PDA.
   *
   * @param creator - Task creator's public key
   * @param taskId - 32-byte task identifier
   * @returns Object with parsed task and PDA, or null if not found
   */
  async fetchTaskByIds(
    creator: PublicKey,
    taskId: Uint8Array,
  ): Promise<{ task: OnChainTask; taskPda: PublicKey } | null> {
    const { address: taskPda } = deriveTaskPda(
      creator,
      taskId,
      this.program.programId,
    );
    const task = await this.fetchTask(taskPda);
    if (!task) {
      return null;
    }
    return { task, taskPda };
  }

  /**
   * Fetch all tasks from the chain.
   *
   * @returns Array of all tasks with their PDAs
   */
  async fetchAllTasks(): Promise<
    Array<{ task: OnChainTask; taskPda: PublicKey }>
  > {
    const accounts = await this.program.account.task.all();
    return accounts.map((acc) => ({
      task: parseOnChainTask(acc.account),
      taskPda: acc.publicKey,
    }));
  }

  /**
   * Fetch all claimable tasks (Open or InProgress status).
   *
   * Uses server-side memcmp filters to query only accounts with the desired
   * status byte, avoiding downloading the entire task set. Falls back to
   * {@link fetchAllTasks} with client-side filtering if the filtered queries
   * fail (e.g. RPC does not support the filter).
   *
   * @returns Array of claimable tasks with their PDAs
   */
  async fetchClaimableTasks(): Promise<
    Array<{ task: OnChainTask; taskPda: PublicKey }>
  > {
    return queryWithFallback(
      async () => {
        const [openAccounts, inProgressAccounts] = await Promise.all([
          this.program.account.task.all([
            {
              memcmp: {
                offset: TASK_STATUS_OFFSET,
                bytes: encodeStatusByte(OnChainTaskStatus.Open),
              },
            },
          ]),
          this.program.account.task.all([
            {
              memcmp: {
                offset: TASK_STATUS_OFFSET,
                bytes: encodeStatusByte(OnChainTaskStatus.InProgress),
              },
            },
          ]),
        ]);

        const results: Array<{ task: OnChainTask; taskPda: PublicKey }> = [];
        for (const acc of openAccounts) {
          results.push({
            task: parseOnChainTask(acc.account),
            taskPda: acc.publicKey,
          });
        }
        for (const acc of inProgressAccounts) {
          results.push({
            task: parseOnChainTask(acc.account),
            taskPda: acc.publicKey,
          });
        }
        return results;
      },
      async () => {
        const all = await this.fetchAllTasks();
        return all.filter(
          ({ task }) =>
            task.status === OnChainTaskStatus.Open ||
            task.status === OnChainTaskStatus.InProgress,
        );
      },
      this.logger,
      "fetchClaimableTasks",
    );
  }

  /**
   * Fetch this agent's claim for a task.
   *
   * @param taskPda - Task account PDA
   * @returns Parsed claim or null if not found
   */
  async fetchClaim(taskPda: PublicKey): Promise<OnChainTaskClaim | null> {
    try {
      const agentPda = this.getAgentPda();
      const { address: claimPda } = deriveClaimPda(
        taskPda,
        agentPda,
        this.program.programId,
      );
      const raw = await this.program.account.taskClaim.fetch(claimPda);
      return parseOnChainTaskClaim(raw);
    } catch (err) {
      if (isAccountNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Fetch all active (uncompleted) claims for this agent.
   *
   * @returns Array of active claims with their PDAs and associated task PDAs
   */
  async fetchActiveClaims(): Promise<
    Array<{ claim: OnChainTaskClaim; claimPda: PublicKey; taskPda: PublicKey }>
  > {
    const agentPda = this.getAgentPda();
    const allClaims = await this.program.account.taskClaim.all();

    const results: Array<{
      claim: OnChainTaskClaim;
      claimPda: PublicKey;
      taskPda: PublicKey;
    }> = [];

    for (const acc of allClaims) {
      const claim = parseOnChainTaskClaim(acc.account);
      // Filter to this agent's uncompleted claims
      if (claim.worker.equals(agentPda) && !claim.isCompleted) {
        results.push({
          claim,
          claimPda: acc.publicKey,
          taskPda: claim.task,
        });
      }
    }

    return results;
  }

  /**
   * Fetch token escrow ATA balance for a token-denominated task.
   *
   * Returns 0 when the ATA does not exist (e.g. already closed).
   */
  async fetchEscrowTokenBalance(
    taskPda: PublicKey,
    rewardMint: PublicKey,
  ): Promise<bigint> {
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const escrowTokenAta = getAssociatedTokenAddressSync(
      rewardMint,
      escrowPda,
      true,
    );
    try {
      const balance =
        await this.program.provider.connection.getTokenAccountBalance(
          escrowTokenAta,
        );
      return BigInt(balance.value.amount);
    } catch (err) {
      if (isAccountNotFoundError(err)) {
        return 0n;
      }
      this.logger.error(
        `Failed to fetch escrow token balance for ${taskPda.toBase58()}: ${err}`,
      );
      throw err;
    }
  }

  // ==========================================================================
  // Transaction Operations
  // ==========================================================================

  /**
   * Claim a task for this agent.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @returns Claim result with signature and claim PDA
   */
  async claimTask(taskPda: PublicKey, task: OnChainTask): Promise<ClaimResult> {
    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const protocolPda = findProtocolPda(this.program.programId);

    this.logger.info(`Claiming task ${taskPda.toBase58()}`);

    try {
      const signature = await this.program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          protocolConfig: protocolPda,
          worker: workerPda,
          authority: this.program.provider.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.logger.info(`Task claimed: ${signature}`);

      return {
        success: true,
        taskId: task.taskId,
        claimPda,
        transactionSignature: signature,
      };
    } catch (err) {
      const parsed = parseAnchorError(err);
      if (parsed) {
        if (isAnchorError(err, AnchorErrorCodes.TaskFullyClaimed)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Task has reached maximum workers",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.TaskExpired)) {
          throw new TaskNotClaimableError(taskPda, "Task has expired");
        }
        if (isAnchorError(err, AnchorErrorCodes.InsufficientCapabilities)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Agent lacks required capabilities",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.TaskNotOpen)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Task is not open for claims",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.AlreadyClaimed)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Agent has already claimed this task",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.AgentNotActive)) {
          throw new TaskNotClaimableError(taskPda, "Agent is not active");
        }
        if (isAnchorError(err, AnchorErrorCodes.MaxActiveTasksReached)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Agent has reached maximum active tasks",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.InsufficientReputation)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Agent reputation below task minimum",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.InvalidStatusTransition)) {
          throw new TaskNotClaimableError(
            taskPda,
            "Invalid task status transition",
          );
        }
        if (isAnchorError(err, AnchorErrorCodes.SelfTaskNotAllowed)) {
          throw new TaskNotClaimableError(taskPda, "Cannot claim own task");
        }
      }
      this.logger.error(`Failed to claim task ${taskPda.toBase58()}: ${err}`);
      throw err;
    }
  }

  /**
   * Complete a task with a public proof.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param result - Task execution result with proof hash
   * @returns Completion result with signature
   */
  async completeTask(
    taskPda: PublicKey,
    task: OnChainTask,
    proofHash: Uint8Array,
    resultData: Uint8Array | null,
  ): Promise<CompleteResult> {
    // Input validation (#963)
    validateByteLength(proofHash, 32, "proofHash");
    validateNonZeroBytes(proofHash, "proofHash");
    if (resultData !== null) {
      validateByteLength(resultData, 64, "resultData");
    }

    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getProtocolTreasury();
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      this.program.provider.publicKey!,
      treasury,
    );

    this.logger.info(`Completing task ${taskPda.toBase58()}`);

    try {
      const signature = await this.program.methods
        .completeTask(
          toAnchorBytes(proofHash),
          resultData ? toAnchorBytes(resultData) : null,
        )
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          worker: workerPda,
          protocolConfig: protocolPda,
          treasury,
          authority: this.program.provider.publicKey,
          systemProgram: SystemProgram.programId,
          ...tokenAccounts,
        })
        .rpc();

      this.logger.info(`Task completed: ${signature}`);

      return {
        success: true,
        taskId: task.taskId,
        isPrivate: false,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to complete task ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Complete a task with a private ZK proof.
   *
   * @param taskPda - Task account PDA
   * @param task - The on-chain task data
   * @param sealBytes - Router seal bytes
   * @param journal - Fixed private journal bytes
   * @param imageId - Trusted image ID bytes
   * @param bindingSeed - 32-byte binding spend seed
   * @param nullifierSeed - 32-byte nullifier spend seed
   * @returns Completion result with signature
   */
  async completeTaskPrivate(
    taskPda: PublicKey,
    task: OnChainTask,
    sealBytes: Uint8Array,
    journal: Uint8Array,
    imageId: Uint8Array,
    bindingSeed: Uint8Array,
    nullifierSeed: Uint8Array,
  ): Promise<CompleteResult> {
    // Input validation (#963)
    validateByteLength(sealBytes, RISC0_SEAL_BORSH_LEN, "sealBytes");
    validateByteLength(journal, RISC0_JOURNAL_LEN, "journal");
    validateByteLength(imageId, RISC0_IMAGE_ID_LEN, "imageId");
    validateByteLength(bindingSeed, HASH_SIZE, "bindingSeed");
    validateByteLength(nullifierSeed, HASH_SIZE, "nullifierSeed");
    validateNonZeroBytes(imageId, "imageId");
    validateNonZeroBytes(bindingSeed, "bindingSeed");
    validateNonZeroBytes(nullifierSeed, "nullifierSeed");

    if (
      !Buffer.from(sealBytes.subarray(0, TRUSTED_RISC0_SELECTOR.length)).equals(
        Buffer.from(TRUSTED_RISC0_SELECTOR),
      )
    ) {
      throw new Error("sealBytes selector does not match trusted selector");
    }

    const workerPda = this.getAgentPda();
    const { address: claimPda } = deriveClaimPda(
      taskPda,
      workerPda,
      this.program.programId,
    );
    const { address: escrowPda } = deriveEscrowPda(
      taskPda,
      this.program.programId,
    );
    const protocolPda = findProtocolPda(this.program.programId);
    const [bindingSpend] = PublicKey.findProgramAddressSync(
      [BINDING_SPEND_SEED, Buffer.from(bindingSeed)],
      this.program.programId,
    );
    const [nullifierSpend] = PublicKey.findProgramAddressSync(
      [NULLIFIER_SPEND_SEED, Buffer.from(nullifierSeed)],
      this.program.programId,
    );
    const [router] = PublicKey.findProgramAddressSync(
      [ROUTER_SEED],
      TRUSTED_RISC0_ROUTER_PROGRAM_ID,
    );
    const [verifierEntry] = PublicKey.findProgramAddressSync(
      [VERIFIER_SEED, Buffer.from(TRUSTED_RISC0_SELECTOR)],
      TRUSTED_RISC0_ROUTER_PROGRAM_ID,
    );
    const treasury = await this.getProtocolTreasury();
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      this.program.provider.publicKey!,
      treasury,
    );

    this.logger.info(`Completing task privately ${taskPda.toBase58()}`);

    try {
      // task_id argument is a u64 on-chain, convert taskId bytes to number
      // The on-chain instruction uses task_id: u64 as a proof binding input
      const taskIdBN = new anchor.BN(task.taskId.slice(0, 8), "le");

      const proof = {
        sealBytes: toAnchorBytes(sealBytes),
        journal: toAnchorBytes(journal),
        imageId: toAnchorBytes(imageId),
        bindingSeed: toAnchorBytes(bindingSeed),
        nullifierSeed: toAnchorBytes(nullifierSeed),
      };

      const completeTaskPrivateMethod = this.program.methods as unknown as {
        completeTaskPrivate: (
          taskId: anchor.BN,
          proofArgs: typeof proof,
        ) => {
          accountsPartial: (accounts: Record<string, unknown>) => {
            rpc: () => Promise<string>;
          };
        };
      };

      const signature = await completeTaskPrivateMethod
        .completeTaskPrivate(taskIdBN, proof)
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          creator: task.creator,
          worker: workerPda,
          protocolConfig: protocolPda,
          bindingSpend,
          nullifierSpend,
          treasury,
          authority: this.program.provider.publicKey,
          routerProgram: TRUSTED_RISC0_ROUTER_PROGRAM_ID,
          router,
          verifierEntry,
          verifierProgram: TRUSTED_RISC0_VERIFIER_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ...tokenAccounts,
        })
        .rpc();

      this.logger.info(`Task completed privately: ${signature}`);

      return {
        success: true,
        taskId: task.taskId,
        isPrivate: true,
        transactionSignature: signature,
      };
    } catch (err) {
      this.logger.error(
        `Failed to complete task privately ${taskPda.toBase58()}: ${err}`,
      );
      throw new TaskSubmissionError(
        taskPda,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Get the agent PDA, caching for reuse.
   */
  private getAgentPda(): PublicKey {
    if (!this.cachedAgentPda) {
      this.cachedAgentPda = deriveAgentPda(
        this.agentId,
        this.program.programId,
      ).address;
    }
    return this.cachedAgentPda;
  }

  /**
   * Get the protocol treasury address, fetching and caching from protocolConfig.
   */
  private async getProtocolTreasury(): Promise<PublicKey> {
    if (this.cachedProtocolTreasury) {
      return this.cachedProtocolTreasury;
    }
    this.cachedProtocolTreasury = await fetchTreasury(
      this.program,
      this.program.programId,
    );
    return this.cachedProtocolTreasury;
  }
}

// ============================================================================
// Utility Helpers
// ============================================================================

/**
 * Checks if an error indicates an account was not found.
 */
function isAccountNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("Account does not exist") ||
      err.message.includes("could not find"))
  );
}
