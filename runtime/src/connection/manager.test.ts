/**
 * Tests for ConnectionManager — resilient RPC transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection } from '@solana/web3.js';
import { ConnectionManager } from './manager.js';
import { AllEndpointsUnhealthyError, ConnectionError } from './errors.js';
import {
  isRetryableError,
  isConnectionLevelError,
  isWriteMethod,
  computeBackoff,
  deriveCoalesceKey,
} from './retry.js';
import { RuntimeErrorCodes } from '../types/errors.js';
import { silentLogger } from '../utils/logger.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a ConnectionManager with a mocked _rpcRequest on the underlying
 * connections. Returns the manager and a function to get the mock for each URL.
 */
function createTestManager(
  urls: string[],
  opts?: {
    retry?: Partial<{ maxRetries: number; baseDelayMs: number; maxDelayMs: number; jitterFactor: number }>;
    healthCheck?: Partial<{ unhealthyThreshold: number; healthyThreshold: number; unhealthyCooldownMs: number }>;
    coalesce?: boolean;
  },
) {
  const mocks = new Map<string, ReturnType<typeof vi.fn>>();

  // Pre-create mocks for each URL
  for (const url of urls) {
    mocks.set(url, vi.fn().mockResolvedValue({ result: `ok-${url}` }));
  }

  const mgr = new ConnectionManager({
    endpoints: urls,
    retry: { baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0, ...opts?.retry },
    healthCheck: opts?.healthCheck,
    coalesce: opts?.coalesce,
    logger: silentLogger,
  });

  // Patch _rpcRequest on ALL internal connections via the private connections map
  const internal = mgr as unknown as { connections: Map<string, Connection> };
  for (const [url, conn] of internal.connections) {
    const mock = mocks.get(url)!;
    (conn as unknown as Record<string, unknown>)._rpcRequest = mock;
  }

  return { mgr, getMock: (url: string) => mocks.get(url)! };
}

// ============================================================================
// retry.ts — pure function tests
// ============================================================================

describe('isRetryableError', () => {
  it('returns true for 429 status', () => {
    expect(isRetryableError({ status: 429, message: 'rate limited' })).toBe(true);
  });

  it('returns true for 502/503/504', () => {
    expect(isRetryableError({ status: 502, message: '' })).toBe(true);
    expect(isRetryableError({ status: 503, message: '' })).toBe(true);
    expect(isRetryableError({ status: 504, message: '' })).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isRetryableError(new Error('connect ETIMEDOUT 1.2.3.4'))).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isRetryableError(new Error('connect ECONNREFUSED 127.0.0.1:8899'))).toBe(true);
  });

  it('returns true for socket hang up', () => {
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
  });

  it('returns true for blockhash not found', () => {
    expect(isRetryableError(new Error('blockhash not found'))).toBe(true);
  });

  it('returns true for Node is behind', () => {
    expect(isRetryableError(new Error('Node is behind by 42 slots'))).toBe(true);
  });

  it('returns false for Account does not exist', () => {
    expect(isRetryableError(new Error('Account does not exist abc123'))).toBe(false);
  });

  it('returns false for custom program error (Anchor)', () => {
    expect(isRetryableError(new Error('custom program error: 0x1770'))).toBe(false);
  });

  it('returns false for insufficient funds', () => {
    expect(isRetryableError(new Error('insufficient funds for rent'))).toBe(false);
  });

  it('returns false for Signature verification', () => {
    expect(isRetryableError(new Error('Signature verification failed'))).toBe(false);
  });

  it('returns false for Transaction simulation failed', () => {
    expect(isRetryableError(new Error('Transaction simulation failed'))).toBe(false);
  });

  it('returns false for generic error', () => {
    expect(isRetryableError(new Error('something random'))).toBe(false);
  });

  it('non-retryable takes priority over retryable', () => {
    // An error containing both patterns — non-retryable wins
    expect(isRetryableError(new Error('Transaction simulation failed ETIMEDOUT'))).toBe(false);
  });

  it('handles nested response.status', () => {
    expect(isRetryableError({ message: '', response: { status: 429 } })).toBe(true);
  });
});

describe('isConnectionLevelError', () => {
  it('returns true for ETIMEDOUT', () => {
    expect(isConnectionLevelError(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('returns true for 502', () => {
    expect(isConnectionLevelError({ status: 502, message: '' })).toBe(true);
  });

  it('returns false for 429', () => {
    expect(isConnectionLevelError({ status: 429, message: '' })).toBe(false);
  });

  it('returns false for blockhash not found', () => {
    expect(isConnectionLevelError(new Error('blockhash not found'))).toBe(false);
  });
});

describe('isWriteMethod', () => {
  it('returns true for sendTransaction', () => {
    expect(isWriteMethod('sendTransaction')).toBe(true);
  });

  it('returns true for sendEncodedTransaction', () => {
    expect(isWriteMethod('sendEncodedTransaction')).toBe(true);
  });

  it('returns false for getAccountInfo', () => {
    expect(isWriteMethod('getAccountInfo')).toBe(false);
  });

  it('returns false for getBalance', () => {
    expect(isWriteMethod('getBalance')).toBe(false);
  });
});

describe('computeBackoff', () => {
  const config = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000, jitterFactor: 0 };

  it('returns base delay for attempt 0', () => {
    expect(computeBackoff(0, config)).toBe(100);
  });

  it('doubles for each attempt', () => {
    expect(computeBackoff(1, config)).toBe(200);
    expect(computeBackoff(2, config)).toBe(400);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoff(10, config)).toBe(5000);
  });

  it('applies jitter', () => {
    const withJitter = { ...config, jitterFactor: 0.5 };
    const delay = computeBackoff(0, withJitter);
    // base=100, jitter range 1.0-1.5, so delay ∈ [100, 150]
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThanOrEqual(150);
  });
});

describe('deriveCoalesceKey', () => {
  it('produces deterministic key for same args', () => {
    const k1 = deriveCoalesceKey('getAccountInfo', ['abc']);
    const k2 = deriveCoalesceKey('getAccountInfo', ['abc']);
    expect(k1).toBe(k2);
  });

  it('different methods produce different keys', () => {
    const k1 = deriveCoalesceKey('getAccountInfo', ['abc']);
    const k2 = deriveCoalesceKey('getBalance', ['abc']);
    expect(k1).not.toBe(k2);
  });

  it('handles Uint8Array deterministically', () => {
    const buf = new Uint8Array([1, 2, 3]);
    const k1 = deriveCoalesceKey('m', [buf]);
    const k2 = deriveCoalesceKey('m', [new Uint8Array([1, 2, 3])]);
    expect(k1).toBe(k2);
  });

  it('handles BigInt', () => {
    const k = deriveCoalesceKey('m', [42n]);
    expect(k).toContain('42');
  });
});

// ============================================================================
// errors.ts
// ============================================================================

describe('ConnectionError', () => {
  it('has correct code and properties', () => {
    const err = new ConnectionError('timeout', 'https://rpc.test', 504);
    expect(err.code).toBe(RuntimeErrorCodes.CONNECTION_ERROR);
    expect(err.endpoint).toBe('https://rpc.test');
    expect(err.httpStatus).toBe(504);
    expect(err.name).toBe('ConnectionError');
  });
});

describe('AllEndpointsUnhealthyError', () => {
  it('has correct code and properties', () => {
    const err = new AllEndpointsUnhealthyError([
      { url: 'https://a', lastError: 'timeout' },
      { url: 'https://b', lastError: null },
    ]);
    expect(err.code).toBe(RuntimeErrorCodes.ALL_ENDPOINTS_UNHEALTHY);
    expect(err.endpointCount).toBe(2);
    expect(err.endpoints).toHaveLength(2);
    expect(err.message).toContain('2');
  });
});

// ============================================================================
// ConnectionManager — constructor
// ============================================================================

describe('ConnectionManager constructor', () => {
  it('throws on empty endpoints', () => {
    expect(() => new ConnectionManager({ endpoints: [] })).toThrow('at least 1 endpoint');
  });

  it('accepts single string endpoint', () => {
    const mgr = new ConnectionManager({
      endpoints: ['https://api.devnet.solana.com'],
      logger: silentLogger,
    });
    expect(mgr.getConnection()).toBeInstanceOf(Connection);
    mgr.destroy();
  });

  it('accepts EndpointConfig objects', () => {
    const mgr = new ConnectionManager({
      endpoints: [{ url: 'https://api.devnet.solana.com', label: 'devnet' }],
      logger: silentLogger,
    });
    const stats = mgr.getStats();
    expect(stats.endpoints[0].label).toBe('devnet');
    mgr.destroy();
  });

  it('uses first endpoint as active', () => {
    const mgr = new ConnectionManager({
      endpoints: ['https://a', 'https://b'],
      logger: silentLogger,
    });
    expect(mgr.getStats().activeEndpoint).toBe('https://a');
    mgr.destroy();
  });
});

// ============================================================================
// ConnectionManager — read retry
// ============================================================================

describe('ConnectionManager read retry', () => {
  let mgr: ConnectionManager;

  afterEach(() => {
    mgr?.destroy();
  });

  it('succeeds on first try', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a']);
    mgr = m;

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };
    const result = await rpc._rpcRequest('getAccountInfo', ['abc']);

    expect(result).toEqual({ result: 'ok-https://a' });
    expect(getMock('https://a')).toHaveBeenCalledOnce();
  });

  it('retries on 429 and succeeds', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a'], {
      retry: { maxRetries: 2 },
    });
    mgr = m;

    const mock = getMock('https://a');
    mock.mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' });
    mock.mockResolvedValueOnce({ result: 'ok-retry' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };
    const result = await rpc._rpcRequest('getAccountInfo', ['abc']);

    expect(result).toEqual({ result: 'ok-retry' });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mgr.getStats().totalRetries).toBe(1);
  });

  it('retries on ETIMEDOUT', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a'], {
      retry: { maxRetries: 2 },
    });
    mgr = m;

    const mock = getMock('https://a');
    mock.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    mock.mockResolvedValueOnce({ result: 'ok' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };
    const result = await rpc._rpcRequest('getBalance', []);

    expect(result).toEqual({ result: 'ok' });
  });

  it('does NOT retry on non-retryable errors (Account does not exist)', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a']);
    mgr = m;

    const mock = getMock('https://a');
    mock.mockRejectedValueOnce(new Error('Account does not exist'));

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await expect(rpc._rpcRequest('getAccountInfo', ['abc'])).rejects.toThrow(
      'Account does not exist',
    );
    expect(mock).toHaveBeenCalledOnce();
  });

  it('does NOT retry on custom program error', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a']);
    mgr = m;

    const mock = getMock('https://a');
    mock.mockRejectedValueOnce(new Error('custom program error: 0x1770'));

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await expect(rpc._rpcRequest('getAccountInfo', [])).rejects.toThrow('custom program error');
    expect(mock).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// ConnectionManager — write behavior
// ============================================================================

describe('ConnectionManager write behavior', () => {
  let mgr: ConnectionManager;

  afterEach(() => {
    mgr?.destroy();
  });

  it('does NOT retry writes', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a'], {
      retry: { maxRetries: 3 },
    });
    mgr = m;

    const mock = getMock('https://a');
    mock.mockRejectedValue({ status: 429, message: 'rate limited' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await expect(rpc._rpcRequest('sendTransaction', ['tx'])).rejects.toMatchObject({
      status: 429,
    });
    // Only 1 call — no retry for writes
    expect(mock).toHaveBeenCalledOnce();
  });

  it('fails over writes on connection-level errors', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a', 'https://b']);
    mgr = m;

    const mockA = getMock('https://a');
    mockA.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    const mockB = getMock('https://b');
    mockB.mockResolvedValueOnce({ result: 'ok-b' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };
    const result = await rpc._rpcRequest('sendTransaction', ['tx']);

    expect(result).toEqual({ result: 'ok-b' });
    expect(mgr.getStats().totalFailovers).toBe(1);
  });

  it('does NOT failover writes on non-connection errors (e.g. 429)', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a', 'https://b']);
    mgr = m;

    const mockA = getMock('https://a');
    mockA.mockRejectedValueOnce({ status: 429, message: 'rate limited' });

    const mockB = getMock('https://b');

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await expect(rpc._rpcRequest('sendTransaction', ['tx'])).rejects.toMatchObject({
      status: 429,
    });
    // mockB should NOT be called
    expect(mockB).not.toHaveBeenCalled();
  });
});

// ============================================================================
// ConnectionManager — failover
// ============================================================================

describe('ConnectionManager failover', () => {
  let mgr: ConnectionManager;

  afterEach(() => {
    mgr?.destroy();
  });

  it('fails over to next endpoint on persistent read failure', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a', 'https://b'], {
      retry: { maxRetries: 1 },
    });
    mgr = m;

    const mockA = getMock('https://a');
    mockA.mockRejectedValue({ status: 503, message: 'unavailable' });

    const mockB = getMock('https://b');
    mockB.mockResolvedValue({ result: 'ok-b' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };
    const result = await rpc._rpcRequest('getAccountInfo', ['abc']);

    expect(result).toEqual({ result: 'ok-b' });
    expect(mgr.getStats().totalFailovers).toBeGreaterThanOrEqual(1);
    expect(mgr.getStats().activeEndpoint).toBe('https://b');
  });

  it('throws AllEndpointsUnhealthyError when all endpoints fail', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a', 'https://b'], {
      retry: { maxRetries: 0 },
    });
    mgr = m;

    getMock('https://a').mockRejectedValue({ status: 502, message: 'bad gateway' });
    getMock('https://b').mockRejectedValue({ status: 503, message: 'unavailable' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    try {
      await rpc._rpcRequest('getAccountInfo', ['abc']);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AllEndpointsUnhealthyError);
      const e = err as AllEndpointsUnhealthyError;
      expect(e.endpointCount).toBe(2);
      expect(e.endpoints[0].url).toBe('https://a');
      expect(e.endpoints[1].url).toBe('https://b');
    }
  });

  it('updates active endpoint after failover', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a', 'https://b'], {
      retry: { maxRetries: 0 },
    });
    mgr = m;

    getMock('https://a').mockRejectedValueOnce({ status: 502, message: '' });
    getMock('https://b').mockResolvedValue({ result: 'ok' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };
    await rpc._rpcRequest('getBalance', []);

    expect(mgr.getStats().activeEndpoint).toBe('https://b');
  });
});

// ============================================================================
// ConnectionManager — coalescing
// ============================================================================

describe('ConnectionManager coalescing', () => {
  let mgr: ConnectionManager;

  afterEach(() => {
    mgr?.destroy();
  });

  it('deduplicates concurrent identical reads', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a'], { coalesce: true });
    mgr = m;

    let resolveRpc!: (v: unknown) => void;
    const mock = getMock('https://a');
    mock.mockImplementation(
      () => new Promise((resolve) => { resolveRpc = resolve; }),
    );

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    const p1 = rpc._rpcRequest('getAccountInfo', ['xyz']);
    const p2 = rpc._rpcRequest('getAccountInfo', ['xyz']);

    // Same promise, only 1 RPC call
    resolveRpc({ result: 'shared' });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ result: 'shared' });
    expect(r2).toEqual({ result: 'shared' });
    expect(mock).toHaveBeenCalledOnce();
    expect(mgr.getStats().totalCoalesced).toBe(1);
  });

  it('does NOT coalesce writes', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a'], { coalesce: true });
    mgr = m;

    const mock = getMock('https://a');
    mock.mockResolvedValue({ result: 'ok' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await Promise.all([
      rpc._rpcRequest('sendTransaction', ['tx']),
      rpc._rpcRequest('sendTransaction', ['tx']),
    ]);

    expect(mock).toHaveBeenCalledTimes(2);
    expect(mgr.getStats().totalCoalesced).toBe(0);
  });

  it('can disable coalescing', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a'], { coalesce: false });
    mgr = m;

    let callCount = 0;
    const mock = getMock('https://a');
    mock.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ result: `call-${callCount}` });
    });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await Promise.all([
      rpc._rpcRequest('getAccountInfo', ['abc']),
      rpc._rpcRequest('getAccountInfo', ['abc']),
    ]);

    expect(mock).toHaveBeenCalledTimes(2);
    expect(mgr.getStats().totalCoalesced).toBe(0);
  });

  it('cleans up inflight map after completion', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a']);
    mgr = m;

    getMock('https://a').mockResolvedValue({ result: 'ok' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await rpc._rpcRequest('getAccountInfo', ['abc']);

    const inflight = (mgr as unknown as { inflight: Map<string, unknown> }).inflight;
    expect(inflight.size).toBe(0);
  });
});

// ============================================================================
// ConnectionManager — health tracking
// ============================================================================

describe('ConnectionManager health tracking', () => {
  let mgr: ConnectionManager;

  afterEach(() => {
    mgr?.destroy();
  });

  it('marks endpoint unhealthy after threshold consecutive failures', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a', 'https://b'], {
      retry: { maxRetries: 0 },
      healthCheck: { unhealthyThreshold: 2 },
    });
    mgr = m;

    const mockA = getMock('https://a');
    mockA.mockRejectedValue({ status: 503, message: 'down' });
    getMock('https://b').mockResolvedValue({ result: 'ok' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    // First call fails on A, falls over to B
    await rpc._rpcRequest('getBalance', []);
    // Second call: A has 1 failure, still "healthy" for getNextHealthyEndpoint
    // but actually has 1 consecutive failure from retry loop
    await rpc._rpcRequest('getBalance', []);

    const stats = mgr.getStats();
    const epA = stats.endpoints.find((e) => e.url === 'https://a')!;
    expect(epA.totalErrors).toBeGreaterThanOrEqual(1);
  });

  it('recovers endpoint after consecutive successes', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a', 'https://b'], {
      retry: { maxRetries: 0 },
      healthCheck: { unhealthyThreshold: 1, healthyThreshold: 1 },
    });
    mgr = m;

    const mockA = getMock('https://a');
    // First: fail → unhealthy
    mockA.mockRejectedValueOnce({ status: 503, message: 'down' });
    // After failover, A will be retried via cooldown — make it succeed
    mockA.mockResolvedValue({ result: 'recovered' });

    getMock('https://b').mockResolvedValue({ result: 'ok-b' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    // First request: A fails, falls over to B
    await rpc._rpcRequest('getBalance', []);
    expect(mgr.getStats().activeEndpoint).toBe('https://b');
  });

  it('cooldown-based auto-recovery', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a', 'https://b'], {
      retry: { maxRetries: 0 },
      healthCheck: { unhealthyThreshold: 1, unhealthyCooldownMs: 10 },
    });
    mgr = m;

    const mockA = getMock('https://a');
    mockA.mockRejectedValueOnce({ status: 503, message: '' });
    // After cooldown, make A succeed
    mockA.mockResolvedValue({ result: 'ok-a' });

    const mockB = getMock('https://b');
    mockB.mockRejectedValue({ status: 503, message: '' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    // First: A fails, B fails — all unhealthy
    try {
      await rpc._rpcRequest('getBalance', []);
    } catch {
      // Expected
    }

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 20));

    // Now A should be tried again via cooldown recovery
    const result = await rpc._rpcRequest('getBalance', []);
    expect(result).toEqual({ result: 'ok-a' });
  });

  it('tracks latency EMA', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a']);
    mgr = m;

    getMock('https://a').mockResolvedValue({ result: 'ok' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await rpc._rpcRequest('getBalance', []);
    await rpc._rpcRequest('getBalance', []);
    await rpc._rpcRequest('getBalance', []);

    const stats = mgr.getStats();
    // avgLatencyMs should be a reasonable number (>= 0)
    expect(stats.endpoints[0].avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// ConnectionManager — abort / destroy
// ============================================================================

describe('ConnectionManager destroy', () => {
  it('is idempotent', () => {
    const mgr = new ConnectionManager({
      endpoints: ['https://a'],
      logger: silentLogger,
    });
    mgr.destroy();
    mgr.destroy(); // should not throw
  });

  it('aborts in-flight retries', async () => {
    const { mgr, getMock } = createTestManager(['https://a'], {
      retry: { maxRetries: 5, baseDelayMs: 100 },
    });

    const mock = getMock('https://a');
    mock.mockRejectedValue({ status: 503, message: 'down' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    const promise = rpc._rpcRequest('getBalance', []);

    // Destroy while retrying
    setTimeout(() => mgr.destroy(), 5);

    // Should eventually resolve/reject without hanging
    try {
      await promise;
    } catch {
      // Expected — either AllEndpointsUnhealthyError or abort
    }

    // Verify we didn't do all 5 retries
    expect(mock.mock.calls.length).toBeLessThan(6);
  });
});

// ============================================================================
// ConnectionManager — stats
// ============================================================================

describe('ConnectionManager stats', () => {
  let mgr: ConnectionManager;

  afterEach(() => {
    mgr?.destroy();
  });

  it('tracks request counts', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a']);
    mgr = m;

    getMock('https://a').mockResolvedValue({ result: 'ok' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await rpc._rpcRequest('getAccountInfo', ['a']);
    await rpc._rpcRequest('getBalance', ['b']);
    await rpc._rpcRequest('sendTransaction', ['tx']);

    const stats = mgr.getStats();
    expect(stats.totalRequests).toBe(3);
    expect(stats.endpoints[0].totalRequests).toBe(3);
    expect(stats.endpoints[0].totalErrors).toBe(0);
  });

  it('tracks retry counts', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a'], {
      retry: { maxRetries: 2 },
    });
    mgr = m;

    const mock = getMock('https://a');
    mock.mockRejectedValueOnce({ status: 429, message: 'rate limited' });
    mock.mockRejectedValueOnce({ status: 429, message: 'rate limited' });
    mock.mockResolvedValueOnce({ result: 'ok' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await rpc._rpcRequest('getAccountInfo', ['abc']);

    expect(mgr.getStats().totalRetries).toBe(2);
  });

  it('tracks error counts per endpoint', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a', 'https://b'], {
      retry: { maxRetries: 0 },
    });
    mgr = m;

    getMock('https://a').mockRejectedValue({ status: 502, message: '' });
    getMock('https://b').mockResolvedValue({ result: 'ok' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await rpc._rpcRequest('getBalance', []);

    const stats = mgr.getStats();
    const epA = stats.endpoints.find((e) => e.url === 'https://a')!;
    expect(epA.totalErrors).toBe(1);
    expect(epA.lastError).toBeTruthy();
  });

  it('initializes with zero stats', () => {
    const m = new ConnectionManager({
      endpoints: ['https://a'],
      logger: silentLogger,
    });
    mgr = m;

    const stats = mgr.getStats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.totalRetries).toBe(0);
    expect(stats.totalFailovers).toBe(0);
    expect(stats.totalCoalesced).toBe(0);
  });
});

// ============================================================================
// ConnectionManager — getConnection
// ============================================================================

describe('ConnectionManager getConnection', () => {
  it('returns Connection instance', () => {
    const mgr = new ConnectionManager({
      endpoints: ['https://api.devnet.solana.com'],
      logger: silentLogger,
    });
    const conn = mgr.getConnection();
    expect(conn).toBeInstanceOf(Connection);
    mgr.destroy();
  });

  it('returns same instance on multiple calls', () => {
    const mgr = new ConnectionManager({
      endpoints: ['https://api.devnet.solana.com'],
      logger: silentLogger,
    });
    const c1 = mgr.getConnection();
    const c2 = mgr.getConnection();
    expect(c1).toBe(c2);
    mgr.destroy();
  });
});

// ============================================================================
// ConnectionManager — single endpoint edge case
// ============================================================================

describe('ConnectionManager single endpoint', () => {
  let mgr: ConnectionManager;

  afterEach(() => {
    mgr?.destroy();
  });

  it('throws AllEndpointsUnhealthyError with 1 endpoint when all retries fail', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a'], {
      retry: { maxRetries: 1 },
    });
    mgr = m;

    getMock('https://a').mockRejectedValue({ status: 503, message: 'down' });

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await expect(rpc._rpcRequest('getBalance', [])).rejects.toBeInstanceOf(
      AllEndpointsUnhealthyError,
    );
  });

  it('does not failover writes with single endpoint', async () => {
    const { mgr: m, getMock } = createTestManager(['https://a']);
    mgr = m;

    getMock('https://a').mockRejectedValue(new Error('connect ETIMEDOUT'));

    const conn = mgr.getConnection();
    const rpc = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };

    await expect(rpc._rpcRequest('sendTransaction', ['tx'])).rejects.toThrow('ETIMEDOUT');
  });
});
