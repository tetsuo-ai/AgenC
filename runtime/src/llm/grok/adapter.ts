/**
 * Grok (xAI) LLM provider adapter.
 *
 * Uses the `openai` SDK pointed at the xAI API endpoint.
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
import type { GrokProviderConfig } from './types.js';
import { mapLLMError } from '../errors.js';
import { ensureLazyImport } from '../lazy-import.js';
import { withTimeout } from '../timeout.js';

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4-1-fast-reasoning';

export class GrokProvider implements LLMProvider {
  readonly name = 'grok';

  private client: unknown | null = null;
  private readonly config: GrokProviderConfig;
  private readonly tools: LLMTool[];

  constructor(config: GrokProviderConfig) {
    this.config = {
      ...config,
      model: config.model ?? DEFAULT_MODEL,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    };

    // Build tools list — optionally inject web_search
    this.tools = [...(config.tools ?? [])];
    if (config.webSearch) {
      this.tools.push({ type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: {} } });
    }
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const params = this.buildParams(messages);

    try {
      const completion = await withTimeout(
        async (signal) => (client as any).chat.completions.create(params, { signal }),
        this.config.timeoutMs,
        this.name,
      );
      return this.parseResponse(completion);
    } catch (err: unknown) {
      throw this.mapError(err);
    }
  }

  async chatStream(messages: LLMMessage[], onChunk: StreamProgressCallback): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const params = { ...this.buildParams(messages), stream: true };
    let content = '';
    let model = this.config.model;
    let finishReason: LLMResponse['finishReason'] = 'stop';
    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      const stream = await withTimeout(
        async (signal) => (client as any).chat.completions.create(params, { signal }),
        this.config.timeoutMs,
        this.name,
      );

      for await (const chunk of stream as AsyncIterable<any>) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          onChunk({ content: delta.content, done: false });
        }

        // Accumulate tool calls from stream deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = toolCallAccum.get(idx);
            if (existing) {
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            } else {
              toolCallAccum.set(idx, {
                id: tc.id ?? `call_${idx}`,
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              });
            }
          }
        }

        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = this.mapFinishReason(chunk.choices[0].finish_reason);
        }
        if (chunk.model) model = chunk.model;
      }

      const toolCalls: LLMToolCall[] = Array.from(toolCallAccum.values())
        .map((candidate) =>
          validateToolCall({
            id: candidate.id,
            name: candidate.name,
            arguments: candidate.arguments,
          })
        )
        .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);
      if (toolCalls.length > 0 && finishReason === 'stop') {
        finishReason = 'tool_calls';
      }

      onChunk({ content: '', done: true, toolCalls });

      return {
        content,
        toolCalls,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model,
        finishReason,
      };
    } catch (err: unknown) {
      if (content.length > 0) {
        const mappedError = this.mapError(err);
        const partialToolCalls: LLMToolCall[] = Array.from(toolCallAccum.values())
          .map((candidate) =>
            validateToolCall({
              id: candidate.id,
              name: candidate.name,
              arguments: candidate.arguments,
            })
          )
          .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);

        onChunk({ content: '', done: true, toolCalls: partialToolCalls });
        return {
          content,
          toolCalls: partialToolCalls,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
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
      await (client as any).models.list();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyImport('openai', this.name, (mod) => {
      const OpenAI = (mod.default ?? mod.OpenAI ?? mod) as any;
      return new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        timeout: this.config.timeoutMs,
        maxRetries: this.config.maxRetries ?? 2,
      });
    });
    return this.client;
  }

  private buildParams(messages: LLMMessage[]): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map((m) => this.toOpenAIMessage(m)),
    };
    if (this.config.temperature !== undefined) params.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined) params.max_tokens = this.config.maxTokens;
    if (this.tools.length > 0) params.tools = this.tools;
    return params;
  }

  private toOpenAIMessage(msg: LLMMessage): Record<string, unknown> {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: msg.content,
        tool_call_id: msg.toolCallId,
      };
    }
    return { role: msg.role, content: msg.content };
  }

  private parseResponse(completion: any): LLMResponse {
    const choice = completion.choices?.[0];
    const message = choice?.message ?? {};

    const toolCalls: LLMToolCall[] = (message.tool_calls ?? [])
      .map((tc: any) =>
        validateToolCall({
          id: tc.id,
          name: tc.function?.name ?? '',
          arguments: tc.function?.arguments ?? '',
        })
      )
      .filter((toolCall: LLMToolCall | null): toolCall is LLMToolCall => toolCall !== null);

    const usage: LLMUsage = {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
    };

    return {
      content: message.content ?? '',
      toolCalls,
      usage,
      model: completion.model ?? this.config.model,
      finishReason: this.mapFinishReason(choice?.finish_reason),
    };
  }

  private mapFinishReason(reason: string | undefined): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      case 'content_filter': return 'content_filter';
      default: return 'stop';
    }
  }

  private mapError(err: unknown): Error {
    return mapLLMError(this.name, err, this.config.timeoutMs ?? 0);
  }
}
