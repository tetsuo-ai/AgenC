import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSurfaceSummaryCacheKey,
  latestSessionSummary,
} from "./lib/agenc-watch-app.mjs";
import {
  FakeWebSocket,
  createWatchLiveReplayHarness,
} from "./fixtures/agenc-watch-live-replay-harness.mjs";

test("createWatchApp starts and disposes terminal lifecycle cleanly", async () => {
  const harness = await createWatchLiveReplayHarness();
  await harness.start();

  assert.deepEqual(harness.stdin.rawModes, [true]);
  assert.equal(harness.stdin.resumeCalls, 1);
  assert.equal(harness.stdin.listenerCount("data"), 1);
  assert.equal(harness.stdout.listenerCount("resize"), 1);
  assert.equal(FakeWebSocket.instances.length, 1);

  const exitCode = harness.dispose(3);
  const closedCode = await harness.app.closed;

  assert.equal(exitCode, 3);
  assert.equal(closedCode, 3);
  assert.deepEqual(harness.stdin.rawModes, [true, false]);
  assert.equal(harness.stdin.listenerCount("data"), 0);
  assert.equal(harness.stdout.listenerCount("resize"), 0);
});

test("createWatchApp unwinds raw mode and listeners on startup failure", async () => {
  const harness = await createWatchLiveReplayHarness({ stdoutThrows: true });

  await assert.rejects(() => harness.start(), /resize listener failed/);

  assert.deepEqual(harness.stdin.rawModes, [true, false]);
  assert.equal(harness.stdin.listenerCount("data"), 0);
  assert.equal(harness.stdout.listenerCount("resize"), 0);
  assert.equal(await harness.app.closed, 1);
});

test("buildSurfaceSummaryCacheKey invalidates richer status chrome inputs", () => {
  const base = {
    connectionState: "live",
    phaseLabel: "running",
    route: { provider: "grok", model: "grok-4", usedFallback: false },
    backgroundRunStatus: {
      enabled: true,
      operatorAvailable: true,
      activeTotal: 0,
      queuedSignalsTotal: 0,
    },
    runtimeStatus: { state: "live" },
    objective: "Ship status chrome",
    lastUsageSummary: "1.2K total",
    latestTool: "system.bash",
    latestToolState: "ok",
    queuedInputCount: 0,
    eventsLength: 3,
    lastEventId: "evt-3",
    planCount: 2,
    activeAgentCount: 1,
    activeAgentLabel: "child-a",
    activeAgentActivity: "editing runtime/src/index.ts",
    plannerStatus: "running",
    plannerNote: "waiting on validation",
    sessionId: "session:1234",
    following: true,
    detailOpen: false,
    transcriptScrollOffset: 0,
    lastActivityAt: "15:47:00",
  };

  const firstKey = buildSurfaceSummaryCacheKey(base);
  const fallbackKey = buildSurfaceSummaryCacheKey({
    ...base,
    route: { ...base.route, usedFallback: true },
  });
  const runtimeKey = buildSurfaceSummaryCacheKey({
    ...base,
    backgroundRunStatus: { ...base.backgroundRunStatus, queuedSignalsTotal: 4 },
  });
  const agentKey = buildSurfaceSummaryCacheKey({
    ...base,
    activeAgentActivity: "running acceptance probe",
  });

  assert.notEqual(firstKey, fallbackKey);
  assert.notEqual(firstKey, runtimeKey);
  assert.notEqual(firstKey, agentKey);
});

test("latestSessionSummary prefers sessions from the current workspace root", () => {
  const payload = [
    {
      sessionId: "session-other",
      workspaceRoot: "/tmp/other-project",
      messageCount: 10,
      lastActiveAt: 200,
    },
    {
      sessionId: "session-same",
      workspaceRoot: "/home/tetsuo/git/AgenC",
      messageCount: 2,
      lastActiveAt: 100,
    },
  ];

  const selected = latestSessionSummary(
    payload,
    null,
    "/home/tetsuo/git/AgenC",
  );

  assert.equal(selected?.sessionId, "session-same");
});
