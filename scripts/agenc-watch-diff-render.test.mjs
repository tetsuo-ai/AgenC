import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiffDisplayLines,
  isDiffRenderableEvent,
} from "./lib/agenc-watch-diff-render.mjs";

test("isDiffRenderableEvent accepts structured source-write mutation events", () => {
  assert.equal(
    isDiffRenderableEvent({
      previewMode: "source-write",
      mutationKind: "replace",
    }),
    true,
  );
  assert.equal(
    isDiffRenderableEvent({
      previewMode: "source-read",
      mutationKind: "replace",
    }),
    false,
  );
});

test("isDiffRenderableEvent accepts unified diff bodies on tool events", () => {
  assert.equal(
    isDiffRenderableEvent({
      kind: "tool result",
      body: "--- a/runtime/src/index.ts\n+++ b/runtime/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
    }),
    true,
  );
});

test("buildDiffDisplayLines renders replace mutations with remove and add hunks", () => {
  const lines = buildDiffDisplayLines(
    {
      previewMode: "source-write",
      mutationKind: "replace",
      filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts",
      mutationBeforeText: "const oldValue = 1;",
      mutationAfterText: "const newValue = 2;",
    },
    {
      cwd: "/home/tetsuo/git/AgenC",
      maxPathChars: 48,
    },
  ).map((line) => ({ mode: line.mode, text: line.text }));

  assert.deepEqual(lines, [
    { mode: "diff-header", text: "replace · runtime/src/index.ts" },
    { mode: "diff-hunk", text: "@@ replace @@" },
    { mode: "diff-section-remove", text: "--- before" },
    { mode: "diff-remove", text: "- const oldValue = 1;" },
    { mode: "diff-section-add", text: "+++ after" },
    { mode: "diff-add", text: "+ const newValue = 2;" },
  ]);
});

test("buildDiffDisplayLines renders inserts with range metadata", () => {
  const lines = buildDiffDisplayLines(
    {
      previewMode: "source-write",
      mutationKind: "insert",
      filePath: "/home/tetsuo/git/AgenC/scripts/agenc-watch.mjs",
      fileRange: { afterLine: 120 },
      mutationAfterText: "const marker = true;",
    },
    {
      cwd: "/home/tetsuo/git/AgenC",
      maxPathChars: 40,
    },
  ).map((line) => ({ mode: line.mode, text: line.text }));

  assert.deepEqual(lines, [
    { mode: "diff-header", text: "insert · scripts/agenc-watch.mjs" },
    { mode: "diff-meta", text: "after line 120" },
    { mode: "diff-hunk", text: "@@ after line 120 @@" },
    { mode: "diff-section-add", text: "+++ after" },
    { mode: "diff-add", text: "+ const marker = true;" },
  ]);
});

test("buildDiffDisplayLines falls back to unified diff parsing when metadata is missing", () => {
  const lines = buildDiffDisplayLines(
    {
      kind: "tool result",
      body: [
        "--- a/runtime/src/index.ts",
        "+++ b/runtime/src/index.ts",
        "@@ -1,2 +1,2 @@",
        "-const oldValue = 1;",
        "+const newValue = 2;",
        " console.log(newValue);",
      ].join("\n"),
    },
    {
      cwd: "/home/tetsuo/git/AgenC",
      maxPathChars: 48,
    },
  ).map((line) => ({ mode: line.mode, text: line.text }));

  assert.deepEqual(lines, [
    { mode: "diff-header", text: "patch · runtime/src/index.ts" },
    { mode: "diff-hunk", text: "@@ -1,2 +1,2 @@" },
    { mode: "diff-remove", text: "-const oldValue = 1;" },
    { mode: "diff-add", text: "+const newValue = 2;" },
    { mode: "diff-context", text: " console.log(newValue);" },
  ]);
});
