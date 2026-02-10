/**
 * PDA derivation helpers for dispute-related accounts
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, SEEDS } from '@agenc/sdk';
import type { PdaWithBump } from '../agent/pda.js';

// Re-export PdaWithBump for consumers importing from dispute module
export type { PdaWithBump } from '../agent/pda.js';

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
  programId: PublicKey = PROGRAM_ID
): PdaWithBump {
  if (disputeId.length !== 32) {
    throw new Error(
      `Invalid disputeId length: ${disputeId.length} (must be 32)`
    );
  }

  const [address, bump] = PublicKey.findProgramAddressSync(
    [SEEDS.DISPUTE, Buffer.from(disputeId)],
    programId
  );

  return { address, bump };
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
  programId: PublicKey = PROGRAM_ID
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
  programId: PublicKey = PROGRAM_ID
): PdaWithBump {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [SEEDS.VOTE, disputePda.toBuffer(), arbiterAgentPda.toBuffer()],
    programId
  );

  return { address, bump };
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
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  return deriveVotePda(disputePda, arbiterAgentPda, programId).address;
}
