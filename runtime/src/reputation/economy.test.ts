import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { ReputationEconomyOperations } from './economy.js';
import {
  parseOnChainReputationStake,
  parseOnChainReputationDelegation,
  REPUTATION_MAX,
  MIN_DELEGATION_AMOUNT,
  REPUTATION_STAKING_COOLDOWN_SECONDS,
} from './types.js';
import {
  ReputationStakeError,
  ReputationDelegationError,
  ReputationWithdrawError,
  ReputationPortabilityError,
} from './errors.js';
import { RuntimeErrorCodes } from '../types/errors.js';
import BN from 'bn.js';

// ============================================================================
// Mock program factory
// ============================================================================

function createMockProgram(overrides: Record<string, any> = {}) {
  const provider = {
    publicKey: Keypair.generate().publicKey,
    connection: {},
  };

  const methods: Record<string, any> = {};
  const methodProxy = new Proxy(methods, {
    get(_target, prop) {
      return (..._args: any[]) => ({
        accountsPartial: () => ({
          rpc: vi.fn().mockResolvedValue('mock-tx-signature'),
        }),
      });
    },
  });

  const defaultAgent = 'agentRegistration' in overrides
    ? overrides.agentRegistration
    : {
        agentId: new Uint8Array(32).fill(1),
        reputation: 5000,
        tasksCompleted: new BN(10),
        totalEarned: new BN(1_000_000_000),
      };

  const accountProxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'agentRegistration') {
          return {
            fetchNullable: vi.fn().mockResolvedValue(defaultAgent),
          };
        }
        if (prop === 'reputationStake') {
          return {
            fetchNullable: vi.fn().mockResolvedValue(
              overrides.reputationStake ?? null,
            ),
          };
        }
        if (prop === 'reputationDelegation') {
          return {
            fetchNullable: vi.fn().mockResolvedValue(
              overrides.reputationDelegation ?? null,
            ),
            all: vi.fn().mockResolvedValue(overrides.delegationAccounts ?? []),
          };
        }
        return { fetchNullable: vi.fn().mockResolvedValue(null), all: vi.fn().mockResolvedValue([]) };
      },
    },
  );

  return {
    methods: methodProxy,
    account: accountProxy,
    provider,
    programId: new PublicKey('5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7'),
  } as any;
}

function createFailingMockProgram(errorMsg: string) {
  const provider = {
    publicKey: Keypair.generate().publicKey,
    connection: {},
  };

  const methods: Record<string, any> = {};
  const methodProxy = new Proxy(methods, {
    get(_target, _prop) {
      return (..._args: any[]) => ({
        accountsPartial: () => ({
          rpc: vi.fn().mockRejectedValue(new Error(errorMsg)),
        }),
      });
    },
  });

  return {
    methods: methodProxy,
    account: new Proxy({}, {
      get() {
        return { fetchNullable: vi.fn().mockResolvedValue(null), all: vi.fn().mockResolvedValue([]) };
      },
    }),
    provider,
    programId: new PublicKey('5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7'),
  } as any;
}

function createAgentId(): Uint8Array {
  return new Uint8Array(32).fill(1);
}

// ============================================================================
// parseOnChainReputationStake
// ============================================================================

describe('parseOnChainReputationStake', () => {
  it('parses raw Anchor account data correctly', () => {
    const agent = Keypair.generate().publicKey;
    const raw = {
      agent,
      stakedAmount: new BN('1000000000'),
      lockedUntil: new BN(1700000000),
      slashCount: 2,
      createdAt: new BN(1690000000),
      bump: 254,
    };

    const parsed = parseOnChainReputationStake(raw);

    expect(parsed.agent).toEqual(agent);
    expect(parsed.stakedAmount).toBe(1_000_000_000n);
    expect(parsed.lockedUntil).toBe(1700000000);
    expect(parsed.slashCount).toBe(2);
    expect(parsed.createdAt).toBe(1690000000);
    expect(parsed.bump).toBe(254);
  });

  it('handles zero values', () => {
    const agent = Keypair.generate().publicKey;
    const raw = {
      agent,
      stakedAmount: new BN(0),
      lockedUntil: new BN(0),
      slashCount: 0,
      createdAt: new BN(0),
      bump: 0,
    };

    const parsed = parseOnChainReputationStake(raw);

    expect(parsed.stakedAmount).toBe(0n);
    expect(parsed.lockedUntil).toBe(0);
  });
});

// ============================================================================
// parseOnChainReputationDelegation
// ============================================================================

describe('parseOnChainReputationDelegation', () => {
  it('parses raw Anchor account data correctly', () => {
    const delegator = Keypair.generate().publicKey;
    const delegatee = Keypair.generate().publicKey;
    const raw = {
      delegator,
      delegatee,
      amount: 2500,
      expiresAt: new BN(1800000000),
      createdAt: new BN(1700000000),
      bump: 253,
    };

    const parsed = parseOnChainReputationDelegation(raw);

    expect(parsed.delegator).toEqual(delegator);
    expect(parsed.delegatee).toEqual(delegatee);
    expect(parsed.amount).toBe(2500);
    expect(parsed.expiresAt).toBe(1800000000);
    expect(parsed.createdAt).toBe(1700000000);
    expect(parsed.bump).toBe(253);
  });

  it('handles no expiry (0)', () => {
    const raw = {
      delegator: Keypair.generate().publicKey,
      delegatee: Keypair.generate().publicKey,
      amount: 1000,
      expiresAt: new BN(0),
      createdAt: new BN(1700000000),
      bump: 250,
    };

    const parsed = parseOnChainReputationDelegation(raw);
    expect(parsed.expiresAt).toBe(0);
  });
});

// ============================================================================
// ReputationEconomyOperations - Staking
// ============================================================================

describe('ReputationEconomyOperations - staking', () => {
  it('stakeReputation returns StakeResult', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.stakeReputation({ amount: 1_000_000_000n });
    expect(result.transactionSignature).toBe('mock-tx-signature');
    expect(result.stakePda).toBeInstanceOf(PublicKey);
  });

  it('getStake returns null when no stake exists', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getStake();
    expect(result).toBeNull();
  });

  it('getStake returns parsed stake when it exists', async () => {
    const agentPda = Keypair.generate().publicKey;
    const program = createMockProgram({
      reputationStake: {
        agent: agentPda,
        stakedAmount: new BN('2000000000'),
        lockedUntil: new BN(1800000000),
        slashCount: 0,
        createdAt: new BN(1700000000),
        bump: 254,
      },
    });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getStake();
    expect(result).not.toBeNull();
    expect(result!.stakedAmount).toBe(2_000_000_000n);
  });

  it('withdrawStake returns WithdrawResult', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.withdrawStake({ amount: 500_000_000n });
    expect(result.transactionSignature).toBe('mock-tx-signature');
  });

  it('stakeReputation wraps RPC errors in ReputationStakeError', async () => {
    const program = createFailingMockProgram('StakeAmountTooLow');
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    await expect(ops.stakeReputation({ amount: 0n })).rejects.toThrow(
      ReputationStakeError,
    );
  });

  it('withdrawStake wraps RPC errors in ReputationWithdrawError', async () => {
    const program = createFailingMockProgram('StakeLocked');
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    await expect(ops.withdrawStake({ amount: 1n })).rejects.toThrow(
      ReputationWithdrawError,
    );
  });
});

// ============================================================================
// ReputationEconomyOperations - Delegation
// ============================================================================

describe('ReputationEconomyOperations - delegation', () => {
  it('delegateReputation returns DelegationResult', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.delegateReputation({
      delegateeId: new Uint8Array(32).fill(2),
      amount: 1000,
    });
    expect(result.transactionSignature).toBe('mock-tx-signature');
    expect(result.delegationPda).toBeInstanceOf(PublicKey);
  });

  it('delegateReputation with expiresAt', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.delegateReputation({
      delegateeId: new Uint8Array(32).fill(3),
      amount: 500,
      expiresAt: 1900000000,
    });
    expect(result.transactionSignature).toBe('mock-tx-signature');
  });

  it('getDelegation returns null when not found', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getDelegation(
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    );
    expect(result).toBeNull();
  });

  it('getDelegation returns parsed delegation when found', async () => {
    const delegator = Keypair.generate().publicKey;
    const delegatee = Keypair.generate().publicKey;
    const program = createMockProgram({
      reputationDelegation: {
        delegator,
        delegatee,
        amount: 1500,
        expiresAt: new BN(0),
        createdAt: new BN(1700000000),
        bump: 253,
      },
    });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getDelegation(delegator, delegatee);
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(1500);
    expect(result!.delegator.toBase58()).toBe(delegator.toBase58());
    expect(result!.delegatee.toBase58()).toBe(delegatee.toBase58());
    expect(result!.expiresAt).toBe(0);
  });

  it('getDelegationsFrom returns parsed delegations', async () => {
    const delegator = Keypair.generate().publicKey;
    const delegatee = Keypair.generate().publicKey;
    const program = createMockProgram({
      delegationAccounts: [
        {
          publicKey: Keypair.generate().publicKey,
          account: {
            delegator,
            delegatee,
            amount: 1000,
            expiresAt: new BN(0),
            createdAt: new BN(1700000000),
            bump: 253,
          },
        },
      ],
    });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getDelegationsFrom(delegator);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(1000);
  });

  it('getDelegationsTo returns parsed delegations', async () => {
    const delegator = Keypair.generate().publicKey;
    const delegatee = Keypair.generate().publicKey;
    const program = createMockProgram({
      delegationAccounts: [
        {
          publicKey: Keypair.generate().publicKey,
          account: {
            delegator,
            delegatee,
            amount: 2000,
            expiresAt: new BN(1900000000),
            createdAt: new BN(1700000000),
            bump: 252,
          },
        },
      ],
    });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getDelegationsTo(delegatee);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(2000);
  });

  it('revokeDelegation returns RevokeResult', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.revokeDelegation(Keypair.generate().publicKey);
    expect(result.transactionSignature).toBe('mock-tx-signature');
  });

  it('delegateReputation wraps RPC errors in ReputationDelegationError', async () => {
    const program = createFailingMockProgram('CannotDelegateSelf');
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    await expect(
      ops.delegateReputation({ delegateeId: new Uint8Array(32).fill(2), amount: 1000 }),
    ).rejects.toThrow(ReputationDelegationError);
  });

  it('revokeDelegation wraps RPC errors in ReputationDelegationError', async () => {
    const program = createFailingMockProgram('DelegationNotFound');
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    await expect(
      ops.revokeDelegation(Keypair.generate().publicKey),
    ).rejects.toThrow(ReputationDelegationError);
  });
});

// ============================================================================
// ReputationEconomyOperations - Effective Reputation
// ============================================================================

describe('ReputationEconomyOperations - effective reputation', () => {
  it('returns base reputation when no delegations', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const agentPda = Keypair.generate().publicKey;
    const result = await ops.getEffectiveReputation(agentPda);
    // Agent has 5000 base reputation (from mock), no delegations
    expect(result).toBe(5000);
  });

  it('adds non-expired delegation amounts', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400; // 1 day ahead
    const program = createMockProgram({
      delegationAccounts: [
        {
          publicKey: Keypair.generate().publicKey,
          account: {
            delegator: Keypair.generate().publicKey,
            delegatee: Keypair.generate().publicKey,
            amount: 2000,
            expiresAt: new BN(futureExpiry),
            createdAt: new BN(1700000000),
            bump: 250,
          },
        },
        {
          publicKey: Keypair.generate().publicKey,
          account: {
            delegator: Keypair.generate().publicKey,
            delegatee: Keypair.generate().publicKey,
            amount: 1000,
            expiresAt: new BN(0), // no expiry
            createdAt: new BN(1700000000),
            bump: 249,
          },
        },
      ],
    });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getEffectiveReputation(Keypair.generate().publicKey);
    // 5000 base + 2000 + 1000 = 8000
    expect(result).toBe(8000);
  });

  it('filters out expired delegations', async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 86400; // 1 day ago
    const program = createMockProgram({
      delegationAccounts: [
        {
          publicKey: Keypair.generate().publicKey,
          account: {
            delegator: Keypair.generate().publicKey,
            delegatee: Keypair.generate().publicKey,
            amount: 3000,
            expiresAt: new BN(pastExpiry),
            createdAt: new BN(1700000000),
            bump: 250,
          },
        },
      ],
    });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getEffectiveReputation(Keypair.generate().publicKey);
    // 5000 base + 0 (expired) = 5000
    expect(result).toBe(5000);
  });

  it('caps at REPUTATION_MAX', async () => {
    const program = createMockProgram({
      delegationAccounts: [
        {
          publicKey: Keypair.generate().publicKey,
          account: {
            delegator: Keypair.generate().publicKey,
            delegatee: Keypair.generate().publicKey,
            amount: 8000,
            expiresAt: new BN(0),
            createdAt: new BN(1700000000),
            bump: 250,
          },
        },
      ],
    });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getEffectiveReputation(Keypair.generate().publicKey);
    // 5000 + 8000 = 13000 but capped at 10000
    expect(result).toBe(REPUTATION_MAX);
  });

  it('returns 0 when agent not found', async () => {
    const program = createMockProgram({ agentRegistration: null });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const result = await ops.getEffectiveReputation(Keypair.generate().publicKey);
    expect(result).toBe(0);
  });
});

// ============================================================================
// ReputationEconomyOperations - Portability
// ============================================================================

describe('ReputationEconomyOperations - portability', () => {
  it('generates a portable reputation proof with valid structure', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const keypair = Keypair.generate();
    const proof = await ops.getPortableReputationProof(keypair);

    expect(proof.agentPda).toBeTruthy();
    expect(proof.reputation).toBe(5000);
    expect(proof.stakedAmount).toBe('0');
    expect(proof.tasksCompleted).toBe('10');
    expect(proof.totalEarned).toBe('1000000000');
    expect(proof.nonce).toHaveLength(32); // 16 bytes hex
    expect(proof.chainId).toBe('solana-devnet');
    expect(proof.signature.length).toBe(64); // ed25519 signature
    expect(proof.programId).toBe('5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7');
  });

  it('includes stake amount when stake exists', async () => {
    const program = createMockProgram({
      reputationStake: {
        agent: Keypair.generate().publicKey,
        stakedAmount: new BN('5000000000'),
        lockedUntil: new BN(1800000000),
        slashCount: 0,
        createdAt: new BN(1700000000),
        bump: 254,
      },
    });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const keypair = Keypair.generate();
    const proof = await ops.getPortableReputationProof(keypair);

    expect(proof.stakedAmount).toBe('5000000000');
  });

  it('uses configurable chainId', async () => {
    const program = createMockProgram();
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
      chainId: 'solana-mainnet-beta',
    });

    const keypair = Keypair.generate();
    const proof = await ops.getPortableReputationProof(keypair);
    expect(proof.chainId).toBe('solana-mainnet-beta');
  });

  it('throws ReputationPortabilityError when agent not registered', async () => {
    const program = createMockProgram({ agentRegistration: null });
    const ops = new ReputationEconomyOperations({
      program,
      agentId: createAgentId(),
    });

    const keypair = Keypair.generate();
    await expect(ops.getPortableReputationProof(keypair)).rejects.toThrow(
      ReputationPortabilityError,
    );
  });
});

// ============================================================================
// Error classes
// ============================================================================

describe('Reputation error classes', () => {
  it('ReputationStakeError has correct code', () => {
    const err = new ReputationStakeError('test reason');
    expect(err.code).toBe(RuntimeErrorCodes.REPUTATION_STAKE_ERROR);
    expect(err.reason).toBe('test reason');
    expect(err.name).toBe('ReputationStakeError');
  });

  it('ReputationDelegationError has correct code', () => {
    const err = new ReputationDelegationError('test reason');
    expect(err.code).toBe(RuntimeErrorCodes.REPUTATION_DELEGATION_ERROR);
    expect(err.reason).toBe('test reason');
  });

  it('ReputationWithdrawError has correct code', () => {
    const err = new ReputationWithdrawError('test reason');
    expect(err.code).toBe(RuntimeErrorCodes.REPUTATION_WITHDRAW_ERROR);
    expect(err.reason).toBe('test reason');
  });

  it('ReputationPortabilityError has correct code', () => {
    const err = new ReputationPortabilityError('test reason');
    expect(err.code).toBe(RuntimeErrorCodes.REPUTATION_PORTABILITY_ERROR);
    expect(err.reason).toBe('test reason');
  });
});

// ============================================================================
// Constants
// ============================================================================

describe('Reputation constants', () => {
  it('REPUTATION_MAX is 10000', () => {
    expect(REPUTATION_MAX).toBe(10_000);
  });

  it('MIN_DELEGATION_AMOUNT is 100', () => {
    expect(MIN_DELEGATION_AMOUNT).toBe(100);
  });

  it('REPUTATION_STAKING_COOLDOWN_SECONDS is 7 days', () => {
    expect(REPUTATION_STAKING_COOLDOWN_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
