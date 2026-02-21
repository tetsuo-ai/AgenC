/**
 * Ollama provider configuration types
 *
 * @module
 */

import type { LLMProviderConfig } from "../types.js";

/**
 * Configuration specific to the Ollama local inference provider.
 */
export interface OllamaProviderConfig extends LLMProviderConfig {
  /** Ollama server host URL (default: 'http://localhost:11434') */
  host?: string;
  /** Keep model in memory after request (default: '5m') */
  keepAlive?: string;
  /** Context window size */
  numCtx?: number;
  /** Number of GPU layers */
  numGpu?: number;
}
