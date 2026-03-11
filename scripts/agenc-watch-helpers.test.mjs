import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createOperatorInputBatcher,
  shouldAutoInspectRun,
} from "./lib/agenc-watch-helpers.mjs";

test("createOperatorInputBatcher coalesces rapid pasted lines into one turn", async () => {
  const dispatched = [];
  const batcher = createOperatorInputBatcher({
    delayMs: 5,
    onDispatch: (value) => dispatched.push(value),
  });

  batcher.push("Requirements:");
  await sleep(1);
  batcher.push("- Use npm and TypeScript only.");
  await sleep(1);
  batcher.push("- Add tests.");
  await sleep(15);

  assert.deepEqual(dispatched, [
    "Requirements:\n- Use npm and TypeScript only.\n- Add tests.",
  ]);
});

test("createOperatorInputBatcher keeps separate turns separate when they are not paste bursts", async () => {
  const dispatched = [];
  const batcher = createOperatorInputBatcher({
    delayMs: 5,
    onDispatch: (value) => dispatched.push(value),
  });

  batcher.push("first turn");
  await sleep(15);
  batcher.push("second turn");
  await sleep(15);

  assert.deepEqual(dispatched, ["first turn", "second turn"]);
});

test("createOperatorInputBatcher ignores empty lines", async () => {
  const dispatched = [];
  const batcher = createOperatorInputBatcher({
    delayMs: 5,
    onDispatch: (value) => dispatched.push(value),
  });

  batcher.push("   ");
  batcher.push("");
  batcher.push("real turn");
  await sleep(15);

  assert.deepEqual(dispatched, ["real turn"]);
});

test("shouldAutoInspectRun only enables auto inspect for background-run state", () => {
  assert.equal(shouldAutoInspectRun(null, "idle"), false);
  assert.equal(shouldAutoInspectRun(null, "queued"), false);
  assert.equal(shouldAutoInspectRun(null, "working"), true);
  assert.equal(shouldAutoInspectRun({ state: "completed" }, "idle"), true);
});
