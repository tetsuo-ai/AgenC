import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination';
import {
  subscribeToStateUpdated,
  subscribeToProtocolInitialized,
  subscribeToRewardDistributed,
  subscribeToRateLimitHit,
  subscribeToMigrationCompleted,
  subscribeToProtocolVersionUpdated,
  subscribeToAllProtocolEvents,
} from './protocol';

function mockBN(value: bigint | number): { toNumber: () => number; toString: () => string } {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

const TEST_PUBKEY = new PublicKey('11111111111111111111111111111111');

function createId(seed = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i) % 256;
  }
  return bytes;
}

function createMockProgram() {
  const eventCallbacks = new Map<number, { eventName: string; callback: Function }>();
  let nextListenerId = 1;

  const mockProgram = {
    addEventListener: vi.fn((eventName: string, callback: Function) => {
      const id = nextListenerId++;
      eventCallbacks.set(id, { eventName, callback });
      return id;
    }),
    removeEventListener: vi.fn(async (id: number) => {
      eventCallbacks.delete(id);
    }),
    _emit: (eventName: string, rawEvent: unknown, slot: number, signature: string) => {
      for (const { eventName: name, callback } of eventCallbacks.values()) {
        if (name === eventName) callback(rawEvent, slot, signature);
      }
    },
    _getCallbackCount: () => eventCallbacks.size,
  };

  return mockProgram as unknown as Program<AgencCoordination> & {
    _emit: typeof mockProgram._emit;
    _getCallbackCount: typeof mockProgram._getCallbackCount;
  };
}

function createRawStateUpdated() {
  return {
    stateKey: Array.from(createId(10)),
    updater: TEST_PUBKEY,
    version: mockBN(5n),
    timestamp: mockBN(1234567890),
  };
}

function createRawProtocolInitialized() {
  return {
    authority: TEST_PUBKEY,
    treasury: TEST_PUBKEY,
    disputeThreshold: 51,
    protocolFeeBps: 250,
    timestamp: mockBN(1234567890),
  };
}

function createRawRewardDistributed(taskId?: Uint8Array) {
  return {
    taskId: Array.from(taskId ?? createId(1)),
    recipient: TEST_PUBKEY,
    amount: mockBN(500_000_000n),
    protocolFee: mockBN(12_500_000n),
    timestamp: mockBN(1234567890),
  };
}

function createRawRateLimitHit(agentId?: Uint8Array) {
  return {
    agentId: Array.from(agentId ?? createId(1)),
    actionType: 0,
    limitType: 1,
    currentCount: 5,
    maxCount: 10,
    cooldownRemaining: mockBN(3600),
    timestamp: mockBN(1234567890),
  };
}

function createRawMigrationCompleted() {
  return {
    fromVersion: 1,
    toVersion: 2,
    authority: TEST_PUBKEY,
    timestamp: mockBN(1234567890),
  };
}

function createRawProtocolVersionUpdated() {
  return {
    oldVersion: 1,
    newVersion: 2,
    minSupportedVersion: 1,
    timestamp: mockBN(1234567890),
  };
}

describe('Protocol Event Subscriptions', () => {
  let mockProgram: ReturnType<typeof createMockProgram>;

  beforeEach(() => {
    mockProgram = createMockProgram();
  });

  describe('subscribeToStateUpdated', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToStateUpdated(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'stateUpdated',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToStateUpdated(mockProgram, callback);

      mockProgram._emit('stateUpdated', createRawStateUpdated(), 100, 'sig1');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.stateKey).toBeInstanceOf(Uint8Array);
      expect(event.updater).toBe(TEST_PUBKEY);
      expect(event.version).toBe(5n);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(100);
      expect(sig).toBe('sig1');
    });

    it('unsubscribe removes listener', async () => {
      const callback = vi.fn();
      const subscription = subscribeToStateUpdated(mockProgram, callback);

      await subscription.unsubscribe();

      expect(mockProgram.removeEventListener).toHaveBeenCalledWith(1);
    });
  });

  describe('subscribeToProtocolInitialized', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToProtocolInitialized(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'protocolInitialized',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToProtocolInitialized(mockProgram, callback);

      mockProgram._emit('protocolInitialized', createRawProtocolInitialized(), 200, 'sig2');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.authority).toBe(TEST_PUBKEY);
      expect(event.treasury).toBe(TEST_PUBKEY);
      expect(event.disputeThreshold).toBe(51);
      expect(event.protocolFeeBps).toBe(250);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(200);
      expect(sig).toBe('sig2');
    });
  });

  describe('subscribeToRewardDistributed', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToRewardDistributed(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'rewardDistributed',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToRewardDistributed(mockProgram, callback);

      mockProgram._emit('rewardDistributed', createRawRewardDistributed(), 300, 'sig3');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.taskId).toBeInstanceOf(Uint8Array);
      expect(event.recipient).toBe(TEST_PUBKEY);
      expect(event.amount).toBe(500_000_000n);
      expect(event.protocolFee).toBe(12_500_000n);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(300);
      expect(sig).toBe('sig3');
    });

    it('filters by taskId when provided', () => {
      const callback = vi.fn();
      const filterTaskId = createId(42);
      subscribeToRewardDistributed(mockProgram, callback, { taskId: filterTaskId });

      mockProgram._emit('rewardDistributed', createRawRewardDistributed(filterTaskId), 1, 'sig1');
      mockProgram._emit('rewardDistributed', createRawRewardDistributed(createId(99)), 2, 'sig2');

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('passes all events when no filter', () => {
      const callback = vi.fn();
      subscribeToRewardDistributed(mockProgram, callback);

      mockProgram._emit('rewardDistributed', createRawRewardDistributed(createId(1)), 1, 'sig1');
      mockProgram._emit('rewardDistributed', createRawRewardDistributed(createId(2)), 2, 'sig2');

      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscribeToRateLimitHit', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToRateLimitHit(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'rateLimitHit',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToRateLimitHit(mockProgram, callback);

      mockProgram._emit('rateLimitHit', createRawRateLimitHit(), 400, 'sig4');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.agentId).toBeInstanceOf(Uint8Array);
      expect(event.actionType).toBe(0);
      expect(event.limitType).toBe(1);
      expect(event.currentCount).toBe(5);
      expect(event.maxCount).toBe(10);
      expect(event.cooldownRemaining).toBe(3600);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(400);
      expect(sig).toBe('sig4');
    });

    it('filters by agentId when provided', () => {
      const callback = vi.fn();
      const filterAgentId = createId(42);
      subscribeToRateLimitHit(mockProgram, callback, { agentId: filterAgentId });

      mockProgram._emit('rateLimitHit', createRawRateLimitHit(filterAgentId), 1, 'sig1');
      mockProgram._emit('rateLimitHit', createRawRateLimitHit(createId(99)), 2, 'sig2');

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('passes all events when no filter', () => {
      const callback = vi.fn();
      subscribeToRateLimitHit(mockProgram, callback);

      mockProgram._emit('rateLimitHit', createRawRateLimitHit(createId(1)), 1, 'sig1');
      mockProgram._emit('rateLimitHit', createRawRateLimitHit(createId(2)), 2, 'sig2');

      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscribeToMigrationCompleted', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToMigrationCompleted(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'migrationCompleted',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToMigrationCompleted(mockProgram, callback);

      mockProgram._emit('migrationCompleted', createRawMigrationCompleted(), 500, 'sig5');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.fromVersion).toBe(1);
      expect(event.toVersion).toBe(2);
      expect(event.authority).toBe(TEST_PUBKEY);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(500);
      expect(sig).toBe('sig5');
    });
  });

  describe('subscribeToProtocolVersionUpdated', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToProtocolVersionUpdated(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'protocolVersionUpdated',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToProtocolVersionUpdated(mockProgram, callback);

      mockProgram._emit('protocolVersionUpdated', createRawProtocolVersionUpdated(), 600, 'sig6');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.oldVersion).toBe(1);
      expect(event.newVersion).toBe(2);
      expect(event.minSupportedVersion).toBe(1);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(600);
      expect(sig).toBe('sig6');
    });
  });

  describe('subscribeToAllProtocolEvents', () => {
    it('routes events to correct callbacks', () => {
      const callbacks = {
        onStateUpdated: vi.fn(),
        onProtocolInitialized: vi.fn(),
        onRewardDistributed: vi.fn(),
        onRateLimitHit: vi.fn(),
        onMigrationCompleted: vi.fn(),
        onProtocolVersionUpdated: vi.fn(),
      };

      subscribeToAllProtocolEvents(mockProgram, callbacks);

      expect(mockProgram.addEventListener).toHaveBeenCalledTimes(6);

      mockProgram._emit('stateUpdated', createRawStateUpdated(), 1, 'sig1');
      mockProgram._emit('protocolInitialized', createRawProtocolInitialized(), 2, 'sig2');
      mockProgram._emit('rewardDistributed', createRawRewardDistributed(), 3, 'sig3');
      mockProgram._emit('rateLimitHit', createRawRateLimitHit(), 4, 'sig4');
      mockProgram._emit('migrationCompleted', createRawMigrationCompleted(), 5, 'sig5');
      mockProgram._emit('protocolVersionUpdated', createRawProtocolVersionUpdated(), 6, 'sig6');

      expect(callbacks.onStateUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onProtocolInitialized).toHaveBeenCalledTimes(1);
      expect(callbacks.onRewardDistributed).toHaveBeenCalledTimes(1);
      expect(callbacks.onRateLimitHit).toHaveBeenCalledTimes(1);
      expect(callbacks.onMigrationCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.onProtocolVersionUpdated).toHaveBeenCalledTimes(1);
    });

    it('only subscribes to provided callbacks', () => {
      const callbacks = {
        onRateLimitHit: vi.fn(),
        onRewardDistributed: vi.fn(),
      };

      subscribeToAllProtocolEvents(mockProgram, callbacks);

      expect(mockProgram.addEventListener).toHaveBeenCalledTimes(2);
    });

    it('unsubscribe removes all listeners', async () => {
      const callbacks = {
        onStateUpdated: vi.fn(),
        onProtocolInitialized: vi.fn(),
        onRewardDistributed: vi.fn(),
        onRateLimitHit: vi.fn(),
        onMigrationCompleted: vi.fn(),
        onProtocolVersionUpdated: vi.fn(),
      };

      const subscription = subscribeToAllProtocolEvents(mockProgram, callbacks);
      await subscription.unsubscribe();

      expect(mockProgram.removeEventListener).toHaveBeenCalledTimes(6);
    });

    it('applies filters to filterable events', () => {
      const callbacks = {
        onRewardDistributed: vi.fn(),
        onRateLimitHit: vi.fn(),
      };

      const filterTaskId = createId(42);
      const filterAgentId = createId(77);
      subscribeToAllProtocolEvents(mockProgram, callbacks, {
        taskId: filterTaskId,
        agentId: filterAgentId,
      });

      // Matching reward
      mockProgram._emit('rewardDistributed', createRawRewardDistributed(filterTaskId), 1, 'sig1');
      // Non-matching reward
      mockProgram._emit('rewardDistributed', createRawRewardDistributed(createId(99)), 2, 'sig2');
      // Matching rate limit
      mockProgram._emit('rateLimitHit', createRawRateLimitHit(filterAgentId), 3, 'sig3');
      // Non-matching rate limit
      mockProgram._emit('rateLimitHit', createRawRateLimitHit(createId(99)), 4, 'sig4');

      expect(callbacks.onRewardDistributed).toHaveBeenCalledTimes(1);
      expect(callbacks.onRateLimitHit).toHaveBeenCalledTimes(1);
    });

    it('empty callbacks object creates no subscriptions', () => {
      const subscription = subscribeToAllProtocolEvents(mockProgram, {});

      expect(mockProgram.addEventListener).not.toHaveBeenCalled();
      expect(subscription.unsubscribe).toBeDefined();
    });
  });
});
