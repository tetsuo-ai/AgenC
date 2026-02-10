/**
 * Shared lazy-import helper for LLM provider adapters.
 *
 * Centralizes the dynamic `import()` pattern used by all three adapters
 * (Grok, Anthropic, Ollama) to load optional SDK dependencies on first use.
 *
 * @module
 */

import { LLMProviderError } from './errors.js';

/**
 * Dynamically import an optional LLM SDK package and extract the constructor.
 *
 * Handles default/named export resolution and wraps "Cannot find module"
 * errors with an actionable install message.
 *
 * @param packageName - npm package to import (e.g. 'openai', '@anthropic-ai/sdk')
 * @param providerName - Provider name for error messages (e.g. 'grok')
 * @param configure - Extract and instantiate the client from the imported module
 * @returns The configured client instance
 */
export async function ensureLazyImport<T>(
  packageName: string,
  providerName: string,
  configure: (mod: Record<string, unknown>) => T,
): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(packageName) as Record<string, unknown>;
  } catch {
    throw new LLMProviderError(
      providerName,
      `${packageName} package not installed. Install it: npm install ${packageName}`,
    );
  }
  return configure(mod);
}
