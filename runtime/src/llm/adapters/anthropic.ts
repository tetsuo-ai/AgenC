/**
 * Anthropic Claude LLM adapter
 */

import { BaseLLMAdapter } from './base';
import type { CompletionOptions, LLMResponse, AnthropicConfig, Message } from '../../types/llm';
import type { Tool, ToolCall } from '../../types/tools';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Anthropic Claude adapter
 */
export class AnthropicAdapter extends BaseLLMAdapter {
  private apiKey: string;
  private baseUrl: string;
  private anthropicVersion: string;

  constructor(config: AnthropicConfig) {
    super({
      ...config,
      model: config.model ?? DEFAULT_MODEL,
    });
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.anthropicVersion = config.anthropicVersion ?? ANTHROPIC_VERSION;
  }

  getContextWindow(): number {
    // Claude models have different context windows
    const model = this.config.model ?? '';
    if (model.includes('opus')) return 200000;
    if (model.includes('sonnet')) return 200000;
    if (model.includes('haiku')) return 200000;
    return 200000; // Default to 200k
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const response = await this.callAPI(prompt, options);
    return this.extractTextContent(response.content);
  }

  async *stream(prompt: string, options?: CompletionOptions): AsyncIterable<string> {
    const messages = this.buildAnthropicMessages(prompt);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
        temperature: options?.temperature ?? this.config.defaultTemperature,
        stream: true,
        ...(this.systemPrompt && { system: this.systemPrompt }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${error}`);
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
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              yield event.delta.text;
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
    const anthropicTools = this.convertTools(tools);
    const response = await this.callAPI(prompt, {
      ...options,
      tools,
    }, anthropicTools);

    return this.convertResponse(response);
  }

  private async callAPI(
    prompt: string,
    options?: CompletionOptions,
    tools?: AnthropicTool[]
  ): Promise<AnthropicResponse> {
    const messages = this.buildAnthropicMessages(prompt);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
      temperature: options?.temperature ?? this.config.defaultTemperature,
    };

    if (this.systemPrompt) {
      body.system = this.systemPrompt;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;

      if (options?.toolChoice) {
        if (options.toolChoice === 'auto') {
          body.tool_choice = { type: 'auto' };
        } else if (options.toolChoice === 'required') {
          body.tool_choice = { type: 'any' };
        } else if (options.toolChoice === 'none') {
          // Don't include tools
          delete body.tools;
        } else if (typeof options.toolChoice === 'object') {
          body.tool_choice = { type: 'tool', name: options.toolChoice.name };
        }
      }
    }

    if (options?.stopSequences) {
      body.stop_sequences = options.stopSequences;
    }

    const response = await this.fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
      body: JSON.stringify(body),
    });

    return await response.json() as AnthropicResponse;
  }

  private buildAnthropicMessages(prompt: string): AnthropicMessage[] {
    const messages: AnthropicMessage[] = [];

    for (const msg of this.messages) {
      if (msg.role === 'system') {
        // System messages are handled separately in Anthropic
        continue;
      }

      if (msg.role === 'tool') {
        // Convert tool results
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.toolCallId ?? '',
            content: msg.content,
          }],
        });
      } else if (msg.role === 'assistant' && msg.toolCalls) {
        // Assistant message with tool calls
        const content: AnthropicContentBlock[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
        messages.push({ role: 'assistant', content });
      } else {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
        });
      }
    }

    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  private convertTools(tools: Tool[]): AnthropicTool[] {
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

  private extractTextContent(content: AnthropicContentBlock[]): string {
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  }

  private convertResponse(response: AnthropicResponse): LLMResponse {
    const content = this.extractTextContent(response.content);

    const toolCalls: ToolCall[] = response.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id ?? '',
        name: block.name ?? '',
        input: block.input,
      }));

    let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' = 'stop';
    if (response.stop_reason === 'tool_use') {
      finishReason = 'tool_calls';
    } else if (response.stop_reason === 'max_tokens') {
      finishReason = 'length';
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      model: response.model,
    };
  }
}
