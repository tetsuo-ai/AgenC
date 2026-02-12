/**
 * SPL Token Helpers for AgenC
 *
 * Utilities for working with SPL token-denominated tasks.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  getAccount as getTokenAccount,
  getMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { SEEDS, PROGRAM_ID } from './constants';

export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };

/**
 * Derive the Associated Token Account address for a task's escrow PDA.
 *
 * @param mint - SPL token mint address
 * @param escrowPda - The escrow PDA (owner of the token account)
 * @returns The ATA address for the escrow
 */
export function deriveTokenEscrowAddress(
  mint: PublicKey,
  escrowPda: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, escrowPda, true);
}

/**
 * Check whether a task uses SPL tokens (vs native SOL).
 *
 * @param task - Object with an optional rewardMint field
 * @returns true if the task has a non-null rewardMint
 */
export function isTokenTask(task: { rewardMint?: PublicKey | null }): boolean {
  return task.rewardMint != null;
}

/**
 * Get the token balance of a task's escrow ATA.
 *
 * @param connection - Solana RPC connection
 * @param taskPda - The task PDA
 * @param mint - SPL token mint
 * @param programId - AgenC program ID (defaults to PROGRAM_ID)
 * @returns Token balance as bigint
 */
export async function getEscrowTokenBalance(
  connection: Connection,
  taskPda: PublicKey,
  mint: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Promise<bigint> {
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [SEEDS.ESCROW, taskPda.toBuffer()],
    programId,
  );
  const ata = getAssociatedTokenAddressSync(mint, escrowPda, true);
  const account = await getTokenAccount(connection, ata);
  return account.amount;
}

/**
 * Format a raw token amount using the mint's decimals.
 *
 * @param amount - Raw token amount (smallest unit)
 * @param decimals - Number of decimal places. If omitted, fetched from the mint.
 * @param connection - Required when decimals is not provided
 * @param mint - Required when decimals is not provided
 * @returns Formatted string (e.g. "1.000000000" for 1 SOL-equivalent with 9 decimals)
 */
export async function formatTokenAmount(
  amount: bigint,
  decimals?: number,
  connection?: Connection,
  mint?: PublicKey,
): Promise<string> {
  let dec = decimals;
  if (dec === undefined) {
    if (!connection || !mint) {
      throw new Error('connection and mint are required when decimals is not provided');
    }
    dec = await getMintDecimals(connection, mint);
  }

  if (dec === 0) {
    return amount.toString();
  }

  const divisor = 10n ** BigInt(dec);
  const whole = amount / divisor;
  const fractional = amount % divisor;
  const fracStr = fractional.toString().padStart(dec, '0');
  return `${whole}.${fracStr}`;
}

/**
 * Get the number of decimals for an SPL token mint.
 *
 * @param connection - Solana RPC connection
 * @param mint - SPL token mint address
 * @returns Number of decimals
 */
export async function getMintDecimals(
  connection: Connection,
  mint: PublicKey,
): Promise<number> {
  const mintInfo = await getMint(connection, mint);
  return mintInfo.decimals;
}
