import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  // Constants
  AgentCapabilities,
  AGENT_REGISTRATION_SIZE,
  AGENT_ID_LENGTH,
  MAX_ENDPOINT_LENGTH,
  MAX_METADATA_URI_LENGTH,
  MAX_REPUTATION,
  MAX_U8,
  CAPABILITY_NAMES,
  // Enum
  AgentStatus,
  // Functions
  agentStatusToString,
  isValidAgentStatus,
  hasCapability,
  getCapabilityNames,
  createCapabilityMask,
  parseAgentState,
  computeRateLimitState,
  // Types
  type AgentState,
} from './types';

/**
 * Mock BN-like object for testing (matches Anchor's BN type)
 */
function mockBN(value: bigint | number): { toNumber: () => number; toString: () => string } {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

// Well-known valid Solana addresses for testing
const TEST_PUBKEY_1 = '11111111111111111111111111111111';

/**
 * Creates a valid 32-byte agent ID
 */
function createAgentId(seed = 0): number[] {
  return Array(32)
    .fill(0)
    .map((_, i) => (seed + i) % 256);
}

/**
 * Creates valid mock agent registration data
 */
function createValidMockData() {
  return {
    agentId: createAgentId(42),
    authority: new PublicKey(TEST_PUBKEY_1),
    capabilities: mockBN(3n), // COMPUTE | INFERENCE
    status: { active: {} }, // Anchor enum format
    endpoint: 'https://agent.example.com',
    metadataUri: 'https://metadata.example.com/agent.json',
    registeredAt: mockBN(1700000000),
    lastActive: mockBN(1700001000),
    tasksCompleted: mockBN(100n),
    totalEarned: mockBN(50_000_000_000n), // 50 SOL
    reputation: 8500, // 85.00%
    activeTasks: 2,
    stake: mockBN(1_000_000_000n), // 1 SOL
    bump: 255,
    lastTaskCreated: mockBN(1700000500),
    lastDisputeInitiated: mockBN(1699990000),
    taskCount24h: 5,
    disputeCount24h: 1,
    rateLimitWindowStart: mockBN(1699920000),
    activeDisputeVotes: 0,
    lastVoteTimestamp: mockBN(0),
    lastStateUpdate: mockBN(1700001000),
  };
}

// ============================================================================
// Constants Tests
// ============================================================================

describe('Agent Constants', () => {
  describe('AGENT_REGISTRATION_SIZE', () => {
    it('equals 438 bytes (matches state.rs)', () => {
      expect(AGENT_REGISTRATION_SIZE).toBe(438);
    });
  });

  describe('AGENT_ID_LENGTH', () => {
    it('equals 32 bytes', () => {
      expect(AGENT_ID_LENGTH).toBe(32);
    });
  });

  describe('MAX_ENDPOINT_LENGTH', () => {
    it('equals 128 characters', () => {
      expect(MAX_ENDPOINT_LENGTH).toBe(128);
    });
  });

  describe('MAX_METADATA_URI_LENGTH', () => {
    it('equals 128 characters', () => {
      expect(MAX_METADATA_URI_LENGTH).toBe(128);
    });
  });

  describe('MAX_REPUTATION', () => {
    it('equals 10000 (100.00%)', () => {
      expect(MAX_REPUTATION).toBe(10000);
    });
  });

  describe('MAX_U8', () => {
    it('equals 255', () => {
      expect(MAX_U8).toBe(255);
    });
  });

  describe('CAPABILITY_NAMES', () => {
    it('contains all 10 capability names', () => {
      expect(CAPABILITY_NAMES).toHaveLength(10);
      expect(CAPABILITY_NAMES).toContain('COMPUTE');
      expect(CAPABILITY_NAMES).toContain('INFERENCE');
      expect(CAPABILITY_NAMES).toContain('STORAGE');
      expect(CAPABILITY_NAMES).toContain('NETWORK');
      expect(CAPABILITY_NAMES).toContain('SENSOR');
      expect(CAPABILITY_NAMES).toContain('ACTUATOR');
      expect(CAPABILITY_NAMES).toContain('COORDINATOR');
      expect(CAPABILITY_NAMES).toContain('ARBITER');
      expect(CAPABILITY_NAMES).toContain('VALIDATOR');
      expect(CAPABILITY_NAMES).toContain('AGGREGATOR');
    });
  });
});

describe('AgentCapabilities', () => {
  it('COMPUTE equals 1n << 0n', () => {
    expect(AgentCapabilities.COMPUTE).toBe(1n);
  });

  it('INFERENCE equals 1n << 1n', () => {
    expect(AgentCapabilities.INFERENCE).toBe(2n);
  });

  it('STORAGE equals 1n << 2n', () => {
    expect(AgentCapabilities.STORAGE).toBe(4n);
  });

  it('NETWORK equals 1n << 3n', () => {
    expect(AgentCapabilities.NETWORK).toBe(8n);
  });

  it('SENSOR equals 1n << 4n', () => {
    expect(AgentCapabilities.SENSOR).toBe(16n);
  });

  it('ACTUATOR equals 1n << 5n', () => {
    expect(AgentCapabilities.ACTUATOR).toBe(32n);
  });

  it('COORDINATOR equals 1n << 6n', () => {
    expect(AgentCapabilities.COORDINATOR).toBe(64n);
  });

  it('ARBITER equals 1n << 7n', () => {
    expect(AgentCapabilities.ARBITER).toBe(128n);
  });

  it('VALIDATOR equals 1n << 8n', () => {
    expect(AgentCapabilities.VALIDATOR).toBe(256n);
  });

  it('AGGREGATOR equals 1n << 9n', () => {
    expect(AgentCapabilities.AGGREGATOR).toBe(512n);
  });

  it('all capabilities are unique powers of 2', () => {
    const values = Object.values(AgentCapabilities);
    const unique = new Set(values.map((v) => v.toString()));
    expect(unique.size).toBe(values.length);

    for (const value of values) {
      // Check it's a power of 2
      expect(value > 0n).toBe(true);
      expect((value & (value - 1n)) === 0n).toBe(true);
    }
  });
});

// ============================================================================
// AgentStatus Tests
// ============================================================================

describe('AgentStatus', () => {
  describe('enum values', () => {
    it('Inactive equals 0', () => {
      expect(AgentStatus.Inactive).toBe(0);
    });

    it('Active equals 1', () => {
      expect(AgentStatus.Active).toBe(1);
    });

    it('Busy equals 2', () => {
      expect(AgentStatus.Busy).toBe(2);
    });

    it('Suspended equals 3', () => {
      expect(AgentStatus.Suspended).toBe(3);
    });
  });

  describe('agentStatusToString', () => {
    it('converts Inactive', () => {
      expect(agentStatusToString(AgentStatus.Inactive)).toBe('Inactive');
    });

    it('converts Active', () => {
      expect(agentStatusToString(AgentStatus.Active)).toBe('Active');
    });

    it('converts Busy', () => {
      expect(agentStatusToString(AgentStatus.Busy)).toBe('Busy');
    });

    it('converts Suspended', () => {
      expect(agentStatusToString(AgentStatus.Suspended)).toBe('Suspended');
    });

    it('handles unknown values gracefully', () => {
      expect(agentStatusToString(99 as AgentStatus)).toBe('Unknown (99)');
    });
  });

  describe('isValidAgentStatus', () => {
    it('returns true for valid values (0-3)', () => {
      expect(isValidAgentStatus(0)).toBe(true);
      expect(isValidAgentStatus(1)).toBe(true);
      expect(isValidAgentStatus(2)).toBe(true);
      expect(isValidAgentStatus(3)).toBe(true);
    });

    it('returns false for negative values', () => {
      expect(isValidAgentStatus(-1)).toBe(false);
    });

    it('returns false for values > 3', () => {
      expect(isValidAgentStatus(4)).toBe(false);
      expect(isValidAgentStatus(255)).toBe(false);
    });

    it('returns false for non-integers', () => {
      expect(isValidAgentStatus(1.5)).toBe(false);
    });
  });
});

// ============================================================================
// Capability Helper Tests
// ============================================================================

describe('hasCapability', () => {
  it('returns true when capability is present', () => {
    const caps = AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE;
    expect(hasCapability(caps, AgentCapabilities.COMPUTE)).toBe(true);
    expect(hasCapability(caps, AgentCapabilities.INFERENCE)).toBe(true);
  });

  it('returns false when capability is absent', () => {
    const caps = AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE;
    expect(hasCapability(caps, AgentCapabilities.STORAGE)).toBe(false);
    expect(hasCapability(caps, AgentCapabilities.ARBITER)).toBe(false);
  });

  it('handles zero capabilities', () => {
    expect(hasCapability(0n, AgentCapabilities.COMPUTE)).toBe(false);
  });

  it('handles all capabilities', () => {
    const allCaps = Object.values(AgentCapabilities).reduce((acc, cap) => acc | cap, 0n);
    for (const cap of Object.values(AgentCapabilities)) {
      expect(hasCapability(allCaps, cap)).toBe(true);
    }
  });
});

describe('getCapabilityNames', () => {
  it('returns empty array for zero capabilities', () => {
    expect(getCapabilityNames(0n)).toEqual([]);
  });

  it('returns single capability name', () => {
    expect(getCapabilityNames(AgentCapabilities.COMPUTE)).toEqual(['COMPUTE']);
  });

  it('returns multiple capability names in order', () => {
    const caps = AgentCapabilities.COMPUTE | AgentCapabilities.ARBITER;
    const names = getCapabilityNames(caps);
    expect(names).toContain('COMPUTE');
    expect(names).toContain('ARBITER');
    expect(names).toHaveLength(2);
  });

  it('returns all capability names when all set', () => {
    const allCaps = Object.values(AgentCapabilities).reduce((acc, cap) => acc | cap, 0n);
    const names = getCapabilityNames(allCaps);
    expect(names).toHaveLength(10);
    for (const name of CAPABILITY_NAMES) {
      expect(names).toContain(name);
    }
  });
});

describe('createCapabilityMask', () => {
  it('returns 0n for empty array', () => {
    expect(createCapabilityMask([])).toBe(0n);
  });

  it('creates mask from single capability', () => {
    expect(createCapabilityMask(['COMPUTE'])).toBe(AgentCapabilities.COMPUTE);
  });

  it('creates mask from multiple capabilities', () => {
    const mask = createCapabilityMask(['COMPUTE', 'INFERENCE', 'ARBITER']);
    const expected =
      AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE | AgentCapabilities.ARBITER;
    expect(mask).toBe(expected);
  });

  it('is inverse of getCapabilityNames', () => {
    const original =
      AgentCapabilities.STORAGE | AgentCapabilities.NETWORK | AgentCapabilities.AGGREGATOR;
    const names = getCapabilityNames(original);
    const reconstructed = createCapabilityMask(names);
    expect(reconstructed).toBe(original);
  });
});

// ============================================================================
// parseAgentState Tests
// ============================================================================

describe('parseAgentState', () => {
  describe('success cases', () => {
    it('parses valid mock data', () => {
      const mockData = createValidMockData();
      const agent = parseAgentState(mockData);

      expect(agent.agentId).toBeInstanceOf(Uint8Array);
      expect(agent.agentId.length).toBe(32);
      expect(agent.authority).toBeInstanceOf(PublicKey);
      expect(agent.capabilities).toBe(3n);
      expect(agent.status).toBe(AgentStatus.Active);
      expect(agent.endpoint).toBe('https://agent.example.com');
      expect(agent.metadataUri).toBe('https://metadata.example.com/agent.json');
      expect(agent.registeredAt).toBe(1700000000);
      expect(agent.lastActive).toBe(1700001000);
      expect(agent.tasksCompleted).toBe(100n);
      expect(agent.totalEarned).toBe(50_000_000_000n);
      expect(agent.reputation).toBe(8500);
      expect(agent.activeTasks).toBe(2);
      expect(agent.stake).toBe(1_000_000_000n);
      expect(agent.bump).toBe(255);
      expect(agent.lastTaskCreated).toBe(1700000500);
      expect(agent.lastDisputeInitiated).toBe(1699990000);
      expect(agent.taskCount24h).toBe(5);
      expect(agent.disputeCount24h).toBe(1);
      expect(agent.rateLimitWindowStart).toBe(1699920000);
      expect(agent.activeDisputeVotes).toBe(0);
      expect(agent.lastVoteTimestamp).toBe(0);
      expect(agent.lastStateUpdate).toBe(1700001000);
    });

    it('correctly converts u64 fields to bigint', () => {
      const mockData = createValidMockData();
      // Use value > MAX_SAFE_INTEGER
      mockData.totalEarned = mockBN(9_007_199_254_740_993n);
      mockData.stake = mockBN(18_446_744_073_709_551_615n); // u64 max

      const agent = parseAgentState(mockData);

      expect(agent.totalEarned).toBe(9_007_199_254_740_993n);
      expect(agent.stake).toBe(18_446_744_073_709_551_615n);
    });

    it('correctly converts i64 timestamp fields to number', () => {
      const mockData = createValidMockData();
      mockData.registeredAt = mockBN(1704067200); // Jan 1, 2024

      const agent = parseAgentState(mockData);

      expect(agent.registeredAt).toBe(1704067200);
      expect(typeof agent.registeredAt).toBe('number');
    });

    it('handles Uint8Array agentId', () => {
      const mockData = createValidMockData();
      mockData.agentId = new Uint8Array(createAgentId(99));

      const agent = parseAgentState(mockData);

      expect(agent.agentId).toBeInstanceOf(Uint8Array);
      expect(agent.agentId[0]).toBe(99);
    });

    it('parses all AgentStatus enum variants', () => {
      const mockData = createValidMockData();

      // Test Inactive
      mockData.status = { inactive: {} };
      expect(parseAgentState(mockData).status).toBe(AgentStatus.Inactive);

      // Test Active
      mockData.status = { active: {} };
      expect(parseAgentState(mockData).status).toBe(AgentStatus.Active);

      // Test Busy
      mockData.status = { busy: {} };
      expect(parseAgentState(mockData).status).toBe(AgentStatus.Busy);

      // Test Suspended
      mockData.status = { suspended: {} };
      expect(parseAgentState(mockData).status).toBe(AgentStatus.Suspended);
    });

    it('parses numeric status values', () => {
      const mockData = createValidMockData();
      mockData.status = 2; // Busy

      const agent = parseAgentState(mockData);
      expect(agent.status).toBe(AgentStatus.Busy);
    });

    it('handles empty strings for endpoint and metadataUri', () => {
      const mockData = createValidMockData();
      mockData.endpoint = '';
      mockData.metadataUri = '';

      const agent = parseAgentState(mockData);

      expect(agent.endpoint).toBe('');
      expect(agent.metadataUri).toBe('');
    });
  });

  describe('error cases - missing required fields', () => {
    it('throws on null input', () => {
      expect(() => parseAgentState(null)).toThrow('Invalid agent registration data');
    });

    it('throws on undefined input', () => {
      expect(() => parseAgentState(undefined)).toThrow('Invalid agent registration data');
    });

    it('throws on empty object', () => {
      expect(() => parseAgentState({})).toThrow('Invalid agent registration data');
    });

    it('throws when agentId is missing', () => {
      const mockData = createValidMockData();
      const { agentId: _, ...dataWithoutAgentId } = mockData;

      expect(() => parseAgentState(dataWithoutAgentId)).toThrow(
        'Invalid agent registration data'
      );
    });

    it('throws when authority is not a PublicKey', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).authority = 'not a pubkey';

      expect(() => parseAgentState(mockData)).toThrow('Invalid agent registration data');
    });

    it('throws when capabilities is not BN-like', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).capabilities = 3; // number instead of BN

      expect(() => parseAgentState(mockData)).toThrow('Invalid agent registration data');
    });

    it('throws when timestamp BN fields are missing toNumber', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).registeredAt = { toString: () => '123' }; // missing toNumber

      expect(() => parseAgentState(mockData)).toThrow('Invalid agent registration data');
    });

    it('throws when reputation is not a number', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).reputation = '8500';

      expect(() => parseAgentState(mockData)).toThrow('Invalid agent registration data');
    });

    it('throws when endpoint is not a string', () => {
      const mockData = createValidMockData();
      (mockData as Record<string, unknown>).endpoint = 123;

      expect(() => parseAgentState(mockData)).toThrow('Invalid agent registration data');
    });
  });

  describe('error cases - range validation', () => {
    it('throws when agentId has wrong length', () => {
      const mockData = createValidMockData();
      mockData.agentId = [1, 2, 3]; // Only 3 bytes

      expect(() => parseAgentState(mockData)).toThrow('Invalid agentId length: 3');
      expect(() => parseAgentState(mockData)).toThrow('must be 32');
    });

    it('throws when reputation exceeds MAX_REPUTATION', () => {
      const mockData = createValidMockData();
      mockData.reputation = 10001;

      expect(() => parseAgentState(mockData)).toThrow('Invalid reputation: 10001');
      expect(() => parseAgentState(mockData)).toThrow('must be 0-10000');
    });

    it('allows reputation at MAX_REPUTATION', () => {
      const mockData = createValidMockData();
      mockData.reputation = 10000;

      const agent = parseAgentState(mockData);
      expect(agent.reputation).toBe(10000);
    });

    it('allows reputation at 0', () => {
      const mockData = createValidMockData();
      mockData.reputation = 0;

      const agent = parseAgentState(mockData);
      expect(agent.reputation).toBe(0);
    });

    it('throws when activeTasks exceeds MAX_U8', () => {
      const mockData = createValidMockData();
      mockData.activeTasks = 256;

      expect(() => parseAgentState(mockData)).toThrow('Invalid activeTasks: 256');
    });

    it('throws when taskCount24h exceeds MAX_U8', () => {
      const mockData = createValidMockData();
      mockData.taskCount24h = 256;

      expect(() => parseAgentState(mockData)).toThrow('Invalid taskCount24h: 256');
    });

    it('throws when disputeCount24h exceeds MAX_U8', () => {
      const mockData = createValidMockData();
      mockData.disputeCount24h = 256;

      expect(() => parseAgentState(mockData)).toThrow('Invalid disputeCount24h: 256');
    });

    it('throws when activeDisputeVotes exceeds MAX_U8', () => {
      const mockData = createValidMockData();
      mockData.activeDisputeVotes = 256;

      expect(() => parseAgentState(mockData)).toThrow('Invalid activeDisputeVotes: 256');
    });

    it('throws when bump exceeds MAX_U8', () => {
      const mockData = createValidMockData();
      mockData.bump = 256;

      expect(() => parseAgentState(mockData)).toThrow('Invalid bump: 256');
    });

    it('throws when endpoint exceeds MAX_ENDPOINT_LENGTH', () => {
      const mockData = createValidMockData();
      mockData.endpoint = 'x'.repeat(129);

      expect(() => parseAgentState(mockData)).toThrow('Invalid endpoint length: 129');
      expect(() => parseAgentState(mockData)).toThrow('must be <= 128');
    });

    it('allows endpoint at MAX_ENDPOINT_LENGTH', () => {
      const mockData = createValidMockData();
      mockData.endpoint = 'x'.repeat(128);

      const agent = parseAgentState(mockData);
      expect(agent.endpoint.length).toBe(128);
    });

    it('throws when metadataUri exceeds MAX_METADATA_URI_LENGTH', () => {
      const mockData = createValidMockData();
      mockData.metadataUri = 'y'.repeat(129);

      expect(() => parseAgentState(mockData)).toThrow('Invalid metadataUri length: 129');
    });

    it('throws on invalid numeric status', () => {
      const mockData = createValidMockData();
      mockData.status = 99; // Invalid status

      expect(() => parseAgentState(mockData)).toThrow('Invalid agent status value: 99');
    });

    it('throws on empty object status', () => {
      const mockData = createValidMockData();
      mockData.status = {}; // Empty object - no variant key

      expect(() => parseAgentState(mockData)).toThrow('Invalid agent status format');
    });

    it('throws when agentId has too many bytes', () => {
      const mockData = createValidMockData();
      mockData.agentId = Array(64).fill(1); // 64 bytes instead of 32

      expect(() => parseAgentState(mockData)).toThrow('Invalid agentId length: 64');
    });

    it('allows metadataUri at MAX_METADATA_URI_LENGTH', () => {
      const mockData = createValidMockData();
      mockData.metadataUri = 'y'.repeat(128);

      const agent = parseAgentState(mockData);
      expect(agent.metadataUri.length).toBe(128);
    });
  });

  describe('edge cases', () => {
    it('handles zero values for rate limiting fields', () => {
      const mockData = createValidMockData();
      mockData.lastTaskCreated = mockBN(0);
      mockData.lastDisputeInitiated = mockBN(0);
      mockData.taskCount24h = 0;
      mockData.disputeCount24h = 0;
      mockData.rateLimitWindowStart = mockBN(0);
      mockData.activeDisputeVotes = 0;
      mockData.lastVoteTimestamp = mockBN(0);

      const agent = parseAgentState(mockData);

      expect(agent.lastTaskCreated).toBe(0);
      expect(agent.lastDisputeInitiated).toBe(0);
      expect(agent.taskCount24h).toBe(0);
      expect(agent.disputeCount24h).toBe(0);
      expect(agent.rateLimitWindowStart).toBe(0);
      expect(agent.activeDisputeVotes).toBe(0);
      expect(agent.lastVoteTimestamp).toBe(0);
    });

    it('handles maximum u8 values', () => {
      const mockData = createValidMockData();
      mockData.activeTasks = 255;
      mockData.taskCount24h = 255;
      mockData.disputeCount24h = 255;
      mockData.activeDisputeVotes = 255;
      mockData.bump = 255;

      const agent = parseAgentState(mockData);

      expect(agent.activeTasks).toBe(255);
      expect(agent.taskCount24h).toBe(255);
      expect(agent.disputeCount24h).toBe(255);
      expect(agent.activeDisputeVotes).toBe(255);
      expect(agent.bump).toBe(255);
    });

    it('handles zero capabilities', () => {
      const mockData = createValidMockData();
      mockData.capabilities = mockBN(0n);

      const agent = parseAgentState(mockData);

      expect(agent.capabilities).toBe(0n);
      expect(getCapabilityNames(agent.capabilities)).toEqual([]);
    });

    it('handles all capabilities set', () => {
      const allCaps = Object.values(AgentCapabilities).reduce((acc, cap) => acc | cap, 0n);
      const mockData = createValidMockData();
      mockData.capabilities = mockBN(allCaps);

      const agent = parseAgentState(mockData);

      expect(agent.capabilities).toBe(allCaps);
      expect(getCapabilityNames(agent.capabilities)).toHaveLength(10);
    });
  });
});

// ============================================================================
// AgentState Interface Tests
// ============================================================================

describe('AgentState interface', () => {
  it('accepts valid structure', () => {
    const agent: AgentState = {
      agentId: new Uint8Array(32),
      authority: new PublicKey(TEST_PUBKEY_1),
      bump: 255,
      capabilities: AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE,
      status: AgentStatus.Active,
      registeredAt: 1700000000,
      lastActive: 1700001000,
      endpoint: 'https://agent.example.com',
      metadataUri: 'https://metadata.example.com/agent.json',
      tasksCompleted: 100n,
      totalEarned: 50_000_000_000n,
      reputation: 8500,
      activeTasks: 2,
      stake: 1_000_000_000n,
      lastTaskCreated: 1700000500,
      lastDisputeInitiated: 1699990000,
      taskCount24h: 5,
      disputeCount24h: 1,
      rateLimitWindowStart: 1699920000,
      activeDisputeVotes: 0,
      lastVoteTimestamp: 0,
      lastStateUpdate: 1700001000,
    };

    expect(agent.authority).toBeInstanceOf(PublicKey);
    expect(typeof agent.capabilities).toBe('bigint');
    expect(typeof agent.tasksCompleted).toBe('bigint');
    expect(typeof agent.reputation).toBe('number');
  });
});

// ============================================================================
// computeRateLimitState Tests
// ============================================================================

describe('computeRateLimitState', () => {
  const baseConfig = {
    taskCreationCooldown: 60, // 60 seconds
    maxTasksPer24h: 50,
    disputeInitiationCooldown: 300, // 5 minutes
    maxDisputesPer24h: 10,
  };

  it('allows action when cooldown passed and under limit', () => {
    const agent = {
      lastTaskCreated: 1700000000,
      lastDisputeInitiated: 1700000000,
      taskCount24h: 5,
      disputeCount24h: 1,
      rateLimitWindowStart: 1700000000,
    };
    const now = 1700001000; // 1000 seconds later

    const state = computeRateLimitState(agent, baseConfig, now);

    expect(state.canCreateTask).toBe(true);
    expect(state.canInitiateDispute).toBe(true);
    expect(state.taskCooldownEnds).toBe(0);
    expect(state.disputeCooldownEnds).toBe(0);
    expect(state.tasksRemainingIn24h).toBe(45);
    expect(state.disputesRemainingIn24h).toBe(9);
  });

  it('blocks action during cooldown', () => {
    const agent = {
      lastTaskCreated: 1700000000,
      lastDisputeInitiated: 1700000000,
      taskCount24h: 5,
      disputeCount24h: 1,
      rateLimitWindowStart: 1700000000,
    };
    const now = 1700000030; // Only 30 seconds later

    const state = computeRateLimitState(agent, baseConfig, now);

    expect(state.canCreateTask).toBe(false);
    expect(state.canInitiateDispute).toBe(false);
    expect(state.taskCooldownEnds).toBe(1700000060);
    expect(state.disputeCooldownEnds).toBe(1700000300);
  });

  it('blocks action when 24h limit reached', () => {
    const agent = {
      lastTaskCreated: 1700000000,
      lastDisputeInitiated: 1700000000,
      taskCount24h: 50, // At limit
      disputeCount24h: 10, // At limit
      rateLimitWindowStart: 1700000000,
    };
    const now = 1700001000;

    const state = computeRateLimitState(agent, baseConfig, now);

    expect(state.canCreateTask).toBe(false);
    expect(state.canInitiateDispute).toBe(false);
    expect(state.tasksRemainingIn24h).toBe(0);
    expect(state.disputesRemainingIn24h).toBe(0);
  });

  it('resets counts when 24h window expires', () => {
    const agent = {
      lastTaskCreated: 1700000000,
      lastDisputeInitiated: 1700000000,
      taskCount24h: 50,
      disputeCount24h: 10,
      rateLimitWindowStart: 1700000000,
    };
    const now = 1700000000 + 86400 + 1000; // More than 24h later

    const state = computeRateLimitState(agent, baseConfig, now);

    // Window expired, so counts reset to 0
    expect(state.tasksRemainingIn24h).toBe(50);
    expect(state.disputesRemainingIn24h).toBe(10);
    expect(state.canCreateTask).toBe(true);
    expect(state.canInitiateDispute).toBe(true);
  });

  it('handles unlimited tasks (maxTasksPer24h = 0)', () => {
    const config = { ...baseConfig, maxTasksPer24h: 0 };
    const agent = {
      lastTaskCreated: 1700000000,
      lastDisputeInitiated: 1700000000,
      taskCount24h: 255,
      disputeCount24h: 1,
      rateLimitWindowStart: 1700000000,
    };
    const now = 1700001000;

    const state = computeRateLimitState(agent, config, now);

    expect(state.canCreateTask).toBe(true);
    expect(state.tasksRemainingIn24h).toBe(255); // MAX_U8
  });

  it('handles unlimited disputes (maxDisputesPer24h = 0)', () => {
    const config = { ...baseConfig, maxDisputesPer24h: 0 };
    const agent = {
      lastTaskCreated: 1700000000,
      lastDisputeInitiated: 1700000000,
      taskCount24h: 5,
      disputeCount24h: 255,
      rateLimitWindowStart: 1700000000,
    };
    const now = 1700001000;

    const state = computeRateLimitState(agent, config, now);

    expect(state.canInitiateDispute).toBe(true);
    expect(state.disputesRemainingIn24h).toBe(255); // MAX_U8
  });

  it('handles zero cooldowns (disabled)', () => {
    const config = {
      taskCreationCooldown: 0,
      maxTasksPer24h: 50,
      disputeInitiationCooldown: 0,
      maxDisputesPer24h: 10,
    };
    const agent = {
      lastTaskCreated: 1700000000,
      lastDisputeInitiated: 1700000000,
      taskCount24h: 5,
      disputeCount24h: 1,
      rateLimitWindowStart: 1700000000,
    };
    const now = 1700000001; // Only 1 second later

    const state = computeRateLimitState(agent, config, now);

    expect(state.canCreateTask).toBe(true);
    expect(state.canInitiateDispute).toBe(true);
    expect(state.taskCooldownEnds).toBe(0);
    expect(state.disputeCooldownEnds).toBe(0);
  });

  it('handles edge case: exactly at cooldown end', () => {
    const agent = {
      lastTaskCreated: 1700000000,
      lastDisputeInitiated: 1700000000,
      taskCount24h: 5,
      disputeCount24h: 1,
      rateLimitWindowStart: 1700000000,
    };
    const now = 1700000060; // Exactly at task cooldown end

    const state = computeRateLimitState(agent, baseConfig, now);

    expect(state.canCreateTask).toBe(true);
    expect(state.taskCooldownEnds).toBe(0);
  });
});
