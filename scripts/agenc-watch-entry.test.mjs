import test from "node:test";
import assert from "node:assert/strict";

import { runAgencWatchCli } from "./agenc-watch.mjs";

function createProcessHarness() {
  const exits = [];
  const writes = [];
  return {
    exits,
    writes,
    processLike: {
      stderr: {
        write: (value) => {
          writes.push(String(value ?? ""));
        },
      },
      exit: (code) => {
        exits.push(code);
      },
    },
  };
}

test("runAgencWatchCli exits with the app exit code on success", async () => {
  const harness = createProcessHarness();

  await runAgencWatchCli({
    runWatchApp: async () => 7,
    processLike: harness.processLike,
  });

  assert.deepEqual(harness.exits, [7]);
  assert.deepEqual(harness.writes, []);
});

test("runAgencWatchCli writes errors and exits non-zero on failure", async () => {
  const harness = createProcessHarness();

  await runAgencWatchCli({
    runWatchApp: async () => {
      throw new Error("boom");
    },
    processLike: harness.processLike,
  });

  assert.deepEqual(harness.exits, [1]);
  assert.equal(harness.writes.length, 1);
  assert.match(harness.writes[0], /boom/);
});
