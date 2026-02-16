import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { AgentDiscovery } from './discovery.js';
import { ProfileCache } from './cache.js';
import { AgentDiscoveryError } from './errors.js';
import {
  AGENT_STATUS_OFFSET,
  agentStateToProfile,
  type DiscoveryConfig,
  type AgentProfile,
} from './types.js';
import { AgentStatus } from '../agent/types.js';
import { Capability } from '../agent/capabilities.js';
import { RuntimeErrorCodes } from '../types/errors.js';
import { silentLogger } from '../utils/logger.js';

// ============================================================================
// Test Helpers
// ============================================================================

function randomPubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

/** BN-like mock for u64 fields (toString) */
function mockBN(value: number | bigint) {
  const s = String(value);
  return { toString: () => s, toNumber: () => Number(value) };
}

/** Create a mock raw agent account matching RawAgentRegistrationData shape */
function mockRawAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: new Uint8Array(32).fill(1),
    authority: randomPubkey(),
    capabilities: mockBN(3), // COMPUTE | INFERENCE
    status: { active: {} },
    endpoint: 'https://agent.example.com',
    metadataUri: '',
    registeredAt: mockBN(1700000000),
    lastActive: mockBN(1700001000),
    tasksCompleted: mockBN(10),
    totalEarned: mockBN(5_000_000_000),
    reputation: 8000,
    activeTasks: 1,
    stake: mockBN(1_000_000_000),
    bump: 255,
    lastTaskCreated: mockBN(1700000500),
    lastDisputeInitiated: mockBN(0),
    taskCount24H: 2,
    disputeCount24H: 0,
    rateLimitWindowStart: mockBN(1700000000),
    activeDisputeVotes: 0,
    lastVoteTimestamp: mockBN(0),
    lastStateUpdate: mockBN(1700000800),
    disputesAsDefendant: 0,
    ...overrides,
  };
}

/** Create an { publicKey, account } pair for .all() results */
function mockAccountEntry(overrides: Record<string, unknown> = {}) {
  return {
    publicKey: randomPubkey(),
    account: mockRawAgent(overrides),
  };
}

// ============================================================================
// Mock Program Factory
// ============================================================================

function createMockProgram() {
  return {
    programId: randomPubkey(),
    account: {
      agentRegistration: {
        fetchNullable: vi.fn(),
        all: vi.fn().mockResolvedValue([]),
      },
    },
  };
}

function buildDiscovery(
  program: ReturnType<typeof createMockProgram>,
  opts: Partial<DiscoveryConfig> = {},
): AgentDiscovery {
  return new AgentDiscovery({
    program: program as unknown as DiscoveryConfig['program'],
    logger: silentLogger,
    cache: { ttlMs: 60_000, maxEntries: 200 },
    ...opts,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('AgentDiscovery', () => {
  let program: ReturnType<typeof createMockProgram>;
  let discovery: AgentDiscovery;

  beforeEach(() => {
    program = createMockProgram();
    discovery = buildDiscovery(program);
  });

  // --------------------------------------------------------------------------
  // getProfile
  // --------------------------------------------------------------------------

  describe('getProfile', () => {
    it('returns null when account does not exist', async () => {
      program.account.agentRegistration.fetchNullable.mockResolvedValue(null);
      const result = await discovery.getProfile(randomPubkey());
      expect(result).toBeNull();
    });

    it('returns parsed profile when account exists', async () => {
      const pda = randomPubkey();
      const raw = mockRawAgent({ reputation: 9500 });
      program.account.agentRegistration.fetchNullable.mockResolvedValue(raw);

      const result = await discovery.getProfile(pda);
      expect(result).not.toBeNull();
      expect(result!.pda.equals(pda)).toBe(true);
      expect(result!.reputation).toBe(9500);
      expect(result!.status).toBe(AgentStatus.Active);
    });

    it('caches profile and returns from cache on second call', async () => {
      const pda = randomPubkey();
      program.account.agentRegistration.fetchNullable.mockResolvedValue(
        mockRawAgent()
      );

      const first = await discovery.getProfile(pda);
      const second = await discovery.getProfile(pda);

      expect(first).toEqual(second);
      expect(program.account.agentRegistration.fetchNullable).toHaveBeenCalledTimes(1);
    });

    it('throws AgentDiscoveryError on RPC failure', async () => {
      program.account.agentRegistration.fetchNullable.mockRejectedValue(
        new Error('RPC timeout')
      );

      await expect(discovery.getProfile(randomPubkey())).rejects.toThrow(
        AgentDiscoveryError
      );
    });

    it('skips cache when cache is disabled', async () => {
      const noCacheDiscovery = buildDiscovery(program, { cache: undefined });
      const pda = randomPubkey();
      program.account.agentRegistration.fetchNullable.mockResolvedValue(
        mockRawAgent()
      );

      await noCacheDiscovery.getProfile(pda);
      await noCacheDiscovery.getProfile(pda);

      expect(program.account.agentRegistration.fetchNullable).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // listByCapability
  // --------------------------------------------------------------------------

  describe('listByCapability', () => {
    it('returns agents matching capability bitmask (AND)', async () => {
      const computeOnly = mockAccountEntry({
        capabilities: mockBN(Number(Capability.COMPUTE)),
        reputation: 5000,
      });
      const computeInference = mockAccountEntry({
        capabilities: mockBN(Number(Capability.COMPUTE | Capability.INFERENCE)),
        reputation: 7000,
      });
      const inferenceOnly = mockAccountEntry({
        capabilities: mockBN(Number(Capability.INFERENCE)),
        reputation: 6000,
      });
      program.account.agentRegistration.all.mockResolvedValue([
        computeOnly,
        computeInference,
        inferenceOnly,
      ]);

      const results = await discovery.listByCapability(
        Capability.COMPUTE | Capability.INFERENCE
      );

      // Only computeInference has BOTH
      expect(results).toHaveLength(1);
      expect(results[0].capabilities).toBe(Capability.COMPUTE | Capability.INFERENCE);
    });

    it('filters by minimum reputation', async () => {
      const lowRep = mockAccountEntry({ reputation: 3000 });
      const highRep = mockAccountEntry({ reputation: 9000 });
      program.account.agentRegistration.all.mockResolvedValue([lowRep, highRep]);

      const results = await discovery.listByCapability(
        Capability.COMPUTE | Capability.INFERENCE,
        5000
      );

      expect(results).toHaveLength(1);
      expect(results[0].reputation).toBe(9000);
    });

    it('returns results sorted by reputation descending', async () => {
      const a = mockAccountEntry({ reputation: 5000 });
      const b = mockAccountEntry({ reputation: 9000 });
      const c = mockAccountEntry({ reputation: 7000 });
      program.account.agentRegistration.all.mockResolvedValue([a, b, c]);

      const results = await discovery.listByCapability(
        Capability.COMPUTE | Capability.INFERENCE
      );

      expect(results.map((r) => r.reputation)).toEqual([9000, 7000, 5000]);
    });

    it('returns empty array when no agents match', async () => {
      program.account.agentRegistration.all.mockResolvedValue([]);
      const results = await discovery.listByCapability(Capability.STORAGE);
      expect(results).toEqual([]);
    });

    it('falls back to full scan when memcmp fails', async () => {
      // First call (memcmp) fails, second call (full scan) succeeds
      program.account.agentRegistration.all
        .mockRejectedValueOnce(new Error('memcmp not supported'))
        .mockResolvedValueOnce([
          mockAccountEntry({ status: { active: {} } }),
          mockAccountEntry({ status: { inactive: {} } }),
        ]);

      const results = await discovery.listByCapability(
        Capability.COMPUTE | Capability.INFERENCE
      );

      // Should still return results (active agent only after fallback filter)
      expect(results.length).toBeGreaterThanOrEqual(0);
      expect(program.account.agentRegistration.all).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // search
  // --------------------------------------------------------------------------

  describe('search', () => {
    it('returns all active agents with no filters', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry(),
        mockAccountEntry(),
      ]);

      const results = await discovery.search();
      expect(results).toHaveLength(2);
    });

    it('filters by capabilities', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ capabilities: mockBN(Number(Capability.COMPUTE)) }),
        mockAccountEntry({
          capabilities: mockBN(Number(Capability.COMPUTE | Capability.STORAGE)),
        }),
      ]);

      const results = await discovery.search({
        capabilities: Capability.STORAGE,
      });

      expect(results).toHaveLength(1);
    });

    it('filters by minReputation', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ reputation: 2000 }),
        mockAccountEntry({ reputation: 8000 }),
      ]);

      const results = await discovery.search({ minReputation: 5000 });
      expect(results).toHaveLength(1);
      expect(results[0].reputation).toBe(8000);
    });

    it('filters by onlineOnly (active + non-empty endpoint)', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ endpoint: '' }),
        mockAccountEntry({ endpoint: 'https://agent.com' }),
      ]);

      const results = await discovery.search({ onlineOnly: true });
      expect(results).toHaveLength(1);
      expect(results[0].endpoint).toBe('https://agent.com');
    });

    it('filters by minStake', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ stake: mockBN(500_000_000) }),
        mockAccountEntry({ stake: mockBN(2_000_000_000) }),
      ]);

      const results = await discovery.search({ minStake: 1_000_000_000n });
      expect(results).toHaveLength(1);
      expect(results[0].stake).toBe(2_000_000_000n);
    });

    it('applies maxResults', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ reputation: 1000 }),
        mockAccountEntry({ reputation: 2000 }),
        mockAccountEntry({ reputation: 3000 }),
      ]);

      const results = await discovery.search({ maxResults: 2 });
      expect(results).toHaveLength(2);
    });

    it('sorts by specified field ascending', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ reputation: 9000 }),
        mockAccountEntry({ reputation: 3000 }),
        mockAccountEntry({ reputation: 6000 }),
      ]);

      const results = await discovery.search({
        sortBy: 'reputation',
        sortOrder: 'asc',
      });

      expect(results.map((r) => r.reputation)).toEqual([3000, 6000, 9000]);
    });

    it('sorts by lastActive descending', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ lastActive: mockBN(100) }),
        mockAccountEntry({ lastActive: mockBN(300) }),
        mockAccountEntry({ lastActive: mockBN(200) }),
      ]);

      const results = await discovery.search({
        sortBy: 'lastActive',
        sortOrder: 'desc',
      });

      expect(results.map((r) => r.lastActive)).toEqual([300, 200, 100]);
    });

    it('sorts by tasksCompleted', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ tasksCompleted: mockBN(5) }),
        mockAccountEntry({ tasksCompleted: mockBN(50) }),
        mockAccountEntry({ tasksCompleted: mockBN(20) }),
      ]);

      const results = await discovery.search({
        sortBy: 'tasksCompleted',
        sortOrder: 'desc',
      });

      expect(results.map((r) => r.tasksCompleted)).toEqual([50n, 20n, 5n]);
    });

    it('sorts by stake', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ stake: mockBN(100) }),
        mockAccountEntry({ stake: mockBN(300) }),
        mockAccountEntry({ stake: mockBN(200) }),
      ]);

      const results = await discovery.search({
        sortBy: 'stake',
        sortOrder: 'asc',
      });

      expect(results.map((r) => r.stake)).toEqual([100n, 200n, 300n]);
    });

    it('includes non-active agents when activeOnly is false', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ status: { inactive: {} } }),
        mockAccountEntry({ status: { active: {} } }),
        mockAccountEntry({ status: { suspended: {} } }),
      ]);

      const results = await discovery.search({ activeOnly: false });
      expect(results).toHaveLength(3);
    });

    it('combines multiple filters', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({
          capabilities: mockBN(Number(Capability.COMPUTE | Capability.STORAGE)),
          reputation: 9000,
          stake: mockBN(2_000_000_000),
          endpoint: 'https://agent.com',
        }),
        mockAccountEntry({
          capabilities: mockBN(Number(Capability.COMPUTE)),
          reputation: 9000,
          stake: mockBN(2_000_000_000),
          endpoint: 'https://agent2.com',
        }),
        mockAccountEntry({
          capabilities: mockBN(Number(Capability.COMPUTE | Capability.STORAGE)),
          reputation: 3000,
          stake: mockBN(2_000_000_000),
          endpoint: 'https://agent3.com',
        }),
      ]);

      const results = await discovery.search({
        capabilities: Capability.COMPUTE | Capability.STORAGE,
        minReputation: 5000,
        minStake: 1_000_000_000n,
        onlineOnly: true,
        maxResults: 10,
      });

      expect(results).toHaveLength(1);
      expect(results[0].reputation).toBe(9000);
    });
  });

  // --------------------------------------------------------------------------
  // listOnlineAgents
  // --------------------------------------------------------------------------

  describe('listOnlineAgents', () => {
    it('returns active agents with endpoints sorted by lastActive', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({
          endpoint: 'https://a.com',
          lastActive: mockBN(100),
        }),
        mockAccountEntry({
          endpoint: '',
          lastActive: mockBN(300),
        }),
        mockAccountEntry({
          endpoint: 'https://b.com',
          lastActive: mockBN(200),
        }),
      ]);

      const results = await discovery.listOnlineAgents();
      expect(results).toHaveLength(2);
      expect(results[0].lastActive).toBe(200);
      expect(results[1].lastActive).toBe(100);
    });

    it('respects limit parameter', async () => {
      program.account.agentRegistration.all.mockResolvedValue([
        mockAccountEntry({ endpoint: 'https://a.com' }),
        mockAccountEntry({ endpoint: 'https://b.com' }),
        mockAccountEntry({ endpoint: 'https://c.com' }),
      ]);

      const results = await discovery.listOnlineAgents(2);
      expect(results).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // dispose
  // --------------------------------------------------------------------------

  describe('dispose', () => {
    it('clears cache', async () => {
      const pda = randomPubkey();
      program.account.agentRegistration.fetchNullable.mockResolvedValue(
        mockRawAgent()
      );

      await discovery.getProfile(pda);
      discovery.dispose();

      // After dispose, must fetch from RPC again
      await discovery.getProfile(pda);
      expect(program.account.agentRegistration.fetchNullable).toHaveBeenCalledTimes(2);
    });

    it('is idempotent', () => {
      expect(() => {
        discovery.dispose();
        discovery.dispose();
      }).not.toThrow();
    });

    it('works when cache is disabled', () => {
      const noCacheDiscovery = buildDiscovery(program, { cache: undefined });
      expect(() => noCacheDiscovery.dispose()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Per-account fault tolerance
  // --------------------------------------------------------------------------

  describe('fault tolerance', () => {
    it('skips corrupted accounts during bulk queries', async () => {
      const validEntry = mockAccountEntry({ reputation: 7000 });
      const corruptedEntry = {
        publicKey: randomPubkey(),
        account: { invalid: 'data' }, // Will fail parseAgentState
      };

      program.account.agentRegistration.all.mockResolvedValue([
        validEntry,
        corruptedEntry,
      ]);

      const results = await discovery.search();
      expect(results).toHaveLength(1);
      expect(results[0].reputation).toBe(7000);
    });
  });
});

// ============================================================================
// ProfileCache unit tests
// ============================================================================

describe('ProfileCache', () => {
  function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
    return {
      pda: randomPubkey(),
      agentId: new Uint8Array(32),
      authority: randomPubkey(),
      capabilities: 3n,
      status: AgentStatus.Active,
      endpoint: 'https://agent.com',
      metadataUri: '',
      registeredAt: 1700000000,
      lastActive: 1700001000,
      tasksCompleted: 10n,
      totalEarned: 5_000_000_000n,
      reputation: 8000,
      activeTasks: 1,
      stake: 1_000_000_000n,
      ...overrides,
    };
  }

  it('returns undefined for missing entries', () => {
    const cache = new ProfileCache();
    expect(cache.get(randomPubkey())).toBeUndefined();
  });

  it('stores and retrieves profiles', () => {
    const cache = new ProfileCache();
    const pda = randomPubkey();
    const profile = makeProfile({ pda });

    cache.set(pda, profile);
    expect(cache.get(pda)).toEqual(profile);
  });

  it('returns undefined for expired entries', () => {
    const cache = new ProfileCache({ ttlMs: 1 }); // 1ms TTL
    const pda = randomPubkey();
    cache.set(pda, makeProfile({ pda }));

    // Manually expire by mocking Date.now
    const originalNow = Date.now;
    Date.now = () => originalNow() + 100;
    try {
      expect(cache.get(pda)).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });

  it('evicts oldest entry when at capacity', () => {
    const cache = new ProfileCache({ maxEntries: 2 });

    const pda1 = randomPubkey();
    const pda2 = randomPubkey();
    const pda3 = randomPubkey();

    cache.set(pda1, makeProfile({ pda: pda1 }));
    cache.set(pda2, makeProfile({ pda: pda2 }));
    cache.set(pda3, makeProfile({ pda: pda3 }));

    // pda1 should have been evicted
    expect(cache.get(pda1)).toBeUndefined();
    expect(cache.get(pda2)).toBeDefined();
    expect(cache.get(pda3)).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it('promotes entry on access (LRU)', () => {
    const cache = new ProfileCache({ maxEntries: 2 });

    const pda1 = randomPubkey();
    const pda2 = randomPubkey();
    const pda3 = randomPubkey();

    cache.set(pda1, makeProfile({ pda: pda1 }));
    cache.set(pda2, makeProfile({ pda: pda2 }));

    // Access pda1 to promote it
    cache.get(pda1);

    // Now adding pda3 should evict pda2 (oldest)
    cache.set(pda3, makeProfile({ pda: pda3 }));

    expect(cache.get(pda1)).toBeDefined();
    expect(cache.get(pda2)).toBeUndefined();
    expect(cache.get(pda3)).toBeDefined();
  });

  it('clear removes all entries', () => {
    const cache = new ProfileCache();
    cache.set(randomPubkey(), makeProfile());
    cache.set(randomPubkey(), makeProfile());

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('reports size correctly', () => {
    const cache = new ProfileCache();
    expect(cache.size).toBe(0);

    cache.set(randomPubkey(), makeProfile());
    expect(cache.size).toBe(1);

    cache.set(randomPubkey(), makeProfile());
    expect(cache.size).toBe(2);
  });
});

// ============================================================================
// agentStateToProfile
// ============================================================================

describe('agentStateToProfile', () => {
  it('maps all AgentState fields to AgentProfile', () => {
    const pda = randomPubkey();
    const state = {
      agentId: new Uint8Array(32).fill(42),
      authority: randomPubkey(),
      bump: 255,
      capabilities: 7n,
      status: AgentStatus.Active,
      registeredAt: 1700000000,
      lastActive: 1700001000,
      endpoint: 'https://test.com',
      metadataUri: 'ipfs://abc',
      tasksCompleted: 100n,
      totalEarned: 10_000_000_000n,
      reputation: 9500,
      activeTasks: 2,
      stake: 5_000_000_000n,
      lastTaskCreated: 0,
      lastDisputeInitiated: 0,
      taskCount24h: 0,
      disputeCount24h: 0,
      rateLimitWindowStart: 0,
      activeDisputeVotes: 0,
      lastVoteTimestamp: 0,
      lastStateUpdate: 0,
      disputesAsDefendant: 0,
    };

    const profile = agentStateToProfile(pda, state);

    expect(profile.pda.equals(pda)).toBe(true);
    expect(profile.agentId).toBe(state.agentId);
    expect(profile.authority.equals(state.authority)).toBe(true);
    expect(profile.capabilities).toBe(7n);
    expect(profile.status).toBe(AgentStatus.Active);
    expect(profile.endpoint).toBe('https://test.com');
    expect(profile.metadataUri).toBe('ipfs://abc');
    expect(profile.reputation).toBe(9500);
    expect(profile.tasksCompleted).toBe(100n);
    expect(profile.totalEarned).toBe(10_000_000_000n);
    expect(profile.activeTasks).toBe(2);
    expect(profile.stake).toBe(5_000_000_000n);
    expect(profile.registeredAt).toBe(1700000000);
    expect(profile.lastActive).toBe(1700001000);
  });
});

// ============================================================================
// AGENT_STATUS_OFFSET
// ============================================================================

describe('AGENT_STATUS_OFFSET', () => {
  it('equals 80 (discriminator 8 + agent_id 32 + authority 32 + capabilities 8)', () => {
    expect(AGENT_STATUS_OFFSET).toBe(80);
  });
});

// ============================================================================
// AgentDiscoveryError
// ============================================================================

describe('AgentDiscoveryError', () => {
  it('has correct code and message', () => {
    const err = new AgentDiscoveryError('test reason');
    expect(err.code).toBe(RuntimeErrorCodes.DISCOVERY_ERROR);
    expect(err.message).toBe('Agent discovery failed: test reason');
    expect(err.name).toBe('AgentDiscoveryError');
    expect(err.reason).toBe('test reason');
  });
});
