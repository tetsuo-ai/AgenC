/**
 * Ollama local LLM provider adapter.
 *
 * Uses the `ollama` SDK for local model inference.
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
import type { OllamaProviderConfig } from './types.js';
import { LLMProviderError, mapLLMError } from '../errors.js';
import { ensureLazyImport } from '../lazy-import.js';
import { withTimeout } from '../timeout.js';

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3';

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  private client: unknown | null = null;
  private readonly config: OllamaProviderConfig;
  private readonly tools: LLMTool[];

  constructor(config: OllamaProviderConfig) {
    this.config = {
      ...config,
      model: config.model ?? DEFAULT_MODEL,
      host: config.host ?? DEFAULT_HOST,
    };
    this.tools = config.tools ?? [];
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const params = this.buildParams(messages);

    try {
      const response = await withTimeout(
        async (signal) => (client as any).chat(params, { signal }),
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
    let model = this.config.model;
    let toolCalls: LLMToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const stream = await withTimeout(
        async (signal) => (client as any).chat(params, { signal }),
        this.config.timeoutMs,
        this.name,
      );

      for await (const chunk of stream as AsyncIterable<any>) {
        if (chunk.message?.content) {
          content += chunk.message.content;
          onChunk({ content: chunk.message.content, done: false });
        }

        // Accumulate tool calls
        if (chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            const validated = validateToolCall({
              id: tc.function?.name ?? `call_${toolCalls.length}`,
              name: tc.function?.name ?? '',
              arguments: JSON.stringify(tc.function?.arguments ?? {}),
            });
            if (validated) {
              toolCalls.push(validated);
            }
          }
        }

        if (chunk.model) model = chunk.model;
        if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
        if (chunk.eval_count) completionTokens = chunk.eval_count;
      }

      const finishReason: LLMResponse['finishReason'] = toolCalls.length > 0 ? 'tool_calls' : 'stop';
      onChunk({ content: '', done: true, toolCalls });

      return {
        content,
        toolCalls,
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
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
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
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
      await (client as any).list();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyImport('ollama', this.name, (mod) => {
      const OllamaClass = (mod.Ollama ?? mod.default) as any;
      return new OllamaClass({ host: this.config.host });
    });
    return this.client;
  }

  private buildParams(messages: LLMMessage[]): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map((m) => this.toOllamaMessage(m)),
    };

    // Build options
    const options: Record<string, unknown> = {};
    if (this.config.temperature !== undefined) options.temperature = this.config.temperature;
    if (this.config.numCtx !== undefined) options.num_ctx = this.config.numCtx;
    if (this.config.numGpu !== undefined) options.num_gpu = this.config.numGpu;
    if (Object.keys(options).length > 0) params.options = options;

    if (this.config.keepAlive !== undefined) params.keep_alive = this.config.keepAlive;

    // Tools — Ollama uses OpenAI-compatible format
    if (this.tools.length > 0) params.tools = this.tools;

    return params;
  }

  private toOllamaMessage(msg: LLMMessage): Record<string, unknown> {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: msg.content,
      };
    }
    return { role: msg.role, content: msg.content };
  }

  private parseResponse(response: any): LLMResponse {
    const message = response.message ?? {};
    const content = message.content ?? '';

    const toolCalls: LLMToolCall[] = (message.tool_calls ?? [])
      .map((tc: any, i: number) =>
        validateToolCall({
          id: tc.function?.name ?? `call_${i}`,
          name: tc.function?.name ?? '',
          arguments: JSON.stringify(tc.function?.arguments ?? {}),
        })
      )
      .filter((toolCall: LLMToolCall | null): toolCall is LLMToolCall => toolCall !== null);

    const usage: LLMUsage = {
      promptTokens: response.prompt_eval_count ?? 0,
      completionTokens: response.eval_count ?? 0,
      totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
    };

    return {
      content,
      toolCalls,
      usage,
      model: response.model ?? this.config.model,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  private mapError(err: unknown): Error {
    // Ollama-specific: connection refused means server isn't running
    const e = err as any;
    if (e?.code === 'ECONNREFUSED') {
      return new LLMProviderError(
        this.name,
        `Cannot connect to Ollama at ${this.config.host}. Is the server running?`,
      );
    }

    return mapLLMError(this.name, err, this.config.timeoutMs ?? 0);
  }
}
