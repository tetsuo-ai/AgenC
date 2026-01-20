/**
 * LLM adapter type definitions for @agenc/runtime
 */

import type { Tool, ToolCall } from './tools';

/**
 * LLM configuration for different providers
 */
export type LLMConfig =
  | { provider: 'grok'; apiKey: string; model?: string; baseUrl?: string }
  | { provider: 'anthropic'; apiKey: string; model?: string; baseUrl?: string }
  | { provider: 'ollama'; baseUrl?: string; model: string }
  | { provider: 'openai'; apiKey: string; model?: string; baseUrl?: string };

/**
 * Message role
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Chat message
 */
export interface Message {
  role: MessageRole;
  content: string;
  /** Tool call ID (for tool responses) */
  toolCallId?: string;
  /** Tool calls made by assistant */
  toolCalls?: ToolCall[];
  /** Name for tool messages */
  name?: string;
}

/**
 * Completion options
 */
export interface CompletionOptions {
  /** Temperature (0-2, default 0.7) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Stop sequences */
  stopSequences?: string[];
  /** Available tools */
  tools?: Tool[];
  /** Tool choice strategy */
  toolChoice?: 'auto' | 'required' | 'none' | { name: string };
  /** Response format */
  responseFormat?: 'text' | 'json';
  /** Top-p sampling */
  topP?: number;
  /** Frequency penalty */
  frequencyPenalty?: number;
  /** Presence penalty */
  presencePenalty?: number;
}

/**
 * Token usage information
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * LLM completion response
 */
export interface LLMResponse {
  /** Response content */
  content: string;
  /** Tool calls requested by the model */
  toolCalls?: ToolCall[];
  /** Finish reason */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  /** Token usage */
  usage: TokenUsage;
  /** Model used */
  model: string;
}

/**
 * Streaming chunk
 */
export interface StreamChunk {
  /** Content delta */
  content?: string;
  /** Tool call delta */
  toolCall?: Partial<ToolCall>;
  /** Is final chunk */
  done: boolean;
  /** Finish reason (on final chunk) */
  finishReason?: string;
}

/**
 * LLM adapter interface
 */
export interface LLMAdapter {
  /**
   * Generate a completion
   */
  complete(prompt: string, options?: CompletionOptions): Promise<string>;

  /**
   * Generate a streaming completion
   */
  stream(prompt: string, options?: CompletionOptions): AsyncIterable<string>;

  /**
   * Generate a completion with tool support
   */
  completeWithTools(
    prompt: string,
    tools: Tool[],
    options?: CompletionOptions
  ): Promise<LLMResponse>;

  /**
   * Set the system prompt
   */
  setSystemPrompt(prompt: string): void;

  /**
   * Add a message to the conversation
   */
  addMessage(message: Message): void;

  /**
   * Get all messages in the conversation
   */
  getMessages(): Message[];

  /**
   * Clear the conversation history
   */
  clearContext(): void;

  /**
   * Count tokens in text
   */
  countTokens(text: string): number;

  /**
   * Get the context window size
   */
  getContextWindow(): number;

  /**
   * Get the model name
   */
  getModel(): string;
}

/**
 * Base adapter configuration
 */
export interface BaseAdapterConfig {
  /** API key */
  apiKey?: string;
  /** Model name */
  model?: string;
  /** Base URL */
  baseUrl?: string;
  /** Default temperature */
  defaultTemperature?: number;
  /** Default max tokens */
  defaultMaxTokens?: number;
  /** Request timeout in ms */
  timeout?: number;
  /** Maximum retries */
  maxRetries?: number;
}

/**
 * Grok-specific configuration
 */
export interface GrokConfig extends BaseAdapterConfig {
  apiKey: string;
  model?: 'grok-2' | 'grok-2-mini' | 'grok-beta';
  baseUrl?: string; // Default: https://api.x.ai/v1
}

/**
 * Anthropic-specific configuration
 */
export interface AnthropicConfig extends BaseAdapterConfig {
  apiKey: string;
  model?: 'claude-opus-4-5-20251101' | 'claude-sonnet-4-20250514' | 'claude-3-5-sonnet-20241022' | 'claude-3-5-haiku-20241022';
  baseUrl?: string; // For proxies
  anthropicVersion?: string;
}

/**
 * Ollama-specific configuration
 */
export interface OllamaConfig extends BaseAdapterConfig {
  model: string; // e.g., 'llama3.2', 'mistral', 'codellama'
  baseUrl?: string; // Default: http://localhost:11434
}

/**
 * OpenAI-compatible configuration
 */
export interface OpenAIConfig extends BaseAdapterConfig {
  apiKey: string;
  model?: string; // Default: gpt-4
  baseUrl?: string;
  organization?: string;
}
