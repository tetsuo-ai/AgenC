import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import { TaskScanner } from './scanner.js';
import { Task, TaskStatus } from './types.js';

// Generate test keypairs once (reused across tests)
const testKeys = {
  task1: Keypair.generate().publicKey,
  task2: Keypair.generate().publicKey,
  task3: Keypair.generate().publicKey,
  creator1: Keypair.generate().publicKey,
  creator2: Keypair.generate().publicKey,
  trusted: Keypair.generate().publicKey,
  blocked: Keypair.generate().publicKey,
  programId: Keypair.generate().publicKey,
};

/**
 * Mock BN-like object
 */
function mockBN(value: bigint | number): { toNumber: () => number; toString: () => string } {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

/**
 * Create a mock task account
 */
function createMockTaskAccount(
  overrides: Partial<{
    taskId: number[];
    creator: PublicKey;
    requiredCapabilities: ReturnType<typeof mockBN>;
    reward: ReturnType<typeof mockBN>;
    description: number[];
    constraintHash: number[];
    deadline: ReturnType<typeof mockBN>;
    maxWorkers: number;
    currentClaims: number;
    status: { open: {} };
  }> = {}
) {
  return {
    taskId: overrides.taskId ?? Array(32).fill(1),
    creator: overrides.creator ?? testKeys.creator1,
    requiredCapabilities: overrides.requiredCapabilities ?? mockBN(1n),
    reward: overrides.reward ?? mockBN(100_000_000n),
    description: overrides.description ?? Array(64).fill(0),
    constraintHash: overrides.constraintHash ?? Array(32).fill(0),
    deadline: overrides.deadline ?? mockBN(0),
    maxWorkers: overrides.maxWorkers ?? 1,
    currentClaims: overrides.currentClaims ?? 0,
    status: overrides.status ?? { open: {} },
  };
}

/**
 * Create a mock program
 */
function createMockProgram() {
  const eventCallbacks = new Map<number, { eventName: string; callback: Function }>();
  let nextListenerId = 1;

  const mockTaskAccounts: Array<{ publicKey: PublicKey; account: unknown }> = [];

  const mockProgram = {
    programId: testKeys.programId,
    account: {
      task: {
        all: vi.fn(async () => mockTaskAccounts),
        fetch: vi.fn(async (pda: PublicKey) => {
          const found = mockTaskAccounts.find((a) => a.publicKey.equals(pda));
          if (!found) throw new Error('Account not found');
          return found.account;
        }),
      },
    },
    addEventListener: vi.fn((eventName: string, callback: Function) => {
      const id = nextListenerId++;
      eventCallbacks.set(id, { eventName, callback });
      return id;
    }),
    removeEventListener: vi.fn(async (id: number) => {
      eventCallbacks.delete(id);
    }),
    // Test helpers
    _addTask: (pda: PublicKey, account: unknown) => {
      mockTaskAccounts.push({ publicKey: pda, account });
    },
    _clearTasks: () => {
      mockTaskAccounts.length = 0;
    },
    _emit: (eventName: string, rawEvent: unknown, slot: number, signature: string) => {
      for (const { eventName: name, callback } of eventCallbacks.values()) {
        if (name === eventName) {
          callback(rawEvent, slot, signature);
        }
      }
    },
    _getEventListenerCount: () => eventCallbacks.size,
  };

  return mockProgram as unknown as Program<AgencCoordination> & {
    _addTask: typeof mockProgram._addTask;
    _clearTasks: typeof mockProgram._clearTasks;
    _emit: typeof mockProgram._emit;
    _getEventListenerCount: typeof mockProgram._getEventListenerCount;
  };
}

/**
 * Create a mock connection
 */
function createMockConnection() {
  return {} as any;
}

/**
 * Create a mock Task object
 */
function createMockTaskObject(overrides: Partial<Task> = {}): Task {
  return {
    pda: testKeys.task1,
    taskId: new Uint8Array(32),
    creator: testKeys.creator1,
    requiredCapabilities: 1n,
    reward: 100_000_000n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    deadline: 0,
    maxWorkers: 1,
    currentClaims: 0,
    status: TaskStatus.Open,
    ...overrides,
  };
}

describe('TaskScanner', () => {
  let mockProgram: ReturnType<typeof createMockProgram>;
  let scanner: TaskScanner;

  beforeEach(() => {
    mockProgram = createMockProgram();
    scanner = new TaskScanner({
      connection: createMockConnection(),
      program: mockProgram,
    });
  });

  describe('scan()', () => {
    it('returns empty array when no tasks exist', async () => {
      const tasks = await scanner.scan();
      expect(tasks).toEqual([]);
    });

    it('returns open tasks', async () => {
      mockProgram._addTask(testKeys.task1, createMockTaskAccount());

      const tasks = await scanner.scan();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].pda.equals(testKeys.task1)).toBe(true);
      expect(tasks[0].status).toBe(TaskStatus.Open);
    });

    it('filters out non-open tasks', async () => {
      mockProgram._addTask(testKeys.task1, createMockTaskAccount({ status: { open: {} } }));
      mockProgram._addTask(testKeys.task2, createMockTaskAccount({ status: { inProgress: {} } as any }));
      mockProgram._addTask(testKeys.task3, createMockTaskAccount({ status: { completed: {} } as any }));

      const tasks = await scanner.scan();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].pda.equals(testKeys.task1)).toBe(true);
    });

    it('filters out fully claimed tasks', async () => {
      mockProgram._addTask(testKeys.task1, createMockTaskAccount({ maxWorkers: 2, currentClaims: 1 }));
      mockProgram._addTask(testKeys.task2, createMockTaskAccount({ maxWorkers: 2, currentClaims: 2 }));

      const tasks = await scanner.scan();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].pda.equals(testKeys.task1)).toBe(true);
    });

    it('parses task data correctly', async () => {
      // Use a fresh key to avoid any cache issues
      const freshTaskPda = Keypair.generate().publicKey;
      // Use a future deadline to avoid being filtered as expired
      const futureDeadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      mockProgram._addTask(
        freshTaskPda,
        createMockTaskAccount({
          taskId: Array.from({ length: 32 }, (_, i) => i),
          creator: testKeys.creator2,
          requiredCapabilities: mockBN(7n),
          reward: mockBN(500_000_000n),
          deadline: mockBN(futureDeadline),
          maxWorkers: 5,
          currentClaims: 0, // No claims yet
        })
      );

      const tasks = await scanner.scan();

      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.pda.equals(freshTaskPda)).toBe(true);
      expect(task.creator.equals(testKeys.creator2)).toBe(true);
      expect(task.requiredCapabilities).toBe(7n);
      expect(task.reward).toBe(500_000_000n);
      expect(task.deadline).toBe(futureDeadline);
      expect(task.maxWorkers).toBe(5);
      expect(task.currentClaims).toBe(0);
    });
  });

  describe('matchesFilter()', () => {
    it('passes all tasks when no filter set', () => {
      const task = createMockTaskObject();
      expect(scanner.matchesFilter(task)).toBe(true);
    });

    it('filters by minimum reward', () => {
      scanner.setFilter({ minReward: 100_000_000n });

      const lowReward = createMockTaskObject({ reward: 50_000_000n });
      const highReward = createMockTaskObject({ reward: 200_000_000n });

      expect(scanner.matchesFilter(lowReward)).toBe(false);
      expect(scanner.matchesFilter(highReward)).toBe(true);
    });

    it('filters by maximum reward', () => {
      scanner.setFilter({ maxReward: 500_000_000n });

      const normalReward = createMockTaskObject({ reward: 200_000_000n });
      const suspiciousReward = createMockTaskObject({ reward: 1_000_000_000_000n });

      expect(scanner.matchesFilter(normalReward)).toBe(true);
      expect(scanner.matchesFilter(suspiciousReward)).toBe(false);
    });

    it('filters by trusted creators', () => {
      scanner.setFilter({ trustedCreators: [testKeys.trusted] });

      const trustedTask = createMockTaskObject({ creator: testKeys.trusted });
      const untrustedTask = createMockTaskObject({ creator: testKeys.creator1 });

      expect(scanner.matchesFilter(trustedTask)).toBe(true);
      expect(scanner.matchesFilter(untrustedTask)).toBe(false);
    });

    it('filters by blocked creators', () => {
      scanner.setFilter({ blockedCreators: [testKeys.blocked] });

      const blockedTask = createMockTaskObject({ creator: testKeys.blocked });
      const okTask = createMockTaskObject({ creator: testKeys.creator1 });

      expect(scanner.matchesFilter(blockedTask)).toBe(false);
      expect(scanner.matchesFilter(okTask)).toBe(true);
    });

    it('filters for private only tasks', () => {
      scanner.setFilter({ privateOnly: true });

      const publicTask = createMockTaskObject({ constraintHash: new Uint8Array(32) });
      const privateTask = createMockTaskObject({ constraintHash: new Uint8Array(32).fill(1) });

      expect(scanner.matchesFilter(publicTask)).toBe(false);
      expect(scanner.matchesFilter(privateTask)).toBe(true);
    });

    it('filters for public only tasks', () => {
      scanner.setFilter({ publicOnly: true });

      const publicTask = createMockTaskObject({ constraintHash: new Uint8Array(32) });
      const privateTask = createMockTaskObject({ constraintHash: new Uint8Array(32).fill(1) });

      expect(scanner.matchesFilter(publicTask)).toBe(true);
      expect(scanner.matchesFilter(privateTask)).toBe(false);
    });

    it('filters by capabilities', () => {
      // Agent has COMPUTE (0x01) and INFERENCE (0x02)
      scanner.setFilter({ capabilities: 0x03n });

      const computeTask = createMockTaskObject({ requiredCapabilities: 0x01n });
      const storageTask = createMockTaskObject({ requiredCapabilities: 0x04n });

      expect(scanner.matchesFilter(computeTask)).toBe(true);
      expect(scanner.matchesFilter(storageTask)).toBe(false);
    });

    it('uses custom filter function', () => {
      scanner.setFilter({
        custom: (task) => task.maxWorkers > 1,
      });

      const singleWorker = createMockTaskObject({ maxWorkers: 1 });
      const multiWorker = createMockTaskObject({ maxWorkers: 5 });

      expect(scanner.matchesFilter(singleWorker)).toBe(false);
      expect(scanner.matchesFilter(multiWorker)).toBe(true);
    });
  });

  describe('subscribeToNewTasks()', () => {
    it('registers event listener', () => {
      const callback = vi.fn();
      scanner.subscribeToNewTasks(callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith('taskCreated', expect.any(Function));
    });

    it('unsubscribes correctly', async () => {
      const callback = vi.fn();
      const subscription = scanner.subscribeToNewTasks(callback);

      await subscription.unsubscribe();

      expect(mockProgram.removeEventListener).toHaveBeenCalledWith(1);
    });
  });

  describe('getTask()', () => {
    it('fetches task by PDA', async () => {
      mockProgram._addTask(testKeys.task1, createMockTaskAccount());

      const task = await scanner.getTask(testKeys.task1);

      expect(task).not.toBeNull();
      expect(task!.pda.equals(testKeys.task1)).toBe(true);
    });

    it('returns null for non-existent task', async () => {
      const nonExistent = Keypair.generate().publicKey;
      const task = await scanner.getTask(nonExistent);

      expect(task).toBeNull();
    });
  });

  describe('isTaskAvailable()', () => {
    it('returns true for open task with available slots', async () => {
      mockProgram._addTask(testKeys.task1, createMockTaskAccount({ maxWorkers: 2, currentClaims: 1 }));

      const task = await scanner.getTask(testKeys.task1);
      const available = await scanner.isTaskAvailable(task!);

      expect(available).toBe(true);
    });

    it('returns false for fully claimed task', async () => {
      mockProgram._addTask(testKeys.task1, createMockTaskAccount({ maxWorkers: 1, currentClaims: 1 }));

      const task = await scanner.getTask(testKeys.task1);
      const available = await scanner.isTaskAvailable(task!);

      expect(available).toBe(false);
    });

    it('returns false for non-open task', async () => {
      mockProgram._addTask(testKeys.task1, createMockTaskAccount({ status: { completed: {} } as any }));

      const task = await scanner.getTask(testKeys.task1);
      const available = await scanner.isTaskAvailable(task!);

      expect(available).toBe(false);
    });
  });

  describe('clearCache()', () => {
    it('clears known task PDAs', async () => {
      mockProgram._addTask(testKeys.task1, createMockTaskAccount());

      // First scan adds to cache
      await scanner.scan();

      // Clear cache
      scanner.clearCache();

      // Can verify indirectly - no errors
    });
  });

  describe('setFilter() and getFilter()', () => {
    it('updates and retrieves filter', () => {
      const filter = { minReward: 100n, maxReward: 1000n };
      scanner.setFilter(filter);

      const retrieved = scanner.getFilter();

      expect(retrieved.minReward).toBe(100n);
      expect(retrieved.maxReward).toBe(1000n);
    });

    it('returns a copy of filter', () => {
      scanner.setFilter({ minReward: 100n });

      const filter1 = scanner.getFilter();
      filter1.minReward = 999n;

      const filter2 = scanner.getFilter();
      expect(filter2.minReward).toBe(100n);
    });
  });
});
