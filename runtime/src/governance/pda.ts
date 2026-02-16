/**
 * PDA derivation helpers for governance-related accounts.
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, SEEDS } from '@agenc/sdk';
import { derivePda } from '../utils/pda.js';
import type { PdaWithBump } from '../utils/pda.js';

export type { PdaWithBump } from '../utils/pda.js';

/**
 * Derives the proposal PDA and bump seed.
 * Seeds: ["proposal", proposer_agent_pda, nonce_le_bytes]
 */
export function deriveProposalPda(
  proposerPda: PublicKey,
  nonce: bigint,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  const nonceBuffer = Buffer.alloc(8);
  nonceBuffer.writeBigUInt64LE(nonce);
  return derivePda([SEEDS.PROPOSAL, proposerPda.toBuffer(), nonceBuffer], programId);
}

/**
 * Finds the proposal PDA address (without bump).
 */
export function findProposalPda(
  proposerPda: PublicKey,
  nonce: bigint,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveProposalPda(proposerPda, nonce, programId).address;
}

/**
 * Derives the governance vote PDA and bump seed.
 * Seeds: ["governance_vote", proposal_pda, voter_agent_pda]
 */
export function deriveGovernanceVotePda(
  proposalPda: PublicKey,
  voterAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda(
    [SEEDS.GOVERNANCE_VOTE, proposalPda.toBuffer(), voterAgentPda.toBuffer()],
    programId,
  );
}

/**
 * Finds the governance vote PDA address (without bump).
 */
export function findGovernanceVotePda(
  proposalPda: PublicKey,
  voterAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveGovernanceVotePda(proposalPda, voterAgentPda, programId).address;
}
