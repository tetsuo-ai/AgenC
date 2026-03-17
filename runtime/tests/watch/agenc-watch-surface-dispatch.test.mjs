import test from "node:test";
import assert from "node:assert/strict";

import { dispatchOperatorSurfaceEvent } from "../../src/watch/agenc-watch-surface-dispatch.mjs";

function createHarness(overrides = {}) {
  const calls = [];
  const state = {
    sessionId: null,
    ownerToken: null,
    sessionAttachedAtMs: null,
    runDetail: { id: "run-1" },
    runState: "working",
    runPhase: "active",
    bootstrapReady: false,
    manualSessionsRequestPending: false,
    manualHistoryRequestPending: false,
    currentObjective: "watch it",
    activeRunStartedAtMs: null,
    latestAgentSummary: null,
    latestTool: null,
    latestToolState: null,
    runInspectPending: true,
    lastUsageSummary: null,
    liveSessionModelRoute: null,
    lastStatus: null,
    configuredModelRoute: null,
    manualStatusRequestPending: false,
    lastStatusFeedFingerprint: null,
    ...overrides.state,
  };
  const api = {
    state,
    now: () => 123,
    setTransientStatus: (value) => calls.push(["status", value]),
    persistSessionId: (value) => calls.push(["persistSessionId", value]),
    persistOwnerToken: (value) => calls.push(["persistOwnerToken", value]),
    resetLiveRunSurface: () => calls.push(["resetLiveRunSurface"]),
    markBootstrapReady: (value) => calls.push(["markBootstrapReady", value]),
    clearBootstrapTimer: () => calls.push(["clearBootstrapTimer"]),
    send: (type, payload) => calls.push(["send", type, payload]),
    authPayload: (payload) => ({ auth: true, ...payload }),
    requestRunInspect: (reason, payload) => calls.push(["requestRunInspect", reason, payload ?? null]),
    eventStore: {
      pushEvent: (...args) => calls.push(["pushEvent", ...args]),
      appendAgentStreamChunk: (...args) => calls.push(["appendAgentStreamChunk", ...args]),
      commitAgentMessage: (...args) => calls.push(["commitAgentMessage", ...args]),
      cancelAgentStream: (...args) => calls.push(["cancelAgentStream", ...args]),
      restoreTranscriptFromHistory: (value) => calls.push(["restoreTranscriptFromHistory", value]),
      clearLiveTranscriptView: (...args) => calls.push(["clearLiveTranscriptView", ...args]),
      replaceLatestToolEvent: (...args) => calls.push(["replaceLatestToolEvent", ...args]),
      replaceLatestSubagentToolEvent: (...args) => calls.push(["replaceLatestSubagentToolEvent", ...args]),
      clearSubagentHeartbeatEvents: (...args) =>
        calls.push(["clearSubagentHeartbeatEvents", ...args]),
    },
    formatSessionSummaries: (value) => JSON.stringify(value),
    latestSessionSummary: (value) => value[0] ?? null,
    formatHistoryPayload: (value) => JSON.stringify(value),
    shouldAutoInspectRun: () => true,
    sanitizeInlineText: (value) => String(value ?? "").trim(),
    truncate: (value) => String(value ?? ""),
    summarizeUsage: (value) => ({ summary: value }),
    normalizeModelRoute: (value) => ({ route: value }),
    describeToolStart: (toolName, args) => ({
      title: `Run ${toolName}`,
      body: JSON.stringify(args ?? {}),
      tone: "yellow",
    }),
    descriptorEventMetadata: (descriptor, metadata) => ({
      ...metadata,
      previewMode: descriptor.previewMode,
      renderSignature: descriptor.renderSignature ?? "",
    }),
    shouldSuppressToolTranscript: () => false,
    shouldSuppressToolActivity: () => false,
    handleToolResult: (...args) => calls.push(["handleToolResult", ...args]),
    tryPrettyJson: (value) => JSON.stringify(value),
    formatLogPayload: (value) => JSON.stringify(value),
    formatStatusPayload: (value) => JSON.stringify(value),
    statusFeedFingerprint: (value) => JSON.stringify(value),
    handlePlannerTraceEvent: (...args) => {
      calls.push(["handlePlannerTraceEvent", ...args]);
      return true;
    },
    handleSubagentLifecycleMessage: (...args) => {
      calls.push(["handleSubagentLifecycleMessage", ...args]);
      return true;
    },
    hydratePlannerDagFromTraceArtifacts: (value) =>
      calls.push(["hydratePlannerDagFromTraceArtifacts", value]),
    isExpectedMissingRunInspect: (value, payload) =>
      value === "missing run" || payload?.code === "background_run_missing",
    isUnavailableBackgroundRunInspect: (payload) =>
      payload?.code === "background_run_unavailable",
    isRetryableBootstrapError: (value) => value === "bootstrap",
    scheduleBootstrap: (value) => calls.push(["scheduleBootstrap", value]),
    ...overrides.api,
  };
  return { api, state, calls };
}

test("dispatchOperatorSurfaceEvent handles session-ready events", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "session",
      type: "chat.session",
      payload: { sessionId: "session-1" },
      payloadRecord: { sessionId: "session-1" },
      payloadList: null,
      isSessionScoped: false,
      message: { error: undefined },
    },
    null,
    api,
  );

  assert.equal(state.sessionId, "session-1");
  assert.equal(state.runState, "idle");
  assert.deepEqual(calls, [
    ["persistSessionId", "session-1"],
    ["resetLiveRunSurface"],
    ["markBootstrapReady", "session ready: session-1"],
  ]);
});

test("dispatchOperatorSurfaceEvent resumes sessions by restoring history and inspecting the run", () => {
  const { api, state, calls } = createHarness({
    state: { bootstrapReady: true },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "session",
      type: "chat.resumed",
      payload: { sessionId: "session-2" },
      payloadRecord: { sessionId: "session-2" },
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.sessionId, "session-2");
  assert.equal(state.sessionAttachedAtMs, 123);
  assert.equal(state.bootstrapReady, false);
  assert.deepEqual(calls, [
    ["persistSessionId", "session-2"],
    ["clearBootstrapTimer"],
    ["resetLiveRunSurface"],
    ["status", "session resumed: session-2; restoring history"],
    ["send", "chat.history", { auth: true, limit: 50 }],
    ["requestRunInspect", "resume", { force: true }],
  ]);
});

test("dispatchOperatorSurfaceEvent restores bootstrap history before marking the session ready", () => {
  const history = [{ role: "assistant", content: "hello" }];
  const { api, calls } = createHarness({
    state: { sessionId: "session-3", bootstrapReady: false },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "session",
      type: "chat.history",
      payload: history,
      payloadRecord: {},
      payloadList: history,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["restoreTranscriptFromHistory", history],
    ["markBootstrapReady", "history restored: 1 item(s)"],
    ["requestRunInspect", "history restore", { force: true }],
  ]);
});

test("dispatchOperatorSurfaceEvent routes tool execution events", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "tool",
      type: "tools.executing",
      payload: { toolName: "system.bash", args: { command: "pwd" } },
      payloadRecord: { toolName: "system.bash", args: { command: "pwd" } },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.latestTool, "system.bash");
  assert.equal(state.latestToolState, "running");
  assert.deepEqual(calls, [
    ["status", "Run system.bash"],
    [
      "pushEvent",
      "tool",
      "Run system.bash",
      JSON.stringify({ command: "pwd" }),
      "yellow",
      {
        toolName: "system.bash",
        toolArgs: { command: "pwd" },
        previewMode: undefined,
        renderSignature: "",
      },
    ],
    ["requestRunInspect", "tool start", null],
  ]);
});

test("dispatchOperatorSurfaceEvent routes final chat messages through stream reconciliation", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.message",
      payload: { content: "done" },
      payloadRecord: { content: "done" },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.latestAgentSummary, "done");
  assert.deepEqual(calls, [
    ["status", "agent reply received"],
    ["commitAgentMessage", "done"],
    ["requestRunInspect", "agent reply", null],
  ]);
});

test("dispatchOperatorSurfaceEvent accepts content-based chat.stream payloads", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.stream",
      payload: { content: "partial", done: false },
      payloadRecord: { content: "partial", done: false },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["appendAgentStreamChunk", "partial", { done: false }],
    ["status", "streaming: partial"],
  ]);
});

test("dispatchOperatorSurfaceEvent retains delta fallback for older chat.stream payloads", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.stream",
      payload: { delta: "legacy" },
      payloadRecord: { delta: "legacy" },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["appendAgentStreamChunk", "legacy", { done: false }],
    ["status", "streaming: legacy"],
  ]);
});

test("dispatchOperatorSurfaceEvent cancels live stream state when chats are cancelled", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.cancelled",
      payload: { cancelled: true },
      payloadRecord: { cancelled: true },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["cancelAgentStream", "cancelled"],
    ["status", "chat cancelled"],
    ["pushEvent", "cancelled", "Chat Cancelled", JSON.stringify({ cancelled: true }), "amber"],
  ]);
});

test("dispatchOperatorSurfaceEvent routes planner families through the planner handler", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "planner",
      type: "planner_step_started",
      payload: { stepName: "Compile" },
      payloadRecord: { stepName: "Compile" },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["handlePlannerTraceEvent", "planner_step_started", { stepName: "Compile" }],
  ]);
});

test("dispatchOperatorSurfaceEvent routes subagent families through the subagent handler", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "subagent",
      type: "subagents.tool.executing",
      payload: {
        subagentSessionId: "subagent:child-1",
        toolName: "system.bash",
        args: { command: "pwd" },
      },
      payloadRecord: {
        subagentSessionId: "subagent:child-1",
        toolName: "system.bash",
        args: { command: "pwd" },
      },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    [
      "handleSubagentLifecycleMessage",
      "subagents.tool.executing",
      {
        subagentSessionId: "subagent:child-1",
        toolName: "system.bash",
        args: { command: "pwd" },
      },
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent updates run state from run.inspect payloads", () => {
  const payload = {
    sessionId: "session-4",
    objective: "Ship it",
    state: "running",
    currentPhase: "execute",
    createdAt: "456",
  };
  const { api, state, calls } = createHarness({
    state: { sessionId: "session-4", runInspectPending: true, activeRunStartedAtMs: null },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "run",
      type: "run.inspect",
      payload,
      payloadRecord: payload,
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.runInspectPending, false);
  assert.equal(state.runDetail, payload);
  assert.equal(state.currentObjective, "Ship it");
  assert.equal(state.runState, "running");
  assert.equal(state.runPhase, "execute");
  assert.equal(state.activeRunStartedAtMs, 456);
  assert.deepEqual(calls, [
    ["hydratePlannerDagFromTraceArtifacts", "session-4"],
    ["status", "run inspect loaded: running"],
  ]);
});

test("dispatchOperatorSurfaceEvent emits status updates when the fingerprint changes", () => {
  const payload = { provider: "openai", model: "gpt-5.4" };
  const { api, state, calls } = createHarness({
    state: {
      manualStatusRequestPending: false,
      lastStatusFeedFingerprint: null,
      configuredModelRoute: null,
    },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "status",
      type: "status.update",
      payload,
      payloadRecord: payload,
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(state.lastStatus, payload);
  assert.deepEqual(state.configuredModelRoute, { route: payload });
  assert.equal(state.lastStatusFeedFingerprint, JSON.stringify(payload));
  assert.deepEqual(calls, [
    ["status", "gateway status loaded"],
    ["pushEvent", "status", "Gateway Status", JSON.stringify(payload), "blue"],
  ]);
});

test("dispatchOperatorSurfaceEvent surfaces durable-run disabled status explicitly", () => {
  const payload = {
    state: "running",
    backgroundRuns: {
      enabled: false,
      operatorAvailable: false,
      disabledCode: "background_runs_feature_disabled",
      disabledReason: "Durable background runs are disabled in autonomy feature flags.",
    },
  };
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "status",
      type: "status.update",
      payload,
      payloadRecord: payload,
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["status", "durable runs disabled"],
    ["pushEvent", "status", "Gateway Status", JSON.stringify(payload), "blue"],
  ]);
});

test("dispatchOperatorSurfaceEvent resets run state for expected missing-run errors", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "error",
      type: "error",
      payload: { code: "E_NO_RUN" },
      payloadRecord: { code: "E_NO_RUN" },
      payloadList: null,
      isSessionScoped: false,
      message: { error: "missing run" },
    },
    null,
    api,
  );

  assert.equal(state.runDetail, null);
  assert.equal(state.runState, "idle");
  assert.equal(state.runPhase, null);
  assert.deepEqual(calls, [
    ["status", "no active background run for this session"],
  ]);
});

test("dispatchOperatorSurfaceEvent schedules bootstrap retries for transient startup errors", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "error",
      type: "error",
      payload: { code: "E_BOOTSTRAP" },
      payloadRecord: { code: "E_BOOTSTRAP" },
      payloadList: null,
      isSessionScoped: false,
      message: { error: "bootstrap" },
    },
    null,
    api,
  );

  assert.equal(state.runInspectPending, false);
  assert.equal(state.manualStatusRequestPending, false);
  assert.equal(state.manualSessionsRequestPending, false);
  assert.equal(state.manualHistoryRequestPending, false);
  assert.deepEqual(calls, [
    ["scheduleBootstrap", "webchat handler still starting"],
  ]);
});

test("dispatchOperatorSurfaceEvent records unavailable durable-run operator errors", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "error",
      type: "error",
      payload: {
        code: "background_run_unavailable",
        backgroundRunAvailability: {
          enabled: false,
          operatorAvailable: false,
          disabledReason:
            "Durable background runs are disabled in autonomy feature flags.",
        },
      },
      payloadRecord: {
        code: "background_run_unavailable",
        backgroundRunAvailability: {
          enabled: false,
          operatorAvailable: false,
          disabledReason:
            "Durable background runs are disabled in autonomy feature flags.",
        },
      },
      payloadList: null,
      isSessionScoped: false,
      message: {
        error:
          "Durable background runs are disabled in autonomy feature flags.",
      },
    },
    null,
    api,
  );

  assert.equal(state.runDetail, null);
  assert.equal(state.runState, "idle");
  assert.equal(state.runPhase, null);
  assert.deepEqual(calls, [
    [
      "status",
      "Durable background runs are disabled in autonomy feature flags.",
    ],
    [
      "pushEvent",
      "run",
      "Durable Run Unavailable",
      "Durable background runs are disabled in autonomy feature flags.",
      "amber",
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent preserves approval escalations in the transcript", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "approval",
      type: "approval.escalated",
      payload: { rule: "system.delete", reason: "dangerous action" },
      payloadRecord: { rule: "system.delete", reason: "dangerous action" },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    [
      "pushEvent",
      "approval",
      "Approval Escalated",
      JSON.stringify({ rule: "system.delete", reason: "dangerous action" }),
      "amber",
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent falls back to a raw event transcript entry for unknown families", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "unknown",
      type: "mystery.event",
      payload: { hello: "world" },
      payloadRecord: { hello: "world" },
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    { type: "mystery.event", payload: { hello: "world" } },
    api,
  );

  assert.deepEqual(calls, [
    ["pushEvent", "mystery.event", "mystery.event", JSON.stringify({ hello: "world" }), "slate"],
  ]);
});
