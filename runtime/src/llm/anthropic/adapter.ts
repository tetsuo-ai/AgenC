/**
 * Anthropic Claude LLM provider adapter.
 *
 * Uses the `@anthropic-ai/sdk` package.
 * The SDK is loaded lazily on first use — it's an optional dependency.
 *
 * @module
 */

import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  LLMUsage,
  LLMTool,
  StreamProgressCallback,
} from '../types.js';
import { validateToolCall } from '../types.js';
import type { AnthropicProviderConfig } from './types.js';
import { mapLLMError } from '../errors.js';
import { ensureLazyImport } from '../lazy-import.js';
import { withTimeout } from '../timeout.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  private client: unknown | null = null;
  private readonly config: AnthropicProviderConfig;
  private readonly tools: LLMTool[];

  constructor(config: AnthropicProviderConfig) {
    this.config = { ...config, model: config.model ?? DEFAULT_MODEL };
    this.tools = config.tools ?? [];
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const params = this.buildParams(messages);

    try {
      const response = await withTimeout(
        async (signal) => (client as any).messages.create(params, { signal }),
        this.config.timeoutMs,
        this.name,
      );
      return this.parseResponse(response);
    } catch (err: unknown) {
      throw this.mapError(err);
    }
  }

  async chatStream(messages: LLMMessage[], onChunk: StreamProgressCallback): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const params = { ...this.buildParams(messages), stream: true };
    let content = '';
    let toolCalls: LLMToolCall[] = [];
    let model = this.config.model;
    let finishReason: LLMResponse['finishReason'] = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;
    let currentToolUse: { id: string; name: string; arguments: string } | null = null;

    try {
      const stream = await withTimeout(
        async (signal) => (client as any).messages.create(params, { signal }),
        this.config.timeoutMs,
        this.name,
      );

      for await (const event of stream as AsyncIterable<any>) {
        switch (event.type) {
          case 'message_start':
            if (event.message?.model) model = event.message.model;
            if (event.message?.usage) inputTokens = event.message.usage.input_tokens ?? 0;
            break;

          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              currentToolUse = {
                id: event.content_block.id,
                name: event.content_block.name,
                arguments: '',
              };
            }
            break;

          case 'content_block_delta':
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              content += event.delta.text;
              onChunk({ content: event.delta.text, done: false });
            }
            if (event.delta?.type === 'input_json_delta' && event.delta.partial_json && currentToolUse) {
              currentToolUse.arguments += event.delta.partial_json;
            }
            break;

          case 'content_block_stop':
            if (currentToolUse) {
              const validated = validateToolCall(currentToolUse);
              if (validated) {
                toolCalls.push(validated);
              }
              currentToolUse = null;
            }
            break;

          case 'message_delta':
            if (event.delta?.stop_reason) {
              finishReason = this.mapStopReason(event.delta.stop_reason);
            }
            if (event.usage) outputTokens = event.usage.output_tokens ?? 0;
            break;
        }
      }

      onChunk({ content: '', done: true, toolCalls });

      return {
        content,
        toolCalls,
        usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens },
        model,
        finishReason,
      };
    } catch (err: unknown) {
      if (content.length > 0) {
        const mappedError = this.mapError(err);
        onChunk({ content: '', done: true, toolCalls });
        return {
          content,
          toolCalls,
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
          },
          model,
          finishReason: 'error',
          error: mappedError,
          partial: true,
        };
      }
      throw this.mapError(err);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      // Minimal request to verify API connectivity
      await (client as any).messages.create({
        model: this.config.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyImport('@anthropic-ai/sdk', this.name, (mod) => {
      const Anthropic = (mod.default ?? mod.Anthropic ?? mod) as any;
      return new Anthropic({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        timeout: this.config.timeoutMs,
        maxRetries: this.config.maxRetries ?? 2,
      });
    });
    return this.client;
  }

  private buildParams(messages: LLMMessage[]): Record<string, unknown> {
    // Extract system message — Anthropic uses a top-level `system` parameter
    let systemPrompt: string | undefined;
    const conversationMessages: LLMMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text).join('\n');
      } else {
        conversationMessages.push(msg);
      }
    }

    const params: Record<string, unknown> = {
      model: this.config.model,
      messages: conversationMessages.map((m) => this.toAnthropicMessage(m)),
      max_tokens: this.config.maxTokens ?? 4096,
    };

    if (systemPrompt) params.system = systemPrompt;
    if (this.config.temperature !== undefined) params.temperature = this.config.temperature;

    // Convert tools to Anthropic format
    if (this.tools.length > 0) {
      params.tools = this.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    // Extended thinking
    if (this.config.extendedThinking) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: this.config.thinkingBudgetTokens ?? 10000,
      };
    }

    return params;
  }

  private toAnthropicMessage(msg: LLMMessage): Record<string, unknown> {
    const textContent = typeof msg.content === 'string'
      ? msg.content
      : msg.content.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text).join('\n');

    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: textContent,
        }],
      };
    }

    if (msg.role === 'assistant') {
      return { role: 'assistant', content: textContent };
    }

    // User messages — support multimodal (images)
    if (Array.isArray(msg.content)) {
      const parts: Record<string, unknown>[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          // Convert OpenAI-style image_url to Anthropic base64 source
          const url = part.image_url.url;
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] },
            });
          }
        }
      }
      return { role: 'user', content: parts };
    }

    return { role: 'user', content: msg.content };
  }

  private parseResponse(response: any): LLMResponse {
    let content = '';
    const toolCalls: LLMToolCall[] = [];

    for (const block of response.content ?? []) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        const validated = validateToolCall({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
        if (validated) {
          toolCalls.push(validated);
        }
      }
    }

    const usage: LLMUsage = {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    };

    return {
      content,
      toolCalls,
      usage,
      model: response.model ?? this.config.model,
      finishReason: this.mapStopReason(response.stop_reason),
    };
  }

  private mapStopReason(reason: string | undefined): LLMResponse['finishReason'] {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'tool_use': return 'tool_calls';
      case 'max_tokens': return 'length';
      default: return 'stop';
    }
  }

  private mapError(err: unknown): Error {
    return mapLLMError(this.name, err, this.config.timeoutMs ?? 0);
  }
}
