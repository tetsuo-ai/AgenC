import { describe, expect, it, vi } from "vitest";
import { resolveConcordiaMemoryContext } from "../src/host-services.js";

describe("resolveConcordiaMemoryContext", () => {
  it("builds a memory wiring context from host_services", async () => {
    const memoryBackend = {
      addEntry: vi.fn(),
      getThread: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
    };
    const identityManager = {
      load: vi.fn(),
      upsert: vi.fn(),
      formatForPrompt: vi.fn(),
    };
    const socialMemory = {
      recordInteraction: vi.fn(),
      getRelationship: vi.fn(),
      listKnownAgents: vi.fn(),
      getWorldFacts: vi.fn(),
      addWorldFact: vi.fn(),
      checkCollectiveEmergence: vi.fn(),
    };
    const proceduralMemory = {
      record: vi.fn(),
      retrieve: vi.fn(),
      formatForPrompt: vi.fn(),
    };

    const context = {
      logger: {
        debug: vi.fn(),
      },
      config: {
        encryption_key: "secret",
      },
      on_message: vi.fn(),
      host_services: {
        concordia_memory: {
          memoryBackend,
          identityManager,
          socialMemory,
          proceduralMemory,
        },
      },
    };

    const resolved = await resolveConcordiaMemoryContext(
      context,
      "world-1",
      "workspace-1",
    );

    expect(resolved).toMatchObject({
      worldId: "world-1",
      workspaceId: "workspace-1",
      memoryBackend,
      identityManager,
      socialMemory,
      proceduralMemory,
      encryptionKey: "secret",
    });
  });

  it("resolves through the world-context host service when available", async () => {
    const resolvedWorld = {
      memoryBackend: {
        addEntry: vi.fn(),
        getThread: vi.fn(),
        set: vi.fn(),
        get: vi.fn(),
      },
      identityManager: {
        load: vi.fn(),
        upsert: vi.fn(),
        formatForPrompt: vi.fn(),
      },
      socialMemory: {
        recordInteraction: vi.fn(),
        getRelationship: vi.fn(),
        listKnownAgents: vi.fn(),
        getWorldFacts: vi.fn(),
        addWorldFact: vi.fn(),
        checkCollectiveEmergence: vi.fn(),
      },
      retriever: {
        retrieve: vi.fn(),
      },
    };
    const resolveWorldContext = vi.fn().mockResolvedValue(resolvedWorld);
    const context = {
      logger: {
        debug: vi.fn(),
      },
      config: {
        encryption_key: "secret",
      },
      on_message: vi.fn(),
      host_services: {
        concordia_memory: {
          resolveWorldContext,
        },
      },
    };

    const resolved = await resolveConcordiaMemoryContext(
      context,
      "world-1",
      "workspace-1",
    );

    expect(resolveWorldContext).toHaveBeenCalledWith({
      worldId: "world-1",
      workspaceId: "workspace-1",
    });
    expect(resolved?.retriever).toBe(resolvedWorld.retriever);
  });

  it("returns null when host_services does not include concordia memory", async () => {
    const context = {
      logger: {
        debug: vi.fn(),
      },
      config: {},
      on_message: vi.fn(),
      host_services: {},
    };

    expect(
      await resolveConcordiaMemoryContext(context, "world-1", "workspace-1"),
    ).toBeNull();
  });
});
