import { describe, expect, it, vi } from "vitest";
import { resolveConcordiaMemoryContext } from "../src/host-services.js";

describe("resolveConcordiaMemoryContext", () => {
  it("builds a memory wiring context from host_services", () => {
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

    const resolved = resolveConcordiaMemoryContext(
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

  it("returns null when host_services does not include concordia memory", () => {
    const context = {
      logger: {
        debug: vi.fn(),
      },
      config: {},
      on_message: vi.fn(),
      host_services: {},
    };

    expect(
      resolveConcordiaMemoryContext(context, "world-1", "workspace-1"),
    ).toBeNull();
  });
});
