import { describe, expect, it } from "vitest";
import {
  buildConcordiaCarryOverPolicy,
  buildConcordiaMemoryNamespaces,
  resolveConcordiaMemoryContinuityMode,
} from "../src/memory-namespaces.js";

describe("memory namespace resolution", () => {
  it("defaults new simulations to isolated run-scoped storage", () => {
    const resolved = buildConcordiaMemoryNamespaces({
      worldId: "market-town",
      workspaceId: "ws-1",
      simulationId: "sim-1",
      lineageId: "lineage-1",
      parentSimulationId: null,
    });

    expect(resolved.continuityMode).toBe("isolated");
    expect(resolved.namespaces.continuityScopeId).toBe("sim:sim-1");
    expect(resolved.namespaces.worldScopeId).toBe("world:market-town::sim:sim-1");
    expect(resolved.namespaces.effectiveStorageKey).toBe("world:market-town::sim:sim-1");
    expect(resolved.carryOverPolicy.identity).toBe("simulation");
    expect(resolved.carryOverPolicy.sharedMemory).toBe("shared");
  });

  it("switches to lineage continuity for resumed runs", () => {
    const resolved = buildConcordiaMemoryNamespaces({
      worldId: "market-town",
      workspaceId: "ws-1",
      simulationId: "sim-2",
      lineageId: "lineage-1",
      parentSimulationId: "sim-1",
      continuityMode: "lineage_resume",
      checkpointMetadata: {
        checkpointSimulationId: "sim-1",
        resumedFromStep: 7,
      },
    });

    expect(resolved.continuityMode).toBe("lineage_resume");
    expect(resolved.namespaces.continuityScopeId).toBe("lineage:lineage-1");
    expect(resolved.namespaces.worldScopeId).toBe("world:market-town::lineage:lineage-1");
    expect(resolved.namespaces.logStorageKey).toBe("log:market-town::sim:sim-2");
    expect(resolved.carryOverPolicy.identity).toBe("lineage");
    expect(resolved.carryOverPolicy.dailyLogs).toBe("simulation");
  });

  it("infers lineage resume mode from checkpoint metadata", () => {
    expect(
      resolveConcordiaMemoryContinuityMode({
        worldId: "market-town",
        workspaceId: "ws-1",
        simulationId: "sim-2",
        checkpointMetadata: { checkpointSimulationId: "sim-1" },
      }),
    ).toBe("lineage_resume");
  });

  it("encodes the intended carry-over matrix", () => {
    const isolated = buildConcordiaCarryOverPolicy("isolated");
    const resumed = buildConcordiaCarryOverPolicy("lineage_resume");

    expect(isolated.vectorStore).toBe("simulation");
    expect(isolated.dailyLogs).toBe("simulation");
    expect(resumed.vectorStore).toBe("lineage");
    expect(resumed.lifecycle).toBe("lineage");
    expect(resumed.sharedMemory).toBe("shared");
  });
});
