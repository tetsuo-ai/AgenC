/**
 * PDA derivation helpers for dispute-related accounts
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "@agenc/sdk";
import { derivePda, validateIdLength } from "../utils/pda.js";

// Re-export PdaWithBump from utils — existing consumers import from here
export type { PdaWithBump } from "../utils/pda.js";
import type { PdaWithBump } from "../utils/pda.js";

/** Length of dispute_id field (bytes) */
export const DISPUTE_ID_LENGTH = 32;

/**
 * Derives the dispute PDA and bump seed.
 * Seeds: ["dispute", dispute_id]
 *
 * @param disputeId - 32-byte dispute identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 * @throws Error if disputeId is not 32 bytes
 */
export function deriveDisputePda(
  disputeId: Uint8Array,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  validateIdLength(disputeId, DISPUTE_ID_LENGTH, "disputeId");
  return derivePda([SEEDS.DISPUTE, Buffer.from(disputeId)], programId);
}

/**
 * Finds the dispute PDA address (without bump).
 * Convenience wrapper around deriveDisputePda.
 *
 * @param disputeId - 32-byte dispute identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 * @throws Error if disputeId is not 32 bytes
 */
export function findDisputePda(
  disputeId: Uint8Array,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveDisputePda(disputeId, programId).address;
}

/**
 * Derives the vote PDA and bump seed.
 * Seeds: ["vote", dispute_pda, arbiter_agent_pda]
 *
 * Note: The voter is the arbiter's AGENT PDA, not the wallet.
 *
 * @param disputePda - Dispute account PDA
 * @param arbiterAgentPda - Arbiter agent account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveVotePda(
  disputePda: PublicKey,
  arbiterAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  return derivePda(
    [SEEDS.VOTE, disputePda.toBuffer(), arbiterAgentPda.toBuffer()],
    programId,
  );
}

/**
 * Finds the vote PDA address (without bump).
 * Convenience wrapper around deriveVotePda.
 *
 * @param disputePda - Dispute account PDA
 * @param arbiterAgentPda - Arbiter agent account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
export function findVotePda(
  disputePda: PublicKey,
  arbiterAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return deriveVotePda(disputePda, arbiterAgentPda, programId).address;
}
