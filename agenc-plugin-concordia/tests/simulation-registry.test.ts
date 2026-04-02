import { describe, expect, it } from "vitest";
import { SimulationRegistry } from "../src/simulation-registry.js";

describe("SimulationRegistry", () => {
  it("stores multiple handles without overwriting prior simulations", async () => {
    const registry = new SimulationRegistry();

    await registry.createHandle({
      request: {
        world_id: "world-a",
        workspace_id: "ws-a",
        simulation_id: "sim-a",
        lineage_id: null,
        parent_simulation_id: null,
        premise: "premise-a",
        agents: [],
      },
      status: "running",
      currentAlias: false,
    });
    await registry.createHandle({
      request: {
        world_id: "world-b",
        workspace_id: "ws-b",
        simulation_id: "sim-b",
        lineage_id: "lineage-b",
        parent_simulation_id: "sim-old",
        premise: "premise-b",
        agents: [],
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
      request: {
        world_id: "world-a",
        workspace_id: "ws-a",
        simulation_id: "sim-a",
        lineage_id: null,
        parent_simulation_id: null,
        premise: "premise-a",
        agents: [],
      },
      status: "running",
      currentAlias: false,
    });
    registry.createHandle({
      request: {
        world_id: "world-b",
        workspace_id: "ws-b",
        simulation_id: "sim-b",
        lineage_id: null,
        parent_simulation_id: null,
        premise: "premise-b",
        agents: [],
      },
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
