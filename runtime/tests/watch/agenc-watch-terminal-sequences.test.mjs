import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAltScreenEnterSequence,
  buildAltScreenLeaveSequence,
  buildTerminalHyperlinkSequence,
  parseMouseWheelSequence,
  supportsTerminalHyperlinks,
} from "../../src/watch/agenc-watch-terminal-sequences.mjs";

test("terminal sequences enable and disable alternate scroll alongside mouse tracking", () => {
  assert.match(buildAltScreenEnterSequence(), /\?1007h/);
  assert.match(buildAltScreenLeaveSequence(), /\?1007l/);
});

test("parseMouseWheelSequence parses sgr wheel events", () => {
  assert.deepEqual(parseMouseWheelSequence("\x1b[<64;10;20M"), {
    length: "\x1b[<64;10;20M".length,
    delta: 3,
    isWheel: true,
  });
  assert.deepEqual(parseMouseWheelSequence("\x1b[<65;10;20M"), {
    length: "\x1b[<65;10;20M".length,
    delta: -3,
    isWheel: true,
  });
});

test("parseMouseWheelSequence ignores non-wheel sgr mouse packets", () => {
  assert.deepEqual(parseMouseWheelSequence("\x1b[<0;10;20M"), {
    length: "\x1b[<0;10;20M".length,
    delta: 0,
    isWheel: false,
  });
  assert.equal(parseMouseWheelSequence("plain text"), null);
});

test("supportsTerminalHyperlinks detects safe defaults and force flags", () => {
  assert.equal(
    supportsTerminalHyperlinks({
      stream: { isTTY: true },
      env: { TERM: "xterm-256color", WT_SESSION: "1" },
    }),
    true,
  );
  assert.equal(
    supportsTerminalHyperlinks({
      stream: { isTTY: true },
      env: { TERM: "dumb" },
    }),
    false,
  );
  assert.equal(
    supportsTerminalHyperlinks({
      stream: { isTTY: false },
      env: { AGENC_WATCH_ENABLE_HYPERLINKS: "1" },
    }),
    true,
  );
});

test("buildTerminalHyperlinkSequence wraps content in OSC 8 escapes", () => {
  assert.equal(
    buildTerminalHyperlinkSequence("runtime/src/index.ts", "file:///tmp/runtime/src/index.ts"),
    "\u001b]8;;file:///tmp/runtime/src/index.ts\u0007runtime/src/index.ts\u001b]8;;\u0007",
  );
});
