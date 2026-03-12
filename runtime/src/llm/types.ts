/**
 * LLM provider types for @agenc/runtime
 *
 * Defines the core interfaces for LLM adapters that bridge
 * language model providers to the AgenC task execution system.
 *
 * @module
 */

/**
 * Message role in a conversation
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Assistant message phase for long-running/tool-heavy flows.
 *
 * Preserved in local history so providers that support phase-aware replay can
 * distinguish working commentary from the completed answer.
 */
export type LLMAssistantPhase = "commentary" | "final_answer";

/**
 * A content part for multimodal messages (OpenAI/Grok-compatible format).
 */
export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * A single message in an LLM conversation.
 *
 * `content` may be a plain string or an array of content parts for multimodal
 * messages (e.g. text + images). Providers that don't support multimodal should
 * extract the text parts and ignore image parts.
 */
export interface LLMMessage {
  role: MessageRole;
  content: string | LLMContentPart[];
  /** Optional assistant phase metadata for phase-aware replay/continuation. */
  phase?: LLMAssistantPhase;
  /** For assistant messages that request tool execution */
  toolCalls?: LLMToolCall[];
  /** For tool result messages — the ID of the tool call being responded to */
  toolCallId?: string;
  /** For tool result messages — the name of the tool */
  toolName?: string;
}

/**
 * Tool definition in OpenAI-compatible format
 */
export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A tool call requested by the LLM
 */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Token usage statistics
 */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Provider-specific request-shape diagnostics for one LLM call.
 *
 * These values are intended for observability/debugging (not billing).
 */
export interface LLMRequestMetrics {
  messageCount: number;
  systemMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolMessages: number;
  totalContentChars: number;
  maxMessageChars: number;
  textParts: number;
  imageParts: number;
  toolCount: number;
  toolNames: readonly string[];
  requestedToolNames?: readonly string[];
  missingRequestedToolNames?: readonly string[];
  toolResolution?: string;
  providerCatalogToolCount?: number;
  toolsAttached?: boolean;
  toolSuppressionReason?: string;
  toolChoice?: string;
  toolSchemaChars: number;
  serializedChars: number;
  previousResponseId?: string;
  statefulInputMode?: "full_replay" | "incremental_delta";
  statefulOmittedMessageCount?: number;
  store?: boolean;
  parallelToolCalls?: boolean;
  stream?: boolean;
}

/**
 * Stateful response fallback reasons when continuation cannot be used.
 */
export type LLMStatefulFallbackReason =
  | "missing_previous_response_id"
  | "provider_retrieval_failure"
  | "state_reconciliation_mismatch"
  | "unsupported";

/**
 * Structured stateful event types for trace logging/diagnostics.
 */
export type LLMStatefulEventType =
  | "stateful_continuation_attempt"
  | "stateful_continuation_success"
  | "stateful_fallback"
  | "state_reconciliation_mismatch";

/**
 * A single stateful-mode diagnostic event.
 */
export interface LLMStatefulEvent {
  readonly type: LLMStatefulEventType;
  readonly reason?: LLMStatefulFallbackReason;
  readonly detail?: string;
}

/**
 * Per-call diagnostics for provider-managed stateful continuation.
 */
export interface LLMStatefulDiagnostics {
  /** True when provider-level stateful mode is enabled for this call. */
  readonly enabled: boolean;
  /** True when this call attempted to continue from a previous response ID. */
  readonly attempted: boolean;
  /** True when `previous_response_id` was accepted and used. */
  readonly continued: boolean;
  /** Explicit `store` value sent to the provider for this call. */
  readonly store: boolean;
  /** Fallback policy used for this call. */
  readonly fallbackToStateless: boolean;
  /** Previously persisted response ID used for continuation (if any). */
  readonly previousResponseId?: string;
  /** New response ID returned by the provider (if any). */
  readonly responseId?: string;
  /** Reconciliation anchor hash for this call (provider-defined). */
  readonly reconciliationHash?: string;
  /** Previous reconciliation anchor restored from local/provider session state. */
  readonly previousReconciliationHash?: string;
  /** Number of messages used to compute the reconciliation chain for this call. */
  readonly reconciliationMessageCount?: number;
  /** Which message set was used to build the reconciliation chain. */
  readonly reconciliationSource?: "non_system_messages" | "all_messages";
  /** Whether the restored anchor hash matched the current reconciliation chain. */
  readonly anchorMatched?: boolean;
  /**
   * True when the runtime compacted local history after the previous anchor was
   * recorded, so a mismatch can be expected.
   */
  readonly historyCompacted?: boolean;
  /**
   * True when continuation proceeded despite a mismatch because the runtime
   * trusted its own compaction boundary.
   */
  readonly compactedHistoryTrusted?: boolean;
  /** Fallback reason when continuation was bypassed or retried statelessly. */
  readonly fallbackReason?: LLMStatefulFallbackReason;
  /** Structured trace events emitted during stateful decisioning. */
  readonly events?: readonly LLMStatefulEvent[];
}

/**
 * Provider-native compaction fallback reasons when an opaque server-side
 * compaction mode cannot stay enabled for a request.
 */
export type LLMCompactionFallbackReason =
  | "unsupported"
  | "request_rejected";

/**
 * Opaque provider compaction item metadata.
 *
 * The runtime stores only identifiers/digests needed for tracing and replay;
 * the payload itself stays provider-owned and out-of-band.
 */
export interface LLMCompactionItemRef {
  /** Provider-emitted item type, e.g. `compaction` or equivalent. */
  readonly type: string;
  /** Provider-emitted item identifier when available. */
  readonly id?: string;
  /** Stable digest over the opaque item for replay/debug correlation. */
  readonly digest: string;
}

/**
 * Per-call diagnostics for provider-native context compaction.
 */
export interface LLMCompactionDiagnostics {
  /** True when provider-native compaction is enabled in config for this call. */
  readonly enabled: boolean;
  /** True when the initial request attempted provider-native compaction. */
  readonly requested: boolean;
  /** True when the final request sent to the provider still included compaction. */
  readonly active: boolean;
  /** Provider-specific compaction mode used for the call. */
  readonly mode: "server_side_context_management";
  /** Configured compaction threshold sent to the provider. */
  readonly threshold: number;
  /** Number of opaque compaction items observed in the provider response. */
  readonly observedItemCount: number;
  /** Latest opaque compaction item returned by the provider, if any. */
  readonly latestItem?: LLMCompactionItemRef;
  /** Fallback reason when compaction had to be disabled for the call. */
  readonly fallbackReason?: LLMCompactionFallbackReason;
}

/**
 * Shared provider-managed stateful continuation controls.
 *
 * Providers may fully support these controls, ignore them with explicit
 * unsupported diagnostics, or selectively support subsets such as
 * `previous_response_id` without opaque compaction.
 */
export interface LLMStatefulResponsesConfig {
  /** Enable session-scoped continuation using provider-managed response IDs. */
  readonly enabled?: boolean;
  /** Explicit `store` value sent to provider calls while stateful mode is enabled. */
  readonly store?: boolean;
  /** Retry once statelessly when continuation anchors are missing/mismatched/stale. */
  readonly fallbackToStateless?: boolean;
  /** Number of recent normalized turns used for reconciliation hashing. */
  readonly reconciliationWindow?: number;
  /** Optional provider-native opaque compaction controls. */
  readonly compaction?: {
    /** Enable provider-native server-side compaction. */
    readonly enabled?: boolean;
    /** Rendered-token threshold for provider compaction. */
    readonly compactThreshold?: number;
    /** Retry once without compaction if the provider rejects the field. */
    readonly fallbackOnUnsupported?: boolean;
  };
}

export interface LLMProviderStatefulCapabilities {
  /** Provider supports assistant `phase` replay metadata. */
  readonly assistantPhase: boolean;
  /** Provider supports `previous_response_id` / equivalent continuation. */
  readonly previousResponseId: boolean;
  /** Provider supports opaque provider-managed compaction state. */
  readonly opaqueCompaction: boolean;
  /** Runtime can safely fall back to stateless replay for unsupported features. */
  readonly deterministicFallback: boolean;
}

export interface LLMProviderCapabilities {
  /** Provider name exposed by the adapter. */
  readonly provider: string;
  /** Stateful continuation and compaction feature support. */
  readonly stateful: LLMProviderStatefulCapabilities;
}

/**
 * Persisted provider-managed continuation anchor.
 *
 * Stored by the runtime so a daemon restart can restore provider-native
 * continuation state instead of falling back to stateless replay.
 */
export interface LLMStatefulResumeAnchor {
  /** Response ID that should be used as `previous_response_id` when resuming. */
  readonly previousResponseId: string;
  /** Provider reconciliation hash captured when the anchor was created. */
  readonly reconciliationHash?: string;
}

/**
 * Optional stateful continuation hints passed to provider calls.
 */
export interface LLMChatStatefulOptions {
  /** Session key used by providers to scope response-id anchors. */
  readonly sessionId: string;
  /** Persisted continuation anchor restored by the runtime after restart. */
  readonly resumeAnchor?: LLMStatefulResumeAnchor;
  /**
   * True when the local session manager compacted history after the previous
   * anchor was recorded.
   */
  readonly historyCompacted?: boolean;
  /**
   * Full local dialogue lineage used only for reconciliation hashing.
   *
   * This lets the runtime keep provider prompt payloads budgeted/truncated
   * while still validating `previous_response_id` against the complete local
   * conversation state.
   */
  readonly reconciliationMessages?: readonly LLMMessage[];
}

/**
 * Optional turn-time tool routing hints passed to provider calls.
 */
export interface LLMChatToolRoutingOptions {
  /**
   * Restrict provider-advertised tools for this call to this allowlist.
   * Unknown tool names are ignored by providers.
   */
  readonly allowedToolNames?: readonly string[];
}

export interface LLMProviderTraceEvent {
  readonly kind: "request" | "response" | "error";
  readonly transport: "chat" | "chat_stream";
  readonly provider: string;
  readonly model?: string;
  readonly callIndex?: number;
  readonly callPhase?:
    | "compaction"
    | "initial"
    | "planner"
    | "planner_verifier"
    | "planner_synthesis"
    | "tool_followup"
    | "evaluator"
    | "evaluator_retry";
  readonly payload: Record<string, unknown>;
  readonly context?: Record<string, unknown>;
}

export interface LLMChatTraceOptions {
  /** Emit raw provider request/response/error payloads through the trace callback. */
  readonly includeProviderPayloads?: boolean;
  /** Callback invoked with provider-native request/response/error payloads. */
  readonly onProviderTraceEvent?: (event: LLMProviderTraceEvent) => void;
}

/**
 * Provider-agnostic tool-choice directive for one model call.
 */
export type LLMToolChoice =
  | "auto"
  | "required"
  | "none"
  | {
    readonly type: "function";
    readonly name: string;
  };

/**
 * Optional provider call options.
 */
export interface LLMChatOptions {
  readonly stateful?: LLMChatStatefulOptions;
  readonly toolRouting?: LLMChatToolRoutingOptions;
  readonly toolChoice?: LLMToolChoice;
  readonly trace?: LLMChatTraceOptions;
  /** Upper bound for this individual provider call. */
  readonly timeoutMs?: number;
  /** Abort signal propagated from the runtime when the request is cancelled. */
  readonly signal?: AbortSignal;
}

export interface LLMProviderEvidence {
  readonly citations?: readonly string[];
}

/**
 * Response from an LLM provider
 */
export interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
  usage: LLMUsage;
  model: string;
  /** Provider-computed request diagnostics for this call. */
  requestMetrics?: LLMRequestMetrics;
  /** Stateful continuation diagnostics, when supported by the provider. */
  stateful?: LLMStatefulDiagnostics;
  /** Provider-native compaction diagnostics, when supported by the provider. */
  compaction?: LLMCompactionDiagnostics;
  /** Provider-side evidence from built-in/server-side tools. */
  providerEvidence?: LLMProviderEvidence;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  /** Underlying error when finishReason is "error". */
  error?: Error;
  /** True if partial content was received before an error. */
  partial?: boolean;
}

/**
 * A chunk from a streaming LLM response
 */
export interface LLMStreamChunk {
  content: string;
  done: boolean;
  toolCalls?: LLMToolCall[];
}

/**
 * Callback for streaming progress updates
 */
export type StreamProgressCallback = (chunk: LLMStreamChunk) => void;

/**
 * Handler for tool calls — maps tool name + arguments to a string result
 */
export type ToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * Core LLM provider interface that all adapters implement
 */
export interface LLMProvider {
  readonly name: string;
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse>;
  chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse>;
  healthCheck(): Promise<boolean>;
  /** Report provider-native continuation / compaction support. */
  getCapabilities?(): LLMProviderCapabilities;
  /** Optional lifecycle hook for session-scoped provider state cleanup. */
  resetSessionState?(sessionId: string): void;
  /** Optional lifecycle hook to clear all provider-managed session state. */
  clearSessionState?(): void;
}

/**
 * Shared configuration for all LLM providers
 */
export interface LLMProviderConfig {
  /** Model identifier (e.g. 'grok-3', 'claude-sonnet-4-5-20250929', 'llama3') */
  model: string;
  /** System prompt prepended to conversations */
  systemPrompt?: string;
  /** Sampling temperature (0.0 - 2.0) */
  temperature?: number;
  /** Maximum tokens in the response */
  maxTokens?: number;
  /** Tools available to the model */
  tools?: LLMTool[];
  /** Handler called when the model invokes a tool */
  toolHandler?: ToolHandler;
  /** Maximum tool call rounds before forcing a text response (default: 10) */
  maxToolRounds?: number;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Maximum automatic retries on transient failures */
  maxRetries?: number;
  /** Base delay between retries in milliseconds */
  retryDelayMs?: number;
}

/**
 * Decode HTML entities that some LLMs (e.g. Grok) emit in tool call arguments.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Validate/sanitize a raw tool call payload.
 *
 * Ensures `id` and `name` are non-empty strings, and `arguments` is a JSON string.
 * Decodes HTML entities both in the JSON string and in parsed string values.
 */
export function validateToolCall(raw: unknown): LLMToolCall | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const argumentsRaw = candidate.arguments;

  if (!id || !name || typeof argumentsRaw !== "string") {
    return null;
  }

  // Decode the JSON string itself (entities in JSON syntax)
  const decoded = decodeHtmlEntities(argumentsRaw);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Also decode entities inside parsed string values (entities within JSON values)
  for (const key of Object.keys(parsed)) {
    if (typeof parsed[key] === "string") {
      parsed[key] = decodeHtmlEntities(parsed[key] as string);
    }
  }

  return {
    id,
    name,
    arguments: JSON.stringify(parsed),
  };
}
