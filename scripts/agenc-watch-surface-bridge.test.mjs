import test from "node:test";
import assert from "node:assert/strict";

import {
  bindWatchSurfaceState,
  createWatchSurfaceDispatchBridge,
  REQUIRED_HELPER_KEYS,
  REQUIRED_STATE_KEYS,
} from "./lib/agenc-watch-surface-bridge.mjs";

function createBridgeHarness() {
  const store = {};
  for (const key of REQUIRED_STATE_KEYS) {
    store[key] = null;
  }

  const stateBindings = Object.fromEntries(
    REQUIRED_STATE_KEYS.map((key) => [
      key,
      bindWatchSurfaceState(
        () => store[key],
        (value) => {
          store[key] = value;
        },
      ),
    ]),
  );

  const helpers = Object.fromEntries(
    REQUIRED_HELPER_KEYS.map((key) => [
      key,
      key === "eventStore"
        ? {
          pushEvent: () => "pushEvent",
          appendAgentStreamChunk: () => "appendAgentStreamChunk",
          commitAgentMessage: () => "commitAgentMessage",
          cancelAgentStream: () => "cancelAgentStream",
          restoreTranscriptFromHistory: () => "restoreTranscriptFromHistory",
          clearLiveTranscriptView: () => "clearLiveTranscriptView",
          replaceLatestToolEvent: () => "replaceLatestToolEvent",
          replaceLatestSubagentToolEvent: () => "replaceLatestSubagentToolEvent",
          clearSubagentHeartbeatEvents: () => "clearSubagentHeartbeatEvents",
        }
        : () => key,
    ]),
  );

  return {
    store,
    stateBindings,
    helpers,
  };
}

test("createWatchSurfaceDispatchBridge exposes mutable state passthroughs", () => {
  const { store, stateBindings, helpers } = createBridgeHarness();
  const { state, api } = createWatchSurfaceDispatchBridge({ stateBindings, helpers });

  state.sessionId = "session-1";
  state.runState = "running";

  assert.equal(store.sessionId, "session-1");
  assert.equal(store.runState, "running");
  assert.equal(state.sessionId, "session-1");
  assert.equal(state.runState, "running");
  assert.equal(api.state, state);
});

test("createWatchSurfaceDispatchBridge preserves helper references", () => {
  const { stateBindings, helpers } = createBridgeHarness();
  const { api } = createWatchSurfaceDispatchBridge({ stateBindings, helpers });

  for (const key of REQUIRED_HELPER_KEYS) {
    assert.equal(api[key], helpers[key]);
  }
});

test("createWatchSurfaceDispatchBridge rejects missing state bindings", () => {
  const { stateBindings, helpers } = createBridgeHarness();
  delete stateBindings.sessionId;

  assert.throws(
    () => createWatchSurfaceDispatchBridge({ stateBindings, helpers }),
    /Missing required watch surface state binding: sessionId/,
  );
});

test("createWatchSurfaceDispatchBridge rejects malformed state bindings", () => {
  const { stateBindings, helpers } = createBridgeHarness();
  stateBindings.sessionId = { get: () => "session-1" };

  assert.throws(
    () => createWatchSurfaceDispatchBridge({ stateBindings, helpers }),
    /Invalid watch surface state binding for sessionId/,
  );
});

test("createWatchSurfaceDispatchBridge rejects missing helper bindings", () => {
  const { stateBindings, helpers } = createBridgeHarness();
  delete helpers.now;

  assert.throws(
    () => createWatchSurfaceDispatchBridge({ stateBindings, helpers }),
    /Missing required watch surface helper: now/,
  );
});

test("bindWatchSurfaceState validates its input", () => {
  assert.throws(
    () => bindWatchSurfaceState(null, () => {}),
    /expects getter and setter functions/,
  );
});

test("createWatchSurfaceDispatchBridge rejects malformed eventStore bindings", () => {
  const { stateBindings, helpers } = createBridgeHarness();
  helpers.eventStore = { pushEvent: () => {} };

  assert.throws(
    () => createWatchSurfaceDispatchBridge({ stateBindings, helpers }),
    /Invalid watch surface eventStore; missing appendAgentStreamChunk/,
  );
});
