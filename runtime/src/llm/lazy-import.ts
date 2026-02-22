/**
 * Shared lazy-import helper for LLM provider adapters.
 *
 * Thin wrapper around the generic {@link ensureLazyModule} that throws
 * {@link LLMProviderError} on missing packages.
 *
 * @module
 */

import { ensureLazyModule } from "../utils/lazy-import.js";
import { LLMProviderError } from "./errors.js";

/**
 * Dynamically import an optional LLM SDK package and extract the constructor.
 *
 * Handles default/named export resolution and wraps "Cannot find module"
 * errors with an actionable install message.
 *
 * @param packageName - npm package to import (e.g. 'openai', 'ollama')
 * @param providerName - Provider name for error messages (e.g. 'grok')
 * @param configure - Extract and instantiate the client from the imported module
 * @returns The configured client instance
 */
export async function ensureLazyImport<T>(
  packageName: string,
  providerName: string,
  configure: (mod: Record<string, unknown>) => T,
): Promise<T> {
  return ensureLazyModule(
    packageName,
    (msg) => new LLMProviderError(providerName, msg),
    configure,
  );
}
