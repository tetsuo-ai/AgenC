import { searchWorkspaceFileIndex } from "./agenc-watch-workspace-index.mjs";
import { matchModelNames } from "./agenc-watch-helpers.mjs";

const TOKEN_BOUNDARY_RE = /[\s([<{,;"']/;
const TOKEN_TERMINATOR_RE = /[\s)\]}>,;"']/;

function clampCursor(input, cursor) {
  const value = String(input ?? "");
  const normalizedCursor = Number.isFinite(Number(cursor)) ? Number(cursor) : value.length;
  return Math.max(0, Math.min(value.length, normalizedCursor));
}

function sliceActiveToken(input, cursor) {
  const value = String(input ?? "");
  const clampedCursor = clampCursor(value, cursor);
  let start = clampedCursor;
  while (start > 0 && !TOKEN_BOUNDARY_RE.test(value[start - 1])) {
    start -= 1;
  }
  let end = clampedCursor;
  while (end < value.length && !TOKEN_TERMINATOR_RE.test(value[end])) {
    end += 1;
  }
  return {
    value,
    cursor: clampedCursor,
    start,
    end,
    token: value.slice(start, end),
  };
}

function normalizeCompletionBoundary(value) {
  return typeof value === "string" && value.trimStart().startsWith("/");
}

function shouldAddTrailingSpace(value, end) {
  if (end >= value.length) {
    return true;
  }
  return /\s/.test(value[end]);
}

function applyTokenReplacement(input, { start, end }, replacement) {
  const value = String(input ?? "");
  let next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  let cursor = start + replacement.length;
  if (shouldAddTrailingSpace(value, end)) {
    next = `${next.slice(0, cursor)} ${next.slice(cursor)}`;
    cursor += 1;
  }
  return {
    input: next,
    cursor,
  };
}

function completeSlashToken(input, commandName) {
  const value = String(input ?? "");
  const trimmed = value.trimStart();
  const [commandToken = "/"] = trimmed.split(/\s+/, 1);
  const remainder = trimmed.slice(commandToken.length);
  const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
  const completed = `${leadingWhitespace}${commandName}${remainder}`;
  return {
    input: completed,
    cursor: completed.length,
  };
}

export function currentComposerInput(state) {
  return String(state?.composerInput ?? "");
}

export function isSlashComposerInput(input) {
  return normalizeCompletionBoundary(input);
}

export function resetComposerState(state) {
  state.composerInput = "";
  state.composerCursor = 0;
  state.composerHistoryIndex = -1;
  state.composerHistoryDraft = "";
}

export function setComposerInputValue(state, nextValue) {
  state.composerInput = String(nextValue ?? "");
  state.composerCursor = clampCursor(state.composerInput, state.composerCursor);
}

export function insertComposerText(state, text) {
  if (!text) {
    return;
  }
  const value = currentComposerInput(state);
  const cursor = clampCursor(value, state.composerCursor);
  state.composerInput =
    value.slice(0, cursor) +
    text +
    value.slice(cursor);
  state.composerCursor = cursor + text.length;
}

export function moveComposerCursorByWord(state, direction) {
  const input = currentComposerInput(state);
  const cursor = clampCursor(input, state.composerCursor);
  if (direction < 0) {
    let next = cursor;
    while (next > 0 && /\s/.test(input[next - 1])) {
      next -= 1;
    }
    while (next > 0 && !/\s/.test(input[next - 1])) {
      next -= 1;
    }
    state.composerCursor = next;
    return;
  }

  let next = cursor;
  while (next < input.length && !/\s/.test(input[next])) {
    next += 1;
  }
  while (next < input.length && /\s/.test(input[next])) {
    next += 1;
  }
  state.composerCursor = next;
}

export function deleteComposerToLineEnd(state) {
  const input = currentComposerInput(state);
  const cursor = clampCursor(input, state.composerCursor);
  if (cursor >= input.length) {
    return;
  }
  state.composerInput = input.slice(0, cursor);
  state.composerHistoryIndex = -1;
}

export function navigateComposerHistory(state, direction) {
  const history = Array.isArray(state?.composerHistory) ? state.composerHistory : [];
  if (history.length === 0) {
    return;
  }
  if (direction < 0) {
    if (state.composerHistoryIndex === -1) {
      state.composerHistoryDraft = currentComposerInput(state);
      state.composerHistoryIndex = history.length - 1;
    } else if (state.composerHistoryIndex > 0) {
      state.composerHistoryIndex -= 1;
    }
    setComposerInputValue(state, history[state.composerHistoryIndex] ?? "");
    state.composerCursor = currentComposerInput(state).length;
    return;
  }
  if (state.composerHistoryIndex === -1) {
    return;
  }
  if (state.composerHistoryIndex < history.length - 1) {
    state.composerHistoryIndex += 1;
    setComposerInputValue(state, history[state.composerHistoryIndex] ?? "");
  } else {
    state.composerHistoryIndex = -1;
    setComposerInputValue(state, state.composerHistoryDraft);
  }
  state.composerCursor = currentComposerInput(state).length;
}

export function recordComposerHistory(state, value, { maxEntries = 200 } = {}) {
  const normalized = String(value ?? "");
  if (!normalized) {
    return;
  }
  const history = Array.isArray(state?.composerHistory) ? state.composerHistory : [];
  if (history[history.length - 1] !== normalized) {
    history.push(normalized);
    if (history.length > maxEntries) {
      state.composerHistory = history.slice(-maxEntries);
    }
  }
  state.composerHistoryIndex = -1;
  state.composerHistoryDraft = "";
}

export function autocompleteSlashComposerInput(state, matchCommands) {
  const input = currentComposerInput(state);
  if (!isSlashComposerInput(input) || typeof matchCommands !== "function") {
    return false;
  }
  const trimmed = input.trimStart();
  const parts = trimmed.split(/\s+/);
  const commandToken = parts[0] ?? "/";

  // If the command is already `/model` and there's a space after it,
  // complete the model argument instead of the command name.
  if ((commandToken === "/model" || commandToken === "/models") && trimmed.length > commandToken.length) {
    const argStart = trimmed.indexOf(commandToken) + commandToken.length;
    const argText = trimmed.slice(argStart).trimStart();
    const matches = matchModelNames(argText, { limit: 1 });
    if (matches.length === 0) return false;
    const leadingWhitespace = input.match(/^\s*/)?.[0] ?? "";
    const completed = `${leadingWhitespace}${commandToken} ${matches[0]}`;
    state.composerInput = completed;
    state.composerCursor = completed.length;
    return true;
  }

  const matches = matchCommands(commandToken, { limit: 1 });
  if (!Array.isArray(matches) || matches.length === 0) {
    return false;
  }
  const completed = completeSlashToken(input, matches[0].name);
  state.composerInput = completed.input;
  state.composerCursor = completed.cursor;
  return true;
}

export function buildComposerRenderLine({ input, cursor, prompt, width, visibleLength }) {
  const value = String(input ?? "");
  const promptText = String(prompt ?? "");
  const promptWidth =
    typeof visibleLength === "function" ? visibleLength(promptText) : promptText.length;
  const lineWidth = Math.max(1, Number(width));
  const firstLineAvailable = Math.max(1, lineWidth - promptWidth);
  const clampedCursor = clampCursor(value, cursor);

  // Short input — single line (common fast path)
  if (value.length <= firstLineAvailable) {
    return {
      line: `${promptText}${value}`,
      lines: [`${promptText}${value}`],
      cursorColumn: Math.max(1, promptWidth + clampedCursor + 1),
      cursorRow: 0,
    };
  }

  // Wrap: first line gets the prompt, continuation lines use full width
  const maxWrappedLines = 4;
  const wrappedLines = [];
  wrappedLines.push(`${promptText}${value.slice(0, firstLineAvailable)}`);
  let offset = firstLineAvailable;
  while (offset < value.length && wrappedLines.length < maxWrappedLines) {
    wrappedLines.push(value.slice(offset, offset + lineWidth));
    offset += lineWidth;
  }

  // Find cursor position in the wrapped lines
  let cursorRow = 0;
  let cursorCol = promptWidth + clampedCursor + 1;
  if (clampedCursor >= firstLineAvailable) {
    const remaining = clampedCursor - firstLineAvailable;
    cursorRow = Math.min(wrappedLines.length - 1, 1 + Math.floor(remaining / lineWidth));
    cursorCol = (remaining % lineWidth) + 1;
  }

  return {
    line: wrappedLines[0],
    lines: wrappedLines,
    cursorColumn: Math.max(1, cursorCol),
    cursorRow,
  };
}

export function getActiveFileTagQuery({ input, cursor }) {
  const { token, start, end } = sliceActiveToken(input, cursor);
  if (!token.startsWith("@")) {
    return null;
  }
  return {
    start,
    end,
    token,
    query: token.slice(1),
  };
}

export function getComposerFileTagSuggestions(
  { input, cursor, fileIndex, limit = 8 } = {},
) {
  const activeTag = getActiveFileTagQuery({ input, cursor });
  if (!activeTag) {
    return [];
  }
  return searchWorkspaceFileIndex(fileIndex, activeTag.query, { limit });
}

export function autocompleteComposerFileTag(state, fileIndex, { limit = 8 } = {}) {
  const input = currentComposerInput(state);
  const activeTag = getActiveFileTagQuery({
    input,
    cursor: state?.composerCursor,
  });
  if (!activeTag) {
    return false;
  }
  const [match] = searchWorkspaceFileIndex(fileIndex, activeTag.query, { limit });
  if (!match) {
    return false;
  }
  const completed = applyTokenReplacement(
    input,
    activeTag,
    `@${match.path}`,
  );
  state.composerInput = completed.input;
  state.composerCursor = completed.cursor;
  state.composerHistoryIndex = -1;
  return true;
}
