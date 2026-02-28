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
  LLMRequestMetrics,
  LLMTool,
  StreamProgressCallback,
} from "../types.js";
import { validateToolCall } from "../types.js";
import type { GrokProviderConfig } from "./types.js";
import { LLMProviderError, mapLLMError } from "../errors.js";
import { ensureLazyImport } from "../lazy-import.js";
import { withTimeout } from "../timeout.js";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4-1-fast-reasoning";
const DEFAULT_VISION_MODEL = "grok-4-0709";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOOL_IDS_IN_ERROR = 8;
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

function createStreamTimeoutError(providerName: string, timeoutMs: number): Error {
  const err = new Error(
    `${providerName} stream stalled after ${timeoutMs}ms without a chunk`,
  );
  (err as { name?: string }).name = "AbortError";
  (err as { code?: string }).code = "ABORT_ERR";
  return err;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function summarizeToolIds(ids: Iterable<string>): string {
  const all = Array.from(ids);
  if (all.length <= MAX_TOOL_IDS_IN_ERROR) {
    return all.join(", ");
  }
  const head = all.slice(0, MAX_TOOL_IDS_IN_ERROR).join(", ");
  return `${head} ... (+${all.length - MAX_TOOL_IDS_IN_ERROR} more)`;
}

function validateToolMessageSequence(messages: readonly LLMMessage[]): void {
  let pendingToolCallIds: Set<string> | null = null;
  let pendingAssistantIndex = -1;

  const throwMalformed = (index: number, reason: string): never => {
    const location =
      index >= 0 ? `message[${index}]` : "conversation";
    throw new LLMProviderError(
      "grok",
      `Invalid tool-turn sequence at ${location}: ${reason}`,
      400,
    );
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role;

    if (role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      if (pendingToolCallIds && pendingToolCallIds.size > 0) {
        throwMalformed(
          i,
          `new assistant tool_calls started before resolving all prior tool results from message[${pendingAssistantIndex}]`,
        );
      }

      const ids = new Set<string>();
      for (const toolCall of msg.toolCalls) {
        const id = toolCall.id?.trim();
        if (!id) {
          throwMalformed(i, "assistant tool_calls contains an empty id");
        }
        if (ids.has(id)) {
          throwMalformed(i, `assistant tool_calls contains duplicate id "${id}"`);
        }
        ids.add(id);
      }
      pendingToolCallIds = ids;
      pendingAssistantIndex = i;
      continue;
    }

    if (role === "tool") {
      const parsedToolCallId = msg.toolCallId?.trim();
      if (!parsedToolCallId) {
        throwMalformed(i, "tool message is missing toolCallId");
      }
      const toolCallId = parsedToolCallId as string;
      const pending = pendingToolCallIds;
      if (!pending || pending.size === 0) {
        throwMalformed(
          i,
          `tool message references "${toolCallId}" without a preceding assistant tool_calls message`,
        );
      }
      const pendingRequired = pending as Set<string>;
      if (!pendingRequired.has(toolCallId)) {
        throwMalformed(
          i,
          `tool message references unknown toolCallId "${toolCallId}" (expected one of: ${summarizeToolIds(pendingRequired)})`,
        );
      }
      pendingRequired.delete(toolCallId);
      continue;
    }

    if (pendingToolCallIds && pendingToolCallIds.size > 0) {
      throwMalformed(
        i,
        `missing tool result message(s) for toolCallId(s): ${summarizeToolIds(pendingToolCallIds)}. Tool results must immediately follow assistant tool_calls.`,
      );
    }
  }

  if (pendingToolCallIds && pendingToolCallIds.size > 0) {
    throwMalformed(
      -1,
      `missing tool result message(s) for toolCallId(s): ${summarizeToolIds(pendingToolCallIds)}.`,
    );
  }
}

async function nextStreamChunkWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number | undefined,
  providerName: string,
): Promise<IteratorResult<T>> {
  if (!timeoutMs || timeoutMs <= 0) {
    return iterator.next();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(createStreamTimeoutError(providerName, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([iterator.next(), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
      if (p.type === "text" || p.type === "input_text") {
        return sum + String(p.text ?? "").length;
      }
      if (p.type === "image_url") {
        const imageUrl = p.image_url as Record<string, unknown> | undefined;
        return sum + String(imageUrl?.url ?? "").length;
      }
      if (p.type === "input_image") {
        return sum + String(p.image_url ?? "").length;
      }
      return sum;
    }, 0);
  }
  return 0;
}

function isPromptOverflowErrorMessage(message: string): boolean {
  return /maximum prompt length|maximum context length|request contains\s+\d+\s+tokens/i.test(
    message,
  );
}

function collectParamDiagnostics(
  params: Record<string, unknown>,
): LLMRequestMetrics {
  const messages = Array.isArray(params.messages)
    ? (params.messages as Array<Record<string, unknown>>)
    : [];
  const inputItems = Array.isArray(params.input)
    ? (params.input as Array<Record<string, unknown>>)
    : [];
  const effectiveMessages = messages.length > 0
    ? messages
    : inputItems;
  const tools = Array.isArray(params.tools)
    ? (params.tools as unknown[])
    : [];

  let totalContentChars = 0;
  let maxMessageChars = 0;
  let imageParts = 0;
  let textParts = 0;
  let systemMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;

  for (const msg of effectiveMessages) {
    const role = String(msg.role ?? "");
    const itemType = String(msg.type ?? "");

    if (role === "system") systemMessages++;
    if (role === "user") userMessages++;
    if (role === "assistant") assistantMessages++;
    if (role === "tool" || itemType === "function_call_output") toolMessages++;

    const content = itemType === "function_call_output"
      ? String(msg.output ?? "")
      : msg.content;
    const chars = estimateOpenAIContentChars(content);
    totalContentChars += chars;
    if (chars > maxMessageChars) maxMessageChars = chars;

    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "image_url" || p.type === "input_image") imageParts++;
        if (p.type === "text" || p.type === "input_text") textParts++;
      }
    }
  }

  let serializedChars = 0;
  let toolSchemaChars = 0;
  try {
    serializedChars = JSON.stringify(params).length;
  } catch {
    serializedChars = -1;
  }
  try {
    toolSchemaChars = JSON.stringify(tools).length;
  } catch {
    toolSchemaChars = -1;
  }

  return {
    messageCount: effectiveMessages.length,
    systemMessages,
    userMessages,
    assistantMessages,
    toolMessages,
    totalContentChars,
    maxMessageChars,
    textParts,
    imageParts,
    toolCount: tools.length,
    toolSchemaChars,
    serializedChars,
  };
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
  private readonly responseTools: Record<string, unknown>[];
  private readonly toolChars: number;

  constructor(config: GrokProviderConfig) {
    this.config = {
      ...config,
      model: config.model ?? DEFAULT_MODEL,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      timeoutMs: normalizeTimeoutMs(config.timeoutMs),
      parallelToolCalls: config.parallelToolCalls ?? false,
    };

    // Build tools list — optionally inject web_search
    const rawTools = [...(config.tools ?? [])];
    const slimmed = slimTools(rawTools);
    this.tools = slimmed.tools;
    this.responseTools = this.toResponseTools(this.tools);
    if (config.webSearch) {
      this.responseTools.push({ type: "web_search" });
    }
    this.toolChars =
      slimmed.chars + (config.webSearch ? JSON.stringify({ type: "web_search" }).length : 0);
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const params = this.buildParams(messages);
    const requestMetrics = collectParamDiagnostics(params);

    try {
      const response = await withTimeout(
        async (signal) =>
          (client as any).responses.create(params, { signal }),
        this.config.timeoutMs,
        this.name,
      );
      return this.parseResponse(response, requestMetrics);
    } catch (err: unknown) {
      const mapped = this.mapError(err);
      this.logPromptOverflowDiagnostics(mapped, params);
      throw mapped;
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const params = { ...this.buildParams(messages), stream: true };
    const requestMetrics = collectParamDiagnostics(params);
    let content = "";
    let model = this.config.model;
    let finishReason: LLMResponse["finishReason"] = "stop";
    let usage: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const toolCallAccum = new Map<string, LLMToolCall>();
    let streamIterator: AsyncIterator<any> | null = null;

    try {
      const stream = await withTimeout(
        async (signal) =>
          (client as any).responses.create(params, { signal }),
        this.config.timeoutMs,
        this.name,
      );

      streamIterator = (stream as AsyncIterable<any>)[Symbol.asyncIterator]();

      while (true) {
        const iterResult = await nextStreamChunkWithTimeout(
          streamIterator,
          this.config.timeoutMs,
          this.name,
        );
        if (iterResult.done) break;
        const event = iterResult.value;

        if (event.type === "response.output_text.delta") {
          const delta = String(event.delta ?? "");
          if (delta.length > 0) {
            content += delta;
            onChunk({ content: delta, done: false });
          }
          continue;
        }

        if (event.type === "response.output_item.done") {
          const toolCall = this.toToolCall(event.item);
          if (toolCall) {
            toolCallAccum.set(toolCall.id, toolCall);
          }
          continue;
        }

        if (event.type === "response.completed") {
          const response = event.response ?? {};
          model = String(response.model ?? model);
          usage = this.parseUsage(response);
          const completedToolCalls = this.extractToolCallsFromOutput(response.output);
          for (const toolCall of completedToolCalls) {
            toolCallAccum.set(toolCall.id, toolCall);
          }
          finishReason = this.mapResponseFinishReason(response, Array.from(toolCallAccum.values()));
          const outputText = String(response.output_text ?? "");
          if (outputText && content.length === 0) {
            content = outputText;
          }
          continue;
        }

        if (event.type === "response.failed") {
          finishReason = "error";
          continue;
        }
      }

      const toolCalls = Array.from(toolCallAccum.values());
      if (toolCalls.length > 0 && finishReason === "stop") finishReason = "tool_calls";

      onChunk({ content: "", done: true, toolCalls });

      return {
        content,
        toolCalls,
        usage,
        model,
        requestMetrics,
        finishReason,
      };
    } catch (err: unknown) {
      if (streamIterator && typeof streamIterator.return === "function") {
        try {
          void streamIterator.return();
        } catch {
          // best-effort stream cleanup
        }
      }
      const mappedError = this.mapError(err);
      this.logPromptOverflowDiagnostics(mappedError, params);
      if (content.length > 0) {
        const partialToolCalls: LLMToolCall[] = Array.from(toolCallAccum.values());

        onChunk({ content: "", done: true, toolCalls: partialToolCalls });
        return {
          content,
          toolCalls: partialToolCalls,
          usage,
          model,
          requestMetrics,
          finishReason: "error",
          error: mappedError,
          partial: true,
        };
      }
      throw mappedError;
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
    validateToolMessageSequence(messages);

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
    const input = boundedMessages.flatMap((message) =>
      this.toResponseInputItems(message),
    );

    const params: Record<string, unknown> = {
      model,
      input,
      store: false,
    };
    if (this.config.temperature !== undefined)
      params.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined)
      params.max_output_tokens = this.config.maxTokens;
    // Enable tools unless the vision model is known to not support them
    if (this.responseTools.length > 0) {
      const hasToolResults = messages.some((m) => m.role === "tool");
      if (
        (!hasImages || VISION_MODELS_WITH_TOOLS.has(visionModel)) &&
        (!hasToolResults || this.toolChars <= MAX_TOOL_SCHEMA_CHARS_FOLLOWUP)
      ) {
        params.tools = this.responseTools;
        params.parallel_tool_calls = this.config.parallelToolCalls;
      }
    }
    return params;
  }

  private toOpenAIMessage(msg: LLMMessage): Record<string, unknown> {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: msg.content,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        })),
      };
    }

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

  private toResponseTools(tools: readonly LLMTool[]): Record<string, unknown>[] {
    return tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  }

  private toResponseInputItems(
    message: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const role = String(message.role ?? "");
    const content = message.content;

    if (role === "tool") {
      const toolCallId = String(message.tool_call_id ?? "").trim();
      if (!toolCallId) return [];
      let output: string;
      if (typeof content === "string") {
        output = content;
      } else {
        try {
          output = JSON.stringify(content);
        } catch {
          output = String(content ?? "");
        }
      }
      return [
        {
          type: "function_call_output",
          call_id: toolCallId,
          output,
        },
      ];
    }

    if (role === "assistant") {
      const toolCalls = Array.isArray(message.tool_calls)
        ? (message.tool_calls as Array<Record<string, unknown>>)
        : [];
      const items: Record<string, unknown>[] = [];
      const normalizedContent = this.normalizeResponseMessageContent(content);
      if (normalizedContent !== undefined) {
        items.push({ role, content: normalizedContent });
      }
      for (const tc of toolCalls) {
        const functionData = (tc.function as Record<string, unknown> | undefined) ?? {};
        const callId = String(tc.id ?? "").trim();
        const name = String(functionData.name ?? "").trim();
        const args = String(functionData.arguments ?? "");
        if (!callId || !name) continue;
        items.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: args,
        });
      }
      return items;
    }

    if (role === "system" || role === "user") {
      const normalizedContent = this.normalizeResponseMessageContent(content);
      if (normalizedContent === undefined) return [];
      return [{ role, content: normalizedContent }];
    }

    const normalizedContent = this.normalizeResponseMessageContent(content);
    if (normalizedContent === undefined) return [];
    return [{ role, content: normalizedContent }];
  }

  private normalizeResponseMessageContent(
    content: unknown,
  ): string | Array<Record<string, unknown>> | undefined {
    if (typeof content === "string") {
      if (content.length === 0) return undefined;
      return content;
    }
    if (!Array.isArray(content)) {
      return undefined;
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const entry = part as Record<string, unknown>;
      if (entry.type === "text") {
        const text = String(entry.text ?? "");
        if (text.length > 0) {
          parts.push({ type: "input_text", text });
        }
      } else if (entry.type === "image_url") {
        const image = (entry.image_url as Record<string, unknown> | undefined) ?? {};
        const url = String(image.url ?? "");
        if (url.length > 0) {
          parts.push({ type: "input_image", image_url: url });
        }
      }
    }
    if (parts.length === 0) return undefined;
    return parts;
  }

  private parseResponse(
    response: any,
    requestMetrics?: LLMRequestMetrics,
  ): LLMResponse {
    const toolCalls = this.extractToolCallsFromOutput(response.output);
    const finishReason = this.mapResponseFinishReason(response, toolCalls);

    return {
      content: this.extractOutputText(response),
      toolCalls,
      usage: this.parseUsage(response),
      model: String(response.model ?? this.config.model),
      requestMetrics,
      finishReason,
    };
  }

  private extractOutputText(response: Record<string, unknown>): string {
    const direct = response.output_text;
    if (typeof direct === "string") return direct;

    const output = Array.isArray(response.output)
      ? (response.output as Array<Record<string, unknown>>)
      : [];
    const chunks: string[] = [];
    for (const item of output) {
      if (item.type !== "message") continue;
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];
      for (const part of content) {
        if (part.type === "output_text") {
          const text = part.text;
          if (typeof text === "string" && text.length > 0) {
            chunks.push(text);
          }
        }
      }
    }
    return chunks.join("");
  }

  private parseUsage(response: Record<string, unknown>): LLMUsage {
    const usage = response.usage as Record<string, unknown> | undefined;
    return {
      promptTokens: Number(usage?.input_tokens ?? 0),
      completionTokens: Number(usage?.output_tokens ?? 0),
      totalTokens: Number(usage?.total_tokens ?? 0),
    };
  }

  private toToolCall(item: unknown): LLMToolCall | null {
    if (!item || typeof item !== "object") return null;
    const candidate = item as Record<string, unknown>;
    if (candidate.type !== "function_call") return null;
    return validateToolCall({
      id: String(candidate.call_id ?? candidate.id ?? ""),
      name: String(candidate.name ?? ""),
      arguments: String(candidate.arguments ?? ""),
    });
  }

  private extractToolCallsFromOutput(output: unknown): LLMToolCall[] {
    if (!Array.isArray(output)) return [];
    const toolCalls: LLMToolCall[] = [];
    for (const item of output) {
      const toolCall = this.toToolCall(item);
      if (toolCall) toolCalls.push(toolCall);
    }
    return toolCalls;
  }

  private mapResponseFinishReason(
    response: Record<string, unknown>,
    toolCalls: readonly LLMToolCall[],
  ): LLMResponse["finishReason"] {
    if (toolCalls.length > 0) return "tool_calls";

    const status = String(response.status ?? "");
    if (status === "failed") return "error";
    if (status === "incomplete") {
      const details =
        (response.incomplete_details as Record<string, unknown> | undefined) ??
        {};
      const reason = String(details.reason ?? "");
      if (reason.includes("content_filter")) return "content_filter";
      if (reason.includes("max_output_tokens")) return "length";
      return "length";
    }
    return "stop";
  }

  private mapError(err: unknown): Error {
    return mapLLMError(this.name, err, this.config.timeoutMs ?? 0);
  }

  private logPromptOverflowDiagnostics(
    error: Error,
    params: Record<string, unknown>,
  ): void {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode !== 400) return;
    if (!isPromptOverflowErrorMessage(error.message)) return;

    const diagnostics = collectParamDiagnostics(params);
    // eslint-disable-next-line no-console
    console.warn(
      `[GrokProvider] Prompt overflow diagnostics: ${JSON.stringify(
        diagnostics,
      )}`,
    );
  }
}
