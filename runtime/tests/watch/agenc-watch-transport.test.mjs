import test from "node:test";
import assert from "node:assert/strict";

import { createWatchTransportController } from "../../src/watch/agenc-watch-transport.mjs";

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  send(frame) {
    this.sent.push(frame);
  }

  close() {
    this.closed = true;
  }

  emit(type, payload = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(payload);
    }
  }
}

function parseSentFrames(socket) {
  return socket.sent.map((frame) => JSON.parse(frame));
}

function createTransportHarness(overrides = {}) {
  const transportState = {
    isOpen: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    bootstrapTimer: null,
    statusPollTimer: null,
    activityPulseTimer: null,
    ws: null,
    connectionState: "connecting",
  };
  const watchState = {
    bootstrapReady: false,
    bootstrapAttempts: 0,
    sessionId: "sess-1",
    manualSessionsRequestPending: false,
    manualHistoryRequestPending: false,
  };
  const pendingFrames = [];
  const calls = [];
  const sockets = [];
  let frameCounter = 0;

  const controller = createWatchTransportController({
    transportState,
    watchState,
    pendingFrames,
    liveEventFilters: ["subagents.*"],
    connectedStatusText: "connected to ws://test",
    reconnectMinDelayMs: overrides.reconnectMinDelayMs ?? 2,
    reconnectMaxDelayMs: overrides.reconnectMaxDelayMs ?? 2,
    statusPollIntervalMs: overrides.statusPollIntervalMs ?? 50,
    activityPulseIntervalMs: overrides.activityPulseIntervalMs ?? 50,
    createSocket() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    nextFrameId(type) {
      frameCounter += 1;
      return `${type}-${frameCounter}`;
    },
    normalizeOperatorMessage(message) {
      return overrides.normalizeOperatorMessage
        ? overrides.normalizeOperatorMessage(message)
        : message;
    },
    projectOperatorSurfaceEvent(message) {
      return overrides.projectOperatorSurfaceEvent
        ? overrides.projectOperatorSurfaceEvent(message)
        : { type: "surface", payload: message };
    },
    shouldIgnoreOperatorMessage(message, sessionId) {
      return overrides.shouldIgnoreOperatorMessage
        ? overrides.shouldIgnoreOperatorMessage(message, sessionId)
        : false;
    },
    dispatchOperatorSurfaceEvent(surfaceEvent, rawMessage) {
      calls.push({ type: "dispatch", surfaceEvent, rawMessage });
    },
    scheduleRender() {
      calls.push({ type: "render" });
    },
    setTransientStatus(status) {
      calls.push({ type: "status", status });
    },
    pushEvent(kind, title, body, tone) {
      calls.push({ type: "event", kind, title, body, tone });
    },
    authPayload() {
      return { ownerToken: "owner-1" };
    },
    hasActiveSurfaceRun() {
      return false;
    },
    shuttingDown() {
      return overrides.shuttingDown ? overrides.shuttingDown() : false;
    },
    flushQueuedOperatorInputs() {
      calls.push({ type: "flushQueuedInputs" });
    },
  });

  return {
    controller,
    transportState,
    watchState,
    pendingFrames,
    calls,
    sockets,
  };
}

test("transport controller queues frames until open and flushes them on connect", () => {
  const harness = createTransportHarness();

  harness.controller.send("chat.message", { text: "hello" });
  assert.equal(harness.pendingFrames.length, 1);

  harness.controller.connect();
  assert.equal(harness.sockets.length, 1);

  const socket = harness.sockets[0];
  socket.emit("open");

  const sentFrames = parseSentFrames(socket);
  assert.equal(harness.transportState.isOpen, true);
  assert.equal(harness.transportState.connectionState, "live");
  assert.equal(harness.pendingFrames.length, 0);
  assert.deepEqual(
    sentFrames.map((frame) => frame.type),
    ["chat.message", "events.subscribe", "status.get", "chat.sessions"],
  );
  assert.ok(
    harness.calls.some((entry) => entry.type === "status" && entry.status === "connected to ws://test"),
  );

  harness.controller.dispose();
});

test("transport controller dispatches parsed messages and reports invalid frames", () => {
  const harness = createTransportHarness();
  harness.controller.connect();
  const socket = harness.sockets[0];
  socket.emit("open");

  socket.emit("message", { data: JSON.stringify({ type: "chat.message", payload: { text: "ok" } }) });
  socket.emit("message", { data: "{bad json" });

  assert.ok(harness.calls.some((entry) => entry.type === "dispatch"));
  assert.ok(harness.calls.some((entry) => entry.type === "render"));
  assert.ok(
    harness.calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "raw" &&
        entry.title === "Unparsed Event",
    ),
  );

  harness.controller.dispose();
});

test("transport controller reconnects after socket close and marks bootstrap ready", async () => {
  const harness = createTransportHarness();
  harness.controller.connect();
  const socket = harness.sockets[0];
  socket.emit("open");
  socket.emit("close");

  assert.equal(harness.transportState.isOpen, false);
  assert.equal(harness.transportState.connectionState, "reconnecting");
  assert.ok(
    harness.calls.some(
      (entry) =>
        entry.type === "status" &&
        entry.status === "websocket disconnected, retrying in 2ms",
    ),
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(harness.sockets.length, 2);

  harness.watchState.bootstrapAttempts = 3;
  harness.controller.markBootstrapReady("session ready");
  assert.equal(harness.watchState.bootstrapReady, true);
  assert.equal(harness.watchState.bootstrapAttempts, 0);
  assert.ok(harness.calls.some((entry) => entry.type === "flushQueuedInputs"));

  harness.controller.dispose();
});
