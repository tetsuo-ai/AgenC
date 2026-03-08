/**
 * Standalone tool helper functions for ChatExecutor.
 *
 * @module
 */

import type { LLMToolCall, LLMMessage, ToolHandler } from "./types.js";
import type { ToolCallRecord, ToolCallAction, ToolLoopState, RecoveryHint, LLMRetryPolicyOverrides } from "./chat-executor-types.js";
import type { LLMRetryPolicyMatrix } from "./policy.js";
import { DEFAULT_LLM_RETRY_POLICY_MATRIX } from "./policy.js";
import type { LLMFailureClass, LLMRetryPolicyRule } from "./policy.js";
import {
  HIGH_RISK_TOOLS,
  HIGH_RISK_TOOL_PREFIXES,
  SAFE_TOOL_RETRY_TOOLS,
  SAFE_TOOL_RETRY_PREFIXES,
  MAX_CONSECUTIVE_IDENTICAL_FAILURES,
  MAX_CONSECUTIVE_ALL_FAILED_ROUNDS,
  MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS,
  RECOVERY_HINT_PREFIX,
} from "./chat-executor-constants.js";
import { buildSemanticToolCallKey } from "./chat-executor-recovery.js";
import { safeStringify } from "../tools/types.js";

const NON_JSON_FAILURE_PREFIXES = [
  "mcp tool \"",
  "error executing tool",
  "tool not found:",
];
const DOOM_VALIDATION_FAILURE_RE =
  /^unknown\s+(?:resolution|screen resolution|scenario|map|skill(?:\s+level)?|wad)\b.*\bvalid:/i;
const DOOM_RUNTIME_FAILURE_RE =
  /^(?:executor not running\b|no game is running\b|game is not running\b)/i;
const DOOM_SCREEN_RESOLUTION_RE = /^(?:RES_)?(\d{2,4})[xX](\d{2,4})$/i;
const NULLISH_STRING_RE = /^(?:null|none|undefined)$/i;
const DEFAULT_VISIBLE_DOOM_SCREEN_RESOLUTION = "RES_1280X720";

export function didToolCallFail(isError: boolean, result: string): boolean {
  if (isError) return true;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return isLikelyFailureText(result);
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim().length > 0) return true;
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return true;
  } catch {
    // Non-JSON tool output — detect known tool-wrapper failure signatures.
    return isLikelyFailureText(result);
  }
  return false;
}

export function parseToolResultObject(
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

export function extractToolFailureText(record: ToolCallRecord): string {
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

export function resolveRetryPolicyMatrix(
  overrides?: LLMRetryPolicyOverrides,
): LLMRetryPolicyMatrix {
  if (!overrides) return DEFAULT_LLM_RETRY_POLICY_MATRIX;
  const merged = {
    ...DEFAULT_LLM_RETRY_POLICY_MATRIX,
  } as Record<LLMFailureClass, LLMRetryPolicyRule>;
  for (const failureClass of Object.keys(
    DEFAULT_LLM_RETRY_POLICY_MATRIX,
  ) as LLMFailureClass[]) {
    const baseRule = merged[failureClass];
    const patch = overrides[failureClass];
    if (!patch) continue;
    merged[failureClass] = {
      ...baseRule,
      ...patch,
    };
  }
  return merged;
}

export function hasExplicitIdempotencyKey(args: Record<string, unknown>): boolean {
  const value = args.idempotencyKey;
  return typeof value === "string" && value.trim().length > 0;
}

export function isHighRiskToolCall(
  toolName: string,
): boolean {
  if (HIGH_RISK_TOOLS.has(toolName)) return true;
  return HIGH_RISK_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

export function isToolRetrySafe(toolName: string): boolean {
  if (SAFE_TOOL_RETRY_TOOLS.has(toolName)) return true;
  return SAFE_TOOL_RETRY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

export function isLikelyToolTransportFailure(
  errorText: string,
): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("transport") ||
    lower.includes("bridge")
  );
}

export function enrichToolResultMetadata(
  result: string,
  metadata: Record<string, unknown>,
): string {
  const parsed = parseToolResultObject(result);
  if (!parsed) return result;
  return safeStringify({
    ...parsed,
    ...metadata,
  });
}

function isLikelyFailureText(result: string): boolean {
  const text = result.trim().toLowerCase();
  if (text.length === 0) return false;
  if (text.startsWith("mcp tool \"") && text.includes("\" failed:")) return true;
  if (text.includes("requires desktop session")) return true;
  if (DOOM_VALIDATION_FAILURE_RE.test(result)) return true;
  if (DOOM_RUNTIME_FAILURE_RE.test(result)) return true;
  return NON_JSON_FAILURE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// ============================================================================
// Permission / argument / retry helpers (extracted from executeSingleToolCall)
// ============================================================================

/** Result of checking whether a tool call is permitted. */
export interface ToolCallPermissionResult {
  readonly action: ToolCallAction;
  readonly errorResult?: string;
  readonly expandAfterRound?: boolean;
  readonly routingMiss?: boolean;
}

/** Check global allowlist and routed subset constraints for a tool call. */
export function checkToolCallPermission(
  toolCall: LLMToolCall,
  allowedTools: Set<string> | null,
  routedToolSet: Set<string> | null,
  canExpandOnRoutingMiss: boolean,
  routedToolsExpanded: boolean,
): ToolCallPermissionResult {
  // Global allowlist check.
  if (allowedTools && !allowedTools.has(toolCall.name)) {
    return {
      action: "skip",
      errorResult: safeStringify({
        error: `Tool "${toolCall.name}" is not permitted`,
      }),
    };
  }

  // Dynamic routed subset check.
  if (routedToolSet && !routedToolSet.has(toolCall.name)) {
    return {
      action: "skip",
      errorResult: safeStringify({
        error:
          `Tool "${toolCall.name}" was not available in the routed tool subset for this turn`,
        routingMiss: true,
      }),
      expandAfterRound: canExpandOnRoutingMiss && !routedToolsExpanded,
      routingMiss: true,
    };
  }

  return { action: "processed" };
}

/** Result of parsing tool call arguments. */
export type ParseToolCallArgsResult =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

/** Parse and validate tool call JSON arguments. */
export function parseToolCallArguments(
  toolCall: LLMToolCall,
): ParseToolCallArgsResult {
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Tool arguments must be a JSON object");
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (parseErr) {
    return {
      ok: false,
      error: safeStringify({
        error: `Invalid tool arguments: ${(parseErr as Error).message}`,
      }),
    };
  }
}

export function normalizeDoomScreenResolution(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  const match = trimmed.match(DOOM_SCREEN_RESOLUTION_RE);
  if (!match) return trimmed;
  return `RES_${match[1]}X${match[2]}`;
}

export function normalizeToolCallArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "mcp.doom.start_game") return args;

  let nextArgs = args;
  const normalizedResolution = normalizeDoomScreenResolution(
    args.screen_resolution,
  );
  if (
    typeof normalizedResolution === "string" &&
    normalizedResolution !== args.screen_resolution
  ) {
    nextArgs = {
      ...nextArgs,
      screen_resolution: normalizedResolution,
    };
  }

  if (nextArgs.screen_resolution === undefined) {
    if (nextArgs === args) nextArgs = { ...args };
    nextArgs.screen_resolution = DEFAULT_VISIBLE_DOOM_SCREEN_RESOLUTION;
  }

  if (nextArgs.window_visible !== true) {
    if (nextArgs === args) nextArgs = { ...args };
    nextArgs.window_visible = true;
  }

  if (nextArgs.render_hud !== true) {
    if (nextArgs === args) nextArgs = { ...args };
    nextArgs.render_hud = true;
  }

  if (
    typeof nextArgs.recording_path === "string" &&
    NULLISH_STRING_RE.test(nextArgs.recording_path.trim())
  ) {
    if (nextArgs === args) nextArgs = { ...args };
    delete nextArgs.recording_path;
  }

  return nextArgs;
}

/** Configuration for tool execution with retry. */
export interface ToolExecutionConfig {
  readonly toolCallTimeoutMs: number;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly signal?: AbortSignal;
  readonly requestDeadlineAt: number;
}

/** Result of executing a tool with retry logic. */
export interface ToolExecutionResult {
  result: string;
  isError: boolean;
  toolFailed: boolean;
  timedOut: boolean;
  retryCount: number;
  retrySuppressedReason?: string;
  durationMs: number;
  finalToolTimeoutMs: number;
}

/** Execute a tool call with timeout racing and transport-failure retry. */
export async function executeToolWithRetry(
  toolCall: LLMToolCall,
  args: Record<string, unknown>,
  handler: ToolHandler,
  config: ToolExecutionConfig,
): Promise<ToolExecutionResult> {
  const toolStart = Date.now();
  let result = safeStringify({ error: "Tool execution failed" });
  let isError = false;
  let toolFailed = false;
  let timedOut = false;
  let finalToolTimeoutMs = config.toolCallTimeoutMs;
  let retrySuppressedReason: string | undefined;
  let retryCount = 0;
  const maxToolRetries = Math.max(
    0,
    config.retryPolicyMatrix.tool_error.maxRetries,
  );

  for (let attempt = 0; attempt <= maxToolRetries; attempt++) {
    const remainingRequestMs = config.requestDeadlineAt - Date.now();
    const toolTimeoutMs = Math.min(
      config.toolCallTimeoutMs,
      Math.max(1, remainingRequestMs),
    );
    finalToolTimeoutMs = toolTimeoutMs;
    let toolTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const toolCallPromise = (async (): Promise<{
      result: string;
      isError: boolean;
      timedOut: boolean;
      threw: boolean;
    }> => {
      try {
        const value = await handler(toolCall.name, args);
        return {
          result: value,
          isError: false,
          timedOut: false,
          threw: false,
        };
      } catch (toolErr) {
        return {
          result: safeStringify({ error: (toolErr as Error).message }),
          isError: true,
          timedOut: false,
          threw: true,
        };
      }
    })();
    const timeoutPromise = new Promise<{
      result: string;
      isError: boolean;
      timedOut: boolean;
      threw: boolean;
    }>((resolve) => {
      toolTimeoutHandle = setTimeout(() => {
        resolve({
          result: safeStringify({
            error: `Tool "${toolCall.name}" timed out after ${toolTimeoutMs}ms`,
          }),
          isError: true,
          timedOut: true,
          threw: false,
        });
      }, toolTimeoutMs);
    });
    const toolOutcome = await Promise.race([
      toolCallPromise,
      timeoutPromise,
    ]);
    if (toolTimeoutHandle !== undefined) {
      clearTimeout(toolTimeoutHandle);
    }

    result = toolOutcome.result;
    isError = toolOutcome.isError;
    timedOut = toolOutcome.timedOut;

    toolFailed = didToolCallFail(isError, result);
    const failureText = toolFailed
      ? extractToolFailureText({
        name: toolCall.name,
        args,
        result,
        isError: toolFailed,
        durationMs: 0,
      })
      : "";
    const transportFailure =
      timedOut ||
      toolOutcome.threw ||
      isLikelyToolTransportFailure(failureText);
    if (!toolFailed) break;

    const canRetryTransportFailure =
      transportFailure &&
      attempt < maxToolRetries &&
      !config.signal?.aborted &&
      (config.requestDeadlineAt - Date.now()) > 0;
    if (!canRetryTransportFailure) break;

    const highRiskTool = isHighRiskToolCall(toolCall.name);
    const hasIdempotency = hasExplicitIdempotencyKey(args);
    const retrySafe = highRiskTool
      ? hasIdempotency
      : isToolRetrySafe(toolCall.name);
    if (!retrySafe) {
      retrySuppressedReason = highRiskTool && !hasIdempotency
        ? `Suppressed auto-retry for high-risk tool "${toolCall.name}" without idempotencyKey`
        : `Suppressed auto-retry for potentially side-effecting tool "${toolCall.name}"`;
      break;
    }

    retryCount++;
  }
  const durationMs = Date.now() - toolStart;
  if (retryCount > 0) {
    result = enrichToolResultMetadata(result, { retryAttempts: retryCount });
  }
  if (retrySuppressedReason) {
    result = enrichToolResultMetadata(result, { retrySuppressedReason });
  }

  return {
    result,
    isError,
    toolFailed,
    timedOut,
    retryCount,
    retrySuppressedReason,
    durationMs,
    finalToolTimeoutMs,
  };
}

/** Update loop-state consecutive failure tracking. */
export function trackToolCallFailureState(
  toolFailed: boolean,
  semanticToolKey: string,
  loopState: ToolLoopState,
): void {
  const failKey = toolFailed ? semanticToolKey : "";
  if (toolFailed && failKey === loopState.lastFailKey) {
    loopState.consecutiveFailCount++;
  } else {
    loopState.lastFailKey = failKey;
    loopState.consecutiveFailCount = toolFailed ? 1 : 0;
  }
}

// ============================================================================
// Stuck-loop detection (extracted from executeToolCallLoop)
// ============================================================================

/** Mutable counters for cross-round stuck detection. */
export interface RoundStuckState {
  consecutiveAllFailedRounds: number;
  lastRoundSemanticKey: string;
  consecutiveSemanticDuplicateRounds: number;
}

/** Result of stuck-loop detection check. */
export interface StuckDetectionResult {
  readonly shouldBreak: boolean;
  readonly reason?: string;
}

/** Check for stuck tool loop patterns across rounds. */
export function checkToolLoopStuckDetection(
  roundCalls: readonly ToolCallRecord[],
  loopState: ToolLoopState,
  stuckState: RoundStuckState,
): StuckDetectionResult {
  // Per-call consecutive identical failure check.
  if (loopState.consecutiveFailCount >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
    return {
      shouldBreak: true,
      reason: "Detected repeated semantically-equivalent failing tool calls",
    };
  }

  if (roundCalls.length === 0) return { shouldBreak: false };

  const roundFailures = roundCalls.filter((call) =>
    didToolCallFail(call.isError, call.result),
  ).length;
  if (roundFailures === roundCalls.length) {
    stuckState.consecutiveAllFailedRounds++;
  } else {
    stuckState.consecutiveAllFailedRounds = 0;
    stuckState.consecutiveSemanticDuplicateRounds = 0;
    stuckState.lastRoundSemanticKey = "";
  }
  if (stuckState.consecutiveAllFailedRounds >= MAX_CONSECUTIVE_ALL_FAILED_ROUNDS) {
    return {
      shouldBreak: true,
      reason: `All tool calls failed for ${MAX_CONSECUTIVE_ALL_FAILED_ROUNDS} consecutive rounds`,
    };
  }

  if (roundFailures === roundCalls.length) {
    const roundSemanticKey = roundCalls
      .map((call) => buildSemanticToolCallKey(call.name, call.args))
      .sort()
      .join("|");
    if (
      roundSemanticKey.length > 0 &&
      roundSemanticKey === stuckState.lastRoundSemanticKey
    ) {
      stuckState.consecutiveSemanticDuplicateRounds++;
    } else {
      stuckState.consecutiveSemanticDuplicateRounds = 0;
    }
    stuckState.lastRoundSemanticKey = roundSemanticKey;
    if (
      stuckState.consecutiveSemanticDuplicateRounds >=
      MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS
    ) {
      return {
        shouldBreak: true,
        reason:
          "Detected repeated semantically equivalent tool rounds with no material progress",
      };
    }
  }

  return { shouldBreak: false };
}

/** Build recovery hint messages for injection after a tool round. */
export function buildToolLoopRecoveryMessages(
  recoveryHints: readonly RecoveryHint[],
  maxRuntimeSystemHints: number,
  currentRuntimeHintCount: number,
): LLMMessage[] {
  const messages: LLMMessage[] = [];
  if (maxRuntimeSystemHints <= 0) return messages;
  let hintCount = currentRuntimeHintCount;
  for (const hint of recoveryHints) {
    if (hintCount >= maxRuntimeSystemHints) break;
    messages.push({
      role: "system",
      content: `${RECOVERY_HINT_PREFIX} ${hint.message}`,
    });
    hintCount++;
  }
  return messages;
}

/** Build a routing expansion hint message when tool routing misses are detected. */
export function buildRoutingExpansionMessage(
  maxRuntimeSystemHints: number,
  currentRuntimeHintCount: number,
): LLMMessage | null {
  if (maxRuntimeSystemHints <= 0) return null;
  if (currentRuntimeHintCount >= maxRuntimeSystemHints) return null;
  return {
    role: "system",
    content:
      `${RECOVERY_HINT_PREFIX} The previous tool request targeted a tool outside the routed subset. ` +
      "Tool availability has been expanded for one retry. Choose the best available tool and continue.",
  };
}
