/**
 * DisputeOperations - On-chain dispute query and transaction operations.
 *
 * Provides methods for fetching disputes/votes from the chain and submitting
 * initiate, vote, resolve, cancel, expire, and slash transactions.
 *
 * @module
 */

import { PublicKey, SystemProgram, type AccountMeta } from '@solana/web3.js';
import { toAnchorBytes } from '../utils/encoding.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type {
  OnChainDispute,
  OnChainDisputeVote,
  InitiateDisputeParams,
  VoteDisputeParams,
  ResolveDisputeParams,
  ExpireDisputeParams,
  ApplySlashParams,
  DisputeResult,
  VoteResult,
} from './types.js';
import {
  parseOnChainDispute,
  parseOnChainDisputeVote,
  OnChainDisputeStatus,
  DISPUTE_STATUS_OFFSET,
  DISPUTE_TASK_OFFSET,
} from './types.js';
import { deriveDisputePda, deriveVotePda } from './pda.js';
import { findAgentPda, findProtocolPda, deriveAuthorityVotePda } from '../agent/pda.js';
import { fetchTreasury } from '../utils/treasury.js';
import { deriveClaimPda, deriveEscrowPda } from '../task/pda.js';
import {
  isAnchorError,
  AnchorErrorCodes,
} from '../types/errors.js';
import {
  DisputeVoteError,
  DisputeResolutionError,
  DisputeSlashError,
} from './errors.js';
import { encodeStatusByte, queryWithFallback } from '../utils/query.js';
import type { MetricsProvider } from '../task/types.js';
import { TELEMETRY_METRIC_NAMES } from '../telemetry/metric-names.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for DisputeOperations class.
 */
export interface DisputeOpsConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** Agent ID (32 bytes) for deriving agent PDA */
  agentId: Uint8Array;
  /** Logger instance (defaults to silent logger) */
  logger?: Logger;
  /** Optional metrics provider for telemetry */
  metrics?: MetricsProvider;
}

// ============================================================================
// DisputeOperations Class
// ============================================================================

/**
 * On-chain dispute query and transaction operations.
 *
 * Provides methods for:
 * - Querying disputes and votes from the chain
 * - Submitting initiate, vote, resolve, cancel, expire, and slash transactions
 * - Caching PDAs and protocol treasury for efficiency
 *
 * @example
 * ```typescript
 * const ops = new DisputeOperations({
 *   program,
 *   agentId: myAgentId,
 * });
 *
 * const dispute = await ops.fetchDispute(disputePda);
 * if (dispute && dispute.status === OnChainDisputeStatus.Active) {
 *   await ops.voteOnDispute({ disputePda, taskPda, approve: true });
 * }
 * ```
 */
export class DisputeOperations {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly logger: Logger;
  private readonly metrics?: MetricsProvider;

  // Cached derived values
  private readonly agentPda: PublicKey;
  private readonly protocolPda: PublicKey;
  private cachedTreasury: PublicKey | null = null;

  constructor(config: DisputeOpsConfig) {
    this.program = config.program;
    this.agentId = new Uint8Array(config.agentId);
    this.logger = config.logger ?? silentLogger;
    this.metrics = config.metrics;

    this.agentPda = findAgentPda(this.agentId, this.program.programId);
    this.protocolPda = findProtocolPda(this.program.programId);
  }

  // ==========================================================================
  // Query Operations
  // ==========================================================================

  /**
   * Fetch a single dispute by its PDA address.
   *
   * @param disputePda - Dispute account PDA
   * @returns Parsed dispute or null if not found
   */
  async fetchDispute(disputePda: PublicKey): Promise<OnChainDispute | null> {
    try {
      const raw = await this.program.account.dispute.fetchNullable(disputePda);
      if (!raw) return null;
      return parseOnChainDispute(raw as Record<string, unknown>);
    } catch (err) {
      this.logger.error(`Failed to fetch dispute ${disputePda.toBase58()}: ${err}`);
      throw err;
    }
  }

  /**
   * Fetch a dispute by its ID, also returning the derived PDA.
   *
   * @param disputeId - 32-byte dispute identifier
   * @returns Object with parsed dispute and PDA, or null if not found
   */
  async fetchDisputeByIds(
    disputeId: Uint8Array,
  ): Promise<{ dispute: OnChainDispute; disputePda: PublicKey } | null> {
    const { address: disputePda } = deriveDisputePda(disputeId, this.program.programId);
    const dispute = await this.fetchDispute(disputePda);
    if (!dispute) return null;
    return { dispute, disputePda };
  }

  /**
   * Fetch all disputes from the chain.
   *
   * @returns Array of all disputes with their PDAs
   */
  async fetchAllDisputes(): Promise<Array<{ dispute: OnChainDispute; disputePda: PublicKey }>> {
    const accounts = await this.program.account.dispute.all();
    return accounts.map((acc) => ({
      dispute: parseOnChainDispute(acc.account as Record<string, unknown>),
      disputePda: acc.publicKey,
    }));
  }

  /**
   * Fetch all active disputes using memcmp filter on status field.
   *
   * @returns Array of active disputes with their PDAs
   */
  async fetchActiveDisputes(): Promise<Array<{ dispute: OnChainDispute; disputePda: PublicKey }>> {
    return queryWithFallback(
      async () => {
        const accounts = await this.program.account.dispute.all([
          {
            memcmp: {
              offset: DISPUTE_STATUS_OFFSET,
              bytes: encodeStatusByte(OnChainDisputeStatus.Active),
            },
          },
        ]);
        return accounts.map((acc) => ({
          dispute: parseOnChainDispute(acc.account as Record<string, unknown>),
          disputePda: acc.publicKey,
        }));
      },
      async () => {
        const all = await this.fetchAllDisputes();
        return all.filter(({ dispute }) => dispute.status === OnChainDisputeStatus.Active);
      },
      this.logger,
      'fetchActiveDisputes',
    );
  }

  /**
   * Fetch all disputes for a specific task using memcmp filter.
   *
   * @param taskPda - Task account PDA
   * @returns Array of disputes for the task
   */
  async fetchDisputesForTask(
    taskPda: PublicKey,
  ): Promise<Array<{ dispute: OnChainDispute; disputePda: PublicKey }>> {
    return queryWithFallback(
      async () => {
        const accounts = await this.program.account.dispute.all([
          {
            memcmp: {
              offset: DISPUTE_TASK_OFFSET,
              bytes: taskPda.toBase58(),
            },
          },
        ]);
        return accounts.map((acc) => ({
          dispute: parseOnChainDispute(acc.account as Record<string, unknown>),
          disputePda: acc.publicKey,
        }));
      },
      async () => {
        const all = await this.fetchAllDisputes();
        return all.filter(({ dispute }) => dispute.task.equals(taskPda));
      },
      this.logger,
      'fetchDisputesForTask',
    );
  }

  /**
   * Fetch a single dispute vote by its PDA address.
   *
   * @param votePda - Vote account PDA
   * @returns Parsed vote or null if not found
   */
  async fetchVote(votePda: PublicKey): Promise<OnChainDisputeVote | null> {
    try {
      const raw = await this.program.account.disputeVote.fetchNullable(votePda);
      if (!raw) return null;
      return parseOnChainDisputeVote(raw as Record<string, unknown>);
    } catch (err) {
      this.logger.error(`Failed to fetch vote ${votePda.toBase58()}: ${err}`);
      throw err;
    }
  }

  // ==========================================================================
  // Transaction Operations
  // ==========================================================================

  /**
   * Initiate a dispute for a task.
   *
   * @param params - Dispute initiation parameters
   * @returns Dispute result with PDA and transaction signature
   */
  async initiateDispute(params: InitiateDisputeParams): Promise<DisputeResult> {
    const start = Date.now();
    const { address: disputePda } = deriveDisputePda(params.disputeId, this.program.programId);
    const { address: claimPda } = deriveClaimPda(params.taskPda, this.agentPda, this.program.programId);

    this.logger.info(`Initiating dispute for task ${params.taskPda.toBase58()}`);

    try {
      const remainingAccounts = this.buildRemainingAccounts(undefined, params.defendantWorkers);

      const builder = this.program.methods
        .initiateDispute(
          toAnchorBytes(params.disputeId),
          toAnchorBytes(params.taskId),
          toAnchorBytes(params.evidenceHash),
          params.resolutionType,
          params.evidence,
        )
        .accountsPartial({
          dispute: disputePda,
          task: params.taskPda,
          agent: this.agentPda,
          protocolConfig: this.protocolPda,
          initiatorClaim: claimPda,
          workerAgent: params.workerAgentPda ?? null,
          workerClaim: params.workerClaimPda ?? null,
          authority: this.program.provider.publicKey,
          systemProgram: SystemProgram.programId,
        });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      this.logger.info(`Dispute initiated: ${signature}`);
      this.recordDisputeMetrics('initiate', Date.now() - start);

      return { disputePda, transactionSignature: signature };
    } catch (err) {
      const pda = disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.InsufficientEvidence)) {
        throw new DisputeResolutionError(pda, 'Insufficient evidence provided');
      }
      if (isAnchorError(err, AnchorErrorCodes.EvidenceTooLong)) {
        throw new DisputeResolutionError(pda, 'Evidence exceeds maximum allowed length');
      }
      if (isAnchorError(err, AnchorErrorCodes.InsufficientStakeForDispute)) {
        throw new DisputeResolutionError(pda, 'Insufficient stake to initiate dispute');
      }
      this.logger.error(`Failed to initiate dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Vote on an active dispute.
   *
   * @param params - Vote parameters
   * @returns Vote result with PDA and transaction signature
   */
  async voteOnDispute(params: VoteDisputeParams): Promise<VoteResult> {
    const start = Date.now();
    const { address: votePda } = deriveVotePda(
      params.disputePda,
      this.agentPda,
      this.program.programId,
    );
    const { address: authVotePda } = deriveAuthorityVotePda(
      params.disputePda,
      this.program.provider.publicKey!,
      this.program.programId,
    );

    this.logger.info(
      `Voting ${params.approve ? 'for' : 'against'} dispute ${params.disputePda.toBase58()}`
    );

    try {
      const signature = await this.program.methods
        .voteDispute(params.approve)
        .accountsPartial({
          dispute: params.disputePda,
          task: params.taskPda,
          workerClaim: params.workerClaimPda ?? null,
          vote: votePda,
          authorityVote: authVotePda,
          arbiter: this.agentPda,
          protocolConfig: this.protocolPda,
          authority: this.program.provider.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.logger.info(`Vote cast: ${signature}`);
      this.recordDisputeMetrics('vote', Date.now() - start);

      return { votePda, transactionSignature: signature };
    } catch (err) {
      const pda = params.disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotActive)) {
        throw new DisputeVoteError(pda, 'Dispute is not active');
      }
      if (isAnchorError(err, AnchorErrorCodes.VotingEnded)) {
        throw new DisputeVoteError(pda, 'Voting period has ended');
      }
      if (isAnchorError(err, AnchorErrorCodes.AlreadyVoted)) {
        throw new DisputeVoteError(pda, 'Already voted on this dispute');
      }
      if (isAnchorError(err, AnchorErrorCodes.NotArbiter)) {
        throw new DisputeVoteError(pda, 'Not authorized to vote (not an arbiter)');
      }
      this.logger.error(`Failed to vote on dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Resolve a dispute after voting period ends.
   *
   * @param params - Resolution parameters
   * @returns Dispute result with transaction signature
   */
  async resolveDispute(params: ResolveDisputeParams): Promise<DisputeResult> {
    const start = Date.now();
    const { address: escrowPda } = deriveEscrowPda(params.taskPda, this.program.programId);

    this.logger.info(`Resolving dispute ${params.disputePda.toBase58()}`);

    try {
      const remainingAccounts = this.buildRemainingAccounts(
        params.arbiterVotes,
        params.extraWorkers,
      );

      const builder = this.program.methods
        .resolveDispute()
        .accountsPartial({
          dispute: params.disputePda,
          task: params.taskPda,
          escrow: escrowPda,
          protocolConfig: this.protocolPda,
          resolver: this.program.provider.publicKey,
          creator: params.creatorPubkey,
          workerClaim: params.workerClaimPda ?? null,
          worker: params.workerAgentPda ?? null,
          workerAuthority: params.workerAuthority ?? null,
          systemProgram: SystemProgram.programId,
        });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      this.logger.info(`Dispute resolved: ${signature}`);
      this.recordDisputeMetrics('resolve', Date.now() - start);

      return { disputePda: params.disputePda, transactionSignature: signature };
    } catch (err) {
      const pda = params.disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotActive)) {
        throw new DisputeResolutionError(pda, 'Dispute is not active');
      }
      if (isAnchorError(err, AnchorErrorCodes.VotingNotEnded)) {
        throw new DisputeResolutionError(pda, 'Voting period has not ended');
      }
      if (isAnchorError(err, AnchorErrorCodes.InsufficientVotes)) {
        throw new DisputeResolutionError(pda, 'Insufficient votes to resolve');
      }
      if (isAnchorError(err, AnchorErrorCodes.UnauthorizedResolver)) {
        throw new DisputeResolutionError(pda, 'Not authorized to resolve this dispute');
      }
      if (isAnchorError(err, AnchorErrorCodes.DisputeAlreadyResolved)) {
        throw new DisputeResolutionError(pda, 'Dispute has already been resolved');
      }
      this.logger.error(`Failed to resolve dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Cancel a dispute (only by initiator, before votes are cast).
   *
   * @param disputePda - Dispute account PDA
   * @param taskPda - Task account PDA
   * @returns Dispute result with transaction signature
   */
  async cancelDispute(
    disputePda: PublicKey,
    taskPda: PublicKey,
  ): Promise<DisputeResult> {
    const start = Date.now();
    this.logger.info(`Cancelling dispute ${disputePda.toBase58()}`);

    try {
      const dispute = await this.fetchDispute(disputePda);
      if (!dispute) {
        throw new DisputeResolutionError(
          disputePda.toBase58(),
          'Dispute not found',
        );
      }

      const signature = await this.program.methods
        .cancelDispute()
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          authority: this.program.provider.publicKey,
        })
        .remainingAccounts([
          { pubkey: dispute.defendant, isSigner: false, isWritable: true },
        ])
        .rpc();

      this.logger.info(`Dispute cancelled: ${signature}`);
      this.recordDisputeMetrics('cancel', Date.now() - start);

      return { disputePda, transactionSignature: signature };
    } catch (err) {
      const pda = disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotActive)) {
        throw new DisputeResolutionError(pda, 'Dispute is not active');
      }
      if (isAnchorError(err, AnchorErrorCodes.UnauthorizedResolver)) {
        throw new DisputeResolutionError(pda, 'Only the dispute initiator can cancel');
      }
      this.logger.error(`Failed to cancel dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Expire a dispute after its expiration deadline.
   * This is a permissionless operation (no signer constraint beyond fee payer).
   *
   * @param params - Expiration parameters
   * @returns Dispute result with transaction signature
   */
  async expireDispute(params: ExpireDisputeParams): Promise<DisputeResult> {
    const start = Date.now();
    const { address: escrowPda } = deriveEscrowPda(params.taskPda, this.program.programId);

    this.logger.info(`Expiring dispute ${params.disputePda.toBase58()}`);

    try {
      const remainingAccounts = this.buildRemainingAccounts(
        params.arbiterVotes,
        params.extraWorkers,
      );

      const builder = this.program.methods
        .expireDispute()
        .accountsPartial({
          dispute: params.disputePda,
          task: params.taskPda,
          escrow: escrowPda,
          protocolConfig: this.protocolPda,
          creator: params.creatorPubkey,
          workerClaim: params.workerClaimPda ?? null,
          worker: params.workerAgentPda ?? null,
          workerAuthority: params.workerAuthority ?? null,
        });

      if (remainingAccounts.length > 0) {
        builder.remainingAccounts(remainingAccounts);
      }

      const signature = await builder.rpc();

      this.logger.info(`Dispute expired: ${signature}`);
      this.recordDisputeMetrics('expire', Date.now() - start);

      return { disputePda: params.disputePda, transactionSignature: signature };
    } catch (err) {
      const pda = params.disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotExpired)) {
        throw new DisputeResolutionError(pda, 'Dispute has not expired yet');
      }
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotActive)) {
        throw new DisputeResolutionError(pda, 'Dispute is not active');
      }
      this.logger.error(`Failed to expire dispute: ${err}`);
      throw err;
    }
  }

  /**
   * Apply a dispute slash to a worker's stake.
   * This is a permissionless operation (no signer constraint beyond fee payer).
   *
   * @param params - Slash parameters
   * @returns Dispute result with transaction signature
   */
  async applySlash(params: ApplySlashParams): Promise<DisputeResult> {
    const start = Date.now();
    const treasury = await this.getTreasury();

    this.logger.info(`Applying slash for dispute ${params.disputePda.toBase58()}`);

    try {
      const signature = await this.program.methods
        .applyDisputeSlash()
        .accountsPartial({
          dispute: params.disputePda,
          task: params.taskPda,
          workerClaim: params.workerClaimPda,
          workerAgent: params.workerAgentPda,
          protocolConfig: this.protocolPda,
          treasury,
        })
        .rpc();

      this.logger.info(`Slash applied: ${signature}`);
      this.recordDisputeMetrics('applySlash', Date.now() - start);

      return { disputePda: params.disputePda, transactionSignature: signature };
    } catch (err) {
      const pda = params.disputePda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.SlashAlreadyApplied)) {
        throw new DisputeSlashError(pda, 'Slash has already been applied');
      }
      if (isAnchorError(err, AnchorErrorCodes.DisputeNotResolved)) {
        throw new DisputeSlashError(pda, 'Dispute has not been resolved');
      }
      this.logger.error(`Failed to apply slash: ${err}`);
      throw err;
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private recordDisputeMetrics(operation: string, durationMs: number): void {
    if (!this.metrics) return;
    const labels = { operation };
    this.metrics.counter(TELEMETRY_METRIC_NAMES.DISPUTE_OPS_TOTAL, 1, labels);
    this.metrics.histogram(TELEMETRY_METRIC_NAMES.DISPUTE_OP_DURATION, durationMs, labels);
  }

  /**
   * Get the protocol treasury address, fetching and caching from protocolConfig.
   */
  private async getTreasury(): Promise<PublicKey> {
    if (this.cachedTreasury) return this.cachedTreasury;
    this.cachedTreasury = await fetchTreasury(this.program, this.program.programId);
    return this.cachedTreasury;
  }

  /**
   * Build remaining_accounts array from arbiter votes and worker pairs.
   *
   * Order: arbiter (vote, agent) pairs first, then worker (claim, agent) pairs.
   * All accounts are writable, non-signer.
   */
  private buildRemainingAccounts(
    arbiterVotes?: Array<{ votePda: PublicKey; arbiterAgentPda: PublicKey }>,
    workers?: Array<{ claimPda: PublicKey; workerPda: PublicKey }>,
  ): AccountMeta[] {
    const accounts: AccountMeta[] = [];
    for (const { votePda, arbiterAgentPda } of arbiterVotes ?? []) {
      accounts.push({ pubkey: votePda, isSigner: false, isWritable: true });
      accounts.push({ pubkey: arbiterAgentPda, isSigner: false, isWritable: true });
    }
    for (const { claimPda, workerPda } of workers ?? []) {
      accounts.push({ pubkey: claimPda, isSigner: false, isWritable: true });
      accounts.push({ pubkey: workerPda, isSigner: false, isWritable: true });
    }
    return accounts;
  }
}
