import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadOperatorEventHelpers,
  resolveOperatorEventModuleCandidates,
} from "../../src/watch/agenc-watch-runtime.mjs";

test("resolveOperatorEventModuleCandidates prioritizes explicit env override", () => {
  const candidates = resolveOperatorEventModuleCandidates({
    env: {
      AGENC_WATCH_OPERATOR_EVENTS_MODULE: "/tmp/operator-events.mjs",
    },
  });

  assert.deepEqual(candidates[0], {
    kind: "path",
    required: true,
    specifier: "/tmp/operator-events.mjs",
  });
  assert.deepEqual(candidates[1], {
    kind: "package",
    specifier: "@tetsuo-ai/runtime/operator-events",
  });
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
        existsSync: () => false,
        packageImporter: async () => {
          throw new Error("package not installed");
        },
      }),
    /Unable to resolve operator event contract/,
  );
});

test("loadOperatorEventHelpers falls back to the runtime package subpath", async () => {
  const module = await loadOperatorEventHelpers({
    env: {},
    existsSync: () => false,
    packageImporter: async (specifier) => {
      assert.equal(specifier, "@tetsuo-ai/runtime/operator-events");
      return {
        normalizeOperatorMessage(message) {
          return message;
        },
        shouldIgnoreOperatorMessage() {
          return false;
        },
        projectOperatorSurfaceEvent(message) {
          return message;
        },
      };
    },
  });

  assert.equal(typeof module.normalizeOperatorMessage, "function");
  assert.equal(typeof module.shouldIgnoreOperatorMessage, "function");
  assert.equal(typeof module.projectOperatorSurfaceEvent, "function");
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
      }),
    /missing required exports/,
  );
});
