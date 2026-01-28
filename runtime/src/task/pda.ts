/**
 * PDA derivation helpers for task-related accounts
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, SEEDS } from '@agenc/sdk';

// Re-export PdaWithBump from agent module
export { type PdaWithBump } from '../agent/pda.js';
import type { PdaWithBump } from '../agent/pda.js';

/** Length of task_id field (bytes) */
export const TASK_ID_LENGTH = 32;

/**
 * Derives the task PDA and bump seed.
 * Seeds: ["task", creator, task_id]
 *
 * @param creator - Task creator's public key
 * @param taskId - 32-byte task identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 * @throws Error if taskId is not 32 bytes
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveTaskPda(creatorPubkey, taskId);
 * console.log(`Task PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveTaskPda(
  creator: PublicKey,
  taskId: Uint8Array,
  programId: PublicKey = PROGRAM_ID
): PdaWithBump {
  if (taskId.length !== TASK_ID_LENGTH) {
    throw new Error(
      `Invalid taskId length: ${taskId.length} (must be ${TASK_ID_LENGTH})`
    );
  }

  const [address, bump] = PublicKey.findProgramAddressSync(
    [SEEDS.TASK, creator.toBuffer(), Buffer.from(taskId)],
    programId
  );

  return { address, bump };
}

/**
 * Finds the task PDA address (without bump).
 * Convenience wrapper around deriveTaskPda for when only the address is needed.
 *
 * @param creator - Task creator's public key
 * @param taskId - 32-byte task identifier
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 * @throws Error if taskId is not 32 bytes
 *
 * @example
 * ```typescript
 * const taskPda = findTaskPda(creatorPubkey, taskId);
 * const task = await program.account.task.fetch(taskPda);
 * ```
 */
export function findTaskPda(
  creator: PublicKey,
  taskId: Uint8Array,
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  return deriveTaskPda(creator, taskId, programId).address;
}

/**
 * Derives the claim PDA and bump seed.
 * Seeds: ["claim", task_pda, worker_agent_pda]
 *
 * @param taskPda - Task account PDA
 * @param workerAgentPda - Worker agent account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveClaimPda(taskPda, workerAgentPda);
 * console.log(`Claim PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveClaimPda(
  taskPda: PublicKey,
  workerAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PdaWithBump {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [SEEDS.CLAIM, taskPda.toBuffer(), workerAgentPda.toBuffer()],
    programId
  );

  return { address, bump };
}

/**
 * Finds the claim PDA address (without bump).
 * Convenience wrapper around deriveClaimPda for when only the address is needed.
 *
 * @param taskPda - Task account PDA
 * @param workerAgentPda - Worker agent account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 *
 * @example
 * ```typescript
 * const claimPda = findClaimPda(taskPda, workerAgentPda);
 * const claim = await program.account.taskClaim.fetch(claimPda);
 * ```
 */
export function findClaimPda(
  taskPda: PublicKey,
  workerAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  return deriveClaimPda(taskPda, workerAgentPda, programId).address;
}

/**
 * Derives the escrow PDA and bump seed.
 * Seeds: ["escrow", task_pda]
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address and bump seed
 *
 * @example
 * ```typescript
 * const { address, bump } = deriveEscrowPda(taskPda);
 * console.log(`Escrow PDA: ${address.toBase58()}, bump: ${bump}`);
 * ```
 */
export function deriveEscrowPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PdaWithBump {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [SEEDS.ESCROW, taskPda.toBuffer()],
    programId
  );

  return { address, bump };
}

/**
 * Finds the escrow PDA address (without bump).
 * Convenience wrapper around deriveEscrowPda for when only the address is needed.
 *
 * @param taskPda - Task account PDA
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns PDA address
 *
 * @example
 * ```typescript
 * const escrowPda = findEscrowPda(taskPda);
 * const escrow = await program.account.taskEscrow.fetch(escrowPda);
 * ```
 */
export function findEscrowPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  return deriveEscrowPda(taskPda, programId).address;
}
