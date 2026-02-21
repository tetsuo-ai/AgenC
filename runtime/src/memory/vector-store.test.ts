import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryVectorStore } from "./vector-store.js";
import type { AddEntryOptions } from "./types.js";

function makeEntry(
  content: string,
  sessionId = "sess-1",
  metadata?: Record<string, unknown>,
): AddEntryOptions {
  return { sessionId, role: "user", content, metadata };
}

/** Create a unit vector pointing in a specific direction (for deterministic tests). */
function basisVector(dim: number, index: number, scale = 1): number[] {
  const v = new Array(dim).fill(0);
  v[index] = scale;
  return v;
}

/** Create a vector with specific values for first N dimensions, rest zeros. */
function sparseVector(dim: number, values: number[]): number[] {
  const v = new Array(dim).fill(0);
  for (let i = 0; i < values.length && i < dim; i++) {
    v[i] = values[i];
  }
  return v;
}

describe("InMemoryVectorStore", () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  // ==========================================================================
  // storeWithEmbedding
  // ==========================================================================

  describe("storeWithEmbedding", () => {
    it("stores entry and infers dimension from first vector", async () => {
      const entry = await store.storeWithEmbedding(
        makeEntry("hello world"),
        basisVector(64, 0),
      );

      expect(entry.id).toBeDefined();
      expect(entry.content).toBe("hello world");
      expect(store.getVectorDimension()).toBe(64);
    });

    it("rejects embedding with mismatched dimension", async () => {
      await store.storeWithEmbedding(makeEntry("first"), basisVector(64, 0));

      await expect(
        store.storeWithEmbedding(makeEntry("second"), basisVector(128, 0)),
      ).rejects.toThrow("dimension mismatch");
    });

    it("respects explicit dimension config", async () => {
      const s = new InMemoryVectorStore({ dimension: 32 });
      expect(s.getVectorDimension()).toBe(32);

      await expect(
        s.storeWithEmbedding(makeEntry("wrong dim"), basisVector(64, 0)),
      ).rejects.toThrow("dimension mismatch");
    });

    it("returns valid MemoryEntry with generated ID", async () => {
      const entry = await store.storeWithEmbedding(
        makeEntry("test entry"),
        basisVector(8, 0),
      );

      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.sessionId).toBe("sess-1");
      expect(entry.role).toBe("user");
      expect(entry.timestamp).toBeGreaterThan(0);
    });

    it("rejects empty embedding", async () => {
      await expect(
        store.storeWithEmbedding(makeEntry("empty"), []),
      ).rejects.toThrow("must not be empty");
    });
  });

  // ==========================================================================
  // searchSimilar
  // ==========================================================================

  describe("searchSimilar", () => {
    it("returns entries sorted by cosine similarity descending", async () => {
      // Basis vectors in 4D: e0, e1, e2
      await store.storeWithEmbedding(
        makeEntry("exact match"),
        basisVector(4, 0),
      );
      await store.storeWithEmbedding(
        makeEntry("partial match"),
        sparseVector(4, [0.7, 0.7]),
      );
      await store.storeWithEmbedding(makeEntry("no match"), basisVector(4, 2));

      // Query along e0
      const results = await store.searchSimilar(basisVector(4, 0));

      expect(results.length).toBe(3);
      expect(results[0].entry.content).toBe("exact match");
      expect(results[0].score).toBeCloseTo(1.0, 5);
      expect(results[1].entry.content).toBe("partial match");
      expect(results[1].score).toBeGreaterThan(0);
      expect(results[2].entry.content).toBe("no match");
      expect(results[2].score).toBeCloseTo(0, 5);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 20; i++) {
        await store.storeWithEmbedding(
          makeEntry(`entry ${i}`),
          basisVector(8, i % 8),
        );
      }

      const results = await store.searchSimilar(basisVector(8, 0), {
        limit: 5,
      });
      expect(results.length).toBe(5);
    });

    it("respects threshold cutoff", async () => {
      await store.storeWithEmbedding(makeEntry("high sim"), basisVector(4, 0));
      await store.storeWithEmbedding(makeEntry("low sim"), basisVector(4, 1));

      const results = await store.searchSimilar(basisVector(4, 0), {
        threshold: 0.5,
      });
      expect(results.length).toBe(1);
      expect(results[0].entry.content).toBe("high sim");
    });

    it("filters by sessionId", async () => {
      await store.storeWithEmbedding(
        makeEntry("sess A", "a"),
        basisVector(4, 0),
      );
      await store.storeWithEmbedding(
        makeEntry("sess B", "b"),
        basisVector(4, 0),
      );

      const results = await store.searchSimilar(basisVector(4, 0), {
        sessionId: "a",
      });
      expect(results.length).toBe(1);
      expect(results[0].entry.content).toBe("sess A");
    });

    it("filters by time range (after/before)", async () => {
      const e1 = await store.storeWithEmbedding(
        makeEntry("old"),
        basisVector(4, 0),
      );
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));
      const e2 = await store.storeWithEmbedding(
        makeEntry("new"),
        basisVector(4, 0),
      );

      const results = await store.searchSimilar(basisVector(4, 0), {
        after: e1.timestamp,
      });
      expect(results.length).toBe(1);
      expect(results[0].entry.content).toBe("new");

      const resultsBefore = await store.searchSimilar(basisVector(4, 0), {
        before: e2.timestamp,
      });
      expect(resultsBefore.length).toBe(1);
      expect(resultsBefore[0].entry.content).toBe("old");
    });

    it("filters by metadata tags", async () => {
      await store.storeWithEmbedding(
        makeEntry("tagged", "sess-1", { tags: ["solana", "zk"] }),
        basisVector(4, 0),
      );
      await store.storeWithEmbedding(
        makeEntry("untagged", "sess-1"),
        basisVector(4, 0),
      );
      await store.storeWithEmbedding(
        makeEntry("partial tag", "sess-1", { tags: ["solana"] }),
        basisVector(4, 0),
      );

      const results = await store.searchSimilar(basisVector(4, 0), {
        tags: ["solana", "zk"],
      });
      expect(results.length).toBe(1);
      expect(results[0].entry.content).toBe("tagged");
    });

    it("returns empty for empty store", async () => {
      const results = await store.searchSimilar(basisVector(4, 0));
      expect(results).toEqual([]);
    });

    it("filters by channel", async () => {
      await store.storeWithEmbedding(
        makeEntry("telegram msg", "sess-1", { channel: "telegram" }),
        basisVector(4, 0),
      );
      await store.storeWithEmbedding(
        makeEntry("discord msg", "sess-1", { channel: "discord" }),
        basisVector(4, 0),
      );

      const results = await store.searchSimilar(basisVector(4, 0), {
        channel: "telegram",
      });
      expect(results.length).toBe(1);
      expect(results[0].entry.content).toBe("telegram msg");
    });
  });

  // ==========================================================================
  // searchHybrid
  // ==========================================================================

  describe("searchHybrid", () => {
    it("combines vector and BM25 with default weights", async () => {
      // Entry with matching keywords but weak vector
      await store.storeWithEmbedding(
        makeEntry("solana blockchain protocol"),
        basisVector(4, 1),
      );
      // Entry with strong vector but no keyword match
      await store.storeWithEmbedding(
        makeEntry("unrelated text here"),
        basisVector(4, 0),
      );

      const results = await store.searchHybrid(
        "solana protocol",
        basisVector(4, 0),
      );
      // Both should appear since one has keyword match and one has vector match
      expect(results.length).toBe(2);
    });

    it("with vectorWeight=1 keywordWeight=0 gives pure vector results", async () => {
      await store.storeWithEmbedding(
        makeEntry("keyword match solana"),
        basisVector(4, 1),
      );
      await store.storeWithEmbedding(
        makeEntry("no keyword match"),
        basisVector(4, 0),
      );

      const results = await store.searchHybrid("solana", basisVector(4, 0), {
        vectorWeight: 1,
        keywordWeight: 0,
      });

      // The entry with basisVector(4, 0) should be first (perfect vector match)
      expect(results[0].entry.content).toBe("no keyword match");
    });

    it("with vectorWeight=0 keywordWeight=1 gives pure keyword results", async () => {
      await store.storeWithEmbedding(
        makeEntry("solana blockchain"),
        basisVector(4, 1),
      );
      await store.storeWithEmbedding(
        makeEntry("no keyword match"),
        basisVector(4, 0),
      );

      const results = await store.searchHybrid("solana", basisVector(4, 0), {
        vectorWeight: 0,
        keywordWeight: 1,
      });

      // Only the keyword match should have nonzero score
      expect(results[0].entry.content).toBe("solana blockchain");
    });

    it("deduplicates entries appearing in both searches", async () => {
      // Entry that matches both vector AND keyword
      await store.storeWithEmbedding(
        makeEntry("solana protocol"),
        basisVector(4, 0),
      );

      const results = await store.searchHybrid("solana", basisVector(4, 0));
      // Should appear only once, not duplicated
      expect(results.length).toBe(1);
      expect(results[0].vectorScore).toBeDefined();
      expect(results[0].keywordScore).toBeDefined();
    });

    it("applies threshold after merging", async () => {
      await store.storeWithEmbedding(
        makeEntry("weak match"),
        basisVector(4, 1),
      );

      const results = await store.searchHybrid(
        "unrelated query",
        basisVector(4, 2),
        {
          threshold: 0.9,
        },
      );

      // Low similarity + low keyword match should be filtered by threshold
      expect(results.length).toBe(0);
    });
  });

  // ==========================================================================
  // BM25 scoring
  // ==========================================================================

  describe("BM25 scoring (via searchHybrid)", () => {
    it("exact keyword match scores higher than partial", async () => {
      await store.storeWithEmbedding(
        makeEntry("solana blockchain network"),
        basisVector(4, 0),
      );
      await store.storeWithEmbedding(
        makeEntry("solana is great for building"),
        basisVector(4, 0),
      );
      await store.storeWithEmbedding(
        makeEntry("ethereum blockchain network"),
        basisVector(4, 0),
      );

      // Pure keyword search
      const results = await store.searchHybrid(
        "solana blockchain",
        new Array(4).fill(0), // zero vector = no vector contribution
        { vectorWeight: 0, keywordWeight: 1 },
      );

      // "solana blockchain network" matches both terms
      expect(results[0].entry.content).toBe("solana blockchain network");
    });

    it("returns zero score for no matching terms", async () => {
      await store.storeWithEmbedding(
        makeEntry("completely unrelated content"),
        basisVector(4, 0),
      );

      const results = await store.searchHybrid(
        "xyz123 nevermatches",
        new Array(4).fill(0),
        { vectorWeight: 0, keywordWeight: 1, threshold: 0.01 },
      );

      // No keyword matches and vectorWeight=0, so no results above threshold
      expect(results.length).toBe(0);
    });

    it("handles empty query gracefully", async () => {
      await store.storeWithEmbedding(
        makeEntry("some content"),
        basisVector(4, 0),
      );

      const results = await store.searchHybrid("", basisVector(4, 0), {
        vectorWeight: 0,
        keywordWeight: 1,
        threshold: 0.01,
      });

      // Empty query = no keyword matches, no results above threshold
      expect(results.length).toBe(0);
    });
  });

  // ==========================================================================
  // MemoryBackend delegation
  // ==========================================================================

  describe("MemoryBackend delegation", () => {
    it("addEntry works without embedding", async () => {
      const entry = await store.addEntry(makeEntry("plain entry"));
      expect(entry.id).toBeDefined();
      expect(entry.content).toBe("plain entry");

      // Should not appear in vector search
      await store.storeWithEmbedding(makeEntry("with vec"), basisVector(4, 0));
      const results = await store.searchSimilar(basisVector(4, 0));
      expect(results.length).toBe(1);
      expect(results[0].entry.content).toBe("with vec");
    });

    it("deleteThread cleans up embeddings", async () => {
      await store.storeWithEmbedding(
        makeEntry("entry 1", "sess-del"),
        basisVector(4, 0),
      );
      await store.storeWithEmbedding(
        makeEntry("entry 2", "sess-del"),
        basisVector(4, 1),
      );

      const deleted = await store.deleteThread("sess-del");
      expect(deleted).toBe(2);

      // Embeddings should be cleaned up — no results
      const results = await store.searchSimilar(basisVector(4, 0));
      expect(results).toEqual([]);
    });

    it("clear resets all vector data", async () => {
      await store.storeWithEmbedding(makeEntry("data"), basisVector(8, 0));
      expect(store.getVectorDimension()).toBe(8);

      await store.clear();
      expect(store.getVectorDimension()).toBe(0);

      // Can now store with different dimension
      await store.storeWithEmbedding(makeEntry("new data"), basisVector(4, 0));
      expect(store.getVectorDimension()).toBe(4);
    });

    it("KV operations delegate correctly", async () => {
      await store.set("key1", "value1");
      expect(await store.get("key1")).toBe("value1");
      expect(await store.has("key1")).toBe(true);

      await store.delete("key1");
      expect(await store.has("key1")).toBe(false);
    });

    it("listSessions delegates correctly", async () => {
      await store.storeWithEmbedding(
        makeEntry("a", "sess-a"),
        basisVector(4, 0),
      );
      await store.storeWithEmbedding(
        makeEntry("b", "sess-b"),
        basisVector(4, 0),
      );

      const sessions = await store.listSessions();
      expect(sessions).toContain("sess-a");
      expect(sessions).toContain("sess-b");
    });

    it("healthCheck delegates correctly", async () => {
      expect(await store.healthCheck()).toBe(true);
      await store.close();
      expect(await store.healthCheck()).toBe(false);
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe("edge cases", () => {
    it("zero-vector query returns entries with score 0", async () => {
      await store.storeWithEmbedding(
        makeEntry("some entry"),
        basisVector(4, 0),
      );

      const results = await store.searchSimilar(new Array(4).fill(0));
      // Score should be 0, but 0 >= 0 threshold, so it's included
      expect(results.length).toBe(1);
      expect(results[0].score).toBe(0);
    });

    it("single entry corpus works correctly", async () => {
      await store.storeWithEmbedding(
        makeEntry("only entry"),
        basisVector(4, 0),
      );

      const vectorResults = await store.searchSimilar(basisVector(4, 0));
      expect(vectorResults.length).toBe(1);
      expect(vectorResults[0].score).toBeCloseTo(1.0, 5);

      const hybridResults = await store.searchHybrid(
        "only entry",
        basisVector(4, 0),
      );
      expect(hybridResults.length).toBe(1);
      expect(hybridResults[0].score).toBeGreaterThan(0);
    });

    it("entries evicted by backend capacity do not appear in search", async () => {
      const s = new InMemoryVectorStore({ maxEntriesPerSession: 2 });

      await s.storeWithEmbedding(makeEntry("first"), basisVector(4, 0));
      await s.storeWithEmbedding(makeEntry("second"), basisVector(4, 1));
      // Third entry evicts "first" from both backend and vector maps
      await s.storeWithEmbedding(makeEntry("third"), basisVector(4, 2));

      // Backend thread reflects eviction
      const thread = await s.getThread("sess-1");
      expect(thread.length).toBe(2);
      expect(thread[0].content).toBe("second");
      expect(thread[1].content).toBe("third");

      // Vector search also reflects eviction — "first" (basisVector 0) should be gone
      const results = await s.searchSimilar(basisVector(4, 0));
      expect(results.length).toBe(2);
      const contents = results.map((r) => r.entry.content);
      expect(contents).not.toContain("first");
      expect(contents).toContain("second");
      expect(contents).toContain("third");
    });

    it("rejects query embedding with wrong dimension", async () => {
      await store.storeWithEmbedding(makeEntry("entry"), basisVector(4, 0));

      await expect(store.searchSimilar(basisVector(8, 0))).rejects.toThrow(
        "dimension mismatch",
      );
    });

    it("getDurability returns none level", () => {
      const info = store.getDurability();
      expect(info.level).toBe("none");
    });
  });
});
