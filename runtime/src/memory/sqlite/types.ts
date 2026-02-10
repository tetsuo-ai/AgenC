/**
 * SQLite backend configuration types
 *
 * @module
 */

import type { MemoryBackendConfig } from '../types.js';

/**
 * Configuration for the SQLite memory backend.
 *
 * Requires the `better-sqlite3` optional dependency (native C++ module
 * that needs `node-gyp` and a C++ compiler to install).
 */
export interface SqliteBackendConfig extends MemoryBackendConfig {
  /** Database path. Default: ':memory:' (in-process, not persisted) */
  dbPath?: string;
  /** Enable WAL mode for better read concurrency. Default: true */
  walMode?: boolean;
  /** Delete expired rows on connect. Default: true */
  cleanupOnConnect?: boolean;
}
