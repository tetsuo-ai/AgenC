import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { TaskExecutor } from './executor.js';
import type {
  TaskExecutionContext,
  TaskExecutionResult,
  TaskExecutorConfig,
  MetricsProvider,
  TracingProvider,
  Span,
} from './types.js';
import { silentLogger } from '../utils/logger.js';
import {
  DefaultMetricsCollector,
  NoopMetrics,
  NoopTracing,
  NoopSpan,
  METRIC_NAMES,
} from './metrics.js';
import type { MetricsSnapshot } from './metrics.js';
import {
  createTask,
  createDiscoveryResult,
  createMockOperations,
  createMockDiscovery,
  waitFor,
} from './test-utils.js';

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
// DefaultMetricsCollector Tests
// ============================================================================

describe('DefaultMetricsCollector', () => {
  let collector: DefaultMetricsCollector;

  beforeEach(() => {
    collector = new DefaultMetricsCollector();
  });

  describe('counter()', () => {
    it('should increment by 1 by default', () => {
      collector.counter('test.count');
      collector.counter('test.count');
      collector.counter('test.count');
      const snapshot = collector.getSnapshot();
      expect(snapshot.counters['test.count']).toBe(3);
    });

    it('should increment by custom value', () => {
      collector.counter('test.count', 5);
      collector.counter('test.count', 3);
      const snapshot = collector.getSnapshot();
      expect(snapshot.counters['test.count']).toBe(8);
    });

    it('should support multiple counter names', () => {
      collector.counter('a');
      collector.counter('b', 2);
      const snapshot = collector.getSnapshot();
      expect(snapshot.counters['a']).toBe(1);
      expect(snapshot.counters['b']).toBe(2);
    });
  });

  describe('histogram()', () => {
    it('should record histogram values', () => {
      collector.histogram('latency', 42);
      collector.histogram('latency', 58);
      collector.histogram('latency', 100);
      const snapshot = collector.getSnapshot();
      expect(snapshot.histograms['latency']).toHaveLength(3);
      expect(snapshot.histograms['latency'][0].value).toBe(42);
      expect(snapshot.histograms['latency'][1].value).toBe(58);
      expect(snapshot.histograms['latency'][2].value).toBe(100);
    });

    it('should record timestamps on entries', () => {
      const before = Date.now();
      collector.histogram('latency', 10);
      const after = Date.now();
      const snapshot = collector.getSnapshot();
      const entry = snapshot.histograms['latency'][0];
      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(after);
    });

    it('should store labels on histogram entries', () => {
      collector.histogram('latency', 50, { taskPda: 'abc123' });
      const snapshot = collector.getSnapshot();
      expect(snapshot.histograms['latency'][0].labels).toEqual({ taskPda: 'abc123' });
    });
  });

  describe('gauge()', () => {
    it('should set gauge value', () => {
      collector.gauge('queue.size', 10);
      const snapshot = collector.getSnapshot();
      expect(snapshot.gauges['queue.size']).toBe(10);
    });

    it('should overwrite gauge value', () => {
      collector.gauge('queue.size', 10);
      collector.gauge('queue.size', 5);
      collector.gauge('queue.size', 0);
      const snapshot = collector.getSnapshot();
      expect(snapshot.gauges['queue.size']).toBe(0);
    });
  });

  describe('recordTaskDuration()', () => {
    it('should record duration in agenc.task.<stage>.duration_ms histogram', () => {
      collector.recordTaskDuration('claim', 42);
      collector.recordTaskDuration('execute', 150);
      collector.recordTaskDuration('submit', 88);
      const snapshot = collector.getSnapshot();
      expect(snapshot.histograms['agenc.task.claim.duration_ms']).toHaveLength(1);
      expect(snapshot.histograms['agenc.task.claim.duration_ms'][0].value).toBe(42);
      expect(snapshot.histograms['agenc.task.execute.duration_ms'][0].value).toBe(150);
      expect(snapshot.histograms['agenc.task.submit.duration_ms'][0].value).toBe(88);
    });
  });

  describe('incrementCounter()', () => {
    it('should increment counter via incrementCounter alias', () => {
      collector.incrementCounter('x');
      collector.incrementCounter('x', 4);
      const snapshot = collector.getSnapshot();
      expect(snapshot.counters['x']).toBe(5);
    });
  });

  describe('recordHistogram()', () => {
    it('should record histogram via recordHistogram alias', () => {
      collector.recordHistogram('y', 99);
      const snapshot = collector.getSnapshot();
      expect(snapshot.histograms['y']).toHaveLength(1);
      expect(snapshot.histograms['y'][0].value).toBe(99);
    });
  });

  describe('getSnapshot()', () => {
    it('should return a point-in-time snapshot with timestamp', () => {
      const before = Date.now();
      const snapshot = collector.getSnapshot();
      const after = Date.now();
      expect(snapshot.timestamp).toBeGreaterThanOrEqual(before);
      expect(snapshot.timestamp).toBeLessThanOrEqual(after);
    });

    it('should return empty collections when no data recorded', () => {
      const snapshot = collector.getSnapshot();
      expect(snapshot.counters).toEqual({});
      expect(snapshot.gauges).toEqual({});
      expect(snapshot.histograms).toEqual({});
    });

    it('should return copies (not references) of internal data', () => {
      collector.counter('c', 1);
      collector.gauge('g', 10);
      collector.histogram('h', 5);
      const snap1 = collector.getSnapshot();

      // Mutate snapshot
      snap1.counters['c'] = 999;
      snap1.gauges['g'] = 999;
      snap1.histograms['h'].push({ value: 999, timestamp: 0 });

      // Verify collector is unchanged
      const snap2 = collector.getSnapshot();
      expect(snap2.counters['c']).toBe(1);
      expect(snap2.gauges['g']).toBe(10);
      expect(snap2.histograms['h']).toHaveLength(1);
    });
  });
});

// ============================================================================
// NoopMetrics Tests
// ============================================================================

describe('NoopMetrics', () => {
  it('should not throw on any method call', () => {
    const noop = new NoopMetrics();
    expect(() => noop.counter('test')).not.toThrow();
    expect(() => noop.counter('test', 5, { label: 'value' })).not.toThrow();
    expect(() => noop.histogram('test', 10)).not.toThrow();
    expect(() => noop.histogram('test', 10, { label: 'value' })).not.toThrow();
    expect(() => noop.gauge('test', 5)).not.toThrow();
    expect(() => noop.gauge('test', 5, { label: 'value' })).not.toThrow();
  });
});

// ============================================================================
// NoopTracing / NoopSpan Tests
// ============================================================================

describe('NoopTracing', () => {
  it('should return a NoopSpan', () => {
    const noop = new NoopTracing();
    const span = noop.startSpan('test');
    expect(span).toBeInstanceOf(NoopSpan);
  });

  it('should return a span that does not throw on any method', () => {
    const noop = new NoopTracing();
    const span = noop.startSpan('test', { key: 'value' });
    expect(() => span.setAttribute('k', 'v')).not.toThrow();
    expect(() => span.setAttribute('k', 42)).not.toThrow();
    expect(() => span.setStatus('ok')).not.toThrow();
    expect(() => span.setStatus('error', 'msg')).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });
});

// ============================================================================
// METRIC_NAMES Constants Tests
// ============================================================================

describe('METRIC_NAMES', () => {
  it('should have agenc.task.* prefix on all names', () => {
    for (const value of Object.values(METRIC_NAMES)) {
      expect(value).toMatch(/^agenc\.task\./);
    }
  });

  it('should include all expected metric names', () => {
    expect(METRIC_NAMES.CLAIM_DURATION).toBe('agenc.task.claim.duration_ms');
    expect(METRIC_NAMES.EXECUTE_DURATION).toBe('agenc.task.execute.duration_ms');
    expect(METRIC_NAMES.SUBMIT_DURATION).toBe('agenc.task.submit.duration_ms');
    expect(METRIC_NAMES.PIPELINE_DURATION).toBe('agenc.task.pipeline.duration_ms');
    expect(METRIC_NAMES.QUEUE_SIZE).toBe('agenc.task.queue.size');
    expect(METRIC_NAMES.ACTIVE_COUNT).toBe('agenc.task.active.count');
    expect(METRIC_NAMES.TASKS_DISCOVERED).toBe('agenc.task.discovered.count');
    expect(METRIC_NAMES.TASKS_CLAIMED).toBe('agenc.task.claimed.count');
    expect(METRIC_NAMES.TASKS_COMPLETED).toBe('agenc.task.completed.count');
    expect(METRIC_NAMES.TASKS_FAILED).toBe('agenc.task.failed.count');
    expect(METRIC_NAMES.CLAIMS_FAILED).toBe('agenc.task.claims_failed.count');
    expect(METRIC_NAMES.SUBMITS_FAILED).toBe('agenc.task.submits_failed.count');
    expect(METRIC_NAMES.CLAIMS_EXPIRED).toBe('agenc.task.claims_expired.count');
    expect(METRIC_NAMES.CLAIM_RETRIES).toBe('agenc.task.claim_retries.count');
    expect(METRIC_NAMES.SUBMIT_RETRIES).toBe('agenc.task.submit_retries.count');
  });
});

// ============================================================================
// TaskExecutor Pipeline Metrics Integration Tests
// ============================================================================

describe('TaskExecutor metrics integration', () => {
  let executor: TaskExecutor;
  let discovery: ReturnType<typeof createMockDiscovery>;
  let operations: ReturnType<typeof createMockOperations>;
  let metricsCollector: DefaultMetricsCollector;

  beforeEach(() => {
    operations = createMockOperations();
    discovery = createMockDiscovery();
    metricsCollector = new DefaultMetricsCollector();
  });

  afterEach(async () => {
    if (executor?.isRunning()) {
      await executor.stop();
    }
  });

  it('should record pipeline stage durations on successful task', async () => {
    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      metrics: metricsCollector,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => operations.completeTask.mock.calls.length > 0);
    await executor.stop();
    await startPromise.catch(() => {});

    const snapshot = metricsCollector.getSnapshot();

    // Verify stage durations were recorded
    expect(snapshot.histograms[METRIC_NAMES.CLAIM_DURATION]).toBeDefined();
    expect(snapshot.histograms[METRIC_NAMES.CLAIM_DURATION].length).toBeGreaterThanOrEqual(1);

    expect(snapshot.histograms[METRIC_NAMES.EXECUTE_DURATION]).toBeDefined();
    expect(snapshot.histograms[METRIC_NAMES.EXECUTE_DURATION].length).toBeGreaterThanOrEqual(1);

    expect(snapshot.histograms[METRIC_NAMES.SUBMIT_DURATION]).toBeDefined();
    expect(snapshot.histograms[METRIC_NAMES.SUBMIT_DURATION].length).toBeGreaterThanOrEqual(1);

    expect(snapshot.histograms[METRIC_NAMES.PIPELINE_DURATION]).toBeDefined();
    expect(snapshot.histograms[METRIC_NAMES.PIPELINE_DURATION].length).toBeGreaterThanOrEqual(1);
  });

  it('should emit counter metrics for discovered/claimed/completed', async () => {
    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      metrics: metricsCollector,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => operations.completeTask.mock.calls.length > 0);
    await executor.stop();
    await startPromise.catch(() => {});

    const snapshot = metricsCollector.getSnapshot();
    expect(snapshot.counters[METRIC_NAMES.TASKS_DISCOVERED]).toBe(1);
    expect(snapshot.counters[METRIC_NAMES.TASKS_CLAIMED]).toBe(1);
    expect(snapshot.counters[METRIC_NAMES.TASKS_COMPLETED]).toBe(1);
  });

  it('should emit failure counter on handler error', async () => {
    const failHandler = async (_ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
      throw new Error('handler exploded');
    };

    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      handler: failHandler,
      metrics: metricsCollector,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => {
      const s = metricsCollector.getSnapshot();
      return (s.counters[METRIC_NAMES.TASKS_FAILED] ?? 0) >= 1;
    });
    await executor.stop();
    await startPromise.catch(() => {});

    const snapshot = metricsCollector.getSnapshot();
    expect(snapshot.counters[METRIC_NAMES.TASKS_FAILED]).toBeGreaterThanOrEqual(1);
  });

  it('should update queue size and active count gauges', async () => {
    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      metrics: metricsCollector,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => operations.completeTask.mock.calls.length > 0);
    await executor.stop();
    await startPromise.catch(() => {});

    const snapshot = metricsCollector.getSnapshot();
    // After completion, active count should be 0
    expect(snapshot.gauges[METRIC_NAMES.ACTIVE_COUNT]).toBe(0);
    expect(snapshot.gauges[METRIC_NAMES.QUEUE_SIZE]).toBeDefined();
  });

  it('should call tracing provider with span lifecycle', async () => {
    const setAttributeCalls: Array<{ key: string; value: string | number }> = [];
    const setStatusCalls: Array<{ status: string; message?: string }> = [];
    let spanEnded = false;

    const mockSpan: Span = {
      setAttribute(key: string, value: string | number) {
        setAttributeCalls.push({ key, value });
      },
      setStatus(status: 'ok' | 'error', message?: string) {
        setStatusCalls.push({ status, message });
      },
      end() {
        spanEnded = true;
      },
    };

    const mockTracing: TracingProvider = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };

    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      tracing: mockTracing,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => operations.completeTask.mock.calls.length > 0);
    await executor.stop();
    await startPromise.catch(() => {});

    // Verify span was created with correct name
    expect(mockTracing.startSpan).toHaveBeenCalledWith(
      'agenc.task.pipeline',
      expect.objectContaining({ taskPda: expect.any(String) }),
    );

    // Verify attributes were set for stage durations
    const attrKeys = setAttributeCalls.map(c => c.key);
    expect(attrKeys).toContain('claim.duration_ms');
    expect(attrKeys).toContain('execute.duration_ms');
    expect(attrKeys).toContain('submit.duration_ms');

    // Verify span status was set to ok
    expect(setStatusCalls).toContainEqual({ status: 'ok' });

    // Verify span was ended
    expect(spanEnded).toBe(true);
  });

  it('should set span error status on failure', async () => {
    const setStatusCalls: Array<{ status: string; message?: string }> = [];
    let spanEnded = false;

    const mockSpan: Span = {
      setAttribute() {},
      setStatus(status: 'ok' | 'error', message?: string) {
        setStatusCalls.push({ status, message });
      },
      end() {
        spanEnded = true;
      },
    };

    const mockTracing: TracingProvider = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };

    const failHandler = async (_ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
      throw new Error('boom');
    };

    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      handler: failHandler,
      tracing: mockTracing,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => spanEnded);
    await executor.stop();
    await startPromise.catch(() => {});

    expect(setStatusCalls.some(c => c.status === 'error')).toBe(true);
    expect(spanEnded).toBe(true);
  });

  it('should return metrics snapshot via getMetricsSnapshot()', async () => {
    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      metrics: metricsCollector,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => operations.completeTask.mock.calls.length > 0);
    await executor.stop();
    await startPromise.catch(() => {});

    const snapshot = executor.getMetricsSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.counters[METRIC_NAMES.TASKS_COMPLETED]).toBe(1);
    expect(snapshot!.histograms[METRIC_NAMES.PIPELINE_DURATION]).toBeDefined();
    expect(snapshot!.timestamp).toBeGreaterThan(0);
  });

  it('should return null from getMetricsSnapshot() when using NoopMetrics', () => {
    executor = new TaskExecutor(createExecutorConfig({
      mode: 'batch',
      batchTasks: [],
    }));

    const snapshot = executor.getMetricsSnapshot();
    expect(snapshot).toBeNull();
  });

  it('should work with custom MetricsProvider implementation', async () => {
    const counterCalls: Array<{ name: string; value?: number }> = [];
    const histogramCalls: Array<{ name: string; value: number }> = [];
    const gaugeCalls: Array<{ name: string; value: number }> = [];

    const customProvider: MetricsProvider = {
      counter(name, value) { counterCalls.push({ name, value }); },
      histogram(name, value) { histogramCalls.push({ name, value }); },
      gauge(name, value) { gaugeCalls.push({ name, value }); },
    };

    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      metrics: customProvider,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => operations.completeTask.mock.calls.length > 0);
    await executor.stop();
    await startPromise.catch(() => {});

    // Verify custom provider was called
    expect(counterCalls.length).toBeGreaterThan(0);
    expect(histogramCalls.length).toBeGreaterThan(0);
    expect(gaugeCalls.length).toBeGreaterThan(0);

    // Verify OpenTelemetry-compatible naming
    const counterNames = counterCalls.map(c => c.name);
    expect(counterNames).toContain(METRIC_NAMES.TASKS_DISCOVERED);
    expect(counterNames).toContain(METRIC_NAMES.TASKS_CLAIMED);
    expect(counterNames).toContain(METRIC_NAMES.TASKS_COMPLETED);

    const histogramNames = histogramCalls.map(h => h.name);
    expect(histogramNames).toContain(METRIC_NAMES.CLAIM_DURATION);
    expect(histogramNames).toContain(METRIC_NAMES.EXECUTE_DURATION);
    expect(histogramNames).toContain(METRIC_NAMES.SUBMIT_DURATION);
    expect(histogramNames).toContain(METRIC_NAMES.PIPELINE_DURATION);
  });

  it('should record submit failure counter on submit error', async () => {
    operations.completeTask.mockRejectedValue(new Error('submit failed'));

    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      metrics: metricsCollector,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
      retryPolicy: { maxAttempts: 1 },
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => {
      const s = metricsCollector.getSnapshot();
      return (s.counters[METRIC_NAMES.SUBMITS_FAILED] ?? 0) >= 1;
    });
    await executor.stop();
    await startPromise.catch(() => {});

    const snapshot = metricsCollector.getSnapshot();
    expect(snapshot.counters[METRIC_NAMES.SUBMITS_FAILED]).toBeGreaterThanOrEqual(1);
  });

  it('should record claim failure counter on claim error', async () => {
    operations.claimTask.mockRejectedValue(new Error('claim failed'));

    executor = new TaskExecutor(createExecutorConfig({
      operations,
      discovery,
      mode: 'autonomous',
      metrics: metricsCollector,
      taskTimeoutMs: 0,
      claimExpiryBufferMs: 0,
      retryPolicy: { maxAttempts: 1 },
    }));

    const startPromise = executor.start();
    await waitFor(() => discovery.start.mock.calls.length > 0);
    const task = createDiscoveryResult();
    discovery._emitTask(task);

    await waitFor(() => {
      const s = metricsCollector.getSnapshot();
      return (s.counters[METRIC_NAMES.CLAIMS_FAILED] ?? 0) >= 1;
    });
    await executor.stop();
    await startPromise.catch(() => {});

    const snapshot = metricsCollector.getSnapshot();
    expect(snapshot.counters[METRIC_NAMES.CLAIMS_FAILED]).toBeGreaterThanOrEqual(1);
  });
});
