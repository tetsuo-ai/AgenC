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
} from "../types.js";
import { validateToolCall } from "../types.js";
import type { GrokProviderConfig } from "./types.js";
import { mapLLMError } from "../errors.js";
import { ensureLazyImport } from "../lazy-import.js";
import { withTimeout } from "../timeout.js";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4-1-fast-reasoning";
const DEFAULT_VISION_MODEL = "grok-4-0709";

/** Vision models known to support function-calling alongside image understanding. */
const VISION_MODELS_WITH_TOOLS = new Set([
  "grok-4-0709",
]);

export class GrokProvider implements LLMProvider {
  readonly name = "grok";

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
      this.tools.push({
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
          parameters: {},
        },
      });
    }
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const params = this.buildParams(messages);

    try {
      const completion = await withTimeout(
        async (signal) =>
          (client as any).chat.completions.create(params, { signal }),
        this.config.timeoutMs,
        this.name,
      );
      return this.parseResponse(completion);
    } catch (err: unknown) {
      throw this.mapError(err);
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const params = { ...this.buildParams(messages), stream: true };
    let content = "";
    let model = this.config.model;
    let finishReason: LLMResponse["finishReason"] = "stop";
    const toolCallAccum = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      const stream = await withTimeout(
        async (signal) =>
          (client as any).chat.completions.create(params, { signal }),
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
              if (tc.function?.arguments)
                existing.arguments += tc.function.arguments;
            } else {
              toolCallAccum.set(idx, {
                id: tc.id ?? `call_${idx}`,
                name: tc.function?.name ?? "",
                arguments: tc.function?.arguments ?? "",
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
          }),
        )
        .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);
      if (toolCalls.length > 0 && finishReason === "stop") {
        finishReason = "tool_calls";
      }

      onChunk({ content: "", done: true, toolCalls });

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
        const partialToolCalls: LLMToolCall[] = Array.from(
          toolCallAccum.values(),
        )
          .map((candidate) =>
            validateToolCall({
              id: candidate.id,
              name: candidate.name,
              arguments: candidate.arguments,
            }),
          )
          .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);

        onChunk({ content: "", done: true, toolCalls: partialToolCalls });
        return {
          content,
          toolCalls: partialToolCalls,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model,
          finishReason: "error",
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

    this.client = await ensureLazyImport("openai", this.name, (mod) => {
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
    // Auto-upgrade to a vision model when messages contain image content
    const hasImages = messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === "image_url"),
    );
    const visionModel = this.config.visionModel ?? DEFAULT_VISION_MODEL;
    const model = hasImages ? visionModel : this.config.model;

    // Build mapped messages, handling multimodal tool messages.
    // The OpenAI API requires tool message content to be a string.
    // When tool results contain images (e.g. screenshots), we extract
    // the text for the tool message and inject images as a user message
    // after all tool results in the block.
    const mapped: Record<string, unknown>[] = [];
    const pendingImages: Array<{
      type: "image_url";
      image_url: { url: string };
    }> = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];

      // Collect images from multimodal tool messages
      if (m.role === "tool" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "image_url") {
            pendingImages.push({
              type: "image_url",
              image_url: part.image_url,
            });
          }
        }
      }

      mapped.push(this.toOpenAIMessage(m));

      // Flush collected images as a user message after the last tool message
      // in a contiguous tool-result block
      if (pendingImages.length > 0) {
        const nextMsg = messages[i + 1];
        if (!nextMsg || nextMsg.role !== "tool") {
          mapped.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "Here is the screenshot from the tool result above.",
              },
              ...pendingImages.map((img) => ({
                type: img.type,
                image_url: img.image_url,
              })),
            ],
          });
          pendingImages.length = 0;
        }
      }
    }

    const params: Record<string, unknown> = {
      model,
      messages: mapped,
    };
    if (this.config.temperature !== undefined)
      params.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined)
      params.max_tokens = this.config.maxTokens;
    // Enable tools unless the vision model is known to not support them
    if (this.tools.length > 0) {
      if (!hasImages || VISION_MODELS_WITH_TOOLS.has(visionModel)) {
        params.tools = this.tools;
      }
    }
    return params;
  }

  private toOpenAIMessage(msg: LLMMessage): Record<string, unknown> {
    if (msg.role === "tool") {
      // Tool messages require string content per the OpenAI API spec.
      // When content is a multimodal array (e.g. from screenshot tool results),
      // extract only the text parts. Images are injected separately by buildParams.
      let content: string;
      if (Array.isArray(msg.content)) {
        content =
          msg.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("\n") || "Tool executed successfully.";
      } else {
        content = msg.content;
      }
      return {
        role: "tool",
        content,
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
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        }),
      )
      .filter(
        (toolCall: LLMToolCall | null): toolCall is LLMToolCall =>
          toolCall !== null,
      );

    const usage: LLMUsage = {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
    };

    return {
      content: message.content ?? "",
      toolCalls,
      usage,
      model: completion.model ?? this.config.model,
      finishReason: this.mapFinishReason(choice?.finish_reason),
    };
  }

  private mapFinishReason(
    reason: string | undefined,
  ): LLMResponse["finishReason"] {
    switch (reason) {
      case "stop":
        return "stop";
      case "tool_calls":
        return "tool_calls";
      case "length":
        return "length";
      case "content_filter":
        return "content_filter";
      default:
        return "stop";
    }
  }

  private mapError(err: unknown): Error {
    return mapLLMError(this.name, err, this.config.timeoutMs ?? 0);
  }
}
