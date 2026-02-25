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
  /** Abort signal — when aborted, the executor stops after the current tool call. */
  readonly signal?: AbortSignal;
}

/** Result returned from ChatExecutor.execute(). */
export interface ChatExecutorResult {
  readonly content: string;
  readonly provider: string;
  readonly usedFallback: boolean;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly tokenUsage: LLMUsage;
  readonly durationMs: number;
  /** True if conversation history was compacted during this execution. */
  readonly compacted: boolean;
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
   * Maximum token budget per session. When cumulative usage meets or exceeds
   * this value, the executor attempts to compact conversation history by
   * summarizing older messages. If compaction fails, falls back to
   * `ChatBudgetExceededError`.
   */
  readonly sessionTokenBudget?: number;
  /** Callback when context compaction occurs (budget recovery). */
  readonly onCompaction?: (sessionId: string, summary: string) => void;
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
  private readonly onCompaction?: (sessionId: string, summary: string) => void;

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
    this.onCompaction = config.onCompaction;
  }

  /**
   * Execute a chat message against the provider chain.
   */
  async execute(params: ChatExecuteParams): Promise<ChatExecutorResult> {
    const { message, systemPrompt, sessionId, signal } = params;
    let { history } = params;
    const activeToolHandler = params.toolHandler ?? this.toolHandler;
    const activeStreamCallback = params.onStreamChunk ?? this.onStreamChunk;
    const startTime = Date.now();

    // Pre-check token budget — attempt compaction instead of hard fail
    let compacted = false;
    if (this.sessionTokenBudget !== undefined) {
      const used = this.sessionTokens.get(sessionId) ?? 0;
      if (used >= this.sessionTokenBudget) {
        try {
          history = await this.compactHistory(history, sessionId);
          this.resetSessionTokens(sessionId);
          compacted = true;
        } catch {
          throw new ChatBudgetExceededError(
            sessionId,
            used,
            this.sessionTokenBudget,
          );
        }
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
    // Deduplicate side-effect tools across ALL rounds: prevent the model
    // from opening 3 YouTube tabs or running the same AppleScript 3 times.
    // system.open: opening multiple URLs is never desired
    // system.applescript: one script per request should suffice (multi-step
    // actions like "open terminal + write hello" belong in a single script)
    // Group-level dedup: once ANY side-effect tool executes, skip all others.
    // This prevents the model from opening Terminal 3x via system.open + system.applescript
    // + system.bash("open Terminal") in a single round with different tool names.
    const SIDE_EFFECT_TOOLS = new Set(["system.open", "system.applescript"]);
    let sideEffectExecuted = false;
    while (
      response.finishReason === "tool_calls" &&
      response.toolCalls.length > 0 &&
      activeToolHandler &&
      rounds < this.maxToolRounds
    ) {
      // Check for cancellation before each round
      if (signal?.aborted) break;

      rounds++;

      // Append the assistant message with tool calls
      messages.push({ role: "assistant", content: response.content });
      for (const toolCall of response.toolCalls) {
        if (SIDE_EFFECT_TOOLS.has(toolCall.name) && sideEffectExecuted) {
          const skipResult = JSON.stringify({
            error: `Skipped "${toolCall.name}" — a desktop action was already performed. Combine actions into a single tool call.`,
          });
          messages.push({
            role: "tool",
            content: skipResult,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          allToolCalls.push({
            name: toolCall.name,
            args: {},
            result: skipResult,
            isError: true,
            durationMs: 0,
          });
          continue;
        }
        if (SIDE_EFFECT_TOOLS.has(toolCall.name)) sideEffectExecuted = true;

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

      // Check for cancellation before re-calling LLM
      if (signal?.aborted) break;

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
      // Try to build a descriptive summary from the tool calls themselves
      const successes = allToolCalls.filter((tc) => !tc.isError);
      const lastSuccess = successes[successes.length - 1];
      if (lastSuccess) {
        try {
          const parsed = JSON.parse(lastSuccess.result);
          if (parsed.taskPda) {
            finalContent = `Task created successfully.\n\n**Task PDA:** ${parsed.taskPda}\n**Transaction:** ${parsed.transactionSignature ?? 'confirmed'}`;
          } else if (parsed.agentPda) {
            finalContent = `Agent registered successfully.\n\n**Agent PDA:** ${parsed.agentPda}\n**Transaction:** ${parsed.transactionSignature ?? 'confirmed'}`;
          } else if (parsed.success === true || parsed.exitCode === 0 || parsed.output !== undefined) {
            // System tool succeeded — build a descriptive message from tool calls
            // Generate context-aware summary from tool names + args
            const summaries: string[] = [];
            for (const tc of successes) {
              if (tc.name === "system.open") {
                const target = String(tc.args?.target ?? "");
                if (target.includes("youtube.com/watch")) {
                  summaries.push(`Opened YouTube video`);
                } else if (target.includes("youtube.com")) {
                  summaries.push(`Opened YouTube`);
                } else if (target) {
                  summaries.push(`Opened ${target.slice(0, 80)}`);
                }
              } else if (tc.name === "system.bash") {
                // For bash commands, show actual output if available
                try {
                  const bashResult = JSON.parse(tc.result);
                  const bashOutput = bashResult.stdout || bashResult.output || "";
                  if (bashOutput.trim()) {
                    summaries.push(bashOutput.trim().slice(0, 2000));
                  } else {
                    const cmd = String(tc.args?.command ?? "").slice(0, 60);
                    if (cmd) summaries.push(`Ran: ${cmd}`);
                  }
                } catch {
                  const cmd = String(tc.args?.command ?? "").slice(0, 60);
                  if (cmd) summaries.push(`Ran: ${cmd}`);
                }
              } else if (tc.name === "system.applescript") {
                const script = String(tc.args?.script ?? "");
                if (script.includes("do script")) {
                  summaries.push("Opened Terminal and ran the command");
                } else if (script.includes("activate")) {
                  summaries.push("Brought app to front");
                } else if (script.includes("quit")) {
                  summaries.push("Closed the app");
                } else {
                  summaries.push("Done");
                }
              } else if (tc.name === "system.notification") {
                summaries.push("Notification sent");
              } else {
                summaries.push("Done");
              }
            }
            finalContent = summaries.length > 0 ? summaries.join("\n") : "Done!";
          } else if (parsed.error) {
            finalContent = `Something went wrong: ${String(parsed.error).slice(0, 300)}`;
          } else if (parsed.exitCode != null && parsed.exitCode !== 0) {
            const errOutput = parsed.stderr || parsed.stdout || "";
            finalContent = errOutput.trim()
              ? `Command failed: ${String(errOutput).slice(0, 300)}`
              : "The command failed. Let me try a different approach.";
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
      compacted,
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

  // --------------------------------------------------------------------------
  // Context compaction
  // --------------------------------------------------------------------------

  /** Max chars of history text sent to the summarization call. */
  private static readonly MAX_COMPACT_INPUT = 20_000;

  private async compactHistory(
    history: readonly LLMMessage[],
    sessionId: string,
  ): Promise<LLMMessage[]> {
    if (history.length <= 5) return [...history];

    const keepCount = 5;
    const toSummarize = history.slice(0, history.length - keepCount);
    const toKeep = history.slice(-keepCount);

    let historyText = toSummarize
      .map((m) => {
        const content =
          typeof m.content === "string"
            ? m.content
            : (m.content as Array<{ type: string; text?: string }>)
                .filter(
                  (p): p is { type: "text"; text: string } =>
                    p.type === "text",
                )
                .map((p) => p.text)
                .join(" ");
        return `[${m.role}] ${content.slice(0, 500)}`;
      })
      .join("\n");

    if (historyText.length > ChatExecutor.MAX_COMPACT_INPUT) {
      historyText = historyText.slice(-ChatExecutor.MAX_COMPACT_INPUT);
    }

    const { response } = await this.callWithFallback([
      {
        role: "system",
        content:
          "Summarize this conversation history concisely. Preserve: key decisions made, " +
          "tool results and their outcomes, unresolved questions, and important context. " +
          "Omit pleasantries and redundant exchanges. Output only the summary.",
      },
      { role: "user", content: historyText },
    ]);

    const summary = response.content;

    if (this.onCompaction) {
      try {
        this.onCompaction(sessionId, summary);
      } catch {
        /* non-blocking */
      }
    }

    return [
      {
        role: "system" as const,
        content: `[Conversation summary]\n${summary}`,
      },
      ...toKeep,
    ];
  }
}
