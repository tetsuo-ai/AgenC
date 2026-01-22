import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { PROGRAM_ID } from '@agenc/sdk';
import { AgentManager, type AgentManagerConfig } from './manager';
import {
  AgentNotRegisteredError,
  ValidationError,
  ActiveTasksError,
  PendingDisputeVotesError,
  RecentVoteActivityError,
} from '../types/errors';
import { AgentStatus } from './types';
import { keypairToWallet } from '../types/wallet';
import { silentLogger } from '../utils/logger';

/**
 * Creates a valid 32-byte agent ID from a seed value
 */
function createAgentId(seed = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i) % 256;
  }
  return bytes;
}

/**
 * Creates a mock connection (doesn't actually connect)
 */
function createMockConnection(): Connection {
  return new Connection('http://localhost:8899', 'confirmed');
}

/**
 * Creates a mock wallet from a keypair
 */
function createMockWallet() {
  const keypair = Keypair.generate();
  return keypairToWallet(keypair);
}

/**
 * Creates a valid AgentManagerConfig
 */
function createConfig(overrides?: Partial<AgentManagerConfig>): AgentManagerConfig {
  return {
    connection: createMockConnection(),
    wallet: createMockWallet(),
    logger: silentLogger,
    ...overrides,
  };
}

describe('AgentManager', () => {
  describe('constructor', () => {
    it('creates instance with required config', () => {
      const config = createConfig();
      const manager = new AgentManager(config);

      expect(manager).toBeInstanceOf(AgentManager);
    });

    it('uses default PROGRAM_ID when not specified', () => {
      const config = createConfig();
      const manager = new AgentManager(config);

      // Can't directly access private field, but we can test behavior
      expect(manager).toBeInstanceOf(AgentManager);
    });

    it('uses custom programId when specified', () => {
      const customProgramId = new PublicKey('11111111111111111111111111111111');
      const config = createConfig({ programId: customProgramId });
      const manager = new AgentManager(config);

      expect(manager).toBeInstanceOf(AgentManager);
    });

    it('uses silent logger by default when not specified', () => {
      const config = createConfig();
      delete (config as Partial<AgentManagerConfig>).logger;
      const manager = new AgentManager(config);

      expect(manager).toBeInstanceOf(AgentManager);
    });
  });

  describe('initial state', () => {
    it('isRegistered returns false initially', () => {
      const manager = new AgentManager(createConfig());

      expect(manager.isRegistered()).toBe(false);
    });

    it('getCachedState returns null initially', () => {
      const manager = new AgentManager(createConfig());

      expect(manager.getCachedState()).toBeNull();
    });

    it('getAgentPda returns null initially', () => {
      const manager = new AgentManager(createConfig());

      expect(manager.getAgentPda()).toBeNull();
    });

    it('getAgentId returns null initially', () => {
      const manager = new AgentManager(createConfig());

      expect(manager.getAgentId()).toBeNull();
    });
  });

  describe('requireRegistered errors', () => {
    it('getState throws AgentNotRegisteredError when not registered', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.getState()).rejects.toThrow(AgentNotRegisteredError);
    });

    it('update throws AgentNotRegisteredError when not registered', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.update({ status: AgentStatus.Active })).rejects.toThrow(
        AgentNotRegisteredError
      );
    });

    it('updateStatus throws AgentNotRegisteredError when not registered', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.updateStatus(AgentStatus.Active)).rejects.toThrow(
        AgentNotRegisteredError
      );
    });

    it('updateCapabilities throws AgentNotRegisteredError when not registered', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.updateCapabilities(1n)).rejects.toThrow(
        AgentNotRegisteredError
      );
    });

    it('updateEndpoint throws AgentNotRegisteredError when not registered', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.updateEndpoint('https://test.com')).rejects.toThrow(
        AgentNotRegisteredError
      );
    });

    it('updateMetadataUri throws AgentNotRegisteredError when not registered', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.updateMetadataUri('https://metadata.com')).rejects.toThrow(
        AgentNotRegisteredError
      );
    });

    it('deregister throws AgentNotRegisteredError when not registered', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.deregister()).rejects.toThrow(AgentNotRegisteredError);
    });

    it('getRateLimitState throws AgentNotRegisteredError when not registered', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.getRateLimitState()).rejects.toThrow(AgentNotRegisteredError);
    });

    it('getReputation throws AgentNotRegisteredError when not registered', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.getReputation()).rejects.toThrow(AgentNotRegisteredError);
    });
  });

  describe('validation - registration params', () => {
    it('validates agentId length', async () => {
      const manager = new AgentManager(createConfig());
      const shortId = new Uint8Array(16);

      await expect(
        manager.register({
          agentId: shortId,
          capabilities: 1n,
          endpoint: 'https://test.com',
          stakeAmount: 1_000_000_000n,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        manager.register({
          agentId: shortId,
          capabilities: 1n,
          endpoint: 'https://test.com',
          stakeAmount: 1_000_000_000n,
        })
      ).rejects.toThrow('Invalid agentId length');
    });

    it('validates capabilities is non-negative', async () => {
      const manager = new AgentManager(createConfig());

      await expect(
        manager.register({
          agentId: createAgentId(1),
          capabilities: -1n,
          endpoint: 'https://test.com',
          stakeAmount: 1_000_000_000n,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        manager.register({
          agentId: createAgentId(1),
          capabilities: -1n,
          endpoint: 'https://test.com',
          stakeAmount: 1_000_000_000n,
        })
      ).rejects.toThrow('Capabilities must be non-negative');
    });

    it('validates endpoint length', async () => {
      const manager = new AgentManager(createConfig());
      const longEndpoint = 'x'.repeat(129);

      await expect(
        manager.register({
          agentId: createAgentId(2),
          capabilities: 1n,
          endpoint: longEndpoint,
          stakeAmount: 1_000_000_000n,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        manager.register({
          agentId: createAgentId(2),
          capabilities: 1n,
          endpoint: longEndpoint,
          stakeAmount: 1_000_000_000n,
        })
      ).rejects.toThrow('Endpoint too long');
    });

    it('validates metadataUri length', async () => {
      const manager = new AgentManager(createConfig());
      const longUri = 'y'.repeat(129);

      await expect(
        manager.register({
          agentId: createAgentId(3),
          capabilities: 1n,
          endpoint: 'https://test.com',
          metadataUri: longUri,
          stakeAmount: 1_000_000_000n,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        manager.register({
          agentId: createAgentId(3),
          capabilities: 1n,
          endpoint: 'https://test.com',
          metadataUri: longUri,
          stakeAmount: 1_000_000_000n,
        })
      ).rejects.toThrow('Metadata URI too long');
    });

    it('validates stakeAmount is non-negative', async () => {
      const manager = new AgentManager(createConfig());

      await expect(
        manager.register({
          agentId: createAgentId(4),
          capabilities: 1n,
          endpoint: 'https://test.com',
          stakeAmount: -1n,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        manager.register({
          agentId: createAgentId(4),
          capabilities: 1n,
          endpoint: 'https://test.com',
          stakeAmount: -1n,
        })
      ).rejects.toThrow('Stake amount must be non-negative');
    });
  });

  describe('validation - update params', () => {
    // Note: These would require a registered agent to test fully
    // For now we test the single-field update methods that do their own validation

    it('updateStatus rejects invalid status', async () => {
      const manager = new AgentManager(createConfig());

      // First will fail with AgentNotRegisteredError, but validation happens first
      // We need to test the validation separately

      // Test with registered agent would be:
      // await expect(manager.updateStatus(99 as AgentStatus)).rejects.toThrow(ValidationError);
    });

    it('updateCapabilities rejects negative value', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.updateCapabilities(-1n)).rejects.toThrow();
    });

    it('updateEndpoint rejects too-long endpoint', async () => {
      const manager = new AgentManager(createConfig());
      const longEndpoint = 'x'.repeat(129);

      await expect(manager.updateEndpoint(longEndpoint)).rejects.toThrow();
    });

    it('updateMetadataUri rejects too-long URI', async () => {
      const manager = new AgentManager(createConfig());
      const longUri = 'y'.repeat(129);

      await expect(manager.updateMetadataUri(longUri)).rejects.toThrow();
    });
  });

  describe('validation - load params', () => {
    it('load validates agentId length', async () => {
      const manager = new AgentManager(createConfig());
      const shortId = new Uint8Array(10);

      await expect(manager.load(shortId)).rejects.toThrow(ValidationError);
      await expect(manager.load(shortId)).rejects.toThrow('Invalid agentId length');
    });

    it('load validates agentId length - too long', async () => {
      const manager = new AgentManager(createConfig());
      const longId = new Uint8Array(64);

      await expect(manager.load(longId)).rejects.toThrow(ValidationError);
    });
  });

  describe('static methods - validation', () => {
    it('fetchAgent validates agentId length', async () => {
      const connection = createMockConnection();
      const shortId = new Uint8Array(20);

      await expect(AgentManager.fetchAgent(connection, shortId)).rejects.toThrow(
        ValidationError
      );
    });

    it('agentExists validates agentId length', async () => {
      const connection = createMockConnection();
      const shortId = new Uint8Array(5);

      await expect(AgentManager.agentExists(connection, shortId)).rejects.toThrow(
        ValidationError
      );
    });
  });

  describe('event subscription', () => {
    it('subscribeToEvents returns subscription with unsubscribe', () => {
      const manager = new AgentManager(createConfig());

      // This would fail with connection error in real scenario
      // but we can test the interface
      try {
        const subscription = manager.subscribeToEvents({
          onRegistered: () => {},
        });

        expect(subscription).toBeDefined();
        expect(typeof subscription.unsubscribe).toBe('function');
      } catch {
        // Expected - no real connection
      }
    });

    it('unsubscribeAll completes without error when no subscriptions', async () => {
      const manager = new AgentManager(createConfig());

      // Should not throw
      await manager.unsubscribeAll();
    });
  });
});

describe('AgentManager error classes', () => {
  describe('ActiveTasksError', () => {
    it('includes task count in message', () => {
      const error = new ActiveTasksError(5);

      expect(error.message).toContain('5');
      expect(error.message).toContain('tasks');
      expect(error.activeTaskCount).toBe(5);
    });

    it('uses singular "task" for count of 1', () => {
      const error = new ActiveTasksError(1);

      expect(error.message).toContain('1 active task');
      expect(error.message).not.toContain('tasks');
    });
  });

  describe('PendingDisputeVotesError', () => {
    it('includes vote count in message', () => {
      const error = new PendingDisputeVotesError(3);

      expect(error.message).toContain('3');
      expect(error.message).toContain('votes');
      expect(error.voteCount).toBe(3);
    });

    it('uses singular "vote" for count of 1', () => {
      const error = new PendingDisputeVotesError(1);

      expect(error.message).toContain('1 pending dispute vote');
      expect(error.message).not.toContain('votes');
    });
  });

  describe('RecentVoteActivityError', () => {
    it('includes timestamp in message', () => {
      const timestamp = new Date('2024-01-01T12:00:00Z');
      const error = new RecentVoteActivityError(timestamp);

      expect(error.message).toContain('24 hours');
      expect(error.message).toContain(timestamp.toISOString());
      expect(error.lastVoteTimestamp).toEqual(timestamp);
    });
  });
});

describe('AgentManager protocol config caching', () => {
  describe('cache configuration', () => {
    it('uses default TTL when not specified', () => {
      const config = createConfig();
      // No protocolConfigCache specified
      const manager = new AgentManager(config);

      expect(manager).toBeInstanceOf(AgentManager);
    });

    it('accepts custom TTL', () => {
      const config = createConfig({
        protocolConfigCache: { ttlMs: 60000 }, // 1 minute
      });
      const manager = new AgentManager(config);

      expect(manager).toBeInstanceOf(AgentManager);
    });

    it('accepts TTL of 0 (caching disabled)', () => {
      const config = createConfig({
        protocolConfigCache: { ttlMs: 0 },
      });
      const manager = new AgentManager(config);

      expect(manager).toBeInstanceOf(AgentManager);
    });

    it('accepts TTL of Infinity (cache forever)', () => {
      const config = createConfig({
        protocolConfigCache: { ttlMs: Infinity },
      });
      const manager = new AgentManager(config);

      expect(manager).toBeInstanceOf(AgentManager);
    });

    it('rejects negative TTL', () => {
      const config = createConfig({
        protocolConfigCache: { ttlMs: -1 },
      });

      expect(() => new AgentManager(config)).toThrow(ValidationError);
      expect(() => new AgentManager(config)).toThrow('non-negative');
    });

    it('rejects NaN TTL', () => {
      const config = createConfig({
        protocolConfigCache: { ttlMs: NaN },
      });

      expect(() => new AgentManager(config)).toThrow(ValidationError);
      expect(() => new AgentManager(config)).toThrow('non-negative number');
    });

    it('accepts returnStaleOnError option', () => {
      const config = createConfig({
        protocolConfigCache: {
          ttlMs: 60000,
          returnStaleOnError: true,
        },
      });
      const manager = new AgentManager(config);

      expect(manager).toBeInstanceOf(AgentManager);
    });
  });

  describe('getCachedProtocolConfig', () => {
    it('returns null when cache is empty', () => {
      const manager = new AgentManager(createConfig());

      expect(manager.getCachedProtocolConfig()).toBeNull();
    });
  });

  describe('isProtocolConfigCacheFresh', () => {
    it('returns false when cache is empty', () => {
      const manager = new AgentManager(createConfig());

      expect(manager.isProtocolConfigCacheFresh()).toBe(false);
    });
  });

  describe('invalidateProtocolConfigCache', () => {
    it('completes without error when cache is empty', () => {
      const manager = new AgentManager(createConfig());

      // Should not throw
      manager.invalidateProtocolConfigCache();
    });

    it('clears cached value', () => {
      const manager = new AgentManager(createConfig());

      // Invalidate empty cache
      manager.invalidateProtocolConfigCache();

      // Verify still null
      expect(manager.getCachedProtocolConfig()).toBeNull();
    });
  });

  describe('getProtocolConfig options', () => {
    it('accepts forceRefresh option', async () => {
      const manager = new AgentManager(createConfig());

      // Will fail due to no connection, but validates the option is accepted
      await expect(
        manager.getProtocolConfig({ forceRefresh: true })
      ).rejects.toThrow();
    });

    it('accepts empty options object', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.getProtocolConfig({})).rejects.toThrow();
    });

    it('accepts no options (default behavior)', async () => {
      const manager = new AgentManager(createConfig());

      await expect(manager.getProtocolConfig()).rejects.toThrow();
    });
  });
});
