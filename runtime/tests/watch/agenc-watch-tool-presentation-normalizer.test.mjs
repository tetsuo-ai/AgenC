import test from "node:test";
import assert from "node:assert/strict";

import { createToolPresentationNormalizer as createNormalizer } from "./fixtures/agenc-watch-tool-presentation-test-helpers.mjs";

test("normalizer classifies desktop editor replace start without transcript copy", () => {
  const normalizer = createNormalizer();

  assert.deepEqual(
    normalizer.normalizeToolStart("desktop.text_editor", {
      command: "str_replace",
      filePath: "/tmp/demo.txt",
      old_str: "old value",
      new_str: "new value",
    }),
    {
      kind: "desktop-editor-start",
      command: "str_replace",
      filePathDisplay: "/tmp/demo.txt",
      filePathRaw: "/tmp/demo.txt",
      sourceText: "new value",
      oldText: "old value",
      insertLine: null,
      viewRange: null,
    },
  );
});

test("normalizer parses shell result previews and formatted command fields", () => {
  const normalizer = createNormalizer();

  assert.deepEqual(
    normalizer.normalizeToolResult(
      "system.bash",
      {
        command: "npm",
        args: ["run", "test"],
        cwd: "/home/tetsuo/git/AgenC/runtime",
      },
      false,
      JSON.stringify({
        exitCode: 0,
        stdout: "\nall green\nsecond line\n",
        stderr: "",
      }),
    ),
    {
      kind: "shell-result",
      isError: false,
      commandText: "npm run test",
      cwdDisplay: "/home/tetsuo/git/AgenC/runtime",
      exitCode: 0,
      stdoutPreview: "all green",
      stderrPreview: null,
    },
  );
});

test("normalizer keeps generic result parsing separate from final transcript copy", () => {
  const normalizer = createNormalizer();

  const normalized = normalizer.normalizeToolResult(
    "system.inspect",
    { target: "daemon" },
    false,
    '{"status":"ready","detail":"daemon ok"}',
  );

  assert.equal(normalized.kind, "generic-result");
  assert.equal(normalized.toolName, "system.inspect");
  assert.equal(normalized.isError, false);
  assert.deepEqual(normalized.summaryEntries, [{ status: "ready", detail: "daemon ok" }]);
  assert.match(normalized.prettyResult, /"status": "ready"/);
  assert.match(normalized.prettyResult, /"detail": "daemon ok"/);
});
