/**
 * Redis backend configuration types
 *
 * @module
 */

import type { MemoryBackendConfig } from "../types.js";

/**
 * Configuration for the Redis memory backend.
 *
 * Requires the `ioredis` optional dependency.
 */
export interface RedisBackendConfig extends MemoryBackendConfig {
  /** Redis URL (e.g. 'redis://localhost:6379'). Takes precedence over host/port. */
  url?: string;
  /** Redis host. Default: 'localhost' */
  host?: string;
  /** Redis port. Default: 6379 */
  port?: number;
  /** Redis password */
  password?: string;
  /** Redis database number. Default: 0 */
  db?: number;
  /** Prefix for all keys. Default: 'agenc:memory:' */
  keyPrefix?: string;
  /** Connection timeout in milliseconds. Default: 5000 */
  connectTimeoutMs?: number;
  /** Maximum reconnection attempts. Default: 3 */
  maxReconnectAttempts?: number;
}
