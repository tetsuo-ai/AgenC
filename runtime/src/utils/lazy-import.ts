/**
 * Generic lazy-import helper for optional npm dependencies.
 *
 * Used by LLM adapters and memory backends to dynamically load packages
 * on first use, with domain-specific error wrapping.
 *
 * @module
 */

/**
 * Dynamically import an optional npm package and configure a client from it.
 *
 * Wraps "Cannot find module" errors with an actionable install message
 * via the caller-provided error factory.
 *
 * @param packageName - npm package to import (e.g. 'openai', 'better-sqlite3')
 * @param createError - Factory that creates a domain-specific error from a message
 * @param configure - Extract and instantiate the client from the imported module
 * @returns The configured client instance
 */
export async function ensureLazyModule<T>(
  packageName: string,
  createError: (message: string) => Error,
  configure: (mod: Record<string, unknown>) => T,
): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(packageName) as Record<string, unknown>;
  } catch {
    throw createError(
      `${packageName} package not installed. Install it: npm install ${packageName}`,
    );
  }
  return configure(mod);
}
