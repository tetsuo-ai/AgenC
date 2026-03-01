/**
 * Grok provider configuration types
 *
 * @module
 */

import type { LLMProviderConfig } from "../types.js";

export interface GrokStatefulResponsesConfig {
  /** Enable session-scoped stateful continuation via `previous_response_id`. */
  enabled?: boolean;
  /** Explicit `store` value for Responses API calls while stateful mode is enabled. */
  store?: boolean;
  /** Retry once without `previous_response_id` on continuation failures. */
  fallbackToStateless?: boolean;
  /** Number of recent normalized turns used for reconciliation hashing. */
  reconciliationWindow?: number;
}

/**
 * Configuration specific to the Grok (xAI) provider.
 * Uses the `openai` SDK pointed at the xAI API.
 */
export interface GrokProviderConfig extends LLMProviderConfig {
  /** xAI API key */
  apiKey: string;
  /** Base URL for the xAI API (default: 'https://api.x.ai/v1') */
  baseURL?: string;
  /** Allow the model to emit multiple tool calls in parallel (default: false). */
  parallelToolCalls?: boolean;
  /** Enable web search tool (injects a web_search tool) */
  webSearch?: boolean;
  /** Search mode when web search is enabled */
  searchMode?: "auto" | "on" | "off";
  /** Vision-capable model to auto-switch to when images are present (default: 'grok-2-vision-1212') */
  visionModel?: string;
  /** Optional stateful continuation controls for Responses API. */
  statefulResponses?: GrokStatefulResponsesConfig;
}
