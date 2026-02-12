/**
 * Shared SPL token account helpers for task and dispute operations.
 *
 * Each builder returns all-null when rewardMint is null (SOL task),
 * or computed ATAs when non-null (SPL token task).
 *
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };

/**
 * Check if a task uses SPL tokens (non-null rewardMint).
 */
export function isTokenTask(rewardMint: PublicKey | null | undefined): boolean {
  return rewardMint != null;
}

/**
 * Token accounts for completeTask / completeTaskPrivate.
 *
 * On-chain account names (camelCase via Anchor):
 *   tokenEscrowAta, workerTokenAccount, treasuryTokenAccount, rewardMint, tokenProgram
 */
export function buildCompleteTaskTokenAccounts(
  rewardMint: PublicKey | null | undefined,
  escrowPda: PublicKey,
  workerAuthority: PublicKey,
  treasury: PublicKey,
): Record<string, PublicKey | null> {
  if (!rewardMint) {
    return {
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
    };
  }
  return {
    tokenEscrowAta: getAssociatedTokenAddressSync(rewardMint, escrowPda, true),
    workerTokenAccount: getAssociatedTokenAddressSync(rewardMint, workerAuthority),
    treasuryTokenAccount: getAssociatedTokenAddressSync(rewardMint, treasury),
    rewardMint,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

/**
 * Token accounts for resolveDispute.
 *
 * On-chain account names:
 *   tokenEscrowAta, creatorTokenAccount, workerTokenAccountAta, treasuryTokenAccount,
 *   rewardMint, tokenProgram
 */
export function buildResolveDisputeTokenAccounts(
  rewardMint: PublicKey | null | undefined,
  escrowPda: PublicKey,
  creatorPubkey: PublicKey,
  workerAuthority: PublicKey | null,
  treasury: PublicKey,
): Record<string, PublicKey | null> {
  if (!rewardMint) {
    return {
      tokenEscrowAta: null,
      creatorTokenAccount: null,
      workerTokenAccountAta: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
    };
  }
  return {
    tokenEscrowAta: getAssociatedTokenAddressSync(rewardMint, escrowPda, true),
    creatorTokenAccount: getAssociatedTokenAddressSync(rewardMint, creatorPubkey),
    workerTokenAccountAta: workerAuthority
      ? getAssociatedTokenAddressSync(rewardMint, workerAuthority)
      : null,
    treasuryTokenAccount: getAssociatedTokenAddressSync(rewardMint, treasury),
    rewardMint,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

/**
 * Token accounts for expireDispute (like resolveDispute but NO treasuryTokenAccount).
 *
 * On-chain account names:
 *   tokenEscrowAta, creatorTokenAccount, workerTokenAccountAta, rewardMint, tokenProgram
 */
export function buildExpireDisputeTokenAccounts(
  rewardMint: PublicKey | null | undefined,
  escrowPda: PublicKey,
  creatorPubkey: PublicKey,
  workerAuthority: PublicKey | null,
): Record<string, PublicKey | null> {
  if (!rewardMint) {
    return {
      tokenEscrowAta: null,
      creatorTokenAccount: null,
      workerTokenAccountAta: null,
      rewardMint: null,
      tokenProgram: null,
    };
  }
  return {
    tokenEscrowAta: getAssociatedTokenAddressSync(rewardMint, escrowPda, true),
    creatorTokenAccount: getAssociatedTokenAddressSync(rewardMint, creatorPubkey),
    workerTokenAccountAta: workerAuthority
      ? getAssociatedTokenAddressSync(rewardMint, workerAuthority)
      : null,
    rewardMint,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

/**
 * Token accounts for applyDisputeSlash.
 *
 * On-chain account names:
 *   escrow, tokenEscrowAta, treasuryTokenAccount, rewardMint, tokenProgram
 */
export function buildApplyDisputeSlashTokenAccounts(
  rewardMint: PublicKey | null | undefined,
  escrowPda: PublicKey,
  treasury: PublicKey,
): Record<string, PublicKey | null> {
  if (!rewardMint) {
    return {
      escrow: null,
      tokenEscrowAta: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
    };
  }
  return {
    escrow: escrowPda,
    tokenEscrowAta: getAssociatedTokenAddressSync(rewardMint, escrowPda, true),
    treasuryTokenAccount: getAssociatedTokenAddressSync(rewardMint, treasury),
    rewardMint,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

/**
 * Token accounts for createTask / createDependentTask.
 *
 * On-chain account names:
 *   rewardMint, creatorTokenAccount, tokenEscrowAta, tokenProgram, associatedTokenProgram
 */
export function buildCreateTaskTokenAccounts(
  rewardMint: PublicKey | null | undefined,
  escrowPda: PublicKey,
  creatorPubkey: PublicKey,
): Record<string, PublicKey | null> {
  if (!rewardMint) {
    return {
      rewardMint: null,
      creatorTokenAccount: null,
      tokenEscrowAta: null,
      tokenProgram: null,
      associatedTokenProgram: null,
    };
  }
  return {
    rewardMint,
    creatorTokenAccount: getAssociatedTokenAddressSync(rewardMint, creatorPubkey),
    tokenEscrowAta: getAssociatedTokenAddressSync(rewardMint, escrowPda, true),
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  };
}
