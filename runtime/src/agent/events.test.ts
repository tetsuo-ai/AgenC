import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination";
import {
  subscribeToAgentRegistered,
  subscribeToAgentUpdated,
  subscribeToAgentDeregistered,
  subscribeToAgentSuspended,
  subscribeToAgentUnsuspended,
  subscribeToAllAgentEvents,
  type AgentEventCallback,
  type EventSubscription,
} from "./events";
import type {
  AgentRegisteredEvent,
  AgentUpdatedEvent,
  AgentDeregisteredEvent,
} from "./types";
import { AgentStatus } from "./types";

/**
 * Mock BN-like object for testing
 */
function mockBN(value: bigint | number): {
  toNumber: () => number;
  toString: () => string;
} {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

const TEST_PUBKEY = new PublicKey("11111111111111111111111111111111");

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
 * Creates a mock Anchor program with event listener support
 */
function createMockProgram() {
  const eventCallbacks = new Map<
    number,
    { eventName: string; callback: Function }
  >();
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
    // Helper to simulate emitting events (not part of real Program API)
    _emit: (
      eventName: string,
      rawEvent: unknown,
      slot: number,
      signature: string,
    ) => {
      for (const { eventName: name, callback } of eventCallbacks.values()) {
        if (name === eventName) {
          callback(rawEvent, slot, signature);
        }
      }
    },
    _getCallbackCount: () => eventCallbacks.size,
  };

  return mockProgram as unknown as Program<AgencCoordination> & {
    _emit: typeof mockProgram._emit;
    _getCallbackCount: typeof mockProgram._getCallbackCount;
  };
}

function createRawAgentSuspended(agentId?: Uint8Array) {
  return {
    agentId: Array.from(agentId ?? createAgentId(7)),
    authority: TEST_PUBKEY,
    timestamp: mockBN(1700001234),
  };
}

function createRawAgentUnsuspended(agentId?: Uint8Array) {
  return {
    agentId: Array.from(agentId ?? createAgentId(8)),
    authority: TEST_PUBKEY,
    timestamp: mockBN(1700001235),
  };
}

describe("Event subscription utilities", () => {
  let mockProgram: ReturnType<typeof createMockProgram>;

  beforeEach(() => {
    mockProgram = createMockProgram();
  });

  describe("subscribeToAgentRegistered", () => {
    it("registers listener with correct event name", () => {
      const callback = vi.fn();
      subscribeToAgentRegistered(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentRegistered",
        expect.any(Function),
      );
    });

    it("parses and passes event to callback", () => {
      const callback = vi.fn();
      subscribeToAgentRegistered(mockProgram, callback);

      const rawEvent = {
        agentId: Array.from(createAgentId(42)),
        authority: TEST_PUBKEY,
        capabilities: mockBN(3n),
        endpoint: "https://test.example.com",
        timestamp: mockBN(1700000000),
      };

      mockProgram._emit("agentRegistered", rawEvent, 12345, "sig123");

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];

      expect(event.agentId).toBeInstanceOf(Uint8Array);
      expect(event.agentId[0]).toBe(42);
      expect(event.authority).toBe(TEST_PUBKEY);
      expect(event.capabilities).toBe(3n);
      expect(event.endpoint).toBe("https://test.example.com");
      expect(event.timestamp).toBe(1700000000);
      expect(slot).toBe(12345);
      expect(sig).toBe("sig123");
    });

    it("filters by agentId when option provided", () => {
      const callback = vi.fn();
      const filterAgentId = createAgentId(42);

      subscribeToAgentRegistered(mockProgram, callback, {
        agentId: filterAgentId,
      });

      // Emit matching event
      mockProgram._emit(
        "agentRegistered",
        {
          agentId: Array.from(filterAgentId),
          authority: TEST_PUBKEY,
          capabilities: mockBN(1n),
          endpoint: "test",
          timestamp: mockBN(1000),
        },
        1,
        "sig1",
      );

      // Emit non-matching event
      mockProgram._emit(
        "agentRegistered",
        {
          agentId: Array.from(createAgentId(99)),
          authority: TEST_PUBKEY,
          capabilities: mockBN(1n),
          endpoint: "test",
          timestamp: mockBN(1000),
        },
        2,
        "sig2",
      );

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes correctly", async () => {
      const callback = vi.fn();
      const subscription = subscribeToAgentRegistered(mockProgram, callback);

      await subscription.unsubscribe();

      expect(mockProgram.removeEventListener).toHaveBeenCalledWith(1); // First listener ID
    });
  });

  describe("subscribeToAgentUpdated", () => {
    it("registers listener with correct event name", () => {
      const callback = vi.fn();
      subscribeToAgentUpdated(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentUpdated",
        expect.any(Function),
      );
    });

    it("parses and passes event to callback", () => {
      const callback = vi.fn();
      subscribeToAgentUpdated(mockProgram, callback);

      const rawEvent = {
        agentId: Array.from(createAgentId(10)),
        capabilities: mockBN(7n),
        status: AgentStatus.Active,
        timestamp: mockBN(1700001000),
      };

      mockProgram._emit("agentUpdated", rawEvent, 54321, "sig456");

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];

      expect(event.agentId).toBeInstanceOf(Uint8Array);
      expect(event.capabilities).toBe(7n);
      expect(event.status).toBe(AgentStatus.Active);
      expect(event.timestamp).toBe(1700001000);
      expect(slot).toBe(54321);
      expect(sig).toBe("sig456");
    });

    it("filters by agentId when option provided", () => {
      const callback = vi.fn();
      const filterAgentId = createAgentId(20);

      subscribeToAgentUpdated(mockProgram, callback, {
        agentId: filterAgentId,
      });

      // Emit non-matching event
      mockProgram._emit(
        "agentUpdated",
        {
          agentId: Array.from(createAgentId(30)),
          capabilities: mockBN(1n),
          status: 0,
          timestamp: mockBN(1000),
        },
        1,
        "sig1",
      );

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("subscribeToAgentDeregistered", () => {
    it("registers listener with correct event name", () => {
      const callback = vi.fn();
      subscribeToAgentDeregistered(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentDeregistered",
        expect.any(Function),
      );
    });

    it("parses and passes event to callback", () => {
      const callback = vi.fn();
      subscribeToAgentDeregistered(mockProgram, callback);

      const rawEvent = {
        agentId: Array.from(createAgentId(5)),
        authority: TEST_PUBKEY,
        timestamp: mockBN(1700002000),
      };

      mockProgram._emit("agentDeregistered", rawEvent, 99999, "sig789");

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];

      expect(event.agentId).toBeInstanceOf(Uint8Array);
      expect(event.authority).toBe(TEST_PUBKEY);
      expect(event.timestamp).toBe(1700002000);
      expect(slot).toBe(99999);
      expect(sig).toBe("sig789");
    });
  });

  describe("subscribeToAgentSuspended", () => {
    it("registers listener with correct event name", () => {
      const callback = vi.fn();
      subscribeToAgentSuspended(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentSuspended",
        expect.any(Function),
      );
    });

    it("parses and passes event to callback", () => {
      const callback = vi.fn();
      subscribeToAgentSuspended(mockProgram, callback);

      const rawEvent = createRawAgentSuspended(createAgentId(9));
      mockProgram._emit("agentSuspended", rawEvent, 11000, "sig110");

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];

      expect(event.agentId).toBeInstanceOf(Uint8Array);
      expect(event.authority).toBe(TEST_PUBKEY);
      expect(event.timestamp).toBe(1700001234);
      expect(slot).toBe(11000);
      expect(sig).toBe("sig110");
    });
  });

  describe("subscribeToAgentUnsuspended", () => {
    it("registers listener with correct event name", () => {
      const callback = vi.fn();
      subscribeToAgentUnsuspended(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentUnsuspended",
        expect.any(Function),
      );
    });

    it("parses and passes event to callback", () => {
      const callback = vi.fn();
      subscribeToAgentUnsuspended(mockProgram, callback);

      const rawEvent = createRawAgentUnsuspended(createAgentId(10));
      mockProgram._emit("agentUnsuspended", rawEvent, 12000, "sig120");

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];

      expect(event.agentId).toBeInstanceOf(Uint8Array);
      expect(event.authority).toBe(TEST_PUBKEY);
      expect(event.timestamp).toBe(1700001235);
      expect(slot).toBe(12000);
      expect(sig).toBe("sig120");
    });
  });

  describe("subscribeToAllAgentEvents", () => {
    it("subscribes to all three event types", () => {
      const callbacks = {
        onRegistered: vi.fn(),
        onUpdated: vi.fn(),
        onDeregistered: vi.fn(),
        onSuspended: vi.fn(),
        onUnsuspended: vi.fn(),
      };

      subscribeToAllAgentEvents(mockProgram, callbacks);

      expect(mockProgram.addEventListener).toHaveBeenCalledTimes(5);
      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentRegistered",
        expect.any(Function),
      );
      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentUpdated",
        expect.any(Function),
      );
      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentDeregistered",
        expect.any(Function),
      );
      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentSuspended",
        expect.any(Function),
      );
      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentUnsuspended",
        expect.any(Function),
      );
    });

    it("only subscribes to events with provided callbacks", () => {
      const callbacks = {
        onRegistered: vi.fn(),
        // onUpdated not provided
        // onDeregistered not provided
      };

      subscribeToAllAgentEvents(mockProgram, callbacks);

      expect(mockProgram.addEventListener).toHaveBeenCalledTimes(1);
      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "agentRegistered",
        expect.any(Function),
      );
    });

    it("routes events to correct callbacks", () => {
      const callbacks = {
        onRegistered: vi.fn(),
        onUpdated: vi.fn(),
        onDeregistered: vi.fn(),
        onSuspended: vi.fn(),
        onUnsuspended: vi.fn(),
      };

      subscribeToAllAgentEvents(mockProgram, callbacks);

      // Emit registered event
      mockProgram._emit(
        "agentRegistered",
        {
          agentId: Array.from(createAgentId(1)),
          authority: TEST_PUBKEY,
          capabilities: mockBN(1n),
          endpoint: "test",
          timestamp: mockBN(1000),
        },
        1,
        "sig1",
      );

      // Emit updated event
      mockProgram._emit(
        "agentUpdated",
        {
          agentId: Array.from(createAgentId(2)),
          capabilities: mockBN(2n),
          status: 1,
          timestamp: mockBN(2000),
        },
        2,
        "sig2",
      );

      // Emit deregistered event
      mockProgram._emit(
        "agentDeregistered",
        {
          agentId: Array.from(createAgentId(3)),
          authority: TEST_PUBKEY,
          timestamp: mockBN(3000),
        },
        3,
        "sig3",
      );
      mockProgram._emit(
        "agentSuspended",
        createRawAgentSuspended(createAgentId(7)),
        4,
        "sig4",
      );
      mockProgram._emit(
        "agentUnsuspended",
        createRawAgentUnsuspended(createAgentId(8)),
        5,
        "sig5",
      );

      expect(callbacks.onRegistered).toHaveBeenCalledTimes(1);
      expect(callbacks.onUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onDeregistered).toHaveBeenCalledTimes(1);
      expect(callbacks.onSuspended).toHaveBeenCalledTimes(1);
      expect(callbacks.onUnsuspended).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes from all events", async () => {
      const callbacks = {
        onRegistered: vi.fn(),
        onUpdated: vi.fn(),
        onDeregistered: vi.fn(),
        onSuspended: vi.fn(),
        onUnsuspended: vi.fn(),
      };

      const subscription = subscribeToAllAgentEvents(mockProgram, callbacks);
      await subscription.unsubscribe();

      expect(mockProgram.removeEventListener).toHaveBeenCalledTimes(5);
    });

    it("applies agentId filter to all subscriptions", () => {
      const callbacks = {
        onRegistered: vi.fn(),
        onUpdated: vi.fn(),
      };

      const filterAgentId = createAgentId(50);
      subscribeToAllAgentEvents(mockProgram, callbacks, {
        agentId: filterAgentId,
      });

      // Emit matching registered event
      mockProgram._emit(
        "agentRegistered",
        {
          agentId: Array.from(filterAgentId),
          authority: TEST_PUBKEY,
          capabilities: mockBN(1n),
          endpoint: "test",
          timestamp: mockBN(1000),
        },
        1,
        "sig1",
      );

      // Emit non-matching updated event
      mockProgram._emit(
        "agentUpdated",
        {
          agentId: Array.from(createAgentId(99)),
          capabilities: mockBN(1n),
          status: 0,
          timestamp: mockBN(1000),
        },
        2,
        "sig2",
      );

      expect(callbacks.onRegistered).toHaveBeenCalledTimes(1);
      expect(callbacks.onUpdated).not.toHaveBeenCalled();
    });

    it("handles empty callbacks object", () => {
      const subscription = subscribeToAllAgentEvents(mockProgram, {});

      expect(mockProgram.addEventListener).not.toHaveBeenCalled();

      // Should still return valid subscription
      expect(subscription.unsubscribe).toBeDefined();
    });
  });

  describe("Event parsing edge cases", () => {
    it("handles Uint8Array agentId in events", () => {
      const callback = vi.fn();
      subscribeToAgentRegistered(mockProgram, callback);

      const rawEvent = {
        agentId: createAgentId(77), // Uint8Array instead of number[]
        authority: TEST_PUBKEY,
        capabilities: mockBN(1n),
        endpoint: "test",
        timestamp: mockBN(1000),
      };

      mockProgram._emit("agentRegistered", rawEvent, 1, "sig");

      expect(callback).toHaveBeenCalled();
      const [event] = callback.mock.calls[0];
      expect(event.agentId).toBeInstanceOf(Uint8Array);
      expect(event.agentId[0]).toBe(77);
    });

    it("converts capabilities from BN to bigint", () => {
      const callback = vi.fn();
      subscribeToAgentRegistered(mockProgram, callback);

      // Large capabilities value
      const rawEvent = {
        agentId: Array.from(createAgentId(1)),
        authority: TEST_PUBKEY,
        capabilities: mockBN(1023n), // All 10 capabilities
        endpoint: "test",
        timestamp: mockBN(1000),
      };

      mockProgram._emit("agentRegistered", rawEvent, 1, "sig");

      const [event] = callback.mock.calls[0];
      expect(event.capabilities).toBe(1023n);
      expect(typeof event.capabilities).toBe("bigint");
    });

    it("converts timestamp from BN to number", () => {
      const callback = vi.fn();
      subscribeToAgentRegistered(mockProgram, callback);

      const rawEvent = {
        agentId: Array.from(createAgentId(1)),
        authority: TEST_PUBKEY,
        capabilities: mockBN(1n),
        endpoint: "test",
        timestamp: mockBN(1704067200), // Unix timestamp
      };

      mockProgram._emit("agentRegistered", rawEvent, 1, "sig");

      const [event] = callback.mock.calls[0];
      expect(event.timestamp).toBe(1704067200);
      expect(typeof event.timestamp).toBe("number");
    });
  });
});
