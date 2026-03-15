/**
 * Text processing, formatting, and sanitization functions for ChatExecutor.
 *
 * @module
 */

import type { GatewayMessage } from "../gateway/message.js";
import type {
  LLMMessage,
  LLMContentPart,
  LLMToolCall,
  LLMProviderEvidence,
} from "./types.js";
import type {
  PromptBudgetSection,
} from "./prompt-budget.js";
import type { ToolCallRecord, ChatPromptShape } from "./chat-executor-types.js";
import {
  MAX_FINAL_RESPONSE_CHARS,
  REPETITIVE_LINE_MIN_COUNT,
  REPETITIVE_LINE_MIN_REPEATS,
  REPETITIVE_LINE_MAX_UNIQUE_RATIO,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_RESULT_FIELD_CHARS,
  MAX_TOOL_RESULT_ARRAY_ITEMS,
  MAX_TOOL_RESULT_OBJECT_KEYS,
  TOOL_RESULT_PRIORITY_KEYS,
  MAX_USER_MESSAGE_CHARS,
  MAX_URL_PREVIEW_CHARS,
  MAX_BASH_OUTPUT_CHARS,
  MAX_COMMAND_PREVIEW_CHARS,
  MAX_RESULT_PREVIEW_CHARS,
  MAX_ERROR_PREVIEW_CHARS,
  ENABLE_TOOL_IMAGE_REPLAY,
  MAX_CONTEXT_INJECTION_CHARS,
} from "./chat-executor-constants.js";
import {
  didToolCallFail,
  parseToolResultObject,
  sanitizeToolCallArgumentsForReplay,
  sanitizeToolCallsForReplay,
} from "./chat-executor-tool-utils.js";
import { safeStringify } from "../tools/types.js";
import {
  hasUnsupportedNarrativeFileClaims,
} from "../utils/delegation-validation.js";
import {
  parseJsonObjectFromText,
  tryParseJsonObject as tryParseObject,
} from "../utils/delegated-contract-normalization.js";

// ============================================================================
// JSON parsing helpers (used by planner + verifier)
// ============================================================================

export { parseJsonObjectFromText, tryParseObject };

// ============================================================================
// Message text extraction
// ============================================================================

/** Extract plain-text content from a gateway message. */
export function extractMessageText(message: GatewayMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

/** Extract plain-text content from an LLM message. */
export function extractLLMMessageText(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

// ============================================================================
// Text truncation and sanitization
// ============================================================================

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

export function sanitizeFinalContent(content: string): string {
  if (!content) return content;
  const collapsed = collapseRunawayRepetition(content);
  if (collapsed.length <= MAX_FINAL_RESPONSE_CHARS) return collapsed;
  return (
    truncateText(collapsed, MAX_FINAL_RESPONSE_CHARS) +
    "\n\n[response truncated: oversized model output suppressed]"
  );
}

const SIMPLE_READ_ONLY_SHELL_COMMANDS = new Set([
  "pwd",
  "whoami",
  "date",
  "hostname",
  "uname",
  "id",
  "ls",
  "cat",
  "echo",
  "head",
  "tail",
  "stat",
  "realpath",
  "readlink",
]);
const SHELL_ADVICE_RE =
  /\b(?:spawns fresh shells|non-persistent|future commands there start|to work in\s+[`~]|prefix like|demo:)\b/i;

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isSimpleReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (/[;&|><\n\r]/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return false;
  const executable = tokens[0]?.toLowerCase() ?? "";
  return SIMPLE_READ_ONLY_SHELL_COMMANDS.has(executable);
}

function extractShellOutputText(toolCall: ToolCallRecord): string | undefined {
  if (toolCall.name !== "desktop.bash" && toolCall.name !== "system.bash") {
    return undefined;
  }
  if (didToolCallFail(toolCall.isError, toolCall.result)) return undefined;
  const parsed = parseToolResultObject(toolCall.result);
  if (!parsed) return undefined;
  if (typeof parsed.exitCode === "number" && parsed.exitCode !== 0) {
    return undefined;
  }

  const stdout = typeof parsed.stdout === "string" ? parsed.stdout.trim() : "";
  const stderr = typeof parsed.stderr === "string" ? parsed.stderr.trim() : "";
  const command =
    toolCall.args &&
      typeof toolCall.args === "object" &&
      !Array.isArray(toolCall.args) &&
      typeof (toolCall.args as { command?: unknown }).command === "string"
      ? ((toolCall.args as { command: string }).command)
      : "";

  if (!isSimpleReadOnlyShellCommand(command)) return undefined;
  if (stdout.length > 0 && stderr.length === 0) return stdout;
  if (stderr.length > 0 && stdout.length === 0) return stderr;
  if (stdout.length > 0 && stderr.length > 0) return `${stdout}\n${stderr}`;
  return undefined;
}

function extractDelegatedToolOutput(
  toolCall: ToolCallRecord,
): string | undefined {
  if (toolCall.name !== "execute_with_agent") {
    return undefined;
  }
  if (didToolCallFail(toolCall.isError, toolCall.result)) {
    return undefined;
  }

  const parsed = parseToolResultObject(toolCall.result);
  if (!parsed) return undefined;
  if (parsed.success === false || parsed.unresolvedToolFailures === true) {
    return undefined;
  }

  const output =
    typeof parsed.output === "string" ? parsed.output.trim() : "";
  if (!output || isLowInformationCompletion(output)) {
    return undefined;
  }
  return output;
}

export function reconcileDirectShellObservationContent(
  content: string,
  toolCalls: readonly ToolCallRecord[],
): string {
  if (!content || toolCalls.length !== 1) return content;
  const shellOutput = extractShellOutputText(toolCalls[0]!);
  if (!shellOutput) return content;

  const trimmed = content.trim();
  const normalizedContent = normalizeInlineText(trimmed);
  const normalizedOutput = normalizeInlineText(shellOutput);
  if (SHELL_ADVICE_RE.test(trimmed)) {
    return shellOutput;
  }
  if (
    normalizedOutput.length > 0 &&
    normalizedContent.includes(normalizedOutput)
  ) {
    return content;
  }

  if (
    trimmed.length === 0 ||
    isLowInformationCompletion(trimmed)
  ) {
    return shellOutput;
  }

  return content;
}

const SIMPLE_CAT_PATH_RE = /^cat\s+(["']?)(\/[^"'`\n\r;&|]+)\1$/i;
const SHELL_WRITE_REDIRECT_RE = />>?\s*(["']?)(\/[^"'`\n\r;&|]+)\1/;

function extractBashCommand(toolCall: ToolCallRecord): string | undefined {
  if (toolCall.name !== "desktop.bash" && toolCall.name !== "system.bash") {
    return undefined;
  }
  if (
    !toolCall.args ||
    typeof toolCall.args !== "object" ||
    Array.isArray(toolCall.args)
  ) {
    return undefined;
  }
  const command = (toolCall.args as { command?: unknown }).command;
  return typeof command === "string" ? command.trim() : undefined;
}

interface VerifiedFileReadObservation {
  readonly path: string;
  readonly contents: string;
}

function extractVerifiedFileReadObservation(
  toolCalls: readonly ToolCallRecord[],
): VerifiedFileReadObservation | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const readCall = toolCalls[index];
    const command = extractBashCommand(readCall);
    if (!command) continue;
    const catMatch = SIMPLE_CAT_PATH_RE.exec(command);
    if (!catMatch) continue;
    if (didToolCallFail(readCall.isError, readCall.result)) continue;

    const parsed = parseToolResultObject(readCall.result);
    const contents =
      parsed && typeof parsed.stdout === "string" ? parsed.stdout : "";
    if (contents.length === 0) continue;

    const path = catMatch[2]!;
    const hasWriteEvidence = toolCalls.slice(0, index).some((toolCall) => {
      if (didToolCallFail(toolCall.isError, toolCall.result)) {
        return false;
      }
      if (
        toolCall.name === "desktop.text_editor" &&
        toolCall.args &&
        typeof toolCall.args === "object" &&
        !Array.isArray(toolCall.args)
      ) {
        const args = toolCall.args as {
          command?: unknown;
          path?: unknown;
        };
        return args.command === "create" && args.path === path;
      }

      const writeCommand = extractBashCommand(toolCall);
      if (!writeCommand) return false;
      const redirectMatch = SHELL_WRITE_REDIRECT_RE.exec(writeCommand);
      if (!redirectMatch) return false;
      return redirectMatch[2] === path;
    });

    if (!hasWriteEvidence) continue;

    return {
      path,
      contents: contents.trimEnd(),
    };
  }

  return undefined;
}

export function reconcileVerifiedFileWorkflowContent(
  content: string,
  toolCalls: readonly ToolCallRecord[],
): string {
  if (!content || toolCalls.length < 2) return content;
  const observation = extractVerifiedFileReadObservation(toolCalls);
  if (!observation) return content;

  const trimmed = content.trim();
  const hasExactPath = trimmed.includes(observation.path);
  const hasExactContents = trimmed.includes(observation.contents);
  if (hasExactPath && hasExactContents) {
    return content;
  }

  if (hasExactContents || isLowInformationCompletion(trimmed)) {
    return `${observation.path}\n${observation.contents}`;
  }

  return content;
}

function extractExactResponseLiteral(messageText: string): string | undefined {
  const directiveMatch =
    /\b(?:return|reply|respond|output|answer)(?:\s+with)?\s+exactly(?:\s+as)?\s+/i.exec(
      messageText,
    );
  const exactlyAsMatch = /\bexactly\s+as\s+/i.exec(messageText);
  const anchorMatch = directiveMatch ?? exactlyAsMatch;
  if (!anchorMatch) {
    return undefined;
  }

  const remainder = messageText
    .slice(anchorMatch.index + anchorMatch[0].length)
    .trim();
  if (!remainder) {
    return extractExactAliasLiteral(messageText);
  }

  const normalized = normalizeExactLiteralCandidate(remainder);
  if (normalized && !GENERIC_EXACT_LITERAL_RE.test(normalized)) {
    return normalized;
  }

  return extractExactAliasLiteral(messageText);
}

function extractExactAliasLiteral(messageText: string): string | undefined {
  const aliasMatch =
    /\b(?:return|reply|respond|output|answer)\b[\s\S]{0,160}?\bas\s+("[^"]+"|'[^']+'|`[^`]+`|[^\n]+?)(?:[.!?](?:\s|$)|$)/i.exec(
      messageText,
    );
  if (!aliasMatch) {
    return undefined;
  }
  return normalizeExactLiteralCandidate(aliasMatch[1] ?? "");
}

function normalizeExactLiteralCandidate(candidate: string): string | undefined {
  const trimmedCandidate = candidate.trim();
  if (trimmedCandidate.length === 0) {
    return undefined;
  }

  const openingQuote = trimmedCandidate[0];
  const quotePairs = new Map<string, string>([
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
  ]);
  const closingQuote = quotePairs.get(openingQuote);
  if (closingQuote) {
    const closingIndex = trimmedCandidate.indexOf(closingQuote, 1);
    if (closingIndex > 1) {
      const quoted = trimmedCandidate.slice(1, closingIndex).trim();
      if (quoted.length > 0 && !GENERIC_EXACT_LITERAL_RE.test(quoted)) {
        return quoted;
      }
    }
    return undefined;
  }

  const unquoted = trimmedCandidate
    .replace(/\s+/g, " ")
    .replace(
      /\s+(?:and|with)\s+(?:nothing\s+else|no\s+extra\s+(?:text|words)|no\s+other\s+text)\b[\s\S]*$/i,
      "",
    )
    .replace(/[.!?]+$/, "")
    .trim();
  if (unquoted.length > 0 && !GENERIC_EXACT_LITERAL_RE.test(unquoted)) {
    return unquoted;
  }

  return undefined;
}

const GENERIC_EXACT_LITERAL_RE =
  /^(?:the\s+)?(?:child\s+answer|answer|result|memorized\s+token|memorised\s+token|token)$/i;

export function reconcileExactResponseContract(
  content: string,
  toolCalls: readonly ToolCallRecord[],
  messageText: string,
  options?: {
    readonly forceLiteralWhenNoToolEvidence?: boolean;
  },
): string {
  if (!content) return content;
  const literal = extractExactResponseLiteral(messageText);
  if (!literal) return content;

  const trimmed = content.trim();
  if (trimmed === literal) {
    return content;
  }

  if (trimmed.includes(literal)) {
    return literal;
  }

  const verifiedFile = extractVerifiedFileReadObservation(toolCalls);
  if (verifiedFile?.contents === literal) {
    return literal;
  }

  const simpleShellOutput =
    toolCalls.length === 1 ? extractShellOutputText(toolCalls[0]!) : undefined;
  if (simpleShellOutput?.trim() === literal) {
    return literal;
  }

  const delegatedOutput =
    toolCalls.length === 1 ? extractDelegatedToolOutput(toolCalls[0]!) : undefined;
  if (delegatedOutput === literal) {
    return literal;
  }
  if (
    delegatedOutput &&
    trimmed === delegatedOutput &&
    literal.endsWith(delegatedOutput) &&
    literal.length > delegatedOutput.length &&
    /^[A-Z0-9_.:-]+[=|:/-]$/i.test(
      literal.slice(0, literal.length - delegatedOutput.length),
    )
  ) {
    return literal;
  }

  if (
    toolCalls.length === 0 &&
    !hasExplicitNonComplianceSignal(trimmed) &&
    !looksLikeExecutionPlan(trimmed) &&
    (
      options?.forceLiteralWhenNoToolEvidence === true ||
      EXACT_CONTRACT_ACK_RE.test(trimmed)
    )
  ) {
    return literal;
  }

  return content;
}

export function reconcileStructuredToolOutcome(
  content: string,
  toolCalls: readonly ToolCallRecord[],
  messageText?: string,
): string {
  if (!content || toolCalls.length === 0) return content;
  const trimmed = content.trim();
  const literal = typeof messageText === "string"
    ? extractExactResponseLiteral(messageText)
    : undefined;

  const hasToolFailure = toolCalls.some((toolCall) =>
    didToolCallFail(toolCall.isError, toolCall.result),
  );
  const hasSubagentFailureSignal = toolCalls.some((toolCall) => {
    if (toolCall.name !== "execute_with_agent") return false;
    const parsedResult = parseToolResultObject(toolCall.result);
    if (!parsedResult) return false;

    if (parsedResult.success === false) return true;
    if (parsedResult.unresolvedToolFailures === true) return true;

    const output =
      typeof parsedResult.output === "string" ? parsedResult.output : "";
    const failedToolCalls =
      typeof parsedResult.failedToolCalls === "number"
        ? parsedResult.failedToolCalls
        : 0;
    if (failedToolCalls <= 0) return false;
    return hasExplicitFailureSignal(output);
  });
  const failedCalls = toolCalls.filter((toolCall) =>
    didToolCallFail(toolCall.isError, toolCall.result),
  );
  const allToolCallsFailed =
    toolCalls.length > 0 && failedCalls.length === toolCalls.length;
  const surfacesFailureDetails =
    hasExplicitFailureSignal(trimmed) ||
    failedCalls.some((toolCall) => {
      const failurePreview = normalizeFailurePreview(
        extractToolFailureMessage(toolCall),
      ).toLowerCase();
      return failurePreview.length > 0 &&
        trimmed.toLowerCase().includes(failurePreview);
    });

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    if (allToolCallsFailed && !surfacesFailureDetails) {
      return buildToolFailureFallback(toolCalls);
    }
    // Narrative file claim guard disabled — Grok models sometimes
    // summarize planned writes before executing them, triggering false
    // rejections that hide useful partial responses.
    // if (hasUnsupportedNarrativeFileClaims(trimmed, toolCalls)) {
    //   return buildUnsupportedFileClaimFallback(toolCalls);
    // }
    if (
      (hasToolFailure || hasSubagentFailureSignal) &&
      (
        isLowInformationCompletion(trimmed) ||
        (
          typeof literal === "string" &&
          literal.length > 0 &&
          trimmed === literal
        )
      )
    ) {
      return buildToolFailureFallback(toolCalls);
    }
    return content;
  }

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
  if (typeof payload.overall !== "string") {
    return content;
  }

  const normalizedOverall = payload.overall.trim().toLowerCase();
  if (normalizedOverall !== "pass") {
    return content;
  }

  const executedTools = new Set(
    toolCalls
      .map((toolCall) => toolCall.name?.trim())
      .filter((name): name is string => Boolean(name)),
  );
  const claimedTools = new Set<string>();
  if (Array.isArray(payload.steps)) {
    for (const step of payload.steps) {
      if (typeof step !== "object" || step === null || Array.isArray(step)) {
        continue;
      }
      const toolName = (step as { tool?: unknown }).tool;
      if (typeof toolName === "string" && toolName.trim().length > 0) {
        claimedTools.add(toolName.trim());
      }
    }
  }

  const claimsUnexecutedTool = Array.from(claimedTools).some(
    (toolName) => !executedTools.has(toolName),
  );
  const hasCheckSummaryContradiction = hasContradictoryPassCheckSummary(payload);

  if (
    !hasToolFailure &&
    !claimsUnexecutedTool &&
    !hasSubagentFailureSignal &&
    !hasCheckSummaryContradiction
  ) {
    return content;
  }

  payload.overall = "fail";
  appendFailureReason(
    payload,
    hasToolFailure,
    claimsUnexecutedTool,
    hasSubagentFailureSignal,
    hasCheckSummaryContradiction,
  );
  return safeStringify(payload);
}

const EXECUTION_PLAN_LINE_RE =
  /^(?:\d+\.\s+|[-*]\s+)(?:scaffold|create|write|edit|implement|build|compile|validate|verify|run|research|compare|open|test|fix|install)\b/i;
const PLAN_HEADING_RE = /^(?:\*\*)?plan(?:\*\*)?:?/im;
const FUTURE_EXECUTION_SIGNAL_RE =
  /\b(?:starting execution|begin(?:ning)? execution|i(?:'ll| will)|going to|next(?: up)?|after that|then)\b/i;

export function reconcileTerminalFailureContent(params: {
  content: string;
  stopReason: string;
  stopReasonDetail?: string;
  toolCalls: readonly ToolCallRecord[];
}): string {
  const { content, stopReason, stopReasonDetail, toolCalls } = params;
  if (stopReason === "completed") return content;

  const fallback = buildTerminalFailureFallback(
    stopReason,
    stopReasonDetail,
    toolCalls,
  );
  const trimmed = content.trim();
  if (trimmed.length === 0) return fallback;
  if (
    isLowInformationCompletion(trimmed) ||
    looksLikeExecutionPlan(trimmed) ||
    (typeof stopReasonDetail === "string" && trimmed === stopReasonDetail.trim())
  ) {
    return fallback;
  }

  return `${fallback}\n\nPartial response before failure:\n${truncateText(trimmed, 600)}`;
}

const EXPLICIT_FAILURE_SIGNAL_RE =
  /\b(command denied|tool denied|denied by user|timed out|timeout|tool not found|failed to spawn|permission denied)\b/i;
const EXPLICIT_NON_COMPLIANCE_SIGNAL_RE =
  /\b(?:can't|cannot|unable|won't|will not|refuse|decline|sorry)\b/i;

function hasExplicitFailureSignal(value: string): boolean {
  return EXPLICIT_FAILURE_SIGNAL_RE.test(value);
}

function hasExplicitNonComplianceSignal(value: string): boolean {
  return hasExplicitFailureSignal(value) ||
    EXPLICIT_NON_COMPLIANCE_SIGNAL_RE.test(value);
}

function appendFailureReason(
  payload: Record<string, unknown>,
  hasToolFailure: boolean,
  claimsUnexecutedTool: boolean,
  hasSubagentFailureSignal: boolean,
  hasCheckSummaryContradiction: boolean,
): void {
  if (!Array.isArray(payload.failure_reasons)) return;
  const reasons = payload.failure_reasons.filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (hasToolFailure && !reasons.includes("tool_call_failed")) {
    reasons.push("tool_call_failed");
  }
  if (claimsUnexecutedTool && !reasons.includes("claims_unexecuted_tool")) {
    reasons.push("claims_unexecuted_tool");
  }
  if (
    hasSubagentFailureSignal &&
    !reasons.includes("subagent_output_contains_failure_signal")
  ) {
    reasons.push("subagent_output_contains_failure_signal");
  }
  if (
    hasCheckSummaryContradiction &&
    !reasons.includes("check_summary_conflicts_with_pass_status")
  ) {
    reasons.push("check_summary_conflicts_with_pass_status");
  }
  payload.failure_reasons = reasons;
}

const LOW_INFORMATION_LINE_RE = /^(done|ok|complete(?:d)?|success|pass)[.!]?$/i;
const LOW_INFORMATION_TOOL_COMPLETION_RE =
  /^(?:complete(?:d)?|ran|executed)\s+(?:[a-z0-9_.-]+\s*){1,4}[.!]?$/i;
const PASS_STATUS_RE = /^pass$/i;
const UNAVAILABLE_VALUE_RE = /\b(?:n\/a|none|null|undefined)\b/i;
const EXACT_CONTRACT_ACK_RE =
  /^(?:(?:i(?:'ve| have)\s+)?(?:memorized|memorised|stored|saved|remembered|noted|ack(?:nowledged)?|understood)|done|ok(?:ay)?|complete(?:d)?|success)(?:\s+(?:it|that|the token|for later recall))?[.!]?$/i;

function isLowInformationCompletion(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return true;
  if (lines.length > 8) return false;
  return lines.every((line) =>
    LOW_INFORMATION_LINE_RE.test(line) ||
    LOW_INFORMATION_TOOL_COMPLETION_RE.test(line)
  );
}

export function looksLikeExecutionPlan(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > 12) return false;
  const planLines = lines.filter((line) => EXECUTION_PLAN_LINE_RE.test(line));
  return planLines.length >= Math.min(3, lines.length);
}

export function isPlanOnlyExecutionResponse(content: string): boolean {
  const trimmed = content.trim();
  if (!looksLikeExecutionPlan(trimmed)) return false;
  return PLAN_HEADING_RE.test(trimmed) || FUTURE_EXECUTION_SIGNAL_RE.test(trimmed);
}

function normalizeFailurePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function buildTerminalFailureFallback(
  stopReason: string,
  stopReasonDetail: string | undefined,
  toolCalls: readonly ToolCallRecord[],
): string {
  const lines = [
    `Execution stopped before completion (${stopReason}).`,
  ];
  if (typeof stopReasonDetail === "string" && stopReasonDetail.trim().length > 0) {
    lines.push(stopReasonDetail.trim());
  }

  const failedCalls = toolCalls.filter((toolCall) =>
    didToolCallFail(toolCall.isError, toolCall.result),
  );
  for (const toolCall of failedCalls.slice(0, 3)) {
    const failure = normalizeFailurePreview(extractToolFailureMessage(toolCall));
    lines.push(`- ${toolCall.name}: ${failure || "tool call failed"}`);
  }
  if (failedCalls.length > 3) {
    lines.push(`- plus ${failedCalls.length - 3} additional tool failures`);
  }

  return lines.join("\n");
}

function buildToolFailureFallback(toolCalls: readonly ToolCallRecord[]): string {
  const failedCalls = toolCalls.filter((toolCall) =>
    didToolCallFail(toolCall.isError, toolCall.result),
  );
  if (failedCalls.length === 0) {
    return "Execution could not be completed due to unresolved tool errors.";
  }

  const lines = [
    "Execution could not be completed due to unresolved tool errors.",
  ];
  for (const toolCall of failedCalls.slice(0, 3)) {
    const failure = normalizeFailurePreview(extractToolFailureMessage(toolCall));
    lines.push(`- ${toolCall.name}: ${failure || "tool call failed"}`);
  }
  if (failedCalls.length > 3) {
    lines.push(`- plus ${failedCalls.length - 3} additional tool failures`);
  }
  return lines.join("\n");
}

function buildUnsupportedFileClaimFallback(
  toolCalls: readonly ToolCallRecord[],
): string {
  const executedTools = toolCalls
    .map((toolCall) => toolCall.name)
    .filter((name, index, values) => values.indexOf(name) === index)
    .slice(0, 4);
  const lines = [
    "Execution did not complete as described: tool evidence did not confirm any file writes.",
  ];
  if (executedTools.length > 0) {
    lines.push(`Executed tools: ${executedTools.join(", ")}`);
  }
  return lines.join("\n");
}

function extractToolFailureMessage(toolCall: ToolCallRecord): string {
  const parsed = parseToolResultObject(toolCall.result);
  if (parsed && typeof parsed.error === "string" && parsed.error.trim().length > 0) {
    return parsed.error;
  }
  if (parsed && typeof parsed.stderr === "string" && parsed.stderr.trim().length > 0) {
    return parsed.stderr;
  }
  if (parsed && typeof parsed.output === "string" && parsed.output.trim().length > 0) {
    return parsed.output;
  }
  if (typeof toolCall.result === "string" && toolCall.result.trim().length > 0) {
    return toolCall.result;
  }
  return "tool call failed";
}

function hasContradictoryPassCheckSummary(
  payload: Record<string, unknown>,
): boolean {
  if (!Array.isArray(payload.checks)) return false;

  for (const check of payload.checks) {
    if (typeof check !== "object" || check === null || Array.isArray(check)) {
      continue;
    }
    const status = (check as { status?: unknown }).status;
    if (typeof status !== "string" || !PASS_STATUS_RE.test(status.trim())) {
      continue;
    }
    const summary = (check as { summary?: unknown }).summary;
    if (typeof summary !== "string" || summary.trim().length === 0) {
      continue;
    }
    const lower = summary.toLowerCase();
    const daemonDown =
      lower.includes("running: false") ||
      lower.includes("running=false") ||
      lower.includes("running false");
    const missingPid = /\bpid\s*:\s*/i.test(summary) && UNAVAILABLE_VALUE_RE.test(summary);
    const missingPort = /\bport\s*:\s*/i.test(summary) && UNAVAILABLE_VALUE_RE.test(summary);
    if (daemonDown || (missingPid && missingPort)) {
      return true;
    }
  }
  return false;
}

export function collapseRunawayRepetition(content: string): string {
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

export function isBase64Like(value: string): boolean {
  if (value.length < 128) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

const DATA_IMAGE_URL_PATTERN =
  /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/;
const DATA_IMAGE_URL_GLOBAL_PATTERN =
  /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
const JSON_BINARY_FIELD_PATTERN =
  /"([A-Za-z0-9_.-]*(?:image|dataurl|data|base64)[A-Za-z0-9_.-]*)"\s*:\s*"([A-Za-z0-9+/=\r\n]{128,})"/gi;
const QUOTED_BASE64_BLOB_PATTERN = /"([A-Za-z0-9+/=\r\n]{512,})"/g;
const RAW_BASE64_BLOB_PATTERN = /[A-Za-z0-9+/=\r\n]{2048,}/g;

function sanitizeRawToolResultText(value: string): string {
  return value
    .replace(DATA_IMAGE_URL_GLOBAL_PATTERN, "(see image)")
    .replace(
      JSON_BINARY_FIELD_PATTERN,
      (_match: string, key: string) => `"${key}":"(base64 omitted)"`,
    )
    .replace(QUOTED_BASE64_BLOB_PATTERN, '"(base64 omitted)"')
    .replace(RAW_BASE64_BLOB_PATTERN, "(base64 omitted)")
    .trim();
}

// ============================================================================
// Prompt shape estimation
// ============================================================================

export function estimateContentChars(
  content: string | LLMContentPart[],
): number {
  if (typeof content === "string") return content.length;
  return content.reduce((sum, part) => {
    if (part.type === "text") return sum + part.text.length;
    return sum + part.image_url.url.length;
  }, 0);
}

export function estimateMessageChars(message: LLMMessage): number {
  // Small role/metadata overhead for rough token approximation.
  return (
    estimateContentChars(message.content) +
    estimateToolCallsChars(message.toolCalls) +
    64
  );
}

export function estimatePromptShape(
  messages: readonly LLMMessage[],
): ChatPromptShape {
  let systemMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  let estimatedChars = 0;
  let systemPromptChars = 0;

  for (const message of messages) {
    estimatedChars += estimateMessageChars(message);
    if (message.role === "system") {
      systemMessages++;
      systemPromptChars += estimateContentChars(message.content);
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

// ============================================================================
// History normalization
// ============================================================================

export function normalizeHistory(history: readonly LLMMessage[]): LLMMessage[] {
  return history.map((entry) => {
    const sanitizedToolCalls = sanitizeToolCallsForReplay(
      entry.toolCalls,
    );
    const baseMessage = sanitizedToolCalls
      ? { ...entry, toolCalls: sanitizedToolCalls }
      : entry;
    if (typeof entry.content === "string") {
      if (entry.role === "tool") {
        const prepared = prepareToolResultForPrompt(entry.content);
        return { ...baseMessage, content: prepared.text };
      }
      return {
        ...baseMessage,
        content: truncateText(
          entry.content,
          MAX_HISTORY_MESSAGE_CHARS,
        ),
      };
    }

    const parts: LLMContentPart[] = entry.content.map((part) => {
      if (part.type === "text") {
        return {
          type: "text" as const,
          text: truncateText(
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
    return { ...baseMessage, content: parts };
  });
}

function extractStatefulReconciliationText(
  content: string | LLMContentPart[],
): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

export function toStatefulReconciliationMessage(
  message: LLMMessage,
): LLMMessage {
  const sanitizedToolCalls = sanitizeToolCallsForReplay(
    message.toolCalls,
  );
  const baseMessage = sanitizedToolCalls
    ? { ...message, toolCalls: sanitizedToolCalls }
    : message;

  if (message.role === "tool") {
    return {
      ...baseMessage,
      content: prepareToolResultForPrompt(
        extractStatefulReconciliationText(message.content),
      ).text,
    };
  }

  return {
    ...baseMessage,
    content: extractStatefulReconciliationText(message.content),
  };
}

export function normalizeHistoryForStatefulReconciliation(
  history: readonly LLMMessage[],
): LLMMessage[] {
  return history.map((entry) => toStatefulReconciliationMessage(entry));
}

// ============================================================================
// Tool call serialization
// ============================================================================

export function estimateToolCallsChars(
  toolCalls: readonly LLMToolCall[] | undefined,
): number {
  if (!toolCalls || toolCalls.length === 0) return 0;
  return toolCalls.reduce((sum, call) => {
    return sum + call.id.length + call.name.length + call.arguments.length + 16;
  }, 0);
}

export { sanitizeToolCallsForReplay, sanitizeToolCallArgumentsForReplay };

// ============================================================================
// JSON sanitization for prompts
// ============================================================================

export function sanitizeJsonForPrompt(
  value: unknown,
  captureDataUrl: (url: string) => void,
): unknown {
  const keyPriority = (key: string): number => {
    const normalized = key.toLowerCase();
    const idx = TOOL_RESULT_PRIORITY_KEYS.indexOf(
      normalized as (typeof TOOL_RESULT_PRIORITY_KEYS)[number],
    );
    return idx >= 0 ? idx : TOOL_RESULT_PRIORITY_KEYS.length + 1;
  };

  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      captureDataUrl(value);
      return "(see image)";
    }
    if (isBase64Like(value)) {
      return "(base64 omitted)";
    }
    return truncateText(value, MAX_TOOL_RESULT_FIELD_CHARS);
  }
  if (Array.isArray(value)) {
    const sanitizedItems = value
      .slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS)
      .map((item) => sanitizeJsonForPrompt(item, captureDataUrl));
    const omitted = value.length - sanitizedItems.length;
    if (omitted > 0) {
      sanitizedItems.push(`[${omitted} items omitted]`);
    }
    return sanitizedItems;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const orderedEntries = Object.entries(obj)
      .sort(([a], [b]) => {
        const priorityDelta = keyPriority(a) - keyPriority(b);
        if (priorityDelta !== 0) return priorityDelta;
        return a.localeCompare(b);
      })
      .slice(0, MAX_TOOL_RESULT_OBJECT_KEYS);
    for (const [key, field] of orderedEntries) {
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
          keyLower === "data" ||
          keyLower.endsWith("base64")
        ) {
          if (isBase64Like(field)) {
            out[key] = "(base64 omitted)";
            continue;
          }
        }
        if (isBase64Like(field)) {
          out[key] = "(base64 omitted)";
          continue;
        }
        out[key] = truncateText(
          field,
          MAX_TOOL_RESULT_FIELD_CHARS,
        );
        continue;
      }
      out[key] = sanitizeJsonForPrompt(field, captureDataUrl);
    }
    const omittedKeys = Object.keys(obj).length - orderedEntries.length;
    if (omittedKeys > 0) {
      out.__truncatedKeys = omittedKeys;
    }
    return out;
  }
  return value;
}

export function prepareToolResultForPrompt(result: string): {
  text: string;
  dataUrl?: string;
} {
  let capturedDataUrl: string | undefined;
  const setDataUrl = (url: string): void => {
    if (!capturedDataUrl) capturedDataUrl = url;
  };

  try {
    const parsed = JSON.parse(result) as unknown;
    const sanitized = sanitizeJsonForPrompt(parsed, setDataUrl);
    return {
      text: truncateText(
        safeStringify(sanitized),
        MAX_TOOL_RESULT_CHARS,
      ),
      ...(capturedDataUrl ? { dataUrl: capturedDataUrl } : {}),
    };
  } catch {
    const dataUrlMatch = result.match(DATA_IMAGE_URL_PATTERN);
    const text = sanitizeRawToolResultText(result);
    return {
      text: truncateText(text, MAX_TOOL_RESULT_CHARS),
      ...(dataUrlMatch ? { dataUrl: dataUrlMatch[0] } : {}),
    };
  }
}

export function buildPromptToolContent(
  result: string,
  remainingImageBudget: number,
): {
  content: string | import("./types.js").LLMContentPart[];
  remainingImageBudget: number;
} {
  const prepared = prepareToolResultForPrompt(result);
  if (!prepared.dataUrl) {
    return { content: prepared.text, remainingImageBudget };
  }

  if (!ENABLE_TOOL_IMAGE_REPLAY) {
    const note = truncateText(
      `${prepared.text}\n\n[Image artifact kept out-of-band by default; prefer URL/DOM/text/process checks before visual verification.]`,
      MAX_TOOL_RESULT_CHARS,
    );
    return { content: note, remainingImageBudget };
  }

  // Prevent huge inline screenshots from blowing up prompt size.
  if (prepared.dataUrl.length > remainingImageBudget) {
    const note =
      prepared.text +
      "\n\n[Screenshot omitted from prompt due image context budget]";
    return {
      content: truncateText(note, MAX_TOOL_RESULT_CHARS),
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

// ============================================================================
// Runtime grounding ledger
// ============================================================================

const MAX_TOOL_LEDGER_ENTRY_RESULT_CHARS = 320;
const MAX_TOOL_LEDGER_ENTRY_ARGUMENT_CHARS = 240;
const MAX_TOOL_LEDGER_CITATION_CHARS = 240;
const MAX_TOOL_LEDGER_FAILURE_COUNT = 8;

function sanitizeLedgerValue(
  value: unknown,
  maxChars: number,
): unknown {
  let capturedDataUrl = false;
  const sanitized = sanitizeJsonForPrompt(
    value,
    () => {
      capturedDataUrl = true;
    },
  );
  const rendered = safeStringify(sanitized);
  if (rendered.length <= maxChars) {
    if (capturedDataUrl && typeof sanitized === "object" && sanitized !== null) {
      return {
        ...(sanitized as Record<string, unknown>),
        __omittedImageData: true,
      };
    }
    return sanitized;
  }
  return {
    __truncated: true,
    originalChars: rendered.length,
    preview: truncateText(rendered, maxChars),
    ...(capturedDataUrl ? { omittedImageData: true } : {}),
  };
}

function buildToolExecutionLedgerEntries(
  toolCalls: readonly ToolCallRecord[],
): Array<Record<string, unknown>> {
  return toolCalls.map((toolCall, index) => {
    const preparedResult = prepareToolResultForPrompt(toolCall.result);
    return {
      index: index + 1,
      tool: toolCall.name,
      status: didToolCallFail(toolCall.isError, toolCall.result)
        ? "error"
        : "success",
      durationMs: toolCall.durationMs,
      args: sanitizeLedgerValue(
        toolCall.args,
        MAX_TOOL_LEDGER_ENTRY_ARGUMENT_CHARS,
      ),
      resultPreview: truncateText(
        preparedResult.text,
        MAX_TOOL_LEDGER_ENTRY_RESULT_CHARS,
      ),
    };
  });
}

function buildToolExecutionLedgerPayload(params: {
  toolCalls: readonly ToolCallRecord[];
  providerEvidence?: LLMProviderEvidence;
}): Record<string, unknown> {
  const { toolCalls, providerEvidence } = params;
  const failedCalls = toolCalls.filter((toolCall) =>
    didToolCallFail(toolCall.isError, toolCall.result),
  );
  const citations = (providerEvidence?.citations ?? [])
    .map((citation) => truncateText(citation, MAX_TOOL_LEDGER_CITATION_CHARS));

  return {
    authoritative: true,
    toolCallCount: toolCalls.length,
    successfulToolCalls: toolCalls.length - failedCalls.length,
    failedToolCalls: failedCalls.length,
    toolCalls: buildToolExecutionLedgerEntries(toolCalls),
    ...(failedCalls.length > 0
      ? {
        failedToolNames: failedCalls
          .slice(0, MAX_TOOL_LEDGER_FAILURE_COUNT)
          .map((toolCall) => toolCall.name),
      }
      : {}),
    ...(citations.length > 0 ? { providerCitations: citations } : {}),
  };
}

function compactToolExecutionLedgerPayload(
  params: {
    toolCalls: readonly ToolCallRecord[];
    providerEvidence?: LLMProviderEvidence;
  },
): Record<string, unknown> {
  const { toolCalls, providerEvidence } = params;
  const failed = toolCalls
    .map((toolCall, index) => ({ toolCall, index }))
    .filter(({ toolCall }) => didToolCallFail(toolCall.isError, toolCall.result));
  const successful = toolCalls
    .map((toolCall, index) => ({ toolCall, index }))
    .filter(({ toolCall }) => !didToolCallFail(toolCall.isError, toolCall.result));
  const selected = new Set<number>();
  for (const { index } of failed) selected.add(index);
  for (let i = successful.length - 1; i >= 0 && selected.size < 12; i--) {
    selected.add(successful[i]!.index);
  }

  const retainedToolCalls = toolCalls.filter((_, index) => selected.has(index));
  const omittedCount = toolCalls.length - retainedToolCalls.length;
  return {
    ...buildToolExecutionLedgerPayload({
      toolCalls: retainedToolCalls,
      providerEvidence,
    }),
    truncatedLedger: true,
    omittedToolCalls: omittedCount > 0 ? omittedCount : 0,
  };
}

export function buildToolExecutionGroundingMessage(params: {
  toolCalls: readonly ToolCallRecord[];
  providerEvidence?: LLMProviderEvidence;
}): LLMMessage | undefined {
  const { toolCalls, providerEvidence } = params;
  if (toolCalls.length === 0 && (providerEvidence?.citations?.length ?? 0) === 0) {
    return undefined;
  }

  const prefix =
    "Runtime execution ledger. These records are authoritative. " +
    "Ground any final answer only in the tool calls and provider evidence below. " +
    "Do not claim unexecuted tools, files, steps, or outcomes.\n";

  let payload = buildToolExecutionLedgerPayload({ toolCalls, providerEvidence });
  let content = prefix + safeStringify(payload);
  if (content.length > MAX_CONTEXT_INJECTION_CHARS) {
    payload = compactToolExecutionLedgerPayload({ toolCalls, providerEvidence });
    content = prefix + safeStringify(payload);
  }

  return {
    role: "system",
    content: truncateText(content, MAX_CONTEXT_INJECTION_CHARS),
  };
}

// ============================================================================
// User message handling
// ============================================================================

/** Append a user message, handling multimodal (image) attachments. */
export function appendUserMessage(
  messages: LLMMessage[],
  sections: PromptBudgetSection[],
  message: GatewayMessage,
  reconciliationMessages?: LLMMessage[],
): void {
  const imageAttachments = (message.attachments ?? []).filter(
    (a) => a.data && a.mimeType.startsWith("image/"),
  );
  const trimmedUserText = truncateText(
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
    sections.push("user");
  } else {
    messages.push({ role: "user", content: trimmedUserText });
    sections.push("user");
  }

  reconciliationMessages?.push({
    role: "user",
    content: message.content,
  });
}

// ============================================================================
// Fallback content generation
// ============================================================================

/**
 * Build a human-readable fallback when the LLM returned empty content
 * after tool calls (e.g. when maxToolRounds is hit mid-loop).
 */
export function generateFallbackContent(
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
      return summarizeToolCalls(successes);
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
export function summarizeToolCalls(
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
    } else if (tc.name === "execute_with_agent") {
      const delegatedOutput = extractDelegatedToolOutput(tc);
      if (delegatedOutput) {
        summaries.push(
          delegatedOutput.slice(0, MAX_RESULT_PREVIEW_CHARS),
        );
      } else {
        summaries.push(`Completed ${tc.name}`);
      }
    } else {
      summaries.push(`Completed ${tc.name}`);
    }
  }
  return summaries.length > 0 ? summaries.join("\n") : "Done!";
}
