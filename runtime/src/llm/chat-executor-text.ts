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
  MAX_HISTORY_MESSAGES,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_RESULT_FIELD_CHARS,
  MAX_TOOL_CALL_ARGUMENT_CHARS,
  MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS,
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
} from "./chat-executor-constants.js";
import {
  didToolCallFail,
  parseToolResultObject,
} from "./chat-executor-tool-utils.js";
import { safeStringify } from "../tools/types.js";

// ============================================================================
// JSON parsing helpers (used by planner + verifier)
// ============================================================================

export function parseJsonObjectFromText(
  content: string,
): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  const direct = tryParseObject(trimmed);
  if (direct) return direct;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    return tryParseObject(candidate);
  }
  return undefined;
}

export function tryParseObject(
  candidate: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

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

export function reconcileStructuredToolOutcome(
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
  if (typeof payload.overall !== "string") {
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

  if (!hasToolFailure && !claimsUnexecutedTool && !hasSubagentFailureSignal) {
    return content;
  }

  payload.overall = "fail";
  appendFailureReason(payload, hasToolFailure, claimsUnexecutedTool, hasSubagentFailureSignal);
  return safeStringify(payload);
}

const EXPLICIT_FAILURE_SIGNAL_RE =
  /\b(command denied|tool denied|denied by user|timed out|timeout|tool not found|failed to spawn|permission denied)\b/i;

function hasExplicitFailureSignal(value: string): boolean {
  return EXPLICIT_FAILURE_SIGNAL_RE.test(value);
}

function appendFailureReason(
  payload: Record<string, unknown>,
  hasToolFailure: boolean,
  claimsUnexecutedTool: boolean,
  hasSubagentFailureSignal: boolean,
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
  payload.failure_reasons = reasons;
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
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  return recent.map((entry) => {
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

export function sanitizeToolCallsForReplay(
  toolCalls: readonly LLMToolCall[] | undefined,
): LLMToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    arguments: sanitizeToolCallArgumentsForReplay(
      toolCall.arguments,
    ),
  }));
}

export function sanitizeToolCallArgumentsForReplay(raw: string): string {
  if (raw.length <= MAX_TOOL_CALL_ARGUMENT_CHARS) {
    return raw;
  }
  const preview = truncateText(
    raw,
    MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS,
  );
  return safeStringify({
    __truncatedToolCallArgs: true,
    originalChars: raw.length,
    preview,
  });
}

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
// User message handling
// ============================================================================

/** Append a user message, handling multimodal (image) attachments. */
export function appendUserMessage(
  messages: LLMMessage[],
  sections: PromptBudgetSection[],
  message: GatewayMessage,
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
    } else {
      summaries.push("Done");
    }
  }
  return summaries.length > 0 ? summaries.join("\n") : "Done!";
}
