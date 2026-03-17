import {
  buildMarkdownDisplayLines,
  buildStreamingMarkdownDisplayLines,
  createDisplayLine,
  createMarkdownStreamCollector,
} from "./agenc-watch-markdown-core.mjs";
import {
  buildInlineFileSegments,
  buildFileReferenceHref,
  buildStructuredFileReference,
  replaceStructuredFileReference,
} from "./agenc-watch-file-links.mjs";
import {
  buildTerminalHyperlinkSequence,
  supportsTerminalHyperlinks,
} from "./agenc-watch-terminal-sequences.mjs";

const DEFAULT_COLOR = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  ink: "\x1b[38;5;225m",
  softInk: "\x1b[38;5;189m",
  fog: "\x1b[38;5;97m",
  cyan: "\x1b[38;5;117m",
  teal: "\x1b[38;5;111m",
  green: "\x1b[38;5;50m",
  yellow: "\x1b[38;5;221m",
  magenta: "\x1b[38;5;177m",
  red: "\x1b[38;5;203m",
  border: "\x1b[38;5;54m",
  borderStrong: "\x1b[38;5;99m",
});

const SOURCE_TOKEN_RE =
  /("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:import|from|export|default|const|let|var|class|function|return|if|else|for|while|switch|case|break|continue|new|throw|try|catch|finally|await|async|true|false|null|undefined|print|fn)\b|\b\d+(?:\.\d+)?\b|\b[A-Z_]{2,}\b)/g;

function colorValue(color, key) {
  return color?.[key] ?? DEFAULT_COLOR[key] ?? "";
}

function effectiveColorDepth(explicitColorDepth) {
  if (Number.isFinite(Number(explicitColorDepth))) {
    return Number(explicitColorDepth);
  }
  if (typeof process?.stdout?.getColorDepth === "function") {
    try {
      return Number(process.stdout.getColorDepth());
    } catch {}
  }
  return 8;
}

function shouldUseSyntaxHighlighting(line, { colorDepth } = {}) {
  const normalizedColorDepth = effectiveColorDepth(colorDepth);
  const raw = String(line ?? "");
  return normalizedColorDepth >= 8 && raw.length <= 240;
}

function applyFileLinkCompaction(line, options = {}) {
  const entry =
    typeof line === "string"
      ? createDisplayLine(line, "plain")
      : line && typeof line === "object"
        ? line
        : createDisplayLine("", "blank");
  if (entry.mode === "blank") {
    return entry;
  }
  const compacted = buildInlineFileSegments(
    String(entry.plainText ?? entry.text ?? ""),
    options,
  );
  const compactedTaggedText = compacted.text;
  const compactedTaggedPlainText = compacted.plainText;
  if (
    compactedTaggedText === String(entry.text ?? "") &&
    compactedTaggedPlainText === String(entry.plainText ?? entry.text ?? "") &&
    (!Array.isArray(compacted.segments) || compacted.segments.every((segment) => segment.kind === "text"))
  ) {
    return entry;
  }
  return {
    ...entry,
    text: compactedTaggedText,
    plainText: compactedTaggedPlainText,
    inlineSegments: compacted.segments,
  };
}

function wrapHyperlink(text, href, enableHyperlinks) {
  if (!enableHyperlinks || !href) {
    return text;
  }
  return buildTerminalHyperlinkSequence(text, href);
}

function createTextSegment(text) {
  return {
    kind: "text",
    text: String(text ?? ""),
  };
}

function normalizeRenderableSegments(segments, fallbackText = "") {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [createTextSegment(fallbackText)];
  }
  return segments;
}

function appendSegmentText(segments, text, start) {
  const value = String(text ?? "");
  if (value.length === 0) {
    return start;
  }
  const last = segments.at(-1);
  if (last?.kind === "text" && Number(last.end) === start) {
    last.text += value;
    last.end = start + value.length;
    return last.end;
  }
  segments.push({
    kind: "text",
    text: value,
    start,
    end: start + value.length,
  });
  return start + value.length;
}

function styleInlineSegment(segment, color, baseTone, enableHyperlinks) {
  if (segment?.kind !== "file-reference") {
    return String(segment?.text ?? "");
  }
  const reset = color.reset ?? "";
  const bold = color.bold ?? "";
  const pathTone = color.cyan ?? "";
  const suffixTone = color.yellow ?? pathTone;
  const openingDecorationText = segment?.openingDecorationText ?? "";
  const closingDecorationText = segment?.closingDecorationText ?? "";
  if (segment?.mentionKind === "tag") {
    const tagTone = color.magenta ?? color.cyan ?? "";
    const styled = `${tagTone}${bold}@${reset}${baseTone}${openingDecorationText}${pathTone}${bold}${segment.pathText ?? ""}${reset}${baseTone}${suffixTone}${segment.suffixText ?? ""}${reset}${baseTone}${closingDecorationText}`;
    return wrapHyperlink(styled, segment.href, enableHyperlinks);
  }
  if (segment?.valid === false || !segment?.href) {
    return `${baseTone}${openingDecorationText}${pathTone}${bold}${segment?.pathText ?? ""}${reset}${baseTone}${suffixTone}${segment?.suffixText ?? ""}${reset}${baseTone}${closingDecorationText}`;
  }
  const styled = `${baseTone}${openingDecorationText}${pathTone}${bold}${segment?.pathText ?? ""}${reset}${baseTone}${suffixTone}${segment?.suffixText ?? ""}${reset}${baseTone}${closingDecorationText}`;
  return wrapHyperlink(styled, segment?.href, enableHyperlinks);
}

function renderInlineSegments(segments, fallbackText, color, baseTone, enableHyperlinks) {
  return normalizeRenderableSegments(segments, fallbackText)
    .map((segment) => styleInlineSegment(segment, color, baseTone, enableHyperlinks))
    .join("");
}

function renderStructuredFileLinkText(
  text,
  entry,
  {
    color,
    baseTone,
    enableHyperlinks,
    cwd = process.cwd(),
  } = {},
) {
  const structuredReference = buildStructuredFileReference(
    {
      filePath: entry?.filePath,
      fileRange: entry?.fileRange,
      displayText: entry?.fileLinkText,
    },
    {
      cwd,
      maxChars: Number.isFinite(Number(entry?.fileLinkMaxChars))
        ? Number(entry.fileLinkMaxChars)
        : 72,
    },
  );
  if (!structuredReference?.displayText) {
    return renderInlineSegments(entry.inlineSegments, text, color, baseTone, enableHyperlinks);
  }

  const reset = color.reset ?? "";
  const pathTone = color.cyan ?? "";
  const bold = color.bold ?? "";
  const href =
    structuredReference.href ??
    buildFileReferenceHref(structuredReference.rawReference, {
      cwd,
      fileRange: entry?.fileRange,
    });
  const styledReference = wrapHyperlink(
    `${pathTone}${bold}${structuredReference.displayText}${reset}${baseTone}`,
    href,
    enableHyperlinks,
  );
  return replaceStructuredFileReference(text, structuredReference, () => styledReference);
}

export function normalizeDisplayLineFileLinks(lines, options = {}) {
  return (Array.isArray(lines) ? lines : []).map((line) =>
    applyFileLinkCompaction(line, options)
  );
}

export function highlightSourceLine(line, color = DEFAULT_COLOR, options = {}) {
  const raw = String(line ?? "");
  if (raw.trim().length === 0) {
    return "";
  }
  if (!shouldUseSyntaxHighlighting(raw, options)) {
    return `${colorValue(color, "softInk")}${raw}${colorValue(color, "reset")}`;
  }
  if (/^\s*\/\//.test(raw)) {
    return `${colorValue(color, "fog")}${raw}${colorValue(color, "reset")}`;
  }
  if (/^\s*#/.test(raw)) {
    return `${colorValue(color, "magenta")}${colorValue(color, "bold")}${raw}${colorValue(color, "reset")}`;
  }
  const metaMatch = raw.match(
    /^(\s*(?:path|cwd|session|provider|model|state|status|agent|channels|tool(?: calls)?|usage|exit|step|probe|category|validation|class|duration|objective|acceptance|command|error|reason|note):)(\s*)(.*)$/i,
  );
  if (metaMatch) {
    const [, label, spacing, value] = metaMatch;
    const valueTone =
      /^(\/|\.\/|\.\.\/|[A-Za-z]:\\)/.test(value)
        ? colorValue(color, "cyan")
        : colorValue(color, "softInk");
    return `${colorValue(color, "teal")}${label}${colorValue(color, "reset")}${spacing}${valueTone}${value}${colorValue(color, "reset")}`;
  }

  let output = "";
  let cursor = 0;
  for (const match of raw.matchAll(SOURCE_TOKEN_RE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      output += raw.slice(cursor, index);
    }
    const tone =
      token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")
        ? colorValue(color, "green")
        : /^\d/.test(token)
          ? colorValue(color, "yellow")
          : /^[A-Z_]{2,}$/.test(token)
            ? colorValue(color, "cyan")
            : colorValue(color, "magenta");
    output += `${tone}${token}${colorValue(color, "reset")}`;
    cursor = index + token.length;
  }
  if (cursor < raw.length) {
    output += raw.slice(cursor);
  }
  return output.length > 0
    ? output
    : `${colorValue(color, "softInk")}${raw}${colorValue(color, "reset")}`;
}

function adjustSplitForInlineReference(references, candidate, lineStart) {
  if (!Array.isArray(references) || references.length === 0) {
    return candidate;
  }
  const absoluteCandidate = lineStart + candidate;
  for (const segment of references) {
    if (segment.kind !== "file-reference") {
      continue;
    }
    if (segment.start < absoluteCandidate && segment.end > absoluteCandidate) {
      if (segment.start > lineStart) {
        return segment.start - lineStart;
      }
      return candidate;
    }
  }
  return candidate;
}

function wrapPlainTextLine(text, width, continuationPrefix = "", inlineSegments = []) {
  const raw = String(text ?? "");
  if (raw.length === 0) {
    return [{ text: "", sourceStart: 0, sourceEnd: 0, prefixText: "" }];
  }
  const normalizedWidth = Math.max(8, Number(width) || 0);
  const chunks = [];
  let remaining = raw;
  let sourceStart = 0;
  let first = true;
  while (remaining.length > 0) {
    const prefix = first ? "" : continuationPrefix;
    const available = Math.max(8, normalizedWidth - prefix.length);
    if (remaining.length <= available) {
      chunks.push({
        text: `${prefix}${remaining}`,
        sourceStart,
        sourceEnd: raw.length,
        prefixText: prefix,
      });
      break;
    }
    let splitAt = available;
    const rawSlice = remaining.slice(0, available + 1);
    const spaceIndex = rawSlice.lastIndexOf(" ");
    if (spaceIndex > Math.floor(available * 0.45)) {
      splitAt = spaceIndex;
    }
    splitAt = adjustSplitForInlineReference(inlineSegments, splitAt, sourceStart);
    const visibleChunk = remaining.slice(0, splitAt);
    const trimmedChunk = visibleChunk.trimEnd();
    const trailingTrim = visibleChunk.length - trimmedChunk.length;
    chunks.push({
      text: `${prefix}${trimmedChunk}`,
      sourceStart,
      sourceEnd: sourceStart + splitAt - trailingTrim,
      prefixText: prefix,
    });
    const nextRemaining = remaining.slice(splitAt);
    const leadingTrim = nextRemaining.length - nextRemaining.trimStart().length;
    sourceStart += splitAt + leadingTrim;
    remaining = nextRemaining.trimStart();
    first = false;
  }
  return chunks;
}

function sliceInlineSegments(inlineSegments, sourceStart, sourceEnd, prefixText = "") {
  if (!Array.isArray(inlineSegments) || inlineSegments.length === 0) {
    return [];
  }
  const sliced = [];
  let cursor = appendSegmentText(sliced, prefixText, 0);
  for (const segment of inlineSegments) {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= sourceStart || start >= sourceEnd) {
      continue;
    }
    if (segment.kind === "text") {
      const segmentText = String(segment.text ?? "");
      const sliceStart = Math.max(sourceStart, start);
      const sliceEnd = Math.min(sourceEnd, end);
      const value = segmentText.slice(sliceStart - start, sliceEnd - start);
      cursor = appendSegmentText(sliced, value, cursor);
      continue;
    }
    if (start < sourceStart || end > sourceEnd) {
      continue;
    }
    sliced.push({
      ...segment,
      start: cursor,
      end: cursor + String(segment.displayText ?? segment.text ?? "").length,
    });
    cursor = Number(sliced.at(-1)?.end ?? cursor);
  }
  return sliced;
}

export function wrapRichDisplayLines(lines, width) {
  const wrapped = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const candidate =
      typeof line === "string"
        ? createDisplayLine(line, "plain")
        : line && typeof line === "object"
          ? line
          : createDisplayLine("", "blank");
    const entry =
      Array.isArray(candidate.inlineSegments) || candidate.mode === "file-link"
        ? candidate
        : normalizeDisplayLineFileLinks([candidate])[0] ?? candidate;
    const text = String(entry.text ?? "");
    const plainText = String(entry.plainText ?? text);
    if (entry.mode === "blank" || plainText.length === 0) {
      wrapped.push(createDisplayLine("", "blank"));
      continue;
    }
    const chunks = wrapPlainTextLine(
      plainText,
      width,
      String(entry.continuationPrefix ?? ""),
      entry.inlineSegments,
    );
    for (const chunk of chunks) {
      wrapped.push({
        ...entry,
        text: chunk.text,
        plainText: chunk.text,
        inlineSegments: sliceInlineSegments(
          entry.inlineSegments,
          chunk.sourceStart,
          chunk.sourceEnd,
          chunk.prefixText,
        ),
      });
    }
  }
  return wrapped;
}

export function renderDisplayLine(
  line,
  {
    color = DEFAULT_COLOR,
    colorDepth,
    enableHyperlinks = supportsTerminalHyperlinks(),
    cwd = process.cwd(),
  } = {},
) {
  const entry =
    typeof line === "string"
      ? createDisplayLine(line, "plain")
      : line && typeof line === "object"
        ? line
        : createDisplayLine("", "blank");
  const text = String(entry.text ?? "");
  if (entry.mode === "blank" || text.length === 0) {
    return "";
  }
  switch (entry.mode) {
    case "code":
      return highlightSourceLine(text, color, { colorDepth });
    case "code-meta":
      return `${colorValue(color, "borderStrong")}${colorValue(color, "bold")}${renderInlineSegments(entry.inlineSegments, text, color, `${colorValue(color, "borderStrong")}${colorValue(color, "bold")}`, enableHyperlinks)}${colorValue(color, "reset")}`;
    case "file-link":
      return `${colorValue(color, "cyan")}${colorValue(color, "bold")}${renderStructuredFileLinkText(text, entry, {
        color,
        baseTone: `${colorValue(color, "cyan")}${colorValue(color, "bold")}`,
        enableHyperlinks,
        cwd,
      })}${colorValue(color, "reset")}`;
    case "diff-header":
      return `${colorValue(color, "cyan")}${colorValue(color, "bold")}${renderStructuredFileLinkText(text, entry, {
        color,
        baseTone: `${colorValue(color, "cyan")}${colorValue(color, "bold")}`,
        enableHyperlinks,
        cwd,
      })}${colorValue(color, "reset")}`;
    case "diff-meta":
      return `${colorValue(color, "softInk")}${renderInlineSegments(entry.inlineSegments, text, color, colorValue(color, "softInk"), enableHyperlinks)}${colorValue(color, "reset")}`;
    case "diff-hunk":
      return `${colorValue(color, "magenta")}${colorValue(color, "bold")}${text}${colorValue(color, "reset")}`;
    case "diff-section-add":
      return `${colorValue(color, "green")}${colorValue(color, "bold")}${text}${colorValue(color, "reset")}`;
    case "diff-section-remove":
      return `${colorValue(color, "red")}${colorValue(color, "bold")}${text}${colorValue(color, "reset")}`;
    case "diff-add":
      return `${colorValue(color, "green")}${text}${colorValue(color, "reset")}`;
    case "diff-remove":
      return `${colorValue(color, "red")}${text}${colorValue(color, "reset")}`;
    case "diff-context":
      return `${colorValue(color, "softInk")}${renderInlineSegments(entry.inlineSegments, text, color, colorValue(color, "softInk"), enableHyperlinks)}${colorValue(color, "reset")}`;
    case "heading":
      return `${colorValue(color, "teal")}${colorValue(color, "bold")}${text}${colorValue(color, "reset")}`;
    case "quote":
      return `${colorValue(color, "magenta")}>${colorValue(color, "reset")} ${colorValue(color, "softInk")}${renderInlineSegments(entry.inlineSegments, text, color, colorValue(color, "softInk"), enableHyperlinks)}${colorValue(color, "reset")}`;
    case "list":
      return `${colorValue(color, "softInk")}${renderInlineSegments(entry.inlineSegments, text, color, colorValue(color, "softInk"), enableHyperlinks)}${colorValue(color, "reset")}`;
    case "rule":
      return `${colorValue(color, "borderStrong")}${text}${colorValue(color, "reset")}`;
    case "table-header":
      return `${colorValue(color, "teal")}${colorValue(color, "bold")}${text}${colorValue(color, "reset")}`;
    case "table-divider":
      return `${colorValue(color, "borderStrong")}${text}${colorValue(color, "reset")}`;
    case "table-row":
      return `${colorValue(color, "softInk")}${renderInlineSegments(entry.inlineSegments, text, color, colorValue(color, "softInk"), enableHyperlinks)}${colorValue(color, "reset")}`;
    case "stream-tail":
      return `${colorValue(color, "softInk")}${renderInlineSegments(entry.inlineSegments, text, color, colorValue(color, "softInk"), enableHyperlinks)}${colorValue(color, "reset")}`;
    case "paragraph":
      return `${colorValue(color, "ink")}${renderInlineSegments(entry.inlineSegments, text, color, colorValue(color, "ink"), enableHyperlinks)}${colorValue(color, "reset")}`;
    default:
      return `${colorValue(color, "fog")}${renderInlineSegments(entry.inlineSegments, text, color, colorValue(color, "fog"), enableHyperlinks)}${colorValue(color, "reset")}`;
  }
}

export {
  buildMarkdownDisplayLines,
  buildStreamingMarkdownDisplayLines,
  createMarkdownStreamCollector,
};
