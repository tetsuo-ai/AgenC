/**
 * Grok (xAI) LLM adapter
 *
 * Grok uses an OpenAI-compatible API format.
 */

import { BaseLLMAdapter } from './base';
import type { CompletionOptions, LLMResponse, GrokConfig } from '../../types/llm';
import type { Tool, ToolCall } from '../../types/tools';

const DEFAULT_MODEL = 'grok-2';
const DEFAULT_BASE_URL = 'https://api.x.ai/v1';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAITool {
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
 * Grok (xAI) adapter using OpenAI-compatible API
 */
export class GrokAdapter extends BaseLLMAdapter {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: GrokConfig) {
    super({
      ...config,
      model: config.model ?? DEFAULT_MODEL,
    });
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  getContextWindow(): number {
    // Grok models context windows
    const model = this.config.model;
    if (model === 'grok-2') return 131072;
    if (model === 'grok-2-mini') return 131072;
    if (model === 'grok-beta') return 131072;
    return 131072; // Default to 128k
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const response = await this.callAPI(prompt, options);
    return response.choices[0]?.message.content ?? '';
  }

  async *stream(prompt: string, options?: CompletionOptions): AsyncIterable<string> {
    const messages = this.buildOpenAIMessages(prompt);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
        temperature: options?.temperature ?? this.config.defaultTemperature,
        stream: true,
        ...(options?.stopSequences && { stop: options.stopSequences }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Grok API error: ${error}`);
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
            const content = event.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
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
    const openaiTools = this.convertTools(tools);
    const response = await this.callAPI(prompt, options, openaiTools);
    return this.convertResponse(response);
  }

  private async callAPI(
    prompt: string,
    options?: CompletionOptions,
    tools?: OpenAITool[]
  ): Promise<OpenAIResponse> {
    const messages = this.buildOpenAIMessages(prompt);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
      temperature: options?.temperature ?? this.config.defaultTemperature,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;

      if (options?.toolChoice) {
        if (options.toolChoice === 'auto') {
          body.tool_choice = 'auto';
        } else if (options.toolChoice === 'required') {
          body.tool_choice = 'required';
        } else if (options.toolChoice === 'none') {
          body.tool_choice = 'none';
        } else if (typeof options.toolChoice === 'object') {
          body.tool_choice = {
            type: 'function',
            function: { name: options.toolChoice.name },
          };
        }
      }
    }

    if (options?.stopSequences) {
      body.stop = options.stopSequences;
    }

    if (options?.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    return await response.json() as OpenAIResponse;
  }

  private buildOpenAIMessages(prompt: string): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];

    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }

    for (const msg of this.messages) {
      if (msg.role === 'tool') {
        messages.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId ?? '',
        });
      } else if (msg.role === 'assistant' && msg.toolCalls) {
        messages.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
            },
          })),
        });
      } else {
        messages.push({
          role: msg.role as 'system' | 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  private convertTools(tools: Tool[]): OpenAITool[] {
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

  private convertResponse(response: OpenAIResponse): LLMResponse {
    const choice = response.choices[0];
    const toolCalls: ToolCall[] = [];

    if (choice?.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = tc.function.arguments;
        }

        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    return {
      content: choice?.message.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: choice?.finish_reason ?? 'stop',
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
      model: response.model,
    };
  }
}
