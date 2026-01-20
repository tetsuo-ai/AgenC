/**
 * Ollama local LLM adapter
 */

import { BaseLLMAdapter } from './base';
import type { CompletionOptions, LLMResponse, OllamaConfig } from '../../types/llm';
import type { Tool, ToolCall } from '../../types/tools';

const DEFAULT_BASE_URL = 'http://localhost:11434';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaResponse {
  model: string;
  created_at: string;
  message: {
    role: 'assistant';
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaStreamChunk {
  model: string;
  created_at: string;
  message: {
    role: 'assistant';
    content: string;
  };
  done: boolean;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * Ollama adapter for local LLM inference
 */
export class OllamaAdapter extends BaseLLMAdapter {
  private baseUrl: string;

  constructor(config: OllamaConfig) {
    super(config);
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  getContextWindow(): number {
    // Ollama context window depends on the model
    // Most models support at least 4k, many support more
    const model = (this.config.model ?? '').toLowerCase();
    if (model.includes('llama3')) return 8192;
    if (model.includes('mistral')) return 8192;
    if (model.includes('codellama')) return 16384;
    if (model.includes('mixtral')) return 32768;
    return 4096; // Default conservative estimate
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const messages = this.buildOllamaMessages(prompt);

    const response = await this.fetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
        options: {
          temperature: options?.temperature ?? this.config.defaultTemperature,
          num_predict: options?.maxTokens ?? this.config.defaultMaxTokens,
          ...(options?.stopSequences && { stop: options.stopSequences }),
        },
      }),
    });

    const data = await response.json() as OllamaResponse;
    return data.message.content;
  }

  async *stream(prompt: string, options?: CompletionOptions): AsyncIterable<string> {
    const messages = this.buildOllamaMessages(prompt);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: true,
        options: {
          temperature: options?.temperature ?? this.config.defaultTemperature,
          num_predict: options?.maxTokens ?? this.config.defaultMaxTokens,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const chunk = JSON.parse(line) as OllamaStreamChunk;
            if (chunk.message?.content) {
              yield chunk.message.content;
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  }

  async completeWithTools(
    prompt: string,
    tools: Tool[],
    options?: CompletionOptions
  ): Promise<LLMResponse> {
    const messages = this.buildOllamaMessages(prompt);
    const ollamaTools = this.convertTools(tools);

    const response = await this.fetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        tools: ollamaTools,
        stream: false,
        options: {
          temperature: options?.temperature ?? this.config.defaultTemperature,
          num_predict: options?.maxTokens ?? this.config.defaultMaxTokens,
        },
      }),
    });

    const data = await response.json() as OllamaResponse;
    return this.convertResponse(data);
  }

  private buildOllamaMessages(prompt: string): OllamaMessage[] {
    const messages: OllamaMessage[] = [];

    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }

    for (const msg of this.messages) {
      if (msg.role === 'tool') {
        // Ollama doesn't have native tool result messages
        // Convert to user message with context
        messages.push({
          role: 'user',
          content: `Tool result for ${msg.name ?? 'tool'}: ${msg.content}`,
        });
      } else if (msg.role === 'system') {
        messages.push({ role: 'system', content: msg.content });
      } else if (msg.role === 'assistant') {
        messages.push({ role: 'assistant', content: msg.content });
      } else {
        messages.push({ role: 'user', content: msg.content });
      }
    }

    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  private convertTools(tools: Tool[]): OllamaTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object' as const,
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required,
        },
      },
    }));
  }

  private convertResponse(response: OllamaResponse): LLMResponse {
    const toolCalls: ToolCall[] = [];

    if (response.message.tool_calls) {
      for (let i = 0; i < response.message.tool_calls.length; i++) {
        const tc = response.message.tool_calls[i];
        toolCalls.push({
          id: `call_${i}`,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    // Estimate token counts from durations
    const promptTokens = response.prompt_eval_count ?? 0;
    const completionTokens = response.eval_count ?? 0;

    return {
      content: response.message.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      model: response.model,
    };
  }

  /**
   * Check if Ollama is running
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error('Failed to list models');
    }
    const data = await response.json() as { models: Array<{ name: string }> };
    return data.models.map((m) => m.name);
  }

  /**
   * Pull a model
   */
  async pullModel(model: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: model }),
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${model}`);
    }

    // Wait for pull to complete
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  }
}
