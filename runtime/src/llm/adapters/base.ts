/**
 * Base LLM adapter with common functionality
 */

import type {
  LLMAdapter,
  Message,
  CompletionOptions,
  LLMResponse,
  TokenUsage,
  BaseAdapterConfig,
} from '../../types/llm';
import type { Tool, MCPToolDefinition, ToolCall } from '../../types/tools';

/**
 * Abstract base adapter with common message handling
 */
export abstract class BaseLLMAdapter implements LLMAdapter {
  protected config: BaseAdapterConfig;
  protected messages: Message[] = [];
  protected systemPrompt: string | null = null;

  constructor(config: BaseAdapterConfig) {
    this.config = {
      defaultTemperature: 0.7,
      defaultMaxTokens: 4096,
      timeout: 60000,
      maxRetries: 3,
      ...config,
    };
  }

  /**
   * Set the system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Add a message to the conversation
   */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * Get all messages
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Clear conversation history
   */
  clearContext(): void {
    this.messages = [];
  }

  /**
   * Get the model name
   */
  getModel(): string {
    return this.config.model ?? 'unknown';
  }

  /**
   * Estimate token count (rough approximation)
   */
  countTokens(text: string): number {
    // Rough approximation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Get context window size (override in subclasses)
   */
  abstract getContextWindow(): number;

  /**
   * Generate a completion
   */
  abstract complete(prompt: string, options?: CompletionOptions): Promise<string>;

  /**
   * Generate a streaming completion
   */
  abstract stream(prompt: string, options?: CompletionOptions): AsyncIterable<string>;

  /**
   * Generate a completion with tool support
   */
  abstract completeWithTools(
    prompt: string,
    tools: Tool[],
    options?: CompletionOptions
  ): Promise<LLMResponse>;

  /**
   * Build messages array for API call
   */
  protected buildMessages(prompt: string): Message[] {
    const messages: Message[] = [];

    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }

    messages.push(...this.messages);
    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  /**
   * Convert tools to API format
   */
  protected toolsToAPIFormat(tools: Tool[]): MCPToolDefinition[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
      },
    }));
  }

  /**
   * Make HTTP request with retry
   */
  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = this.config.maxRetries ?? 3
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return response;
        }

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const delay = retryAfter ? parseInt(retryAfter) * 1000 : 1000 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Handle other errors
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      } catch (error) {
        lastError = error as Error;
        if (attempt < retries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError ?? new Error('Request failed');
  }
}
