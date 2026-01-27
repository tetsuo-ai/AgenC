import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { EventMonitor } from './monitor.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';

function mockBN(value: bigint | number): { toNumber: () => number; toString: () => string } {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

const TEST_PUBKEY = new PublicKey('11111111111111111111111111111111');

function createMockProgram() {
  const eventCallbacks = new Map<number, { eventName: string; callback: Function }>();
  let nextListenerId = 1;

  return {
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
  } as unknown as Program<AgencCoordination> & {
    _emit: (eventName: string, rawEvent: unknown, slot: number, signature: string) => void;
    _getCallbackCount: () => number;
  };
}

function createRawTaskCreated() {
  return {
    taskId: new Uint8Array(32).fill(1),
    creator: TEST_PUBKEY,
    requiredCapabilities: mockBN(1n),
    rewardAmount: mockBN(1_000_000_000n),
    taskType: 0,
    deadline: mockBN(9999999),
    timestamp: mockBN(1234567890),
  };
}

function createRawTaskClaimed() {
  return {
    taskId: new Uint8Array(32).fill(1),
    worker: TEST_PUBKEY,
    currentWorkers: 1,
    maxWorkers: 3,
    timestamp: mockBN(1234567890),
  };
}

function createRawDisputeInitiated() {
  return {
    disputeId: new Uint8Array(32).fill(2),
    taskId: new Uint8Array(32).fill(1),
    initiator: TEST_PUBKEY,
    resolutionType: 0,
    votingDeadline: mockBN(9999999),
    timestamp: mockBN(1234567890),
  };
}

function createRawProtocolInitialized() {
  return {
    authority: TEST_PUBKEY,
    treasury: TEST_PUBKEY,
    disputeThreshold: 51,
    protocolFeeBps: 100,
    timestamp: mockBN(1234567890),
  };
}

describe('EventMonitor', () => {
  let mockProgram: ReturnType<typeof createMockProgram>;

  beforeEach(() => {
    mockProgram = createMockProgram();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should throw when program is missing', () => {
      expect(() => new EventMonitor({ program: null as any })).toThrow(
        'EventMonitorConfig.program is required'
      );
    });

    it('should throw when program is undefined', () => {
      expect(() => new EventMonitor({ program: undefined as any })).toThrow(
        'EventMonitorConfig.program is required'
      );
    });

    it('should create instance with valid config', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      expect(monitor).toBeInstanceOf(EventMonitor);
    });

    it('should accept optional logger', () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        setLevel: vi.fn(),
      };
      const monitor = new EventMonitor({ program: mockProgram, logger });
      monitor.start();
      expect(logger.info).toHaveBeenCalledWith('EventMonitor started');
    });
  });

  describe('initial state', () => {
    it('should not be running before start()', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      expect(monitor.isRunning()).toBe(false);
    });

    it('should have zero metrics', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      const metrics = monitor.getMetrics();
      expect(metrics.totalEventsReceived).toBe(0);
      expect(metrics.eventCounts).toEqual({});
      expect(metrics.uptimeMs).toBe(0);
      expect(metrics.startedAt).toBeNull();
    });

    it('should have zero subscriptions', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      expect(monitor.getSubscriptionCount()).toBe(0);
    });
  });

  describe('subscriptions', () => {
    it('should register task event listeners immediately', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({
        onTaskCreated: vi.fn(),
        onTaskClaimed: vi.fn(),
      });
      expect(mockProgram.addEventListener).toHaveBeenCalledWith('taskCreated', expect.any(Function));
      expect(mockProgram.addEventListener).toHaveBeenCalledWith('taskClaimed', expect.any(Function));
      expect(monitor.getSubscriptionCount()).toBe(1);
    });

    it('should register dispute event listeners immediately', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToDisputeEvents({
        onDisputeInitiated: vi.fn(),
      });
      expect(mockProgram.addEventListener).toHaveBeenCalledWith('disputeInitiated', expect.any(Function));
      expect(monitor.getSubscriptionCount()).toBe(1);
    });

    it('should register protocol event listeners immediately', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToProtocolEvents({
        onProtocolInitialized: vi.fn(),
      });
      expect(mockProgram.addEventListener).toHaveBeenCalledWith('protocolInitialized', expect.any(Function));
      expect(monitor.getSubscriptionCount()).toBe(1);
    });

    it('should register agent event listeners immediately', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToAgentEvents({
        onRegistered: vi.fn(),
      });
      expect(mockProgram.addEventListener).toHaveBeenCalledWith('agentRegistered', expect.any(Function));
      expect(monitor.getSubscriptionCount()).toBe(1);
    });

    it('should accumulate subscriptions from multiple subscribe calls', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({ onTaskCreated: vi.fn() });
      monitor.subscribeToDisputeEvents({ onDisputeInitiated: vi.fn() });
      monitor.subscribeToProtocolEvents({ onProtocolInitialized: vi.fn() });
      expect(monitor.getSubscriptionCount()).toBe(3);
    });

    it('should not require start() for subscriptions to work', () => {
      const userCallback = vi.fn();
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({ onTaskCreated: userCallback });

      // Do NOT call start() — subscriptions should still fire
      mockProgram._emit('taskCreated', createRawTaskCreated(), 100, 'sig1');
      expect(userCallback).toHaveBeenCalledOnce();
    });
  });

  describe('lifecycle', () => {
    it('start() sets isRunning and records startedAt', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      vi.setSystemTime(1000);
      monitor.start();
      expect(monitor.isRunning()).toBe(true);
      expect(monitor.getMetrics().startedAt).toBe(1000);
    });

    it('start() is idempotent', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      vi.setSystemTime(1000);
      monitor.start();
      vi.setSystemTime(2000);
      monitor.start(); // second call — no-op
      expect(monitor.getMetrics().startedAt).toBe(1000); // unchanged
    });

    it('stop() unsubscribes all and resets state', async () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({ onTaskCreated: vi.fn() });
      monitor.start();
      expect(monitor.getSubscriptionCount()).toBeGreaterThan(0);

      await monitor.stop();
      expect(monitor.isRunning()).toBe(false);
      expect(monitor.getSubscriptionCount()).toBe(0);
      expect(monitor.getMetrics().startedAt).toBeNull();
    });

    it('stop() calls removeEventListener on all handles', async () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({
        onTaskCreated: vi.fn(),
        onTaskClaimed: vi.fn(),
      });
      monitor.start();

      await monitor.stop();
      expect(mockProgram.removeEventListener).toHaveBeenCalled();
    });

    it('stop() is idempotent', async () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.start();
      await monitor.stop();
      await monitor.stop(); // should not throw
      expect(monitor.isRunning()).toBe(false);
    });

    it('stop() when never started is a no-op', async () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({ onTaskCreated: vi.fn() });
      await monitor.stop(); // should not throw, should not unsubscribe
      expect(monitor.getSubscriptionCount()).toBe(1); // subscriptions still intact
    });
  });

  describe('metrics', () => {
    it('should count events after they fire', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({ onTaskCreated: vi.fn() });

      mockProgram._emit('taskCreated', createRawTaskCreated(), 100, 'sig1');
      mockProgram._emit('taskCreated', createRawTaskCreated(), 101, 'sig2');

      const metrics = monitor.getMetrics();
      expect(metrics.totalEventsReceived).toBe(2);
      expect(metrics.eventCounts['taskCreated']).toBe(2);
    });

    it('should track per-event-name counts separately', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({
        onTaskCreated: vi.fn(),
        onTaskClaimed: vi.fn(),
      });

      mockProgram._emit('taskCreated', createRawTaskCreated(), 100, 'sig1');
      mockProgram._emit('taskClaimed', createRawTaskClaimed(), 101, 'sig2');

      const metrics = monitor.getMetrics();
      expect(metrics.eventCounts['taskCreated']).toBe(1);
      expect(metrics.eventCounts['taskClaimed']).toBe(1);
      expect(metrics.totalEventsReceived).toBe(2);
    });

    it('should track events across different subscription types', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({ onTaskCreated: vi.fn() });
      monitor.subscribeToDisputeEvents({ onDisputeInitiated: vi.fn() });
      monitor.subscribeToProtocolEvents({ onProtocolInitialized: vi.fn() });

      mockProgram._emit('taskCreated', createRawTaskCreated(), 100, 'sig1');
      mockProgram._emit('disputeInitiated', createRawDisputeInitiated(), 101, 'sig2');
      mockProgram._emit('protocolInitialized', createRawProtocolInitialized(), 102, 'sig3');

      const metrics = monitor.getMetrics();
      expect(metrics.totalEventsReceived).toBe(3);
      expect(metrics.eventCounts['taskCreated']).toBe(1);
      expect(metrics.eventCounts['disputeInitiated']).toBe(1);
      expect(metrics.eventCounts['protocolInitialized']).toBe(1);
    });

    it('should compute uptimeMs correctly', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      expect(monitor.getMetrics().uptimeMs).toBe(0);

      vi.setSystemTime(1000);
      monitor.start();
      vi.setSystemTime(6000);
      expect(monitor.getMetrics().uptimeMs).toBe(5000);
    });

    it('should return 0 uptimeMs when not started', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      vi.setSystemTime(5000);
      expect(monitor.getMetrics().uptimeMs).toBe(0);
    });

    it('should return a copy of eventCounts, not the internal object', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      const metrics1 = monitor.getMetrics();
      metrics1.eventCounts['injected'] = 999;
      const metrics2 = monitor.getMetrics();
      expect(metrics2.eventCounts['injected']).toBeUndefined();
    });
  });

  describe('callback wrapping', () => {
    it('should forward parsed events to user callback after counting', () => {
      const userCallback = vi.fn();
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToTaskEvents({ onTaskCreated: userCallback });

      mockProgram._emit('taskCreated', createRawTaskCreated(), 100, 'sig1');

      expect(userCallback).toHaveBeenCalledOnce();
      expect(userCallback).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: expect.any(Uint8Array) }),
        100,
        'sig1'
      );
      expect(monitor.getMetrics().totalEventsReceived).toBe(1);
    });

    it('should increment metrics before forwarding to user callback', () => {
      const monitor = new EventMonitor({ program: mockProgram });
      let metricsAtCallbackTime = 0;
      const userCallback = vi.fn(() => {
        metricsAtCallbackTime = monitor.getMetrics().totalEventsReceived;
      });
      monitor.subscribeToTaskEvents({ onTaskCreated: userCallback });

      mockProgram._emit('taskCreated', createRawTaskCreated(), 100, 'sig1');
      expect(metricsAtCallbackTime).toBe(1);
    });

    it('should wrap dispute event callbacks for metrics', () => {
      const userCallback = vi.fn();
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToDisputeEvents({ onDisputeInitiated: userCallback });

      mockProgram._emit('disputeInitiated', createRawDisputeInitiated(), 100, 'sig1');

      expect(userCallback).toHaveBeenCalledOnce();
      expect(monitor.getMetrics().eventCounts['disputeInitiated']).toBe(1);
    });

    it('should wrap protocol event callbacks for metrics', () => {
      const userCallback = vi.fn();
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToProtocolEvents({ onProtocolInitialized: userCallback });

      mockProgram._emit('protocolInitialized', createRawProtocolInitialized(), 100, 'sig1');

      expect(userCallback).toHaveBeenCalledOnce();
      expect(monitor.getMetrics().eventCounts['protocolInitialized']).toBe(1);
    });

    it('should wrap agent event callbacks for metrics', () => {
      const userCallback = vi.fn();
      const monitor = new EventMonitor({ program: mockProgram });
      monitor.subscribeToAgentEvents({ onRegistered: userCallback });

      mockProgram._emit('agentRegistered', {
        agentId: new Uint8Array(32).fill(5),
        authority: TEST_PUBKEY,
        capabilities: mockBN(3n),
        endpoint: 'https://example.com',
        timestamp: mockBN(1234567890),
      }, 100, 'sig1');

      expect(userCallback).toHaveBeenCalledOnce();
      expect(monitor.getMetrics().eventCounts['agentRegistered']).toBe(1);
    });
  });
});
