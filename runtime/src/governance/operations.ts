/**
 * GovernanceOperations - On-chain governance query and transaction operations.
 *
 * Provides methods for creating proposals, voting, executing, cancelling,
 * and querying governance state from the chain.
 *
 * @module
 */

import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type {
  OnChainProposal,
  OnChainGovernanceVote,
  OnChainGovernanceConfig,
  CreateProposalParams,
  VoteProposalParams,
  ExecuteProposalParams,
  CancelProposalParams,
  InitializeGovernanceParams,
  ProposalResult,
  GovernanceVoteResult,
  ProposalWithVotes,
} from "./types.js";
import {
  parseOnChainProposal,
  parseOnChainGovernanceVote,
  parseOnChainGovernanceConfig,
  ProposalStatus,
  PROPOSAL_STATUS_OFFSET,
} from "./types.js";
import {
  deriveProposalPda,
  deriveGovernanceVotePda,
  findGovernanceConfigPda,
} from "./pda.js";
import { findAgentPda, findProtocolPda } from "../agent/pda.js";
import { isAnchorError, AnchorErrorCodes } from "../types/errors.js";
import {
  GovernanceVoteError,
  GovernanceExecutionError,
  GovernanceProposalNotFoundError,
} from "./errors.js";
import { encodeStatusByte, queryWithFallback } from "../utils/query.js";

// ============================================================================
// Configuration
// ============================================================================

export interface GovernanceOpsConfig {
  program: Program<AgencCoordination>;
  agentId: Uint8Array;
  logger?: Logger;
}

// ============================================================================
// GovernanceOperations Class
// ============================================================================

export class GovernanceOperations {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly logger: Logger;
  private readonly agentPda: PublicKey;
  private readonly protocolPda: PublicKey;
  private readonly governanceConfigPda: PublicKey;

  constructor(config: GovernanceOpsConfig) {
    this.program = config.program;
    this.agentId = new Uint8Array(config.agentId);
    this.logger = config.logger ?? silentLogger;
    this.agentPda = findAgentPda(this.agentId, this.program.programId);
    this.protocolPda = findProtocolPda(this.program.programId);
    this.governanceConfigPda = findGovernanceConfigPda(this.program.programId);
  }

  // ==========================================================================
  // Query Operations
  // ==========================================================================

  async fetchGovernanceConfig(): Promise<OnChainGovernanceConfig | null> {
    try {
      const raw = await (
        this.program.account as any
      ).governanceConfig.fetchNullable(this.governanceConfigPda);
      if (!raw) return null;
      return parseOnChainGovernanceConfig(raw as Record<string, unknown>);
    } catch (err) {
      this.logger.error(`Failed to fetch governance config: ${err}`);
      throw err;
    }
  }

  async fetchProposal(proposalPda: PublicKey): Promise<OnChainProposal | null> {
    try {
      const raw = await (this.program.account as any).proposal.fetchNullable(
        proposalPda,
      );
      if (!raw) return null;
      return parseOnChainProposal(raw as Record<string, unknown>);
    } catch (err) {
      this.logger.error(
        `Failed to fetch proposal ${proposalPda.toBase58()}: ${err}`,
      );
      throw err;
    }
  }

  async fetchAllProposals(): Promise<
    Array<{ proposal: OnChainProposal; proposalPda: PublicKey }>
  > {
    const accounts = await (this.program.account as any).proposal.all();
    return accounts.map((acc: any) => ({
      proposal: parseOnChainProposal(acc.account as Record<string, unknown>),
      proposalPda: acc.publicKey,
    }));
  }

  async fetchActiveProposals(): Promise<
    Array<{ proposal: OnChainProposal; proposalPda: PublicKey }>
  > {
    return queryWithFallback(
      async () => {
        const accounts = await (this.program.account as any).proposal.all([
          {
            memcmp: {
              offset: PROPOSAL_STATUS_OFFSET,
              bytes: encodeStatusByte(ProposalStatus.Active),
            },
          },
        ]);
        return accounts.map((acc: any) => ({
          proposal: parseOnChainProposal(
            acc.account as Record<string, unknown>,
          ),
          proposalPda: acc.publicKey,
        }));
      },
      async () => {
        const all = await this.fetchAllProposals();
        return all.filter(
          ({ proposal }) => proposal.status === ProposalStatus.Active,
        );
      },
      this.logger,
      "fetchActiveProposals",
    );
  }

  async fetchGovernanceVote(
    votePda: PublicKey,
  ): Promise<OnChainGovernanceVote | null> {
    try {
      const raw = await (
        this.program.account as any
      ).governanceVote.fetchNullable(votePda);
      if (!raw) return null;
      return parseOnChainGovernanceVote(raw as Record<string, unknown>);
    } catch (err) {
      this.logger.error(
        `Failed to fetch governance vote ${votePda.toBase58()}: ${err}`,
      );
      throw err;
    }
  }

  async getProposal(proposalPda: PublicKey): Promise<ProposalWithVotes | null> {
    const proposal = await this.fetchProposal(proposalPda);
    if (!proposal) return null;

    // Fetch all governance vote accounts filtered by proposal
    const voteAccounts = await (this.program.account as any).governanceVote.all(
      [
        {
          memcmp: {
            offset: 8, // discriminator, then proposal pubkey
            bytes: proposalPda.toBase58(),
          },
        },
      ],
    );

    const votes = voteAccounts.map((acc: any) =>
      parseOnChainGovernanceVote(acc.account as Record<string, unknown>),
    );

    return { ...proposal, proposalPda, votes };
  }

  // ==========================================================================
  // Transaction Operations
  // ==========================================================================

  async initializeGovernance(
    params: InitializeGovernanceParams,
  ): Promise<{ governanceConfigPda: PublicKey; transactionSignature: string }> {
    this.logger.info("Initializing governance configuration");

    const signature = await (this.program.methods as any)
      .initializeGovernance(
        params.votingPeriod,
        params.executionDelay,
        params.quorumBps,
        params.approvalThresholdBps,
        params.minProposalStake,
      )
      .accountsPartial({
        governanceConfig: this.governanceConfigPda,
        protocolConfig: this.protocolPda,
        authority: this.program.provider.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    this.logger.info(`Governance initialized: ${signature}`);
    return {
      governanceConfigPda: this.governanceConfigPda,
      transactionSignature: signature,
    };
  }

  async createProposal(params: CreateProposalParams): Promise<ProposalResult> {
    const { address: proposalPda } = deriveProposalPda(
      this.agentPda,
      params.nonce,
      this.program.programId,
    );

    this.logger.info(`Creating proposal ${proposalPda.toBase58()}`);

    const payload = new Uint8Array(64);
    payload.set(params.payload.slice(0, 64));

    const signature = await (this.program.methods as any)
      .createProposal(
        params.nonce,
        params.proposalType,
        Array.from(params.titleHash),
        Array.from(params.descriptionHash),
        Array.from(payload),
        params.votingPeriod,
      )
      .accountsPartial({
        proposal: proposalPda,
        proposer: this.agentPda,
        protocolConfig: this.protocolPda,
        governanceConfig: this.governanceConfigPda,
        authority: this.program.provider.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    this.logger.info(`Proposal created: ${signature}`);
    return { proposalPda, transactionSignature: signature };
  }

  async vote(params: VoteProposalParams): Promise<GovernanceVoteResult> {
    const authority = this.program.provider.publicKey;
    if (!authority) {
      throw new Error("Provider public key is required for governance voting");
    }

    const { address: votePda } = deriveGovernanceVotePda(
      params.proposalPda,
      authority,
      this.program.programId,
    );

    this.logger.info(
      `Voting ${params.approve ? "for" : "against"} proposal ${params.proposalPda.toBase58()}`,
    );

    try {
      const signature = await (this.program.methods as any)
        .voteProposal(params.approve)
        .accountsPartial({
          proposal: params.proposalPda,
          vote: votePda,
          voter: this.agentPda,
          protocolConfig: this.protocolPda,
          authority,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.logger.info(`Vote cast: ${signature}`);
      return { votePda, transactionSignature: signature };
    } catch (err) {
      const pda = params.proposalPda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.ProposalNotActive)) {
        throw new GovernanceVoteError(pda, "Proposal is not active");
      }
      if (isAnchorError(err, AnchorErrorCodes.ProposalVotingEnded)) {
        throw new GovernanceVoteError(pda, "Voting period has ended");
      }
      this.logger.error(`Failed to vote on proposal: ${err}`);
      throw err;
    }
  }

  async executeProposal(
    params: ExecuteProposalParams,
  ): Promise<ProposalResult> {
    this.logger.info(`Executing proposal ${params.proposalPda.toBase58()}`);

    try {
      const signature = await (this.program.methods as any)
        .executeProposal()
        .accountsPartial({
          proposal: params.proposalPda,
          protocolConfig: this.protocolPda,
          governanceConfig: this.governanceConfigPda,
          executor: this.program.provider.publicKey,
          treasury: params.treasuryPubkey ?? null,
          recipient: params.recipientPubkey ?? null,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.logger.info(`Proposal executed: ${signature}`);
      return {
        proposalPda: params.proposalPda,
        transactionSignature: signature,
      };
    } catch (err) {
      const pda = params.proposalPda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.ProposalNotActive)) {
        throw new GovernanceExecutionError(pda, "Proposal is not active");
      }
      if (isAnchorError(err, AnchorErrorCodes.ProposalVotingNotEnded)) {
        throw new GovernanceExecutionError(pda, "Voting period has not ended");
      }
      if (isAnchorError(err, AnchorErrorCodes.TimelockNotElapsed)) {
        throw new GovernanceExecutionError(
          pda,
          "Execution timelock has not elapsed",
        );
      }
      if (isAnchorError(err, AnchorErrorCodes.ProposalInsufficientQuorum)) {
        throw new GovernanceExecutionError(
          pda,
          "Insufficient quorum for proposal execution",
        );
      }
      if (isAnchorError(err, AnchorErrorCodes.ProposalNotApproved)) {
        throw new GovernanceExecutionError(
          pda,
          "Proposal did not achieve majority",
        );
      }
      this.logger.error(`Failed to execute proposal: ${err}`);
      throw err;
    }
  }

  async cancelProposal(params: CancelProposalParams): Promise<ProposalResult> {
    this.logger.info(`Cancelling proposal ${params.proposalPda.toBase58()}`);

    try {
      const signature = await (this.program.methods as any)
        .cancelProposal()
        .accountsPartial({
          proposal: params.proposalPda,
          authority: this.program.provider.publicKey,
        })
        .rpc();

      this.logger.info(`Proposal cancelled: ${signature}`);
      return {
        proposalPda: params.proposalPda,
        transactionSignature: signature,
      };
    } catch (err) {
      const pda = params.proposalPda.toBase58();
      if (isAnchorError(err, AnchorErrorCodes.ProposalNotActive)) {
        throw new GovernanceProposalNotFoundError(pda);
      }
      if (isAnchorError(err, AnchorErrorCodes.ProposalUnauthorizedCancel)) {
        throw new GovernanceExecutionError(pda, "Only the proposer can cancel");
      }
      this.logger.error(`Failed to cancel proposal: ${err}`);
      throw err;
    }
  }
}
