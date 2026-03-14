import {
  buildStructuredFileReference,
  compactFileReference,
} from "./agenc-watch-file-links.mjs";

function createDisplayLine(text, mode = "plain", metadata = {}) {
  return {
    text: String(text ?? ""),
    plainText: String(text ?? ""),
    mode,
    ...metadata,
  };
}

function splitTextLines(value) {
  const text = String(value ?? "").replace(/\r\n/g, "\n");
  if (text.length === 0) {
    return [""];
  }
  return text.split("\n");
}

function appendPrefixedLines(lines, entries, prefix, mode) {
  const normalized = Array.isArray(entries) && entries.length > 0 ? entries : [""];
  for (const [index, entry] of normalized.entries()) {
    lines.push(
      createDisplayLine(
        `${prefix}${entry}`,
        mode,
        {
          continuationPrefix: "  ",
          lineRole: index === 0 ? "leading" : "continuation",
        },
      ),
    );
  }
}

function pushDiffSectionLine(lines, text, mode, metadata = {}) {
  lines.push(
    createDisplayLine(text, mode, metadata),
  );
}

function formatRangeLabel(fileRange) {
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

function isSourceMutationPreview(event) {
  return event?.previewMode === "source-write" || event?.previewMode === "source-mutation";
}

function looksLikeUnifiedDiff(body) {
  const text = String(body ?? "");
  return (
    text.includes("@@") &&
    ((text.includes("\n--- ") && text.includes("\n+++ ")) ||
      text.startsWith("--- ") ||
      text.startsWith("diff --git "))
  );
}

function isToolLikeKind(kind) {
  return /\btool\b/i.test(String(kind ?? ""));
}

export function isDiffRenderableEvent(event) {
  return Boolean(
    event &&
    ((isSourceMutationPreview(event) &&
      typeof event.mutationKind === "string" &&
      event.mutationKind.trim().length > 0) ||
      (looksLikeUnifiedDiff(event?.body) &&
        (isSourceMutationPreview(event) || isToolLikeKind(event?.kind)))),
  );
}

function pushDiffHeader(lines, headline, filePath, { cwd, maxPathChars } = {}) {
  const fileReference = buildStructuredFileReference(
    {
      filePath,
    },
    { cwd, maxChars: maxPathChars },
  );
  const compactPath = fileReference?.displayText ?? "file";
  lines.push(
    createDisplayLine(
      `${headline} · ${compactPath}`,
      "diff-header",
      {
        filePath,
        fileLinkText: compactPath,
      },
    ),
  );
}

function buildMetadataDiffLines(event, { cwd, maxPathChars }) {
  const mutationKind = String(event?.mutationKind ?? "").trim().toLowerCase();
  const filePath = String(event?.filePath ?? "").trim();
  const fileRange = event?.fileRange ?? null;
  const beforeText = typeof event?.mutationBeforeText === "string" ? event.mutationBeforeText : "";
  const afterText = typeof event?.mutationAfterText === "string" ? event.mutationAfterText : "";

  const lines = [];
  let hunkIndex = 0;
  const rangeLabel = formatRangeLabel(fileRange);
  const headline =
    mutationKind === "append"
      ? "append"
      : mutationKind === "insert"
        ? "insert"
        : mutationKind === "replace"
          ? "replace"
          : mutationKind === "create"
            ? "create"
            : "write";

  pushDiffHeader(lines, headline, filePath, { cwd, maxPathChars });

  if (rangeLabel) {
    lines.push(
      createDisplayLine(rangeLabel, "diff-meta", {
        filePath,
        fileRange,
      }),
    );
  }

  switch (mutationKind) {
    case "create":
    case "write":
      lines.push(createDisplayLine(`@@ ${headline} @@`, "diff-hunk", { filePath, diffHunkIndex: hunkIndex++ }));
      pushDiffSectionLine(lines, "+++ after", "diff-section-add", { filePath });
      appendPrefixedLines(lines, splitTextLines(afterText), "+ ", "diff-add");
      break;
    case "append":
      lines.push(createDisplayLine("@@ append @@", "diff-hunk", { filePath, diffHunkIndex: hunkIndex++ }));
      pushDiffSectionLine(lines, "+++ after", "diff-section-add", { filePath });
      appendPrefixedLines(lines, splitTextLines(afterText), "+ ", "diff-add");
      break;
    case "insert":
      lines.push(createDisplayLine(`@@ ${rangeLabel ?? "insert"} @@`, "diff-hunk", { filePath, diffHunkIndex: hunkIndex++ }));
      pushDiffSectionLine(lines, "+++ after", "diff-section-add", { filePath });
      appendPrefixedLines(lines, splitTextLines(afterText), "+ ", "diff-add");
      break;
    case "replace":
      lines.push(createDisplayLine("@@ replace @@", "diff-hunk", { filePath, diffHunkIndex: hunkIndex++ }));
      pushDiffSectionLine(lines, "--- before", "diff-section-remove", { filePath });
      appendPrefixedLines(lines, splitTextLines(beforeText), "- ", "diff-remove");
      pushDiffSectionLine(lines, "+++ after", "diff-section-add", { filePath });
      appendPrefixedLines(lines, splitTextLines(afterText), "+ ", "diff-add");
      break;
    default:
      return [];
  }

  return lines;
}

function parsePatchPath(rawPath) {
  const text = String(rawPath ?? "").trim();
  if (!text) {
    return null;
  }
  if (text === "/dev/null") {
    return text;
  }
  if (text.startsWith("a/") || text.startsWith("b/")) {
    return text.slice(2);
  }
  return text;
}

function patchHeadline(oldPath, nextPath) {
  if (oldPath === "/dev/null" && nextPath && nextPath !== "/dev/null") {
    return "create";
  }
  if (nextPath === "/dev/null" && oldPath && oldPath !== "/dev/null") {
    return "delete";
  }
  if (oldPath && nextPath && oldPath !== nextPath) {
    return "rename";
  }
  return "patch";
}

function pushPatchFileHeader(lines, filePath, headline, { cwd, maxPathChars } = {}) {
  const compactPath = filePath
    ? compactFileReference(filePath, { cwd, maxChars: maxPathChars })
    : "file";
  lines.push(
    createDisplayLine(`${headline} · ${compactPath}`, "diff-header", {
      filePath,
      fileLinkText: compactPath,
    }),
  );
}

function buildUnifiedDiffDisplayLines(body, { cwd, maxPathChars }) {
  const source = String(body ?? "").replace(/\r\n/g, "\n");
  if (!looksLikeUnifiedDiff(source)) {
    return [];
  }

  const rows = source.split("\n");
  const lines = [];
  let currentFilePath = null;
  let currentOldPath = null;
  let currentNewPath = null;
  let sawHunk = false;
  let hunkIndex = 0;

  for (const row of rows) {
    if (row.startsWith("diff --git ")) {
      if (lines.length > 0) {
        lines.push(createDisplayLine("", "blank"));
      }
      currentOldPath = null;
      currentNewPath = null;
      currentFilePath = null;
      sawHunk = false;
      continue;
    }

    if (row.startsWith("--- ")) {
      currentOldPath = parsePatchPath(row.slice(4).trim());
      sawHunk = false;
      continue;
    }

    if (row.startsWith("+++ ")) {
      currentNewPath = parsePatchPath(row.slice(4).trim());
      currentFilePath =
        currentNewPath && currentNewPath !== "/dev/null"
          ? currentNewPath
          : currentOldPath && currentOldPath !== "/dev/null"
            ? currentOldPath
            : null;
      pushPatchFileHeader(
        lines,
        currentFilePath,
        patchHeadline(currentOldPath, currentNewPath),
        { cwd, maxPathChars },
      );
      sawHunk = false;
      continue;
    }

    if (row.startsWith("@@")) {
      if (!currentFilePath && (currentOldPath || currentNewPath)) {
        currentFilePath =
          currentNewPath && currentNewPath !== "/dev/null" ? currentNewPath : currentOldPath;
        pushPatchFileHeader(
          lines,
          currentFilePath,
          patchHeadline(currentOldPath, currentNewPath),
          { cwd, maxPathChars },
        );
      }
      lines.push(createDisplayLine(row, "diff-hunk", {
        filePath: currentFilePath,
        diffHunkIndex: hunkIndex++,
      }));
      sawHunk = true;
      continue;
    }

    if (!sawHunk) {
      continue;
    }

    if (row.startsWith("+") && !row.startsWith("+++")) {
      lines.push(createDisplayLine(row, "diff-add"));
      continue;
    }
    if (row.startsWith("-") && !row.startsWith("---")) {
      lines.push(createDisplayLine(row, "diff-remove"));
      continue;
    }
    if (row.startsWith(" ")) {
      lines.push(createDisplayLine(row, "diff-context"));
      continue;
    }
    if (row.startsWith("\\")) {
      lines.push(createDisplayLine(row, "diff-meta"));
    }
  }

  return lines.filter((line, index, allLines) => {
    if (line.mode !== "blank") {
      return true;
    }
    const previous = allLines[index - 1];
    const next = allLines[index + 1];
    return Boolean(previous && next);
  });
}

export function buildDiffDisplayLines(event, { cwd = process.cwd(), maxPathChars = 72 } = {}) {
  const metadataLines = buildMetadataDiffLines(event, { cwd, maxPathChars });
  if (metadataLines.length > 0) {
    return metadataLines;
  }
  return buildUnifiedDiffDisplayLines(event?.body, { cwd, maxPathChars });
}
