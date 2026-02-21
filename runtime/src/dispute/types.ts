/**
 * Dispute type definitions, parsing utilities, and parameter types
 * for the Phase 8 Dispute Operations module.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import { ResolutionType } from "../events/types.js";
import { toUint8Array } from "../utils/encoding.js";

// Re-export ResolutionType for consumers importing from dispute module
export { ResolutionType } from "../events/types.js";

// ============================================================================
// On-Chain Dispute Status Enum (matches state.rs DisputeStatus)
// ============================================================================

/**
 * Dispute status values matching on-chain enum.
 * Stored as u8 on-chain.
 */
export enum OnChainDisputeStatus {
  /** Dispute is active and accepting votes */
  Active = 0,
  /** Dispute has been resolved */
  Resolved = 1,
  /** Dispute has expired */
  Expired = 2,
  /** Dispute was cancelled by initiator */
  Cancelled = 3,
}

// ============================================================================
// Account Layout Constants
// ============================================================================

/**
 * Byte offset of the `status` field in the on-chain Dispute account.
 *
 * Layout: 8 (discriminator) + 32 (dispute_id) + 32 (task) + 32 (initiator)
 *       + 32 (initiator_authority) + 32 (evidence_hash) + 1 (resolution_type) = 169
 */
export const DISPUTE_STATUS_OFFSET = 169;

/**
 * Byte offset of the `task` field in the on-chain Dispute account.
 *
 * Layout: 8 (discriminator) + 32 (dispute_id) = 40
 */
export const DISPUTE_TASK_OFFSET = 40;

// ============================================================================
// On-Chain Interfaces (parsed, developer-friendly types)
// ============================================================================

/**
 * Parsed on-chain Dispute account data.
 * Matches the state.rs Dispute struct with TypeScript-native types.
 * PDA seeds: ["dispute", dispute_id]
 */
export interface OnChainDispute {
  /** Dispute identifier (32 bytes) */
  disputeId: Uint8Array;
  /** Related task PDA */
  task: PublicKey;
  /** Initiator agent PDA */
  initiator: PublicKey;
  /** Initiator's authority wallet */
  initiatorAuthority: PublicKey;
  /** Evidence hash (32 bytes) */
  evidenceHash: Uint8Array;
  /** Proposed resolution type */
  resolutionType: ResolutionType;
  /** Current dispute status */
  status: OnChainDisputeStatus;
  /** Creation timestamp (Unix seconds) */
  createdAt: number;
  /** Resolution timestamp (Unix seconds, 0 if unresolved) */
  resolvedAt: number;
  /** Votes for approval (u64 as bigint) */
  votesFor: bigint;
  /** Votes against (u64 as bigint) */
  votesAgainst: bigint;
  /** Total arbiters who voted */
  totalVoters: number;
  /** Voting deadline (Unix seconds) */
  votingDeadline: number;
  /** Dispute expiration (Unix seconds) */
  expiresAt: number;
  /** Whether worker slashing has been applied */
  slashApplied: boolean;
  /** Whether initiator slashing has been applied */
  initiatorSlashApplied: boolean;
  /** Snapshot of worker's stake at dispute initiation (u64 as bigint) */
  workerStakeAtDispute: bigint;
  /** Whether the dispute was initiated by the task creator */
  initiatedByCreator: boolean;
  /** Bump seed */
  bump: number;
  /** The defendant worker's agent PDA (fix #827) */
  defendant: PublicKey;
  /** Reward mint for the disputed task (null = SOL). Enriched by DisputeOperations query helpers. */
  rewardMint: PublicKey | null;
}

/**
 * Parsed on-chain DisputeVote account data.
 * Matches the state.rs DisputeVote struct with TypeScript-native types.
 * PDA seeds: ["vote", dispute, voter_agent_pda]
 */
export interface OnChainDisputeVote {
  /** Dispute account PDA */
  dispute: PublicKey;
  /** Voter (arbiter agent PDA) */
  voter: PublicKey;
  /** Vote (true = approve, false = reject) */
  approved: boolean;
  /** Vote timestamp (Unix seconds) */
  votedAt: number;
  /** Arbiter's stake at time of voting (u64 as bigint) */
  stakeAtVote: bigint;
  /** Bump seed */
  bump: number;
}

// ============================================================================
// Parameter Types
// ============================================================================

/**
 * Parameters for initiating a dispute.
 */
export interface InitiateDisputeParams {
  /** Dispute identifier (32 bytes) */
  disputeId: Uint8Array;
  /** Task account PDA */
  taskPda: PublicKey;
  /** Task identifier (32 bytes) — instruction arg */
  taskId: Uint8Array;
  /** Evidence hash (32 bytes) — instruction arg */
  evidenceHash: Uint8Array;
  /** Resolution type (0=Refund, 1=Complete, 2=Split) — instruction arg */
  resolutionType: number;
  /** Evidence string (max 256 chars) — instruction arg */
  evidence: string;
  /** Optional: worker agent PDA (when creator initiates) */
  workerAgentPda?: PublicKey;
  /** Optional: worker claim PDA (when creator initiates) */
  workerClaimPda?: PublicKey;
  /** Optional: defendant worker pairs for remaining_accounts */
  defendantWorkers?: Array<{ claimPda: PublicKey; workerPda: PublicKey }>;
}

/**
 * Parameters for voting on a dispute.
 */
export interface VoteDisputeParams {
  /** Dispute account PDA */
  disputePda: PublicKey;
  /** Task account PDA */
  taskPda: PublicKey;
  /** Whether to approve (true) or reject (false) */
  approve: boolean;
  /** Optional: worker claim PDA for arbiter party validation */
  workerClaimPda?: PublicKey;
}

/**
 * Parameters for resolving a dispute.
 */
export interface ResolveDisputeParams {
  /** Dispute account PDA */
  disputePda: PublicKey;
  /** Task account PDA */
  taskPda: PublicKey;
  /** Task creator's public key */
  creatorPubkey: PublicKey;
  /** Optional: worker claim PDA (required for Complete/Split) */
  workerClaimPda?: PublicKey;
  /** Optional: worker agent PDA (required for Complete/Split) */
  workerAgentPda?: PublicKey;
  /** Optional: worker authority wallet (required for Complete/Split) */
  workerAuthority?: PublicKey;
  /** Arbiter vote PDAs + agent PDAs for remaining_accounts */
  arbiterVotes: Array<{ votePda: PublicKey; arbiterAgentPda: PublicKey }>;
  /** Optional: extra worker pairs for collaborative tasks */
  extraWorkers?: Array<{ claimPda: PublicKey; workerPda: PublicKey }>;
}

/**
 * Parameters for expiring a dispute.
 */
export interface ExpireDisputeParams {
  /** Dispute account PDA */
  disputePda: PublicKey;
  /** Task account PDA */
  taskPda: PublicKey;
  /** Task creator's public key */
  creatorPubkey: PublicKey;
  /** Optional: worker claim PDA */
  workerClaimPda?: PublicKey;
  /** Optional: worker agent PDA */
  workerAgentPda?: PublicKey;
  /** Optional: worker authority wallet */
  workerAuthority?: PublicKey;
  /** Arbiter vote PDAs + agent PDAs for remaining_accounts */
  arbiterVotes: Array<{ votePda: PublicKey; arbiterAgentPda: PublicKey }>;
  /** Optional: extra worker pairs for collaborative tasks */
  extraWorkers?: Array<{ claimPda: PublicKey; workerPda: PublicKey }>;
}

/**
 * Parameters for applying a dispute slash.
 */
export interface ApplySlashParams {
  /** Dispute account PDA */
  disputePda: PublicKey;
  /** Task account PDA */
  taskPda: PublicKey;
  /** Worker claim PDA */
  workerClaimPda: PublicKey;
  /** Worker agent PDA */
  workerAgentPda: PublicKey;
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result of a dispute initiation transaction.
 */
export interface DisputeResult {
  /** Dispute account PDA */
  disputePda: PublicKey;
  /** Transaction signature */
  transactionSignature: string;
}

/**
 * Result of a dispute vote transaction.
 */
export interface VoteResult {
  /** Vote account PDA */
  votePda: PublicKey;
  /** Transaction signature */
  transactionSignature: string;
}

// ============================================================================
// Parse Functions
// ============================================================================

/**
 * Parse raw Anchor dispute account data to typed OnChainDispute.
 *
 * @param raw - Raw account data from program.account.dispute.fetch()
 * @returns Parsed dispute data
 */
export function parseOnChainDispute(
  raw: Record<string, unknown>,
): OnChainDispute {
  const r = raw as Record<string, any>;
  return {
    disputeId: toUint8Array(r.disputeId),
    task: r.task,
    initiator: r.initiator,
    initiatorAuthority: r.initiatorAuthority,
    evidenceHash: toUint8Array(r.evidenceHash),
    resolutionType: parseResolutionType(r.resolutionType),
    status: parseDisputeStatus(r.status),
    createdAt: toBNNumber(r.createdAt),
    resolvedAt: toBNNumber(r.resolvedAt),
    votesFor: toBNBigint(r.votesFor),
    votesAgainst: toBNBigint(r.votesAgainst),
    totalVoters:
      typeof r.totalVoters === "number" ? r.totalVoters : Number(r.totalVoters),
    votingDeadline: toBNNumber(r.votingDeadline),
    expiresAt: toBNNumber(r.expiresAt),
    slashApplied: Boolean(r.slashApplied),
    initiatorSlashApplied: Boolean(r.initiatorSlashApplied),
    workerStakeAtDispute: toBNBigint(r.workerStakeAtDispute),
    initiatedByCreator: Boolean(r.initiatedByCreator),
    bump: typeof r.bump === "number" ? r.bump : Number(r.bump),
    defendant: r.defendant,
    rewardMint: null,
  };
}

/**
 * Parse raw Anchor dispute vote account data to typed OnChainDisputeVote.
 *
 * @param raw - Raw account data from program.account.disputeVote.fetch()
 * @returns Parsed vote data
 */
export function parseOnChainDisputeVote(
  raw: Record<string, unknown>,
): OnChainDisputeVote {
  const r = raw as Record<string, any>;
  return {
    dispute: r.dispute,
    voter: r.voter,
    approved: Boolean(r.approved),
    votedAt: toBNNumber(r.votedAt),
    stakeAtVote: toBNBigint(r.stakeAtVote),
    bump: typeof r.bump === "number" ? r.bump : Number(r.bump),
  };
}

/**
 * Convert an OnChainDisputeStatus to a human-readable string.
 */
export function disputeStatusToString(status: OnChainDisputeStatus): string {
  switch (status) {
    case OnChainDisputeStatus.Active:
      return "Active";
    case OnChainDisputeStatus.Resolved:
      return "Resolved";
    case OnChainDisputeStatus.Expired:
      return "Expired";
    case OnChainDisputeStatus.Cancelled:
      return "Cancelled";
    default:
      return `Unknown(${status})`;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Convert BN-like value to number */
function toBNNumber(val: unknown): number {
  if (typeof val === "number") return val;
  if (val && typeof (val as any).toNumber === "function")
    return (val as any).toNumber();
  return Number(val);
}

/** Convert BN-like value to bigint */
function toBNBigint(val: unknown): bigint {
  if (typeof val === "bigint") return val;
  if (val && typeof (val as any).toString === "function")
    return BigInt((val as any).toString());
  return BigInt(String(val));
}

/** Parse Anchor's resolution_type enum object to ResolutionType */
function parseResolutionType(val: unknown): ResolutionType {
  if (typeof val === "number") return val as ResolutionType;
  if (val && typeof val === "object") {
    if ("refund" in val) return ResolutionType.Refund;
    if ("complete" in val) return ResolutionType.Complete;
    if ("split" in val) return ResolutionType.Split;
  }
  return ResolutionType.Refund;
}

/** Parse Anchor's dispute status enum object to OnChainDisputeStatus */
function parseDisputeStatus(val: unknown): OnChainDisputeStatus {
  if (typeof val === "number") return val as OnChainDisputeStatus;
  if (val && typeof val === "object") {
    if ("active" in val) return OnChainDisputeStatus.Active;
    if ("resolved" in val) return OnChainDisputeStatus.Resolved;
    if ("expired" in val) return OnChainDisputeStatus.Expired;
    if ("cancelled" in val) return OnChainDisputeStatus.Cancelled;
  }
  return OnChainDisputeStatus.Active;
}
