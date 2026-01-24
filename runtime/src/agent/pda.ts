/**
 * PDA derivation helpers for agent-related accounts
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, SEEDS } from '@agenc/sdk';
import { AGENT_ID_LENGTH } from './types.js';

/**
 * PDA with its bump seed for account creation
 */
export interface PdaWithBump {
  /** The derived program address */
  address: PublicKey;
  /** The bump seed used in derivation */
  bump: number;
}

/**
 * Derives the agent PDA and bump seed from an agent ID.
 * Seeds: ["agent", agent_id]
 *
 * @param agentId - 32-byte agent identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 * @throws Error if agentId is not 32 bytes
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveAgentPda(agentId);
 * console.log(`Agent PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveAgentPda(
  agentId: Uint8Array,
  programId: PublicKey = PROGRAM_ID
): PdaWithBump {
  if (agentId.length !== AGENT_ID_LENGTH) {
    throw new Error(
      `Invalid agentId length: ${agentId.length} (must be ${AGENT_ID_LENGTH})`
    );
  }

  const [address, bump] = PublicKey.findProgramAddressSync(
    [SEEDS.AGENT, Buffer.from(agentId)],
    programId
  );

  return { address, bump };
}

/**
 * Derives the protocol config PDA and bump seed.
 * Seeds: ["protocol"]
 *
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveProtocolPda();
 * console.log(`Protocol PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveProtocolPda(programId: PublicKey = PROGRAM_ID): PdaWithBump {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [SEEDS.PROTOCOL],
    programId
  );

  return { address, bump };
}

/**
 * Finds the agent PDA address (without bump).
 * Convenience wrapper around deriveAgentPda for when only the address is needed.
 *
 * @param agentId - 32-byte agent identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 * @throws Error if agentId is not 32 bytes
 *
 * @example
 * ```typescript
 * const agentPda = findAgentPda(agentId);
 * const agentState = await program.account.agentRegistration.fetch(agentPda);
 * ```
 */
export function findAgentPda(
  agentId: Uint8Array,
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  return deriveAgentPda(agentId, programId).address;
}

/**
 * Finds the protocol config PDA address (without bump).
 * Convenience wrapper around deriveProtocolPda for when only the address is needed.
 *
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 *
 * @example
 * ```typescript
 * const protocolPda = findProtocolPda();
 * const config = await program.account.protocolConfig.fetch(protocolPda);
 * ```
 */
export function findProtocolPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return deriveProtocolPda(programId).address;
}

/**
 * Derives the authority vote PDA and bump seed.
 * Used to prevent Sybil attacks on dispute voting (one vote per authority per dispute).
 * Seeds: ["authority_vote", dispute, authority]
 *
 * @param disputePda - Dispute account PDA
 * @param authority - Authority (wallet) public key
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveAuthorityVotePda(disputePda, authority);
 * console.log(`Authority vote PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveAuthorityVotePda(
  disputePda: PublicKey,
  authority: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PdaWithBump {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('authority_vote'), disputePda.toBuffer(), authority.toBuffer()],
    programId
  );

  return { address, bump };
}

/**
 * Finds the authority vote PDA address (without bump).
 * Convenience wrapper around deriveAuthorityVotePda for when only the address is needed.
 *
 * @param disputePda - Dispute account PDA
 * @param authority - Authority (wallet) public key
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 *
 * @example
 * ```typescript
 * const authorityVotePda = findAuthorityVotePda(disputePda, authority);
 * const vote = await program.account.authorityDisputeVote.fetch(authorityVotePda);
 * ```
 */
export function findAuthorityVotePda(
  disputePda: PublicKey,
  authority: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  return deriveAuthorityVotePda(disputePda, authority, programId).address;
}
