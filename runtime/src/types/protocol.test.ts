import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { MAX_MULTISIG_OWNERS, parseProtocolConfig, ProtocolConfig } from './protocol';

/**
 * Mock BN-like object for testing
 */
function mockBN(value: bigint | number): { toNumber: () => number; toString: () => string } {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

// Well-known valid Solana addresses for testing (NOT actual program IDs)
const TEST_PUBKEY_1 = '11111111111111111111111111111111';
const TEST_PUBKEY_2 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TEST_PUBKEY_3 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const TEST_PUBKEY_4 = 'SysvarRent111111111111111111111111111111111';
const TEST_PUBKEY_5 = 'SysvarC1ock11111111111111111111111111111111';
const TEST_PUBKEY_6 = 'SysvarStakeHistory1111111111111111111111111';
const TEST_PUBKEY_7 = 'SysvarS1otHashes111111111111111111111111111';

/**
 * Creates valid mock protocol config data
 */
function createValidMockData() {
  return {
    authority: new PublicKey(TEST_PUBKEY_1),
    treasury: new PublicKey(TEST_PUBKEY_2),
    disputeThreshold: 51,
    protocolFeeBps: 100,
    minArbiterStake: mockBN(1_000_000_000n),
    minAgentStake: mockBN(100_000_000n),
    maxClaimDuration: mockBN(86400),
    maxDisputeDuration: mockBN(172800),
    totalAgents: mockBN(10n),
    totalTasks: mockBN(100n),
    completedTasks: mockBN(50n),
    totalValueDistributed: mockBN(10_000_000_000n),
    bump: 255,
    multisigThreshold: 2,
    multisigOwnersLen: 3,
    taskCreationCooldown: mockBN(60),
    maxTasksPer24H: 10,
    disputeInitiationCooldown: mockBN(300),
    maxDisputesPer24H: 5,
    minStakeForDispute: mockBN(500_000_000n),
    slashPercentage: 10,
    stateUpdateCooldown: mockBN(60),
    votingPeriod: mockBN(86400),
    protocolVersion: 1,
    minSupportedVersion: 1,
    multisigOwners: [
      new PublicKey(TEST_PUBKEY_3),
      new PublicKey(TEST_PUBKEY_4),
      new PublicKey(TEST_PUBKEY_5),
      new PublicKey(TEST_PUBKEY_6),
      new PublicKey(TEST_PUBKEY_7),
    ],
  };
}

describe('MAX_MULTISIG_OWNERS', () => {
  it('equals 5', () => {
    expect(MAX_MULTISIG_OWNERS).toBe(5);
  });
});

describe('ProtocolConfig interface', () => {
  it('accepts valid structure', () => {
    // This test verifies the interface is correctly typed
    const config: ProtocolConfig = {
      authority: new PublicKey(TEST_PUBKEY_1),
      treasury: new PublicKey(TEST_PUBKEY_2),
      disputeThreshold: 51,
      protocolFeeBps: 100,
      minArbiterStake: 1_000_000_000n,
      minAgentStake: 100_000_000n,
      maxClaimDuration: 86400,
      maxDisputeDuration: 172800,
      totalAgents: 10n,
      totalTasks: 100n,
      completedTasks: 50n,
      totalValueDistributed: 10_000_000_000n,
      bump: 255,
      multisigThreshold: 2,
      multisigOwnersLen: 3,
      taskCreationCooldown: 60,
      maxTasksPer24h: 10,
      disputeInitiationCooldown: 300,
      maxDisputesPer24h: 5,
      minStakeForDispute: 500_000_000n,
      slashPercentage: 10,
      stateUpdateCooldown: 60,
      votingPeriod: 86400,
      protocolVersion: 1,
      minSupportedVersion: 1,
      multisigOwners: [new PublicKey(TEST_PUBKEY_3)],
    };

    expect(config.authority).toBeInstanceOf(PublicKey);
    expect(typeof config.disputeThreshold).toBe('number');
    expect(typeof config.minArbiterStake).toBe('bigint');
  });
});

describe('parseProtocolConfig', () => {
  describe('success cases', () => {
    it('parses valid mock data', () => {
      const mockData = createValidMockData();
      const config = parseProtocolConfig(mockData);

      expect(config.authority).toBeInstanceOf(PublicKey);
      expect(config.treasury).toBeInstanceOf(PublicKey);
      expect(config.disputeThreshold).toBe(51);
      expect(config.protocolFeeBps).toBe(100);
      expect(config.minArbiterStake).toBe(1_000_000_000n);
      expect(config.minAgentStake).toBe(100_000_000n);
      expect(config.maxClaimDuration).toBe(86400);
      expect(config.maxDisputeDuration).toBe(172800);
      expect(config.totalAgents).toBe(10n);
      expect(config.totalTasks).toBe(100n);
      expect(config.completedTasks).toBe(50n);
      expect(config.totalValueDistributed).toBe(10_000_000_000n);
      expect(config.bump).toBe(255);
      expect(config.multisigThreshold).toBe(2);
      expect(config.multisigOwnersLen).toBe(3);
      expect(config.taskCreationCooldown).toBe(60);
      expect(config.maxTasksPer24h).toBe(10);
      expect(config.disputeInitiationCooldown).toBe(300);
      expect(config.maxDisputesPer24h).toBe(5);
      expect(config.minStakeForDispute).toBe(500_000_000n);
      expect(config.slashPercentage).toBe(10);
      expect(config.stateUpdateCooldown).toBe(60);
      expect(config.votingPeriod).toBe(86400);
      expect(config.protocolVersion).toBe(1);
      expect(config.minSupportedVersion).toBe(1);
    });

    it('correctly converts u64 fields to bigint', () => {
      const mockData = createValidMockData();
      mockData.minArbiterStake = mockBN(9_007_199_254_740_993n); // > MAX_SAFE_INTEGER
      mockData.totalValueDistributed = mockBN(18_446_744_073_709_551_615n); // u64 max

      const config = parseProtocolConfig(mockData);

      expect(config.minArbiterStake).toBe(9_007_199_254_740_993n);
      expect(config.totalValueDistributed).toBe(18_446_744_073_709_551_615n);
    });

    it('correctly converts i64 duration fields to number', () => {
      const mockData = createValidMockData();
      mockData.maxClaimDuration = mockBN(604800); // 1 week in seconds
      mockData.maxDisputeDuration = mockBN(1209600); // 2 weeks

      const config = parseProtocolConfig(mockData);

      expect(config.maxClaimDuration).toBe(604800);
      expect(config.maxDisputeDuration).toBe(1209600);
      expect(typeof config.maxClaimDuration).toBe('number');
    });

    it('correctly slices multisigOwners to actual length', () => {
      const mockData = createValidMockData();
      mockData.multisigOwnersLen = 2;
      mockData.multisigOwners = [
        new PublicKey(TEST_PUBKEY_3),
        new PublicKey(TEST_PUBKEY_4),
        new PublicKey(TEST_PUBKEY_5),
        new PublicKey(TEST_PUBKEY_6),
        new PublicKey(TEST_PUBKEY_7),
      ];

      const config = parseProtocolConfig(mockData);

      expect(config.multisigOwners).toHaveLength(2);
      expect(config.multisigOwners[0].toBase58()).toBe(TEST_PUBKEY_3);
    });

    it('handles empty multisig owners (length 0)', () => {
      const mockData = createValidMockData();
      mockData.multisigOwnersLen = 0;

      const config = parseProtocolConfig(mockData);

      expect(config.multisigOwners).toHaveLength(0);
    });
  });

  describe('error cases - missing required fields', () => {
    it('throws on null input', () => {
      expect(() => parseProtocolConfig(null)).toThrow('Invalid protocol config data');
    });

    it('throws on undefined input', () => {
      expect(() => parseProtocolConfig(undefined)).toThrow('Invalid protocol config data');
    });

    it('throws on empty object', () => {
      expect(() => parseProtocolConfig({})).toThrow('Invalid protocol config data');
    });

    it('throws when authority is missing', () => {
      const mockData = createValidMockData();
      const { authority: _, ...dataWithoutAuthority } = mockData;

      expect(() => parseProtocolConfig(dataWithoutAuthority)).toThrow(
        'Invalid protocol config data'
      );
    });

    it('throws when authority is not a PublicKey', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).authority = 'not a pubkey';

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocol config data');
    });

    it('throws when treasury is missing', () => {
      const mockData = createValidMockData();
      const { treasury: _, ...dataWithoutTreasury } = mockData;

      expect(() => parseProtocolConfig(dataWithoutTreasury)).toThrow(
        'Invalid protocol config data'
      );
    });

    it('throws when disputeThreshold is not a number', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).disputeThreshold = 'not a number';

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocol config data');
    });

    it('throws when protocolFeeBps is not a number', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).protocolFeeBps = null;

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocol config data');
    });

    it('throws when bump is not a number', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).bump = undefined;

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocol config data');
    });

    it('throws when multisigThreshold is not a number', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).multisigThreshold = 'two';

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocol config data');
    });

    it('throws when multisigOwnersLen is not a number', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).multisigOwnersLen = null;

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocol config data');
    });

    it('throws when BN fields are missing toNumber/toString', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).minArbiterStake = 123; // number instead of BN-like

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocol config data');
    });

    it('throws when multisigOwners is not an array', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).multisigOwners = 'not an array';

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocol config data');
    });

    it('throws when multisigOwners contains non-PublicKey elements', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).multisigOwners = [
        'not a pubkey',
        new PublicKey(TEST_PUBKEY_1),
      ];

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocol config data');
    });
  });

  describe('error cases - range validation', () => {
    it('throws when disputeThreshold is 0', () => {
      const mockData = createValidMockData();
      mockData.disputeThreshold = 0;

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid disputeThreshold');
      expect(() => parseProtocolConfig(mockData)).toThrow('must be 1-100');
    });

    it('throws when disputeThreshold exceeds 100', () => {
      const mockData = createValidMockData();
      mockData.disputeThreshold = 101;

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid disputeThreshold: 101');
      expect(() => parseProtocolConfig(mockData)).toThrow('must be 1-100');
    });

    it('throws when protocolFeeBps exceeds 10000', () => {
      const mockData = createValidMockData();
      mockData.protocolFeeBps = 10001;

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid protocolFeeBps: 10001');
      expect(() => parseProtocolConfig(mockData)).toThrow('must be <= 10000');
    });

    it('allows protocolFeeBps at max (10000 = 100%)', () => {
      const mockData = createValidMockData();
      mockData.protocolFeeBps = 10000;

      const config = parseProtocolConfig(mockData);
      expect(config.protocolFeeBps).toBe(10000);
    });

    it('throws when slashPercentage exceeds 100', () => {
      const mockData = createValidMockData();
      mockData.slashPercentage = 101;

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid slashPercentage: 101');
      expect(() => parseProtocolConfig(mockData)).toThrow('must be 0-100');
    });

    it('allows slashPercentage at boundary values (0 and 100)', () => {
      const mockData = createValidMockData();

      mockData.slashPercentage = 0;
      let config = parseProtocolConfig(mockData);
      expect(config.slashPercentage).toBe(0);

      mockData.slashPercentage = 100;
      config = parseProtocolConfig(mockData);
      expect(config.slashPercentage).toBe(100);
    });

    it('throws when multisigOwnersLen exceeds MAX_MULTISIG_OWNERS', () => {
      const mockData = createValidMockData();
      mockData.multisigOwnersLen = 6;

      expect(() => parseProtocolConfig(mockData)).toThrow('Invalid multisigOwnersLen: 6');
      expect(() => parseProtocolConfig(mockData)).toThrow('exceeds maximum 5');
    });

    it('allows multisigOwnersLen at MAX_MULTISIG_OWNERS', () => {
      const mockData = createValidMockData();
      mockData.multisigOwnersLen = 5;

      const config = parseProtocolConfig(mockData);
      expect(config.multisigOwnersLen).toBe(5);
      expect(config.multisigOwners).toHaveLength(5);
    });
  });

  describe('edge cases', () => {
    it('handles zero values for optional fields', () => {
      const mockData = createValidMockData();
      mockData.taskCreationCooldown = mockBN(0);
      mockData.maxTasksPer24H = 0;
      mockData.disputeInitiationCooldown = mockBN(0);
      mockData.maxDisputesPer24H = 0;

      const config = parseProtocolConfig(mockData);

      expect(config.taskCreationCooldown).toBe(0);
      expect(config.maxTasksPer24h).toBe(0);
      expect(config.disputeInitiationCooldown).toBe(0);
      expect(config.maxDisputesPer24h).toBe(0);
    });

    it('handles maximum u8 values', () => {
      const mockData = createValidMockData();
      mockData.bump = 255;
      mockData.maxTasksPer24H = 255;
      mockData.maxDisputesPer24H = 255;
      mockData.disputeThreshold = 100; // max valid

      const config = parseProtocolConfig(mockData);

      expect(config.bump).toBe(255);
      expect(config.maxTasksPer24h).toBe(255);
      expect(config.maxDisputesPer24h).toBe(255);
      expect(config.disputeThreshold).toBe(100);
    });

    it('handles minimum valid disputeThreshold (1)', () => {
      const mockData = createValidMockData();
      mockData.disputeThreshold = 1;

      const config = parseProtocolConfig(mockData);
      expect(config.disputeThreshold).toBe(1);
    });
  });
});
