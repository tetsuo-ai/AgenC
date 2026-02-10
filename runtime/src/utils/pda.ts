/**
 * Shared PDA derivation helpers used across agent, task, and dispute modules.
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID } from '@agenc/sdk';

/**
 * PDA with its bump seed for account creation.
 */
export interface PdaWithBump {
  /** The derived program address */
  address: PublicKey;
  /** The bump seed used in derivation */
  bump: number;
}

/**
 * Derive a PDA from seeds and program ID.
 *
 * @param seeds - Array of seed buffers
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 */
export function derivePda(
  seeds: Array<Buffer | Uint8Array>,
  programId: PublicKey = PROGRAM_ID,
): PdaWithBump {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return { address, bump };
}

/**
 * Validate that a byte array has the expected length.
 *
 * @param id - Byte array to validate
 * @param expectedLength - Expected length in bytes
 * @param name - Name used in error message
 * @throws Error if length does not match
 */
export function validateIdLength(
  id: Uint8Array,
  expectedLength: number,
  name: string,
): void {
  if (id.length !== expectedLength) {
    throw new Error(
      `Invalid ${name} length: ${id.length} (must be ${expectedLength})`
    );
  }
}
