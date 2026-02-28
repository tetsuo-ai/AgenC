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
  LLMContentPart,
  LLMResponse,
  LLMUsage,
  LLMRequestMetrics,
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

/** Estimated prompt-shape statistics for one provider call. */
export interface ChatPromptShape {
  readonly messageCount: number;
  readonly systemMessages: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolMessages: number;
  readonly estimatedChars: number;
  readonly systemPromptChars: number;
}

/** Per-provider-call usage attribution for one ChatExecutor execution. */
export interface ChatCallUsageRecord {
  /** 1-based call index within a single execute() invocation. */
  readonly callIndex: number;
  readonly phase:
    | "initial"
    | "tool_followup"
    | "evaluator"
    | "evaluator_retry";
  readonly provider: string;
  readonly model?: string;
  readonly finishReason: LLMResponse["finishReason"];
  readonly usage: LLMUsage;
  readonly beforeBudget: ChatPromptShape;
  readonly afterBudget: ChatPromptShape;
  /** Provider-specific request metrics (e.g. toolSchemaChars for Grok). */
  readonly providerRequestMetrics?: LLMRequestMetrics;
}

/** Result returned from ChatExecutor.execute(). */
export interface ChatExecutorResult {
  readonly content: string;
  readonly provider: string;
  /** Actual model identifier returned by the provider for the final response. */
  readonly model?: string;
  readonly usedFallback: boolean;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly tokenUsage: LLMUsage;
  /** Per-call token and prompt-shape attribution for this execution. */
  readonly callUsage: readonly ChatCallUsageRecord[];
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
  beforeBudget: ChatPromptShape;
  afterBudget: ChatPromptShape;
}

interface RecoveryHint {
  key: string;
  message: string;
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
/** Break tool loop after N rounds where every tool call failed. */
const MAX_CONSECUTIVE_ALL_FAILED_ROUNDS = 3;
const RECOVERY_HINT_PREFIX = "Tool recovery hint:";
const SHELL_BUILTIN_COMMANDS = new Set([
  "set",
  "cd",
  "export",
  "source",
  "alias",
  "unalias",
  "unset",
  "shopt",
  "ulimit",
  "umask",
  "readonly",
  "declare",
  "typeset",
  "builtin",
]);
/** Max chars for JSON result previews. */
const MAX_RESULT_PREVIEW_CHARS = 500;
/** Max chars for error message previews. */
const MAX_ERROR_PREVIEW_CHARS = 300;
/** Max chars of user message sent to the evaluator. */
const MAX_EVAL_USER_CHARS = 500;
/** Max chars of response sent to the evaluator. */
const MAX_EVAL_RESPONSE_CHARS = 2000;
/** Cap history depth sent to providers per request. */
const MAX_HISTORY_MESSAGES = 20;
/** Max chars retained per history message. */
const MAX_HISTORY_MESSAGE_CHARS = 2_000;
/** Max chars from a single injected system context block (skills/memory/progress). */
const MAX_CONTEXT_INJECTION_CHARS = 12_000;
/** Hard prompt-size guard (approx chars) to avoid provider context-length errors. */
const MAX_PROMPT_CHARS_BUDGET = 100_000;
/** Max chars kept from a tool result when feeding it back into the LLM. */
const MAX_TOOL_RESULT_CHARS = 12_000;
/** Max chars retained for any single string field inside JSON tool output. */
const MAX_TOOL_RESULT_FIELD_CHARS = 2_000;
/** Global image-data budget (chars) for tool results in a single execution. */
const MAX_TOOL_IMAGE_CHARS_BUDGET = 100_000;
/** Max chars retained from a single user text message. */
const MAX_USER_MESSAGE_CHARS = 8_000;
/** Hard cap for final assistant response size (protects against runaway output). */
const MAX_FINAL_RESPONSE_CHARS = 24_000;
/** Minimum line count before repetitive-output suppression is evaluated. */
const REPETITIVE_LINE_MIN_COUNT = 40;
/** Dominant-line repetition threshold for runaway detection. */
const REPETITIVE_LINE_MIN_REPEATS = 20;
/** Unique-line ratio threshold for runaway detection. */
const REPETITIVE_LINE_MAX_UNIQUE_RATIO = 0.35;
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

function didToolCallFail(isError: boolean, result: string): boolean {
  if (isError) return true;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim().length > 0) return true;
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return true;
  } catch {
    // Non-JSON tool output — treat as non-failure unless isError=true.
  }
  return false;
}

function parseToolResultObject(
  result: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractToolFailureText(record: ToolCallRecord): string {
  const parsed = parseToolResultObject(record.result);
  if (!parsed) return record.result;

  const pieces: string[] = [];
  if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
    pieces.push(parsed.error.trim());
  }
  if (typeof parsed.stderr === "string" && parsed.stderr.trim().length > 0) {
    pieces.push(parsed.stderr.trim());
  }
  if (pieces.length > 0) return pieces.join("\n");
  return record.result;
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
    const hasHistory = history.length > 0;
    await this.injectContext(this.skillInjector, messageText, sessionId, messages);
    // Session-scoped persistence should not bleed into truly fresh chats.
    // For the first turn, only inject static skill context.
    if (hasHistory) {
      await this.injectContext(this.memoryRetriever, messageText, sessionId, messages);
      await this.injectContext(this.learningProvider, messageText, sessionId, messages);
      await this.injectContext(this.progressProvider, messageText, sessionId, messages);
    }

    // Append history and user message
    messages.push(...ChatExecutor.normalizeHistory(history));

    ChatExecutor.appendUserMessage(messages, message);

    // First LLM call
    const cumulativeUsage: LLMUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const callUsage: ChatCallUsageRecord[] = [];
    let callIndex = 0;
    const allToolCalls: ToolCallRecord[] = [];

    let {
      response,
      providerName,
      usedFallback,
      beforeBudget,
      afterBudget,
    } = await this.callWithFallback(messages, activeStreamCallback);
    let responseModel = response.model;
    this.accumulateUsage(cumulativeUsage, response.usage);
    callUsage.push(
      this.createCallUsageRecord({
        callIndex: ++callIndex,
        phase: "initial",
        providerName,
        response,
        beforeBudget,
        afterBudget,
      }),
    );

    // Tool call loop — side-effect deduplication prevents the model from
    // repeating desktop actions (e.g. opening 3 YouTube tabs). Once ANY
    // side-effect tool executes, all others are skipped for this request.
    let rounds = 0;
    let sideEffectExecuted = false;
    let remainingToolImageChars = MAX_TOOL_IMAGE_CHARS_BUDGET;
    const emittedRecoveryHints = new Set<string>();
    // Track consecutive identical failing calls to break stuck loops
    // (e.g. LLM calling `desktop.bash mkdir` with no args 5 times in a row).
    let lastFailKey = "";
    let consecutiveFailCount = 0;
    let consecutiveAllFailedRounds = 0;
    while (
      response.finishReason === "tool_calls" &&
      response.toolCalls.length > 0 &&
      activeToolHandler &&
      rounds < effectiveMaxToolRounds
    ) {
      // Check for cancellation before each round
      if (signal?.aborted) break;

      rounds++;
      const roundToolCallStart = allToolCalls.length;

      // Append the assistant message with tool calls
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });
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
        const toolFailed = didToolCallFail(isError, result);

        allToolCalls.push({
          name: toolCall.name,
          args,
          result,
          isError: toolFailed,
          durationMs: toolDuration,
        });

        // Track consecutive identical failures to detect stuck loops.
        // Key on tool name + JSON args so "mkdir" with no args is distinct
        // from "mkdir -p crypto-tracker".
        const failDetected = toolFailed;
        const failKey = failDetected ? `${toolCall.name}:${toolCall.arguments}` : "";
        if (failDetected && failKey === lastFailKey) {
          consecutiveFailCount++;
        } else {
          lastFailKey = failKey;
          consecutiveFailCount = failDetected ? 1 : 0;
        }

        const promptToolContent = ChatExecutor.buildPromptToolContent(
          result,
          remainingToolImageChars,
        );
        remainingToolImageChars = promptToolContent.remainingImageBudget;
        messages.push({
          role: "tool",
          content: promptToolContent.content,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
      }

      // Check for cancellation before re-calling LLM
      if (signal?.aborted) break;

      // Break stuck loops — if the same tool with the same args has failed
      // N times consecutively, stop the loop entirely.
      if (consecutiveFailCount >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
        break;
      }

      // Break stuck loops — if all tool calls fail for multiple consecutive
      // rounds, stop retrying and let the model respond with what it learned.
      const roundCalls = allToolCalls.slice(roundToolCallStart);
      if (roundCalls.length > 0) {
        const roundFailures = roundCalls.filter((call) =>
          didToolCallFail(call.isError, call.result),
        ).length;
        if (roundFailures === roundCalls.length) {
          consecutiveAllFailedRounds++;
        } else {
          consecutiveAllFailedRounds = 0;
        }
        if (consecutiveAllFailedRounds >= MAX_CONSECUTIVE_ALL_FAILED_ROUNDS) {
          break;
        }
      }

      const recoveryHints = ChatExecutor.buildRecoveryHints(
        roundCalls,
        emittedRecoveryHints,
      );
      for (const hint of recoveryHints) {
        messages.push({
          role: "system",
          content: `${RECOVERY_HINT_PREFIX} ${hint.message}`,
        });
      }

      // Re-call LLM
      const next = await this.callWithFallback(messages, activeStreamCallback);
      response = next.response;
      providerName = next.providerName;
      responseModel = next.response.model;
      beforeBudget = next.beforeBudget;
      afterBudget = next.afterBudget;
      if (next.usedFallback) usedFallback = true;
      this.accumulateUsage(cumulativeUsage, response.usage);
      callUsage.push(
        this.createCallUsageRecord({
          callIndex: ++callIndex,
          phase: "tool_followup",
          providerName,
          response,
          beforeBudget,
          afterBudget,
        }),
      );
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
        this.accumulateUsage(cumulativeUsage, evalResult.response.usage);
        this.trackTokenUsage(sessionId, evalResult.response.usage.totalTokens);
        callUsage.push(
          this.createCallUsageRecord({
            callIndex: ++callIndex,
            phase: "evaluator",
            providerName: evalResult.providerName,
            response: evalResult.response,
            beforeBudget: evalResult.beforeBudget,
            afterBudget: evalResult.afterBudget,
          }),
        );

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
        callUsage.push(
          this.createCallUsageRecord({
            callIndex: ++callIndex,
            phase: "evaluator_retry",
            providerName: retry.providerName,
            response: retry.response,
            beforeBudget: retry.beforeBudget,
            afterBudget: retry.afterBudget,
          }),
        );
        providerName = retry.providerName;
        responseModel = retry.response.model;
        if (retry.usedFallback) usedFallback = true;
        currentContent = retry.response.content || currentContent;
      }
    }

    finalContent = ChatExecutor.sanitizeFinalContent(finalContent);
    finalContent = ChatExecutor.reconcileStructuredToolOutcome(
      finalContent,
      allToolCalls,
    );

    return {
      content: finalContent,
      provider: providerName,
      model: responseModel,
      usedFallback,
      toolCalls: allToolCalls,
      tokenUsage: cumulativeUsage,
      callUsage,
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
    const beforeBudget = ChatExecutor.estimatePromptShape(messages);
    const boundedMessages = ChatExecutor.enforcePromptCharBudget(
      messages,
      MAX_PROMPT_CHARS_BUDGET,
    );
    const afterBudget = ChatExecutor.estimatePromptShape(boundedMessages);
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
          response = await provider.chatStream(boundedMessages, onStreamChunk);
        } else {
          response = await provider.chat(boundedMessages);
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
          beforeBudget,
          afterBudget,
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

  private static buildRecoveryHints(
    roundCalls: readonly ToolCallRecord[],
    emittedHints: Set<string>,
  ): RecoveryHint[] {
    const hints: RecoveryHint[] = [];
    for (const call of roundCalls) {
      const hint = ChatExecutor.inferRecoveryHint(call);
      if (!hint) continue;
      if (emittedHints.has(hint.key)) continue;
      emittedHints.add(hint.key);
      hints.push(hint);
    }
    return hints;
  }

  private static inferRecoveryHint(
    call: ToolCallRecord,
  ): RecoveryHint | undefined {
    if (!didToolCallFail(call.isError, call.result)) return undefined;

    const failureText = extractToolFailureText(call);
    const failureTextLower = failureText.toLowerCase();

    if (call.name === "system.bash") {
      const command = String(call.args?.command ?? "").trim().toLowerCase();
      const isBuiltin = command.length > 0 && SHELL_BUILTIN_COMMANDS.has(command);
      if (
        isBuiltin ||
        failureTextLower.includes("shell builtin") ||
        /spawn\s+\S+\s+enoent/i.test(failureText)
      ) {
        return {
          key: "system-bash-shell-builtin",
          message:
            "system.bash executes one real binary only. Shell builtins (for example `set`, `cd`, `export`) " +
            "and script-style command chains do not work there. Use executable + args, or move multi-line/chained logic to `desktop.bash`.",
        };
      }
      if (
        failureTextLower.includes("one executable token") ||
        failureTextLower.includes("shell operators/newlines")
      ) {
        return {
          key: "system-bash-command-shape",
          message:
            "system.bash `command` must be a single executable token. Put flags/operands in `args`. " +
            "For pipes/redirection/heredocs or multi-line shell scripts, use `desktop.bash`.",
        };
      }
    }

    if (
      call.name === "system.browse" ||
      call.name === "system.httpGet" ||
      call.name === "system.httpPost" ||
      call.name === "system.httpFetch"
    ) {
      if (
        failureTextLower.includes("private/loopback address blocked") ||
        failureTextLower.includes("ssrf target blocked")
      ) {
        return {
          key: "localhost-ssrf-blocked",
          message:
            "system.browse/system.http* block localhost/private/internal addresses by design. " +
            "For local service checks, use `desktop.bash` (curl inside the sandbox) or Playwright desktop tools.",
        };
      }
    }

    return undefined;
  }

  /** Extract plain-text content from a gateway message. */
  private static extractMessageText(message: GatewayMessage): string {
    return typeof message.content === "string" ? message.content : "";
  }

  private static truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
    return value.slice(0, maxChars - 3) + "...";
  }

  private static sanitizeFinalContent(content: string): string {
    if (!content) return content;
    const collapsed = ChatExecutor.collapseRunawayRepetition(content);
    if (collapsed.length <= MAX_FINAL_RESPONSE_CHARS) return collapsed;
    return (
      ChatExecutor.truncateText(collapsed, MAX_FINAL_RESPONSE_CHARS) +
      "\n\n[response truncated: oversized model output suppressed]"
    );
  }

  private static reconcileStructuredToolOutcome(
    content: string,
    toolCalls: readonly ToolCallRecord[],
  ): string {
    if (!content || toolCalls.length === 0) return content;
    const trimmed = content.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return content;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return content;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return content;
    }

    const payload = parsed as Record<string, unknown>;
    if (typeof payload.overall !== "string" || !Array.isArray(payload.steps)) {
      return content;
    }

    const normalizedOverall = payload.overall.trim().toLowerCase();
    if (normalizedOverall !== "pass") {
      return content;
    }

    const hasToolFailure = toolCalls.some((toolCall) =>
      didToolCallFail(toolCall.isError, toolCall.result),
    );

    const executedTools = new Set(
      toolCalls
        .map((toolCall) => toolCall.name?.trim())
        .filter((name): name is string => Boolean(name)),
    );
    const claimedTools = new Set<string>();
    for (const step of payload.steps) {
      if (typeof step !== "object" || step === null || Array.isArray(step)) {
        continue;
      }
      const toolName = (step as { tool?: unknown }).tool;
      if (typeof toolName === "string" && toolName.trim().length > 0) {
        claimedTools.add(toolName.trim());
      }
    }

    const claimsUnexecutedTool = Array.from(claimedTools).some(
      (toolName) => !executedTools.has(toolName),
    );

    if (!hasToolFailure && !claimsUnexecutedTool) {
      return content;
    }

    payload.overall = "fail";
    return safeStringify(payload);
  }

  private static collapseRunawayRepetition(content: string): string {
    const lines = content.split(/\r?\n/);
    if (lines.length < REPETITIVE_LINE_MIN_COUNT) return content;

    const normalized = lines.map((line) =>
      line.trim().replace(/\s+/g, " ").toLowerCase(),
    );
    const nonEmpty = normalized.filter((line) => line.length > 0);
    if (nonEmpty.length < REPETITIVE_LINE_MIN_COUNT) return content;

    const freq = new Map<string, number>();
    for (const line of nonEmpty) {
      if (line.length > 80) continue;
      freq.set(line, (freq.get(line) ?? 0) + 1);
    }

    let topCount = 0;
    for (const count of freq.values()) {
      if (count > topCount) topCount = count;
    }

    const uniqueRatio = new Set(nonEmpty).size / nonEmpty.length;
    if (
      topCount < REPETITIVE_LINE_MIN_REPEATS ||
      uniqueRatio > REPETITIVE_LINE_MAX_UNIQUE_RATIO
    ) {
      return content;
    }

    const preview = lines.slice(0, 24).join("\n");
    return `${preview}\n\n[response truncated: repetitive model output suppressed]`;
  }

  private static isBase64Like(value: string): boolean {
    if (value.length < 128) return false;
    return /^[A-Za-z0-9+/=\r\n]+$/.test(value);
  }

  private static estimateContentChars(
    content: string | LLMContentPart[],
  ): number {
    if (typeof content === "string") return content.length;
    return content.reduce((sum, part) => {
      if (part.type === "text") return sum + part.text.length;
      return sum + part.image_url.url.length;
    }, 0);
  }

  private static estimateMessageChars(message: LLMMessage): number {
    // Small role/metadata overhead for rough token approximation.
    return ChatExecutor.estimateContentChars(message.content) + 64;
  }

  private static truncateMessageContent(
    content: string | LLMContentPart[],
    maxChars: number,
  ): string | LLMContentPart[] {
    if (maxChars <= 0) return "";
    if (typeof content === "string") {
      return ChatExecutor.truncateText(content, maxChars);
    }

    const out: LLMContentPart[] = [];
    let used = 0;
    for (const part of content) {
      const remaining = maxChars - used;
      if (remaining <= 0) break;

      if (part.type === "text") {
        const text = ChatExecutor.truncateText(part.text, remaining);
        if (text.length > 0) {
          out.push({ type: "text", text });
          used += text.length;
        }
        continue;
      }

      // Never carry prior inline image data when hard-truncating.
      const placeholder = "[image omitted]";
      const text = ChatExecutor.truncateText(placeholder, remaining);
      if (text.length > 0) {
        out.push({ type: "text", text });
        used += text.length;
      }
    }

    if (out.length === 0) {
      out.push({ type: "text", text: "" });
    }
    return out;
  }

  private static enforcePromptCharBudget(
    messages: LLMMessage[],
    maxChars: number,
  ): LLMMessage[] {
    const totalChars = messages.reduce(
      (sum, message) => sum + ChatExecutor.estimateMessageChars(message),
      0,
    );
    if (totalChars <= maxChars) return messages;

    // Keep only the first system message as anchor; drop additional injected
    // system blocks when we are in hard-budget mode.
    const firstSystemIndex = messages.findIndex((m) => m.role === "system");
    const firstSystem =
      firstSystemIndex >= 0 ? messages[firstSystemIndex] : undefined;
    const systemHead = firstSystem
      ? {
          ...firstSystem,
          content: ChatExecutor.truncateMessageContent(
            firstSystem.content,
            Math.min(24_000, Math.floor(maxChars * 0.5)),
          ),
        }
      : undefined;
    const systemHeadChars = systemHead
      ? ChatExecutor.estimateMessageChars(systemHead)
      : 0;

    const nonSystemBudget = Math.max(4_000, maxChars - systemHeadChars);
    const nonSystemMessages = messages.filter((message, idx) =>
      idx === firstSystemIndex ? false : message.role !== "system");

    const selected: LLMMessage[] = [];
    let used = 0;
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const message = nonSystemMessages[i];
      const messageChars = ChatExecutor.estimateMessageChars(message);
      if (used + messageChars <= nonSystemBudget) {
        selected.push(message);
        used += messageChars;
        continue;
      }

      // Keep at least the newest non-system message, truncated to fit.
      if (selected.length === 0) {
        const remaining = Math.max(256, nonSystemBudget - used);
        selected.push({
          ...message,
          content: ChatExecutor.truncateMessageContent(message.content, remaining),
        });
      }
      break;
    }

    selected.reverse();
    return systemHead ? [systemHead, ...selected] : selected;
  }

  private static estimatePromptShape(
    messages: readonly LLMMessage[],
  ): ChatPromptShape {
    let systemMessages = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolMessages = 0;
    let estimatedChars = 0;
    let systemPromptChars = 0;

    for (const message of messages) {
      estimatedChars += ChatExecutor.estimateMessageChars(message);
      if (message.role === "system") {
        systemMessages++;
        systemPromptChars += ChatExecutor.estimateContentChars(message.content);
      } else if (message.role === "user") {
        userMessages++;
      } else if (message.role === "assistant") {
        assistantMessages++;
      } else if (message.role === "tool") {
        toolMessages++;
      }
    }

    return {
      messageCount: messages.length,
      systemMessages,
      userMessages,
      assistantMessages,
      toolMessages,
      estimatedChars,
      systemPromptChars,
    };
  }

  private static normalizeHistory(history: readonly LLMMessage[]): LLMMessage[] {
    const recent = history.slice(-MAX_HISTORY_MESSAGES);
    return recent.map((entry) => {
      if (typeof entry.content === "string") {
        if (entry.role === "tool") {
          const prepared = ChatExecutor.prepareToolResultForPrompt(entry.content);
          return { ...entry, content: prepared.text };
        }
        return {
          ...entry,
          content: ChatExecutor.truncateText(
            entry.content,
            MAX_HISTORY_MESSAGE_CHARS,
          ),
        };
      }

      const parts: LLMContentPart[] = entry.content.map((part) => {
        if (part.type === "text") {
          return {
            type: "text" as const,
            text: ChatExecutor.truncateText(
              part.text,
              MAX_HISTORY_MESSAGE_CHARS,
            ),
          };
        }
        // Never replay historical inline images into future prompts.
        return {
          type: "text" as const,
          text: "[prior image omitted]",
        };
      });
      return { ...entry, content: parts };
    });
  }

  private static sanitizeJsonForPrompt(
    value: unknown,
    captureDataUrl: (url: string) => void,
  ): unknown {
    if (typeof value === "string") {
      if (value.startsWith("data:image/")) {
        captureDataUrl(value);
        return "(see image)";
      }
      if (ChatExecutor.isBase64Like(value)) {
        return "(base64 omitted)";
      }
      return ChatExecutor.truncateText(value, MAX_TOOL_RESULT_FIELD_CHARS);
    }
    if (Array.isArray(value)) {
      return value.map((item) =>
        ChatExecutor.sanitizeJsonForPrompt(item, captureDataUrl),
      );
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (typeof field === "string") {
          if (field.startsWith("data:image/")) {
            captureDataUrl(field);
            out[key] = "(see image)";
            continue;
          }
          if (
            keyLower === "image" ||
            keyLower === "dataurl" ||
            keyLower.endsWith("base64")
          ) {
            if (ChatExecutor.isBase64Like(field)) {
              out[key] = "(base64 omitted)";
              continue;
            }
          }
          out[key] = ChatExecutor.truncateText(
            field,
            MAX_TOOL_RESULT_FIELD_CHARS,
          );
          continue;
        }
        out[key] = ChatExecutor.sanitizeJsonForPrompt(field, captureDataUrl);
      }
      return out;
    }
    return value;
  }

  private static prepareToolResultForPrompt(result: string): {
    text: string;
    dataUrl?: string;
  } {
    let capturedDataUrl: string | undefined;
    const setDataUrl = (url: string): void => {
      if (!capturedDataUrl) capturedDataUrl = url;
    };

    try {
      const parsed = JSON.parse(result) as unknown;
      const sanitized = ChatExecutor.sanitizeJsonForPrompt(parsed, setDataUrl);
      return {
        text: ChatExecutor.truncateText(
          safeStringify(sanitized),
          MAX_TOOL_RESULT_CHARS,
        ),
        ...(capturedDataUrl ? { dataUrl: capturedDataUrl } : {}),
      };
    } catch {
      const dataUrlMatch = result.match(
        /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/,
      );
      const text = result
        .replace(
          /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
          "(see image)",
        )
        .replace(/"[Ii]mage"\s*:\s*"[A-Za-z0-9+/=\r\n]{128,}"/g, '"image":"(base64 omitted)"')
        .trim();
      return {
        text: ChatExecutor.truncateText(text, MAX_TOOL_RESULT_CHARS),
        ...(dataUrlMatch ? { dataUrl: dataUrlMatch[0] } : {}),
      };
    }
  }

  private static buildPromptToolContent(
    result: string,
    remainingImageBudget: number,
  ): {
    content: string | import("./types.js").LLMContentPart[];
    remainingImageBudget: number;
  } {
    const prepared = ChatExecutor.prepareToolResultForPrompt(result);
    if (!prepared.dataUrl) {
      return { content: prepared.text, remainingImageBudget };
    }

    // Prevent huge inline screenshots from blowing up prompt size.
    if (prepared.dataUrl.length > remainingImageBudget) {
      const note =
        prepared.text +
        "\n\n[Screenshot omitted from prompt due image context budget]";
      return {
        content: ChatExecutor.truncateText(note, MAX_TOOL_RESULT_CHARS),
        remainingImageBudget,
      };
    }

    return {
      content: [
        { type: "image_url" as const, image_url: { url: prepared.dataUrl } },
        { type: "text" as const, text: prepared.text },
      ],
      remainingImageBudget: remainingImageBudget - prepared.dataUrl.length,
    };
  }

  /** Append a user message, handling multimodal (image) attachments. */
  private static appendUserMessage(
    messages: LLMMessage[],
    message: GatewayMessage,
  ): void {
    const imageAttachments = (message.attachments ?? []).filter(
      (a) => a.data && a.mimeType.startsWith("image/"),
    );
    const trimmedUserText = ChatExecutor.truncateText(
      message.content,
      MAX_USER_MESSAGE_CHARS,
    );
    if (imageAttachments.length > 0) {
      const contentParts: LLMContentPart[] = [];
      if (trimmedUserText) {
        contentParts.push({ type: "text", text: trimmedUserText });
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
      messages.push({ role: "user", content: trimmedUserText });
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
        messages.push({
          role: "system",
          content: ChatExecutor.truncateText(
            context,
            MAX_CONTEXT_INJECTION_CHARS,
          ),
        });
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

  private createCallUsageRecord(input: {
    callIndex: number;
    phase: ChatCallUsageRecord["phase"];
    providerName: string;
    response: LLMResponse;
    beforeBudget: ChatPromptShape;
    afterBudget: ChatPromptShape;
  }): ChatCallUsageRecord {
    return {
      callIndex: input.callIndex,
      phase: input.phase,
      provider: input.providerName,
      model: input.response.model,
      finishReason: input.response.finishReason,
      usage: input.response.usage,
      beforeBudget: input.beforeBudget,
      afterBudget: input.afterBudget,
      providerRequestMetrics: input.response.requestMetrics,
    };
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
  ): Promise<{
    score: number;
    feedback: string;
    response: LLMResponse;
    providerName: string;
    beforeBudget: ChatPromptShape;
    afterBudget: ChatPromptShape;
  }> {
    const rubric = this.evaluator?.rubric ?? ChatExecutor.DEFAULT_EVAL_RUBRIC;
    const {
      response,
      providerName,
      beforeBudget,
      afterBudget,
    } = await this.callWithFallback([
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
        response,
        providerName,
        beforeBudget,
        afterBudget,
      };
    } catch {
      return {
        score: 1.0,
        feedback: "Evaluation parse failed — accepting response",
        response,
        providerName,
        beforeBudget,
        afterBudget,
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
