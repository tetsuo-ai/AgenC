import test from "node:test";
import assert from "node:assert/strict";

import {
  clearSubagentToolArgs,
  createWatchState,
  createWatchStateBindings,
  loadPersistedWatchState,
  persistWatchState,
  readSubagentToolArgs,
  rememberSubagentToolArgs,
  resetDelegatedWatchState,
} from "./lib/agenc-watch-state.mjs";

test("loadPersistedWatchState returns sanitized values for the active client key", () => {
  const fs = {
    readFileSync: () =>
      JSON.stringify({
        clientKey: "watch-key",
        ownerToken: " owner-1 ",
        sessionId: " session-1 ",
      }),
  };

  assert.deepEqual(
    loadPersistedWatchState({
      fs,
      path: {},
      watchStateFile: "/tmp/watch-state.json",
      clientKey: "watch-key",
    }),
    { ownerToken: "owner-1", sessionId: "session-1" },
  );
});

test("persistWatchState stores sanitized values and creates the parent directory", () => {
  const calls = [];
  const fs = {
    mkdirSync: (value, options) => calls.push(["mkdirSync", value, options]),
    writeFileSync: (value, data) => calls.push(["writeFileSync", value, data]),
  };
  const path = {
    dirname: (value) => `${value}.dir`,
  };

  persistWatchState({
    fs,
    path,
    watchStateFile: "/tmp/watch-state.json",
    clientKey: "watch-key",
    ownerToken: " owner-2 ",
    sessionId: " session-2 ",
  });

  assert.deepEqual(calls[0], [
    "mkdirSync",
    "/tmp/watch-state.json.dir",
    { recursive: true },
  ]);
  assert.equal(calls[1][0], "writeFileSync");
  assert.equal(calls[1][1], "/tmp/watch-state.json");
  assert.match(calls[1][2], /"ownerToken": "owner-2"/);
  assert.match(calls[1][2], /"sessionId": "session-2"/);
});

test("createWatchState seeds persisted identity and collection state", () => {
  const state = createWatchState({
    persistedWatchState: {
      ownerToken: "owner-3",
      sessionId: "session-3",
    },
    launchedAtMs: 123,
  });

  assert.equal(state.ownerToken, "owner-3");
  assert.equal(state.sessionId, "session-3");
  assert.equal(state.sessionAttachedAtMs, 123);
  assert.equal(state.transientStatus, "Booting watch client…");
  assert.ok(Array.isArray(state.events));
  assert.ok(state.subagentPlanSteps instanceof Map);
  assert.ok(state.subagentToolArgs instanceof Map);
});

test("createWatchStateBindings exposes mutable bridge bindings", () => {
  const state = createWatchState();
  const bindings = createWatchStateBindings({
    state,
    bindState: (get, set) => ({ get, set }),
  });

  bindings.sessionId.set("session-4");
  bindings.latestTool.set("system.bash");

  assert.equal(bindings.sessionId.get(), "session-4");
  assert.equal(bindings.latestTool.get(), "system.bash");
  assert.equal(state.sessionId, "session-4");
  assert.equal(state.latestTool, "system.bash");
});

test("subagent tool arg helpers cache, read, clear, and reset cleanly", () => {
  const state = createWatchState();
  state.subagentPlanSteps.set("step-1", { id: 1 });
  state.subagentSessionPlanKeys.set("session-1", "step-1");
  state.subagentLiveActivity.set("session-1", "editing file");
  state.recentSubagentLifecycleFingerprints.set("fingerprint", Date.now());
  state.plannerDagNodes.set("node-1", { key: "node-1" });
  state.plannerDagEdges.push({ from: "a", to: "b" });
  state.plannerDagStatus = "running";
  state.plannerDagNote = "note";
  state.plannerDagUpdatedAt = 456;
  state.plannerDagHydratedSessionId = "session-1";

  rememberSubagentToolArgs(state, "session-1", "system.bash", {
    command: "pwd",
  });
  rememberSubagentToolArgs(state, "session-1", "system.readFile", {
    path: "README.md",
  });

  assert.deepEqual(
    readSubagentToolArgs(state, "session-1", "system.bash"),
    { command: "pwd" },
  );

  clearSubagentToolArgs(state, "session-1", "system.bash");
  assert.equal(
    readSubagentToolArgs(state, "session-1", "system.bash"),
    undefined,
  );
  assert.deepEqual(
    readSubagentToolArgs(state, "session-1", "system.readFile"),
    { path: "README.md" },
  );

  resetDelegatedWatchState(state);

  assert.equal(state.subagentPlanSteps.size, 0);
  assert.equal(state.subagentSessionPlanKeys.size, 0);
  assert.equal(state.subagentLiveActivity.size, 0);
  assert.equal(state.recentSubagentLifecycleFingerprints.size, 0);
  assert.equal(state.subagentToolArgs.size, 0);
  assert.equal(state.plannerDagNodes.size, 0);
  assert.deepEqual(state.plannerDagEdges, []);
  assert.equal(state.plannerDagStatus, "idle");
  assert.equal(state.plannerDagNote, null);
  assert.equal(state.plannerDagUpdatedAt, 0);
  assert.equal(state.plannerDagHydratedSessionId, null);
});
