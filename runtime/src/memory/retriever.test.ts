import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SemanticMemoryRetriever,
  estimateTokens,
  computeRetrievalScore,
  type SemanticMemoryRetrieverConfig,
} from "./retriever.js";
import type { MemoryEntry } from "./types.js";
import type { VectorMemoryBackend, ScoredMemoryEntry } from "./vector-store.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { CuratedMemoryManager } from "./structured.js";

function makeEntry(
  content: string,
  timestamp = 1_000_000,
  sessionId = "sess-1",
  metadata?: Record<string, unknown>,
): MemoryEntry {
  return {
    id: `entry-${Math.random().toString(16).slice(2, 8)}`,
    sessionId,
    role: "assistant",
    content,
    timestamp,
    metadata,
  };
}

function makeScoredEntry(
  content: string,
  score: number,
  opts?: {
    timestamp?: number;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  },
): ScoredMemoryEntry {
  return {
    entry: makeEntry(
      content,
      opts?.timestamp ?? 1_000_000,
      opts?.sessionId ?? "sess-1",
      opts?.metadata,
    ),
    score,
  };
}

function createMockEmbedding(): EmbeddingProvider {
  return {
    name: "mock",
    dimension: 8,
    embed: vi.fn().mockResolvedValue([1, 0, 0, 0, 0, 0, 0, 0]),
    embedBatch: vi.fn().mockResolvedValue([[1, 0, 0, 0, 0, 0, 0, 0]]),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

function createMockVectorBackend(): VectorMemoryBackend {
  return {
    name: "mock-vector",
    searchHybrid: vi.fn().mockResolvedValue([]),
    searchSimilar: vi.fn().mockResolvedValue([]),
    storeWithEmbedding: vi.fn(),
    getVectorDimension: vi.fn().mockReturnValue(8),
    addEntry: vi.fn(),
    getThread: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
    deleteThread: vi.fn().mockResolvedValue(0),
    listSessions: vi.fn().mockResolvedValue([]),
    set: vi.fn(),
    get: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(false),
    has: vi.fn().mockResolvedValue(false),
    listKeys: vi.fn().mockResolvedValue([]),
    getDurability: vi
      .fn()
      .mockReturnValue({
        level: "none",
        supportsFlush: false,
        description: "",
      }),
    flush: vi.fn(),
    clear: vi.fn(),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
  } as unknown as VectorMemoryBackend;
}

function createMockCurated(content = ""): CuratedMemoryManager {
  return {
    load: vi.fn().mockResolvedValue(content),
    proposeAddition: vi.fn(),
    addFact: vi.fn(),
    removeFact: vi.fn(),
  } as unknown as CuratedMemoryManager;
}

function createRetriever(
  overrides: Partial<SemanticMemoryRetrieverConfig> = {},
): SemanticMemoryRetriever {
  return new SemanticMemoryRetriever({
    vectorBackend: createMockVectorBackend(),
    embeddingProvider: createMockEmbedding(),
    ...overrides,
  });
}

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(chars / 4)", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("computeRetrievalScore", () => {
  const now = 1_000_000;
  const halfLife = 86_400_000;

  it("returns pure relevance when recencyWeight=0", () => {
    const score = computeRetrievalScore(0.8, now - halfLife, now, 0, halfLife);
    expect(score).toBeCloseTo(0.8, 5);
  });

  it("returns pure recency when recencyWeight=1", () => {
    const score = computeRetrievalScore(0.8, now - halfLife, now, 1, halfLife);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("clamps future timestamps to recency=1", () => {
    const score = computeRetrievalScore(0.4, now + 10_000, now, 0.5, halfLife);
    expect(score).toBeCloseTo(0.7, 5);
  });
});

describe("SemanticMemoryRetriever", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when no candidates are available", async () => {
    const retriever = createRetriever();
    const result = await retriever.retrieveDetailed("query", "sess-1");
    expect(result.content).toBeUndefined();
    expect(result.entries).toHaveLength(0);
  });

  it("retrieves working, episodic, and semantic roles separately", async () => {
    const backend = createMockVectorBackend();
    (backend.getThread as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeEntry("working context", Date.now(), "sess-1", {
        memoryRole: "working",
        confidence: 0.7,
        provenance: "ingestion:turn",
      }),
    ]);

    (backend.searchHybrid as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _query: string,
        _embedding: number[],
        options?: { memoryRoles?: readonly ("working" | "episodic" | "semantic")[] },
      ) => {
        if (options?.memoryRoles?.includes("episodic")) {
          return [
            makeScoredEntry("episodic summary", 0.82, {
              metadata: {
                memoryRole: "episodic",
                confidence: 0.9,
                provenance: "ingestion:session_end",
              },
            }),
          ];
        }
        if (options?.memoryRoles?.includes("semantic")) {
          return [
            makeScoredEntry("semantic fact", 0.91, {
              metadata: {
                memoryRole: "semantic",
                confidence: 0.88,
                provenance: "entity_extractor:conversation",
              },
            }),
          ];
        }
        return [];
      },
    );

    const retriever = createRetriever({ vectorBackend: backend, maxTokenBudget: 4000 });
    const result = await retriever.retrieveDetailed("query semantic fact", "sess-1");

    expect(result.content).toContain('role="working"');
    expect(result.content).toContain('role="episodic"');
    expect(result.content).toContain('role="semantic"');
    expect(result.content).toContain('provenance="ingestion:session_end"');
    expect(result.content).toContain('confidence="0.90"');

    expect(backend.searchHybrid).toHaveBeenCalledTimes(2);
    expect(backend.searchHybrid).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ memoryRoles: ["semantic"], sessionId: "sess-1" }),
    );
    expect(backend.searchHybrid).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ memoryRoles: ["episodic"], sessionId: "sess-1" }),
    );
  });

  it("enforces diversity-aware packing by dropping near-duplicates", async () => {
    const backend = createMockVectorBackend();
    (backend.searchHybrid as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _query: string,
        _embedding: number[],
        options?: { memoryRoles?: readonly ("working" | "episodic" | "semantic")[] },
      ) => {
        if (!options?.memoryRoles?.includes("semantic")) return [];
        return [
          makeScoredEntry("The server failed on port 8123 with timeout", 0.95, {
            metadata: { memoryRole: "semantic", confidence: 0.9 },
          }),
          makeScoredEntry("Server failed on port 8123 due to timeout", 0.94, {
            metadata: { memoryRole: "semantic", confidence: 0.88 },
          }),
          makeScoredEntry("Use retry budget to avoid infinite loops", 0.7, {
            metadata: { memoryRole: "semantic", confidence: 0.8 },
          }),
        ];
      },
    );

    const retriever = createRetriever({
      vectorBackend: backend,
      maxTokenBudget: 2000,
      diversityThreshold: 0.6,
    });

    const result = await retriever.retrieveDetailed("port timeout retry", "sess-1");

    const blockCount = (result.content?.match(/<memory /g) ?? []).length;
    expect(blockCount).toBe(2);
    expect(result.content).toContain("retry budget");
  });

  it("forwards session id for isolation in both thread and vector retrieval", async () => {
    const backend = createMockVectorBackend();
    const retriever = createRetriever({ vectorBackend: backend });

    await retriever.retrieveDetailed("query", "ws-a:sess-22");

    expect(backend.getThread).toHaveBeenCalledWith("ws-a:sess-22", expect.any(Number));
    expect(backend.searchHybrid).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ sessionId: "ws-a:sess-22" }),
    );
  });

  it("includes curated memory with bounded budget", async () => {
    const curated = createMockCurated("x".repeat(10_000));
    const retriever = createRetriever({
      curatedMemory: curated,
      maxTokenBudget: 200,
    });

    const result = await retriever.retrieveDetailed("query", "sess-1");

    expect(result.curatedIncluded).toBe(true);
    expect(result.content).toContain('source="curated"');
    expect(result.estimatedTokens).toBeLessThanOrEqual(200);
  });

  it("uses curated cache and supports clearCache", async () => {
    const curated = createMockCurated("fact-v1");
    const retriever = createRetriever({
      curatedMemory: curated,
      curatedCacheTtlMs: 60_000,
    });

    await retriever.retrieveDetailed("q1", "sess-1");
    await retriever.retrieveDetailed("q2", "sess-1");
    expect(curated.load).toHaveBeenCalledTimes(1);

    retriever.clearCache();
    (curated.load as ReturnType<typeof vi.fn>).mockResolvedValue("fact-v2");
    const result = await retriever.retrieveDetailed("q3", "sess-1");

    expect(curated.load).toHaveBeenCalledTimes(2);
    expect(result.content).toContain("fact-v2");
  });

  it("still returns working/curated memory when embedding is empty", async () => {
    const embedding = createMockEmbedding();
    (embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const backend = createMockVectorBackend();
    (backend.getThread as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeEntry("working note", Date.now(), "sess-1", {
        memoryRole: "working",
      }),
    ]);

    const retriever = createRetriever({
      embeddingProvider: embedding,
      vectorBackend: backend,
    });

    const result = await retriever.retrieveDetailed("query", "sess-1");
    expect(result.content).toContain("working note");
    expect(backend.searchHybrid).not.toHaveBeenCalled();
  });
});
