import test from "node:test";
import assert from "node:assert/strict";

import { createWatchCommandController } from "../../src/watch/agenc-watch-commands.mjs";

function createCommandHarness(overrides = {}) {
  const watchState = {
    sessionId: "sess-1",
    currentObjective: null,
    runDetail: null,
    runState: "idle",
    runPhase: null,
    bootstrapAttempts: 0,
    manualSessionsRequestPending: false,
    manualHistoryRequestPending: false,
    manualStatusRequestPending: false,
    runInspectPending: false,
    transcriptScrollOffset: 7,
    transcriptFollowMode: false,
    activeRunStartedAtMs: null,
  };
  const queuedOperatorInputs = [];
  const calls = [];
  const controller = createWatchCommandController({
    watchState,
    queuedOperatorInputs,
    WATCH_COMMANDS: [
      { name: "/help", usage: "/help", description: "show help", aliases: [] },
      { name: "/clear", usage: "/clear", description: "clear console", aliases: [] },
      { name: "/export", usage: "/export", description: "export view", aliases: [] },
      { name: "/init", usage: "/init", description: "init guide", aliases: [] },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: [
          "/help",
          "/clear",
          "/export",
          "/init",
          "/status",
          "/logs",
          "/new",
        ].includes(commandToken)
          ? { name: commandToken }
          : null,
      };
    },
    authPayload(extra = {}) {
      return { auth: true, ...extra };
    },
    send(type, payload) {
      calls.push({ type: "send", frameType: type, payload });
    },
    shutdownWatch(code) {
      calls.push({ type: "shutdown", code });
    },
    dismissIntro() {
      calls.push({ type: "dismissIntro" });
    },
    clearLiveTranscriptView() {
      calls.push({ type: "clear" });
    },
    exportCurrentView(options) {
      calls.push({ type: "export", options });
    },
    resetLiveRunSurface() {
      calls.push({ type: "resetLiveRunSurface" });
    },
    resetDelegationState() {
      calls.push({ type: "resetDelegationState" });
    },
    persistSessionId(sessionId) {
      calls.push({ type: "persistSessionId", sessionId });
    },
    clearBootstrapTimer() {
      calls.push({ type: "clearBootstrapTimer" });
    },
    pushEvent(kind, title, body, tone) {
      calls.push({ type: "event", kind, title, body, tone });
    },
    setTransientStatus(status) {
      calls.push({ type: "status", status });
    },
    readWatchDaemonLogTail({ lines }) {
      calls.push({ type: "logs", lines });
      return { lines: ["a", "b"] };
    },
    formatLogPayload(payload) {
      return payload.lines.join("\n");
    },
    currentClientKey() {
      return "tmux-live-watch";
    },
    isOpen() {
      return true;
    },
    bootstrapPending() {
      return false;
    },
    ...overrides,
  });
  return { controller, watchState, queuedOperatorInputs, calls };
}

test("command controller clears and exports through explicit operator actions", () => {
  const { controller, calls, watchState } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/clear"), true);
  assert.equal(controller.dispatchOperatorInput("/export"), true);

  assert.equal(watchState.transcriptScrollOffset, 0);
  assert.equal(watchState.transcriptFollowMode, true);
  assert.ok(calls.some((entry) => entry.type === "clear"));
  assert.ok(calls.some((entry) => entry.type === "export" && entry.options?.announce === true));
});

test("command controller queues input while bootstrap is pending", () => {
  const { controller, queuedOperatorInputs, calls } = createCommandHarness({
    isOpen() {
      return false;
    },
    bootstrapPending() {
      return true;
    },
  });

  assert.equal(controller.dispatchOperatorInput("hello world"), true);
  assert.deepEqual(queuedOperatorInputs, ["hello world"]);
  assert.ok(calls.some((entry) => entry.type === "event" && entry.kind === "queued"));
});

test("command controller dispatches normal prompts onto chat.message", () => {
  const { controller, watchState, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("ship it"), true);

  assert.equal(watchState.currentObjective, "ship it");
  assert.equal(watchState.runState, "starting");
  assert.equal(watchState.runPhase, "queued");
  assert.ok(calls.some((entry) => entry.type === "send" && entry.frameType === "chat.message"));
  assert.ok(calls.some((entry) => entry.type === "event" && entry.kind === "you"));
});

test("command controller serves daemon logs locally for /logs", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/logs 5"), true);

  assert.ok(calls.some((entry) => entry.type === "logs" && entry.lines === 5));
  assert.ok(calls.some((entry) => entry.type === "event" && entry.kind === "logs"));
});

test("command controller forwards /init to the daemon chat surface", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/init --force"), true);

  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "send" &&
        entry.frameType === "chat.message" &&
        entry.payload?.content === "/init --force",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" && entry.title === "Project Guide Init",
    ),
  );
});
