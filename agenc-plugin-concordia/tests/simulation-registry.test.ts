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
});
