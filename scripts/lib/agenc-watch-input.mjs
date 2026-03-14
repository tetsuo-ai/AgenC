function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchInputController requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchInputController requires a ${name} object`);
  }
}

export function createWatchInputController(dependencies = {}) {
  const {
    watchState,
    shuttingDown,
    parseMouseWheelSequence,
    scrollCurrentViewBy,
    shutdownWatch,
    toggleExpandedEvent,
    currentDiffNavigationState,
    jumpCurrentDiffHunk,
    copyCurrentView,
    clearLiveTranscriptView,
    deleteComposerTail,
    autocompleteComposerInput,
    navigateComposer,
    moveComposerCursorByWord,
    insertComposerTextValue,
    dismissIntro,
    resetComposer,
    recordComposerHistory,
    operatorInputBatcher,
    setTransientStatus,
    scheduleRender,
  } = dependencies;

  assertObject("watchState", watchState);
  assertFunction("shuttingDown", shuttingDown);
  assertFunction("parseMouseWheelSequence", parseMouseWheelSequence);
  assertFunction("scrollCurrentViewBy", scrollCurrentViewBy);
  assertFunction("shutdownWatch", shutdownWatch);
  assertFunction("toggleExpandedEvent", toggleExpandedEvent);
  assertFunction("currentDiffNavigationState", currentDiffNavigationState);
  assertFunction("jumpCurrentDiffHunk", jumpCurrentDiffHunk);
  assertFunction("copyCurrentView", copyCurrentView);
  assertFunction("clearLiveTranscriptView", clearLiveTranscriptView);
  assertFunction("deleteComposerTail", deleteComposerTail);
  assertFunction("autocompleteComposerInput", autocompleteComposerInput);
  assertFunction("navigateComposer", navigateComposer);
  assertFunction("moveComposerCursorByWord", moveComposerCursorByWord);
  assertFunction("insertComposerTextValue", insertComposerTextValue);
  assertFunction("dismissIntro", dismissIntro);
  assertFunction("resetComposer", resetComposer);
  assertFunction("recordComposerHistory", recordComposerHistory);
  if (!operatorInputBatcher || typeof operatorInputBatcher.push !== "function") {
    throw new TypeError("createWatchInputController requires an operatorInputBatcher with push()");
  }
  assertFunction("setTransientStatus", setTransientStatus);
  assertFunction("scheduleRender", scheduleRender);

  function submitComposerInput() {
    const value = watchState.composerInput.trim();
    if (!value) {
      scheduleRender();
      return;
    }
    recordComposerHistory(value);
    resetComposer();
    operatorInputBatcher.push(value);
    scheduleRender();
  }

  function handleTerminalEscapeSequence(input, index) {
    const rest = input.slice(index);
    const sequenceTable = [
      { seq: "\x1b[1;5D", run: () => moveComposerCursorByWord(-1) },
      { seq: "\x1b[5D", run: () => moveComposerCursorByWord(-1) },
      { seq: "\x1bb", run: () => moveComposerCursorByWord(-1) },
      { seq: "\x1b[1;5C", run: () => moveComposerCursorByWord(1) },
      { seq: "\x1b[5C", run: () => moveComposerCursorByWord(1) },
      { seq: "\x1bf", run: () => moveComposerCursorByWord(1) },
      { seq: "\x1b[5~", run: () => scrollCurrentViewBy(12) },
      { seq: "\x1b[6~", run: () => scrollCurrentViewBy(-12) },
      { seq: "\x1b[3~", run: () => {
        if (watchState.composerCursor < watchState.composerInput.length) {
          watchState.composerInput =
            watchState.composerInput.slice(0, watchState.composerCursor) +
            watchState.composerInput.slice(watchState.composerCursor + 1);
          watchState.composerHistoryIndex = -1;
        }
      } },
      { seq: "\x1b[A", run: () => navigateComposer(-1) },
      { seq: "\x1b[B", run: () => navigateComposer(1) },
      { seq: "\x1b[D", run: () => {
        watchState.composerCursor = Math.max(0, watchState.composerCursor - 1);
      } },
      { seq: "\x1b[C", run: () => {
        watchState.composerCursor = Math.min(watchState.composerInput.length, watchState.composerCursor + 1);
      } },
      { seq: "\x1b[H", run: () => {
        watchState.composerCursor = 0;
      } },
      { seq: "\x1b[F", run: () => {
        watchState.composerCursor = watchState.composerInput.length;
      } },
      { seq: "\x1b[1~", run: () => {
        watchState.composerCursor = 0;
      } },
      { seq: "\x1b[4~", run: () => {
        watchState.composerCursor = watchState.composerInput.length;
      } },
    ];

    for (const entry of sequenceTable) {
      if (rest.startsWith(entry.seq)) {
        entry.run();
        return index + entry.seq.length;
      }
    }

    if (watchState.expandedEventId) {
      watchState.expandedEventId = null;
      watchState.detailScrollOffset = 0;
      setTransientStatus("detail closed");
    }
    return index + 1;
  }

  function handleTerminalInput(input) {
    if (shuttingDown() || input.length === 0) {
      return;
    }

    let index = 0;
    let didMutate = false;

    while (index < input.length) {
      const mouseWheel = parseMouseWheelSequence(input, index);
      if (mouseWheel) {
        if (mouseWheel.isWheel && mouseWheel.delta !== 0) {
          scrollCurrentViewBy(mouseWheel.delta);
        }
        didMutate = true;
        index += mouseWheel.length;
        continue;
      }

      const char = input[index];
      if (char === "\x03") {
        shutdownWatch(0);
        return;
      }
      if (char === "\x0f") {
        toggleExpandedEvent();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x19") {
        copyCurrentView();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x10" || char === "\x0e") {
        const diffNavigation = currentDiffNavigationState();
        if (diffNavigation?.enabled) {
          jumpCurrentDiffHunk(char === "\x0e" ? 1 : -1);
          didMutate = true;
          index += 1;
          continue;
        }
      }
      if (char === "\x0c") {
        clearLiveTranscriptView();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x0b") {
        deleteComposerTail();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x01") {
        watchState.composerCursor = 0;
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x05") {
        watchState.composerCursor = watchState.composerInput.length;
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\r" || char === "\n") {
        submitComposerInput();
        didMutate = true;
        index += char === "\r" && input[index + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (char === "\t") {
        autocompleteComposerInput();
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x7f" || char === "\b") {
        if (watchState.composerCursor > 0) {
          watchState.composerInput =
            watchState.composerInput.slice(0, watchState.composerCursor - 1) +
            watchState.composerInput.slice(watchState.composerCursor);
          watchState.composerCursor -= 1;
          watchState.composerHistoryIndex = -1;
        }
        didMutate = true;
        index += 1;
        continue;
      }
      if (char === "\x1b") {
        index = handleTerminalEscapeSequence(input, index);
        didMutate = true;
        continue;
      }
      if (char < " ") {
        index += 1;
        continue;
      }

      if (!watchState.introDismissed) {
        dismissIntro();
      }
      insertComposerTextValue(char);
      watchState.composerHistoryIndex = -1;
      didMutate = true;
      index += 1;
    }

    if (didMutate) {
      scheduleRender();
    }
  }

  return {
    submitComposerInput,
    handleTerminalEscapeSequence,
    handleTerminalInput,
  };
}
