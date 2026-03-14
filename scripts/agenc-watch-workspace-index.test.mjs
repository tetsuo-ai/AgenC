import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createWorkspaceFileIndex,
  loadWorkspaceFileIndex,
  searchWorkspaceFileIndex,
} from "./lib/agenc-watch-workspace-index.mjs";

test("createWorkspaceFileIndex normalizes and sorts relative paths", () => {
  const index = createWorkspaceFileIndex([
    "./runtime/src/index.ts",
    "scripts\\agenc-watch.mjs",
    "runtime/src/index.ts",
  ]);

  assert.deepEqual(
    index.files.map((entry) => entry.path),
    ["runtime/src/index.ts", "scripts/agenc-watch.mjs"],
  );
});

test("searchWorkspaceFileIndex ranks prefix and basename matches deterministically", () => {
  const index = createWorkspaceFileIndex([
    "runtime/src/channels/webchat/operator-events.ts",
    "runtime/src/channels/webchat/types.ts",
    "runtime/src/gateway/message.ts",
  ]);

  const suggestions = searchWorkspaceFileIndex(index, "types", { limit: 3 });

  assert.deepEqual(
    suggestions.map((entry) => entry.path),
    ["runtime/src/channels/webchat/types.ts"],
  );
});

test("loadWorkspaceFileIndex falls back to fs walking when ripgrep is unavailable", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-watch-workspace-"));
  fs.mkdirSync(path.join(workspace, "runtime", "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "runtime", "src", "index.ts"), "export {};\n");
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");

  const index = loadWorkspaceFileIndex({
    cwd: workspace,
    execFileSyncImpl() {
      throw new Error("rg unavailable");
    },
  });

  assert.equal(index.ready, true);
  assert.deepEqual(
    index.files.map((entry) => entry.path),
    ["runtime/src/index.ts"],
  );
});
