/**
 * Shared lazy-import helper for memory backend adapters.
 *
 * Centralizes the dynamic `import()` pattern used by SQLite and Redis
 * backends to load optional dependencies on first use.
 *
 * @module
 */

import { MemoryConnectionError } from './errors.js';

/**
 * Dynamically import an optional memory backend package.
 *
 * Handles default/named export resolution and wraps "Cannot find module"
 * errors with an actionable install message.
 *
 * @param packageName - npm package to import (e.g. 'better-sqlite3', 'ioredis')
 * @param backendName - Backend name for error messages (e.g. 'sqlite')
 * @param configure - Extract and instantiate the client from the imported module
 * @returns The configured client instance
 */
export async function ensureLazyBackend<T>(
  packageName: string,
  backendName: string,
  configure: (mod: Record<string, unknown>) => T,
): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(packageName) as Record<string, unknown>;
  } catch {
    throw new MemoryConnectionError(
      backendName,
      `${packageName} package not installed. Install it: npm install ${packageName}`,
    );
  }
  return configure(mod);
}
