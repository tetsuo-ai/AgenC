/**
 * Configuration and stats types for ConnectionManager.
 *
 * @module
 */

import type { Commitment } from '@solana/web3.js';
import type { Logger } from '../utils/logger.js';
import type { MetricsProvider } from '../task/types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface EndpointConfig {
  url: string;
  label?: string;
}

export interface RetryConfig {
  /** Maximum retry attempts per endpoint. Default: 3 */
  maxRetries: number;
  /** Base delay for exponential backoff in ms. Default: 200 */
  baseDelayMs: number;
  /** Maximum backoff delay in ms. Default: 10_000 */
  maxDelayMs: number;
  /** Random jitter factor (0–1). Default: 0.2 */
  jitterFactor: number;
}

export interface HealthCheckConfig {
  /** Consecutive failures before marking unhealthy. Default: 3 */
  unhealthyThreshold: number;
  /** Consecutive successes before marking healthy. Default: 2 */
  healthyThreshold: number;
  /** Cooldown before retrying an unhealthy endpoint in ms. Default: 30_000 */
  unhealthyCooldownMs: number;
}

export interface ConnectionManagerConfig {
  /** RPC endpoints (at least 1). Strings are treated as URLs. */
  endpoints: (string | EndpointConfig)[];
  /** Retry configuration for read requests. */
  retry?: Partial<RetryConfig>;
  /** Health tracking configuration. */
  healthCheck?: Partial<HealthCheckConfig>;
  /** Enable request coalescing for identical concurrent reads. Default: true */
  coalesce?: boolean;
  /** Commitment level for all connections. Default: 'confirmed' */
  commitment?: Commitment;
  /** Logger instance. */
  logger?: Logger;
  /** Optional metrics provider for telemetry. */
  metrics?: MetricsProvider;
}

// ============================================================================
// Stats / Health
// ============================================================================

export interface EndpointHealth {
  url: string;
  label: string;
  healthy: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalRequests: number;
  totalErrors: number;
  avgLatencyMs: number;
  lastErrorTime: number | null;
  lastError: string | null;
}

export interface ConnectionManagerStats {
  totalRequests: number;
  totalRetries: number;
  totalFailovers: number;
  totalCoalesced: number;
  activeEndpoint: string;
  endpoints: EndpointHealth[];
}

// ============================================================================
// Internal health state (not exported from barrel)
// ============================================================================

export interface EndpointHealthState {
  url: string;
  label: string;
  healthy: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalRequests: number;
  totalErrors: number;
  latencyEma: number;
  lastErrorTime: number | null;
  lastError: string | null;
}
