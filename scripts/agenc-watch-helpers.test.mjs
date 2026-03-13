import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createOperatorInputBatcher,
  findWatchCommandDefinition,
  matchWatchCommands,
  parseWatchSlashCommand,
  shouldAutoInspectRun,
  WATCH_COMMANDS,
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

test("matchWatchCommands returns the full command palette for slash-only input", () => {
  const matches = matchWatchCommands("/");
  assert.equal(matches.length, WATCH_COMMANDS.length);
  assert.equal(matches[0]?.name, "/cancel");
  assert.equal(matches.at(-1)?.name, "/trace");
});

test("matchWatchCommands filters by prefix and aliases", () => {
  assert.deepEqual(
    matchWatchCommands("/se").map((command) => command.name),
    ["/session", "/sessions"],
  );
  assert.equal(findWatchCommandDefinition("/commands")?.name, "/help");
  assert.equal(findWatchCommandDefinition("/copy")?.name, "/export");
  assert.equal(findWatchCommandDefinition("/models")?.name, "/model");
});

test("parseWatchSlashCommand resolves canonical command metadata and args", () => {
  assert.deepEqual(parseWatchSlashCommand("/logs 200"), {
    raw: "/logs 200",
    commandToken: "/logs",
    args: ["200"],
    command: findWatchCommandDefinition("/logs"),
  });
  assert.deepEqual(parseWatchSlashCommand("/copy"), {
    raw: "/copy",
    commandToken: "/copy",
    args: [],
    command: findWatchCommandDefinition("/copy"),
  });
  assert.deepEqual(parseWatchSlashCommand("/model grok-4"), {
    raw: "/model grok-4",
    commandToken: "/model",
    args: ["grok-4"],
    command: findWatchCommandDefinition("/model"),
  });
  assert.equal(parseWatchSlashCommand("ship it"), null);
  assert.equal(parseWatchSlashCommand("/unknown")?.command, null);
});
