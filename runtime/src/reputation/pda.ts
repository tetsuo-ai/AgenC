/**
 * PDA derivation helpers for reputation economy accounts
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, SEEDS } from '@agenc/sdk';
import { derivePda } from '../utils/pda.js';

export type { PdaWithBump } from '../utils/pda.js';
import type { PdaWithBump } from '../utils/pda.js';

/**
 * Derives the reputation stake PDA and bump seed.
 * Seeds: ["reputation_stake", agent_pda]
 *
 * @param agentPda - Agent account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveReputationStakePda(
  agentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PdaWithBump {
  return derivePda([SEEDS.REPUTATION_STAKE, agentPda.toBuffer()], programId);
}

/**
 * Finds the reputation stake PDA address (without bump).
 *
 * @param agentPda - Agent account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
export function findReputationStakePda(
  agentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  return deriveReputationStakePda(agentPda, programId).address;
}

/**
 * Derives the reputation delegation PDA and bump seed.
 * Seeds: ["reputation_delegation", delegator_pda, delegatee_pda]
 *
 * @param delegatorPda - Delegator agent PDA
 * @param delegateePda - Delegatee agent PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function deriveReputationDelegationPda(
  delegatorPda: PublicKey,
  delegateePda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PdaWithBump {
  return derivePda(
    [SEEDS.REPUTATION_DELEGATION, delegatorPda.toBuffer(), delegateePda.toBuffer()],
    programId
  );
}

/**
 * Finds the reputation delegation PDA address (without bump).
 *
 * @param delegatorPda - Delegator agent PDA
 * @param delegateePda - Delegatee agent PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 */
export function findReputationDelegationPda(
  delegatorPda: PublicKey,
  delegateePda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  return deriveReputationDelegationPda(delegatorPda, delegateePda, programId).address;
}
