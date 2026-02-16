/**
 * Governance type definitions, parsing utilities, and parameter types.
 *
 * @module
 */

import type { PublicKey } from '@solana/web3.js';
import { toUint8Array } from '../utils/encoding.js';

// ============================================================================
// On-Chain Enums (match state.rs)
// ============================================================================

export enum ProposalType {
  ProtocolUpgrade = 0,
  FeeChange = 1,
  TreasurySpend = 2,
  RateLimitChange = 3,
}

export enum ProposalStatus {
  Active = 0,
  Executed = 1,
  Defeated = 2,
  Cancelled = 3,
}

// ============================================================================
// Account Layout Constants
// ============================================================================

/**
 * Byte offset of the `status` field in the on-chain Proposal account.
 *
 * Layout: 8 (disc) + 32 (proposer) + 32 (proposer_authority) + 8 (nonce)
 *       + 1 (proposal_type) + 32 (title_hash) + 32 (description_hash)
 *       + 64 (payload) = 209
 */
export const PROPOSAL_STATUS_OFFSET = 209;

// ============================================================================
// Parsed On-Chain Interfaces
// ============================================================================

export interface OnChainProposal {
  proposer: PublicKey;
  proposerAuthority: PublicKey;
  nonce: bigint;
  proposalType: ProposalType;
  titleHash: Uint8Array;
  descriptionHash: Uint8Array;
  payload: Uint8Array;
  status: ProposalStatus;
  createdAt: number;
  votingDeadline: number;
  executionAfter: number;
  executedAt: number;
  votesFor: bigint;
  votesAgainst: bigint;
  totalVoters: number;
  quorum: bigint;
  bump: number;
}

export interface OnChainGovernanceVote {
  proposal: PublicKey;
  voter: PublicKey;
  approved: boolean;
  votedAt: number;
  voteWeight: bigint;
  bump: number;
}

// ============================================================================
// Parameter Types
// ============================================================================

export interface CreateProposalParams {
  nonce: bigint;
  proposalType: ProposalType;
  titleHash: Uint8Array;
  descriptionHash: Uint8Array;
  payload: Uint8Array;
  votingPeriod: number;
}

export interface VoteProposalParams {
  proposalPda: PublicKey;
  approve: boolean;
}

export interface ExecuteProposalParams {
  proposalPda: PublicKey;
  treasuryPubkey?: PublicKey;
  recipientPubkey?: PublicKey;
}

export interface CancelProposalParams {
  proposalPda: PublicKey;
}

export interface InitializeGovernanceParams {
  votingPeriod: number;
  executionDelay: number;
  quorumBps: number;
  approvalThresholdBps: number;
  minProposalStake: bigint;
}

// ============================================================================
// GovernanceConfig On-Chain Interface
// ============================================================================

export interface OnChainGovernanceConfig {
  authority: PublicKey;
  minProposalStake: bigint;
  votingPeriod: number;
  executionDelay: number;
  quorumBps: number;
  approvalThresholdBps: number;
  totalProposals: bigint;
  bump: number;
}

export function parseOnChainGovernanceConfig(raw: Record<string, unknown>): OnChainGovernanceConfig {
  const r = raw as Record<string, any>;
  return {
    authority: r.authority,
    minProposalStake: toBNBigint(r.minProposalStake),
    votingPeriod: toBNNumber(r.votingPeriod),
    executionDelay: toBNNumber(r.executionDelay),
    quorumBps: typeof r.quorumBps === 'number' ? r.quorumBps : Number(r.quorumBps),
    approvalThresholdBps:
      typeof r.approvalThresholdBps === 'number'
        ? r.approvalThresholdBps
        : Number(r.approvalThresholdBps),
    totalProposals: toBNBigint(r.totalProposals),
    bump: typeof r.bump === 'number' ? r.bump : Number(r.bump),
  };
}

// ============================================================================
// Result Types
// ============================================================================

export interface ProposalResult {
  proposalPda: PublicKey;
  transactionSignature: string;
}

export interface GovernanceVoteResult {
  votePda: PublicKey;
  transactionSignature: string;
}

export interface ProposalWithVotes extends OnChainProposal {
  proposalPda: PublicKey;
  votes: OnChainGovernanceVote[];
}

// ============================================================================
// Parse Functions
// ============================================================================

export function parseOnChainProposal(raw: Record<string, unknown>): OnChainProposal {
  const r = raw as Record<string, any>;
  return {
    proposer: r.proposer,
    proposerAuthority: r.proposerAuthority,
    nonce: toBNBigint(r.nonce),
    proposalType: parseProposalType(r.proposalType),
    titleHash: toUint8Array(r.titleHash),
    descriptionHash: toUint8Array(r.descriptionHash),
    payload: toUint8Array(r.payload),
    status: parseProposalStatus(r.status),
    createdAt: toBNNumber(r.createdAt),
    votingDeadline: toBNNumber(r.votingDeadline),
    executionAfter: toBNNumber(r.executionAfter),
    executedAt: toBNNumber(r.executedAt),
    votesFor: toBNBigint(r.votesFor),
    votesAgainst: toBNBigint(r.votesAgainst),
    totalVoters: typeof r.totalVoters === 'number' ? r.totalVoters : Number(r.totalVoters),
    quorum: toBNBigint(r.quorum),
    bump: typeof r.bump === 'number' ? r.bump : Number(r.bump),
  };
}

export function parseOnChainGovernanceVote(raw: Record<string, unknown>): OnChainGovernanceVote {
  const r = raw as Record<string, any>;
  return {
    proposal: r.proposal,
    voter: r.voter,
    approved: Boolean(r.approved),
    votedAt: toBNNumber(r.votedAt),
    voteWeight: toBNBigint(r.voteWeight),
    bump: typeof r.bump === 'number' ? r.bump : Number(r.bump),
  };
}

export function proposalStatusToString(status: ProposalStatus): string {
  switch (status) {
    case ProposalStatus.Active:
      return 'Active';
    case ProposalStatus.Executed:
      return 'Executed';
    case ProposalStatus.Defeated:
      return 'Defeated';
    case ProposalStatus.Cancelled:
      return 'Cancelled';
    default:
      return `Unknown(${status})`;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

function toBNNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  if (val && typeof (val as any).toNumber === 'function') return (val as any).toNumber();
  return Number(val);
}

function toBNBigint(val: unknown): bigint {
  if (typeof val === 'bigint') return val;
  if (val && typeof (val as any).toString === 'function') return BigInt((val as any).toString());
  return BigInt(String(val));
}

function parseProposalType(val: unknown): ProposalType {
  if (typeof val === 'number') return val as ProposalType;
  if (val && typeof val === 'object') {
    if ('protocolUpgrade' in val) return ProposalType.ProtocolUpgrade;
    if ('feeChange' in val) return ProposalType.FeeChange;
    if ('treasurySpend' in val) return ProposalType.TreasurySpend;
    if ('rateLimitChange' in val) return ProposalType.RateLimitChange;
  }
  return Number(val) as ProposalType;
}

function parseProposalStatus(val: unknown): ProposalStatus {
  if (typeof val === 'number') return val as ProposalStatus;
  if (val && typeof val === 'object') {
    if ('active' in val) return ProposalStatus.Active;
    if ('executed' in val) return ProposalStatus.Executed;
    if ('defeated' in val) return ProposalStatus.Defeated;
    if ('cancelled' in val) return ProposalStatus.Cancelled;
  }
  return Number(val) as ProposalStatus;
}
