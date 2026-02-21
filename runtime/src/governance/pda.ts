/**
 * PDA derivation helpers for governance-related accounts.
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "@agenc/sdk";
import { derivePda } from "../utils/pda.js";
import type { PdaWithBump } from "../utils/pda.js";

export type { PdaWithBump } from "../utils/pda.js";

/**
 * Derives the governance config PDA and bump seed.
 * Seeds: ["governance"]
 */
export function deriveGovernanceConfigPda(
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda([SEEDS.GOVERNANCE], programId);
}

/**
 * Finds the governance config PDA address (without bump).
 */
export function findGovernanceConfigPda(
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveGovernanceConfigPda(programId).address;
}

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
  return derivePda(
    [SEEDS.PROPOSAL, proposerPda.toBuffer(), nonceBuffer],
    programId,
  );
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
 * Seeds: ["governance_vote", proposal_pda, voter_authority_pubkey]
 */
export function deriveGovernanceVotePda(
  proposalPda: PublicKey,
  voterAuthorityPubkey: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda(
    [
      SEEDS.GOVERNANCE_VOTE,
      proposalPda.toBuffer(),
      voterAuthorityPubkey.toBuffer(),
    ],
    programId,
  );
}

/**
 * Finds the governance vote PDA address (without bump).
 */
export function findGovernanceVotePda(
  proposalPda: PublicKey,
  voterAuthorityPubkey: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveGovernanceVotePda(proposalPda, voterAuthorityPubkey, programId)
    .address;
}
