/**
 * Grok (xAI) LLM provider adapter.
 *
 * Uses the `openai` SDK pointed at the xAI API endpoint.
 * The SDK is loaded lazily on first use — it's an optional dependency.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMCompactionDiagnostics,
  LLMCompactionFallbackReason,
  LLMProviderTraceEvent,
  LLMToolChoice,
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMStatefulDiagnostics,
  LLMStatefulEvent,
  LLMStatefulFallbackReason,
  LLMToolCall,
  LLMUsage,
  LLMRequestMetrics,
  LLMTool,
  StreamProgressCallback,
} from "../types.js";
import { validateToolCall } from "../types.js";
import { LLMProviderError, mapLLMError } from "../errors.js";
import { ensureLazyImport } from "../lazy-import.js";
import {
  resolveLLMStatefulResponsesConfig,
  type ResolvedLLMStatefulResponsesConfig,
} from "../provider-capabilities.js";
import { supportsGrokServerSideTools } from "../provider-native-search.js";
import { withTimeout } from "../timeout.js";
import { validateToolTurnSequence } from "../tool-turn-validator.js";
import type { GrokProviderConfig } from "./types.js";
import {
  buildProviderTraceErrorPayload,
  buildToolSelectionTraceContext,
  cloneProviderTracePayload,
  computeReconciliationChain,
  extractCompactionItemRefs,
  extractTraceToolNames,
  isAssistantPhaseRejection,
  isContinuationRetrievalFailure,
  isServerCompactionRejection,
  slimTools,
  summarizeTraceToolChoice,
  toSlimTool,
  truncate,
  type ToolSelectionDiagnostics,
} from "./adapter-utils.js";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4-1-fast-reasoning";
const DEFAULT_VISION_MODEL = "grok-4-0709";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_MESSAGES_PAYLOAD_CHARS = 80_000;
const MAX_SYSTEM_MESSAGE_CHARS = 16_000;
const MAX_MESSAGE_CHARS_PER_ENTRY = 4_000;
const MAX_TOOL_SCHEMA_CHARS_FOLLOWUP = 20_000;

/** Vision models known to support function-calling alongside image understanding. */
const VISION_MODELS_WITH_TOOLS = new Set([
  "grok-4-0709",
]);

interface StatefulSessionAnchor {
  responseId: string;
  reconciliationHash: string;
  updatedAt: number;
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

function closeAsyncIterator(iterator: AsyncIterator<unknown>): void {
  if (typeof iterator.return !== "function") return;
  try {
    const closeResult = iterator.return();
    if (
      closeResult !== null &&
      closeResult !== undefined &&
      typeof closeResult.then === "function"
    ) {
      void closeResult.catch(() => undefined);
    }
  } catch {
    // best-effort stream cleanup
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

function normalizeResponsesToolChoice(
  toolChoice: LLMToolChoice | undefined,
): LLMToolChoice | undefined {
  if (toolChoice === undefined || typeof toolChoice === "string") {
    return toolChoice;
  }

  const directName = typeof toolChoice.name === "string"
    ? toolChoice.name.trim()
    : "";
  if (toolChoice.type === "function" && directName.length > 0) {
    return { type: "function", name: directName };
  }

  const legacyName = typeof (toolChoice as { function?: { name?: unknown } }).function
      ?.name === "string"
    ? (toolChoice as { function?: { name?: string } }).function!.name!.trim()
    : "";
  if (toolChoice.type === "function" && legacyName.length > 0) {
    return { type: "function", name: legacyName };
  }

  return toolChoice;
}

function resolveResponsesToolChoice(
  toolChoice: LLMToolChoice | undefined,
  selection: ToolSelectionDiagnostics,
): LLMToolChoice | undefined {
  const normalized = normalizeResponsesToolChoice(toolChoice);
  if (normalized !== "required") {
    return normalized;
  }

  if (!selection.toolsAttached || selection.resolvedToolNames.length !== 1) {
    return normalized;
  }

  return {
    type: "function",
    name: selection.resolvedToolNames[0],
  };
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
  selection?: ToolSelectionDiagnostics,
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
  const toolNames = extractTraceToolNames(tools);

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
    toolNames,
    requestedToolNames: selection?.requestedToolNames,
    missingRequestedToolNames: selection?.missingRequestedToolNames,
    toolResolution: selection?.toolResolution,
    providerCatalogToolCount: selection?.providerCatalogToolCount,
    toolsAttached: selection?.toolsAttached,
    toolSuppressionReason: selection?.toolSuppressionReason,
    toolChoice: summarizeTraceToolChoice(params.tool_choice),
    toolSchemaChars,
    serializedChars,
    previousResponseId:
      typeof params.previous_response_id === "string"
        ? String(params.previous_response_id)
        : undefined,
    store: typeof params.store === "boolean" ? params.store : undefined,
    parallelToolCalls:
      typeof params.parallel_tool_calls === "boolean"
        ? params.parallel_tool_calls
        : undefined,
    stream: typeof params.stream === "boolean" ? params.stream : undefined,
  };
}

function emitProviderTraceEvent(
  options: LLMChatOptions | undefined,
  event: LLMProviderTraceEvent,
): void {
  options?.trace?.onProviderTraceEvent?.(event);
}

function appendStatefulEvent(
  events: LLMStatefulEvent[],
  type: LLMStatefulEvent["type"],
  options?: {
    reason?: LLMStatefulFallbackReason;
    detail?: string;
  },
): void {
  events.push({
    type,
    reason: options?.reason,
    detail: options?.detail,
  });
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

export class GrokProvider implements LLMProvider {
  readonly name = "grok";

  private client: unknown | null = null;
  private readonly config: GrokProviderConfig;
  private readonly rawToolsByName = new Map<string, LLMTool>();
  private readonly tools: LLMTool[];
  private readonly responseTools: Record<string, unknown>[];
  private readonly responseToolsByName = new Map<string, Record<string, unknown>>();
  private readonly responseToolCharsByName = new Map<string, number>();
  private readonly webSearchTool?: Record<string, unknown>;
  private readonly toolChars: number;
  private readonly statefulConfig: ResolvedLLMStatefulResponsesConfig;
  private readonly statefulSessions = new Map<string, StatefulSessionAnchor>();
  private assistantPhaseSupported: boolean | undefined;
  private serverCompactionSupported: boolean | undefined;

  constructor(config: GrokProviderConfig) {
    this.config = {
      ...config,
      model: config.model ?? DEFAULT_MODEL,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      timeoutMs: normalizeTimeoutMs(config.timeoutMs),
      parallelToolCalls: config.parallelToolCalls ?? false,
    };
    this.statefulConfig = resolveLLMStatefulResponsesConfig(
      config.statefulResponses,
    );

    // Build tools list — optionally inject web_search
    const rawTools = [...(config.tools ?? [])];
    for (const tool of rawTools) {
      this.rawToolsByName.set(tool.function.name, tool);
    }
    const slimmed = slimTools(rawTools);
    const webSearchEnabled =
      config.webSearch === true && supportsGrokServerSideTools(this.config.model);
    this.tools = slimmed.tools;
    this.responseTools = this.toResponseTools(this.tools);
    for (let i = 0; i < this.tools.length; i++) {
      const name = this.tools[i]?.function?.name;
      const responseTool = this.responseTools[i];
      if (!name || !responseTool) continue;
      this.responseToolsByName.set(name, responseTool);
      this.responseToolCharsByName.set(name, JSON.stringify(responseTool).length);
    }
    if (webSearchEnabled) {
      this.webSearchTool = { type: "web_search" };
      this.responseTools.push(this.webSearchTool);
    }
    this.toolChars =
      slimmed.chars +
      (webSearchEnabled ? JSON.stringify({ type: "web_search" }).length : 0);
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    let plan = this.buildRequestPlan(messages, options);

    const run = async (activePlan: ReturnType<GrokProvider["buildRequestPlan"]>) => {
      emitProviderTraceEvent(options, {
        kind: "request",
        transport: "chat",
        provider: this.name,
        model: String(activePlan.params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(activePlan.params) ??
          { error: "provider_request_trace_unavailable" },
        context: buildToolSelectionTraceContext(
          activePlan.toolSelection,
          options?.toolChoice,
        ),
      });
      try {
        const response = await withTimeout(
          async (signal) =>
            (client as any).responses.create(activePlan.params, { signal }),
          this.config.timeoutMs,
          this.name,
        );
        emitProviderTraceEvent(options, {
          kind: "response",
          transport: "chat",
          provider: this.name,
          model: String(response?.model ?? activePlan.params.model ?? this.config.model),
          payload:
            cloneProviderTracePayload(response) ??
            { error: "provider_response_trace_unavailable" },
        });
        const parsed = this.parseResponse(
          response,
          activePlan.requestMetrics,
          activePlan.statefulDiagnostics,
          activePlan.compactionDiagnostics,
        );
        if (activePlan.assistantPhaseEnabled) {
          this.assistantPhaseSupported = true;
        }
        if (activePlan.compactionDiagnostics?.active) {
          this.serverCompactionSupported = true;
        }
        this.persistStatefulAnchor(activePlan, parsed);
        return parsed;
      } catch (error) {
        emitProviderTraceEvent(options, {
          kind: "error",
          transport: "chat",
          provider: this.name,
          model: String(activePlan.params.model ?? this.config.model),
          payload: buildProviderTraceErrorPayload(error),
        });
        throw error;
      }
    };

    while (true) {
      try {
        return await run(plan);
      } catch (err: unknown) {
        if (plan.assistantPhaseEnabled && isAssistantPhaseRejection(err)) {
          this.assistantPhaseSupported = false;
          plan = this.buildRequestPlan(messages, options, {
            forceStateless: plan.statefulDiagnostics?.attempted === false
              ? false
              : undefined,
            fallbackReason: plan.statefulDiagnostics?.fallbackReason,
            inheritedEvents: plan.statefulDiagnostics?.events ?? [],
            disableAssistantPhase: true,
            disableServerCompaction:
              plan.compactionDiagnostics?.active !== true
                ? true
                : undefined,
            compactionFallbackReason: plan.compactionDiagnostics?.fallbackReason,
          });
          continue;
        }
        if (
          plan.compactionDiagnostics?.active &&
          this.statefulConfig.compaction.fallbackOnUnsupported &&
          isServerCompactionRejection(err)
        ) {
          this.serverCompactionSupported = false;
          plan = this.buildRequestPlan(messages, options, {
            forceStateless: false,
            fallbackReason: plan.statefulDiagnostics?.fallbackReason,
            inheritedEvents: plan.statefulDiagnostics?.events ?? [],
            disableAssistantPhase: !plan.assistantPhaseEnabled ? true : undefined,
            disableServerCompaction: true,
            compactionFallbackReason: "request_rejected",
          });
          continue;
        }
        if (this.shouldRetryStatelessFromStateful(err, plan.statefulDiagnostics)) {
          plan = this.buildRequestPlan(messages, options, {
            forceStateless: true,
            fallbackReason: "provider_retrieval_failure",
            inheritedEvents: plan.statefulDiagnostics?.events ?? [],
            disableAssistantPhase: !plan.assistantPhaseEnabled ? true : undefined,
            disableServerCompaction:
              plan.compactionDiagnostics?.active !== true
                ? true
                : undefined,
            compactionFallbackReason: plan.compactionDiagnostics?.fallbackReason,
          });
          continue;
        }
        const mapped = this.mapError(err);
        this.logPromptOverflowDiagnostics(mapped, plan.params);
        throw mapped;
      }
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    let plan = this.buildRequestPlan(messages, options);
    let params: Record<string, unknown> = { ...plan.params, stream: true };
    let requestMetrics = collectParamDiagnostics(params, plan.toolSelection);
    let statefulDiagnostics = plan.statefulDiagnostics;
    let compactionDiagnostics = plan.compactionDiagnostics;
    let content = "";
    let model = this.config.model;
    let finishReason: LLMResponse["finishReason"] = "stop";
    let responseError: Error | undefined;
    let usage: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let providerEvidence: LLMResponse["providerEvidence"];
    const toolCallAccum = new Map<string, LLMToolCall>();
    let streamIterator: AsyncIterator<any> | null = null;
    const streamTimeoutMs = normalizeTimeoutMs(this.config.timeoutMs);
    const streamDeadlineAt = Date.now() + streamTimeoutMs;

    try {
      let stream: AsyncIterable<any>;
      while (true) {
        emitProviderTraceEvent(options, {
          kind: "request",
          transport: "chat_stream",
          provider: this.name,
          model: String(params.model ?? this.config.model),
          payload:
            cloneProviderTracePayload(params) ??
            { error: "provider_request_trace_unavailable" },
          context: buildToolSelectionTraceContext(
            plan.toolSelection,
            options?.toolChoice,
          ),
        });
        try {
          stream = await withTimeout(
            async (signal) =>
              (client as any).responses.create(params, { signal }),
            this.config.timeoutMs,
            this.name,
          );
          if (plan.assistantPhaseEnabled) {
            this.assistantPhaseSupported = true;
          }
          if (plan.compactionDiagnostics?.active) {
            this.serverCompactionSupported = true;
          }
          break;
        } catch (err: unknown) {
          if (plan.assistantPhaseEnabled && isAssistantPhaseRejection(err)) {
            this.assistantPhaseSupported = false;
            plan = this.buildRequestPlan(messages, options, {
              fallbackReason: statefulDiagnostics?.fallbackReason,
              inheritedEvents: statefulDiagnostics?.events ?? [],
              disableAssistantPhase: true,
              disableServerCompaction:
                compactionDiagnostics?.active !== true ? true : undefined,
              compactionFallbackReason: compactionDiagnostics?.fallbackReason,
            });
            params = { ...plan.params, stream: true };
            requestMetrics = collectParamDiagnostics(params, plan.toolSelection);
            statefulDiagnostics = plan.statefulDiagnostics;
            compactionDiagnostics = plan.compactionDiagnostics;
            continue;
          }
          if (
            plan.compactionDiagnostics?.active &&
            this.statefulConfig.compaction.fallbackOnUnsupported &&
            isServerCompactionRejection(err)
          ) {
            this.serverCompactionSupported = false;
            plan = this.buildRequestPlan(messages, options, {
              fallbackReason: statefulDiagnostics?.fallbackReason,
              inheritedEvents: statefulDiagnostics?.events ?? [],
              disableAssistantPhase: !plan.assistantPhaseEnabled ? true : undefined,
              disableServerCompaction: true,
              compactionFallbackReason: "request_rejected",
            });
            params = { ...plan.params, stream: true };
            requestMetrics = collectParamDiagnostics(params, plan.toolSelection);
            statefulDiagnostics = plan.statefulDiagnostics;
            compactionDiagnostics = plan.compactionDiagnostics;
            continue;
          }
          if (this.shouldRetryStatelessFromStateful(err, statefulDiagnostics)) {
            plan = this.buildRequestPlan(messages, options, {
              forceStateless: true,
              fallbackReason: "provider_retrieval_failure",
              inheritedEvents: statefulDiagnostics?.events ?? [],
              disableAssistantPhase: !plan.assistantPhaseEnabled ? true : undefined,
              disableServerCompaction:
                compactionDiagnostics?.active !== true ? true : undefined,
              compactionFallbackReason: compactionDiagnostics?.fallbackReason,
            });
            params = { ...plan.params, stream: true };
            requestMetrics = collectParamDiagnostics(params, plan.toolSelection);
            statefulDiagnostics = plan.statefulDiagnostics;
            compactionDiagnostics = plan.compactionDiagnostics;
            continue;
          }
          throw err;
        }
      }

      streamIterator = stream[Symbol.asyncIterator]();

      while (true) {
        const remainingStreamMs = streamDeadlineAt - Date.now();
        if (remainingStreamMs <= 0) {
          throw createStreamTimeoutError(this.name, streamTimeoutMs);
        }
        const iterResult = await nextStreamChunkWithTimeout(
          streamIterator,
          remainingStreamMs,
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
          emitProviderTraceEvent(options, {
            kind: "response",
            transport: "chat_stream",
            provider: this.name,
            model: String(response.model ?? model),
            payload:
              cloneProviderTracePayload(response) ??
              { error: "provider_response_trace_unavailable" },
          });
          model = String(response.model ?? model);
          usage = this.parseUsage(response);
          providerEvidence = this.extractProviderEvidence(
            response as Record<string, unknown>,
          );
          const completedToolCalls = this.extractToolCallsFromOutput(response.output);
          for (const toolCall of completedToolCalls) {
            toolCallAccum.set(toolCall.id, toolCall);
          }
          finishReason = this.mapResponseFinishReason(response, Array.from(toolCallAccum.values()));
          responseError = this.extractResponseError(response, finishReason);
          const outputText = String(response.output_text ?? "");
          if (outputText && content.length === 0) {
            content = outputText;
          }
          if (statefulDiagnostics) {
            statefulDiagnostics = {
              ...statefulDiagnostics,
              responseId:
                typeof response.id === "string" ? String(response.id) : undefined,
            };
          }
          if (compactionDiagnostics) {
            const compactionItems = extractCompactionItemRefs(
              response as Record<string, unknown>,
            );
            compactionDiagnostics = {
              ...compactionDiagnostics,
              observedItemCount: compactionItems.length,
              ...(compactionItems.length > 0
                ? { latestItem: compactionItems[compactionItems.length - 1] }
                : {}),
            };
          }
          break;
        }

        if (event.type === "response.failed") {
          const failedResponse =
            event.response && typeof event.response === "object"
              ? (event.response as Record<string, unknown>)
              : {};
          emitProviderTraceEvent(options, {
            kind: "error",
            transport: "chat_stream",
            provider: this.name,
            model: String(failedResponse.model ?? model),
            payload:
              cloneProviderTracePayload(failedResponse) ??
              { error: "provider_error_trace_unavailable" },
          });
          finishReason = "error";
          responseError =
            this.extractResponseError(failedResponse, "error") ??
            new LLMProviderError(this.name, "Provider returned status failed");
          break;
        }
      }

      const toolCalls = Array.from(toolCallAccum.values());
      if (toolCalls.length > 0 && finishReason === "stop") finishReason = "tool_calls";

      onChunk({ content: "", done: true, toolCalls });

      const parsed: LLMResponse = {
        content,
        toolCalls,
        usage,
        model,
        requestMetrics,
        stateful: statefulDiagnostics,
        compaction: compactionDiagnostics,
        providerEvidence,
        finishReason,
        ...(responseError ? { error: responseError } : {}),
      };
      this.persistStatefulAnchor(plan, parsed);
      return parsed;
    } catch (err: unknown) {
      emitProviderTraceEvent(options, {
        kind: "error",
        transport: "chat_stream",
        provider: this.name,
        model,
        payload: buildProviderTraceErrorPayload(err),
      });
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
          stateful: statefulDiagnostics,
          compaction: compactionDiagnostics,
          providerEvidence,
          finishReason: "error",
          error: mappedError,
          partial: true,
        };
      }
      throw mappedError;
    } finally {
      if (streamIterator) closeAsyncIterator(streamIterator);
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

  getCapabilities() {
    return {
      provider: this.name,
      stateful: {
        assistantPhase: true,
        previousResponseId: true,
        opaqueCompaction: true,
        deterministicFallback: true,
      },
    } as const;
  }

  resetSessionState(sessionId: string): void {
    this.statefulSessions.delete(sessionId);
  }

  clearSessionState(): void {
    this.statefulSessions.clear();
  }

  private buildRequestPlan(
    messages: readonly LLMMessage[],
    options?: LLMChatOptions,
    overrides?: {
      forceStateless?: boolean;
      fallbackReason?: LLMStatefulFallbackReason;
      inheritedEvents?: readonly LLMStatefulEvent[];
      disableAssistantPhase?: boolean;
      disableServerCompaction?: boolean;
      compactionFallbackReason?: LLMCompactionFallbackReason;
    },
  ): {
    params: Record<string, unknown>;
    requestMetrics: LLMRequestMetrics;
    toolSelection: ToolSelectionDiagnostics;
    statefulDiagnostics?: LLMStatefulDiagnostics;
    compactionDiagnostics?: LLMCompactionDiagnostics;
    sessionId?: string;
    reconciliationHash?: string;
    assistantPhaseEnabled: boolean;
  } {
    const assistantPhaseEnabled =
      overrides?.disableAssistantPhase !== true &&
      this.assistantPhaseSupported !== false;
    const compactionEnabled =
      this.statefulConfig.compaction.enabled === true &&
      this.statefulConfig.compaction.compactThreshold !== undefined;
    const compactionActive =
      compactionEnabled &&
      overrides?.disableServerCompaction !== true &&
      this.serverCompactionSupported !== false;
    const compactionDiagnostics = compactionEnabled
      ? {
        enabled: true,
        requested: true,
        active: compactionActive,
        mode: "server_side_context_management" as const,
        threshold: this.statefulConfig.compaction.compactThreshold!,
        observedItemCount: 0,
        ...(overrides?.compactionFallbackReason
          ? { fallbackReason: overrides.compactionFallbackReason }
          : {}),
      }
      : undefined;
    const sessionId = options?.stateful?.sessionId?.trim();
    if (!this.statefulConfig.enabled || !sessionId) {
      const toolSelection = this.resolveResponseTools(
        options?.toolRouting?.allowedToolNames,
      );
      const built = this.buildParams(messages, {
        store: false,
        allowedToolNames: options?.toolRouting?.allowedToolNames,
        toolChoice: options?.toolChoice,
        assistantPhaseEnabled,
        contextManagementCompactThreshold:
          compactionActive ? this.statefulConfig.compaction.compactThreshold : undefined,
        toolSelection,
      });
      return {
        params: built.params,
        requestMetrics: collectParamDiagnostics(
          built.params,
          built.toolSelection,
        ),
        toolSelection: built.toolSelection,
        compactionDiagnostics,
        assistantPhaseEnabled,
      };
    }

    const events: LLMStatefulEvent[] = [
      ...(overrides?.inheritedEvents ?? []),
    ];
    const reconciliationMessages =
      options?.stateful?.reconciliationMessages ?? messages;
    const continuationTurn = reconciliationMessages.some(
      (message) => message.role === "assistant" || message.role === "tool",
    );
    const reconciliation = computeReconciliationChain(
      reconciliationMessages,
      this.statefulConfig.reconciliationWindow,
    );
    const persistedResumeAnchor = options?.stateful?.resumeAnchor;
    const memoryAnchor = this.statefulSessions.get(sessionId);
    const anchor = memoryAnchor ?? (
      persistedResumeAnchor?.previousResponseId &&
      persistedResumeAnchor.reconciliationHash
        ? {
            responseId: persistedResumeAnchor.previousResponseId,
            reconciliationHash: persistedResumeAnchor.reconciliationHash,
            updatedAt: Date.now(),
          }
        : undefined
    );
    const forceStateless = overrides?.forceStateless === true;
    let attempted = false;
    let continued = false;
    let previousResponseId: string | undefined;
    let fallbackReason = overrides?.fallbackReason;
    let anchorMatched: boolean | undefined;
    const historyCompacted = options?.stateful?.historyCompacted === true;
    let compactedHistoryTrusted = false;

    if (!forceStateless && anchor?.responseId) {
      attempted = true;
      previousResponseId = anchor.responseId;
      appendStatefulEvent(events, "stateful_continuation_attempt", {
        detail: `session=${sessionId}`,
      });

      anchorMatched = reconciliation.chain.includes(anchor.reconciliationHash);
      if (anchorMatched) {
        continued = true;
        appendStatefulEvent(events, "stateful_continuation_success");
      } else if (historyCompacted) {
        continued = true;
        compactedHistoryTrusted = true;
        appendStatefulEvent(events, "stateful_continuation_success", {
          detail: `session=${sessionId}; trusted_compacted_history=true`,
        });
      } else {
        fallbackReason = "state_reconciliation_mismatch";
        appendStatefulEvent(events, "state_reconciliation_mismatch", {
          reason: "state_reconciliation_mismatch",
          detail: `session=${sessionId}`,
        });
        this.statefulSessions.delete(sessionId);
        if (!this.statefulConfig.fallbackToStateless) {
          throw new LLMProviderError(
            this.name,
            "state_reconciliation_mismatch: local history does not match previous_response_id anchor",
            400,
          );
        }
        continued = false;
        previousResponseId = undefined;
        appendStatefulEvent(events, "stateful_fallback", {
          reason: "state_reconciliation_mismatch",
        });
      }
    } else if (!forceStateless && continuationTurn) {
      fallbackReason = "missing_previous_response_id";
      appendStatefulEvent(events, "stateful_fallback", {
        reason: "missing_previous_response_id",
      });
      if (!this.statefulConfig.fallbackToStateless) {
        throw new LLMProviderError(
          this.name,
          "missing_previous_response_id: stateful continuation requested but no prior response anchor is available",
          400,
        );
      }
    } else if (forceStateless && fallbackReason) {
      appendStatefulEvent(events, "stateful_fallback", {
        reason: fallbackReason,
      });
    }

    const toolSelection = this.resolveResponseTools(
      options?.toolRouting?.allowedToolNames,
    );
    const built = this.buildParams(messages, {
      store: this.statefulConfig.store,
      previousResponseId: continued ? previousResponseId : undefined,
      allowedToolNames: options?.toolRouting?.allowedToolNames,
      toolChoice: options?.toolChoice,
      assistantPhaseEnabled,
      contextManagementCompactThreshold:
        compactionActive ? this.statefulConfig.compaction.compactThreshold : undefined,
      toolSelection,
    });

    return {
      params: built.params,
      requestMetrics: collectParamDiagnostics(
        built.params,
        built.toolSelection,
      ),
      toolSelection: built.toolSelection,
      sessionId,
      reconciliationHash: reconciliation.anchorHash,
      compactionDiagnostics,
      assistantPhaseEnabled,
      statefulDiagnostics: {
        enabled: true,
        attempted,
        continued,
        store: this.statefulConfig.store,
        fallbackToStateless: this.statefulConfig.fallbackToStateless,
        previousResponseId: continued ? previousResponseId : undefined,
        fallbackReason,
        reconciliationHash: reconciliation.anchorHash,
        previousReconciliationHash: anchor?.reconciliationHash,
        reconciliationMessageCount: reconciliation.messageCountUsed,
        reconciliationSource: reconciliation.source,
        anchorMatched,
        historyCompacted,
        compactedHistoryTrusted,
        events,
      },
    };
  }

  private persistStatefulAnchor(
    plan: {
      sessionId?: string;
      reconciliationHash?: string;
      statefulDiagnostics?: LLMStatefulDiagnostics;
    },
    response: LLMResponse,
  ): void {
    if (!plan.statefulDiagnostics?.enabled) return;
    const sessionId = plan.sessionId;
    const responseId = response.stateful?.responseId;
    const reconciliationHash = plan.reconciliationHash;
    if (!sessionId || !responseId || !reconciliationHash) {
      if (sessionId) {
        this.statefulSessions.delete(sessionId);
      }
      return;
    }
    this.statefulSessions.set(sessionId, {
      responseId,
      reconciliationHash,
      updatedAt: Date.now(),
    });
  }

  private shouldRetryStatelessFromStateful(
    error: unknown,
    statefulDiagnostics: LLMStatefulDiagnostics | undefined,
  ): boolean {
    if (!statefulDiagnostics?.attempted) return false;
    if (!statefulDiagnostics.fallbackToStateless) return false;
    return isContinuationRetrievalFailure(error);
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

  private buildParams(
    messages: readonly LLMMessage[],
    options?: {
      store?: boolean;
      previousResponseId?: string;
      allowedToolNames?: readonly string[];
      toolChoice?: LLMToolChoice;
      assistantPhaseEnabled?: boolean;
      contextManagementCompactThreshold?: number;
      toolSelection?: ToolSelectionDiagnostics;
    },
  ): {
    params: Record<string, unknown>;
    toolSelection: ToolSelectionDiagnostics;
  } {
    const visionModel = this.config.visionModel ?? DEFAULT_VISION_MODEL;
    validateToolTurnSequence(messages, { providerName: this.name });

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

      mapped.push(this.toOpenAIMessage(m, options?.assistantPhaseEnabled !== false));

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
      store: options?.store ?? false,
    };
    if (options?.previousResponseId) {
      params.previous_response_id = options.previousResponseId;
    }
    if (this.config.temperature !== undefined)
      params.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined)
      params.max_output_tokens = this.config.maxTokens;
    if (options?.contextManagementCompactThreshold !== undefined) {
      params.context_management = {
        compact_threshold: options.contextManagementCompactThreshold,
      };
    }
    const selectedTools = {
      ...(options?.toolSelection ??
        this.resolveResponseTools(options?.allowedToolNames)),
    };
    // Enable tools unless the vision model is known to not support them.
    if (selectedTools.tools.length > 0) {
      const hasToolResults = messages.some((m) => m.role === "tool");
      if (
        (!hasImages || VISION_MODELS_WITH_TOOLS.has(visionModel)) &&
        (!hasToolResults || selectedTools.chars <= MAX_TOOL_SCHEMA_CHARS_FOLLOWUP)
      ) {
        params.tools = selectedTools.tools;
        selectedTools.toolsAttached = true;
        params.parallel_tool_calls = this.config.parallelToolCalls;
        const toolChoice = resolveResponsesToolChoice(
          options?.toolChoice,
          selectedTools,
        );
        if (toolChoice !== undefined) {
          params.tool_choice = toolChoice;
        }
      } else if (hasImages && !VISION_MODELS_WITH_TOOLS.has(visionModel)) {
        selectedTools.toolSuppressionReason = "vision_model_without_tool_support";
      } else if (hasToolResults) {
        selectedTools.toolSuppressionReason = "followup_tool_schema_limit";
      }
    }
    return { params, toolSelection: selectedTools };
  }

  private resolveResponseTools(
    allowedToolNames?: readonly string[],
  ): ToolSelectionDiagnostics {
    const providerCatalogToolCount = this.responseTools.length;
    const providerCatalogToolNames = extractTraceToolNames(this.responseTools);
    if (allowedToolNames === undefined) {
      return {
        tools: this.responseTools,
        chars: this.toolChars,
        requestedToolNames: [],
        resolvedToolNames: providerCatalogToolNames,
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_no_filter",
        toolsAttached: false,
      };
    }

    if (allowedToolNames.length === 0) {
      return {
        tools: [],
        chars: 0,
        requestedToolNames: [],
        resolvedToolNames: [],
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_empty_filter",
        toolsAttached: false,
        toolSuppressionReason: "empty_allowlist",
      };
    }

    const allowed = new Set(
      allowedToolNames
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    );
    if (allowed.size === 0) {
      return {
        tools: [],
        chars: 0,
        requestedToolNames: [],
        resolvedToolNames: [],
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_empty_filter",
        toolsAttached: false,
        toolSuppressionReason: "empty_allowlist",
      };
    }

    const requestedToolNames = [...allowed];
    const selected: Record<string, unknown>[] = [];
    let chars = 0;
    for (const name of requestedToolNames) {
      let responseTool = this.responseToolsByName.get(name);
      let responseToolChars = this.responseToolCharsByName.get(name);
      if (!responseTool) {
        const rawTool = this.rawToolsByName.get(name);
        if (rawTool) {
          const slimTool = toSlimTool(rawTool);
          responseTool = this.toResponseTools([slimTool.tool])[0];
          responseToolChars = JSON.stringify(responseTool).length;
        }
      }
      if (!responseTool) continue;
      selected.push(responseTool);
      chars += responseToolChars ?? JSON.stringify(responseTool).length;
    }

    if (this.webSearchTool && allowed.has("web_search")) {
      selected.push(this.webSearchTool);
      chars += JSON.stringify(this.webSearchTool).length;
    }

    const resolvedToolNames = extractTraceToolNames(selected);
    const missingRequestedToolNames = requestedToolNames.filter((name) =>
      !resolvedToolNames.includes(name)
    );

    if (selected.length === 0) {
      return {
        tools: this.responseTools,
        chars: this.toolChars,
        requestedToolNames,
        resolvedToolNames: providerCatalogToolNames,
        missingRequestedToolNames: requestedToolNames,
        providerCatalogToolCount,
        toolResolution: "fallback_full_catalog_no_matches",
        toolsAttached: false,
      };
    }

    return {
      tools: selected,
      chars,
      requestedToolNames,
      resolvedToolNames,
      missingRequestedToolNames,
      providerCatalogToolCount,
      toolResolution:
        missingRequestedToolNames.length > 0 ? "subset_partial" : "subset_exact",
      toolsAttached: false,
    };
  }

  private toOpenAIMessage(
    msg: LLMMessage,
    preserveAssistantPhase: boolean,
  ): Record<string, unknown> {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: msg.content,
        ...(preserveAssistantPhase && msg.phase ? { phase: msg.phase } : {}),
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
    return {
      role: msg.role,
      content: msg.content,
      ...(msg.role === "assistant" && preserveAssistantPhase && msg.phase
        ? { phase: msg.phase }
        : {}),
    };
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
      const phase = message.phase;
      const items: Record<string, unknown>[] = [];
      const normalizedContent = this.normalizeResponseMessageContent(content);
      if (normalizedContent !== undefined) {
        items.push({
          role,
          content: normalizedContent,
          ...(phase === "commentary" || phase === "final_answer"
            ? { phase }
            : {}),
        });
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
    statefulDiagnostics?: LLMStatefulDiagnostics,
    compactionDiagnostics?: LLMCompactionDiagnostics,
  ): LLMResponse {
    const toolCalls = this.extractToolCallsFromOutput(response.output);
    const finishReason = this.mapResponseFinishReason(response, toolCalls);
    const responseId =
      typeof response?.id === "string" ? String(response.id) : undefined;
    const compactionItems = extractCompactionItemRefs(
      response as Record<string, unknown>,
    );
    const stateful = statefulDiagnostics
      ? {
        ...statefulDiagnostics,
        responseId,
      }
      : undefined;
    const compaction = compactionDiagnostics
      ? {
        ...compactionDiagnostics,
        observedItemCount: compactionItems.length,
        ...(compactionItems.length > 0
          ? { latestItem: compactionItems[compactionItems.length - 1] }
          : {}),
      }
      : undefined;
    const parsedError = this.extractResponseError(response, finishReason);

    return {
      content: this.extractOutputText(response),
      toolCalls,
      usage: this.parseUsage(response),
      model: String(response.model ?? this.config.model),
      requestMetrics,
      stateful,
      compaction,
      providerEvidence: this.extractProviderEvidence(response),
      finishReason,
      ...(parsedError ? { error: parsedError } : {}),
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

  private extractProviderEvidence(
    response: Record<string, unknown>,
  ): LLMResponse["providerEvidence"] {
    const citations = this.extractCitations(response);
    if (citations.length === 0) return undefined;
    return { citations };
  }

  private extractCitations(response: Record<string, unknown>): string[] {
    const citations = new Set<string>();
    const topLevel = Array.isArray(response.citations)
      ? response.citations
      : [];
    for (const entry of topLevel) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        citations.add(entry.trim());
        continue;
      }
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof (entry as { url?: unknown }).url === "string"
      ) {
        citations.add(String((entry as { url: string }).url).trim());
      }
    }
    if (citations.size > 0) {
      return [...citations];
    }

    const output = Array.isArray(response.output)
      ? (response.output as Array<Record<string, unknown>>)
      : [];
    for (const item of output) {
      if (item.type !== "message") continue;
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];
      for (const part of content) {
        const annotations = Array.isArray(part.annotations)
          ? (part.annotations as Array<Record<string, unknown>>)
          : [];
        for (const annotation of annotations) {
          const url = annotation.url;
          if (typeof url === "string" && url.trim().length > 0) {
            citations.add(url.trim());
          }
        }
      }
    }

    return [...citations];
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

  private extractResponseError(
    response: Record<string, unknown>,
    finishReason: LLMResponse["finishReason"],
  ): Error | undefined {
    if (finishReason !== "error") return undefined;
    const status = String(response.status ?? "");
    const rawError = response.error;
    const errorObj =
      rawError && typeof rawError === "object" && !Array.isArray(rawError)
        ? (rawError as Record<string, unknown>)
        : undefined;
    const message = (
      typeof errorObj?.message === "string" && errorObj.message.length > 0
        ? errorObj.message
        : (status === "failed"
            ? "Provider returned failed response status"
            : "Provider returned error response")
    );
    const codeRaw = errorObj?.code ?? errorObj?.status ?? errorObj?.statusCode;
    const statusCode = typeof codeRaw === "number"
      ? codeRaw
      : Number.parseInt(String(codeRaw ?? ""), 10);
    return new LLMProviderError(
      this.name,
      message,
      Number.isFinite(statusCode) ? statusCode : undefined,
    );
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
