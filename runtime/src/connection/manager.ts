/**
 * ConnectionManager — resilient RPC transport for Solana.
 *
 * Patches `Connection._rpcRequest` to add retry, failover, and request
 * coalescing at the transport layer. All existing code (Anchor, AgentManager,
 * TaskOperations, etc.) benefits with zero API changes.
 *
 * **Important:** WebSocket subscriptions are NOT covered — they use a
 * separate transport. The codebase already uses hybrid polling+events
 * fallback in AutonomousAgent and DAGMonitor.
 *
 * @module
 */

import { Connection } from '@solana/web3.js';
import type {
  ConnectionManagerConfig,
  ConnectionManagerStats,
  EndpointConfig,
  EndpointHealth,
  EndpointHealthState,
  HealthCheckConfig,
  RetryConfig,
} from './types.js';
import { AllEndpointsUnhealthyError } from './errors.js';
import {
  isRetryableError,
  isConnectionLevelError,
  isWriteMethod,
  computeBackoff,
  deriveCoalesceKey,
} from './retry.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type { MetricsProvider } from '../task/types.js';
import { TELEMETRY_METRIC_NAMES } from '../telemetry/metric-names.js';

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  jitterFactor: 0.2,
};

const DEFAULT_HEALTH: HealthCheckConfig = {
  unhealthyThreshold: 3,
  healthyThreshold: 2,
  unhealthyCooldownMs: 30_000,
};

/** Exponential moving average weight — 10% new sample, 90% history. */
const EMA_FACTOR = 0.1;

// ============================================================================
// ConnectionManager
// ============================================================================

/**
 * Resilient RPC connection manager with retry, failover, and coalescing.
 *
 * Creates a real `Connection` instance whose `_rpcRequest` is patched
 * for resilience. Pass the result of `getConnection()` to `AnchorProvider`,
 * `AgentBuilder`, or any code expecting a `Connection`.
 *
 * @example
 * ```typescript
 * const mgr = new ConnectionManager({
 *   endpoints: [
 *     { url: 'https://rpc.helius.xyz/?api-key=...', label: 'helius' },
 *     'https://api.devnet.solana.com',
 *   ],
 * });
 *
 * const provider = new AnchorProvider(mgr.getConnection(), wallet);
 * ```
 */
export class ConnectionManager {
  // Endpoint state
  private readonly connections: Map<string, Connection> = new Map();
  private readonly endpointUrls: string[];
  private readonly endpointLabels: Map<string, string> = new Map();
  private readonly endpointHealth: Map<string, EndpointHealthState> = new Map();
  private activeIndex = 0;

  // Request coalescing
  private readonly inflight: Map<string, Promise<unknown>> = new Map();
  private readonly coalesceEnabled: boolean;

  // Config
  private readonly retryConfig: RetryConfig;
  private readonly healthConfig: HealthCheckConfig;
  private readonly logger: Logger;
  private metrics?: MetricsProvider;

  // Shutdown
  private readonly abortController = new AbortController();

  // Stats
  private _totalRequests = 0;
  private _totalRetries = 0;
  private _totalFailovers = 0;
  private _totalCoalesced = 0;

  // Primary (patched) connection
  private readonly primaryConnection: Connection;

  constructor(config: ConnectionManagerConfig) {
    if (!config.endpoints || config.endpoints.length === 0) {
      throw new Error('ConnectionManager requires at least 1 endpoint');
    }

    this.retryConfig = { ...DEFAULT_RETRY, ...config.retry };
    this.healthConfig = { ...DEFAULT_HEALTH, ...config.healthCheck };
    this.coalesceEnabled = config.coalesce !== false;
    this.logger = config.logger ?? silentLogger;
    this.metrics = config.metrics;

    const commitment = config.commitment ?? 'confirmed';

    // Normalize endpoints
    const endpoints: EndpointConfig[] = config.endpoints.map((ep) =>
      typeof ep === 'string' ? { url: ep } : ep,
    );

    this.endpointUrls = endpoints.map((ep) => ep.url);

    for (const ep of endpoints) {
      const label = ep.label ?? ep.url;
      this.endpointLabels.set(ep.url, label);

      const conn = new Connection(ep.url, { commitment });
      this.connections.set(ep.url, conn);

      this.endpointHealth.set(ep.url, {
        url: ep.url,
        label,
        healthy: true,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalRequests: 0,
        totalErrors: 0,
        latencyEma: 0,
        lastErrorTime: null,
        lastError: null,
      });
    }

    // Create the primary connection (will be patched)
    const primaryUrl = this.endpointUrls[0];
    this.primaryConnection = new Connection(primaryUrl, { commitment });

    // Runtime guard: verify _rpcRequest is patchable
    const proto = this.primaryConnection as unknown as Record<string, unknown>;
    if (typeof proto._rpcRequest !== 'function') {
      throw new Error(
        'Connection._rpcRequest is not a function — ' +
        '@solana/web3.js version may be incompatible. Requires >=1.90.0.',
      );
    }

    // Patch _rpcRequest
    proto._rpcRequest = this.createResilientRpcRequest();

    this.logger.info(
      `ConnectionManager initialized with ${endpoints.length} endpoint(s), ` +
      `active: ${this.endpointLabels.get(primaryUrl)}`,
    );
  }

  /**
   * Returns the resilient Connection instance.
   *
   * Pass this to AnchorProvider, AgentBuilder, or any code expecting a Connection.
   * The returned object passes `instanceof Connection` checks.
   *
   * **Note:** WebSocket subscriptions use a separate transport and are NOT
   * covered by retry/failover. Use hybrid polling+events for reliability.
   */
  getConnection(): Connection {
    return this.primaryConnection;
  }

  /**
   * Get current stats for all endpoints.
   */
  getStats(): ConnectionManagerStats {
    const endpoints: EndpointHealth[] = this.endpointUrls.map((url) => {
      const h = this.endpointHealth.get(url)!;
      return {
        url: h.url,
        label: h.label,
        healthy: h.healthy,
        consecutiveFailures: h.consecutiveFailures,
        consecutiveSuccesses: h.consecutiveSuccesses,
        totalRequests: h.totalRequests,
        totalErrors: h.totalErrors,
        avgLatencyMs: Math.round(h.latencyEma),
        lastErrorTime: h.lastErrorTime,
        lastError: h.lastError,
      };
    });

    return {
      totalRequests: this._totalRequests,
      totalRetries: this._totalRetries,
      totalFailovers: this._totalFailovers,
      totalCoalesced: this._totalCoalesced,
      activeEndpoint: this.endpointUrls[this.activeIndex],
      endpoints,
    };
  }

  /**
   * Signal shutdown — aborts in-flight retries and prevents new requests.
   * Idempotent.
   */
  destroy(): void {
    this.abortController.abort();
    this.inflight.clear();
    this.logger.info('ConnectionManager destroyed');
  }

  /**
   * Set the metrics provider (post-construction injection).
   *
   * Used by AgentBuilder.build() which creates the ConnectionManager
   * before the telemetry collector exists.
   */
  setMetrics(metrics: MetricsProvider): void {
    this.metrics = metrics;
  }

  // ==========================================================================
  // Core resilient request
  // ==========================================================================

  private createResilientRpcRequest(): (method: string, args: unknown[]) => Promise<unknown> {
    return (method: string, args: unknown[]): Promise<unknown> => {
      this._totalRequests++;

      if (isWriteMethod(method)) {
        return this.executeWrite(method, args);
      }

      // Read path: coalescing + retry + failover
      if (this.coalesceEnabled) {
        const key = deriveCoalesceKey(method, args);
        const existing = this.inflight.get(key);
        if (existing) {
          this._totalCoalesced++;
          return existing;
        }
        const promise = this.executeRead(method, args).finally(() => {
          this.inflight.delete(key);
        });
        this.inflight.set(key, promise);
        return promise;
      }

      return this.executeRead(method, args);
    };
  }

  // ==========================================================================
  // Write path: no retry, only failover on connection-level errors
  // ==========================================================================

  private async executeWrite(method: string, args: unknown[]): Promise<unknown> {
    const activeUrl = this.endpointUrls[this.activeIndex];
    const conn = this.connections.get(activeUrl)!;
    const rpcStart = Date.now();

    try {
      const start = Date.now();
      const result = await this.callRpcRequest(conn, method, args);
      this.recordSuccess(activeUrl, Date.now() - start);
      this.metrics?.histogram(TELEMETRY_METRIC_NAMES.RPC_REQUEST_DURATION, Date.now() - rpcStart, { method });
      return result;
    } catch (error) {
      this.recordFailure(activeUrl, error);

      // Only failover on connection-level errors
      if (isConnectionLevelError(error)) {
        const nextUrl = this.getNextHealthyEndpoint(activeUrl);
        if (nextUrl) {
          this._totalFailovers++;
          this.metrics?.counter(TELEMETRY_METRIC_NAMES.RPC_FAILOVERS_TOTAL, 1, { method });
          this.activeIndex = this.endpointUrls.indexOf(nextUrl);
          this.logger.warn(
            `Write failover: ${this.endpointLabels.get(activeUrl)} → ${this.endpointLabels.get(nextUrl)}`,
          );

          const nextConn = this.connections.get(nextUrl)!;
          try {
            const start = Date.now();
            const result = await this.callRpcRequest(nextConn, method, args);
            this.recordSuccess(nextUrl, Date.now() - start);
            this.metrics?.histogram(TELEMETRY_METRIC_NAMES.RPC_REQUEST_DURATION, Date.now() - rpcStart, { method });
            return result;
          } catch (failoverError) {
            this.recordFailure(nextUrl, failoverError);
            throw failoverError;
          }
        }
      }

      throw error;
    }
  }

  // ==========================================================================
  // Read path: retry + failover
  // ==========================================================================

  private async executeRead(method: string, args: unknown[]): Promise<unknown> {
    // Try all endpoints (active first, then failovers)
    let triedEndpoints = 0;
    let currentUrl = this.endpointUrls[this.activeIndex];
    const rpcStart = Date.now();

    while (triedEndpoints < this.endpointUrls.length) {
      const conn = this.connections.get(currentUrl)!;
      const retryResult = await this.retryOnEndpoint(conn, currentUrl, method, args);

      if (retryResult.success) {
        this.metrics?.histogram(TELEMETRY_METRIC_NAMES.RPC_REQUEST_DURATION, Date.now() - rpcStart, { method });
        return retryResult.value;
      }

      triedEndpoints++;

      // Try next healthy endpoint
      const nextUrl = this.getNextHealthyEndpoint(currentUrl);
      if (!nextUrl) break;

      this._totalFailovers++;
      this.metrics?.counter(TELEMETRY_METRIC_NAMES.RPC_FAILOVERS_TOTAL, 1, { method });
      currentUrl = nextUrl;
      this.activeIndex = this.endpointUrls.indexOf(currentUrl);
      this.logger.warn(
        `Read failover: → ${this.endpointLabels.get(currentUrl)}`,
      );
    }

    // All endpoints exhausted
    const epSummary = this.endpointUrls.map((url) => ({
      url,
      lastError: this.endpointHealth.get(url)!.lastError,
    }));
    throw new AllEndpointsUnhealthyError(epSummary);
  }

  private async retryOnEndpoint(
    conn: Connection,
    url: string,
    method: string,
    args: unknown[],
  ): Promise<{ success: true; value: unknown } | { success: false; error: unknown }> {
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      // Check abort
      if (this.abortController.signal.aborted) {
        return { success: false, error: new Error('ConnectionManager destroyed') };
      }

      try {
        const start = Date.now();
        const result = await this.callRpcRequest(conn, method, args);
        this.recordSuccess(url, Date.now() - start);
        return { success: true, value: result };
      } catch (error) {
        this.recordFailure(url, error);

        // Non-retryable errors are thrown immediately (don't try other endpoints either)
        if (!isRetryableError(error)) {
          throw error;
        }

        // Last attempt on this endpoint — return failure to trigger failover
        if (attempt >= this.retryConfig.maxRetries) {
          return { success: false, error };
        }

        this._totalRetries++;
        this.metrics?.counter(TELEMETRY_METRIC_NAMES.RPC_RETRIES_TOTAL, 1, { method });
        const delay = computeBackoff(attempt, this.retryConfig);
        this.logger.debug(
          `Retry ${attempt + 1}/${this.retryConfig.maxRetries} on ${this.endpointLabels.get(url)} in ${delay}ms`,
        );

        // Abortable sleep
        await this.sleep(delay);
      }
    }

    // Should not reach here, but satisfy TypeScript
    return { success: false, error: new Error('Retry loop exited unexpectedly') };
  }

  // ==========================================================================
  // Low-level helpers
  // ==========================================================================

  /**
   * Call the real _rpcRequest on a (non-patched) Connection instance.
   */
  private callRpcRequest(conn: Connection, method: string, args: unknown[]): Promise<unknown> {
    const proto = conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> };
    return proto._rpcRequest(method, args);
  }

  /**
   * Abortable sleep.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.abortController.signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ==========================================================================
  // Health tracking
  // ==========================================================================

  private recordSuccess(url: string, latencyMs: number): void {
    const h = this.endpointHealth.get(url);
    if (!h) return;

    h.totalRequests++;
    h.consecutiveSuccesses++;
    h.consecutiveFailures = 0;

    // EMA latency update
    h.latencyEma = h.latencyEma === 0
      ? latencyMs
      : h.latencyEma * (1 - EMA_FACTOR) + latencyMs * EMA_FACTOR;

    // Recover from unhealthy
    if (!h.healthy && h.consecutiveSuccesses >= this.healthConfig.healthyThreshold) {
      h.healthy = true;
      this.logger.info(`Endpoint recovered: ${h.label}`);
    }
  }

  private recordFailure(url: string, error: unknown): void {
    const h = this.endpointHealth.get(url);
    if (!h) return;

    h.totalRequests++;
    h.totalErrors++;
    h.consecutiveFailures++;
    h.consecutiveSuccesses = 0;
    h.lastErrorTime = Date.now();
    h.lastError = error instanceof Error ? error.message : String(error);

    if (h.healthy && h.consecutiveFailures >= this.healthConfig.unhealthyThreshold) {
      h.healthy = false;
      this.logger.warn(`Endpoint unhealthy: ${h.label} (${h.consecutiveFailures} consecutive failures)`);
    }
  }

  /**
   * Get the next healthy endpoint after `afterUrl`.
   *
   * Round-robin among healthy endpoints, or endpoints whose unhealthy
   * cooldown has elapsed (auto-recovery without timers).
   */
  private getNextHealthyEndpoint(afterUrl: string): string | undefined {
    if (this.endpointUrls.length === 1) return undefined;

    const startIdx = this.endpointUrls.indexOf(afterUrl);
    const now = Date.now();

    for (let offset = 1; offset < this.endpointUrls.length; offset++) {
      const idx = (startIdx + offset) % this.endpointUrls.length;
      const url = this.endpointUrls[idx];
      const h = this.endpointHealth.get(url)!;

      if (h.healthy) return url;

      // Cooldown-based auto-recovery: try unhealthy endpoint if cooldown elapsed
      if (h.lastErrorTime && now - h.lastErrorTime >= this.healthConfig.unhealthyCooldownMs) {
        this.logger.info(`Attempting recovery of ${h.label} after cooldown`);
        return url;
      }
    }

    return undefined;
  }
}
