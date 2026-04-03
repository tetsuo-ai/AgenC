import { describe, expect, it } from "vitest";
import { SimulationRegistry } from "../src/simulation-registry.js";

function buildHandleRequest(
  simulationId: string,
  worldId: string,
  workspaceId: string,
) {
  return {
    world_id: worldId,
    workspace_id: workspaceId,
    simulation_id: simulationId,
    lineage_id: null,
    parent_simulation_id: null,
    premise: `${simulationId}-premise`,
    agents: [],
  };
}

describe("SimulationRegistry", () => {
  it("stores multiple handles without overwriting prior simulations", async () => {
    const registry = new SimulationRegistry();

    await registry.createHandle({
      request: buildHandleRequest("sim-a", "world-a", "ws-a"),
      status: "running",
      currentAlias: false,
    });
    await registry.createHandle({
      request: {
        ...buildHandleRequest("sim-b", "world-b", "ws-b"),
        lineage_id: "lineage-b",
        parent_simulation_id: "sim-old",
      },
      status: "paused",
      currentAlias: true,
    });

    const summaries = registry.listSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.map((summary) => summary.simulation_id)).toEqual(
      expect.arrayContaining(["sim-a", "sim-b"]),
    );
    expect(registry.getCurrentAlias()).toBe("sim-b");
  });

  it("indexes pending responses by simulation and request id", async () => {
    const registry = new SimulationRegistry<unknown, unknown, { sessionId: string }>();
    registry.createHandle({
      request: buildHandleRequest("sim-a", "world-a", "ws-a"),
      status: "running",
      currentAlias: false,
    });
    registry.createHandle({
      request: buildHandleRequest("sim-b", "world-b", "ws-b"),
      status: "running",
      currentAlias: false,
    });

    registry.registerPendingResponse("sim-a", "req-a", { sessionId: "session-a" });
    registry.registerPendingResponse("sim-b", "req-b", { sessionId: "session-b" });

    expect(registry.getPendingByRequestId("req-a")?.handle.simulationId).toBe("sim-a");
    expect(registry.getPendingByRequestId("req-b")?.handle.simulationId).toBe("sim-b");
    expect(
      registry.findPendingBySession("sim-b", "session-b", (pending) => pending.sessionId),
    ).toHaveLength(1);
    expect(
      registry.findPendingBySession("sim-a", "session-b", (pending) => pending.sessionId),
    ).toHaveLength(0);
  });

  it("stores replay events per simulation and filters by cursor", () => {
    const registry = new SimulationRegistry();
    registry.createHandle({
      request: buildHandleRequest("sim-replay", "world-r", "ws-r"),
      status: "running",
      currentAlias: false,
    });

    registry.appendReplayEvent("sim-replay", {
      type: "observation",
      step: 1,
      simulation_id: "sim-replay",
      world_id: "world-r",
      workspace_id: "ws-r",
      content: "Alice sees the square.",
    });
    registry.appendReplayEvent("sim-replay", {
      type: "resolution",
      step: 2,
      simulation_id: "sim-replay",
      world_id: "world-r",
      workspace_id: "ws-r",
      content: "Alice secures the deal.",
    });

    expect(registry.listReplayEvents("sim-replay")).toHaveLength(2);
    const replayAfterFirst = registry.listReplayEvents("sim-replay", "1");
    expect(replayAfterFirst).toHaveLength(1);
    expect(replayAfterFirst[0]?.event_id).toBe("2");
    expect(registry.getRecord("sim-replay")?.replay_event_count).toBe(2);
  });

  it("surfaces checkpoint status in summaries and records", () => {
    const registry = new SimulationRegistry();
    registry.createHandle({
      request: buildHandleRequest("sim-checkpoint", "world-c", "ws-c"),
      status: "paused",
      currentAlias: false,
    });

    registry.setCheckpoint("sim-checkpoint", {
      checkpoint_id: "sim-checkpoint:step:5",
      checkpoint_path: "/tmp/checkpoints/sim-checkpoint_step_5.json",
      schema_version: 3,
      world_id: "world-c",
      workspace_id: "ws-c",
      simulation_id: "sim-checkpoint",
      lineage_id: null,
      parent_simulation_id: null,
      step: 5,
      timestamp: 123,
      max_steps: 12,
      scene_cursor: null,
      runtime_cursor: {
        current_step: 5,
        start_step: 6,
        max_steps: 12,
      },
      replay_cursor: {
        replay_cursor: 9,
        replay_event_count: 9,
      },
      world_state_refs: {
        source: "inline_checkpoint",
        entity_state_keys: [],
      },
      subsystem_state: {
        resumed: ["gm_state"],
        reset: ["control_port"],
      },
    });

    expect(registry.listSummaries()[0]?.checkpoint?.checkpoint_id).toBe("sim-checkpoint:step:5");
    expect(registry.getRecord("sim-checkpoint")?.checkpoint?.runtime_cursor.current_step).toBe(5);
  });

  it("hydrates replay history before live append on an opened stream", () => {
    const registry = new SimulationRegistry();
    registry.createHandle({
      request: buildHandleRequest("sim-stream", "world-s", "ws-s"),
      status: "running",
      currentAlias: false,
    });

    registry.appendReplayEvent("sim-stream", {
      type: "step",
      step: 1,
      simulation_id: "sim-stream",
      world_id: "world-s",
      workspace_id: "ws-s",
      content: "step one",
    });

    const live: string[] = [];
    const stream = registry.openReplayStream("sim-stream", null, (event) => {
      live.push(event.event_id);
    });

    expect(stream?.history).toHaveLength(1);
    registry.appendReplayEvent("sim-stream", {
      type: "step",
      step: 2,
      simulation_id: "sim-stream",
      world_id: "world-s",
      workspace_id: "ws-s",
      content: "step two",
    });

    expect(live).toEqual(["2"]);
    stream?.unsubscribe();
  });

  it("tracks operational counts and configured thread budgets", () => {
    const registry = new SimulationRegistry<unknown, unknown, { sessionId: string }>();
    registry.createHandle({
      request: {
        ...buildHandleRequest("sim-run", "world-run", "ws-run"),
        run_budget: { simultaneous_max_workers: 3 },
      },
      status: "running",
      currentAlias: false,
    });
    registry.createHandle({
      request: {
        ...buildHandleRequest("sim-pause", "world-pause", "ws-pause"),
        run_budget: { simultaneous_max_workers: 2 },
      },
      status: "paused",
      currentAlias: false,
    });
    registry.createHandle({
      request: buildHandleRequest("sim-failed", "world-failed", "ws-failed"),
      status: "failed",
      currentAlias: false,
    });
    registry.registerPendingResponse("sim-run", "req-1", { sessionId: "session-1" });
    registry.registerPendingResponse("sim-pause", "req-2", { sessionId: "session-2" });

    expect(registry.countActiveHandles()).toBe(2);
    expect(registry.countHistoricalHandles()).toBe(1);
    expect(registry.getPendingResponseCount()).toBe(2);
    expect(registry.getConfiguredThreadBudgetCount()).toBe(5);
  });

  it("prunes aged historical simulations and trims archived replay history", () => {
    const registry = new SimulationRegistry(undefined, {
      replayBufferLimit: 10,
      archivedReplayEventLimit: 2,
    });
    registry.createHandle({
      request: buildHandleRequest("sim-keep", "world-keep", "ws-keep"),
      status: "finished",
      currentAlias: false,
    });
    registry.createHandle({
      request: buildHandleRequest("sim-drop", "world-drop", "ws-drop"),
      status: "failed",
      currentAlias: false,
    });

    registry.updateLifecycle("sim-keep", { endedAt: 4_500 });
    registry.updateLifecycle("sim-drop", { endedAt: 1_000 });
    registry.appendReplayEvent("sim-keep", {
      type: "step",
      step: 1,
      simulation_id: "sim-keep",
      world_id: "world-keep",
      workspace_id: "ws-keep",
      content: "step one",
    });
    registry.appendReplayEvent("sim-keep", {
      type: "step",
      step: 2,
      simulation_id: "sim-keep",
      world_id: "world-keep",
      workspace_id: "ws-keep",
      content: "step two",
    });
    registry.appendReplayEvent("sim-keep", {
      type: "step",
      step: 3,
      simulation_id: "sim-keep",
      world_id: "world-keep",
      workspace_id: "ws-keep",
      content: "step three",
    });

    const pruned = registry.pruneHistoricalHandles({
      maxHistoricalSimulations: 1,
      archivedSimulationRetentionMs: 2_000,
      archivedReplayEventLimit: 2,
      now: 5_000,
    });

    expect(pruned.removedSimulationIds).toEqual(["sim-drop"]);
    expect(pruned.removedSessions).toEqual([
      { simulationId: "sim-drop", workspaceId: "ws-drop" },
    ]);
    expect(pruned.trimmedReplayEvents).toBe(1);
    expect(registry.get("sim-drop")).toBeUndefined();
    expect(registry.listReplayEvents("sim-keep")).toHaveLength(2);
  });

  it("reserves distinct internal ports for concurrent simulations", async () => {
    const registry = new SimulationRegistry();
    const first = await registry.reservePorts({});
    const second = await registry.reservePorts({});

    expect(new Set([
      first.controlPort,
      first.eventPort,
      second.controlPort,
      second.eventPort,
    ]).size).toBe(4);
    expect(registry.getReservedPortCount()).toBe(4);

    const handle = registry.createHandle({
      request: {
        ...buildHandleRequest("sim-ports", "world-ports", "ws-ports"),
        control_port: first.controlPort,
        event_port: first.eventPort,
      },
      status: "running",
      currentAlias: false,
      controlPort: first.controlPort,
      eventPort: first.eventPort,
    });
    registry.releasePorts(handle);
    expect(registry.getReservedPortCount()).toBe(2);
  });


});
