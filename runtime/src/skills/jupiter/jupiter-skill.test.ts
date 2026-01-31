import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JupiterSkill } from './jupiter-skill.js';
import { SkillState } from '../types.js';
import { SkillNotReadyError } from '../errors.js';
import type { SkillContext } from '../types.js';
import { silentLogger } from '../../utils/logger.js';
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { Wallet } from '../../types/wallet.js';
import { WSOL_MINT, USDC_MINT } from './constants.js';

// Mock fetch globally
const mockFetch = vi.fn();

function createMockWallet(): Wallet {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey,
    signTransaction: vi.fn(async (tx) => tx),
    signAllTransactions: vi.fn(async (txs) => txs),
  };
}

function createMockConnection(): Connection {
  return {
    getBalance: vi.fn(async () => 5 * LAMPORTS_PER_SOL),
    getTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
    getParsedAccountInfo: vi.fn(async () => ({ value: null })),
    getAccountInfo: vi.fn(async () => null),
    sendRawTransaction: vi.fn(async () => 'mock_tx_signature'),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100,
    })),
  } as unknown as Connection;
}

function createMockContext(): SkillContext {
  return {
    connection: createMockConnection(),
    wallet: createMockWallet(),
    logger: silentLogger,
  };
}

describe('JupiterSkill', () => {
  let skill: JupiterSkill;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    skill = new JupiterSkill();
  });

  describe('metadata', () => {
    it('has correct metadata', () => {
      expect(skill.metadata.name).toBe('jupiter');
      expect(skill.metadata.version).toBe('0.1.0');
      expect(skill.metadata.requiredCapabilities).toBe(1n | 8n); // COMPUTE | NETWORK
      expect(skill.metadata.tags).toEqual(['defi', 'swap', 'transfer', 'jupiter']);
    });
  });

  describe('lifecycle', () => {
    it('starts in Created state', () => {
      expect(skill.state).toBe(SkillState.Created);
    });

    it('transitions to Ready after initialize', async () => {
      await skill.initialize(createMockContext());
      expect(skill.state).toBe(SkillState.Ready);
    });

    it('transitions to Stopped after shutdown', async () => {
      await skill.initialize(createMockContext());
      await skill.shutdown();
      expect(skill.state).toBe(SkillState.Stopped);
    });
  });

  describe('action registry', () => {
    it('exposes 7 actions', async () => {
      await skill.initialize(createMockContext());
      const actions = skill.getActions();
      expect(actions).toHaveLength(7);
      expect(actions.map((a) => a.name).sort()).toEqual([
        'executeSwap',
        'getQuote',
        'getSolBalance',
        'getTokenBalance',
        'getTokenPrice',
        'transferSol',
        'transferToken',
      ]);
    });

    it('getAction returns correct action by name', () => {
      const action = skill.getAction('getQuote');
      expect(action).toBeDefined();
      expect(action!.name).toBe('getQuote');
    });

    it('getAction returns undefined for unknown name', () => {
      expect(skill.getAction('nonexistent')).toBeUndefined();
    });
  });

  describe('ensureReady guard', () => {
    it('throws SkillNotReadyError when not initialized', async () => {
      await expect(
        skill.getQuote({
          inputMint: WSOL_MINT,
          outputMint: USDC_MINT,
          amount: 100n,
        }),
      ).rejects.toThrow(SkillNotReadyError);
    });

    it('throws SkillNotReadyError after shutdown', async () => {
      await skill.initialize(createMockContext());
      await skill.shutdown();

      await expect(
        skill.getSolBalance(),
      ).rejects.toThrow(SkillNotReadyError);
    });
  });

  describe('getSolBalance', () => {
    it('returns SOL balance for wallet', async () => {
      const ctx = createMockContext();
      await skill.initialize(ctx);

      const balance = await skill.getSolBalance();

      expect(balance.mint).toBe(WSOL_MINT);
      expect(balance.symbol).toBe('SOL');
      expect(balance.amount).toBe(BigInt(5 * LAMPORTS_PER_SOL));
      expect(balance.decimals).toBe(9);
      expect(balance.uiAmount).toBe(5);
      expect(ctx.connection.getBalance).toHaveBeenCalledWith(ctx.wallet.publicKey);
    });

    it('returns balance for a specific address', async () => {
      const ctx = createMockContext();
      await skill.initialize(ctx);

      const other = Keypair.generate().publicKey;
      await skill.getSolBalance(other);

      expect(ctx.connection.getBalance).toHaveBeenCalledWith(other);
    });
  });

  describe('getTokenBalance', () => {
    it('returns zero balance when no token accounts exist', async () => {
      const ctx = createMockContext();
      await skill.initialize(ctx);

      const mint = new PublicKey(USDC_MINT);
      const balance = await skill.getTokenBalance(mint);

      expect(balance.mint).toBe(USDC_MINT);
      expect(balance.amount).toBe(0n);
      expect(balance.symbol).toBe('USDC');
    });
  });

  describe('getQuote', () => {
    it('calls Jupiter API and returns parsed quote', async () => {
      const ctx = createMockContext();
      await skill.initialize(ctx);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          inputMint: WSOL_MINT,
          outputMint: USDC_MINT,
          inAmount: '1000000000',
          outAmount: '25500000',
          otherAmountThreshold: '25245000',
          priceImpactPct: '0.01',
        }),
      });

      const quote = await skill.getQuote({
        inputMint: WSOL_MINT,
        outputMint: USDC_MINT,
        amount: 1_000_000_000n,
      });

      expect(quote.inAmount).toBe(1_000_000_000n);
      expect(quote.outAmount).toBe(25_500_000n);
    });

    it('applies default slippage when not specified', async () => {
      const ctx = createMockContext();
      await skill.initialize(ctx);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          inputMint: 'a',
          outputMint: 'b',
          inAmount: '100',
          outAmount: '200',
          otherAmountThreshold: '190',
          priceImpactPct: '0',
        }),
      });

      await skill.getQuote({
        inputMint: 'a',
        outputMint: 'b',
        amount: 100n,
      });

      // Default slippage of 50 bps should be applied
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('slippageBps=50');
    });
  });

  describe('getTokenPrice', () => {
    it('returns prices for requested mints', async () => {
      const ctx = createMockContext();
      await skill.initialize(ctx);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            [WSOL_MINT]: { id: WSOL_MINT, price: 25.5 },
          },
        }),
      });

      const prices = await skill.getTokenPrice([WSOL_MINT]);
      expect(prices.get(WSOL_MINT)?.priceUsd).toBe(25.5);
    });
  });

  describe('custom config', () => {
    it('accepts custom slippage and timeout', () => {
      const custom = new JupiterSkill({
        defaultSlippageBps: 100,
        timeoutMs: 60_000,
        apiBaseUrl: 'https://custom-api.example.com',
      });
      expect(custom.metadata.name).toBe('jupiter');
    });
  });
});
