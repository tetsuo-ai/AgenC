import test from "node:test";
import assert from "node:assert/strict";

import { createWatchEventStore } from "../../src/watch/agenc-watch-event-store.mjs";

function createHarness() {
  const events = [];
  const watchState = {
    transcriptScrollOffset: 12,
    transcriptFollowMode: false,
    detailScrollOffset: 4,
    lastActivityAt: null,
    latestAgentSummary: null,
    expandedEventId: "evt-stale",
  };
  const calls = [];
  let nextIdCounter = 0;
  let nowCounter = 0;

  const store = createWatchEventStore({
    watchState,
    events,
    maxEvents: 3,
    introDismissKinds: new Set(["agent", "tool", "subagent"]),
    nextId: (prefix = "evt") => `${prefix}-${++nextIdCounter}`,
    nowStamp: () => `12:00:0${++nowCounter}`,
    nowMs: () => 1_000 + nowCounter,
    normalizeEventBody: (value) => ({
      body: String(value ?? ""),
      bodyTruncated: String(value ?? "").length > 8,
    }),
    sanitizeLargeText: (value) => String(value ?? ""),
    sanitizeInlineText: (value) => String(value ?? "").replace(/\s+/g, " ").trim(),
    stripTerminalControlSequences: (value) => String(value ?? "").replace(/\x1b\[[0-9;]*m/g, ""),
    dismissIntro: () => calls.push(["dismissIntro"]),
    scheduleRender: () => calls.push(["scheduleRender"]),
    withPreservedManualTranscriptViewport: (mutator) => mutator({ shouldFollow: true }),
    findLatestPendingAgentEvent: (value) =>
      [...value].reverse().find((event) => event.kind === "agent" && event.streamState !== "complete") ?? null,
    nextAgentStreamState: ({ done }) => (done ? "pending-final" : "streaming"),
    setTransientStatus: (value) => calls.push(["setTransientStatus", value]),
    resetDelegationState: () => calls.push(["resetDelegationState"]),
    applyDescriptorRenderingMetadata: (target, descriptor) => {
      if (descriptor?.previewMode) {
        target.previewMode = descriptor.previewMode;
      }
    },
    formatHistoryTimestamp: (value, nowStamp) => (value ? `history:${value}` : nowStamp()),
  });

  return {
    store,
    watchState,
    events,
    calls,
  };
}

test("event store coalesces repeated events and preserves follow mode", () => {
  const { store, events, watchState, calls } = createHarness();

  store.pushEvent("tool", "Run bash", "pwd", "yellow", { toolName: "system.bash" });
  store.pushEvent("tool", "Run bash", "pwd", "yellow", { toolName: "system.bash" });

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Run bash");
  assert.equal(watchState.transcriptScrollOffset, 0);
  assert.equal(watchState.transcriptFollowMode, true);
  assert.equal(watchState.lastActivityAt, "12:00:02");
  assert.deepEqual(
    calls.filter(([name]) => name === "scheduleRender"),
    [["scheduleRender"], ["scheduleRender"]],
  );
});

test("event store streams and commits agent replies with summary side effects", () => {
  const { store, events, watchState } = createHarness();

  store.appendAgentStreamChunk("hello ");
  store.appendAgentStreamChunk("world", { done: true });
  store.commitAgentMessage("hello world");

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Agent Reply");
  assert.equal(events[0].streamState, "complete");
  assert.equal(events[0].body, "hello world");
  assert.equal(watchState.latestAgentSummary, "hello world");
  assert.equal(watchState.lastActivityAt, "12:00:03");
  assert.equal(watchState.transcriptFollowMode, true);
});

test("event store restores transcript history and clears stale expanded selection", () => {
  const { store, events, watchState } = createHarness();

  store.restoreTranscriptFromHistory([
    { sender: "user", content: "hi", timestamp: "2026-03-14T00:00:00.000Z" },
    { sender: "assistant", content: "there", timestamp: "2026-03-14T00:00:01.000Z" },
  ]);

  assert.equal(events.length, 2);
  assert.equal(events[0].title, "Prompt");
  assert.equal(events[1].renderMode, "markdown");
  assert.equal(events[1].timestamp, "history:2026-03-14T00:00:01.000Z");
  assert.equal(watchState.transcriptScrollOffset, 0);
  assert.equal(watchState.detailScrollOffset, 0);
  assert.equal(watchState.expandedEventId, null);
});

test("event store clears live transcript view and delegation state", () => {
  const { store, events, watchState, calls } = createHarness();

  store.pushEvent("tool", "Run bash", "pwd", "yellow");
  watchState.expandedEventId = events[0].id;
  store.clearLiveTranscriptView();

  assert.equal(events.length, 0);
  assert.equal(watchState.expandedEventId, null);
  assert.equal(watchState.transcriptScrollOffset, 0);
  assert.equal(watchState.detailScrollOffset, 0);
  assert.deepEqual(calls.slice(-2), [
    ["resetDelegationState"],
    ["setTransientStatus", "view cleared"],
  ]);
});

test("event store replaces latest tool results and clears subagent heartbeats", () => {
  const { store, events } = createHarness();

  store.pushEvent("tool", "Run bash", "pwd", "yellow", { toolName: "system.bash" });
  assert.equal(
    store.replaceLatestToolEvent("system.bash", false, "/tmp", {
      title: "Run bash",
      tone: "green",
      previewMode: "source",
    }),
    true,
  );
  store.upsertSubagentHeartbeatEvent("sub-1", "Delegated child", "working", "blue", {
    subagentSessionId: "sub-1",
  });
  assert.equal(store.clearSubagentHeartbeatEvents("sub-1"), true);

  assert.equal(events[0].kind, "tool result");
  assert.equal(events[0].previewMode, "source");
  assert.equal(events.some((event) => event.subagentHeartbeat), false);
});
