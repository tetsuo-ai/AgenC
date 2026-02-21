/**
 * Shared lazy-import helper for memory backend adapters.
 *
 * Thin wrapper around the generic {@link ensureLazyModule} that throws
 * {@link MemoryConnectionError} on missing packages.
 *
 * @module
 */

import { ensureLazyModule } from "../utils/lazy-import.js";
import { MemoryConnectionError } from "./errors.js";

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
  return ensureLazyModule(
    packageName,
    (msg) => new MemoryConnectionError(backendName, msg),
    configure,
  );
}
