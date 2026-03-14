import test from "node:test";
import assert from "node:assert/strict";

import { createWatchToolPresentationNormalizer } from "./lib/agenc-watch-tool-presentation-normalizer.mjs";

function createNormalizer() {
  const sanitizeLargeText = (value) =>
    String(value)
      .replace(
        /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g,
        "(image omitted)",
      )
      .replace(/"data":"[A-Za-z0-9+/=\r\n]{120,}"/g, '"data":"(image omitted)"')
      .replace(/[A-Za-z0-9+/=\r\n]{400,}/g, "(blob omitted)");
  const sanitizeInlineText = (value) => sanitizeLargeText(value).replace(/\s+/g, " ").trim();
  const stable = (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const tryParseJson = (value) => {
    if (typeof value !== "string") {
      return value && typeof value === "object" ? value : null;
    }
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };
  const tryPrettyJson = (value) => {
    const raw = typeof value === "string" ? sanitizeLargeText(value) : stable(value);
    if (typeof raw !== "string") {
      return stable(raw);
    }
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  };
  const parseStructuredJson = (value) => {
    if (typeof value !== "string") {
      return value && typeof value === "object" ? [value] : [];
    }
    const single = tryParseJson(value);
    if (single && typeof single === "object" && !Array.isArray(single)) {
      return [single];
    }
    return value
      .split("\n")
      .map((line) => tryParseJson(line.trim()))
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  };

  return createWatchToolPresentationNormalizer({
    sanitizeInlineText,
    sanitizeLargeText,
    truncate: (value, maxChars = 220) =>
      value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`,
    stable,
    tryParseJson,
    tryPrettyJson,
    parseStructuredJson,
  });
}

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
