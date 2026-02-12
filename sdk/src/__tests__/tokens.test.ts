/**
 * Unit tests for SPL token helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Connection, Keypair } from '@solana/web3.js';

// Mock @solana/spl-token before importing tokens module
vi.mock('@solana/spl-token', () => {
  const mockGetAssociatedTokenAddressSync = vi.fn();
  const mockGetAccount = vi.fn();
  const mockGetMint = vi.fn();
  return {
    getAssociatedTokenAddressSync: mockGetAssociatedTokenAddressSync,
    getAccount: mockGetAccount,
    getMint: mockGetMint,
    TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    ASSOCIATED_TOKEN_PROGRAM_ID: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  };
});

import {
  deriveTokenEscrowAddress,
  isTokenTask,
  getEscrowTokenBalance,
  formatTokenAmount,
  getMintDecimals,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '../tokens';

import {
  getAssociatedTokenAddressSync,
  getAccount as getTokenAccount,
  getMint,
} from '@solana/spl-token';

const makeTestPubkey = (seed: number): PublicKey => {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return new PublicKey(bytes);
};

describe('deriveTokenEscrowAddress', () => {
  it('calls getAssociatedTokenAddressSync with correct args', () => {
    const mint = makeTestPubkey(1);
    const escrowPda = makeTestPubkey(2);
    const expectedAta = makeTestPubkey(3);

    vi.mocked(getAssociatedTokenAddressSync).mockReturnValue(expectedAta);

    const result = deriveTokenEscrowAddress(mint, escrowPda);

    expect(getAssociatedTokenAddressSync).toHaveBeenCalledWith(mint, escrowPda, true);
    expect(result.equals(expectedAta)).toBe(true);
  });

  it('uses allowOwnerOffCurve=true for PDA owner', () => {
    const mint = makeTestPubkey(4);
    const escrowPda = makeTestPubkey(5);

    vi.mocked(getAssociatedTokenAddressSync).mockReturnValue(makeTestPubkey(6));

    deriveTokenEscrowAddress(mint, escrowPda);

    const call = vi.mocked(getAssociatedTokenAddressSync).mock.calls[0];
    expect(call[2]).toBe(true); // allowOwnerOffCurve
  });

  it('is deterministic', () => {
    const mint = makeTestPubkey(7);
    const escrowPda = makeTestPubkey(8);
    const ata = makeTestPubkey(9);

    vi.mocked(getAssociatedTokenAddressSync).mockReturnValue(ata);

    const result1 = deriveTokenEscrowAddress(mint, escrowPda);
    const result2 = deriveTokenEscrowAddress(mint, escrowPda);

    expect(result1.equals(result2)).toBe(true);
  });
});

describe('isTokenTask', () => {
  it('returns true when rewardMint is set', () => {
    expect(isTokenTask({ rewardMint: makeTestPubkey(1) })).toBe(true);
  });

  it('returns false when rewardMint is null', () => {
    expect(isTokenTask({ rewardMint: null })).toBe(false);
  });

  it('returns false when rewardMint is undefined', () => {
    expect(isTokenTask({})).toBe(false);
  });

  it('returns false when rewardMint is explicitly undefined', () => {
    expect(isTokenTask({ rewardMint: undefined })).toBe(false);
  });
});

describe('getEscrowTokenBalance', () => {
  let mockConnection: Connection;

  beforeEach(() => {
    mockConnection = {} as unknown as Connection;
    vi.clearAllMocks();
  });

  it('returns token balance from escrow ATA', async () => {
    const taskPda = makeTestPubkey(1);
    const mint = makeTestPubkey(2);
    const ata = makeTestPubkey(3);

    vi.mocked(getAssociatedTokenAddressSync).mockReturnValue(ata);
    vi.mocked(getTokenAccount).mockResolvedValue({
      amount: 1000000000n,
    } as never);

    const balance = await getEscrowTokenBalance(mockConnection, taskPda, mint);

    expect(balance).toBe(1000000000n);
  });
});

describe('formatTokenAmount', () => {
  it('formats amount with 9 decimals', async () => {
    const result = await formatTokenAmount(1000000000n, 9);
    expect(result).toBe('1.000000000');
  });

  it('formats amount with 6 decimals (USDC-like)', async () => {
    const result = await formatTokenAmount(1500000n, 6);
    expect(result).toBe('1.500000');
  });

  it('formats amount with 0 decimals', async () => {
    const result = await formatTokenAmount(42n, 0);
    expect(result).toBe('42');
  });

  it('formats zero amount', async () => {
    const result = await formatTokenAmount(0n, 9);
    expect(result).toBe('0.000000000');
  });

  it('formats fractional amount', async () => {
    const result = await formatTokenAmount(500000000n, 9);
    expect(result).toBe('0.500000000');
  });

  it('fetches decimals from mint when not provided', async () => {
    const mint = makeTestPubkey(1);
    const mockConnection = {} as unknown as Connection;

    vi.mocked(getMint).mockResolvedValue({ decimals: 6 } as never);

    const result = await formatTokenAmount(1000000n, undefined, mockConnection, mint);
    expect(result).toBe('1.000000');
    expect(getMint).toHaveBeenCalledWith(mockConnection, mint);
  });

  it('throws when decimals not provided and no connection', async () => {
    await expect(formatTokenAmount(100n)).rejects.toThrow(
      'connection and mint are required when decimals is not provided'
    );
  });
});

describe('getMintDecimals', () => {
  it('returns decimals from mint', async () => {
    const mint = makeTestPubkey(1);
    const mockConnection = {} as unknown as Connection;

    vi.mocked(getMint).mockResolvedValue({ decimals: 9 } as never);

    const decimals = await getMintDecimals(mockConnection, mint);
    expect(decimals).toBe(9);
  });

  it('propagates errors', async () => {
    const mint = makeTestPubkey(1);
    const mockConnection = {} as unknown as Connection;

    vi.mocked(getMint).mockRejectedValue(new Error('Account not found'));

    await expect(getMintDecimals(mockConnection, mint)).rejects.toThrow('Account not found');
  });
});

describe('re-exports', () => {
  it('exports TOKEN_PROGRAM_ID', () => {
    expect(TOKEN_PROGRAM_ID).toBeDefined();
    expect(TOKEN_PROGRAM_ID).toBeInstanceOf(PublicKey);
  });

  it('exports ASSOCIATED_TOKEN_PROGRAM_ID', () => {
    expect(ASSOCIATED_TOKEN_PROGRAM_ID).toBeDefined();
    expect(ASSOCIATED_TOKEN_PROGRAM_ID).toBeInstanceOf(PublicKey);
  });
});
