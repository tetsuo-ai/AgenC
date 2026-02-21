import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "./in-memory/backend.js";
import { SqliteBackend } from "./sqlite/backend.js";
import { MemoryGraph } from "./graph.js";
import type { MemoryBackend } from "./types.js";

describe("MemoryGraph", () => {
  it("requires provenance on writes", async () => {
    const backend = new InMemoryBackend();
    const graph = new MemoryGraph(backend);

    await expect(
      graph.upsertNode({
        content: "fact without source",
        provenance: [],
      }),
    ).rejects.toThrow("provenance");
  });

  it("supports provenance-aware retrieval filters", async () => {
    const backend = new InMemoryBackend();
    const graph = new MemoryGraph(backend);

    await graph.upsertNode({
      id: "n1",
      content: "Task payout is 10 SOL",
      sessionId: "s1",
      baseConfidence: 0.95,
      provenance: [{ type: "onchain_event", sourceId: "tx-1" }],
    });
    await graph.upsertNode({
      id: "n2",
      content: "Unverified rumor",
      sessionId: "s1",
      baseConfidence: 0.4,
      provenance: [{ type: "manual", sourceId: "note-1" }],
    });

    const strict = await graph.query({
      sessionId: "s1",
      minConfidence: 0.7,
      provenanceTypes: ["onchain_event"],
      requireProvenance: true,
    });

    expect(strict).toHaveLength(1);
    expect(strict[0].node.id).toBe("n1");
  });

  it("applies freshness decay to confidence", async () => {
    const clock = { now: 1_000_000 };
    const backend = new InMemoryBackend();
    const graph = new MemoryGraph(backend, {
      now: () => clock.now,
      confidenceHalfLifeMs: 1_000,
    });

    await graph.upsertNode({
      id: "n1",
      content: "decaying fact",
      baseConfidence: 1,
      provenance: [{ type: "manual", sourceId: "seed" }],
    });

    clock.now += 1_000;
    const results = await graph.query({ nowMs: clock.now });
    expect(results).toHaveLength(1);
    expect(results[0].effectiveConfidence).toBeGreaterThan(0.49);
    expect(results[0].effectiveConfidence).toBeLessThan(0.51);
  });

  it("models contradiction and supersession edges in retrieval policy", async () => {
    const backend = new InMemoryBackend();
    const graph = new MemoryGraph(backend);

    await graph.upsertNode({
      id: "base",
      content: "Model A is best",
      provenance: [{ type: "manual", sourceId: "opinion-a" }],
    });
    await graph.upsertNode({
      id: "contra",
      content: "Model A fails benchmark X",
      provenance: [{ type: "external_doc", sourceId: "paper-1" }],
    });
    await graph.upsertNode({
      id: "newer",
      content: "Model B supersedes Model A",
      provenance: [{ type: "external_doc", sourceId: "paper-2" }],
    });

    await graph.addEdge({
      fromId: "contra",
      toId: "base",
      type: "contradicts",
    });
    await graph.addEdge({
      fromId: "newer",
      toId: "base",
      type: "supersedes",
    });

    const strict = await graph.query({
      includeContradicted: false,
      includeSuperseded: false,
    });
    expect(strict.some((r) => r.node.id === "base")).toBe(false);

    const relaxed = await graph.query({
      includeContradicted: true,
      includeSuperseded: true,
    });
    expect(relaxed.some((r) => r.node.id === "base")).toBe(true);
  });

  it("materializes session summaries from thread history", async () => {
    const backend = new InMemoryBackend();
    await backend.addEntry({
      sessionId: "s1",
      role: "user",
      content: "Need a plan for token launch",
    });
    await backend.addEntry({
      sessionId: "s1",
      role: "assistant",
      content: "Drafting 3-step launch plan",
    });

    const graph = new MemoryGraph(backend);
    const summaryNode = await graph.materializeSessionSummary("s1");
    expect(summaryNode.content).toContain("Need a plan");
    expect(summaryNode.provenance[0].type).toBe("materialization");
  });

  it("keeps in-memory and sqlite behavior aligned for core graph queries", async () => {
    // Skip when better-sqlite3 native bindings are not compiled
    let hasSqlite = false;
    try {
      require.resolve("better-sqlite3");
      // Resolve succeeds but bindings may still be missing — probe it
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      db.close();
      hasSqlite = true;
    } catch {
      // native module unavailable
    }
    if (!hasSqlite) {
      return; // skip
    }

    const runScenario = async (backend: MemoryBackend) => {
      const graph = new MemoryGraph(backend);
      await graph.upsertNode({
        id: "a",
        content: "Primary fact",
        sessionId: "shared",
        baseConfidence: 0.9,
        provenance: [{ type: "tx_signature", sourceId: "sig-a" }],
      });
      await graph.upsertNode({
        id: "b",
        content: "Derived fact",
        sessionId: "shared",
        baseConfidence: 0.8,
        provenance: [{ type: "tool_output", sourceId: "tool-b" }],
      });
      await graph.addEdge({
        id: "e1",
        fromId: "b",
        toId: "a",
        type: "derived_from",
      });

      const results = await graph.query({
        sessionId: "shared",
        minConfidence: 0.5,
      });
      return results.map((r) => r.node.id);
    };

    const inMemory = new InMemoryBackend();
    const sqlite = new SqliteBackend({ dbPath: ":memory:" });
    const inMemoryResults = await runScenario(inMemory);
    const sqliteResults = await runScenario(sqlite);

    expect(sqliteResults).toEqual(inMemoryResults);
    await sqlite.close();
  });
});
