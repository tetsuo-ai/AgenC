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
const MAX_MESSAGES_PAYLOAD_CHARS = 80_000;
const MAX_SYSTEM_MESSAGE_CHARS = 16_000;
const MAX_MESSAGE_CHARS_PER_ENTRY = 4_000;
const MAX_TOOL_DESCRIPTION_CHARS = 200;
const MAX_TOOL_SCHEMA_CHARS_PER_TOOL = 3_000;
const MAX_TOOL_SCHEMA_CHARS_TOTAL = 40_000;
const MAX_TOOL_SCHEMA_CHARS_FOLLOWUP = 20_000;
const TOOL_METADATA_KEYS = new Set([
  "description",
  "title",
  "examples",
  "default",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const PRIORITY_TOOL_NAMES = new Set([
  "system.bash",
  "desktop.bash",
  "desktop.screenshot",
  "desktop.window_list",
  "desktop.click",
  "desktop.type",
  "desktop.keypress",
  "desktop.mouse_move",
  "desktop.scroll",
]);

/** Vision models known to support function-calling alongside image understanding. */
const VISION_MODELS_WITH_TOOLS = new Set([
  "grok-4-0709",
]);

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

function sanitizeLargeText(value: string): string {
  return value
    .replace(
      /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
      "(image omitted)",
    )
    .replace(/[A-Za-z0-9+/=\r\n]{400,}/g, "(base64 omitted)");
}

function estimateOpenAIContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (!part || typeof part !== "object") return sum;
      const p = part as Record<string, unknown>;
      if (p.type === "text") return sum + String(p.text ?? "").length;
      if (p.type === "image_url") {
        const imageUrl = p.image_url as Record<string, unknown> | undefined;
        return sum + String(imageUrl?.url ?? "").length;
      }
      return sum;
    }, 0);
  }
  return 0;
}

function hasImageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return p.type === "image_url";
  });
}

function compactOpenAIMessage(
  msg: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> {
  const role = String(msg.role ?? "user");
  const compact = { ...msg };
  const content = msg.content;

  if (typeof content === "string") {
    compact.content = truncate(sanitizeLargeText(content), maxChars);
    return compact;
  }

  if (Array.isArray(content)) {
    // In hard-cap mode we collapse multimodal payloads to compact text.
    const text = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as Record<string, unknown>;
        if (p.type === "text") return String(p.text ?? "");
        if (p.type === "image_url") return "[image omitted]";
        return "";
      })
      .filter((s) => s.length > 0)
      .join("\n");
    compact.content = truncate(sanitizeLargeText(text || "[content omitted]"), maxChars);
    return compact;
  }

  compact.content = role === "tool" ? "Tool executed." : "";
  return compact;
}

function enforceMessageBudget(
  messages: Record<string, unknown>[],
  maxChars: number,
): Record<string, unknown>[] {
  const total = messages.reduce(
    (sum, m) => sum + estimateOpenAIContentChars(m.content) + 48,
    0,
  );
  if (total <= maxChars) return messages;

  const firstSystemIndex = messages.findIndex((m) => m.role === "system");
  const firstSystem =
    firstSystemIndex >= 0
      ? compactOpenAIMessage(messages[firstSystemIndex], MAX_SYSTEM_MESSAGE_CHARS)
      : undefined;
  const systemChars = firstSystem
    ? estimateOpenAIContentChars(firstSystem.content) + 48
    : 0;
  const nonSystemBudget = Math.max(4_000, maxChars - systemChars);

  const nonSystem = messages.filter((_, idx) => idx !== firstSystemIndex);
  const selected: Record<string, unknown>[] = [];
  let used = 0;

  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const compact = compactOpenAIMessage(
      nonSystem[i],
      MAX_MESSAGE_CHARS_PER_ENTRY,
    );
    const chars = estimateOpenAIContentChars(compact.content) + 48;
    if (used + chars <= nonSystemBudget) {
      selected.push(compact);
      used += chars;
      continue;
    }
    if (selected.length === 0) {
      const remaining = Math.max(256, nonSystemBudget - used - 48);
      selected.push(compactOpenAIMessage(nonSystem[i], remaining));
    }
    break;
  }

  selected.reverse();
  return firstSystem ? [firstSystem, ...selected] : selected;
}

function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((item) => sanitizeSchema(item));
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(input)) {
      if (TOOL_METADATA_KEYS.has(key)) continue;
      if (key === "enum" && Array.isArray(field)) {
        output[key] = field.slice(0, 64);
        continue;
      }
      output[key] = sanitizeSchema(field);
    }
    return output;
  }
  return value;
}

function toolPriority(name: string): number {
  if (PRIORITY_TOOL_NAMES.has(name)) return 0;
  if (name.startsWith("desktop.")) return 1;
  if (name.startsWith("system.")) return 2;
  return 3;
}

function slimTools(tools: LLMTool[]): { tools: LLMTool[]; chars: number } {
  if (tools.length === 0) return { tools: [], chars: 0 };

  const ordered = [...tools].sort((a, b) => {
    const pa = toolPriority(a.function.name);
    const pb = toolPriority(b.function.name);
    if (pa !== pb) return pa - pb;
    return a.function.name.localeCompare(b.function.name);
  });

  const selected: LLMTool[] = [];
  let usedChars = 0;

  for (const tool of ordered) {
    const sanitizedParams = sanitizeSchema(tool.function.parameters);
    let normalizedParams = sanitizedParams;
    if (
      JSON.stringify(sanitizedParams).length > MAX_TOOL_SCHEMA_CHARS_PER_TOOL
    ) {
      normalizedParams = { type: "object", additionalProperties: true };
    }

    const slim: LLMTool = {
      type: "function",
      function: {
        name: tool.function.name,
        description: truncate(
          tool.function.description ?? "",
          MAX_TOOL_DESCRIPTION_CHARS,
        ),
        parameters: normalizedParams as Record<string, unknown>,
      },
    };

    const slimChars = JSON.stringify(slim).length;
    if (usedChars + slimChars > MAX_TOOL_SCHEMA_CHARS_TOTAL) {
      continue;
    }
    selected.push(slim);
    usedChars += slimChars;
  }

  // Always keep at least one tool if any were provided.
  if (selected.length === 0) {
    const first = ordered[0];
    const fallbackTool: LLMTool = {
      type: "function",
      function: {
        name: first.function.name,
        description: truncate(
          first.function.description ?? "",
          MAX_TOOL_DESCRIPTION_CHARS,
        ),
        parameters: { type: "object", additionalProperties: true },
      },
    };
    const chars = JSON.stringify(fallbackTool).length;
    return { tools: [fallbackTool], chars };
  }

  return { tools: selected, chars: usedChars };
}

export class GrokProvider implements LLMProvider {
  readonly name = "grok";

  private client: unknown | null = null;
  private readonly config: GrokProviderConfig;
  private readonly tools: LLMTool[];
  private readonly toolChars: number;

  constructor(config: GrokProviderConfig) {
    this.config = {
      ...config,
      model: config.model ?? DEFAULT_MODEL,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    };

    // Build tools list — optionally inject web_search
    const rawTools = [...(config.tools ?? [])];
    if (config.webSearch) {
      rawTools.push({
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
          parameters: {},
        },
      });
    }
    const slimmed = slimTools(rawTools);
    this.tools = slimmed.tools;
    this.toolChars = slimmed.chars;
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
    const visionModel = this.config.visionModel ?? DEFAULT_VISION_MODEL;

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

    const boundedMessages = enforceMessageBudget(
      mapped,
      MAX_MESSAGES_PAYLOAD_CHARS,
    );
    const hasImages = boundedMessages.some((m) => hasImageContent(m.content));
    const model = hasImages ? visionModel : this.config.model;

    const params: Record<string, unknown> = {
      model,
      messages: boundedMessages,
    };
    if (this.config.temperature !== undefined)
      params.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined)
      params.max_tokens = this.config.maxTokens;
    // Enable tools unless the vision model is known to not support them
    if (this.tools.length > 0) {
      const hasToolResults = messages.some((m) => m.role === "tool");
      if (
        (!hasImages || VISION_MODELS_WITH_TOOLS.has(visionModel)) &&
        (!hasToolResults || this.toolChars <= MAX_TOOL_SCHEMA_CHARS_FOLLOWUP)
      ) {
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
