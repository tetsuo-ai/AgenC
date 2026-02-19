/**
 * Grok provider configuration types
 *
 * @module
 */

import type { LLMProviderConfig } from '../types.js';

/**
 * Configuration specific to the Grok (xAI) provider.
 * Uses the `openai` SDK pointed at the xAI API.
 */
export interface GrokProviderConfig extends LLMProviderConfig {
  /** xAI API key */
  apiKey: string;
  /** Base URL for the xAI API (default: 'https://api.x.ai/v1') */
  baseURL?: string;
  /** Enable web search tool (injects a web_search tool) */
  webSearch?: boolean;
  /** Search mode when web search is enabled */
  searchMode?: 'auto' | 'on' | 'off';
  /** Vision-capable model to auto-switch to when images are present (default: 'grok-2-vision-1212') */
  visionModel?: string;
}
