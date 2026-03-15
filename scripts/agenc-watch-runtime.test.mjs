import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadOperatorEventHelpers,
  resolveOperatorEventModuleCandidates,
} from "./lib/agenc-watch-runtime.mjs";

test("resolveOperatorEventModuleCandidates prioritizes explicit env override", () => {
  const candidates = resolveOperatorEventModuleCandidates({
    env: {
      AGENC_WATCH_OPERATOR_EVENTS_MODULE: "/tmp/operator-events.mjs",
    },
    baseDir: "/repo/scripts",
    cwd: "/repo",
  });

  assert.equal(candidates[0], "/tmp/operator-events.mjs");
  assert.equal(candidates[1], "/repo/runtime/dist/operator-events.mjs");
  assert.equal(candidates[2], "/repo/runtime/dist/operator-events.mjs");
});

test("loadOperatorEventHelpers loads an explicit module override", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-watch-runtime-"));
  const modulePath = path.join(tempDir, "operator-events.mjs");
  fs.writeFileSync(
    modulePath,
    [
      "export function normalizeOperatorMessage(message) { return message; }",
      "export function shouldIgnoreOperatorMessage() { return false; }",
      "export function projectOperatorSurfaceEvent(message) { return message; }",
      "",
    ].join("\n"),
    "utf8",
  );

  const module = await loadOperatorEventHelpers({
    env: {
      AGENC_WATCH_OPERATOR_EVENTS_MODULE: modulePath,
    },
    baseDir: "/repo/scripts",
    cwd: "/repo",
  });

  assert.equal(typeof module.normalizeOperatorMessage, "function");
  assert.equal(typeof module.shouldIgnoreOperatorMessage, "function");
  assert.equal(typeof module.projectOperatorSurfaceEvent, "function");
});

test("loadOperatorEventHelpers fails loudly when the runtime contract is missing", async () => {
  await assert.rejects(
    () =>
      loadOperatorEventHelpers({
        env: {},
        baseDir: "/missing/scripts",
        cwd: "/missing",
        existsSync: () => false,
      }),
    /Unable to resolve operator event contract/,
  );
});

test("loadOperatorEventHelpers rejects modules missing required exports", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-watch-runtime-bad-"));
  const modulePath = path.join(tempDir, "operator-events.mjs");
  fs.writeFileSync(
    modulePath,
    [
      "export function normalizeOperatorMessage(message) { return message; }",
      "export function shouldIgnoreOperatorMessage() { return false; }",
      "",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      loadOperatorEventHelpers({
        env: {
          AGENC_WATCH_OPERATOR_EVENTS_MODULE: modulePath,
        },
        baseDir: "/repo/scripts",
        cwd: "/repo",
      }),
    /missing required exports/,
  );
});
