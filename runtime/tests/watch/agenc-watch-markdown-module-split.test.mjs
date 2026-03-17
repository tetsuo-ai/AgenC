import test from "node:test";
import assert from "node:assert/strict";

import { buildMarkdownDisplayLines } from "../../src/watch/agenc-watch-markdown-parse.mjs";
import {
  buildStreamingMarkdownDisplayLines,
  createMarkdownStreamCollector,
} from "../../src/watch/agenc-watch-markdown-stream.mjs";

test("markdown parse module preserves structural markdown rendering", () => {
  const lines = buildMarkdownDisplayLines(`
# Heading

- one
> quote

\`\`\`js
const answer = 42;
\`\`\`
`);

  const actual = lines
    .filter((line) => line.mode !== "blank")
    .map((line) => ({ mode: line.mode, text: line.text }));

  assert.deepEqual(actual, [
    { mode: "heading", text: "Heading" },
    { mode: "list", text: "• one" },
    { mode: "quote", text: "quote" },
    { mode: "code-meta", text: "code · js" },
    { mode: "code", text: "const answer = 42;" },
  ]);
});

test("markdown stream module preserves incremental table sanitization and collector state", () => {
  const collector = createMarkdownStreamCollector();
  collector.pushDelta("| Name | Value |\n| --- | --- |\n| alp");
  const preview = collector.snapshot()
    .filter((line) => line.mode !== "blank")
    .map((line) => ({ mode: line.mode, text: line.text }));

  assert.deepEqual(preview, [
    { mode: "table-header", text: "Name │ Value" },
    { mode: "table-divider", text: "─────┼──────" },
    { mode: "stream-tail", text: "alp" },
  ]);

  const direct = buildStreamingMarkdownDisplayLines("| Name | Value |\n| --- | --- |\n| alp");
  assert.deepEqual(
    direct.filter((line) => line.mode !== "blank").map((line) => ({ mode: line.mode, text: line.text })),
    preview,
  );
});
