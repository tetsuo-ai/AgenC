/**
 * ChatExecutor — message-oriented LLM executor with cooldown-based fallback.
 *
 * Unlike LLMTaskExecutor (which takes on-chain Tasks and returns bigints),
 * ChatExecutor takes text messages and conversation history, returning string
 * responses. It adds cooldown-based provider fallback and session-level token
 * budget tracking.
 *
 * @module
 */

import type { GatewayMessage } from "../gateway/message.js";
import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMUsage,
  StreamProgressCallback,
  ToolHandler,
} from "./types.js";
import {
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "./errors.js";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

// ============================================================================
// Error classes
// ============================================================================

/**
 * Error thrown when a session's token budget is exceeded.
 */
export class ChatBudgetExceededError extends RuntimeError {
  public readonly sessionId: string;
  public readonly used: number;
  public readonly limit: number;

  constructor(sessionId: string, used: number, limit: number) {
    super(
      `Token budget exceeded for session "${sessionId}": ${used}/${limit}`,
      RuntimeErrorCodes.CHAT_BUDGET_EXCEEDED,
    );
    this.name = "ChatBudgetExceededError";
    this.sessionId = sessionId;
    this.used = used;
    this.limit = limit;
  }
}

// ============================================================================
// Injection interfaces
// ============================================================================

/** Injects skill context into a conversation. */
export interface SkillInjector {
  inject(message: string, sessionId: string): Promise<string | undefined>;
}

/** Retrieves memory context for a conversation. */
export interface MemoryRetriever {
  retrieve(message: string, sessionId: string): Promise<string | undefined>;
}

// ============================================================================
// Core types
// ============================================================================

/** Record of a single tool call execution. */
export interface ToolCallRecord {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly isError: boolean;
  readonly durationMs: number;
}

/** Parameters for a single ChatExecutor.execute() call. */
export interface ChatExecuteParams {
  readonly message: GatewayMessage;
  readonly history: readonly LLMMessage[];
  readonly systemPrompt: string;
  readonly sessionId: string;
  /** Per-call tool handler — overrides the constructor handler for this call. */
  readonly toolHandler?: ToolHandler;
  /** Per-call stream callback — overrides the constructor callback for this call. */
  readonly onStreamChunk?: StreamProgressCallback;
}

/** Result returned from ChatExecutor.execute(). */
export interface ChatExecutorResult {
  readonly content: string;
  readonly provider: string;
  readonly usedFallback: boolean;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly tokenUsage: LLMUsage;
  readonly durationMs: number;
}

/** Configuration for ChatExecutor construction. */
export interface ChatExecutorConfig {
  /** Ordered providers — first is primary, rest are fallbacks. */
  readonly providers: readonly LLMProvider[];
  readonly toolHandler?: ToolHandler;
  readonly maxToolRounds?: number;
  readonly onStreamChunk?: StreamProgressCallback;
  readonly skillInjector?: SkillInjector;
  readonly memoryRetriever?: MemoryRetriever;
  readonly allowedTools?: readonly string[];
  /**
   * Maximum token budget per session. Checked before each call — if cumulative
   * usage already meets or exceeds this value, the call is rejected with
   * `ChatBudgetExceededError`. This is a soft cap: the final call that pushes
   * usage over the limit will succeed, but subsequent calls will be blocked.
   */
  readonly sessionTokenBudget?: number;
  /** Base cooldown period for failed providers in ms (default: 60_000). */
  readonly providerCooldownMs?: number;
  /** Maximum cooldown period in ms (default: 300_000). */
  readonly maxCooldownMs?: number;
  /** Maximum tracked sessions before eviction (default: 10_000). */
  readonly maxTrackedSessions?: number;
}

// ============================================================================
// Internal types
// ============================================================================

interface CooldownEntry {
  availableAt: number;
  failures: number;
}

interface FallbackResult {
  response: LLMResponse;
  providerName: string;
  usedFallback: boolean;
}

// ============================================================================
// ChatExecutor
// ============================================================================

/**
 * Message-oriented LLM executor with cooldown-based provider fallback
 * and session-level token budget tracking.
 */
export class ChatExecutor {
  private readonly providers: readonly LLMProvider[];
  private readonly toolHandler?: ToolHandler;
  private readonly maxToolRounds: number;
  private readonly onStreamChunk?: StreamProgressCallback;
  private readonly allowedTools: Set<string> | null;
  private readonly sessionTokenBudget?: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxTrackedSessions: number;
  private readonly skillInjector?: SkillInjector;
  private readonly memoryRetriever?: MemoryRetriever;

  private readonly cooldowns = new Map<string, CooldownEntry>();
  private readonly sessionTokens = new Map<string, number>();

  constructor(config: ChatExecutorConfig) {
    if (!config.providers || config.providers.length === 0) {
      throw new Error("ChatExecutor requires at least one provider");
    }
    this.providers = config.providers;
    this.toolHandler = config.toolHandler;
    this.maxToolRounds = config.maxToolRounds ?? 10;
    this.onStreamChunk = config.onStreamChunk;
    this.allowedTools = config.allowedTools
      ? new Set(config.allowedTools)
      : null;
    this.sessionTokenBudget = config.sessionTokenBudget;
    this.cooldownMs = Math.max(0, config.providerCooldownMs ?? 60_000);
    this.maxCooldownMs = Math.max(0, config.maxCooldownMs ?? 300_000);
    this.maxTrackedSessions = Math.max(1, config.maxTrackedSessions ?? 10_000);
    this.skillInjector = config.skillInjector;
    this.memoryRetriever = config.memoryRetriever;
  }

  /**
   * Execute a chat message against the provider chain.
   */
  async execute(params: ChatExecuteParams): Promise<ChatExecutorResult> {
    const { message, history, systemPrompt, sessionId } = params;
    const activeToolHandler = params.toolHandler ?? this.toolHandler;
    const activeStreamCallback = params.onStreamChunk ?? this.onStreamChunk;
    const startTime = Date.now();

    // Pre-check token budget
    if (this.sessionTokenBudget !== undefined) {
      const used = this.sessionTokens.get(sessionId) ?? 0;
      if (used >= this.sessionTokenBudget) {
        throw new ChatBudgetExceededError(
          sessionId,
          used,
          this.sessionTokenBudget,
        );
      }
    }

    // Build messages array
    const messages: LLMMessage[] = [{ role: "system", content: systemPrompt }];

    // Skill injection (best-effort)
    if (this.skillInjector) {
      try {
        const skillContext = await this.skillInjector.inject(
          message.content,
          sessionId,
        );
        if (skillContext) {
          messages.push({ role: "system", content: skillContext });
        }
      } catch {
        // Skill injection failure is non-blocking
      }
    }

    // Memory retrieval (best-effort)
    if (this.memoryRetriever) {
      try {
        const memoryContext = await this.memoryRetriever.retrieve(
          message.content,
          sessionId,
        );
        if (memoryContext) {
          messages.push({ role: "system", content: memoryContext });
        }
      } catch {
        // Memory retrieval failure is non-blocking
      }
    }

    // Append history and user message
    messages.push(...history);

    // Build user message — multimodal if attachments with image data are present
    const imageAttachments = (message.attachments ?? []).filter(
      (a) => a.data && a.mimeType.startsWith("image/"),
    );
    if (imageAttachments.length > 0) {
      const contentParts: import("./types.js").LLMContentPart[] = [];
      if (message.content) {
        contentParts.push({ type: "text", text: message.content });
      }
      for (const att of imageAttachments) {
        const base64 = Buffer.from(att.data!).toString("base64");
        contentParts.push({
          type: "image_url",
          image_url: { url: `data:${att.mimeType};base64,${base64}` },
        });
      }
      messages.push({ role: "user", content: contentParts });
    } else {
      messages.push({ role: "user", content: message.content });
    }

    // First LLM call
    const cumulativeUsage: LLMUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const allToolCalls: ToolCallRecord[] = [];

    let { response, providerName, usedFallback } = await this.callWithFallback(
      messages,
      activeStreamCallback,
    );
    this.accumulateUsage(cumulativeUsage, response.usage);

    // Tool call loop
    let rounds = 0;
    while (
      response.finishReason === "tool_calls" &&
      response.toolCalls.length > 0 &&
      activeToolHandler &&
      rounds < this.maxToolRounds
    ) {
      rounds++;

      // Append the assistant message with tool calls
      messages.push({ role: "assistant", content: response.content });

      for (const toolCall of response.toolCalls) {
        // Allowlist check
        if (this.allowedTools && !this.allowedTools.has(toolCall.name)) {
          const errorResult = JSON.stringify({
            error: `Tool "${toolCall.name}" is not permitted`,
          });
          messages.push({
            role: "tool",
            content: errorResult,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          allToolCalls.push({
            name: toolCall.name,
            args: {},
            result: errorResult,
            isError: true,
            durationMs: 0,
          });
          continue;
        }

        // Parse arguments
        let args: Record<string, unknown>;
        try {
          const parsed = JSON.parse(toolCall.arguments) as unknown;
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            throw new Error("Tool arguments must be a JSON object");
          }
          args = parsed as Record<string, unknown>;
        } catch (parseErr) {
          const errorResult = JSON.stringify({
            error: `Invalid tool arguments: ${(parseErr as Error).message}`,
          });
          messages.push({
            role: "tool",
            content: errorResult,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          allToolCalls.push({
            name: toolCall.name,
            args: {},
            result: errorResult,
            isError: true,
            durationMs: 0,
          });
          continue;
        }

        // Execute tool
        const toolStart = Date.now();
        let result: string;
        let isError = false;
        try {
          result = await activeToolHandler!(toolCall.name, args);
        } catch (toolErr) {
          result = JSON.stringify({ error: (toolErr as Error).message });
          isError = true;
        }
        const toolDuration = Date.now() - toolStart;

        allToolCalls.push({
          name: toolCall.name,
          args,
          result,
          isError,
          durationMs: toolDuration,
        });

        // If the tool result contains a screenshot data URL, create multimodal
        // content parts so vision-capable LLMs can "see" the image.
        const dataUrlMatch = result.match(
          /data:image\/png;base64,([A-Za-z0-9+/=]+)/,
        );
        if (dataUrlMatch) {
          const dataUrl = dataUrlMatch[0];
          // Strip the base64 image from the text result to avoid duplication
          const textContent = result
            .replace(/"dataUrl"\s*:\s*"[^"]*"/, '"dataUrl":"(see image)"')
            .trim();
          messages.push({
            role: "tool",
            content: [
              { type: "image_url" as const, image_url: { url: dataUrl } },
              { type: "text" as const, text: textContent },
            ],
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
        } else {
          messages.push({
            role: "tool",
            content: result,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
        }
      }

      // Re-call LLM
      const next = await this.callWithFallback(messages, activeStreamCallback);
      response = next.response;
      providerName = next.providerName;
      if (next.usedFallback) usedFallback = true;
      this.accumulateUsage(cumulativeUsage, response.usage);
    }

    // Update session token budget
    this.trackTokenUsage(sessionId, cumulativeUsage.totalTokens);

    // If the LLM returned empty content after tool calls (common when maxToolRounds
    // is hit while the LLM still wanted to make more calls), generate a fallback
    // summary from the last successful tool result.
    let finalContent = response.content;
    if (!finalContent && allToolCalls.length > 0) {
      const lastSuccess = [...allToolCalls].reverse().find((tc) => !tc.isError);
      if (lastSuccess) {
        try {
          const parsed = JSON.parse(lastSuccess.result);
          if (parsed.taskPda) {
            finalContent = `Task created successfully.\n\n**Task PDA:** ${parsed.taskPda}\n**Transaction:** ${parsed.transactionSignature ?? 'confirmed'}`;
          } else if (parsed.agentPda) {
            finalContent = `Agent registered successfully.\n\n**Agent PDA:** ${parsed.agentPda}\n**Transaction:** ${parsed.transactionSignature ?? 'confirmed'}`;
          } else {
            finalContent = `Operation completed. Result:\n\`\`\`json\n${lastSuccess.result.slice(0, 500)}\n\`\`\``;
          }
        } catch {
          finalContent = `Operation completed. Result: ${lastSuccess.result.slice(0, 500)}`;
        }
      }
    }

    return {
      content: finalContent,
      provider: providerName,
      usedFallback,
      toolCalls: allToolCalls,
      tokenUsage: cumulativeUsage,
      durationMs: Date.now() - startTime,
    };
  }

  /** Get accumulated token usage for a session. */
  getSessionTokenUsage(sessionId: string): number {
    return this.sessionTokens.get(sessionId) ?? 0;
  }

  /** Reset token usage for a specific session. */
  resetSessionTokens(sessionId: string): void {
    this.sessionTokens.delete(sessionId);
  }

  /** Clear all session token tracking. */
  clearAllSessionTokens(): void {
    this.sessionTokens.clear();
  }

  /** Clear all provider cooldowns. */
  clearCooldowns(): void {
    this.cooldowns.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async callWithFallback(
    messages: LLMMessage[],
    onStreamChunk?: StreamProgressCallback,
  ): Promise<FallbackResult> {
    let lastError: Error | undefined;
    const now = Date.now();

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const cooldown = this.cooldowns.get(provider.name);

      if (cooldown && cooldown.availableAt > now) {
        continue;
      }

      try {
        let response: LLMResponse;
        if (onStreamChunk) {
          response = await provider.chatStream(messages, onStreamChunk);
        } else {
          response = await provider.chat(messages);
        }

        if (response.finishReason === "error") {
          throw (
            response.error ??
            new LLMProviderError(provider.name, "Provider returned error")
          );
        }

        // Success — clear cooldown
        this.cooldowns.delete(provider.name);

        return {
          response,
          providerName: provider.name,
          usedFallback: i > 0,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (!this.shouldFallback(lastError)) {
          throw lastError;
        }

        // Apply cooldown
        const failures = (this.cooldowns.get(provider.name)?.failures ?? 0) + 1;
        const cooldownDuration =
          err instanceof LLMRateLimitError && err.retryAfterMs
            ? err.retryAfterMs
            : Math.min(this.cooldownMs * failures, this.maxCooldownMs);
        this.cooldowns.set(provider.name, {
          availableAt: Date.now() + cooldownDuration,
          failures,
        });
      }
    }

    if (lastError) {
      throw lastError;
    }
    // All providers were skipped (in cooldown) — no provider was attempted
    throw new LLMProviderError(
      "chat-executor",
      "All providers are in cooldown",
    );
  }

  private shouldFallback(err: Error): boolean {
    // Only fall back on transient errors. LLMProviderError (e.g. 400 Bad Request)
    // and LLMAuthenticationError are not transient — retrying with a different
    // provider for malformed requests or config issues won't help.
    return (
      err instanceof LLMTimeoutError ||
      err instanceof LLMServerError ||
      err instanceof LLMRateLimitError
    );
  }

  private accumulateUsage(cumulative: LLMUsage, usage: LLMUsage): void {
    cumulative.promptTokens += usage.promptTokens;
    cumulative.completionTokens += usage.completionTokens;
    cumulative.totalTokens += usage.totalTokens;
  }

  private trackTokenUsage(sessionId: string, tokens: number): void {
    const current = this.sessionTokens.get(sessionId) ?? 0;

    // Delete-then-reinsert to maintain LRU order (most recent at end)
    this.sessionTokens.delete(sessionId);
    this.sessionTokens.set(sessionId, current + tokens);

    // Evict least-recently-used entries if over capacity
    if (this.sessionTokens.size > this.maxTrackedSessions) {
      const oldest = this.sessionTokens.keys().next().value;
      if (oldest !== undefined) {
        this.sessionTokens.delete(oldest);
      }
    }
  }
}
