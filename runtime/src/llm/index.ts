/**
 * LLM Adapters for @agenc/runtime
 *
 * Provides LLM provider adapters that bridge language models
 * to the AgenC task execution system (Phase 4).
 *
 * @module
 */

// Core types
export type {
  LLMProvider,
  LLMProviderConfig,
  LLMMessage,
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
  LLMUsage,
  MessageRole,
  StreamProgressCallback,
  ToolHandler,
} from './types.js';
export { validateToolCall } from './types.js';

// Error classes
export {
  LLMAuthenticationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMResponseConversionError,
  LLMServerError,
  LLMToolCallError,
  LLMTimeoutError,
  mapLLMError,
} from './errors.js';

// Response converter
export { responseToOutput } from './response-converter.js';

// LLM Task Executor
export { LLMTaskExecutor, type LLMTaskExecutorConfig } from './executor.js';
export { FallbackLLMProvider, type FallbackChainConfig } from './fallback.js';

// Provider adapters
export { GrokProvider, type GrokProviderConfig } from './grok/index.js';
export { AnthropicProvider, type AnthropicProviderConfig } from './anthropic/index.js';
export { OllamaProvider, type OllamaProviderConfig } from './ollama/index.js';
