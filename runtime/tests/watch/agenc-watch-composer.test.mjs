import test from "node:test";
import assert from "node:assert/strict";

import {
  autocompleteComposerFileTag,
  autocompleteSlashComposerInput,
  buildComposerRenderLine,
  getActiveFileTagQuery,
  getComposerFileTagSuggestions,
  insertComposerText,
  isSlashComposerInput,
  moveComposerCursorByWord,
  navigateComposerHistory,
  recordComposerHistory,
  resetComposerState,
  setComposerInputValue,
} from "../../src/watch/agenc-watch-composer.mjs";
import { createWorkspaceFileIndex } from "../../src/watch/agenc-watch-workspace-index.mjs";

function makeState(input = "", cursor = input.length) {
  return {
    composerInput: input,
    composerCursor: cursor,
    composerHistory: [],
    composerHistoryIndex: -1,
    composerHistoryDraft: "",
  };
}

test("getActiveFileTagQuery finds the current @file token at the cursor", () => {
  const query = getActiveFileTagQuery({
    input: "review @runtime/src/channels/webchat/types.ts next",
    cursor: "review @runtime/src/channels/webchat/types.ts".length,
  });

  assert.deepEqual(query, {
    start: 7,
    end: 45,
    token: "@runtime/src/channels/webchat/types.ts",
    query: "runtime/src/channels/webchat/types.ts",
  });
});

test("getComposerFileTagSuggestions ranks basename and path matches", () => {
  const index = createWorkspaceFileIndex([
    "runtime/src/channels/webchat/types.ts",
    "runtime/src/gateway/message.ts",
    "scripts/agenc-watch.mjs",
  ]);

  const suggestions = getComposerFileTagSuggestions({
    input: "@types",
    cursor: "@types".length,
    fileIndex: index,
    limit: 3,
  });

  assert.deepEqual(
    suggestions.map((entry) => entry.path),
    [
      "runtime/src/channels/webchat/types.ts",
    ],
  );
});

test("autocompleteComposerFileTag replaces the active token and appends spacing", () => {
  const state = makeState("open @oper", "open @oper".length);
  const index = createWorkspaceFileIndex([
    "runtime/src/channels/webchat/operator-events.ts",
  ]);

  const completed = autocompleteComposerFileTag(state, index, { limit: 4 });

  assert.equal(completed, true);
  assert.equal(state.composerInput, "open @runtime/src/channels/webchat/operator-events.ts ");
  assert.equal(
    state.composerCursor,
    state.composerInput.length,
  );
});

test("autocompleteSlashComposerInput completes the leading slash token only", () => {
  const state = makeState("/his 5", "/his".length);
  const completed = autocompleteSlashComposerInput(state, (input, { limit }) =>
    input === "/his" && limit === 1 ? [{ name: "/history" }] : []
  );

  assert.equal(completed, true);
  assert.equal(state.composerInput, "/history 5");
});

test("buildComposerRenderLine keeps the cursor inside the visible window", () => {
  const rendered = buildComposerRenderLine({
    input: "01234567890123456789",
    cursor: 19,
    prompt: "> ",
    width: 12,
    visibleLength: (value) => value.length,
  });

  assert.equal(rendered.line, "> 0123456789");
  assert.equal(rendered.cursorColumn, 10);
  assert.equal(rendered.cursorRow, 1);
});

test("recordComposerHistory and navigateComposerHistory preserve the draft input", () => {
  const state = makeState("draft");
  recordComposerHistory(state, "first");
  recordComposerHistory(state, "second");

  navigateComposerHistory(state, -1);
  assert.equal(state.composerInput, "second");

  navigateComposerHistory(state, -1);
  assert.equal(state.composerInput, "first");

  navigateComposerHistory(state, 1);
  assert.equal(state.composerInput, "second");

  navigateComposerHistory(state, 1);
  assert.equal(state.composerInput, "draft");
});

test("insertComposerText, setComposerInputValue, moveComposerCursorByWord, and resetComposerState mutate the composer state deterministically", () => {
  const state = makeState("hello world", 5);

  insertComposerText(state, ",");
  assert.equal(state.composerInput, "hello, world");

  moveComposerCursorByWord(state, -1);
  assert.equal(state.composerCursor, 0);

  setComposerInputValue(state, "reset me");
  assert.equal(state.composerInput, "reset me");
  assert.equal(state.composerCursor, 0);

  state.composerCursor = state.composerInput.length;
  moveComposerCursorByWord(state, -1);
  assert.equal(state.composerCursor, 6);

  assert.equal(isSlashComposerInput("/help"), true);
  assert.equal(isSlashComposerInput("hello"), false);

  resetComposerState(state);
  assert.equal(state.composerInput, "");
  assert.equal(state.composerCursor, 0);
});
