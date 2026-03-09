/**
 * Trace, stateful continuation, and tool-selection helpers for the Grok adapter.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type {
  LLMCompactionItemRef,
  LLMMessage,
  LLMTool,
  LLMToolChoice,
} from "../types.js";
import { safeStringify } from "../../tools/types.js";

const MAX_TOOL_DESCRIPTION_CHARS = 200;
const MAX_TOOL_SCHEMA_CHARS_PER_TOOL = 3_000;
const MAX_TOOL_SCHEMA_CHARS_TOTAL = 40_000;
const MAX_STATEFUL_RECONCILIATION_WINDOW = 256;
const STATEFUL_HASH_VERSION = "v1";
const TOOL_METADATA_KEYS = new Set([
  "description",
  "title",
  "examples",
  "default",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const PRIORITY_TOOL_NAMES = new Set([
  "system.bash",
  "desktop.bash",
  "desktop.screenshot",
  "desktop.window_list",
  "desktop.click",
  "desktop.type",
  "desktop.keypress",
  "desktop.mouse_move",
  "desktop.scroll",
]);

export type ToolResolutionStrategy =
  | "all_tools_no_filter"
  | "all_tools_empty_filter"
  | "subset_exact"
  | "subset_partial"
  | "fallback_full_catalog_no_matches";

export interface ToolSelectionDiagnostics {
  readonly tools: Record<string, unknown>[];
  readonly chars: number;
  readonly requestedToolNames: readonly string[];
  readonly resolvedToolNames: readonly string[];
  readonly missingRequestedToolNames: readonly string[];
  readonly providerCatalogToolCount: number;
  readonly toolResolution: ToolResolutionStrategy;
  readonly toolsAttached: boolean;
  readonly toolSuppressionReason?: string;
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

export function extractTraceToolNames(tools: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const record = tool as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.trim().length > 0) {
      names.push(record.name.trim());
      continue;
    }
    if (
      record.function &&
      typeof record.function === "object" &&
      !Array.isArray(record.function) &&
      typeof (record.function as Record<string, unknown>).name === "string"
    ) {
      names.push(String((record.function as Record<string, unknown>).name).trim());
      continue;
    }
    if (typeof record.type === "string" && record.type.trim().length > 0) {
      names.push(record.type.trim());
    }
  }
  return names;
}

export function summarizeTraceToolChoice(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.type === "function" &&
    typeof record.name === "string" &&
    record.name.trim().length > 0
  ) {
    return `function:${record.name.trim()}`;
  }
  try {
    return safeStringify(record);
  } catch {
    return "[unserializable]";
  }
}

export function buildToolSelectionTraceContext(
  selection: ToolSelectionDiagnostics,
  toolChoice: LLMToolChoice | undefined,
): Record<string, unknown> {
  return {
    requestedToolNames: selection.requestedToolNames,
    resolvedToolNames: selection.resolvedToolNames,
    missingRequestedToolNames: selection.missingRequestedToolNames,
    toolResolution: selection.toolResolution,
    providerCatalogToolCount: selection.providerCatalogToolCount,
    toolsAttached: selection.toolsAttached,
    ...(selection.toolSuppressionReason
      ? { toolSuppressionReason: selection.toolSuppressionReason }
      : {}),
    requestedToolChoice:
      typeof toolChoice === "string"
        ? toolChoice
        : toolChoice?.name,
  };
}

export function cloneProviderTracePayload(
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

export function buildProviderTraceErrorPayload(
  error: unknown,
): Record<string, unknown> {
  if (error instanceof Error) {
    const payload: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) payload.stack = error.stack;
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "string" ||
      typeof code === "number" ||
      typeof code === "boolean"
    ) {
      payload.code = code;
    }
    const status = (error as { status?: unknown }).status;
    if (
      typeof status === "string" ||
      typeof status === "number" ||
      typeof status === "boolean"
    ) {
      payload.status = status;
    }
    return payload;
  }
  return { error: String(error) };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function normalizeHashContent(content: LLMMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image_url",
      url: part.image_url.url,
    };
  });
}

function normalizeMessageForReconciliation(message: LLMMessage): unknown {
  const normalized: Record<string, unknown> = {
    role: message.role,
    content: normalizeHashContent(message.content),
  };
  if (message.phase) normalized.phase = message.phase;
  if (message.toolCallId) normalized.toolCallId = message.toolCallId;
  if (message.toolName) normalized.toolName = message.toolName;
  if (message.toolCalls && message.toolCalls.length > 0) {
    normalized.toolCalls = message.toolCalls
      .map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  return normalized;
}

export function computeReconciliationChain(
  messages: readonly LLMMessage[],
  windowSize: number,
): { anchorHash: string; chain: string[] } {
  const boundedWindowSize = Math.min(
    MAX_STATEFUL_RECONCILIATION_WINDOW,
    Math.max(1, Math.floor(windowSize)),
  );
  const start = Math.max(0, messages.length - boundedWindowSize);
  const window = messages.slice(start);
  let rolling = hashText(`agenc:grok:stateful:${STATEFUL_HASH_VERSION}:root`);
  const chain: string[] = [];

  for (const message of window) {
    const normalized = normalizeMessageForReconciliation(message);
    const turnHash = hashText(stableStringify(normalized));
    rolling = hashText(`${rolling}|${turnHash}`);
    chain.push(rolling);
  }

  return { anchorHash: rolling, chain };
}

export function isContinuationRetrievalFailure(error: unknown): boolean {
  const e = error as Record<string, unknown> | null;
  const statusRaw = e?.status ?? e?.statusCode;
  const parsedStatus =
    typeof statusRaw === "number"
      ? statusRaw
      : Number.parseInt(String(statusRaw ?? ""), 10);
  const status = Number.isFinite(parsedStatus) ? parsedStatus : undefined;
  const message = String(e?.message ?? "").toLowerCase();

  if (status === 404 && message.includes("response")) return true;
  if (!message.includes("previous") && !message.includes("response")) {
    return false;
  }
  return (
    message.includes("previous_response_id") ||
    message.includes("previous response") ||
    message.includes("not found") ||
    message.includes("expired") ||
    message.includes("retriev")
  );
}

function toProviderErrorMessage(error: unknown): string {
  if (typeof error === "string") return error.toLowerCase();
  if (!error || typeof error !== "object") return "";
  return String((error as { message?: unknown }).message ?? "").toLowerCase();
}

function isUnsupportedFieldError(message: string): boolean {
  return (
    message.includes("unknown") ||
    message.includes("unsupported") ||
    message.includes("invalid") ||
    message.includes("unexpected") ||
    message.includes("additional properties") ||
    message.includes("not allowed")
  );
}

export function isAssistantPhaseRejection(error: unknown): boolean {
  const message = toProviderErrorMessage(error);
  return message.includes("phase") && isUnsupportedFieldError(message);
}

export function isServerCompactionRejection(error: unknown): boolean {
  const message = toProviderErrorMessage(error);
  if (
    !message.includes("context_management") &&
    !message.includes("compact_threshold") &&
    !message.includes("compaction")
  ) {
    return false;
  }
  return isUnsupportedFieldError(message);
}

function hashOpaqueCompactionItem(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function extractCompactionItemRefs(
  response: Record<string, unknown>,
): LLMCompactionItemRef[] {
  const output = Array.isArray(response.output)
    ? (response.output as Array<Record<string, unknown>>)
    : [];
  const items: LLMCompactionItemRef[] = [];
  for (const item of output) {
    const type = typeof item.type === "string" ? item.type.trim() : "";
    if (type.length === 0 || !/compact/i.test(type)) {
      continue;
    }
    const id =
      typeof item.id === "string" && item.id.trim().length > 0
        ? item.id.trim()
        : undefined;
    items.push({
      type,
      id,
      digest: hashOpaqueCompactionItem(item),
    });
  }
  return items;
}

function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((item) => sanitizeSchema(item));
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(input)) {
      if (TOOL_METADATA_KEYS.has(key)) continue;
      if (key === "enum" && Array.isArray(field)) {
        output[key] = field.slice(0, 64);
        continue;
      }
      output[key] = sanitizeSchema(field);
    }
    return output;
  }
  return value;
}

function toolPriority(name: string): number {
  if (PRIORITY_TOOL_NAMES.has(name)) return 0;
  if (name.startsWith("desktop.")) return 1;
  if (name.startsWith("system.")) return 2;
  return 3;
}

export function slimTools(
  tools: readonly LLMTool[],
): { tools: LLMTool[]; chars: number } {
  if (tools.length === 0) return { tools: [], chars: 0 };

  const ordered = [...tools].sort((a, b) => {
    const pa = toolPriority(a.function.name);
    const pb = toolPriority(b.function.name);
    if (pa !== pb) return pa - pb;
    return a.function.name.localeCompare(b.function.name);
  });

  const selected: LLMTool[] = [];
  let usedChars = 0;

  for (const tool of ordered) {
    const sanitizedParams = sanitizeSchema(tool.function.parameters);
    let normalizedParams = sanitizedParams;
    if (
      JSON.stringify(sanitizedParams).length > MAX_TOOL_SCHEMA_CHARS_PER_TOOL
    ) {
      normalizedParams = { type: "object", additionalProperties: true };
    }

    const slim: LLMTool = {
      type: "function",
      function: {
        name: tool.function.name,
        description: truncate(
          tool.function.description ?? "",
          MAX_TOOL_DESCRIPTION_CHARS,
        ),
        parameters: normalizedParams as Record<string, unknown>,
      },
    };

    const slimChars = JSON.stringify(slim).length;
    if (usedChars + slimChars > MAX_TOOL_SCHEMA_CHARS_TOTAL) {
      continue;
    }
    selected.push(slim);
    usedChars += slimChars;
  }

  if (selected.length === 0) {
    const first = ordered[0];
    const fallbackTool: LLMTool = {
      type: "function",
      function: {
        name: first.function.name,
        description: truncate(
          first.function.description ?? "",
          MAX_TOOL_DESCRIPTION_CHARS,
        ),
        parameters: { type: "object", additionalProperties: true },
      },
    };
    const chars = JSON.stringify(fallbackTool).length;
    return { tools: [fallbackTool], chars };
  }

  return { tools: selected, chars: usedChars };
}

export function toSlimTool(tool: LLMTool): { tool: LLMTool; chars: number } {
  const sanitizedParams = sanitizeSchema(tool.function.parameters);
  let normalizedParams = sanitizedParams;
  if (
    JSON.stringify(sanitizedParams).length > MAX_TOOL_SCHEMA_CHARS_PER_TOOL
  ) {
    normalizedParams = { type: "object", additionalProperties: true };
  }

  const slim: LLMTool = {
    type: "function",
    function: {
      name: tool.function.name,
      description: truncate(
        tool.function.description ?? "",
        MAX_TOOL_DESCRIPTION_CHARS,
      ),
      parameters: normalizedParams as Record<string, unknown>,
    },
  };

  return {
    tool: slim,
    chars: JSON.stringify(slim).length,
  };
}
