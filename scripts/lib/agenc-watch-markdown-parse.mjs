import markdownit from "markdown-it";

const MARKDOWN = markdownit({
  html: false,
  linkify: false,
  breaks: true,
  typographer: false,
});

export function createDisplayLine(text, mode = "plain", metadata = {}) {
  return {
    text: String(text ?? ""),
    plainText: String(text ?? ""),
    mode,
    ...metadata,
  };
}

export function stripTerminalControlSequences(value) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");
}

export function normalizeMarkdownSource(value) {
  return stripTerminalControlSequences(String(value ?? ""))
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ");
}

export function normalizeInlineMarkdown(value) {
  return String(value ?? "")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const normalizedAlt = normalizeInlineMarkdown(alt).trim();
      const normalizedUrl = String(url ?? "").trim();
      if (normalizedAlt && normalizedUrl) {
        return `image: ${normalizedAlt} (${normalizedUrl})`;
      }
      return normalizedAlt || normalizedUrl || "image";
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const normalizedLabel = normalizeInlineMarkdown(label).trim();
      const normalizedUrl = String(url ?? "").trim();
      if (!normalizedUrl) {
        return normalizedLabel;
      }
      if (!normalizedLabel || normalizedLabel === normalizedUrl) {
        return normalizedUrl;
      }
      return `${normalizedLabel} (${normalizedUrl})`;
    })
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1")
    .replace(/`([^`]*)`/g, "'$1'")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1");
}

function normalizeInlineWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateCell(value, maxWidth = 24) {
  const text = String(value ?? "");
  if (text.length <= maxWidth) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxWidth - 1)).trimEnd()}…`;
}

export function parseTableRow(rawLine) {
  if (typeof rawLine !== "string" || !rawLine.includes("|")) {
    return null;
  }
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => normalizeInlineMarkdown(cell).trim());
  return cells.length > 0 ? cells : null;
}

export function isTableSeparator(rawLine) {
  return /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(String(rawLine ?? ""));
}

export function buildTableDisplayLines(headers, rows) {
  const matrix = [headers, ...rows].map((row) =>
    row.map((cell) => truncateCell(cell)),
  );
  const columnCount = Math.max(...matrix.map((row) => row.length), 0);
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(3, ...matrix.map((row) => String(row[index] ?? "").length)),
  );
  const renderRow = (row) =>
    row
      .map((cell, index) => String(cell ?? "").padEnd(widths[index], " "))
      .join(" │ ");
  const divider = widths.map((width) => "─".repeat(width)).join("─┼─");
  return [
    createDisplayLine(renderRow(headers), "table-header"),
    createDisplayLine(divider, "table-divider"),
    ...rows.map((row) => createDisplayLine(renderRow(row), "table-row")),
  ];
}

export function normalizeDisplayLineCollection(lines) {
  const normalized = [];
  let blankRun = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const entry =
      typeof line === "string"
        ? createDisplayLine(line, "plain")
        : line && typeof line === "object"
          ? line
          : createDisplayLine("", "blank");
    if (entry.mode === "blank" || String(entry.text ?? "").trim().length === 0) {
      blankRun += 1;
      if (blankRun > 1) {
        continue;
      }
      normalized.push(createDisplayLine("", "blank"));
      continue;
    }
    blankRun = 0;
    normalized.push(entry);
  }
  return normalized.length > 0 ? normalized : [createDisplayLine("(empty)", "paragraph")];
}

function attributeValue(token, name) {
  if (token && typeof token.attrGet === "function") {
    return token.attrGet(name);
  }
  if (!Array.isArray(token?.attrs)) {
    return null;
  }
  const pair = token.attrs.find((entry) => entry?.[0] === name);
  return pair?.[1] ?? null;
}

function formatLinkDisplay(label, destination) {
  const normalizedLabel = normalizeInlineWhitespace(label);
  const normalizedDestination = String(destination ?? "").trim();
  if (!normalizedDestination) {
    return normalizedLabel;
  }
  if (!normalizedLabel || normalizedLabel === normalizedDestination) {
    return normalizedDestination;
  }
  return `${normalizedLabel} (${normalizedDestination})`;
}

function formatImageDisplay(altText, destination) {
  const normalizedAlt = normalizeInlineWhitespace(altText);
  const normalizedDestination = String(destination ?? "").trim();
  if (normalizedAlt && normalizedDestination) {
    return `image: ${normalizedAlt} (${normalizedDestination})`;
  }
  return normalizedAlt || normalizedDestination || "image";
}

function renderInlineTokens(tokens = [], stopTypes = new Set(), startIndex = 0) {
  let output = "";
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (stopTypes.has(token?.type)) {
      return {
        text: output,
        nextIndex: index + 1,
      };
    }
    switch (token?.type) {
      case "text":
        output += normalizeInlineMarkdown(token.content);
        index += 1;
        break;
      case "softbreak":
      case "hardbreak":
        output += "\n";
        index += 1;
        break;
      case "code_inline":
        output += `'${token.content ?? ""}'`;
        index += 1;
        break;
      case "image": {
        const alt = renderInlineTokens(token.children ?? []).text;
        output += formatImageDisplay(alt, attributeValue(token, "src"));
        index += 1;
        break;
      }
      case "link_open": {
        const link = renderInlineTokens(tokens, new Set(["link_close"]), index + 1);
        output += formatLinkDisplay(link.text, attributeValue(token, "href"));
        index = link.nextIndex;
        break;
      }
      case "em_open": {
        const emphasis = renderInlineTokens(tokens, new Set(["em_close"]), index + 1);
        output += emphasis.text;
        index = emphasis.nextIndex;
        break;
      }
      case "strong_open": {
        const strong = renderInlineTokens(tokens, new Set(["strong_close"]), index + 1);
        output += strong.text;
        index = strong.nextIndex;
        break;
      }
      case "s_open": {
        const strike = renderInlineTokens(tokens, new Set(["s_close"]), index + 1);
        output += strike.text;
        index = strike.nextIndex;
        break;
      }
      case "html_inline":
        output += normalizeInlineMarkdown(token.content);
        index += 1;
        break;
      default:
        if (Array.isArray(token?.children) && token.children.length > 0) {
          output += renderInlineTokens(token.children).text;
        } else if (typeof token?.content === "string" && token.content.length > 0) {
          output += normalizeInlineMarkdown(token.content);
        }
        index += 1;
        break;
    }
  }
  return {
    text: output,
    nextIndex: index,
  };
}

function maybeInsertGapLine(lines, lastSourceEnd, map) {
  if (
    !Array.isArray(map) ||
    map.length < 2 ||
    !Number.isFinite(lastSourceEnd) ||
    map[0] <= lastSourceEnd
  ) {
    return;
  }
  const lastLine = lines.at(-1);
  if (lastLine?.mode !== "blank") {
    lines.push(createDisplayLine("", "blank"));
  }
}

function nextSourceEnd(map, fallback) {
  return Array.isArray(map) && map.length >= 2 ? map[1] : fallback;
}

function createRenderContext() {
  return {
    blockquoteDepth: 0,
    listStack: [],
    listItemStack: [],
  };
}

function openList(context, token, type) {
  const start = Number.parseInt(attributeValue(token, "start") ?? "1", 10);
  context.listStack.push({
    type,
    nextIndex: Number.isFinite(start) ? start : 1,
  });
}

function openListItem(context) {
  const activeList = context.listStack.at(-1) ?? { type: "bullet", nextIndex: 1 };
  const marker =
    activeList.type === "ordered"
      ? `${activeList.nextIndex}. `
      : "• ";
  if (activeList.type === "ordered") {
    activeList.nextIndex += 1;
  }
  context.listItemStack.push({
    indent: " ".repeat(
      Math.max(0, (context.listStack.length - 1) * 2 + context.blockquoteDepth * 2),
    ),
    marker,
    paragraphCount: 0,
  });
}

function appendStructuredTextLine(lines, text, defaultMode, map, context, lastSourceEnd) {
  // Split on embedded newlines (from softbreak/hardbreak tokens) so each
  // line renders independently instead of being collapsed into one paragraph.
  const segments = String(text ?? "").split("\n").map((s) => normalizeInlineWhitespace(s)).filter(Boolean);
  if (segments.length === 0) {
    return nextSourceEnd(map, lastSourceEnd);
  }
  maybeInsertGapLine(lines, lastSourceEnd, map);
  const activeListItem = context.listItemStack.at(-1);
  if (activeListItem) {
    const continuationPrefix = `${activeListItem.indent}${" ".repeat(activeListItem.marker.length)}`;
    for (const [segIndex, segment] of segments.entries()) {
      const prefix =
        activeListItem.paragraphCount === 0 && segIndex === 0
          ? `${activeListItem.indent}${activeListItem.marker}`
          : continuationPrefix;
      lines.push(
        createDisplayLine(`${prefix}${segment}`, "list", {
          continuationPrefix,
        }),
      );
    }
    activeListItem.paragraphCount += 1;
    return nextSourceEnd(map, lastSourceEnd);
  }
  if (context.blockquoteDepth > 0) {
    const quoteLead =
      context.blockquoteDepth > 1
        ? `${"> ".repeat(context.blockquoteDepth - 1)}`
        : "";
    for (const segment of segments) {
      lines.push(
        createDisplayLine(`${quoteLead}${segment}`, "quote", {
          continuationPrefix: `${"  ".repeat(Math.max(1, context.blockquoteDepth))}`,
        }),
      );
    }
    return nextSourceEnd(map, lastSourceEnd);
  }
  for (const segment of segments) {
    lines.push(createDisplayLine(segment, defaultMode));
  }
  return nextSourceEnd(map, lastSourceEnd);
}

function appendCodeFenceLines(lines, token, lastSourceEnd) {
  maybeInsertGapLine(lines, lastSourceEnd, token.map);
  const language =
    String(token.info ?? "")
      .trim()
      .split(/\s+/)[0] || "text";
  lines.push(
    createDisplayLine(`code · ${language}`, "code-meta", {
      language,
    }),
  );
  const content = String(token.content ?? "").replace(/\r\n/g, "\n");
  const contentLines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
  for (const line of contentLines) {
    lines.push(
      createDisplayLine(line, "code", {
        language,
      }),
    );
  }
  return nextSourceEnd(token.map, lastSourceEnd);
}

function consumeTable(tokens, startIndex) {
  let headers = [];
  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let inHeader = false;
  let index = startIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    switch (token?.type) {
      case "thead_open":
        inHeader = true;
        break;
      case "thead_close":
        inHeader = false;
        break;
      case "inline":
        currentCell = normalizeInlineWhitespace(
          renderInlineTokens(token.children ?? []).text,
        );
        break;
      case "th_close":
      case "td_close":
        currentRow.push(currentCell);
        currentCell = "";
        break;
      case "tr_close":
        if (currentRow.length > 0) {
          if (headers.length === 0 && (inHeader || rows.length === 0)) {
            headers = currentRow;
          } else {
            rows.push(currentRow);
          }
        }
        currentRow = [];
        break;
      case "table_close":
        return {
          nextIndex: index + 1,
          lines: headers.length > 0
            ? buildTableDisplayLines(headers, rows)
            : [createDisplayLine("(empty)", "paragraph")],
        };
      default:
        break;
    }
    index += 1;
  }
  return {
    nextIndex: index,
    lines: headers.length > 0
      ? buildTableDisplayLines(headers, rows)
      : [createDisplayLine("(empty)", "paragraph")],
  };
}

export function buildMarkdownDisplayLines(value) {
  const source = normalizeMarkdownSource(value);
  if (source.trim().length === 0) {
    return [createDisplayLine("(empty)", "paragraph")];
  }

  const tokens = MARKDOWN.parse(source, {});
  const lines = [];
  const context = createRenderContext();
  let index = 0;
  let lastSourceEnd = null;

  while (index < tokens.length) {
    const token = tokens[index];
    switch (token?.type) {
      case "heading_open": {
        const inlineToken = tokens[index + 1];
        const level = Number.parseInt(String(token.tag ?? "h1").slice(1), 10) || 1;
        maybeInsertGapLine(lines, lastSourceEnd, token.map);
        lines.push(
          createDisplayLine(
            normalizeInlineWhitespace(
              renderInlineTokens(inlineToken?.children ?? []).text,
            ),
            "heading",
            { level },
          ),
        );
        lastSourceEnd = nextSourceEnd(token.map, lastSourceEnd);
        index += 3;
        break;
      }
      case "paragraph_open": {
        const inlineToken = tokens[index + 1];
        lastSourceEnd = appendStructuredTextLine(
          lines,
          renderInlineTokens(inlineToken?.children ?? []).text,
          "paragraph",
          token.map,
          context,
          lastSourceEnd,
        );
        index += 3;
        break;
      }
      case "blockquote_open":
        context.blockquoteDepth += 1;
        index += 1;
        break;
      case "blockquote_close":
        context.blockquoteDepth = Math.max(0, context.blockquoteDepth - 1);
        index += 1;
        break;
      case "bullet_list_open":
        openList(context, token, "bullet");
        index += 1;
        break;
      case "ordered_list_open":
        openList(context, token, "ordered");
        index += 1;
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        context.listStack.pop();
        index += 1;
        break;
      case "list_item_open":
        openListItem(context);
        index += 1;
        break;
      case "list_item_close":
        context.listItemStack.pop();
        index += 1;
        break;
      case "fence":
      case "code_block":
        lastSourceEnd = appendCodeFenceLines(lines, token, lastSourceEnd);
        index += 1;
        break;
      case "hr":
        maybeInsertGapLine(lines, lastSourceEnd, token.map);
        lines.push(createDisplayLine("────────", "rule"));
        lastSourceEnd = nextSourceEnd(token.map, lastSourceEnd);
        index += 1;
        break;
      case "table_open": {
        maybeInsertGapLine(lines, lastSourceEnd, token.map);
        const table = consumeTable(tokens, index);
        lines.push(...table.lines);
        lastSourceEnd = nextSourceEnd(token.map, lastSourceEnd);
        index = table.nextIndex;
        break;
      }
      case "html_block": {
        maybeInsertGapLine(lines, lastSourceEnd, token.map);
        for (const rawLine of normalizeMarkdownSource(token.content).split("\n")) {
          const normalizedLine = normalizeInlineWhitespace(rawLine);
          if (!normalizedLine) {
            lines.push(createDisplayLine("", "blank"));
            continue;
          }
          lines.push(createDisplayLine(normalizedLine, "paragraph"));
        }
        lastSourceEnd = nextSourceEnd(token.map, lastSourceEnd);
        index += 1;
        break;
      }
      default:
        index += 1;
        break;
    }
  }

  return normalizeDisplayLineCollection(lines);
}
