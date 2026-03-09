import { createHash } from "node:crypto";
import { safeStringify } from "../tools/types.js";

const BASE64_DATA_URL_PREFIX = /^data:([^;,]+)?;base64,/i;
const BASE64_BLOCK_PATTERN =
  /^(?:[A-Za-z0-9+/]{4}){256,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const DISALLOWED_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const REPLACEMENT_CHAR_PATTERN = /\uFFFD/g;
const BOX_DRAWING_CHAR_PATTERN = /[╭╮╰╯│─┌┐└┘├┤┬┴┼═║╔╗╚╝]/g;

const DEFAULT_PREVIEW_MAX_CHARS = 20_000;
const DEFAULT_PREVIEW_MAX_DEPTH = 4;
const DEFAULT_PREVIEW_MAX_ARRAY_ITEMS = 40;
const DEFAULT_PREVIEW_MAX_OBJECT_KEYS = 80;

interface TraceSerializationState {
  readonly depth: number;
  readonly activePath: WeakSet<object>;
}

interface TraceSerializationOptions {
  readonly maxChars?: number;
  readonly maxDepth?: number;
  readonly maxArrayItems?: number;
  readonly maxObjectKeys?: number;
  readonly limitCollections: boolean;
  readonly transformString: (value: string, maxChars: number) => unknown;
}

export interface TracePreviewSerializationOptions {
  readonly maxChars?: number;
  readonly maxDepth?: number;
  readonly maxArrayItems?: number;
  readonly maxObjectKeys?: number;
}

function truncateTraceText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function buildShaDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function inspectTraceText(value: string): {
  cleaned: string;
  ansiEscapes: number;
  controlChars: number;
  replacementChars: number;
  frameChars: number;
  lineCount: number;
  hasWhitespaceRun: boolean;
} {
  const ansiEscapes = countMatches(value, ANSI_ESCAPE_PATTERN);
  const withoutAnsi = value.replace(ANSI_ESCAPE_PATTERN, "");
  const controlChars = countMatches(
    withoutAnsi,
    DISALLOWED_CONTROL_CHAR_PATTERN,
  );
  const replacementChars = countMatches(withoutAnsi, REPLACEMENT_CHAR_PATTERN);
  const frameChars = countMatches(withoutAnsi, BOX_DRAWING_CHAR_PATTERN);
  const cleaned = withoutAnsi.replace(DISALLOWED_CONTROL_CHAR_PATTERN, " ");
  return {
    cleaned,
    ansiEscapes,
    controlChars,
    replacementChars,
    frameChars,
    lineCount: cleaned.length === 0 ? 0 : cleaned.split(/\r?\n/).length,
    hasWhitespaceRun: / {24,}/.test(cleaned),
  };
}

function summarizeBinaryStringForArtifact(
  value: string,
): Record<string, unknown> | undefined {
  const dataUrlMatch = value.match(BASE64_DATA_URL_PREFIX);
  if (dataUrlMatch) {
    return {
      kind: "data_url_base64",
      mediaType: dataUrlMatch[1] ?? "application/octet-stream",
      chars: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }

  const compact = value.replace(/\s+/g, "");
  if (compact.length >= 1024 && BASE64_BLOCK_PATTERN.test(compact)) {
    return {
      kind: "base64_blob",
      chars: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }

  return undefined;
}

function summarizeBinaryStringForPreview(
  value: string,
): Record<string, unknown> | undefined {
  const dataUrlMatch = value.match(BASE64_DATA_URL_PREFIX);
  if (dataUrlMatch) {
    const commaIndex = value.indexOf(",");
    const base64 = commaIndex > 0 ? value.slice(commaIndex + 1) : "";
    return {
      artifactType: "image_data_url",
      mimeType: dataUrlMatch[1] ?? "application/octet-stream",
      digest: `sha256:${createHash("sha256").update(base64).digest("hex")}`,
      bytes: Math.max(0, Math.floor((base64.length * 3) / 4)),
      externalized: true,
    };
  }

  const compact = value.replace(/\s+/g, "");
  if (compact.length >= 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    return {
      artifactType: "base64_blob",
      digest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
      chars: value.length,
      externalized: true,
    };
  }

  return undefined;
}

function summarizeSpecialTextForPreview(
  value: string,
): Record<string, unknown> | undefined {
  const inspection = inspectTraceText(value);
  if (
    value.includes("\0") ||
    inspection.controlChars >= 8 ||
    (inspection.controlChars >= 2 && value.length >= 128) ||
    (inspection.replacementChars >= 8 && value.length >= 128)
  ) {
    return {
      artifactType: "binary_like_text",
      digest: buildShaDigest(value),
      chars: value.length,
      lines: inspection.lineCount,
      controlChars: inspection.controlChars,
      replacementChars: inspection.replacementChars,
      externalized: true,
    };
  }

  if (
    inspection.ansiEscapes > 0 &&
    (value.length >= 256 ||
      inspection.lineCount > 4 ||
      inspection.frameChars >= 4 ||
      inspection.hasWhitespaceRun)
  ) {
    return {
      artifactType: "terminal_capture",
      digest: buildShaDigest(value),
      chars: value.length,
      lines: inspection.lineCount,
      ansiEscapes: inspection.ansiEscapes,
      frameChars: inspection.frameChars,
      externalized: true,
    };
  }

  return undefined;
}

function formatTraceTextSummaryForSnippet(
  summary: Record<string, unknown>,
): string {
  const digest =
    typeof summary.digest === "string" ? ` ${summary.digest}` : "";
  if (summary.artifactType === "terminal_capture") {
    return `[terminal capture omitted${digest} lines:${summary.lines ?? "?"} ansiEscapes:${summary.ansiEscapes ?? 0} chars:${summary.chars ?? "?"}]`;
  }
  if (summary.artifactType === "binary_like_text") {
    return `[binary-like text omitted${digest} controlChars:${summary.controlChars ?? 0} chars:${summary.chars ?? "?"}]`;
  }
  if (summary.artifactType === "image_data_url") {
    return `[image data url omitted${digest} bytes:${summary.bytes ?? "?"}]`;
  }
  if (summary.artifactType === "base64_blob") {
    return `[base64 blob omitted${digest} chars:${summary.chars ?? "?"}]`;
  }
  return safeStringify(summary);
}

function toSerializableError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

function serializeTraceValue(
  value: unknown,
  options: TraceSerializationOptions,
  state: TraceSerializationState,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return options.transformString(
      value,
      options.maxChars ?? DEFAULT_PREVIEW_MAX_CHARS,
    );
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return serializeTraceValue(toSerializableError(value), options, state);
  }
  if (typeof value !== "object") {
    return options.transformString(
      String(value),
      options.maxChars ?? DEFAULT_PREVIEW_MAX_CHARS,
    );
  }
  if (state.activePath.has(value)) return "[circular]";
  if (
    options.limitCollections &&
    state.depth >= (options.maxDepth ?? DEFAULT_PREVIEW_MAX_DEPTH)
  ) {
    return "[depth-truncated]";
  }

  state.activePath.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = options.limitCollections
        ? value.slice(0, options.maxArrayItems ?? DEFAULT_PREVIEW_MAX_ARRAY_ITEMS)
        : value;
      const serialized = entries.map((entry) =>
        serializeTraceValue(entry, options, {
          depth: state.depth + 1,
          activePath: state.activePath,
        }),
      );
      if (options.limitCollections && value.length > entries.length) {
        serialized.push(`[${value.length - entries.length} more item(s)]`);
      }
      return serialized;
    }

    const entries = Object.entries(value);
    const limitedEntries = options.limitCollections
      ? entries.slice(0, options.maxObjectKeys ?? DEFAULT_PREVIEW_MAX_OBJECT_KEYS)
      : entries;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of limitedEntries) {
      output[key] = serializeTraceValue(entry, options, {
        depth: state.depth + 1,
        activePath: state.activePath,
      });
    }
    if (options.limitCollections && entries.length > limitedEntries.length) {
      output.__truncatedKeys = entries.length - limitedEntries.length;
    }
    return output;
  } finally {
    state.activePath.delete(value);
  }
}

export function sanitizeTracePayloadForArtifact(value: unknown): unknown {
  return serializeTraceValue(
    value,
    {
      limitCollections: false,
      transformString: (entry) => summarizeBinaryStringForArtifact(entry) ?? entry,
    },
    {
      depth: 0,
      activePath: new WeakSet<object>(),
    },
  );
}

export function summarizeTraceTextForPreview(
  value: string,
  maxChars: number,
): unknown {
  return (
    summarizeBinaryStringForPreview(value) ??
    summarizeSpecialTextForPreview(value) ??
    truncateTraceText(inspectTraceText(value).cleaned, maxChars)
  );
}

export function sanitizeTraceTextForLogSnippet(
  value: string,
  maxChars = DEFAULT_PREVIEW_MAX_CHARS,
): string {
  const preview =
    summarizeBinaryStringForPreview(value) ??
    summarizeSpecialTextForPreview(value);
  if (preview) {
    return formatTraceTextSummaryForSnippet(preview);
  }
  return truncateTraceText(inspectTraceText(value).cleaned, maxChars);
}

export function summarizeTracePayloadForPreview(
  value: unknown,
  options: number | TracePreviewSerializationOptions = DEFAULT_PREVIEW_MAX_CHARS,
): unknown {
  const resolvedOptions =
    typeof options === "number" ? { maxChars: options } : options;
  return serializeTraceValue(
    value,
    {
      maxChars: resolvedOptions.maxChars ?? DEFAULT_PREVIEW_MAX_CHARS,
      maxDepth: resolvedOptions.maxDepth ?? DEFAULT_PREVIEW_MAX_DEPTH,
      maxArrayItems:
        resolvedOptions.maxArrayItems ?? DEFAULT_PREVIEW_MAX_ARRAY_ITEMS,
      maxObjectKeys:
        resolvedOptions.maxObjectKeys ?? DEFAULT_PREVIEW_MAX_OBJECT_KEYS,
      limitCollections: true,
      transformString: (entry, maxChars) =>
        summarizeTraceTextForPreview(entry, maxChars),
    },
    {
      depth: 0,
      activePath: new WeakSet<object>(),
    },
  );
}

export function formatTracePayloadForLog(
  payload: Record<string, unknown>,
  maxChars = DEFAULT_PREVIEW_MAX_CHARS,
): string {
  const summarized = summarizeTracePayloadForPreview(payload, maxChars);
  if (
    typeof summarized === "object" &&
    summarized !== null &&
    !Array.isArray(summarized)
  ) {
    return safeStringify(summarized);
  }
  return safeStringify({ value: summarized });
}
