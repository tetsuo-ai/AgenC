/**
 * ReputationEconomyOperations — on-chain reputation staking, delegation, and portability.
 * @module
 */

import { PublicKey, SystemProgram, type Keypair } from '@solana/web3.js';
import { sign, createPrivateKey } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import anchor, { type Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { findAgentPda } from '../agent/pda.js';
import { deriveReputationStakePda, deriveReputationDelegationPda } from './pda.js';
import type {
  OnChainReputationStake,
  OnChainReputationDelegation,
  ReputationStakeParams,
  WithdrawStakeParams,
  ReputationDelegationParams,
  StakeResult,
  DelegationResult,
  WithdrawResult,
  RevokeResult,
  PortableReputationProof,
} from './types.js';
import {
  parseOnChainReputationStake,
  parseOnChainReputationDelegation,
  REPUTATION_MAX,
} from './types.js';
import {
  ReputationStakeError,
  ReputationDelegationError,
  ReputationWithdrawError,
  ReputationPortabilityError,
} from './errors.js';
// ============================================================================
// Configuration
// ============================================================================

/** Configuration for ReputationEconomyOperations */
export interface ReputationEconomyOpsConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** Agent ID (32 bytes) */
  agentId: Uint8Array;
  /** Logger (defaults to silent) */
  logger?: Logger;
  /** Chain identifier for portable reputation proofs (default: 'solana-devnet') */
  chainId?: string;
}

/** Ed25519 DER prefix for building signing keys */
const ED25519_DER_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// ============================================================================
// ReputationEconomyOperations
// ============================================================================

/**
 * On-chain reputation staking, delegation, and portability operations.
 */
export class ReputationEconomyOperations {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly logger: Logger;
  private readonly agentPda: PublicKey;
  private readonly chainId: string;

  constructor(config: ReputationEconomyOpsConfig) {
    this.program = config.program;
    this.agentId = new Uint8Array(config.agentId);
    this.logger = config.logger ?? silentLogger;
    this.chainId = config.chainId ?? 'solana-devnet';
    this.agentPda = findAgentPda(this.agentId, this.program.programId);
  }

  // ==========================================================================
  // Staking
  // ==========================================================================

  /**
   * Stake SOL on agent reputation.
   */
  async stakeReputation(params: ReputationStakeParams): Promise<StakeResult> {
    const { address: stakePda } = deriveReputationStakePda(
      this.agentPda,
      this.program.programId,
    );

    this.logger.info(`Staking ${params.amount} lamports on reputation`);

    try {
      const signature = await (this.program.methods as any)
        .stakeReputation(new anchor.BN(params.amount.toString()))
        .accountsPartial({
          authority: this.program.provider.publicKey,
          agent: this.agentPda,
          reputationStake: stakePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.logger.info(`Staked reputation: ${signature}`);
      return { stakePda, transactionSignature: signature };
    } catch (err) {
      throw new ReputationStakeError(
        (err as Error).message || 'Stake transaction failed',
      );
    }
  }

  /**
   * Withdraw SOL from reputation stake after cooldown.
   */
  async withdrawStake(params: WithdrawStakeParams): Promise<WithdrawResult> {
    const { address: stakePda } = deriveReputationStakePda(
      this.agentPda,
      this.program.programId,
    );

    this.logger.info(`Withdrawing ${params.amount} lamports from reputation stake`);

    try {
      const signature = await (this.program.methods as any)
        .withdrawReputationStake(new anchor.BN(params.amount.toString()))
        .accountsPartial({
          authority: this.program.provider.publicKey,
          agent: this.agentPda,
          reputationStake: stakePda,
        })
        .rpc();

      this.logger.info(`Withdrawn reputation stake: ${signature}`);
      return { transactionSignature: signature };
    } catch (err) {
      throw new ReputationWithdrawError(
        (err as Error).message || 'Withdraw transaction failed',
      );
    }
  }

  /**
   * Fetch reputation stake for an agent.
   */
  async getStake(agentPda?: PublicKey): Promise<OnChainReputationStake | null> {
    const target = agentPda ?? this.agentPda;
    const { address: stakePda } = deriveReputationStakePda(
      target,
      this.program.programId,
    );

    try {
      const raw = await (this.program.account as any).reputationStake.fetchNullable(stakePda);
      if (!raw) return null;
      return parseOnChainReputationStake(raw);
    } catch (err) {
      this.logger.error(`Failed to fetch reputation stake: ${err}`);
      return null;
    }
  }

  // ==========================================================================
  // Delegation
  // ==========================================================================

  /**
   * Delegate reputation points to a peer agent.
   */
  async delegateReputation(params: ReputationDelegationParams): Promise<DelegationResult> {
    const delegateePda = findAgentPda(params.delegateeId, this.program.programId);
    const { address: delegationPda } = deriveReputationDelegationPda(
      this.agentPda,
      delegateePda,
      this.program.programId,
    );

    this.logger.info(`Delegating ${params.amount} reputation points`);

    try {
      const expiresAt = params.expiresAt ?? 0;
      const signature = await (this.program.methods as any)
        .delegateReputation(params.amount, new anchor.BN(expiresAt))
        .accountsPartial({
          authority: this.program.provider.publicKey,
          delegatorAgent: this.agentPda,
          delegateeAgent: delegateePda,
          delegation: delegationPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.logger.info(`Delegated reputation: ${signature}`);
      return { delegationPda, transactionSignature: signature };
    } catch (err) {
      throw new ReputationDelegationError(
        (err as Error).message || 'Delegation transaction failed',
      );
    }
  }

  /**
   * Revoke a reputation delegation.
   */
  async revokeDelegation(delegateePda: PublicKey): Promise<RevokeResult> {
    const { address: delegationPda } = deriveReputationDelegationPda(
      this.agentPda,
      delegateePda,
      this.program.programId,
    );

    this.logger.info(`Revoking delegation to ${delegateePda.toBase58()}`);

    try {
      const signature = await (this.program.methods as any)
        .revokeDelegation()
        .accountsPartial({
          authority: this.program.provider.publicKey,
          delegatorAgent: this.agentPda,
          delegation: delegationPda,
        })
        .rpc();

      this.logger.info(`Revoked delegation: ${signature}`);
      return { transactionSignature: signature };
    } catch (err) {
      throw new ReputationDelegationError(
        (err as Error).message || 'Revoke transaction failed',
      );
    }
  }

  /**
   * Fetch a single delegation between two agents.
   */
  async getDelegation(
    delegatorPda: PublicKey,
    delegateePda: PublicKey,
  ): Promise<OnChainReputationDelegation | null> {
    const { address: delegationPda } = deriveReputationDelegationPda(
      delegatorPda,
      delegateePda,
      this.program.programId,
    );

    try {
      const raw = await (this.program.account as any).reputationDelegation.fetchNullable(delegationPda);
      if (!raw) return null;
      return parseOnChainReputationDelegation(raw);
    } catch (err) {
      this.logger.error(`Failed to fetch delegation: ${err}`);
      return null;
    }
  }

  /**
   * Fetch all delegations from an agent (outbound).
   */
  async getDelegationsFrom(
    agentPda: PublicKey,
  ): Promise<OnChainReputationDelegation[]> {
    try {
      const accounts = await (this.program.account as any).reputationDelegation.all([
        {
          memcmp: {
            offset: 8, // discriminator
            bytes: agentPda.toBase58(),
          },
        },
      ]);
      return accounts.map((acc: { account: any }) =>
        parseOnChainReputationDelegation(acc.account),
      );
    } catch (err) {
      this.logger.error(`Failed to fetch delegations from ${agentPda.toBase58()}: ${err}`);
      return [];
    }
  }

  /**
   * Fetch all delegations to an agent (inbound).
   */
  async getDelegationsTo(
    agentPda: PublicKey,
  ): Promise<OnChainReputationDelegation[]> {
    try {
      const accounts = await (this.program.account as any).reputationDelegation.all([
        {
          memcmp: {
            offset: 8 + 32, // discriminator + delegator pubkey
            bytes: agentPda.toBase58(),
          },
        },
      ]);
      return accounts.map((acc: { account: any }) =>
        parseOnChainReputationDelegation(acc.account),
      );
    } catch (err) {
      this.logger.error(`Failed to fetch delegations to ${agentPda.toBase58()}: ${err}`);
      return [];
    }
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  /**
   * Compute the effective reputation of an agent including non-expired delegations.
   * Capped at REPUTATION_MAX (10000).
   */
  async getEffectiveReputation(agentPda: PublicKey): Promise<number> {
    try {
      // Fetch base reputation from agent account
      const agent = await this.program.account.agentRegistration.fetchNullable(agentPda);
      if (!agent) return 0;

      const baseReputation = (agent as any).reputation as number;

      // Fetch inbound delegations
      const delegations = await this.getDelegationsTo(agentPda);

      // Sum non-expired delegation amounts
      const now = Math.floor(Date.now() / 1000);
      let delegatedTotal = 0;
      for (const d of delegations) {
        if (d.expiresAt === 0 || d.expiresAt > now) {
          delegatedTotal += d.amount;
        }
      }

      return Math.min(baseReputation + delegatedTotal, REPUTATION_MAX);
    } catch (err) {
      this.logger.error(`Failed to compute effective reputation: ${err}`);
      return 0;
    }
  }

  // ==========================================================================
  // Portability
  // ==========================================================================

  /**
   * Generate a portable reputation proof signed by the agent's keypair.
   * The proof can be verified off-chain by any party with the agent's public key.
   */
  async getPortableReputationProof(
    keypair: Keypair,
  ): Promise<PortableReputationProof> {
    try {
      // Fetch agent state
      const agent = await this.program.account.agentRegistration.fetchNullable(this.agentPda);
      if (!agent) {
        throw new ReputationPortabilityError('Agent not registered');
      }

      // Fetch stake
      const stake = await this.getStake();

      // Fetch inbound delegation count
      const delegations = await this.getDelegationsTo(this.agentPda);

      const now = Math.floor(Date.now() / 1000);
      const nonce = randomBytes(16).toString('hex');

      const proof: PortableReputationProof = {
        agentId: new Uint8Array((agent as any).agentId),
        agentPda: this.agentPda.toBase58(),
        reputation: (agent as any).reputation as number,
        stakedAmount: stake ? stake.stakedAmount.toString() : '0',
        tasksCompleted: BigInt((agent as any).tasksCompleted.toString()).toString(),
        totalEarned: BigInt((agent as any).totalEarned.toString()).toString(),
        delegationsReceived: delegations.length,
        timestamp: now,
        nonce,
        chainId: this.chainId,
        programId: this.program.programId.toBase58(),
        signature: new Uint8Array(0), // placeholder, will be replaced
      };

      // Build signing payload (deterministic serialization)
      const payload = buildProofPayload(proof);

      // Sign with ed25519 using node:crypto
      const derKey = createPrivateKey({
        key: Buffer.concat([ED25519_DER_PREFIX, keypair.secretKey.slice(0, 32)]),
        format: 'der',
        type: 'pkcs8',
      });
      const sig = sign(null, payload, derKey);

      proof.signature = new Uint8Array(sig);
      return proof;
    } catch (err) {
      if (err instanceof ReputationPortabilityError) throw err;
      throw new ReputationPortabilityError(
        (err as Error).message || 'Unknown error generating proof',
      );
    }
  }
}

/**
 * Build a deterministic signing payload from a portable reputation proof.
 * Excludes the signature field itself.
 */
function buildProofPayload(proof: PortableReputationProof): Buffer {
  const parts = [
    proof.agentPda,
    proof.reputation.toString(),
    proof.stakedAmount,
    proof.tasksCompleted,
    proof.totalEarned,
    proof.delegationsReceived.toString(),
    proof.timestamp.toString(),
    proof.nonce,
    proof.chainId,
    proof.programId,
  ];
  return Buffer.from(parts.join('|'), 'utf-8');
}
