import path from "node:path";
import { pathToFileURL } from "node:url";

const FILE_REF_SOURCE = String.raw`(?:(?:\/|\.{1,2}\/|[A-Za-z]:\\)[^\s)\]}>,"'` + "`" + String.raw`]+|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)(?:#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?`;
const UNQUOTED_INLINE_FILE_RE = new RegExp(`^${FILE_REF_SOURCE}`);
const LOCATION_SUFFIX_PREFIX_RE = /^(#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)/;

const HASH_LOCATION_SUFFIX_RE = /^#L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?$/;
const COLON_LOCATION_SUFFIX_RE = /^:(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?$/;

function splitFileReference(rawReference) {
  const reference = String(rawReference ?? "").trim();
  if (!reference) {
    return null;
  }

  const hashMatch = reference.match(/^(.*?)(#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?)$/);
  if (hashMatch) {
    return {
      pathPart: hashMatch[1],
      suffix: hashMatch[2],
    };
  }

  const colonMatch = reference.match(/^(.*?)(:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)$/);
  if (colonMatch) {
    return {
      pathPart: colonMatch[1],
      suffix: colonMatch[2],
    };
  }

  return {
    pathPart: reference,
    suffix: "",
  };
}

function normalizeFilePath(pathPart) {
  const value = String(pathPart ?? "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("\\\\")) {
    return `//${value.slice(2).replace(/\\/g, "/").replace(/^\/+/, "")}`;
  }
  return value.replace(/\\/g, "/");
}

function compactSegments(normalizedPath, maxChars = 64) {
  if (normalizedPath.length <= maxChars) {
    return normalizedPath;
  }
  const isAbsolute = normalizedPath.startsWith("/");
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length <= 3) {
    return `${normalizedPath.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  }
  const leading = isAbsolute ? "/" : "";
  const head = segments[0];
  const tail = segments.slice(-2).join("/");
  const candidate = `${leading}${head}/…/${tail}`;
  if (candidate.length <= maxChars) {
    return candidate;
  }
  return `${leading}…/${tail}`.slice(0, maxChars - 1).trimEnd() + "…";
}

function resolveMaxChars(options = {}) {
  const primary = Number(options.maxChars);
  if (Number.isFinite(primary) && primary > 0) {
    return primary;
  }
  const fallback = Number(options.maxPathChars);
  if (Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }
  return 64;
}

function normalizeLocationSuffix(suffix) {
  const raw = String(suffix ?? "").trim();
  if (!raw) {
    return "";
  }

  const hashMatch = raw.match(HASH_LOCATION_SUFFIX_RE);
  if (hashMatch) {
    const [, startLine, startColumn, endLine, endColumn] = hashMatch;
    let normalized = `#L${startLine}`;
    if (startColumn) {
      normalized += `C${startColumn}`;
    }
    if (endLine) {
      normalized += `-L${endLine}`;
      if (endColumn) {
        normalized += `C${endColumn}`;
      }
    }
    return normalized;
  }

  const colonMatch = raw.match(COLON_LOCATION_SUFFIX_RE);
  if (colonMatch) {
    const [, startLine, startColumn, endLine, endColumn] = colonMatch;
    let normalized = `#L${startLine}`;
    if (startColumn) {
      normalized += `C${startColumn}`;
    }
    if (endLine) {
      normalized += `-L${endLine}`;
      if (endColumn) {
        normalized += `C${endColumn}`;
      }
    }
    return normalized;
  }

  return "";
}

function locationSuffixFromFileRange(fileRange) {
  if (!fileRange || typeof fileRange !== "object") {
    return "";
  }

  const afterLine = Number(fileRange.afterLine);
  if (Number.isFinite(afterLine)) {
    return `#L${afterLine}`;
  }

  const startLine = Number(fileRange.startLine);
  const startColumn = Number(fileRange.startColumn);
  const endLine = Number(fileRange.endLine);
  const endColumn = Number(fileRange.endColumn);

  if (!Number.isFinite(startLine)) {
    return "";
  }

  let normalized = `#L${startLine}`;
  if (Number.isFinite(startColumn)) {
    normalized += `C${startColumn}`;
  }
  if (Number.isFinite(endLine) && endLine >= startLine) {
    normalized += `-L${endLine}`;
    if (Number.isFinite(endColumn)) {
      normalized += `C${endColumn}`;
    }
  }
  return normalized;
}

function resolveDisplayPath(normalizedPath, cwd) {
  let displayPath = normalizedPath;
  if (
    cwd &&
    typeof cwd === "string" &&
    normalizedPath.startsWith("/") &&
    normalizeFilePath(cwd).length > 0
  ) {
    const relative = path.posix.relative(normalizeFilePath(cwd), normalizedPath);
    if (relative && !relative.startsWith("..")) {
      displayPath = relative;
    }
  }
  return displayPath;
}

function resolveAbsoluteLocalPath(normalizedPath, cwd) {
  if (!normalizedPath) {
    return null;
  }
  if (normalizedPath.startsWith("/")) {
    return path.resolve(normalizedPath);
  }
  if (/^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith("//")) {
    return null;
  }
  if (!cwd || typeof cwd !== "string" || cwd.trim().length === 0) {
    return null;
  }
  return path.resolve(cwd, normalizedPath);
}

function isInlineStartBoundary(character) {
  return character == null || /[\s([<{]/.test(character);
}

function isInlineEndBoundary(character) {
  return character == null || /[\s)\]}>,"'`.;!?]/.test(character);
}

function isPathLikeReference(reference) {
  const parts = splitFileReference(reference);
  if (!parts) {
    return false;
  }
  const normalizedPath = normalizeFilePath(parts.pathPart);
  if (!normalizedPath) {
    return false;
  }
  return (
    normalizedPath.startsWith("/") ||
    normalizedPath.startsWith("./") ||
    normalizedPath.startsWith("../") ||
    normalizedPath.startsWith("//") ||
    /^[A-Za-z]:\//.test(normalizedPath) ||
    normalizedPath.includes("/") ||
    /[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/.test(normalizedPath)
  );
}

function parseQuotedInlineReference(source, startIndex) {
  const quoteCharacter = source[startIndex];
  if (quoteCharacter !== "\"" && quoteCharacter !== "'") {
    return null;
  }

  let cursor = startIndex + 1;
  let closedAt = -1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quoteCharacter) {
      closedAt = cursor;
      break;
    }
    cursor += 1;
  }

  if (closedAt === -1) {
    return null;
  }

  const innerReference = source.slice(startIndex + 1, closedAt).trim();
  if (!innerReference) {
    return null;
  }

  let suffix = "";
  const suffixMatch = source.slice(closedAt + 1).match(LOCATION_SUFFIX_PREFIX_RE);
  if (suffixMatch) {
    suffix = suffixMatch[1];
  }

  const rawReference = `${innerReference}${suffix}`;
  if (!isPathLikeReference(rawReference)) {
    return null;
  }

  const endIndex = closedAt + 1 + suffix.length;
  if (!isInlineEndBoundary(source[endIndex])) {
    return null;
  }

  return {
    rawReference,
    quoteCharacter,
    endIndex,
  };
}

function parseUnquotedInlineReference(source, startIndex) {
  const match = source.slice(startIndex).match(UNQUOTED_INLINE_FILE_RE);
  if (!match) {
    return null;
  }

  const rawReference = match[0];
  if (!isPathLikeReference(rawReference)) {
    return null;
  }

  const endIndex = startIndex + rawReference.length;
  if (!isInlineEndBoundary(source[endIndex])) {
    return null;
  }

  return {
    rawReference,
    quoteCharacter: "",
    endIndex,
  };
}

function createInlineFileMatch(source, startIndex, options = {}) {
  if (!isInlineStartBoundary(source[startIndex - 1])) {
    return null;
  }

  const markerText = source[startIndex] === "@" ? "@" : "";
  const referenceStart = startIndex + markerText.length;
  const parsed =
    parseQuotedInlineReference(source, referenceStart) ??
    parseUnquotedInlineReference(source, referenceStart);
  if (!parsed) {
    return null;
  }

  const cwd = options.cwd ?? process.cwd();
  const maxChars = resolveMaxChars(options);
  const compactedReference = compactFileReference(parsed.rawReference, { cwd, maxChars });
  const compactedParts = splitFileReference(compactedReference);
  if (!compactedParts) {
    return null;
  }

  const rawParts = splitFileReference(parsed.rawReference);
  const normalizedPath = normalizeFilePath(rawParts?.pathPart ?? compactedParts.pathPart);
  const href =
    markerText === "@"
      ? buildFileTagHref(`${markerText}${parsed.rawReference}`, { cwd })
      : buildFileReferenceHref(parsed.rawReference, { cwd });
  const openingDecorationText = parsed.quoteCharacter || "";
  const closingDecorationText = parsed.quoteCharacter || "";
  const displayText = `${markerText}${openingDecorationText}${compactedReference}${closingDecorationText}`;
  return {
    start: startIndex,
    end: parsed.endIndex,
    markerText,
    mentionKind: markerText === "@" ? "tag" : "reference",
    rawReference: parsed.rawReference,
    rawText: source.slice(startIndex, parsed.endIndex),
    displayText,
    text: displayText,
    openingDecorationText,
    closingDecorationText,
    pathText: compactedParts.pathPart,
    suffixText: compactedParts.suffix,
    filePath: normalizedPath || null,
    href,
    valid: Boolean(href),
  };
}

function collectInlineFileMatches(text, options = {}) {
  const source = String(text ?? "");
  const matches = [];
  let index = 0;

  while (index < source.length) {
    const match = createInlineFileMatch(source, index, options);
    if (!match) {
      index += 1;
      continue;
    }
    matches.push(match);
    index = Math.max(match.end, index + 1);
  }

  return matches;
}

function replaceInlineFileMatches(text, options, predicate, replacer) {
  const source = String(text ?? "");
  const matches = collectInlineFileMatches(source, options).filter(predicate);
  if (matches.length === 0) {
    return source;
  }

  let output = "";
  let cursor = 0;
  for (const match of matches) {
    output += source.slice(cursor, match.start);
    output += replacer(match);
    cursor = match.end;
  }
  output += source.slice(cursor);
  return output;
}

export function buildStructuredFileReference(
  {
    filePath = "",
    fileRange = null,
    displayText = null,
  } = {},
  {
    cwd = process.cwd(),
    maxChars = 64,
  } = {},
) {
  const normalizedPath = normalizeFilePath(filePath);
  if (!normalizedPath) {
    return null;
  }
  const suffix = locationSuffixFromFileRange(fileRange);
  const rawReference = `${normalizedPath}${suffix}`;
  const computedDisplayText =
    typeof displayText === "string" && displayText.length > 0
      ? displayText
      : compactFileReference(rawReference, { cwd, maxChars });
  return {
    rawReference,
    pathPart: normalizedPath,
    suffix,
    displayText: computedDisplayText,
    href: buildFileReferenceHref(rawReference, { cwd, fileRange }),
    filePath: normalizedPath,
    fileRange,
  };
}

export function buildFileReferenceHref(reference, { cwd = process.cwd(), fileRange = null } = {}) {
  const parts = splitFileReference(reference);
  if (!parts) {
    return null;
  }

  const normalizedPath = normalizeFilePath(parts.pathPart);
  const suffix = normalizeLocationSuffix(parts.suffix || locationSuffixFromFileRange(fileRange));
  const absolutePath = resolveAbsoluteLocalPath(normalizedPath, cwd);
  if (!absolutePath) {
    return null;
  }

  const url = pathToFileURL(absolutePath);
  if (suffix.startsWith("#")) {
    url.hash = suffix.slice(1);
  }
  return url.toString();
}

export function replaceStructuredFileReference(text, structuredReference, replacer) {
  const source = String(text ?? "");
  const target = String(structuredReference?.displayText ?? "");
  if (!target || typeof replacer !== "function") {
    return source;
  }
  const index = source.indexOf(target);
  if (index === -1) {
    return source;
  }
  const replacement = replacer(structuredReference);
  return `${source.slice(0, index)}${replacement}${source.slice(index + target.length)}`;
}

export function compactFileReference(
  reference,
  { cwd = process.cwd(), maxChars = 64, maxPathChars } = {},
) {
  const parts = splitFileReference(reference);
  if (!parts) {
    return String(reference ?? "");
  }

  const normalizedPath = normalizeFilePath(parts.pathPart);
  const displayPath = resolveDisplayPath(normalizedPath, cwd);
  return `${compactSegments(displayPath, resolveMaxChars({ maxChars, maxPathChars }))}${parts.suffix}`;
}

export function compactFileReferencesInText(text, options = {}) {
  return replaceInlineFileMatches(
    text,
    options,
    (match) => match.mentionKind === "reference",
    (match) => match.displayText,
  );
}

export function compactFileTag(tag, options = {}) {
  const value = String(tag ?? "");
  if (!value.startsWith("@")) {
    return value;
  }
  return `@${compactFileReference(value.slice(1), options)}`;
}

function appendTextSegment(segments, text, start) {
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

export function buildInlineFileSegments(text, options = {}) {
  const source = String(text ?? "");
  let output = "";
  let cursor = 0;
  const segments = [];

  for (const match of collectInlineFileMatches(source, options)) {
    const leadingText = source.slice(cursor, match.start);
    output += leadingText;
    appendTextSegment(segments, leadingText, output.length - leadingText.length);
    const start = output.length;
    output += match.displayText;
    segments.push({
      kind: "file-reference",
      ...match,
      start,
      end: output.length,
    });
    cursor = match.end;
  }

  output += source.slice(cursor);
  appendTextSegment(segments, source.slice(cursor), output.length - source.slice(cursor).length);
  return {
    text: output,
    plainText: output,
    segments,
  };
}

export function compactFileTagsInText(text, options = {}) {
  return replaceInlineFileMatches(
    text,
    options,
    (match) => match.mentionKind === "tag",
    (match) => match.displayText,
  );
}

export function buildFileTagHref(tag, { cwd = process.cwd() } = {}) {
  const value = String(tag ?? "");
  if (!value.startsWith("@")) {
    return null;
  }
  return buildFileReferenceHref(value.slice(1), { cwd });
}

export function styleFileTagsInText(
  text,
  {
    color = {},
    baseTone = "",
  } = {},
) {
  const reset = color.reset ?? "";
  const tagTone = color.magenta ?? color.cyan ?? "";
  const pathTone = color.cyan ?? "";
  const suffixTone = color.yellow ?? pathTone;
  const bold = color.bold ?? "";

  return replaceInlineFileMatches(
    text,
    {},
    (match) => match.mentionKind === "tag",
    (match) =>
      `${tagTone}${bold}@${reset}${baseTone}${match.openingDecorationText ?? ""}${pathTone}${bold}${match.pathText ?? ""}${reset}${baseTone}${suffixTone}${match.suffixText ?? ""}${reset}${baseTone}${match.closingDecorationText ?? ""}`,
  );
}

export function styleFileReferencesInText(
  text,
  {
    color = {},
    baseTone = "",
  } = {},
) {
  const reset = color.reset ?? "";
  const pathTone = color.cyan ?? "";
  const suffixTone = color.yellow ?? pathTone;
  const bold = color.bold ?? "";

  return replaceInlineFileMatches(
    text,
    {},
    (match) => match.mentionKind === "reference",
    (match) =>
      `${baseTone}${match.openingDecorationText ?? ""}${pathTone}${bold}${match.pathText ?? ""}${reset}${baseTone}${suffixTone}${match.suffixText ?? ""}${reset}${baseTone}${match.closingDecorationText ?? ""}`,
  );
}
