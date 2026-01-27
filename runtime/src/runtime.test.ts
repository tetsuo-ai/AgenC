/**
 * Tests for AgentRuntime class
 *
 * These tests focus on constructor validation and synchronous methods.
 * Integration tests requiring blockchain connections are in a separate file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { AgentRuntime } from './runtime.js';
import { EventMonitor } from './events/index.js';
import { ValidationError } from './types/errors.js';
import type { Wallet } from './types/wallet.js';
import { AGENT_ID_LENGTH } from './agent/types.js';

// Mock Connection to avoid real network calls
const mockConnection = {
  getAccountInfo: vi.fn(),
  rpcEndpoint: 'https://api.devnet.solana.com',
} as unknown as Connection;

describe('AgentRuntime', () => {
  describe('constructor', () => {
    it('creates instance with minimal valid config using Keypair', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      expect(runtime).toBeInstanceOf(AgentRuntime);
      expect(runtime.isStarted()).toBe(false);
      expect(runtime.getAgentId()).toBeInstanceOf(Uint8Array);
      expect(runtime.getAgentId().length).toBe(AGENT_ID_LENGTH);
    });

    it('creates instance with Wallet interface', () => {
      const wallet: Wallet = {
        publicKey: Keypair.generate().publicKey,
        signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => tx,
        signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => txs,
      };

      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet,
        capabilities: 1n,
      });

      expect(runtime).toBeInstanceOf(AgentRuntime);
    });

    it('throws ValidationError when connection is missing', () => {
      const keypair = Keypair.generate();
      expect(() => new AgentRuntime({
        connection: null as unknown as Connection,
        wallet: keypair,
      })).toThrow(ValidationError);
      expect(() => new AgentRuntime({
        connection: null as unknown as Connection,
        wallet: keypair,
      })).toThrow('connection is required');
    });

    it('throws ValidationError when wallet is missing', () => {
      expect(() => new AgentRuntime({
        connection: mockConnection,
        wallet: null as unknown as Keypair,
      })).toThrow(ValidationError);
      expect(() => new AgentRuntime({
        connection: mockConnection,
        wallet: null as unknown as Keypair,
      })).toThrow('wallet is required');
    });

    it('throws ValidationError when agentId has wrong length', () => {
      const keypair = Keypair.generate();

      // Too short
      expect(() => new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        agentId: new Uint8Array(16),
      })).toThrow(ValidationError);
      expect(() => new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        agentId: new Uint8Array(16),
      })).toThrow('Invalid agentId length: 16');

      // Too long
      expect(() => new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        agentId: new Uint8Array(64),
      })).toThrow(ValidationError);
      expect(() => new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        agentId: new Uint8Array(64),
      })).toThrow('Invalid agentId length: 64');
    });

    it('accepts valid 32-byte agentId', () => {
      const keypair = Keypair.generate();
      const customAgentId = new Uint8Array(32).fill(42);

      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        agentId: customAgentId,
        capabilities: 1n,
      });

      const returnedId = runtime.getAgentId();
      expect(returnedId).toEqual(customAgentId);
      // Verify it's a copy, not the same instance
      expect(returnedId).not.toBe(customAgentId);
    });

    it('generates random agentId when not provided', () => {
      const keypair = Keypair.generate();

      const runtime1 = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const runtime2 = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      // Different runtimes should have different IDs
      expect(runtime1.getAgentId()).not.toEqual(runtime2.getAgentId());
    });

    it('uses default values for optional config', () => {
      const keypair = Keypair.generate();

      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
      });

      expect(runtime.getAgentId().length).toBe(32);
      expect(runtime.getAgentPda()).toBeNull(); // Not started yet
    });
  });

  describe('getAgentId', () => {
    it('returns a copy of agentId to prevent mutation', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const id1 = runtime.getAgentId();
      const id2 = runtime.getAgentId();

      // Should be equal values
      expect(id1).toEqual(id2);
      // But different instances
      expect(id1).not.toBe(id2);

      // Mutating the returned value should not affect the internal state
      id1[0] = 0xff;
      const id3 = runtime.getAgentId();
      expect(id3[0]).not.toBe(0xff);
    });
  });

  describe('isStarted', () => {
    it('returns false before start() is called', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      expect(runtime.isStarted()).toBe(false);
    });
  });

  describe('getAgentPda', () => {
    it('returns null before start() is called', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      expect(runtime.getAgentPda()).toBeNull();
    });
  });

  describe('getAgentManager', () => {
    it('returns the AgentManager instance', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const manager = runtime.getAgentManager();
      expect(manager).toBeDefined();
      // Verify it's the same instance each time
      expect(runtime.getAgentManager()).toBe(manager);
    });
  });

  describe('stop', () => {
    it('is idempotent when not started', async () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      // Should not throw when called before start
      await expect(runtime.stop()).resolves.toBeUndefined();
      await expect(runtime.stop()).resolves.toBeUndefined();
    });
  });

  describe('registerShutdownHandlers', () => {
    let originalOn: typeof process.on;
    let handlers: Map<string, () => void>;

    beforeEach(() => {
      handlers = new Map();
      originalOn = process.on;
      process.on = vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler);
        return process;
      }) as typeof process.on;
    });

    afterEach(() => {
      process.on = originalOn;
    });

    it('registers SIGINT and SIGTERM handlers', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      runtime.registerShutdownHandlers();

      expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    });

    it('is idempotent - does not register handlers twice', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      runtime.registerShutdownHandlers();
      runtime.registerShutdownHandlers();

      // Should only be called twice (SIGINT + SIGTERM), not four times
      expect(process.on).toHaveBeenCalledTimes(2);
    });
  });

  describe('createEventMonitor', () => {
    it('returns an EventMonitor instance', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const monitor = runtime.createEventMonitor();
      expect(monitor).toBeInstanceOf(EventMonitor);
    });

    it('returns a new instance on each call', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const monitor1 = runtime.createEventMonitor();
      const monitor2 = runtime.createEventMonitor();
      expect(monitor1).not.toBe(monitor2);
    });

    it('returns a monitor that is not yet running', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const monitor = runtime.createEventMonitor();
      expect(monitor.isRunning()).toBe(false);
      expect(monitor.getSubscriptionCount()).toBe(0);
    });

    it('returns a monitor with zeroed metrics', () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const monitor = runtime.createEventMonitor();
      const metrics = monitor.getMetrics();
      expect(metrics.totalEventsReceived).toBe(0);
      expect(metrics.eventCounts).toEqual({});
      expect(metrics.startedAt).toBeNull();
      expect(metrics.uptimeMs).toBe(0);
    });
  });
});
