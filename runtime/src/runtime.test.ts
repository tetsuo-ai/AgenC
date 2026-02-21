/**
 * Tests for AgentRuntime class
 *
 * These tests focus on constructor validation and synchronous methods.
 * Integration tests requiring blockchain connections are in a separate file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { AgentRuntime } from "./runtime.js";
import { EventMonitor } from "./events/index.js";
import { AgentManager } from "./agent/manager.js";
import { TaskExecutor } from "./task/index.js";
import { AgentStatus } from "./agent/types.js";
import { ValidationError } from "./types/errors.js";
import { ReplayEventBridge, type ReplayBridgeHandle } from "./replay/bridge.js";
import type { Wallet } from "./types/wallet.js";
import { AGENT_ID_LENGTH } from "./agent/types.js";
import type { TaskOperations } from "./task/operations.js";
import type { Logger } from "./utils/logger.js";
import { createLogger } from "./utils/logger.js";

// Mock Connection to avoid real network calls
const mockConnection = {
  getAccountInfo: vi.fn(),
  rpcEndpoint: "https://api.devnet.solana.com",
} as unknown as Connection;

function createReplayBridgeHandle(): ReplayBridgeHandle {
  const store = {
    query: vi.fn(async () => []),
    getCursor: vi.fn(async () => null),
    saveCursor: vi.fn(async () => {}),
    save: vi.fn(async () => ({ inserted: 0, duplicates: 0 })),
    clear: vi.fn(async () => {}),
  };

  return {
    start: vi.fn(async () => {}),
    runBackfill: vi.fn(async () => ({
      processed: 0,
      duplicates: 0,
      cursor: null,
    })),
    getStore: vi.fn(async () => store),
    query: vi.fn(async () => []),
    getCursor: vi.fn(async () => null),
    clear: vi.fn(async () => {}),
    saveCursor: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

describe("AgentRuntime", () => {
  describe("constructor", () => {
    it("creates instance with minimal valid config using Keypair", () => {
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

    it("creates instance with Wallet interface", () => {
      const wallet: Wallet = {
        publicKey: Keypair.generate().publicKey,
        signTransaction: async <T extends Transaction | VersionedTransaction>(
          tx: T,
        ): Promise<T> => tx,
        signAllTransactions: async <
          T extends Transaction | VersionedTransaction,
        >(
          txs: T[],
        ): Promise<T[]> => txs,
      };

      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet,
        capabilities: 1n,
      });

      expect(runtime).toBeInstanceOf(AgentRuntime);
    });

    it("throws ValidationError when connection is missing", () => {
      const keypair = Keypair.generate();
      expect(
        () =>
          new AgentRuntime({
            connection: null as unknown as Connection,
            wallet: keypair,
          }),
      ).toThrow(ValidationError);
      expect(
        () =>
          new AgentRuntime({
            connection: null as unknown as Connection,
            wallet: keypair,
          }),
      ).toThrow("connection is required");
    });

    it("throws ValidationError when wallet is missing", () => {
      expect(
        () =>
          new AgentRuntime({
            connection: mockConnection,
            wallet: null as unknown as Keypair,
          }),
      ).toThrow(ValidationError);
      expect(
        () =>
          new AgentRuntime({
            connection: mockConnection,
            wallet: null as unknown as Keypair,
          }),
      ).toThrow("wallet is required");
    });

    it("throws ValidationError when agentId has wrong length", () => {
      const keypair = Keypair.generate();

      // Too short
      expect(
        () =>
          new AgentRuntime({
            connection: mockConnection,
            wallet: keypair,
            agentId: new Uint8Array(16),
          }),
      ).toThrow(ValidationError);
      expect(
        () =>
          new AgentRuntime({
            connection: mockConnection,
            wallet: keypair,
            agentId: new Uint8Array(16),
          }),
      ).toThrow("Invalid agentId length: 16");

      // Too long
      expect(
        () =>
          new AgentRuntime({
            connection: mockConnection,
            wallet: keypair,
            agentId: new Uint8Array(64),
          }),
      ).toThrow(ValidationError);
      expect(
        () =>
          new AgentRuntime({
            connection: mockConnection,
            wallet: keypair,
            agentId: new Uint8Array(64),
          }),
      ).toThrow("Invalid agentId length: 64");
    });

    it("accepts valid 32-byte agentId", () => {
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

    it("generates random agentId when not provided", () => {
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

    it("uses default values for optional config", () => {
      const keypair = Keypair.generate();

      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
      });

      expect(runtime.getAgentId().length).toBe(32);
      expect(runtime.getAgentPda()).toBeNull(); // Not started yet
    });
  });

  describe("getAgentId", () => {
    it("returns a copy of agentId to prevent mutation", () => {
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
      const originalFirstByte = id2[0];
      id1[0] = originalFirstByte === 0xff ? 0x00 : 0xff;
      const id3 = runtime.getAgentId();
      expect(id3[0]).toBe(originalFirstByte);
    });
  });

  describe("isStarted", () => {
    it("returns false before start() is called", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      expect(runtime.isStarted()).toBe(false);
    });
  });

  describe("getAgentPda", () => {
    it("returns null before start() is called", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      expect(runtime.getAgentPda()).toBeNull();
    });
  });

  describe("getAgentManager", () => {
    it("returns the AgentManager instance", () => {
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

  describe("stop", () => {
    it("is idempotent when not started", async () => {
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

  describe("registerShutdownHandlers", () => {
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

    it("registers SIGINT and SIGTERM handlers", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      runtime.registerShutdownHandlers();

      expect(process.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
      expect(process.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    });

    it("is idempotent - does not register handlers twice", () => {
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

  describe("createEventMonitor", () => {
    it("returns an EventMonitor instance", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const monitor = runtime.createEventMonitor();
      expect(monitor).toBeInstanceOf(EventMonitor);
    });

    it("returns a new instance on each call", () => {
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

    it("returns a monitor that is not yet running", () => {
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

    it("returns a monitor with zeroed metrics", () => {
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

  describe("createTaskExecutor", () => {
    const mockOperations = {} as TaskOperations;
    const mockHandler = vi.fn();

    it("returns a TaskExecutor instance", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const executor = runtime.createTaskExecutor({
        operations: mockOperations,
        handler: mockHandler,
      });

      expect(executor).toBeInstanceOf(TaskExecutor);
    });

    it("returns a new instance on each call", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const executor1 = runtime.createTaskExecutor({
        operations: mockOperations,
        handler: mockHandler,
      });
      const executor2 = runtime.createTaskExecutor({
        operations: mockOperations,
        handler: mockHandler,
      });

      expect(executor1).not.toBe(executor2);
    });

    it("returns an executor that is not yet running", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const executor = runtime.createTaskExecutor({
        operations: mockOperations,
        handler: mockHandler,
      });

      expect(executor.isRunning()).toBe(false);
    });

    it("uses runtime logger by default", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
        logLevel: "info",
      });

      // The executor should be created without errors using the runtime's logger
      const executor = runtime.createTaskExecutor({
        operations: mockOperations,
        handler: mockHandler,
      });

      expect(executor).toBeInstanceOf(TaskExecutor);
    });

    it("allows logger override", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const customLogger: Logger = createLogger("debug", "[CustomExecutor]");

      const executor = runtime.createTaskExecutor({
        operations: mockOperations,
        handler: mockHandler,
        logger: customLogger,
      });

      expect(executor).toBeInstanceOf(TaskExecutor);
    });

    it("supports multiple concurrent executors", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const executors = [
        runtime.createTaskExecutor({
          operations: mockOperations,
          handler: mockHandler,
        }),
        runtime.createTaskExecutor({
          operations: mockOperations,
          handler: mockHandler,
        }),
        runtime.createTaskExecutor({
          operations: mockOperations,
          handler: mockHandler,
        }),
      ];

      expect(executors).toHaveLength(3);
      executors.forEach((e) => expect(e).toBeInstanceOf(TaskExecutor));
      // All distinct instances
      expect(new Set(executors).size).toBe(3);
    });

    it("returns executor with zeroed metrics", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const executor = runtime.createTaskExecutor({
        operations: mockOperations,
        handler: mockHandler,
      });

      const status = executor.getStatus();
      expect(status.running).toBe(false);
      expect(status.tasksDiscovered).toBe(0);
      expect(status.tasksClaimed).toBe(0);
      expect(status.tasksCompleted).toBe(0);
      expect(status.tasksFailed).toBe(0);
    });

    it("passes through mode and maxConcurrentTasks config", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
      });

      const executor = runtime.createTaskExecutor({
        operations: mockOperations,
        handler: mockHandler,
        mode: "batch",
        maxConcurrentTasks: 5,
      });

      const status = executor.getStatus();
      expect(status.mode).toBe("batch");
    });
  });

  describe("replay integration", () => {
    let createSpy: ReturnType<typeof vi.spyOn>;
    let bridge: ReplayBridgeHandle;

    beforeEach(() => {
      bridge = createReplayBridgeHandle();
      createSpy = vi.spyOn(ReplayEventBridge, "create").mockReturnValue(bridge);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("creates replay bridge when enabled via runtime config", () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
        replay: {
          enabled: true,
        },
        program: {} as any,
      });

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(runtime.getReplayBridge()).toBe(bridge);
    });

    it("starts and stops replay bridge in runtime lifecycle", async () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
        replay: {
          enabled: true,
        },
        program: {} as any,
      });

      const manager = runtime.getAgentManager();

      vi.spyOn(AgentManager, "agentExists").mockResolvedValue(true);
      vi.spyOn(manager, "load").mockResolvedValue({
        status: AgentStatus.Active,
      } as any);

      await runtime.start();
      expect(bridge.start).toHaveBeenCalledTimes(1);

      vi.spyOn(manager, "unsubscribeAll").mockResolvedValue(undefined);
      await runtime.stop();
      expect(bridge.stop).toHaveBeenCalledTimes(1);
    });

    it("uses backfill defaults when toSlot is omitted", async () => {
      const keypair = Keypair.generate();
      const runtime = new AgentRuntime({
        connection: mockConnection,
        wallet: keypair,
        capabilities: 1n,
        replay: {
          enabled: true,
          backfill: {
            toSlot: 987,
            pageSize: 4,
          },
        },
        program: {} as any,
      });

      const runBackfill = vi.mocked(bridge.runBackfill);
      const fetcher = {
        fetchPage: vi.fn(async () => ({
          events: [],
          nextCursor: null,
          done: true,
        })),
      };
      await runtime.runReplayBackfill({ fetcher });
      expect(runBackfill).toHaveBeenCalledWith({
        fetcher,
        toSlot: 987,
        pageSize: 4,
      });
    });
  });
});
