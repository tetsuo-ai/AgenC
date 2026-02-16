/**
 * Types for the reputation economy module
 * @module
 */

import type { PublicKey } from '@solana/web3.js';

// ============================================================================
// Constants
// ============================================================================

/** Cooldown period before staked SOL can be withdrawn (7 days in seconds) */
export const REPUTATION_STAKING_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

/** Minimum delegation amount in reputation points (1% of max reputation) */
export const MIN_DELEGATION_AMOUNT = 100;

/** Maximum reputation score */
export const REPUTATION_MAX = 10_000;

// ============================================================================
// On-Chain Account Types
// ============================================================================

/** Parsed on-chain ReputationStake account */
export interface OnChainReputationStake {
  /** Agent PDA this stake belongs to */
  agent: PublicKey;
  /** SOL lamports currently staked */
  stakedAmount: bigint;
  /** Timestamp before which withdrawals are blocked */
  lockedUntil: number;
  /** Historical count of slashes applied */
  slashCount: number;
  /** Account creation timestamp */
  createdAt: number;
  /** PDA bump seed */
  bump: number;
}

/** Parsed on-chain ReputationDelegation account */
export interface OnChainReputationDelegation {
  /** Delegator agent PDA */
  delegator: PublicKey;
  /** Delegatee agent PDA */
  delegatee: PublicKey;
  /** Reputation points delegated (0-10000 scale) */
  amount: number;
  /** Expiration timestamp (0 = no expiry) */
  expiresAt: number;
  /** Delegation creation timestamp */
  createdAt: number;
  /** PDA bump seed */
  bump: number;
}

// ============================================================================
// Operation Params
// ============================================================================

/** Parameters for staking reputation */
export interface ReputationStakeParams {
  /** Amount of lamports to stake */
  amount: bigint;
}

/** Parameters for withdrawing reputation stake */
export interface WithdrawStakeParams {
  /** Amount of lamports to withdraw */
  amount: bigint;
}

/** Parameters for delegating reputation */
export interface ReputationDelegationParams {
  /** Delegatee agent ID (32 bytes) */
  delegateeId: Uint8Array;
  /** Reputation points to delegate (MIN_DELEGATION_AMOUNT..10000) */
  amount: number;
  /** Optional expiration timestamp (0 or omitted = no expiry) */
  expiresAt?: number;
}

// ============================================================================
// Operation Results
// ============================================================================

/** Result of a stake operation */
export interface StakeResult {
  /** Reputation stake PDA */
  stakePda: PublicKey;
  /** Transaction signature */
  transactionSignature: string;
}

/** Result of a delegation operation */
export interface DelegationResult {
  /** Delegation PDA */
  delegationPda: PublicKey;
  /** Transaction signature */
  transactionSignature: string;
}

/** Result of a withdrawal operation */
export interface WithdrawResult {
  /** Transaction signature */
  transactionSignature: string;
}

/** Result of a revoke operation */
export interface RevokeResult {
  /** Transaction signature */
  transactionSignature: string;
}

/** Portable reputation proof signed by agent authority */
export interface PortableReputationProof {
  /** Agent ID (32 bytes) */
  agentId: Uint8Array;
  /** Agent PDA (base58) */
  agentPda: string;
  /** Reputation score (0-10000) */
  reputation: number;
  /** SOL lamports staked (bigint as string for JSON safety) */
  stakedAmount: string;
  /** Total tasks completed (bigint as string) */
  tasksCompleted: string;
  /** Total SOL earned (bigint as string) */
  totalEarned: string;
  /** Number of inbound delegations received */
  delegationsReceived: number;
  /** Unix timestamp of proof generation */
  timestamp: number;
  /** Random nonce for replay protection (hex string) */
  nonce: string;
  /** Chain identifier */
  chainId: string;
  /** Program ID (base58) */
  programId: string;
  /** Ed25519 signature by agent authority */
  signature: Uint8Array;
}

// ============================================================================
// Parse Functions
// ============================================================================

/**
 * Parses raw Anchor account data into OnChainReputationStake.
 */
export function parseOnChainReputationStake(raw: {
  agent: PublicKey;
  stakedAmount: { toString(): string };
  lockedUntil: { toNumber(): number };
  slashCount: number;
  createdAt: { toNumber(): number };
  bump: number;
}): OnChainReputationStake {
  return {
    agent: raw.agent,
    stakedAmount: BigInt(raw.stakedAmount.toString()),
    lockedUntil: raw.lockedUntil.toNumber(),
    slashCount: raw.slashCount,
    createdAt: raw.createdAt.toNumber(),
    bump: raw.bump,
  };
}

/**
 * Parses raw Anchor account data into OnChainReputationDelegation.
 */
export function parseOnChainReputationDelegation(raw: {
  delegator: PublicKey;
  delegatee: PublicKey;
  amount: number;
  expiresAt: { toNumber(): number };
  createdAt: { toNumber(): number };
  bump: number;
}): OnChainReputationDelegation {
  return {
    delegator: raw.delegator,
    delegatee: raw.delegatee,
    amount: raw.amount,
    expiresAt: raw.expiresAt.toNumber(),
    createdAt: raw.createdAt.toNumber(),
    bump: raw.bump,
  };
}
