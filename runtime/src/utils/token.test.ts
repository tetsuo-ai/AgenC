import { describe, it, expect } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  isTokenTask,
  buildCompleteTaskTokenAccounts,
  buildResolveDisputeTokenAccounts,
  buildExpireDisputeTokenAccounts,
  buildApplyDisputeSlashTokenAccounts,
  buildCreateTaskTokenAccounts,
} from './token.js';

// ============================================================================
// Fixtures
// Use Keypair.generate().publicKey for on-curve keys (required by
// getAssociatedTokenAddressSync for non-PDA owners).
// Use PublicKey.unique() only for PDA-like addresses (escrow) where
// allowOwnerOffCurve=true is passed.
// ============================================================================

const MINT = Keypair.generate().publicKey;
const ESCROW_PDA = PublicKey.unique(); // off-curve (PDA)
const WORKER = Keypair.generate().publicKey;
const CREATOR = Keypair.generate().publicKey;
const TREASURY = Keypair.generate().publicKey;

// ============================================================================
// isTokenTask
// ============================================================================

describe('isTokenTask', () => {
  it('returns false for null', () => {
    expect(isTokenTask(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTokenTask(undefined)).toBe(false);
  });

  it('returns true for a PublicKey', () => {
    expect(isTokenTask(MINT)).toBe(true);
  });
});

// ============================================================================
// buildCompleteTaskTokenAccounts
// ============================================================================

describe('buildCompleteTaskTokenAccounts', () => {
  it('returns all nulls for SOL task (null mint)', () => {
    const result = buildCompleteTaskTokenAccounts(null, ESCROW_PDA, WORKER, TREASURY);

    expect(result.tokenEscrowAta).toBeNull();
    expect(result.workerTokenAccount).toBeNull();
    expect(result.treasuryTokenAccount).toBeNull();
    expect(result.rewardMint).toBeNull();
    expect(result.tokenProgram).toBeNull();
  });

  it('returns all nulls for SOL task (undefined mint)', () => {
    const result = buildCompleteTaskTokenAccounts(undefined, ESCROW_PDA, WORKER, TREASURY);

    expect(result.tokenEscrowAta).toBeNull();
    expect(result.rewardMint).toBeNull();
  });

  it('returns correct ATAs for token task', () => {
    const result = buildCompleteTaskTokenAccounts(MINT, ESCROW_PDA, WORKER, TREASURY);

    expect(result.tokenEscrowAta).toEqual(
      getAssociatedTokenAddressSync(MINT, ESCROW_PDA, true),
    );
    expect(result.workerTokenAccount).toEqual(
      getAssociatedTokenAddressSync(MINT, WORKER),
    );
    expect(result.treasuryTokenAccount).toEqual(
      getAssociatedTokenAddressSync(MINT, TREASURY),
    );
    expect(result.rewardMint).toEqual(MINT);
    expect(result.tokenProgram).toEqual(TOKEN_PROGRAM_ID);
  });

  it('escrow ATA uses allowOwnerOffCurve', () => {
    const result = buildCompleteTaskTokenAccounts(MINT, ESCROW_PDA, WORKER, TREASURY);
    // PDA-owned ATAs require allowOwnerOffCurve=true
    const expected = getAssociatedTokenAddressSync(MINT, ESCROW_PDA, true);
    expect(result.tokenEscrowAta).toEqual(expected);
  });
});

// ============================================================================
// buildResolveDisputeTokenAccounts
// ============================================================================

describe('buildResolveDisputeTokenAccounts', () => {
  it('returns all nulls for SOL task', () => {
    const result = buildResolveDisputeTokenAccounts(null, ESCROW_PDA, CREATOR, WORKER, TREASURY);

    expect(result.tokenEscrowAta).toBeNull();
    expect(result.creatorTokenAccount).toBeNull();
    expect(result.workerTokenAccountAta).toBeNull();
    expect(result.treasuryTokenAccount).toBeNull();
    expect(result.rewardMint).toBeNull();
    expect(result.tokenProgram).toBeNull();
  });

  it('returns correct ATAs for token task with worker', () => {
    const result = buildResolveDisputeTokenAccounts(MINT, ESCROW_PDA, CREATOR, WORKER, TREASURY);

    expect(result.tokenEscrowAta).toEqual(
      getAssociatedTokenAddressSync(MINT, ESCROW_PDA, true),
    );
    expect(result.creatorTokenAccount).toEqual(
      getAssociatedTokenAddressSync(MINT, CREATOR),
    );
    expect(result.workerTokenAccountAta).toEqual(
      getAssociatedTokenAddressSync(MINT, WORKER),
    );
    expect(result.treasuryTokenAccount).toEqual(
      getAssociatedTokenAddressSync(MINT, TREASURY),
    );
    expect(result.rewardMint).toEqual(MINT);
    expect(result.tokenProgram).toEqual(TOKEN_PROGRAM_ID);
  });

  it('returns null workerTokenAccountAta when worker is null', () => {
    const result = buildResolveDisputeTokenAccounts(MINT, ESCROW_PDA, CREATOR, null, TREASURY);

    expect(result.workerTokenAccountAta).toBeNull();
    // Other fields should still be set
    expect(result.tokenEscrowAta).not.toBeNull();
    expect(result.creatorTokenAccount).not.toBeNull();
    expect(result.treasuryTokenAccount).not.toBeNull();
  });
});

// ============================================================================
// buildExpireDisputeTokenAccounts
// ============================================================================

describe('buildExpireDisputeTokenAccounts', () => {
  it('returns all nulls for SOL task', () => {
    const result = buildExpireDisputeTokenAccounts(null, ESCROW_PDA, CREATOR, WORKER);

    expect(result.tokenEscrowAta).toBeNull();
    expect(result.creatorTokenAccount).toBeNull();
    expect(result.workerTokenAccountAta).toBeNull();
    expect(result.rewardMint).toBeNull();
    expect(result.tokenProgram).toBeNull();
  });

  it('does NOT include treasuryTokenAccount', () => {
    const result = buildExpireDisputeTokenAccounts(MINT, ESCROW_PDA, CREATOR, WORKER);

    expect(result).not.toHaveProperty('treasuryTokenAccount');
  });

  it('returns correct ATAs for token task', () => {
    const result = buildExpireDisputeTokenAccounts(MINT, ESCROW_PDA, CREATOR, WORKER);

    expect(result.tokenEscrowAta).toEqual(
      getAssociatedTokenAddressSync(MINT, ESCROW_PDA, true),
    );
    expect(result.creatorTokenAccount).toEqual(
      getAssociatedTokenAddressSync(MINT, CREATOR),
    );
    expect(result.workerTokenAccountAta).toEqual(
      getAssociatedTokenAddressSync(MINT, WORKER),
    );
    expect(result.rewardMint).toEqual(MINT);
    expect(result.tokenProgram).toEqual(TOKEN_PROGRAM_ID);
  });

  it('returns null workerTokenAccountAta when worker is null', () => {
    const result = buildExpireDisputeTokenAccounts(MINT, ESCROW_PDA, CREATOR, null);

    expect(result.workerTokenAccountAta).toBeNull();
    expect(result.tokenEscrowAta).not.toBeNull();
  });
});

// ============================================================================
// buildApplyDisputeSlashTokenAccounts
// ============================================================================

describe('buildApplyDisputeSlashTokenAccounts', () => {
  it('returns all nulls for SOL task', () => {
    const result = buildApplyDisputeSlashTokenAccounts(null, ESCROW_PDA, TREASURY);

    expect(result.escrow).toBeNull();
    expect(result.tokenEscrowAta).toBeNull();
    expect(result.treasuryTokenAccount).toBeNull();
    expect(result.rewardMint).toBeNull();
    expect(result.tokenProgram).toBeNull();
  });

  it('returns escrow + ATAs for token task', () => {
    const result = buildApplyDisputeSlashTokenAccounts(MINT, ESCROW_PDA, TREASURY);

    expect(result.escrow).toEqual(ESCROW_PDA);
    expect(result.tokenEscrowAta).toEqual(
      getAssociatedTokenAddressSync(MINT, ESCROW_PDA, true),
    );
    expect(result.treasuryTokenAccount).toEqual(
      getAssociatedTokenAddressSync(MINT, TREASURY),
    );
    expect(result.rewardMint).toEqual(MINT);
    expect(result.tokenProgram).toEqual(TOKEN_PROGRAM_ID);
  });
});

// ============================================================================
// buildCreateTaskTokenAccounts
// ============================================================================

describe('buildCreateTaskTokenAccounts', () => {
  it('returns all nulls for SOL task', () => {
    const result = buildCreateTaskTokenAccounts(null, ESCROW_PDA, CREATOR);

    expect(result.rewardMint).toBeNull();
    expect(result.creatorTokenAccount).toBeNull();
    expect(result.tokenEscrowAta).toBeNull();
    expect(result.tokenProgram).toBeNull();
    expect(result.associatedTokenProgram).toBeNull();
  });

  it('returns correct ATAs and programs for token task', () => {
    const result = buildCreateTaskTokenAccounts(MINT, ESCROW_PDA, CREATOR);

    expect(result.rewardMint).toEqual(MINT);
    expect(result.creatorTokenAccount).toEqual(
      getAssociatedTokenAddressSync(MINT, CREATOR),
    );
    expect(result.tokenEscrowAta).toEqual(
      getAssociatedTokenAddressSync(MINT, ESCROW_PDA, true),
    );
    expect(result.tokenProgram).toEqual(TOKEN_PROGRAM_ID);
    expect(result.associatedTokenProgram).toEqual(ASSOCIATED_TOKEN_PROGRAM_ID);
  });

  it('includes associatedTokenProgram (unlike other builders)', () => {
    const result = buildCreateTaskTokenAccounts(MINT, ESCROW_PDA, CREATOR);
    expect(result.associatedTokenProgram).toEqual(ASSOCIATED_TOKEN_PROGRAM_ID);
  });
});
