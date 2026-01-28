import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { TaskDiscovery, type TaskDiscoveryOptions, type TaskDiscoveryResult } from './discovery.js';
import { TaskOperations } from './operations.js';
import { OnChainTaskStatus, type OnChainTask, type TaskFilterConfig } from './types.js';
import { TaskType } from '../events/types.js';
import { silentLogger } from '../utils/logger.js';
import { PROGRAM_ID } from '@agenc/sdk';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';

// ============================================================================
// Helpers
// ============================================================================

const COMPUTE = 1n << 0n;
const INFERENCE = 1n << 1n;

function createTask(overrides: Partial<OnChainTask> = {}): OnChainTask {
  return {
    taskId: new Uint8Array(32),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: COMPUTE,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1_000_000n,
    maxWorkers: 5,
    currentWorkers: 0,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1700000000,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    completedAt: 0,
    escrow: Keypair.generate().publicKey,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

/**
 * Creates a mock Anchor program with event listener support for TaskCreated.
 */
function createMockProgram() {
  const eventCallbacks = new Map<number, { eventName: string; callback: Function }>();
  let nextListenerId = 1;

  const mockProgram = {
    programId: PROGRAM_ID,
    addEventListener: vi.fn((eventName: string, callback: Function) => {
      const id = nextListenerId++;
      eventCallbacks.set(id, { eventName, callback });
      return id;
    }),
    removeEventListener: vi.fn(async (_id: number) => {
      eventCallbacks.delete(_id);
    }),
    _emit: (eventName: string, rawEvent: unknown, slot: number, signature: string) => {
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

/**
 * Creates a mock TaskOperations instance.
 */
function createMockOperations() {
  return {
    fetchClaimableTasks: vi.fn().mockResolvedValue([]),
    fetchTask: vi.fn().mockResolvedValue(null),
    fetchAllTasks: vi.fn().mockResolvedValue([]),
    fetchClaim: vi.fn().mockResolvedValue(null),
    fetchActiveClaims: vi.fn().mockResolvedValue([]),
    claimTask: vi.fn(),
    completeTask: vi.fn(),
    completeTaskPrivate: vi.fn(),
    fetchTaskByIds: vi.fn().mockResolvedValue(null),
  } as unknown as TaskOperations & {
    fetchClaimableTasks: ReturnType<typeof vi.fn>;
    fetchTask: ReturnType<typeof vi.fn>;
  };
}

function mockBN(value: bigint | number): { toNumber: () => number; toString: () => string } {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('TaskDiscovery', () => {
  let mockProgram: ReturnType<typeof createMockProgram>;
  let mockOps: ReturnType<typeof createMockOperations>;
  let discovery: TaskDiscovery;

  const defaultConfig = (): TaskDiscoveryOptions => ({
    program: mockProgram,
    operations: mockOps as unknown as TaskOperations,
    filter: {},
    mode: 'poll',
    pollIntervalMs: 100,
    logger: silentLogger,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mockProgram = createMockProgram();
    mockOps = createMockOperations();
  });

  afterEach(async () => {
    if (discovery?.isRunning()) {
      await discovery.stop();
    }
    vi.useRealTimers();
  });

  // ==========================================================================
  // Poll Mode Tests
  // ==========================================================================

  describe('Poll Mode', () => {
    it('discovers tasks on interval', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const listener = vi.fn();
      discovery = new TaskDiscovery(defaultConfig());
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);
      // Flush the initial poll microtask
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].pda).toBe(taskPda);
      expect(listener.mock.calls[0][0].source).toBe('poll');
    });

    it('deduplicates: same task not discovered twice', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const listener = vi.fn();
      discovery = new TaskDiscovery(defaultConfig());
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      // First poll should discover
      expect(listener).toHaveBeenCalledTimes(1);

      // Second poll should not re-discover
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('filters tasks by agent capabilities', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask({ requiredCapabilities: COMPUTE | INFERENCE });
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const listener = vi.fn();
      discovery = new TaskDiscovery(defaultConfig());
      discovery.onTaskDiscovered(listener);

      // Agent only has COMPUTE, but task requires COMPUTE | INFERENCE
      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).not.toHaveBeenCalled();
    });

    it('continues polling after fetch error', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue([{ task, taskPda }]);

      const listener = vi.fn();
      discovery = new TaskDiscovery(defaultConfig());
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);
      // First poll fails — no discovery
      expect(listener).not.toHaveBeenCalled();

      // Second poll succeeds
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('applies filter config', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask({ rewardAmount: 500_000n });
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const listener = vi.fn();
      const config = defaultConfig();
      config.filter = { minRewardLamports: 1_000_000n };
      discovery = new TaskDiscovery(config);
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event Mode Tests
  // ==========================================================================

  describe('Event Mode', () => {
    it('discovers tasks via TaskCreated events', async () => {
      const creator = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      const task = createTask({ taskId, creator });

      // Derive the expected PDA
      const [expectedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('task'), creator.toBuffer(), Buffer.from(taskId)],
        PROGRAM_ID,
      );
      (mockOps.fetchTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);

      const listener = vi.fn();
      const config = defaultConfig();
      config.mode = 'event';
      discovery = new TaskDiscovery(config);
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);

      // Simulate TaskCreated event
      mockProgram._emit(
        'taskCreated',
        {
          taskId: Array.from(taskId),
          creator,
          requiredCapabilities: mockBN(COMPUTE),
          rewardAmount: mockBN(1_000_000n),
          taskType: 0,
          deadline: mockBN(0),
          timestamp: mockBN(Date.now()),
        },
        100,
        'sig-event-1',
      );

      // Wait for async fetchTask
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].source).toBe('event');
      expect(listener.mock.calls[0][0].pda.equals(expectedPda)).toBe(true);
    });

    it('deduplicates: same task from event not discovered twice', async () => {
      const creator = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(2);
      const task = createTask({ taskId, creator });
      (mockOps.fetchTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);

      const listener = vi.fn();
      const config = defaultConfig();
      config.mode = 'event';
      discovery = new TaskDiscovery(config);
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);

      const rawEvent = {
        taskId: Array.from(taskId),
        creator,
        requiredCapabilities: mockBN(COMPUTE),
        rewardAmount: mockBN(1_000_000n),
        taskType: 0,
        deadline: mockBN(0),
        timestamp: mockBN(Date.now()),
      };

      // Emit twice
      mockProgram._emit('taskCreated', rawEvent, 100, 'sig1');
      await vi.advanceTimersByTimeAsync(0);

      mockProgram._emit('taskCreated', rawEvent, 101, 'sig2');
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('filters events by capabilities', async () => {
      const creator = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(3);
      // Task requires INFERENCE but agent only has COMPUTE
      const task = createTask({
        taskId,
        creator,
        requiredCapabilities: INFERENCE,
      });
      (mockOps.fetchTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);

      const listener = vi.fn();
      const config = defaultConfig();
      config.mode = 'event';
      discovery = new TaskDiscovery(config);
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);

      mockProgram._emit(
        'taskCreated',
        {
          taskId: Array.from(taskId),
          creator,
          requiredCapabilities: mockBN(INFERENCE),
          rewardAmount: mockBN(1_000_000n),
          taskType: 0,
          deadline: mockBN(0),
          timestamp: mockBN(Date.now()),
        },
        100,
        'sig-filter',
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(listener).not.toHaveBeenCalled();
    });

    it('handles fetch failure gracefully', async () => {
      const creator = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(4);
      (mockOps.fetchTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fetch error'));

      const listener = vi.fn();
      const config = defaultConfig();
      config.mode = 'event';
      discovery = new TaskDiscovery(config);
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);

      mockProgram._emit(
        'taskCreated',
        {
          taskId: Array.from(taskId),
          creator,
          requiredCapabilities: mockBN(COMPUTE),
          rewardAmount: mockBN(1_000_000n),
          taskType: 0,
          deadline: mockBN(0),
          timestamp: mockBN(Date.now()),
        },
        100,
        'sig-fail',
      );

      await vi.advanceTimersByTimeAsync(0);

      // Listener should NOT be called since fetch failed
      expect(listener).not.toHaveBeenCalled();
    });

    it('handles null task from fetchTask', async () => {
      const creator = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(5);
      (mockOps.fetchTask as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const listener = vi.fn();
      const config = defaultConfig();
      config.mode = 'event';
      discovery = new TaskDiscovery(config);
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);

      mockProgram._emit(
        'taskCreated',
        {
          taskId: Array.from(taskId),
          creator,
          requiredCapabilities: mockBN(COMPUTE),
          rewardAmount: mockBN(1_000_000n),
          taskType: 0,
          deadline: mockBN(0),
          timestamp: mockBN(Date.now()),
        },
        100,
        'sig-null',
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Hybrid Mode Tests
  // ==========================================================================

  describe('Hybrid Mode', () => {
    it('runs both poll and event sources', async () => {
      const pollPda = Keypair.generate().publicKey;
      const pollTask = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task: pollTask, taskPda: pollPda },
      ]);

      const eventCreator = Keypair.generate().publicKey;
      const eventTaskId = new Uint8Array(32).fill(10);
      const eventTask = createTask({ taskId: eventTaskId, creator: eventCreator });
      (mockOps.fetchTask as ReturnType<typeof vi.fn>).mockResolvedValue(eventTask);

      const listener = vi.fn();
      const config = defaultConfig();
      config.mode = 'hybrid';
      discovery = new TaskDiscovery(config);
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      // Poll finds one
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].source).toBe('poll');

      // Event finds another
      mockProgram._emit(
        'taskCreated',
        {
          taskId: Array.from(eventTaskId),
          creator: eventCreator,
          requiredCapabilities: mockBN(COMPUTE),
          rewardAmount: mockBN(1_000_000n),
          taskType: 0,
          deadline: mockBN(0),
          timestamp: mockBN(Date.now()),
        },
        100,
        'sig-hybrid',
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[1][0].source).toBe('event');
    });

    it('cross-source deduplication: poll-discovered task not rediscovered via event', async () => {
      const creator = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(20);
      const task = createTask({ taskId, creator });

      // Derive expected PDA
      const [expectedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('task'), creator.toBuffer(), Buffer.from(taskId)],
        PROGRAM_ID,
      );

      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda: expectedPda },
      ]);
      (mockOps.fetchTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);

      const listener = vi.fn();
      const config = defaultConfig();
      config.mode = 'hybrid';
      discovery = new TaskDiscovery(config);
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      // Poll discovers first
      expect(listener).toHaveBeenCalledTimes(1);

      // Same task emitted as event — should be deduplicated
      mockProgram._emit(
        'taskCreated',
        {
          taskId: Array.from(taskId),
          creator,
          requiredCapabilities: mockBN(COMPUTE),
          rewardAmount: mockBN(1_000_000n),
          taskType: 0,
          deadline: mockBN(0),
          timestamp: mockBN(Date.now()),
        },
        200,
        'sig-dedup',
      );

      await vi.advanceTimersByTimeAsync(0);

      // Still only 1 notification
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Listener Tests
  // ==========================================================================

  describe('Listeners', () => {
    it('multiple listeners all notified', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      discovery = new TaskDiscovery(defaultConfig());
      discovery.onTaskDiscovered(listener1);
      discovery.onTaskDiscovered(listener2);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('exception in one listener does not break others', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const throwingListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const goodListener = vi.fn();

      discovery = new TaskDiscovery(defaultConfig());
      discovery.onTaskDiscovered(throwingListener);
      discovery.onTaskDiscovered(goodListener);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      expect(throwingListener).toHaveBeenCalledTimes(1);
      expect(goodListener).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe removes listener', async () => {
      const taskPda1 = Keypair.generate().publicKey;
      const taskPda2 = Keypair.generate().publicKey;
      const task1 = createTask();
      const task2 = createTask();

      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ task: task1, taskPda: taskPda1 }])
        .mockResolvedValueOnce([{ task: task2, taskPda: taskPda2 }]);

      const listener = vi.fn();
      discovery = new TaskDiscovery(defaultConfig());
      const unsub = discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsub();

      // Next poll
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);

      // Should still be 1 (not 2)
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Lifecycle Tests
  // ==========================================================================

  describe('Lifecycle', () => {
    it('start() is idempotent', async () => {
      discovery = new TaskDiscovery(defaultConfig());

      await discovery.start(COMPUTE);
      await discovery.start(COMPUTE); // no-op

      expect(discovery.isRunning()).toBe(true);
    });

    it('stop() is idempotent', async () => {
      discovery = new TaskDiscovery(defaultConfig());

      await discovery.start(COMPUTE);
      await discovery.stop();
      await discovery.stop(); // no-op

      expect(discovery.isRunning()).toBe(false);
    });

    it('stop() cleans up timer and subscriptions', async () => {
      const config = defaultConfig();
      config.mode = 'hybrid';
      discovery = new TaskDiscovery(config);

      await discovery.start(COMPUTE);
      expect(discovery.isRunning()).toBe(true);
      expect(mockProgram.addEventListener).toHaveBeenCalled();

      await discovery.stop();
      expect(discovery.isRunning()).toBe(false);
      expect(mockProgram.removeEventListener).toHaveBeenCalled();
    });

    it('isRunning() reflects state', async () => {
      discovery = new TaskDiscovery(defaultConfig());

      expect(discovery.isRunning()).toBe(false);

      await discovery.start(COMPUTE);
      expect(discovery.isRunning()).toBe(true);

      await discovery.stop();
      expect(discovery.isRunning()).toBe(false);
    });

    it('can restart after stop', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const listener = vi.fn();
      discovery = new TaskDiscovery(defaultConfig());
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);
      expect(listener).toHaveBeenCalledTimes(1);

      await discovery.stop();

      // Clear seen so the same task can be re-discovered
      discovery.clearSeen();

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Monitoring Tests
  // ==========================================================================

  describe('Monitoring', () => {
    it('getDiscoveredCount() is accurate', async () => {
      const taskPda1 = Keypair.generate().publicKey;
      const taskPda2 = Keypair.generate().publicKey;
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { task: createTask(), taskPda: taskPda1 },
        { task: createTask(), taskPda: taskPda2 },
      ]);

      discovery = new TaskDiscovery(defaultConfig());

      expect(discovery.getDiscoveredCount()).toBe(0);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      expect(discovery.getDiscoveredCount()).toBe(2);
    });

    it('clearSeen() resets deduplication', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const listener = vi.fn();
      discovery = new TaskDiscovery(defaultConfig());
      discovery.onTaskDiscovered(listener);

      await discovery.start(COMPUTE);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(discovery.getDiscoveredCount()).toBe(1);

      // Clear seen
      discovery.clearSeen();
      expect(discovery.getDiscoveredCount()).toBe(0);

      // Next poll should rediscover the same task
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(2);
      expect(discovery.getDiscoveredCount()).toBe(1);
    });
  });

  // ==========================================================================
  // Manual Poll Tests
  // ==========================================================================

  describe('Manual poll()', () => {
    it('returns discovered tasks', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      discovery = new TaskDiscovery(defaultConfig());
      const results = await discovery.poll(COMPUTE);

      expect(results.length).toBe(1);
      expect(results[0].pda).toBe(taskPda);
      expect(results[0].source).toBe('poll');
    });

    it('deduplicates with previously seen tasks', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      discovery = new TaskDiscovery(defaultConfig());

      const first = await discovery.poll(COMPUTE);
      expect(first.length).toBe(1);

      const second = await discovery.poll(COMPUTE);
      expect(second.length).toBe(0);
    });

    it('applies filters', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask({ rewardAmount: 500_000n });
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const config = defaultConfig();
      config.filter = { minRewardLamports: 1_000_000n };
      discovery = new TaskDiscovery(config);

      const results = await discovery.poll(COMPUTE);
      expect(results.length).toBe(0);
    });

    it('notifies listeners during manual poll', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { task, taskPda },
      ]);

      const listener = vi.fn();
      discovery = new TaskDiscovery(defaultConfig());
      discovery.onTaskDiscovered(listener);

      await discovery.poll(COMPUTE);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('returns empty on error', async () => {
      (mockOps.fetchClaimableTasks as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network'),
      );

      discovery = new TaskDiscovery(defaultConfig());
      const results = await discovery.poll(COMPUTE);

      expect(results.length).toBe(0);
    });
  });
});
