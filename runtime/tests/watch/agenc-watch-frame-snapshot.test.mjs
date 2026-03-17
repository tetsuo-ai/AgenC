import test from "node:test";
import assert from "node:assert/strict";

import {
  createDisplayLine,
  createWatchFrameHarness,
} from "./fixtures/agenc-watch-frame-harness.mjs";
import { FRAME_SNAPSHOT_EXPECTATIONS } from "./fixtures/agenc-watch-frame-snapshot.fixture.mjs";
import {
  assertFrameExpectation,
  normalizeSnapshotFrame,
} from "./fixtures/agenc-watch-snapshot-assertions.mjs";
import {
  buildDetailPaneSummary,
  buildTranscriptEventSummary,
  buildWatchFooterSummary,
  buildWatchLayout,
  buildWatchSidebarPolicy,
} from "../../src/watch/agenc-watch-surface-summary.mjs";

function snapshotDeps() {
  return {
    buildDetailPaneSummary,
    buildTranscriptEventSummary,
    buildWatchFooterSummary,
    buildWatchLayout,
    buildWatchSidebarPolicy,
  };
}

test("frame snapshot keeps wide planner and sidebar chrome stable", () => {
  const subagentPlanSteps = new Map([
    ["a", {
      key: "a",
      order: 1,
      stepName: "Inspect runtime",
      objective: "Inspect runtime",
      status: "running",
      note: "running acceptance probe",
      subagentSessionId: "session:sub1",
      updatedAt: 10,
    }],
    ["b", {
      key: "b",
      order: 2,
      stepName: "Patch frame",
      objective: "Patch frame",
      status: "failed",
      note: "probe failed",
      subagentSessionId: "session:sub2",
      updatedAt: 9,
    }],
  ]);
  const subagentLiveActivity = new Map([["session:sub1", "running acceptance probe"]]);
  const plannerDagNodes = new Map([
    ["plan", { key: "plan", order: 1, stepName: "Plan", objective: "Plan", status: "completed", stepType: "synthesis", note: "planned" }],
    ["inspect", { key: "inspect", order: 2, stepName: "Inspect runtime", objective: "Inspect runtime", status: "running", stepType: "subagent_task", note: "running acceptance probe" }],
    ["patch", { key: "patch", order: 3, stepName: "Patch frame", objective: "Patch frame", status: "failed", stepType: "deterministic_tool", note: "probe failed" }],
  ]);
  const plannerDagEdges = [{ from: "plan", to: "inspect" }, { from: "inspect", to: "patch" }];
  const harness = createWatchFrameHarness({
    width: 120,
    height: 24,
    activeRun: true,
    objective: "Ship operator console polish",
    surfaceSummary: {
      overview: {
        connectionState: "live",
        sessionToken: "12345678",
        phaseLabel: "delegating",
        queuedInputCount: 1,
        latestTool: "system.writeFile",
        latestToolState: "running",
        usage: "3.4K total",
        lastActivityAt: "15:47:00",
        activeAgentCount: 2,
        planCount: 4,
        transcriptMode: "follow",
        fallbackState: "active",
        runtimeState: "degraded",
        runtimeLabel: "live · durable operator unavailable",
        activeLine: "child probe failed · retrying validation",
        durableActiveTotal: 1,
        durableQueuedSignalsTotal: 2,
        durableRunsState: "offline",
      },
      chips: [
        { label: "RUN", value: "delegating", tone: "cyan" },
        { label: "ROUTE", value: "fallback", tone: "amber" },
        { label: "PROVIDER", value: "grok", tone: "teal" },
        { label: "MODEL", value: "grok-4", tone: "teal" },
        { label: "FAILOVER", value: "active", tone: "amber" },
        { label: "RUNTIME", value: "degraded", tone: "red" },
        { label: "DURABLE", value: "offline", tone: "red" },
        { label: "MODE", value: "follow", tone: "green" },
      ],
      routeLabel: "grok-4 via grok",
      providerLabel: "grok",
      objective: "Ship operator console polish",
      routeState: "fallback",
      routeTone: "amber",
      recentTools: [
        { timestamp: "15:46:59", title: "Edited runtime/src/index.ts", meta: "system.writeFile", tone: "teal" },
        { timestamp: "15:46:58", title: "Read runtime/src/index.ts", meta: "system.readFile", tone: "slate" },
      ],
      attention: {
        approvalAlertCount: 0,
        errorAlertCount: 2,
        queuedInputCount: 1,
        items: [{ timestamp: "15:46:57", title: "Probe failed", tone: "red" }],
      },
    },
    events: [
      { id: "evt-1", kind: "agent", title: "Agent Reply", body: "Working through the planner graph.", timestamp: "15:47:00" },
      { id: "evt-2", kind: "tool result", title: "Edited runtime/src/index.ts", body: "done", timestamp: "15:47:01" },
    ],
    dependencies: {
      ...snapshotDeps(),
      subagentPlanSteps,
      subagentLiveActivity,
      plannerDagNodes,
      plannerDagEdges,
    },
    watchState: {
      plannerDagStatus: "running",
      plannerDagUpdatedAt: 1000,
    },
  });

  assertFrameExpectation(
    normalizeSnapshotFrame(harness.controller.buildVisibleFrameSnapshot().lines.join("\n")),
    FRAME_SNAPSHOT_EXPECTATIONS.widePlanner,
  );
});

test("frame snapshot keeps diff detail navigation stable", () => {
  const harness = createWatchFrameHarness({
    width: 100,
    height: 22,
    watchState: {
      expandedEventId: "evt-diff",
      detailScrollOffset: 0,
    },
    events: [
      {
        id: "evt-diff",
        kind: "tool result",
        title: "Edited runtime/src/index.ts",
        body: "patch",
        timestamp: "15:48:00",
        filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts",
      },
    ],
    surfaceSummary: {
      overview: {
        connectionState: "live",
        sessionToken: "12345678",
        phaseLabel: "running",
        queuedInputCount: 0,
        latestTool: "system.writeFile",
        latestToolState: "ok",
        usage: "1.2K total",
        lastActivityAt: "15:48:00",
        activeAgentCount: 0,
        planCount: 0,
        transcriptMode: "detail",
        fallbackState: "standby",
        runtimeState: "healthy",
        runtimeLabel: "live · durable ready",
        activeLine: "Edited runtime/src/index.ts",
        durableActiveTotal: 0,
        durableQueuedSignalsTotal: 0,
        durableRunsState: "ready",
      },
      chips: [{ label: "RUN", value: "running", tone: "cyan" }],
      routeLabel: "grok-4 via grok",
      providerLabel: "grok",
      objective: "Patch runtime/src/index.ts",
      routeState: "primary",
      routeTone: "teal",
      recentTools: [],
      attention: { approvalAlertCount: 0, errorAlertCount: 0, queuedInputCount: 0, items: [] },
    },
    wrapEventDisplayLines() {
      return [
        createDisplayLine("replace · runtime/src/index.ts", "diff-header", { filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts" }),
        createDisplayLine("@@ replace @@", "diff-hunk", { filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts", diffHunkIndex: 0 }),
        createDisplayLine("--- before", "diff-section-remove", { filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts" }),
        createDisplayLine("- const oldValue = 1;", "diff-remove"),
        createDisplayLine("+++ after", "diff-section-add", { filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts" }),
        createDisplayLine("+ const newValue = 2;", "diff-add"),
        createDisplayLine("@@ lines 8-12 @@", "diff-hunk", { filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts", diffHunkIndex: 1 }),
        createDisplayLine("--- before", "diff-section-remove", { filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts" }),
        createDisplayLine("- return oldValue;", "diff-remove"),
        createDisplayLine("+++ after", "diff-section-add", { filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts" }),
        createDisplayLine("+ return newValue;", "diff-add"),
      ];
    },
    dependencies: {
      ...snapshotDeps(),
      isDiffRenderableEvent: () => true,
    },
  });

  const snapshot = normalizeSnapshotFrame(harness.controller.buildVisibleFrameSnapshot().lines.join("\n"));
  assertFrameExpectation(snapshot, FRAME_SNAPSHOT_EXPECTATIONS.diffDetail);
});

test("frame snapshot keeps narrow reconnect view stable", () => {
  const harness = createWatchFrameHarness({
    width: 90,
    height: 18,
    surfaceSummary: {
      overview: {
        connectionState: "reconnecting",
        sessionToken: "12345678",
        phaseLabel: "idle",
        queuedInputCount: 0,
        latestTool: "idle",
        latestToolState: "idle",
        usage: "n/a",
        lastActivityAt: "15:49:00",
        activeAgentCount: 0,
        planCount: 0,
        transcriptMode: "follow",
        fallbackState: "pending",
        runtimeState: "reconnecting",
        runtimeLabel: "reconnecting · durable pending",
        activeLine: "Awaiting operator prompt",
        durableActiveTotal: 0,
        durableQueuedSignalsTotal: 0,
        durableRunsState: "pending",
      },
      chips: [
        { label: "RUN", value: "idle", tone: "magenta" },
        { label: "RUNTIME", value: "reconnecting", tone: "amber" },
      ],
      routeLabel: "routing pending",
      providerLabel: "pending",
      objective: "No active objective",
      routeState: "pending",
      routeTone: "slate",
      recentTools: [],
      attention: { approvalAlertCount: 0, errorAlertCount: 0, queuedInputCount: 0, items: [] },
    },
    events: [
      {
        id: "evt-1",
        kind: "agent",
        title: "Agent Reply",
        body: "Reconnecting to the daemon.",
        timestamp: "15:49:00",
      },
    ],
    dependencies: snapshotDeps(),
  });

  const snapshot = normalizeSnapshotFrame(harness.controller.buildVisibleFrameSnapshot().lines.join("\n"));
  assertFrameExpectation(snapshot, FRAME_SNAPSHOT_EXPECTATIONS.narrowReconnect);
});
