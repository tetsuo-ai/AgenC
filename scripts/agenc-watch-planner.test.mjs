import test from "node:test";
import assert from "node:assert/strict";

import { createWatchPlannerController } from "./lib/agenc-watch-planner.mjs";

function createPlannerHarness() {
  const watchState = {
    sessionId: "sess-1",
    plannerDagPipelineId: null,
    plannerDagNote: null,
    plannerDagStatus: "idle",
    plannerDagUpdatedAt: 0,
    runPhase: "executing",
    runState: "running",
    activeRunStartedAtMs: 123,
  };
  const calls = [];
  const controller = createWatchPlannerController({
    watchState,
    plannerDagNodeCount: () => 2,
    sessionValuesMatch: (left, right) => left === right,
    hydratePlannerDagForLiveSession(input) {
      calls.push({ type: "hydrate", input });
    },
    ingestPlannerDag(payload) {
      calls.push({ type: "ingest", payload });
    },
    updatePlannerDagNode(input) {
      calls.push({ type: "update", input });
    },
    retirePlannerDagOpenNodes(status, note) {
      calls.push({ type: "retire", status, note });
    },
    sanitizeInlineText(value) {
      return String(value ?? "").trim();
    },
    describeToolStart(toolName) {
      return { title: `${toolName} started` };
    },
    describeToolResult(toolName, args, isError, result) {
      return { title: `${toolName} ${isError ? "failed" : "done"} ${String(result ?? "").trim()}`.trim() };
    },
  });
  return { controller, watchState, calls };
}

test("planner controller ignores mismatched session events", () => {
  const { controller, calls } = createPlannerHarness();

  const handled = controller.handlePlannerTraceEvent("planner_step_started", {
    sessionId: "other-session",
    stepName: "collect",
    tool: "system.bash",
  });

  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

test("planner controller updates nodes for started and finished steps", () => {
  const { controller, calls, watchState } = createPlannerHarness();

  assert.equal(
    controller.handlePlannerTraceEvent("planner_step_started", {
      sessionId: "sess-1",
      pipelineId: "pipe-1",
      stepName: "collect",
      tool: "system.bash",
      args: { command: "pwd" },
    }),
    true,
  );
  assert.equal(
    controller.handlePlannerTraceEvent("planner_step_finished", {
      sessionId: "sess-1",
      pipelineId: "pipe-1",
      stepName: "collect",
      tool: "system.bash",
      result: "ok",
    }),
    true,
  );

  assert.equal(watchState.plannerDagPipelineId, "pipe-1");
  assert.ok(
    calls.some((entry) => entry.type === "update" && entry.input.status === "running"),
  );
  assert.ok(
    calls.some((entry) => entry.type === "update" && entry.input.status === "completed"),
  );
});

test("planner controller closes the run on terminal planner completion", () => {
  const { controller, calls, watchState } = createPlannerHarness();

  controller.handlePlannerTraceEvent("planner_path_finished", {
    sessionId: "sess-1",
    stopReason: "completed",
    stopReasonDetail: "all done",
  });

  assert.equal(watchState.plannerDagStatus, "completed");
  assert.equal(watchState.runPhase, null);
  assert.equal(watchState.runState, "idle");
  assert.equal(watchState.activeRunStartedAtMs, null);
  assert.ok(
    calls.some((entry) => entry.type === "retire" && entry.status === "cancelled"),
  );
});
