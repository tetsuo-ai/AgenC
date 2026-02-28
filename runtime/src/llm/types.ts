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
  toolSchemaChars: number;
  serializedChars: number;
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
  chat(messages: LLMMessage[]): Promise<LLMResponse>;
  chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
  ): Promise<LLMResponse>;
  healthCheck(): Promise<boolean>;
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
