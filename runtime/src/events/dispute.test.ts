import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination';
import {
  subscribeToDisputeInitiated,
  subscribeToDisputeVoteCast,
  subscribeToDisputeResolved,
  subscribeToDisputeExpired,
  subscribeToAllDisputeEvents,
} from './dispute';

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

function createRawDisputeInitiated(disputeId?: Uint8Array) {
  return {
    disputeId: Array.from(disputeId ?? createId(1)),
    taskId: Array.from(createId(2)),
    initiator: TEST_PUBKEY,
    resolutionType: 0,
    votingDeadline: mockBN(9999999),
    timestamp: mockBN(1234567890),
  };
}

function createRawDisputeVoteCast(disputeId?: Uint8Array) {
  return {
    disputeId: Array.from(disputeId ?? createId(1)),
    voter: TEST_PUBKEY,
    approved: true,
    votesFor: mockBN(3n),
    votesAgainst: mockBN(1n),
    timestamp: mockBN(1234567890),
  };
}

function createRawDisputeResolved(disputeId?: Uint8Array) {
  return {
    disputeId: Array.from(disputeId ?? createId(1)),
    resolutionType: 1,
    votesFor: mockBN(5n),
    votesAgainst: mockBN(2n),
    timestamp: mockBN(1234567890),
  };
}

function createRawDisputeExpired(disputeId?: Uint8Array) {
  return {
    disputeId: Array.from(disputeId ?? createId(1)),
    taskId: Array.from(createId(2)),
    refundAmount: mockBN(1_000_000_000n),
    timestamp: mockBN(1234567890),
  };
}

describe('Dispute Event Subscriptions', () => {
  let mockProgram: ReturnType<typeof createMockProgram>;

  beforeEach(() => {
    mockProgram = createMockProgram();
  });

  describe('subscribeToDisputeInitiated', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToDisputeInitiated(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'disputeInitiated',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToDisputeInitiated(mockProgram, callback);

      mockProgram._emit('disputeInitiated', createRawDisputeInitiated(), 100, 'sig1');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.disputeId).toBeInstanceOf(Uint8Array);
      expect(event.taskId).toBeInstanceOf(Uint8Array);
      expect(event.initiator).toBe(TEST_PUBKEY);
      expect(event.resolutionType).toBe(0);
      expect(event.votingDeadline).toBe(9999999);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(100);
      expect(sig).toBe('sig1');
    });

    it('filters by disputeId when provided', () => {
      const callback = vi.fn();
      const filterDisputeId = createId(42);
      subscribeToDisputeInitiated(mockProgram, callback, { disputeId: filterDisputeId });

      mockProgram._emit('disputeInitiated', createRawDisputeInitiated(filterDisputeId), 1, 'sig1');
      mockProgram._emit('disputeInitiated', createRawDisputeInitiated(createId(99)), 2, 'sig2');

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('passes all events when no filter', () => {
      const callback = vi.fn();
      subscribeToDisputeInitiated(mockProgram, callback);

      mockProgram._emit('disputeInitiated', createRawDisputeInitiated(createId(1)), 1, 'sig1');
      mockProgram._emit('disputeInitiated', createRawDisputeInitiated(createId(2)), 2, 'sig2');

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('unsubscribe removes listener', async () => {
      const callback = vi.fn();
      const subscription = subscribeToDisputeInitiated(mockProgram, callback);

      await subscription.unsubscribe();

      expect(mockProgram.removeEventListener).toHaveBeenCalledWith(1);
    });
  });

  describe('subscribeToDisputeVoteCast', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToDisputeVoteCast(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'disputeVoteCast',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToDisputeVoteCast(mockProgram, callback);

      mockProgram._emit('disputeVoteCast', createRawDisputeVoteCast(), 200, 'sig2');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.disputeId).toBeInstanceOf(Uint8Array);
      expect(event.voter).toBe(TEST_PUBKEY);
      expect(event.approved).toBe(true);
      expect(event.votesFor).toBe(3n);
      expect(event.votesAgainst).toBe(1n);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(200);
      expect(sig).toBe('sig2');
    });

    it('filters by disputeId when provided', () => {
      const callback = vi.fn();
      const filterDisputeId = createId(42);
      subscribeToDisputeVoteCast(mockProgram, callback, { disputeId: filterDisputeId });

      mockProgram._emit('disputeVoteCast', createRawDisputeVoteCast(filterDisputeId), 1, 'sig1');
      mockProgram._emit('disputeVoteCast', createRawDisputeVoteCast(createId(99)), 2, 'sig2');

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribeToDisputeResolved', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToDisputeResolved(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'disputeResolved',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToDisputeResolved(mockProgram, callback);

      mockProgram._emit('disputeResolved', createRawDisputeResolved(), 300, 'sig3');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.disputeId).toBeInstanceOf(Uint8Array);
      expect(event.resolutionType).toBe(1);
      expect(event.votesFor).toBe(5n);
      expect(event.votesAgainst).toBe(2n);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(300);
      expect(sig).toBe('sig3');
    });

    it('filters by disputeId when provided', () => {
      const callback = vi.fn();
      const filterDisputeId = createId(42);
      subscribeToDisputeResolved(mockProgram, callback, { disputeId: filterDisputeId });

      mockProgram._emit('disputeResolved', createRawDisputeResolved(filterDisputeId), 1, 'sig1');
      mockProgram._emit('disputeResolved', createRawDisputeResolved(createId(99)), 2, 'sig2');

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribeToDisputeExpired', () => {
    it('registers with correct camelCase event name', () => {
      const callback = vi.fn();
      subscribeToDisputeExpired(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'disputeExpired',
        expect.any(Function)
      );
    });

    it('parses raw events and forwards to callback', () => {
      const callback = vi.fn();
      subscribeToDisputeExpired(mockProgram, callback);

      mockProgram._emit('disputeExpired', createRawDisputeExpired(), 400, 'sig4');

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.disputeId).toBeInstanceOf(Uint8Array);
      expect(event.taskId).toBeInstanceOf(Uint8Array);
      expect(event.refundAmount).toBe(1_000_000_000n);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(400);
      expect(sig).toBe('sig4');
    });

    it('filters by disputeId when provided', () => {
      const callback = vi.fn();
      const filterDisputeId = createId(42);
      subscribeToDisputeExpired(mockProgram, callback, { disputeId: filterDisputeId });

      mockProgram._emit('disputeExpired', createRawDisputeExpired(filterDisputeId), 1, 'sig1');
      mockProgram._emit('disputeExpired', createRawDisputeExpired(createId(99)), 2, 'sig2');

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribeToAllDisputeEvents', () => {
    it('routes events to correct callbacks', () => {
      const callbacks = {
        onDisputeInitiated: vi.fn(),
        onDisputeVoteCast: vi.fn(),
        onDisputeResolved: vi.fn(),
        onDisputeExpired: vi.fn(),
      };

      subscribeToAllDisputeEvents(mockProgram, callbacks);

      expect(mockProgram.addEventListener).toHaveBeenCalledTimes(4);

      mockProgram._emit('disputeInitiated', createRawDisputeInitiated(), 1, 'sig1');
      mockProgram._emit('disputeVoteCast', createRawDisputeVoteCast(), 2, 'sig2');
      mockProgram._emit('disputeResolved', createRawDisputeResolved(), 3, 'sig3');
      mockProgram._emit('disputeExpired', createRawDisputeExpired(), 4, 'sig4');

      expect(callbacks.onDisputeInitiated).toHaveBeenCalledTimes(1);
      expect(callbacks.onDisputeVoteCast).toHaveBeenCalledTimes(1);
      expect(callbacks.onDisputeResolved).toHaveBeenCalledTimes(1);
      expect(callbacks.onDisputeExpired).toHaveBeenCalledTimes(1);
    });

    it('only subscribes to provided callbacks', () => {
      const callbacks = {
        onDisputeInitiated: vi.fn(),
      };

      subscribeToAllDisputeEvents(mockProgram, callbacks);

      expect(mockProgram.addEventListener).toHaveBeenCalledTimes(1);
      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        'disputeInitiated',
        expect.any(Function)
      );
    });

    it('unsubscribe removes all listeners', async () => {
      const callbacks = {
        onDisputeInitiated: vi.fn(),
        onDisputeVoteCast: vi.fn(),
        onDisputeResolved: vi.fn(),
        onDisputeExpired: vi.fn(),
      };

      const subscription = subscribeToAllDisputeEvents(mockProgram, callbacks);
      await subscription.unsubscribe();

      expect(mockProgram.removeEventListener).toHaveBeenCalledTimes(4);
    });

    it('applies disputeId filter to all subscriptions', () => {
      const callbacks = {
        onDisputeInitiated: vi.fn(),
        onDisputeVoteCast: vi.fn(),
      };

      const filterDisputeId = createId(50);
      subscribeToAllDisputeEvents(mockProgram, callbacks, { disputeId: filterDisputeId });

      // Matching
      mockProgram._emit('disputeInitiated', createRawDisputeInitiated(filterDisputeId), 1, 'sig1');
      // Non-matching
      mockProgram._emit('disputeVoteCast', createRawDisputeVoteCast(createId(99)), 2, 'sig2');

      expect(callbacks.onDisputeInitiated).toHaveBeenCalledTimes(1);
      expect(callbacks.onDisputeVoteCast).not.toHaveBeenCalled();
    });

    it('empty callbacks object creates no subscriptions', () => {
      const subscription = subscribeToAllDisputeEvents(mockProgram, {});

      expect(mockProgram.addEventListener).not.toHaveBeenCalled();
      expect(subscription.unsubscribe).toBeDefined();
    });
  });
});
