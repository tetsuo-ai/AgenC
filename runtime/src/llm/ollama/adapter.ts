/**
 * Ollama local LLM provider adapter.
 *
 * Uses the `ollama` SDK for local model inference.
 * The SDK is loaded lazily on first use — it's an optional dependency.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMProvider,
  LLMMessage,
  LLMProviderTraceEvent,
  LLMRequestMetrics,
  LLMResponse,
  LLMToolCall,
  LLMUsage,
  LLMTool,
  StreamProgressCallback,
} from "../types.js";
import { validateToolCall } from "../types.js";
import type { OllamaProviderConfig } from "./types.js";
import { LLMProviderError, mapLLMError } from "../errors.js";
import { ensureLazyImport } from "../lazy-import.js";
import {
  buildUnsupportedCompactionDiagnostics,
  buildUnsupportedStatefulDiagnostics,
  resolveLLMStatefulResponsesConfig,
  type ResolvedLLMStatefulResponsesConfig,
} from "../provider-capabilities.js";
import { withTimeout } from "../timeout.js";
import { validateToolTurnSequence } from "../tool-turn-validator.js";
import { safeStringify } from "../../tools/types.js";

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "llama3";

type ToolResolutionStrategy =
  | "all_tools_no_filter"
  | "all_tools_empty_filter"
  | "subset_exact"
  | "subset_partial"
  | "fallback_full_catalog_no_matches";

interface ToolSelectionDiagnostics {
  readonly tools: LLMTool[];
  readonly requestedToolNames: readonly string[];
  readonly resolvedToolNames: readonly string[];
  readonly missingRequestedToolNames: readonly string[];
  readonly providerCatalogToolCount: number;
  readonly toolResolution: ToolResolutionStrategy;
  readonly toolsAttached: boolean;
  readonly toolSuppressionReason?: string;
}

function collectParamDiagnostics(
  params: Record<string, unknown>,
  selection?: ToolSelectionDiagnostics,
): LLMRequestMetrics {
  const messages = Array.isArray(params.messages)
    ? (params.messages as Array<Record<string, unknown>>)
    : [];
  const tools = Array.isArray(params.tools)
    ? (params.tools as Array<Record<string, unknown>>)
    : [];

  let totalContentChars = 0;
  let maxMessageChars = 0;
  let systemMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;

  for (const message of messages) {
    const role = String(message.role ?? "");
    if (role === "system") systemMessages++;
    if (role === "user") userMessages++;
    if (role === "assistant") assistantMessages++;
    if (role === "tool") toolMessages++;

    const content = typeof message.content === "string"
      ? message.content
      : safeStringify(message.content ?? "");
    totalContentChars += content.length;
    if (content.length > maxMessageChars) {
      maxMessageChars = content.length;
    }
  }

  let serializedChars = 0;
  let toolSchemaChars = 0;
  try {
    serializedChars = safeStringify(params).length;
  } catch {
    serializedChars = -1;
  }
  try {
    toolSchemaChars = safeStringify(tools).length;
  } catch {
    toolSchemaChars = -1;
  }

  return {
    messageCount: messages.length,
    systemMessages,
    userMessages,
    assistantMessages,
    toolMessages,
    totalContentChars,
    maxMessageChars,
    textParts: 0,
    imageParts: 0,
    toolCount: tools.length,
    toolNames: tools
      .map((tool) => {
        const fn = tool.function;
        return fn &&
          typeof fn === "object" &&
          !Array.isArray(fn) &&
          typeof (fn as Record<string, unknown>).name === "string"
          ? String((fn as Record<string, unknown>).name)
          : undefined;
      })
      .filter((name): name is string => Boolean(name)),
    requestedToolNames: selection?.requestedToolNames,
    missingRequestedToolNames: selection?.missingRequestedToolNames,
    toolResolution: selection?.toolResolution,
    providerCatalogToolCount: selection?.providerCatalogToolCount,
    toolsAttached: selection?.toolsAttached,
    toolSuppressionReason: selection?.toolSuppressionReason,
    toolChoice: undefined,
    toolSchemaChars,
    serializedChars,
    previousResponseId: undefined,
    store: undefined,
    parallelToolCalls: undefined,
    stream: typeof params.stream === "boolean" ? params.stream : undefined,
  };
}

function cloneProviderTracePayload(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    return JSON.parse(safeStringify(value)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function buildProviderTraceErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const payload: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) payload.stack = error.stack;
    const status = (error as { status?: unknown }).status;
    if (
      typeof status === "string" ||
      typeof status === "number" ||
      typeof status === "boolean"
    ) {
      payload.status = status;
    }
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "string" ||
      typeof code === "number" ||
      typeof code === "boolean"
    ) {
      payload.code = code;
    }
    return payload;
  }
  return { error: String(error) };
}

function emitProviderTraceEvent(
  options: LLMChatOptions | undefined,
  event: LLMProviderTraceEvent,
): void {
  options?.trace?.onProviderTraceEvent?.(event);
}

function buildToolSelectionTraceContext(
  selection: ToolSelectionDiagnostics,
): Record<string, unknown> {
  return {
    requestedToolNames: selection.requestedToolNames,
    resolvedToolNames: selection.resolvedToolNames,
    missingRequestedToolNames: selection.missingRequestedToolNames,
    toolResolution: selection.toolResolution,
    providerCatalogToolCount: selection.providerCatalogToolCount,
    toolsAttached: selection.toolsAttached,
    };
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";

  private client: unknown | null = null;
  private readonly config: OllamaProviderConfig;
  private readonly tools: LLMTool[];
  private readonly statefulConfig: ResolvedLLMStatefulResponsesConfig;

  constructor(config: OllamaProviderConfig) {
    this.config = {
      ...config,
      model: config.model ?? DEFAULT_MODEL,
      host: config.host ?? DEFAULT_HOST,
    };
    this.tools = config.tools ?? [];
    this.statefulConfig = resolveLLMStatefulResponsesConfig(
      config.statefulResponses,
    );
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const toolSelection = this.selectTools(options?.toolRouting?.allowedToolNames);
    const params = this.buildParams(messages, options, toolSelection);
    const requestMetrics = collectParamDiagnostics(params, toolSelection);

    try {
      emitProviderTraceEvent(options, {
        kind: "request",
        transport: "chat",
        provider: this.name,
        model: String(params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(params) ??
          { error: "provider_request_trace_unavailable" },
        context: buildToolSelectionTraceContext(toolSelection),
      });
      const response = await withTimeout(
        async (signal) => (client as any).chat(params, { signal }),
        this.config.timeoutMs,
        this.name,
      );
      emitProviderTraceEvent(options, {
        kind: "response",
        transport: "chat",
        provider: this.name,
        model: String(response?.model ?? params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(response) ??
          { error: "provider_response_trace_unavailable" },
      });
      return {
        ...this.parseResponse(response, options),
        requestMetrics,
      };
    } catch (err: unknown) {
      emitProviderTraceEvent(options, {
        kind: "error",
        transport: "chat",
        provider: this.name,
        model: String(params.model ?? this.config.model),
        payload: buildProviderTraceErrorPayload(err),
      });
      throw this.mapError(err);
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const toolSelection = this.selectTools(options?.toolRouting?.allowedToolNames);
    const params: Record<string, unknown> = {
      ...this.buildParams(messages, options, toolSelection),
      stream: true,
    };
    const requestMetrics = collectParamDiagnostics(params, toolSelection);
    let content = "";
    let model = this.config.model;
    let toolCalls: LLMToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      emitProviderTraceEvent(options, {
        kind: "request",
        transport: "chat_stream",
        provider: this.name,
        model: String(params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(params) ??
          { error: "provider_request_trace_unavailable" },
        context: buildToolSelectionTraceContext(toolSelection),
      });
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
              name: tc.function?.name ?? "",
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

      const finishReason: LLMResponse["finishReason"] =
        toolCalls.length > 0 ? "tool_calls" : "stop";
      onChunk({ content: "", done: true, toolCalls });
      emitProviderTraceEvent(options, {
        kind: "response",
        transport: "chat_stream",
        provider: this.name,
        model,
        payload: {
          message: {
            content,
            role: "assistant",
            ...(toolCalls.length > 0
              ? {
                tool_calls: toolCalls.map((toolCall) => ({
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                  },
                })),
              }
              : {}),
          },
          model,
          prompt_eval_count: promptTokens,
          eval_count: completionTokens,
        },
      });

      return {
        content,
        toolCalls,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        model,
        requestMetrics,
        finishReason,
        ...this.buildUnsupportedDiagnostics(options),
      };
    } catch (err: unknown) {
      emitProviderTraceEvent(options, {
        kind: "error",
        transport: "chat_stream",
        provider: this.name,
        model,
        payload: buildProviderTraceErrorPayload(err),
      });
      if (content.length > 0) {
        const mappedError = this.mapError(err);
        onChunk({ content: "", done: true, toolCalls });
        return {
          content,
          toolCalls,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
          model,
          requestMetrics,
          finishReason: "error",
          error: mappedError,
          partial: true,
          ...this.buildUnsupportedDiagnostics(options),
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

  getCapabilities() {
    return {
      provider: this.name,
      stateful: {
        assistantPhase: false,
        previousResponseId: false,
        opaqueCompaction: false,
        deterministicFallback: true,
      },
    } as const;
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyImport("ollama", this.name, (mod) => {
      const OllamaClass = (mod.Ollama ?? mod.default) as any;
      return new OllamaClass({ host: this.config.host });
    });
    return this.client;
  }

  private buildParams(
    messages: LLMMessage[],
    options?: LLMChatOptions,
    toolSelection?: ToolSelectionDiagnostics,
  ): Record<string, unknown> {
    validateToolTurnSequence(messages, { providerName: this.name });

    const params: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map((m) => this.toOllamaMessage(m)),
    };

    // Build model options
    const modelOptions: Record<string, unknown> = {};
    if (this.config.temperature !== undefined)
      modelOptions.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined)
      modelOptions.num_predict = this.config.maxTokens;
    if (this.config.numCtx !== undefined) modelOptions.num_ctx = this.config.numCtx;
    if (this.config.numGpu !== undefined) modelOptions.num_gpu = this.config.numGpu;
    if (Object.keys(modelOptions).length > 0) params.options = modelOptions;

    if (this.config.keepAlive !== undefined)
      params.keep_alive = this.config.keepAlive;

    // Tools — Ollama uses OpenAI-compatible format
    if (this.tools.length > 0) {
      params.tools = (toolSelection ?? this.selectTools(
        options?.toolRouting?.allowedToolNames,
      )).tools;
    }

    return params;
  }

  private selectTools(
    allowedToolNames?: readonly string[],
  ): ToolSelectionDiagnostics {
    const providerCatalogToolCount = this.tools.length;
    const providerCatalogToolNames = this.tools.map((tool) => tool.function.name);
    if (allowedToolNames === undefined) {
      return {
        tools: this.tools,
        requestedToolNames: [],
        resolvedToolNames: providerCatalogToolNames,
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_no_filter",
        toolsAttached: true,
      };
    }

    if (allowedToolNames.length === 0) {
      return {
        tools: [],
        requestedToolNames: [],
        resolvedToolNames: [],
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_empty_filter",
        toolsAttached: false,
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
        requestedToolNames: [],
        resolvedToolNames: [],
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_empty_filter",
        toolsAttached: false,
      };
    }

    const requestedToolNames = [...allowed];
    const filtered = this.tools.filter((tool) => allowed.has(tool.function.name));
    const resolvedToolNames = filtered.map((tool) => tool.function.name);
    const missingRequestedToolNames = requestedToolNames.filter((name) =>
      !resolvedToolNames.includes(name)
    );
    if (filtered.length === 0) {
      return {
        tools: this.tools,
        requestedToolNames,
        resolvedToolNames: providerCatalogToolNames,
        missingRequestedToolNames: requestedToolNames,
        providerCatalogToolCount,
        toolResolution: "fallback_full_catalog_no_matches",
        toolsAttached: true,
      };
    }

    return {
      tools: filtered,
      requestedToolNames,
      resolvedToolNames,
      missingRequestedToolNames,
      providerCatalogToolCount,
      toolResolution:
        missingRequestedToolNames.length > 0 ? "subset_partial" : "subset_exact",
      toolsAttached: true,
    };
  }

  private buildUnsupportedDiagnostics(
    options?: LLMChatOptions,
  ): Pick<LLMResponse, "stateful" | "compaction"> {
    const hasSessionId =
      typeof options?.stateful?.sessionId === "string" &&
      options.stateful.sessionId.trim().length > 0;
    return {
      stateful: buildUnsupportedStatefulDiagnostics({
        provider: this.name,
        config: this.statefulConfig,
        hasSessionId,
      }),
      compaction: buildUnsupportedCompactionDiagnostics({
        provider: this.name,
        config: this.statefulConfig,
      }),
    };
  }

  private toOllamaMessage(msg: LLMMessage): Record<string, unknown> {
    if (msg.role === "tool") {
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

  private parseResponse(response: any, options?: LLMChatOptions): LLMResponse {
    const message = response.message ?? {};
    const content = message.content ?? "";

    const toolCalls: LLMToolCall[] = (message.tool_calls ?? [])
      .map((tc: any, i: number) =>
        validateToolCall({
          id: tc.function?.name ?? `call_${i}`,
          name: tc.function?.name ?? "",
          arguments: JSON.stringify(tc.function?.arguments ?? {}),
        }),
      )
      .filter(
        (toolCall: LLMToolCall | null): toolCall is LLMToolCall =>
          toolCall !== null,
      );

    const usage: LLMUsage = {
      promptTokens: response.prompt_eval_count ?? 0,
      completionTokens: response.eval_count ?? 0,
      totalTokens:
        (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
    };

    return {
      content,
      toolCalls,
      usage,
      model: response.model ?? this.config.model,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      ...this.buildUnsupportedDiagnostics(options),
    };
  }

  private mapError(err: unknown): Error {
    // Ollama-specific: connection refused means server isn't running
    const e = err as any;
    if (e?.code === "ECONNREFUSED") {
      return new LLMProviderError(
        this.name,
        `Cannot connect to Ollama at ${this.config.host}. Is the server running?`,
      );
    }

    return mapLLMError(this.name, err, this.config.timeoutMs ?? 0);
  }
}
