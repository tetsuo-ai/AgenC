import test from "node:test";
import assert from "node:assert/strict";

import { createWatchToolPresentation } from "./lib/agenc-watch-tool-presentation.mjs";

function createToolPresentation() {
  const sanitizeLargeText = (value) =>
    String(value)
      .replace(
        /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g,
        "(image omitted)",
      )
      .replace(/"data":"[A-Za-z0-9+/=\r\n]{120,}"/g, '"data":"(image omitted)"')
      .replace(/[A-Za-z0-9+/=\r\n]{400,}/g, "(blob omitted)");
  const sanitizeInlineText = (value) => sanitizeLargeText(value).replace(/\s+/g, " ").trim();
  const sanitizeDisplayText = (value) =>
    sanitizeLargeText(value)
      .replace(/```/g, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/__(.*?)__/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/^\s*[-*]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "");
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

  return createWatchToolPresentation({
    sanitizeInlineText,
    sanitizeLargeText,
    sanitizeDisplayText,
    truncate: (value, maxChars = 220) =>
      value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`,
    stable,
    tryParseJson,
    tryPrettyJson,
    parseStructuredJson,
    buildToolSummary: (parsed) => {
      const entries = Array.isArray(parsed) ? parsed : [];
      return entries
        .map((entry) => (entry && typeof entry === "object" ? entry.status : null))
        .filter(Boolean)
        .map((status) => `status: ${status}`);
    },
  });
}

test("createWatchToolPresentation validates required dependencies", () => {
  assert.throws(
    () => createWatchToolPresentation({}),
    /requires a sanitizeInlineText function dependency/,
  );
});

test("tool presentation formats shell starts and low-signal suppression", () => {
  const tools = createToolPresentation();

  assert.equal(
    tools.shouldSuppressToolTranscript("system.bash", { command: "pwd" }),
    true,
  );
  assert.equal(
    tools.backgroundToolSurfaceLabel("system.bash", { command: "npm", args: ["test"] }),
    "Run npm test",
  );

  assert.deepEqual(
    tools.describeToolStart("system.bash", {
      command: "npm",
      args: ["run", "test"],
      cwd: "/home/tetsuo/git/AgenC/runtime",
    }),
    {
      title: "Run npm run test",
      body: "cwd: /home/tetsuo/git/AgenC/runtime",
      tone: "yellow",
    },
  );
});

test("tool presentation formats delegated child tasks", () => {
  const tools = createToolPresentation();

  const descriptor = tools.describeToolStart("execute_with_agent", {
    objective: "Implement the DAG renderer",
    tools: ["system.bash", "system.writeFile"],
    workingDirectory: "/home/tetsuo/git/AgenC/runtime",
    acceptanceCriteria: ["tests pass", "build succeeds"],
  });

  assert.equal(descriptor.title, "Delegate Implement the DAG renderer");
  assert.match(descriptor.body, /tools: system.bash, system.writeFile/);
  assert.match(descriptor.body, /cwd: \/home\/tetsuo\/git\/AgenC\/runtime/);
  assert.match(descriptor.body, /acceptance: tests pass \| build succeeds/);
  assert.equal(descriptor.tone, "magenta");
});

test("tool presentation formats text-editor reads and suppresses low-signal reads", () => {
  const tools = createToolPresentation();

  assert.equal(
    tools.shouldSuppressToolTranscript("desktop.text_editor", {
      command: "view",
      filePath: "/tmp/demo.txt",
      view_range: [1, 20],
    }),
    true,
  );

  assert.deepEqual(
    tools.describeToolResult(
      "desktop.text_editor",
      {
        command: "view",
        filePath: "/tmp/demo.txt",
      },
      false,
      JSON.stringify({ output: "line one\nline two" }),
    ),
    {
      title: "Read /tmp/demo.txt",
      body: "path: /tmp/demo.txt\nline one\nline two",
      tone: "slate",
      previewMode: "source-read",
      filePath: "/tmp/demo.txt",
    },
  );
});

test("tool presentation emits structured mutation metadata for write and replace flows", () => {
  const tools = createToolPresentation();

  const writeDescriptor = tools.describeToolStart("system.writeFile", {
    path: "/home/tetsuo/git/AgenC/runtime/src/index.ts",
    content: "export const ready = true;\n",
  });
  assert.equal(writeDescriptor.previewMode, "source-write");
  assert.equal(writeDescriptor.filePath, "/home/tetsuo/git/AgenC/runtime/src/index.ts");
  assert.equal(writeDescriptor.mutationKind, "write");
  assert.equal(writeDescriptor.mutationAfterText, "export const ready = true;\n");

  const replaceDescriptor = tools.describeToolStart("desktop.text_editor", {
    command: "str_replace",
    filePath: "/tmp/demo.txt",
    old_str: "old value",
    new_str: "new value",
  });
  assert.equal(replaceDescriptor.previewMode, "source-write");
  assert.equal(replaceDescriptor.filePath, "/tmp/demo.txt");
  assert.equal(replaceDescriptor.mutationKind, "replace");
  assert.equal(replaceDescriptor.mutationBeforeText, "old value");
  assert.equal(replaceDescriptor.mutationAfterText, "new value");
});

test("tool presentation formats shell results and generic summaries", () => {
  const tools = createToolPresentation();

  assert.deepEqual(
    tools.describeToolResult(
      "system.bash",
      {
        command: "pwd",
        cwd: "/home/tetsuo/git/AgenC",
      },
      false,
      JSON.stringify({ exitCode: 0, stdout: "/home/tetsuo/git/AgenC\n" }),
    ),
    {
      title: "Ran pwd",
      body: "cwd: /home/tetsuo/git/AgenC\nexit 0\n/home/tetsuo/git/AgenC",
      tone: "green",
    },
  );

  const generic = tools.describeToolResult(
    "system.inspect",
    { target: "daemon" },
    false,
    JSON.stringify({ status: "ready" }),
  );

  assert.equal(generic.title, "system.inspect");
  assert.equal(generic.body, "status: ready");
  assert.equal(generic.tone, "green");
});
