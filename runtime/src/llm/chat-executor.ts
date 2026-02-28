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
import { safeStringify } from "../tools/types.js";

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
  /** Per-call tool round limit — overrides the constructor default. */
  readonly maxToolRounds?: number;
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
  /** Result of response evaluation, if evaluator is configured. */
  readonly evaluation?: EvaluationResult;
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
  /** Optional response evaluator/critic configuration. */
  readonly evaluator?: EvaluatorConfig;
  /** Optional provider that injects self-learning context per message. */
  readonly learningProvider?: MemoryRetriever;
  /** Optional provider that injects cross-session progress context per message. */
  readonly progressProvider?: MemoryRetriever;
  /** Base cooldown period for failed providers in ms (default: 60_000). */
  readonly providerCooldownMs?: number;
  /** Maximum cooldown period in ms (default: 300_000). */
  readonly maxCooldownMs?: number;
  /** Maximum tracked sessions before eviction (default: 10_000). */
  readonly maxTrackedSessions?: number;
}

// ============================================================================
// Evaluator types
// ============================================================================

/** Configuration for optional response evaluation/critic. */
export interface EvaluatorConfig {
  readonly rubric?: string;
  /** Minimum score (0.0–1.0) to accept the response. Default: 0.7. */
  readonly minScore?: number;
  /** Maximum retry attempts when score is below threshold. Default: 1. */
  readonly maxRetries?: number;
}

/** Result of a response evaluation. */
export interface EvaluationResult {
  readonly score: number;
  readonly feedback: string;
  readonly passed: boolean;
  readonly retryCount: number;
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
// Constants
// ============================================================================

/** Max chars for URL preview in tool summaries. */
const MAX_URL_PREVIEW_CHARS = 80;
/** Max chars for bash output in tool summaries. */
const MAX_BASH_OUTPUT_CHARS = 2000;
/** Max chars for command preview in tool summaries. */
const MAX_COMMAND_PREVIEW_CHARS = 60;
/**
 * Max consecutive identical failing tool calls before the loop is broken.
 * When the LLM calls the same tool with the same arguments and gets an error
 * N times in a row, we inject a hint after (N-1) and break after N.
 */
const MAX_CONSECUTIVE_IDENTICAL_FAILURES = 3;
/** Max chars for JSON result previews. */
const MAX_RESULT_PREVIEW_CHARS = 500;
/** Max chars for error message previews. */
const MAX_ERROR_PREVIEW_CHARS = 300;
/** Max chars of user message sent to the evaluator. */
const MAX_EVAL_USER_CHARS = 500;
/** Max chars of response sent to the evaluator. */
const MAX_EVAL_RESPONSE_CHARS = 2000;
/**
 * macOS native tools that cause visible side-effects (opening apps, running scripts).
 * Once any tool in this set executes, further calls to ANY tool in the set are
 * skipped for the remainder of the request. This prevents the model from e.g.
 * opening 3 YouTube tabs.
 *
 * NOTE: Desktop sandbox tools (`desktop.*`) are intentionally excluded — multi-step
 * desktop automation (click → type → screenshot → verify) needs repeated calls.
 */
const MACOS_SIDE_EFFECT_TOOLS = new Set([
  "system.open",
  "system.applescript",
  "system.notification",
]);

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
  private readonly learningProvider?: MemoryRetriever;
  private readonly progressProvider?: MemoryRetriever;
  private readonly onCompaction?: (sessionId: string, summary: string) => void;
  private readonly evaluator?: EvaluatorConfig;

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
    this.learningProvider = config.learningProvider;
    this.progressProvider = config.progressProvider;
    this.onCompaction = config.onCompaction;
    this.evaluator = config.evaluator;
  }

  /**
   * Execute a chat message against the provider chain.
   */
  async execute(params: ChatExecuteParams): Promise<ChatExecutorResult> {
    const { message, systemPrompt, sessionId, signal, maxToolRounds: paramMaxToolRounds } = params;
    let { history } = params;
    const activeToolHandler = params.toolHandler ?? this.toolHandler;
    const activeStreamCallback = params.onStreamChunk ?? this.onStreamChunk;
    const effectiveMaxToolRounds = paramMaxToolRounds ?? this.maxToolRounds;
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

    // Context injection — skill, memory, and learning (all best-effort)
    const messageText = ChatExecutor.extractMessageText(message);
    await this.injectContext(this.skillInjector, messageText, sessionId, messages);
    await this.injectContext(this.memoryRetriever, messageText, sessionId, messages);
    await this.injectContext(this.learningProvider, messageText, sessionId, messages);
    await this.injectContext(this.progressProvider, messageText, sessionId, messages);

    // Append history and user message
    messages.push(...history);

    ChatExecutor.appendUserMessage(messages, message);

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

    // Tool call loop — side-effect deduplication prevents the model from
    // repeating desktop actions (e.g. opening 3 YouTube tabs). Once ANY
    // side-effect tool executes, all others are skipped for this request.
    let rounds = 0;
    let sideEffectExecuted = false;
    // Track consecutive identical failing calls to break stuck loops
    // (e.g. LLM calling `desktop.bash mkdir` with no args 5 times in a row).
    let lastFailKey = "";
    let consecutiveFailCount = 0;
    while (
      response.finishReason === "tool_calls" &&
      response.toolCalls.length > 0 &&
      activeToolHandler &&
      rounds < effectiveMaxToolRounds
    ) {
      // Check for cancellation before each round
      if (signal?.aborted) break;

      rounds++;

      // Append the assistant message with tool calls
      messages.push({ role: "assistant", content: response.content });
      for (const toolCall of response.toolCalls) {
        if (MACOS_SIDE_EFFECT_TOOLS.has(toolCall.name) && sideEffectExecuted) {
          const skipResult = safeStringify({
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
        if (MACOS_SIDE_EFFECT_TOOLS.has(toolCall.name)) sideEffectExecuted = true;

        // Allowlist check
        if (this.allowedTools && !this.allowedTools.has(toolCall.name)) {
          const errorResult = safeStringify({
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
          const errorResult = safeStringify({
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
          result = safeStringify({ error: (toolErr as Error).message });
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

        // Track consecutive identical failures to detect stuck loops.
        // Key on tool name + JSON args so "mkdir" with no args is distinct
        // from "mkdir -p crypto-tracker".
        const failDetected = isError || result.includes('"exitCode":1') || result.includes('"exitCode":2');
        const failKey = failDetected ? `${toolCall.name}:${toolCall.arguments}` : "";
        if (failDetected && failKey === lastFailKey) {
          consecutiveFailCount++;
        } else {
          lastFailKey = failKey;
          consecutiveFailCount = failDetected ? 1 : 0;
        }

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

      // Break stuck loops — if the same tool with the same args has failed
      // N times consecutively, stop the loop entirely.
      if (consecutiveFailCount >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
        break;
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
      finalContent =
        ChatExecutor.generateFallbackContent(allToolCalls) ?? finalContent;
    }

    // Response evaluation (optional critic)
    let evaluation: EvaluationResult | undefined;
    if (this.evaluator && finalContent) {
      const minScore = this.evaluator.minScore ?? 0.7;
      const maxRetries = this.evaluator.maxRetries ?? 1;
      let retryCount = 0;
      let currentContent = finalContent;

      while (retryCount <= maxRetries) {
        // Skip evaluation if token budget would be exceeded
        if (this.sessionTokenBudget !== undefined) {
          const used = this.sessionTokens.get(sessionId) ?? 0;
          if (used >= this.sessionTokenBudget) break;
        }

        const evalResult = await this.evaluateResponse(
          currentContent,
          messageText,
        );
        this.accumulateUsage(cumulativeUsage, evalResult.usage);
        this.trackTokenUsage(sessionId, evalResult.usage.totalTokens);

        if (evalResult.score >= minScore || retryCount === maxRetries) {
          evaluation = {
            score: evalResult.score,
            feedback: evalResult.feedback,
            passed: evalResult.score >= minScore,
            retryCount,
          };
          finalContent = currentContent;
          break;
        }

        retryCount++;
        messages.push(
          { role: "assistant", content: currentContent },
          {
            role: "system",
            content: `Response scored ${evalResult.score.toFixed(2)}. Feedback: ${evalResult.feedback}\nPlease improve your response.`,
          },
        );
        const retry = await this.callWithFallback(messages, activeStreamCallback);
        this.accumulateUsage(cumulativeUsage, retry.response.usage);
        this.trackTokenUsage(sessionId, retry.response.usage.totalTokens);
        currentContent = retry.response.content || currentContent;
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
      evaluation,
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

  /** Extract plain-text content from a gateway message. */
  private static extractMessageText(message: GatewayMessage): string {
    return typeof message.content === "string" ? message.content : "";
  }

  /** Append a user message, handling multimodal (image) attachments. */
  private static appendUserMessage(
    messages: LLMMessage[],
    message: GatewayMessage,
  ): void {
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
  }

  /**
   * Build a human-readable fallback when the LLM returned empty content
   * after tool calls (e.g. when maxToolRounds is hit mid-loop).
   */
  private static generateFallbackContent(
    allToolCalls: readonly ToolCallRecord[],
  ): string | undefined {
    const successes = allToolCalls.filter((tc) => !tc.isError);
    const lastSuccess = successes[successes.length - 1];
    if (!lastSuccess) return undefined;

    try {
      const parsed = JSON.parse(lastSuccess.result);
      if (parsed.taskPda) {
        return `Task created successfully.\n\n**Task PDA:** ${parsed.taskPda}\n**Transaction:** ${parsed.transactionSignature ?? "confirmed"}`;
      }
      if (parsed.agentPda) {
        return `Agent registered successfully.\n\n**Agent PDA:** ${parsed.agentPda}\n**Transaction:** ${parsed.transactionSignature ?? "confirmed"}`;
      }
      if (
        parsed.success === true ||
        parsed.exitCode === 0 ||
        parsed.output !== undefined
      ) {
        return ChatExecutor.summarizeToolCalls(successes);
      }
      if (parsed.error) {
        return `Something went wrong: ${String(parsed.error).slice(0, MAX_ERROR_PREVIEW_CHARS)}`;
      }
      if (parsed.exitCode != null && parsed.exitCode !== 0) {
        const errOutput = parsed.stderr || parsed.stdout || "";
        return errOutput.trim()
          ? `Command failed: ${String(errOutput).slice(0, MAX_ERROR_PREVIEW_CHARS)}`
          : "The command failed. Let me try a different approach.";
      }
      return `Operation completed. Result:\n\`\`\`json\n${lastSuccess.result.slice(0, MAX_RESULT_PREVIEW_CHARS)}\n\`\`\``;
    } catch {
      return `Operation completed. Result: ${lastSuccess.result.slice(0, MAX_RESULT_PREVIEW_CHARS)}`;
    }
  }

  /** Build a human-readable summary from successful tool calls. */
  private static summarizeToolCalls(
    successes: readonly ToolCallRecord[],
  ): string {
    const summaries: string[] = [];
    for (const tc of successes) {
      if (tc.name === "system.open") {
        const target = String(tc.args?.target ?? "");
        if (target.includes("youtube.com/watch")) {
          summaries.push("Opened YouTube video");
        } else if (target.includes("youtube.com")) {
          summaries.push("Opened YouTube");
        } else if (target) {
          summaries.push(
            `Opened ${target.slice(0, MAX_URL_PREVIEW_CHARS)}`,
          );
        }
      } else if (tc.name === "system.bash") {
        try {
          const bashResult = JSON.parse(tc.result);
          const bashOutput = bashResult.stdout || bashResult.output || "";
          if (bashOutput.trim()) {
            summaries.push(
              bashOutput.trim().slice(0, MAX_BASH_OUTPUT_CHARS),
            );
          } else {
            const cmd = String(tc.args?.command ?? "").slice(
              0,
              MAX_COMMAND_PREVIEW_CHARS,
            );
            if (cmd) summaries.push(`Ran: ${cmd}`);
          }
        } catch {
          const cmd = String(tc.args?.command ?? "").slice(
            0,
            MAX_COMMAND_PREVIEW_CHARS,
          );
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
    return summaries.length > 0 ? summaries.join("\n") : "Done!";
  }

  /**
   * Best-effort context injection. Supports both SkillInjector (`.inject()`)
   * and MemoryRetriever (`.retrieve()`) interfaces.
   */
  private async injectContext(
    provider: SkillInjector | MemoryRetriever | undefined,
    message: string,
    sessionId: string,
    messages: LLMMessage[],
  ): Promise<void> {
    if (!provider) return;
    try {
      const context =
        "inject" in provider
          ? await provider.inject(message, sessionId)
          : await provider.retrieve(message, sessionId);
      if (context) {
        messages.push({ role: "system", content: context });
      }
    } catch {
      // Context injection failure is non-blocking
    }
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
  // Response evaluation
  // --------------------------------------------------------------------------

  private static readonly DEFAULT_EVAL_RUBRIC =
    "Rate this AI response 0.0-1.0. Consider accuracy, completeness, clarity, " +
    "and appropriate use of tool results.\n" +
    'Return ONLY JSON: {"score": 0.0-1.0, "feedback": "brief explanation"}';

  private async evaluateResponse(
    content: string,
    userMessage: string,
  ): Promise<{ score: number; feedback: string; usage: LLMUsage }> {
    const rubric = this.evaluator?.rubric ?? ChatExecutor.DEFAULT_EVAL_RUBRIC;
    const { response } = await this.callWithFallback([
      { role: "system", content: rubric },
      {
        role: "user",
        content: `User request: ${userMessage.slice(0, MAX_EVAL_USER_CHARS)}\n\nResponse: ${content.slice(0, MAX_EVAL_RESPONSE_CHARS)}`,
      },
    ]);
    try {
      const parsed = JSON.parse(response.content) as {
        score?: number;
        feedback?: string;
      };
      return {
        score:
          typeof parsed.score === "number"
            ? Math.max(0, Math.min(1, parsed.score))
            : 0.5,
        feedback:
          typeof parsed.feedback === "string" ? parsed.feedback : "",
        usage: response.usage,
      };
    } catch {
      return {
        score: 1.0,
        feedback: "Evaluation parse failed — accepting response",
        usage: response.usage,
      };
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
