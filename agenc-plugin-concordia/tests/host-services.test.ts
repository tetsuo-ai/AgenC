import { describe, expect, it, vi } from "vitest";
import { resolveConcordiaMemoryContext } from "../src/host-services.js";

describe("resolveConcordiaMemoryContext", () => {
  it("passes simulation-aware storage and namespace information to the runtime resolver", async () => {
    const resolveWorldContext = vi.fn().mockResolvedValue({
      memoryBackend: { addEntry: vi.fn(), getThread: vi.fn(), set: vi.fn(), get: vi.fn() },
      identityManager: { load: vi.fn(), upsert: vi.fn(), formatForPrompt: vi.fn() },
      socialMemory: {
        recordInteraction: vi.fn(),
        getRelationship: vi.fn(),
        listKnownAgents: vi.fn(),
        addWorldFact: vi.fn(),
        confirmWorldFact: vi.fn(),
        getWorldFacts: vi.fn(),
        checkCollectiveEmergence: vi.fn(),
      },
    });

    const context = {
      config: { encryption_key: "secret" },
      logger: { debug: vi.fn() },
      host_services: {
        concordia_memory: {
          resolveWorldContext,
        },
      },
    } as never;

    const memoryCtx = await resolveConcordiaMemoryContext(
      context,
      "market-town",
      "workspace-1",
      {
        simulationId: "sim-2",
        lineageId: "lineage-1",
        parentSimulationId: "sim-1",
      },
      {
        continuityMode: "lineage_resume",
        checkpointMetadata: {
          checkpointSimulationId: "sim-1",
          resumedFromStep: 7,
        },
      },
    );

    expect(resolveWorldContext).toHaveBeenCalledWith({
      worldId: "market-town",
      workspaceId: "workspace-1",
      simulationId: "sim-2",
      lineageId: "lineage-1",
      parentSimulationId: "sim-1",
      effectiveStorageKey: "world:market-town::lineage:lineage-1",
      logStorageKey: "log:market-town::sim:sim-2",
      scopedWorkspaceId: "workspace-1::lineage:lineage-1",
      continuityMode: "lineage_resume",
      checkpointMetadata: {
        checkpointSimulationId: "sim-1",
        resumedFromStep: 7,
      },
    });
    expect(memoryCtx?.effectiveStorageKey).toBe("world:market-town::lineage:lineage-1");
    expect(memoryCtx?.namespaces.worldScopeId).toBe("world:market-town::lineage:lineage-1");
    expect(memoryCtx?.namespaces.logStorageKey).toBe("log:market-town::sim:sim-2");
    expect(memoryCtx?.carryOverPolicy.identity).toBe("lineage");
  });
});
