import {
  buildTableDisplayLines,
  buildMarkdownDisplayLines,
  createDisplayLine,
  isTableSeparator,
  normalizeDisplayLineCollection,
  normalizeInlineMarkdown,
  normalizeMarkdownSource,
  parseTableRow,
  stripTerminalControlSequences,
} from "./agenc-watch-markdown-parse.mjs";

function looksLikeTableLine(rawLine) {
  return /^\s*\|/.test(String(rawLine ?? ""));
}

function findTrailingTableCandidateStart(rawLines) {
  let index = rawLines.length - 1;
  while (index >= 0 && String(rawLines[index] ?? "").trim().length === 0) {
    index -= 1;
  }
  const endIndex = index;
  while (index >= 0 && looksLikeTableLine(rawLines[index])) {
    index -= 1;
  }
  return index === endIndex ? -1 : index + 1;
}

function hasPotentiallyIncompleteInlineMarkdown(rawLine) {
  const text = String(rawLine ?? "");
  const backtickCount = (text.match(/`/g) ?? []).length;
  return (
    backtickCount % 2 === 1 ||
    /\[[^\]]*$/.test(text) ||
    /\[[^\]]+\]\([^)]*$/.test(text)
  );
}

function normalizeStreamingTailText(rawLine) {
  let text = String(rawLine ?? "");
  if (!text.trim()) {
    return "";
  }
  if (looksLikeTableLine(text)) {
    const indent = text.match(/^\s*/)?.[0] ?? "";
    let trimmed = text.trim();
    if (trimmed.startsWith("|")) {
      trimmed = trimmed.slice(1);
    }
    if (trimmed.endsWith("|")) {
      trimmed = trimmed.slice(0, -1);
    }
    return `${indent}${trimmed
      .split("|")
      .map((cell) => normalizeInlineMarkdown(cell).trim())
      .join(" │ ")}`.trimEnd();
  }
  text = text.replace(/\[([^\]]+)\]\(([^)]*)$/, (_, label, url) => {
    const normalizedLabel = normalizeInlineMarkdown(label).trim();
    return normalizedLabel ? `${normalizedLabel} (${url}` : String(url ?? "");
  });
  text = text.replace(/\[([^\]]*)$/, (_, label) => normalizeInlineMarkdown(label));
  if ((text.match(/`/g) ?? []).length % 2 === 1) {
    text = text.replace(/`/g, "'");
  }
  return normalizeInlineMarkdown(text).trimEnd();
}

function lineSignature(line) {
  return JSON.stringify({
    mode: String(line?.mode ?? ""),
    text: String(line?.text ?? ""),
    plainText: String(line?.plainText ?? line?.text ?? ""),
    continuationPrefix: String(line?.continuationPrefix ?? ""),
    language: String(line?.language ?? ""),
  });
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && lineSignature(left[index]) === lineSignature(right[index])) {
    index += 1;
  }
  return index;
}

function buildStreamingMarkdownState(value) {
  const source = normalizeMarkdownSource(value);
  if (source.trim().length === 0) {
    return {
      completeLines: [createDisplayLine("(empty)", "paragraph")],
      previewLines: [],
    };
  }

  const rawLines = source.split("\n");
  const trailingTableStart = findTrailingTableCandidateStart(rawLines);

  if (trailingTableStart !== -1) {
    let trailingTableEnd = rawLines.length - 1;
    while (
      trailingTableEnd >= trailingTableStart &&
      String(rawLines[trailingTableEnd] ?? "").trim().length === 0
    ) {
      trailingTableEnd -= 1;
    }

    const headerCells = parseTableRow(rawLines[trailingTableStart]);
    const separatorComplete = isTableSeparator(rawLines[trailingTableStart + 1] ?? "");
    const stableSource = rawLines.slice(0, trailingTableStart).join("\n");
    const stableLines = stableSource ? buildMarkdownDisplayLines(stableSource) : [];

    if (!headerCells || !separatorComplete) {
      const previewLines = rawLines
        .slice(trailingTableStart, trailingTableEnd + 1)
        .map((line) => normalizeStreamingTailText(line))
        .filter(Boolean)
        .map((line) => createDisplayLine(line, "stream-tail"));
      return {
        completeLines: stableLines,
        previewLines,
      };
    }

    const completedRows = [];
    const previewLines = [];
    const tableBodyLines = rawLines.slice(trailingTableStart + 2, trailingTableEnd + 1);
    for (let index = 0; index < tableBodyLines.length; index += 1) {
      const line = tableBodyLines[index];
      const parsedRow = parseTableRow(line);
      const isLastBodyLine = index === tableBodyLines.length - 1;
      if (parsedRow && (!isLastBodyLine || source.endsWith("\n"))) {
        completedRows.push(parsedRow);
      } else if (String(line ?? "").trim()) {
        previewLines.push(
          createDisplayLine(normalizeStreamingTailText(line), "stream-tail"),
        );
      }
    }

    return {
      completeLines: normalizeDisplayLineCollection([
        ...stableLines,
        ...buildTableDisplayLines(headerCells, completedRows),
      ]),
      previewLines: previewLines.filter((line) => String(line.text ?? "").trim().length > 0),
    };
  }

  if (source.endsWith("\n")) {
    return {
      completeLines: buildMarkdownDisplayLines(source),
      previewLines: [],
    };
  }

  const lastLine = rawLines.at(-1) ?? "";
  if (hasPotentiallyIncompleteInlineMarkdown(lastLine)) {
    const stableSource = rawLines.slice(0, -1).join("\n");
    const tail = normalizeStreamingTailText(lastLine);
    return {
      completeLines: stableSource ? buildMarkdownDisplayLines(stableSource) : [],
      previewLines: tail ? [createDisplayLine(tail, "stream-tail")] : [],
    };
  }

  const lastNewlineIndex = source.lastIndexOf("\n");
  if (lastNewlineIndex === -1) {
    return {
      completeLines: [],
      previewLines: buildMarkdownDisplayLines(source),
    };
  }

  const stableSource = source.slice(0, lastNewlineIndex + 1);
  const stableLines = buildMarkdownDisplayLines(stableSource);
  const fullLines = buildMarkdownDisplayLines(source);
  const prefixLength = commonPrefixLength(stableLines, fullLines);

  return {
    completeLines: fullLines.slice(0, prefixLength),
    previewLines: fullLines.slice(prefixLength),
  };
}

export function createMarkdownStreamCollector() {
  let buffer = "";
  let committedLines = [];

  function clear() {
    buffer = "";
    committedLines = [];
  }

  function pushDelta(delta) {
    buffer += stripTerminalControlSequences(String(delta ?? ""));
  }

  function syncToValue(value) {
    const next = stripTerminalControlSequences(String(value ?? ""));
    if (next === buffer) {
      return;
    }
    if (!next.startsWith(buffer)) {
      clear();
      buffer = next;
      return;
    }
    buffer += next.slice(buffer.length);
  }

  function commitCompleteLines() {
    const { completeLines } = buildStreamingMarkdownState(buffer);
    const prefixLength = commonPrefixLength(committedLines, completeLines);
    const nextLines =
      prefixLength < committedLines.length
        ? completeLines
        : completeLines.slice(committedLines.length);
    committedLines = completeLines;
    return nextLines;
  }

  function previewPendingLines() {
    const { previewLines } = buildStreamingMarkdownState(buffer);
    return previewLines;
  }

  function snapshot() {
    const state = buildStreamingMarkdownState(buffer);
    committedLines = state.completeLines;
    return normalizeDisplayLineCollection([
      ...state.completeLines,
      ...state.previewLines,
    ]);
  }

  function finalizeAndDrain() {
    const rendered = buildMarkdownDisplayLines(buffer);
    const prefixLength = commonPrefixLength(committedLines, rendered);
    const lines = rendered.slice(prefixLength);
    clear();
    return lines;
  }

  return {
    clear,
    pushDelta,
    syncToValue,
    commitCompleteLines,
    previewPendingLines,
    snapshot,
    finalizeAndDrain,
  };
}

export function buildStreamingMarkdownDisplayLines(value) {
  const state = buildStreamingMarkdownState(value);
  return normalizeDisplayLineCollection([
    ...state.completeLines,
    ...state.previewLines,
  ]);
}
