/**
 * Event body/display-line formatting for the watch TUI transcript.
 *
 * Handles creating, normalizing, and wrapping display lines for events,
 * including source preview, markdown, and diff rendering modes.
 */

import {
  sanitizeDisplayText,
  sanitizeInlineText,
  sanitizeLargeText,
  stable,
  stripMarkdownDecorators,
  stripTerminalControlSequences,
  truncate,
} from "./agenc-watch-text-utils.mjs";
import {
  buildWatchRenderCacheSignature,
  getCachedEventDisplayLines,
  getCachedWrappedDisplayLines,
} from "./agenc-watch-render-cache.mjs";
import {
  buildDiffDisplayLines,
  isDiffRenderableEvent,
} from "./agenc-watch-diff-render.mjs";
import {
  buildMarkdownDisplayLines,
  buildStreamingMarkdownDisplayLines,
  renderDisplayLine,
  wrapRichDisplayLines,
} from "./agenc-watch-rich-text.mjs";
import { compactFileReference } from "./agenc-watch-file-links.mjs";

export function eventBodyLines(value, maxLines = Infinity) {
  const lines = sanitizeLargeText(String(value ?? "(empty)"))
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .map((line) => line.replace(/\r/g, "").replace(/\s+$/g, ""));
  const normalized = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim().length === 0) {
      blankRun += 1;
      if (blankRun > 1) {
        continue;
      }
      normalized.push("");
    } else {
      blankRun = 0;
      normalized.push(line);
    }
    if (normalized.length >= maxLines) {
      break;
    }
  }
  if (normalized.length === 0) {
    return ["(empty)"];
  }
  return normalized;
}

export function createDisplayLine(text, mode = "plain", metadata = {}) {
  return {
    text: String(text ?? ""),
    plainText: String(text ?? ""),
    mode,
    ...metadata,
  };
}

export function displayLineText(line) {
  if (typeof line === "string") {
    return line;
  }
  return String(line?.text ?? "");
}

export function displayLinePlainText(line) {
  if (typeof line === "string") {
    return line;
  }
  return String(line?.plainText ?? line?.text ?? "");
}

export function isMarkdownRenderableEvent(event) {
  return (
    event?.renderMode === "markdown" ||
    event?.kind === "agent" ||
    event?.kind === "subagent"
  );
}

export function normalizeDisplayLines(lines, maxLines = Infinity) {
  const normalized = [];
  let blankRun = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const entry =
      typeof line === "string" ? createDisplayLine(line) : line && typeof line === "object"
        ? line
        : createDisplayLine("", "blank");
    if (displayLineText(entry).trim().length === 0 || entry.mode === "blank") {
      blankRun += 1;
      if (blankRun > 1) {
        continue;
      }
      normalized.push(createDisplayLine("", "blank"));
    } else {
      blankRun = 0;
      normalized.push(entry);
    }
    if (normalized.length >= maxLines) {
      break;
    }
  }
  return normalized.length > 0 ? normalized : [createDisplayLine("(empty)", "plain")];
}

export function eventPreviewMode(event) {
  return sanitizeInlineText(String(event?.previewMode ?? "")).toLowerCase();
}

export function isSourcePreviewEvent(event) {
  const mode = eventPreviewMode(event);
  return (
    mode === "source" ||
    mode.startsWith("source-") ||
    /^Edit(?:ed)?\b|^Append(?:ed)?\b|^Read\b/i.test(String(event?.title ?? ""))
  );
}

export function isMutationPreviewEvent(event) {
  const mode = eventPreviewMode(event);
  if (mode === "source-write" || mode === "source-mutation") {
    return true;
  }
  if (mode === "source-read") {
    return false;
  }
  return /^Edit(?:ed)?\b|^Append(?:ed)?\b/i.test(String(event?.title ?? ""));
}

export function normalizeEventBody(body, maxStoredBodyChars) {
  const normalizedBody = stripTerminalControlSequences(
    (typeof body === "string" ? sanitizeLargeText(body) : stable(body)) || "(empty)",
  );
  return {
    body:
      normalizedBody.length > maxStoredBodyChars
        ? `${normalizedBody.slice(0, maxStoredBodyChars - 1)}\u2026`
        : normalizedBody,
    bodyTruncated: normalizedBody.length > maxStoredBodyChars,
  };
}

export function normalizeOptionalEventText(value, maxStoredBodyChars) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return normalizeEventBody(value, maxStoredBodyChars).body;
}

export function normalizeOptionalFileRange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const next = {};
  for (const key of ["afterLine", "startLine", "endLine", "startColumn", "endColumn"]) {
    const numeric = Number(value[key]);
    if (Number.isFinite(numeric)) {
      next[key] = numeric;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function renderMetadataPayload(metadata = {}) {
  return {
    previewMode: metadata.previewMode ?? null,
    filePath: metadata.filePath ?? null,
    fileRange: metadata.fileRange ?? null,
    mutationKind: metadata.mutationKind ?? null,
    mutationBeforeText: metadata.mutationBeforeText ?? null,
    mutationAfterText: metadata.mutationAfterText ?? null,
  };
}

export function buildRenderSignature(metadata = {}) {
  return stable(renderMetadataPayload(metadata));
}

export function applyDescriptorRenderingMetadata(target, descriptor = {}) {
  if (!target || typeof target !== "object") {
    return target;
  }
  const previewMode =
    typeof descriptor.previewMode === "string" && descriptor.previewMode.trim().length > 0
      ? descriptor.previewMode
      : undefined;
  const filePath =
    typeof descriptor.filePath === "string" && descriptor.filePath.trim().length > 0
      ? sanitizeInlineText(descriptor.filePath)
      : undefined;
  const fileRange = normalizeOptionalFileRange(descriptor.fileRange);
  const mutationKind =
    typeof descriptor.mutationKind === "string" && descriptor.mutationKind.trim().length > 0
      ? descriptor.mutationKind.trim().toLowerCase()
      : undefined;
  const mutationBeforeText = normalizeOptionalEventText(descriptor.mutationBeforeText, 96_000);
  const mutationAfterText = normalizeOptionalEventText(descriptor.mutationAfterText, 96_000);

  for (const [key, value] of Object.entries({
    previewMode,
    filePath,
    fileRange,
    mutationKind,
    mutationBeforeText,
    mutationAfterText,
  })) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }

  target.renderSignature = buildRenderSignature(target);
  return target;
}

export function descriptorEventMetadata(descriptor = {}, extra = {}) {
  return applyDescriptorRenderingMetadata({ ...extra }, descriptor);
}

export function sourceFileRangeLabel(fileRange) {
  if (!fileRange || typeof fileRange !== "object") {
    return null;
  }
  if (Number.isFinite(Number(fileRange.afterLine))) {
    return `after line ${Number(fileRange.afterLine)}`;
  }
  if (
    Number.isFinite(Number(fileRange.startLine)) &&
    Number.isFinite(Number(fileRange.endLine))
  ) {
    return `lines ${Number(fileRange.startLine)}-${Number(fileRange.endLine)}`;
  }
  if (Number.isFinite(Number(fileRange.startLine))) {
    return `line ${Number(fileRange.startLine)}`;
  }
  return null;
}

export function buildSourcePreviewDisplayLines(event, { cwd, maxChars = 72 } = {}) {
  const rawLines = eventBodyLines(event.body);
  const lines = [];
  const filePath =
    typeof event?.filePath === "string" && event.filePath.trim().length > 0
      ? event.filePath
      : null;
  const rangeLabel = sourceFileRangeLabel(event?.fileRange);

  let contentLines = rawLines;
  if (filePath && /^path:\s+/i.test(String(rawLines[0] ?? ""))) {
    contentLines = rawLines.slice(1);
    while (contentLines.length > 0 && contentLines[0].trim().length === 0) {
      contentLines = contentLines.slice(1);
    }
  }

  if (filePath) {
    const compactPath = compactFileReference(filePath, {
      cwd,
      maxChars,
    });
    lines.push(
      createDisplayLine(
        rangeLabel ? `${compactPath} \u00b7 ${rangeLabel}` : compactPath,
        "file-link",
        {
          filePath,
          fileRange: event?.fileRange,
          fileLinkText: compactPath,
        },
      ),
    );
    if (contentLines.length > 0) {
      lines.push(createDisplayLine("", "blank"));
    }
  }

  return lines.concat(contentLines.map((line) => createDisplayLine(line, "code")));
}

/**
 * Build display lines for an event, using cached results when possible.
 *
 * @param {object} event - Transcript event object.
 * @param {object} renderCache - The watch render cache instance.
 * @param {object} deps - Dependency bag: { cwd, maxInlineChars, maxPreviewSourceLines }.
 * @param {number} maxLines - Max lines to produce.
 */
export function buildEventDisplayLines(event, renderCache, deps, maxLines = Infinity) {
  const signature = buildWatchRenderCacheSignature(event);
  return getCachedEventDisplayLines(
    renderCache,
    event,
    signature,
    () => {
      if (isDiffRenderableEvent(event)) {
        const diffLines = buildDiffDisplayLines(event, {
          cwd: deps.cwd,
          maxPathChars: 72,
        });
        if (diffLines.length > 0) {
          return normalizeDisplayLines(diffLines);
        }
      }
      if (isSourcePreviewEvent(event)) {
        return normalizeDisplayLines(
          buildSourcePreviewDisplayLines(event, { cwd: deps.cwd }),
        );
      }
      if (isMarkdownRenderableEvent(event)) {
        return normalizeDisplayLines(
          (event?.streamState === "streaming"
            ? buildStreamingMarkdownDisplayLines
            : buildMarkdownDisplayLines)(
            stripTerminalControlSequences(sanitizeLargeText(event.body ?? "")),
          ),
        );
      }
      return normalizeDisplayLines(
        eventBodyLines(event.body).map((line) => createDisplayLine(line, "plain")),
      );
    },
    { maxLines },
  );
}

export function wrapDisplayLines(lines, width) {
  return wrapRichDisplayLines(lines, width);
}

export function wrapEventDisplayLines(event, renderCache, deps, width, maxLines = Infinity) {
  const signature = buildWatchRenderCacheSignature(event);
  return getCachedWrappedDisplayLines(
    renderCache,
    event,
    signature,
    width,
    maxLines,
    () => wrapDisplayLines(
      buildEventDisplayLines(event, renderCache, deps, maxLines),
      width,
    ),
  );
}

export function compactBodyLines(value, maxLines = 4, maxInlineChars = 220) {
  const lines = sanitizeDisplayText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[\[\]{}(),]+$/.test(line));
  if (lines.length === 0) {
    const fallback = sanitizeInlineText(stripMarkdownDecorators(value ?? ""));
    return fallback ? [fallback] : [];
  }
  return lines.slice(0, maxLines).map((line) => truncate(line, maxInlineChars));
}

export function renderEventBodyLine(event, line, { inline = false, color: colorPalette, cwd, enableHyperlinks, isSourcePreview }) {
  const lineText = displayLineText(line);
  if (!lineText || lineText.length === 0) {
    return "";
  }
  const guide = inline
    ? `${colorPalette.borderStrong}\u2502${colorPalette.reset} `
    : `${colorPalette.border}\u2502${colorPalette.reset} `;
  const prefix = `${inline ? "  " : ""}${guide}`;
  const entry =
    typeof line === "string"
      ? createDisplayLine(line, isSourcePreview ? "code" : "plain")
      : line;
  return `${prefix}${renderDisplayLine(entry, {
    color: colorPalette,
    cwd,
    enableHyperlinks,
  })}`;
}
