/**
 * Governance module — enums, PDA helpers, and CU budget constants.
 */

import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, SEEDS } from './constants.js';

// ============================================================================
// Enums
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
// PDA helpers
// ============================================================================

export function deriveGovernanceConfigPda(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEEDS.GOVERNANCE], programId);
}

export function deriveProposalPda(
  proposerAgentPda: PublicKey,
  nonce: bigint | number,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [SEEDS.PROPOSAL, proposerAgentPda.toBuffer(), nonceBuf],
    programId,
  );
}

export function deriveGovernanceVotePda(
  proposalPda: PublicKey,
  voterAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.GOVERNANCE_VOTE, proposalPda.toBuffer(), voterAgentPda.toBuffer()],
    programId,
  );
}

// ============================================================================
// Compute unit budgets
// ============================================================================

export const RECOMMENDED_CU_INITIALIZE_GOVERNANCE = 50_000;
export const RECOMMENDED_CU_CREATE_PROPOSAL = 60_000;
export const RECOMMENDED_CU_VOTE_PROPOSAL = 50_000;
export const RECOMMENDED_CU_EXECUTE_PROPOSAL = 80_000;
export const RECOMMENDED_CU_CANCEL_PROPOSAL = 30_000;
