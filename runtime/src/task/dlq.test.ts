import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { DeadLetterQueue } from './dlq.js';
import { TaskExecutor } from './executor.js';
import type { TaskOperations } from './operations.js';
import type {
  TaskExecutionContext,
  TaskExecutionResult,
  TaskExecutorConfig,
  DeadLetterEntry,
} from './types.js';
import { silentLogger } from '../utils/logger.js';
import {
  createTask,
  createDiscoveryResult,
  createMockOperations,
  createMockDiscovery,
  waitFor,
} from './test-utils.js';

// ============================================================================
// Helpers (match executor.test.ts patterns)
// ============================================================================

function createEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    taskPda: Keypair.generate().publicKey.toBase58(),
    task: createTask(),
    error: 'test error',
    failedAt: Date.now(),
    stage: 'claim',
    attempts: 3,
    retryable: true,
    ...overrides,
  };
}

const agentId = new Uint8Array(32).fill(42);
const agentPda = Keypair.generate().publicKey;

const defaultHandler = async (_ctx: TaskExecutionContext): Promise<TaskExecutionResult> => ({
  proofHash: new Uint8Array(32).fill(1),
});

function createExecutorConfig(overrides: Partial<TaskExecutorConfig> = {}): TaskExecutorConfig {
  return {
    operations: createMockOperations(),
    handler: defaultHandler,
    agentId,
    agentPda,
    logger: silentLogger,
    ...overrides,
  };
}

// ============================================================================
// DeadLetterQueue Unit Tests
// ============================================================================

describe('DeadLetterQueue', () => {
  let dlq: DeadLetterQueue;

  beforeEach(() => {
    dlq = new DeadLetterQueue();
  });

  describe('add()', () => {
    it('adds an entry to the queue', () => {
      const entry = createEntry();
      dlq.add(entry);
      expect(dlq.size()).toBe(1);
    });

    it('preserves insertion order', () => {
      const e1 = createEntry({ error: 'first' });
      const e2 = createEntry({ error: 'second' });
      const e3 = createEntry({ error: 'third' });
      dlq.add(e1);
      dlq.add(e2);
      dlq.add(e3);

      const all = dlq.getAll();
      expect(all[0].error).toBe('first');
      expect(all[1].error).toBe('second');
      expect(all[2].error).toBe('third');
    });
  });

  describe('getAll()', () => {
    it('returns empty array when queue is empty', () => {
      expect(dlq.getAll()).toEqual([]);
    });

    it('returns a copy (not the internal array)', () => {
      dlq.add(createEntry());
      const all = dlq.getAll();
      all.push(createEntry());
      expect(dlq.size()).toBe(1);
    });

    it('returns all entries ordered oldest to newest', () => {
      for (let i = 0; i < 5; i++) {
        dlq.add(createEntry({ error: `error-${i}` }));
      }
      const all = dlq.getAll();
      expect(all).toHaveLength(5);
      expect(all[0].error).toBe('error-0');
      expect(all[4].error).toBe('error-4');
    });
  });

  describe('getByTaskId()', () => {
    it('returns matching entry', () => {
      const entry = createEntry({ taskPda: 'abc123' });
      dlq.add(entry);
      expect(dlq.getByTaskId('abc123')).toBe(entry);
    });

    it('returns undefined for non-existent entry', () => {
      dlq.add(createEntry());
      expect(dlq.getByTaskId('nonexistent')).toBeUndefined();
    });

    it('returns undefined when queue is empty', () => {
      expect(dlq.getByTaskId('anything')).toBeUndefined();
    });
  });

  describe('retry()', () => {
    it('removes and returns entry by taskPda', () => {
      const entry = createEntry({ taskPda: 'abc123' });
      dlq.add(entry);

      const result = dlq.retry('abc123');
      expect(result).toBe(entry);
      expect(dlq.size()).toBe(0);
    });

    it('returns undefined for non-existent entry', () => {
      dlq.add(createEntry());
      expect(dlq.retry('nonexistent')).toBeUndefined();
      expect(dlq.size()).toBe(1);
    });

    it('only removes the matching entry', () => {
      dlq.add(createEntry({ taskPda: 'a' }));
      dlq.add(createEntry({ taskPda: 'b' }));
      dlq.add(createEntry({ taskPda: 'c' }));

      dlq.retry('b');
      expect(dlq.size()).toBe(2);
      expect(dlq.getByTaskId('a')).toBeDefined();
      expect(dlq.getByTaskId('b')).toBeUndefined();
      expect(dlq.getByTaskId('c')).toBeDefined();
    });
  });

  describe('remove()', () => {
    it('removes entry and returns true', () => {
      dlq.add(createEntry({ taskPda: 'abc123' }));
      expect(dlq.remove('abc123')).toBe(true);
      expect(dlq.size()).toBe(0);
    });

    it('returns false for non-existent entry', () => {
      expect(dlq.remove('nonexistent')).toBe(false);
    });
  });

  describe('size()', () => {
    it('returns 0 for empty queue', () => {
      expect(dlq.size()).toBe(0);
    });

    it('tracks additions', () => {
      dlq.add(createEntry());
      dlq.add(createEntry());
      expect(dlq.size()).toBe(2);
    });

    it('tracks removals', () => {
      dlq.add(createEntry({ taskPda: 'a' }));
      dlq.add(createEntry({ taskPda: 'b' }));
      dlq.remove('a');
      expect(dlq.size()).toBe(1);
    });
  });

  describe('clear()', () => {
    it('removes all entries', () => {
      for (let i = 0; i < 10; i++) {
        dlq.add(createEntry());
      }
      dlq.clear();
      expect(dlq.size()).toBe(0);
      expect(dlq.getAll()).toEqual([]);
    });
  });

  describe('maxSize eviction (FIFO)', () => {
    it('evicts oldest entry when at capacity', () => {
      const small = new DeadLetterQueue({ maxSize: 3 });
      small.add(createEntry({ error: 'e1' }));
      small.add(createEntry({ error: 'e2' }));
      small.add(createEntry({ error: 'e3' }));
      expect(small.size()).toBe(3);

      small.add(createEntry({ error: 'e4' }));
      expect(small.size()).toBe(3);

      const all = small.getAll();
      expect(all[0].error).toBe('e2');
      expect(all[1].error).toBe('e3');
      expect(all[2].error).toBe('e4');
    });

    it('evicts multiple oldest entries as needed', () => {
      const small = new DeadLetterQueue({ maxSize: 2 });
      small.add(createEntry({ error: 'e1' }));
      small.add(createEntry({ error: 'e2' }));
      small.add(createEntry({ error: 'e3' }));
      small.add(createEntry({ error: 'e4' }));

      expect(small.size()).toBe(2);
      const all = small.getAll();
      expect(all[0].error).toBe('e3');
      expect(all[1].error).toBe('e4');
    });

    it('defaults to maxSize 1000', () => {
      const defaultDlq = new DeadLetterQueue();
      for (let i = 0; i < 1001; i++) {
        defaultDlq.add(createEntry({ error: `e-${i}` }));
      }
      expect(defaultDlq.size()).toBe(1000);
      // Oldest (e-0) should have been evicted
      const all = defaultDlq.getAll();
      expect(all[0].error).toBe('e-1');
      expect(all[999].error).toBe('e-1000');
    });

    it('respects custom maxSize', () => {
      const custom = new DeadLetterQueue({ maxSize: 5 });
      for (let i = 0; i < 10; i++) {
        custom.add(createEntry({ error: `e-${i}` }));
      }
      expect(custom.size()).toBe(5);
      const all = custom.getAll();
      expect(all[0].error).toBe('e-5');
      expect(all[4].error).toBe('e-9');
    });
  });
});

// ============================================================================
// Executor DLQ Integration Tests
// ============================================================================

describe('TaskExecutor DLQ integration', () => {
  it('exposes DLQ via getDeadLetterQueue()', () => {
    const config = createExecutorConfig({ mode: 'batch' });
    const executor = new TaskExecutor(config);
    const dlq = executor.getDeadLetterQueue();

    expect(dlq).toBeInstanceOf(DeadLetterQueue);
    expect(dlq.size()).toBe(0);
  });

  it('sends handler failure to DLQ', async () => {
    const mockOps = createMockOperations();
    const mockDiscovery = createMockDiscovery();
    const onDeadLettered = vi.fn();

    const handler = async (): Promise<TaskExecutionResult> => {
      throw new Error('handler crash');
    };

    const config = createExecutorConfig({
      mode: 'autonomous',
      operations: mockOps,
      discovery: mockDiscovery,
      handler,
    });
    const executor = new TaskExecutor(config);
    executor.on({ onDeadLettered });

    const startPromise = executor.start();
    await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

    const task = createDiscoveryResult();
    mockDiscovery._emitTask(task);

    await waitFor(() => executor.getStatus().tasksFailed >= 1, 3000);
    // Allow DLQ write to settle
    await new Promise((r) => setTimeout(r, 50));

    const dlq = executor.getDeadLetterQueue();
    expect(dlq.size()).toBe(1);

    const entry = dlq.getAll()[0];
    expect(entry.taskPda).toBe(task.pda.toBase58());
    expect(entry.error).toBe('handler crash');
    expect(entry.stage).toBe('execute');
    expect(entry.attempts).toBe(1);
    expect(entry.retryable).toBe(false);
    expect(entry.failedAt).toBeGreaterThan(0);

    // onDeadLettered callback fired
    expect(onDeadLettered).toHaveBeenCalledTimes(1);
    expect(onDeadLettered.mock.calls[0][0].taskPda).toBe(task.pda.toBase58());

    await executor.stop();
    await startPromise;
  });

  it('sends claim retry exhaustion to DLQ with stage=claim', async () => {
    const mockOps = createMockOperations();
    const mockDiscovery = createMockDiscovery();
    const onDeadLettered = vi.fn();

    mockOps.claimTask.mockRejectedValue(new Error('persistent RPC failure'));

    const config = createExecutorConfig({
      mode: 'autonomous',
      operations: mockOps,
      discovery: mockDiscovery,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
    });
    const executor = new TaskExecutor(config);
    executor.on({ onDeadLettered });

    const startPromise = executor.start();
    await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

    const task = createDiscoveryResult();
    mockDiscovery._emitTask(task);

    await waitFor(() => mockOps.claimTask.mock.calls.length >= 2, 5000);
    await new Promise((r) => setTimeout(r, 100));

    const dlq = executor.getDeadLetterQueue();
    expect(dlq.size()).toBe(1);

    const entry = dlq.getAll()[0];
    expect(entry.stage).toBe('claim');
    expect(entry.attempts).toBe(2);
    expect(entry.retryable).toBe(true);

    expect(onDeadLettered).toHaveBeenCalledTimes(1);

    await executor.stop();
    await startPromise;
  });

  it('sends submit retry exhaustion to DLQ with stage=submit', async () => {
    const mockOps = createMockOperations();
    const mockDiscovery = createMockDiscovery();
    const onDeadLettered = vi.fn();

    mockOps.completeTask.mockRejectedValue(new Error('persistent submit failure'));

    const config = createExecutorConfig({
      mode: 'autonomous',
      operations: mockOps,
      discovery: mockDiscovery,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
    });
    const executor = new TaskExecutor(config);
    executor.on({ onDeadLettered });

    const startPromise = executor.start();
    await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

    const task = createDiscoveryResult();
    mockDiscovery._emitTask(task);

    await waitFor(() => mockOps.completeTask.mock.calls.length >= 2, 5000);
    await new Promise((r) => setTimeout(r, 100));

    const dlq = executor.getDeadLetterQueue();
    expect(dlq.size()).toBe(1);

    const entry = dlq.getAll()[0];
    expect(entry.stage).toBe('submit');
    expect(entry.attempts).toBe(2);
    expect(entry.retryable).toBe(true);

    expect(onDeadLettered).toHaveBeenCalledTimes(1);

    await executor.stop();
    await startPromise;
  });

  it('sends timeout failure to DLQ with stage=execute', async () => {
    const mockOps = createMockOperations();
    const mockDiscovery = createMockDiscovery();
    const onDeadLettered = vi.fn();

    const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
      await new Promise<void>((_, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return { proofHash: new Uint8Array(32).fill(1) };
    };

    const config = createExecutorConfig({
      mode: 'autonomous',
      operations: mockOps,
      discovery: mockDiscovery,
      handler,
      taskTimeoutMs: 50,
    });
    const executor = new TaskExecutor(config);
    executor.on({ onDeadLettered });

    const startPromise = executor.start();
    await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

    mockDiscovery._emitTask(createDiscoveryResult());
    await waitFor(() => executor.getStatus().tasksFailed >= 1, 3000);
    await new Promise((r) => setTimeout(r, 50));

    const dlq = executor.getDeadLetterQueue();
    expect(dlq.size()).toBe(1);

    const entry = dlq.getAll()[0];
    expect(entry.stage).toBe('execute');
    expect(entry.error).toContain('timed out');

    expect(onDeadLettered).toHaveBeenCalledTimes(1);

    await executor.stop();
    await startPromise;
  });

  it('does not send to DLQ on graceful shutdown abort', async () => {
    const mockOps = createMockOperations();
    const mockDiscovery = createMockDiscovery();
    const onDeadLettered = vi.fn();
    let handlerResolve: (() => void) | null = null;

    const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
      await new Promise<void>((resolve, reject) => {
        handlerResolve = resolve;
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return { proofHash: new Uint8Array(32).fill(1) };
    };

    const config = createExecutorConfig({
      mode: 'autonomous',
      operations: mockOps,
      discovery: mockDiscovery,
      handler,
      taskTimeoutMs: 0,
    });
    const executor = new TaskExecutor(config);
    executor.on({ onDeadLettered });

    const startPromise = executor.start();
    await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

    mockDiscovery._emitTask(createDiscoveryResult());
    await waitFor(() => handlerResolve !== null);

    // Stop executor (graceful shutdown aborts signal)
    await executor.stop();
    await startPromise;

    // DLQ should be empty — graceful shutdown is not a failure
    expect(executor.getDeadLetterQueue().size()).toBe(0);
    expect(onDeadLettered).not.toHaveBeenCalled();
  });

  it('respects deadLetterQueue.maxSize config', () => {
    const config = createExecutorConfig({
      mode: 'batch',
      deadLetterQueue: { maxSize: 5 },
    });
    const executor = new TaskExecutor(config);
    const dlq = executor.getDeadLetterQueue();

    // Manually verify by adding entries directly — we access DLQ through public API
    for (let i = 0; i < 10; i++) {
      dlq.add(createEntry({ error: `e-${i}` }));
    }
    expect(dlq.size()).toBe(5);
    expect(dlq.getAll()[0].error).toBe('e-5');
  });

  it('accumulates multiple failures in DLQ', async () => {
    const mockOps = createMockOperations();
    const mockDiscovery = createMockDiscovery();
    const onDeadLettered = vi.fn();

    const handler = async (): Promise<TaskExecutionResult> => {
      throw new Error('handler crash');
    };

    const config = createExecutorConfig({
      mode: 'autonomous',
      operations: mockOps,
      discovery: mockDiscovery,
      handler,
      maxConcurrentTasks: 3,
    });
    const executor = new TaskExecutor(config);
    executor.on({ onDeadLettered });

    const startPromise = executor.start();
    await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

    // Emit 3 tasks that will all fail
    mockDiscovery._emitTask(createDiscoveryResult());
    mockDiscovery._emitTask(createDiscoveryResult());
    mockDiscovery._emitTask(createDiscoveryResult());

    await waitFor(() => executor.getStatus().tasksFailed >= 3, 5000);
    await new Promise((r) => setTimeout(r, 50));

    expect(executor.getDeadLetterQueue().size()).toBe(3);
    expect(onDeadLettered).toHaveBeenCalledTimes(3);

    await executor.stop();
    await startPromise;
  });

  it('includes errorCode from RuntimeError in DLQ entry', async () => {
    const mockOps = createMockOperations();
    const mockDiscovery = createMockDiscovery();

    // Create an error with a code property
    const codedError = new Error('handler failed');
    (codedError as Record<string, unknown>).code = 'TASK_EXECUTION_FAILED';

    const handler = async (): Promise<TaskExecutionResult> => {
      throw codedError;
    };

    const config = createExecutorConfig({
      mode: 'autonomous',
      operations: mockOps,
      discovery: mockDiscovery,
      handler,
    });
    const executor = new TaskExecutor(config);

    const startPromise = executor.start();
    await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

    mockDiscovery._emitTask(createDiscoveryResult());
    await waitFor(() => executor.getStatus().tasksFailed >= 1, 3000);
    await new Promise((r) => setTimeout(r, 50));

    const entry = executor.getDeadLetterQueue().getAll()[0];
    expect(entry.errorCode).toBe('TASK_EXECUTION_FAILED');

    await executor.stop();
    await startPromise;
  });

  it('DLQ entry includes task context from discovery result', async () => {
    const mockOps = createMockOperations();
    const mockDiscovery = createMockDiscovery();

    const handler = async (): Promise<TaskExecutionResult> => {
      throw new Error('fail');
    };

    const config = createExecutorConfig({
      mode: 'autonomous',
      operations: mockOps,
      discovery: mockDiscovery,
      handler,
    });
    const executor = new TaskExecutor(config);

    const startPromise = executor.start();
    await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

    const task = createDiscoveryResult();
    mockDiscovery._emitTask(task);
    await waitFor(() => executor.getStatus().tasksFailed >= 1, 3000);
    await new Promise((r) => setTimeout(r, 50));

    const entry = executor.getDeadLetterQueue().getAll()[0];
    expect(entry.task).toBe(task.task);
    expect(entry.taskPda).toBe(task.pda.toBase58());

    await executor.stop();
    await startPromise;
  });
});
