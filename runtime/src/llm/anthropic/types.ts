/**
 * Anthropic provider configuration types
 *
 * @module
 */

import type { LLMProviderConfig } from '../types.js';

/**
 * Configuration specific to the Anthropic Claude provider.
 */
export interface AnthropicProviderConfig extends LLMProviderConfig {
  /** Anthropic API key */
  apiKey: string;
  /** Base URL for the Anthropic API */
  baseURL?: string;
  /** Enable extended thinking */
  extendedThinking?: boolean;
  /** Budget for thinking tokens (requires extendedThinking) */
  thinkingBudgetTokens?: number;
}
