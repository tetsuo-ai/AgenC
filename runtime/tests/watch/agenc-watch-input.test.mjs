import test from "node:test";
import assert from "node:assert/strict";

import { createWatchInputController } from "../../src/watch/agenc-watch-input.mjs";

function createInputHarness(overrides = {}) {
  const watchState = {
    composerInput: "",
    composerCursor: 0,
    composerHistoryIndex: -1,
    expandedEventId: null,
    detailScrollOffset: 0,
    introDismissed: false,
  };
  const calls = [];
  const controller = createWatchInputController({
    watchState,
    shuttingDown: overrides.shuttingDown ?? (() => false),
    parseMouseWheelSequence: overrides.parseMouseWheelSequence ?? (() => null),
    scrollCurrentViewBy(delta) {
      calls.push({ type: "scroll", delta });
    },
    shutdownWatch(code) {
      calls.push({ type: "shutdown", code });
    },
    toggleExpandedEvent() {
      calls.push({ type: "toggleExpandedEvent" });
    },
    currentDiffNavigationState() {
      return overrides.currentDiffNavigationState ?? { enabled: false };
    },
    jumpCurrentDiffHunk(direction) {
      calls.push({ type: "jumpDiffHunk", direction });
      return true;
    },
    copyCurrentView() {
      calls.push({ type: "copy" });
    },
    clearLiveTranscriptView() {
      calls.push({ type: "clear" });
    },
    deleteComposerTail() {
      calls.push({ type: "deleteTail" });
    },
    autocompleteComposerInput() {
      calls.push({ type: "autocomplete" });
    },
    navigateComposer(direction) {
      calls.push({ type: "navigate", direction });
    },
    moveComposerCursorByWord(direction) {
      calls.push({ type: "moveWord", direction });
    },
    setTransientStatus(status) {
      calls.push({ type: "status", status });
    },
    dismissIntro() {
      watchState.introDismissed = true;
      calls.push({ type: "dismissIntro" });
    },
    insertComposerTextValue(char) {
      watchState.composerInput =
        watchState.composerInput.slice(0, watchState.composerCursor) +
        char +
        watchState.composerInput.slice(watchState.composerCursor);
      watchState.composerCursor += char.length;
      calls.push({ type: "insert", char });
    },
    resetComposer() {
      watchState.composerInput = "";
      watchState.composerCursor = 0;
      watchState.composerHistoryIndex = -1;
      calls.push({ type: "resetComposer" });
    },
    recordComposerHistory(value) {
      calls.push({ type: "recordHistory", value });
    },
    operatorInputBatcher: {
      push(value) {
        calls.push({ type: "submit", value });
      },
    },
    scheduleRender() {
      calls.push({ type: "render" });
    },
  });
  return { controller, watchState, calls };
}

test("input controller inserts visible characters and dismisses the intro", () => {
  const { controller, watchState, calls } = createInputHarness();

  controller.handleTerminalInput("ab");

  assert.equal(watchState.composerInput, "ab");
  assert.equal(watchState.composerCursor, 2);
  assert.ok(calls.some((entry) => entry.type === "dismissIntro"));
  assert.ok(calls.some((entry) => entry.type === "render"));
});

test("input controller handles enter, tab, and ctrl shortcuts", () => {
  const { controller, watchState, calls } = createInputHarness();
  watchState.composerInput = "show status";
  watchState.composerCursor = watchState.composerInput.length;

  controller.handleTerminalInput("\t\r\x0f\x19\x0c");

  assert.ok(calls.some((entry) => entry.type === "autocomplete"));
  assert.ok(calls.some((entry) => entry.type === "submit" && entry.value === "show status"));
  assert.ok(calls.some((entry) => entry.type === "recordHistory" && entry.value === "show status"));
  assert.ok(calls.some((entry) => entry.type === "resetComposer"));
  assert.ok(calls.some((entry) => entry.type === "toggleExpandedEvent"));
  assert.ok(calls.some((entry) => entry.type === "copy"));
  assert.ok(calls.some((entry) => entry.type === "clear"));
});

test("input controller routes mouse-wheel packets to viewport scrolling", () => {
  const { controller, calls } = createInputHarness({
    parseMouseWheelSequence(input, index) {
      if (index === 0) {
        return { isWheel: true, delta: 3, length: input.length };
      }
      return null;
    },
  });

  controller.handleTerminalInput("wheel");

  assert.ok(calls.some((entry) => entry.type === "scroll" && entry.delta === 3));
});

test("input controller closes expanded detail on unknown escape", () => {
  const { controller, watchState, calls } = createInputHarness();
  watchState.expandedEventId = "evt-1";
  watchState.detailScrollOffset = 8;

  controller.handleTerminalEscapeSequence("\x1b[999~", 0);

  assert.equal(watchState.expandedEventId, null);
  assert.equal(watchState.detailScrollOffset, 0);
  assert.ok(calls.some((entry) => entry.type === "status" && entry.status === "detail closed"));
});

test("input controller routes ctrl+p and ctrl+n to diff hunk navigation only in diff detail mode", () => {
  const { controller, calls } = createInputHarness({
    currentDiffNavigationState: { enabled: true, currentHunkIndex: 1, totalHunks: 3 },
  });

  controller.handleTerminalInput("\x10\x0e");

  assert.deepEqual(
    calls.filter((entry) => entry.type === "jumpDiffHunk"),
    [
      { type: "jumpDiffHunk", direction: -1 },
      { type: "jumpDiffHunk", direction: 1 },
    ],
  );
});

test("input controller ignores diff shortcuts outside diff detail mode", () => {
  const { controller, watchState, calls } = createInputHarness();
  watchState.composerInput = "hello";
  watchState.composerCursor = 5;

  controller.handleTerminalInput("\x10\x0e");

  assert.equal(calls.some((entry) => entry.type === "jumpDiffHunk"), false);
  assert.equal(watchState.composerInput, "hello");
});
