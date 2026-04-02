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
});
