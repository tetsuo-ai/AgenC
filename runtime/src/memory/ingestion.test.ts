import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MemoryIngestionEngine,
  createIngestionHooks,
  type IngestionConfig,
} from "./ingestion.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { VectorMemoryBackend } from "./vector-store.js";
import type {
  DailyLogManager,
  CuratedMemoryManager,
  EntityExtractor,
  StructuredMemoryEntry,
} from "./structured.js";
import type { LLMProvider, LLMMessage, LLMResponse } from "../llm/types.js";
import type { HookContext } from "../gateway/hooks.js";
import type { Logger } from "../utils/logger.js";
import type { MemoryEntry } from "./types.js";

// ============================================================================
// Mock factories
// ============================================================================

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "test",
    dimension: 128,
    embed: vi
      .fn<[string], Promise<number[]>>()
      .mockResolvedValue(new Array(128).fill(0)),
    embedBatch: vi.fn<[string[]], Promise<number[][]>>().mockResolvedValue([]),
    isAvailable: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
  };
}

function createMockVectorStore(): VectorMemoryBackend {
  const mockEntry: MemoryEntry = {
    id: "mock-id",
    sessionId: "test-session",
    role: "assistant",
    content: "mock",
    timestamp: Date.now(),
  };
  return {
    storeWithEmbedding: vi.fn().mockResolvedValue(mockEntry),
    searchSimilar: vi.fn().mockResolvedValue([]),
    searchHybrid: vi.fn().mockResolvedValue([]),
    getVectorDimension: vi.fn().mockReturnValue(128),
    addEntry: vi.fn().mockResolvedValue(mockEntry),
    getThread: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
    deleteThread: vi.fn().mockResolvedValue(0),
    listSessions: vi.fn().mockResolvedValue([]),
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(false),
    has: vi.fn().mockResolvedValue(false),
    listKeys: vi.fn().mockResolvedValue([]),
    getDurability: vi
      .fn()
      .mockReturnValue({
        level: "none",
        supportsFlush: false,
        description: "mock",
      }),
    flush: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    name: "mock-vector-store",
  } as unknown as VectorMemoryBackend;
}

function createMockLogManager(): DailyLogManager {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    readLog: vi.fn().mockResolvedValue(undefined),
    listDates: vi.fn().mockResolvedValue([]),
    todayPath: "/tmp/test.md",
  } as unknown as DailyLogManager;
}

function createMockCuratedMemory(): CuratedMemoryManager {
  return {
    proposeAddition: vi.fn(
      (fact: string, source: string) => `- ${fact} (source: ${source})`,
    ),
    load: vi.fn().mockResolvedValue(""),
    addFact: vi.fn().mockResolvedValue(undefined),
    removeFact: vi.fn().mockResolvedValue(false),
  } as unknown as CuratedMemoryManager;
}

function createMockEntityExtractor(): EntityExtractor {
  return {
    extract: vi
      .fn<[string, string], Promise<StructuredMemoryEntry[]>>()
      .mockResolvedValue([]),
  };
}

function createMockLLMProvider(): LLMProvider {
  const response: LLMResponse = {
    content: "Test summary",
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    model: "test",
    finishReason: "stop",
  };
  return {
    name: "test-llm",
    chat: vi
      .fn<[LLMMessage[]], Promise<LLMResponse>>()
      .mockResolvedValue(response),
    chatStream: vi.fn().mockResolvedValue(response),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createHookContext(
  event: string,
  payload: Record<string, unknown>,
): HookContext {
  return {
    event: event as HookContext["event"],
    payload,
    logger: createMockLogger(),
    timestamp: Date.now(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("MemoryIngestionEngine", () => {
  let embeddingProvider: ReturnType<typeof createMockEmbeddingProvider>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let logManager: ReturnType<typeof createMockLogManager>;
  let curatedMemory: ReturnType<typeof createMockCuratedMemory>;
  let entityExtractor: ReturnType<typeof createMockEntityExtractor>;
  let llmProvider: ReturnType<typeof createMockLLMProvider>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    embeddingProvider = createMockEmbeddingProvider();
    vectorStore = createMockVectorStore();
    logManager = createMockLogManager();
    curatedMemory = createMockCuratedMemory();
    entityExtractor = createMockEntityExtractor();
    llmProvider = createMockLLMProvider();
    logger = createMockLogger();
  });

  function createEngine(
    overrides?: Partial<IngestionConfig>,
  ): MemoryIngestionEngine {
    return new MemoryIngestionEngine({
      embeddingProvider,
      vectorStore,
      logManager,
      curatedMemory,
      entityExtractor,
      generateSummaries: true,
      llmProvider,
      logger,
      ...overrides,
    });
  }

  // --------------------------------------------------------------------------
  // ingestTurn
  // --------------------------------------------------------------------------

  describe("ingestTurn", () => {
    it("generates embedding from combined user+agent text", async () => {
      const engine = createEngine();
      await engine.ingestTurn("sess-1", "hello", "hi there");

      expect(embeddingProvider.embed).toHaveBeenCalledWith(
        "User: hello\nAssistant: hi there",
      );
    });

    it("stores in vector store with correct sessionId, role, and metadata", async () => {
      const engine = createEngine();
      await engine.ingestTurn("sess-1", "hello", "hi there");

      expect(vectorStore.storeWithEmbedding).toHaveBeenCalledWith(
        {
          sessionId: "sess-1",
          role: "assistant",
          content: "User: hello\nAssistant: hi there",
          metadata: { type: "conversation_turn" },
        },
        new Array(128).fill(0),
      );
    });

    it("appends user + agent messages to daily log", async () => {
      const engine = createEngine();
      await engine.ingestTurn("sess-1", "hello", "hi there");

      expect(logManager.append).toHaveBeenCalledTimes(2);
      expect(logManager.append).toHaveBeenCalledWith("sess-1", "user", "hello");
      expect(logManager.append).toHaveBeenCalledWith(
        "sess-1",
        "assistant",
        "hi there",
      );
    });

    it("skips daily log when enableDailyLogs is false", async () => {
      const engine = createEngine({ enableDailyLogs: false });
      await engine.ingestTurn("sess-1", "hello", "hi there");

      expect(logManager.append).not.toHaveBeenCalled();
    });

    it("handles embedding failure gracefully (still appends daily log)", async () => {
      (embeddingProvider.embed as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("embed failed"),
      );
      const engine = createEngine();
      await engine.ingestTurn("sess-1", "hello", "hi there");

      expect(vectorStore.storeWithEmbedding).not.toHaveBeenCalled();
      expect(logManager.append).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to generate embedding for turn",
        expect.any(Error),
      );
    });

    it("handles vector store failure gracefully (still appends daily log)", async () => {
      (
        vectorStore.storeWithEmbedding as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("store failed"));
      const engine = createEngine();
      await engine.ingestTurn("sess-1", "hello", "hi there");

      expect(logManager.append).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to store turn in vector store",
        expect.any(Error),
      );
    });

    it("handles daily log failure gracefully (does not throw)", async () => {
      (logManager.append as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("log failed"),
      );
      const engine = createEngine();

      await expect(
        engine.ingestTurn("sess-1", "hello", "hi there"),
      ).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // processSessionEnd
  // --------------------------------------------------------------------------

  describe("processSessionEnd", () => {
    const sampleHistory: LLMMessage[] = [
      { role: "user", content: "What is Solana?" },
      { role: "assistant", content: "Solana is a blockchain." },
    ];

    it("returns empty result for empty history", async () => {
      const engine = createEngine();
      const result = await engine.processSessionEnd("sess-1", []);

      expect(result).toEqual({ summary: "", entities: [], proposedFacts: [] });
      expect(llmProvider.chat).not.toHaveBeenCalled();
    });

    it("generates summary via LLM with correct message format", async () => {
      const engine = createEngine();
      await engine.processSessionEnd("sess-1", sampleHistory);

      expect(llmProvider.chat).toHaveBeenCalledWith([
        {
          role: "system",
          content:
            "Summarize this conversation in 2-3 sentences, focusing on key decisions and learnings.",
        },
        {
          role: "user",
          content: "user: What is Solana?\nassistant: Solana is a blockchain.",
        },
      ]);
    });

    it("stores summary with embedding in vector store (high-priority metadata)", async () => {
      const engine = createEngine();
      await engine.processSessionEnd("sess-1", sampleHistory);

      expect(vectorStore.storeWithEmbedding).toHaveBeenCalledWith(
        {
          sessionId: "sess-1",
          role: "system",
          content: "Test summary",
          metadata: { type: "session_summary", priority: "high" },
        },
        new Array(128).fill(0),
      );
    });

    it("extracts entities and formats as proposed facts", async () => {
      const entities: StructuredMemoryEntry[] = [
        {
          id: "e1",
          content: "Solana is fast",
          entityName: "Solana",
          entityType: "technology",
          confidence: 0.9,
          source: "conversation",
          tags: ["blockchain"],
          createdAt: Date.now(),
        },
      ];
      (entityExtractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue(
        entities,
      );
      const engine = createEngine();

      const result = await engine.processSessionEnd("sess-1", sampleHistory);

      expect(result.entities).toEqual(entities);
      expect(result.proposedFacts).toEqual([
        "- Solana is fast (source: conversation)",
      ]);
      expect(curatedMemory.proposeAddition).toHaveBeenCalledWith(
        "Solana is fast",
        "conversation",
      );
    });

    it("skips summary when generateSummaries is false", async () => {
      const engine = createEngine({ generateSummaries: false });
      const result = await engine.processSessionEnd("sess-1", sampleHistory);

      expect(result.summary).toBe("");
      expect(llmProvider.chat).not.toHaveBeenCalled();
    });

    it("skips summary when no LLM provider", async () => {
      const engine = createEngine({ llmProvider: undefined });
      const result = await engine.processSessionEnd("sess-1", sampleHistory);

      expect(result.summary).toBe("");
    });

    it("skips entity extraction when enableEntityExtraction is false", async () => {
      const engine = createEngine({ enableEntityExtraction: false });
      const result = await engine.processSessionEnd("sess-1", sampleHistory);

      expect(result.entities).toEqual([]);
      expect(entityExtractor.extract).not.toHaveBeenCalled();
    });

    it("uses NoopEntityExtractor when none provided (returns empty entities)", async () => {
      const engine = createEngine({ entityExtractor: undefined });
      const result = await engine.processSessionEnd("sess-1", sampleHistory);

      expect(result.entities).toEqual([]);
    });

    it("returns partial result when LLM fails (entities still returned)", async () => {
      (llmProvider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("LLM timeout"),
      );
      const entities: StructuredMemoryEntry[] = [
        {
          id: "e1",
          content: "fact",
          entityName: "E",
          entityType: "thing",
          confidence: 0.8,
          source: "src",
          tags: [],
          createdAt: Date.now(),
        },
      ];
      (entityExtractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue(
        entities,
      );

      const engine = createEngine();
      const result = await engine.processSessionEnd("sess-1", sampleHistory);

      expect(result.summary).toBe("");
      expect(result.entities).toEqual(entities);
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to generate session summary",
        expect.any(Error),
      );
    });

    it("returns partial result when entity extraction fails (summary still returned)", async () => {
      (entityExtractor.extract as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("extraction failed"),
      );
      const engine = createEngine();
      const result = await engine.processSessionEnd("sess-1", sampleHistory);

      expect(result.summary).toBe("Test summary");
      expect(result.entities).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to extract entities",
        expect.any(Error),
      );
    });
  });

  // --------------------------------------------------------------------------
  // processCompaction
  // --------------------------------------------------------------------------

  describe("processCompaction", () => {
    it("stores summary with embedding and compaction_summary metadata", async () => {
      const engine = createEngine();
      await engine.processCompaction("sess-1", "Compacted summary");

      expect(embeddingProvider.embed).toHaveBeenCalledWith("Compacted summary");
      expect(vectorStore.storeWithEmbedding).toHaveBeenCalledWith(
        {
          sessionId: "sess-1",
          role: "system",
          content: "Compacted summary",
          metadata: { type: "compaction_summary" },
        },
        new Array(128).fill(0),
      );
    });

    it("passes correct sessionId to storeWithEmbedding", async () => {
      const engine = createEngine();
      await engine.processCompaction("specific-session", "Summary text");

      const call = (vectorStore.storeWithEmbedding as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(call[0].sessionId).toBe("specific-session");
    });

    it("skips empty/whitespace summary", async () => {
      const engine = createEngine();
      await engine.processCompaction("sess-1", "");
      await engine.processCompaction("sess-1", "   ");

      expect(embeddingProvider.embed).not.toHaveBeenCalled();
      expect(vectorStore.storeWithEmbedding).not.toHaveBeenCalled();
    });

    it("handles embedding failure gracefully", async () => {
      (embeddingProvider.embed as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("embed failed"),
      );
      const engine = createEngine();

      await expect(
        engine.processCompaction("sess-1", "Some summary"),
      ).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to store compaction summary",
        expect.any(Error),
      );
    });
  });

  // --------------------------------------------------------------------------
  // createIngestionHooks
  // --------------------------------------------------------------------------

  describe("createIngestionHooks", () => {
    it("returns 3 hook handlers with correct event names and priorities", () => {
      const engine = createEngine();
      const hooks = createIngestionHooks(engine);

      expect(hooks).toHaveLength(3);
      expect(hooks[0].event).toBe("message:outbound");
      expect(hooks[0].name).toBe("memory-ingestion-turn");
      expect(hooks[0].priority).toBe(200);

      expect(hooks[1].event).toBe("session:end");
      expect(hooks[1].name).toBe("memory-ingestion-session-end");
      expect(hooks[1].priority).toBe(200);

      expect(hooks[2].event).toBe("session:compact");
      expect(hooks[2].name).toBe("memory-ingestion-compact");
      expect(hooks[2].priority).toBe(200);
    });

    it("message:outbound handler calls ingestTurn with payload fields", async () => {
      const engine = createEngine();
      const ingestSpy = vi
        .spyOn(engine, "ingestTurn")
        .mockResolvedValue(undefined);
      const hooks = createIngestionHooks(engine, logger);

      const ctx = createHookContext("message:outbound", {
        sessionId: "sess-1",
        userMessage: "hello",
        agentResponse: "hi",
      });

      const result = await hooks[0].handler(ctx);
      expect(result.continue).toBe(true);

      // Fire-and-forget — wait for microtask to flush
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ingestSpy).toHaveBeenCalledWith("sess-1", "hello", "hi");
    });

    it("session:end handler awaits processSessionEnd and attaches result to payload", async () => {
      const engine = createEngine();
      const mockResult = { summary: "sum", entities: [], proposedFacts: [] };
      vi.spyOn(engine, "processSessionEnd").mockResolvedValue(mockResult);
      const hooks = createIngestionHooks(engine, logger);

      const ctx = createHookContext("session:end", {
        sessionId: "sess-1",
        history: [{ role: "user", content: "test" }],
      });

      const result = await hooks[1].handler(ctx);
      expect(result.continue).toBe(true);
      expect(ctx.payload.ingestionResult).toEqual(mockResult);
    });

    it("session:compact handler awaits processCompaction", async () => {
      const engine = createEngine();
      const compactSpy = vi
        .spyOn(engine, "processCompaction")
        .mockResolvedValue(undefined);
      const hooks = createIngestionHooks(engine, logger);

      const ctx = createHookContext("session:compact", {
        sessionId: "sess-1",
        summary: "compacted",
      });

      const result = await hooks[2].handler(ctx);
      expect(result.continue).toBe(true);
      expect(compactSpy).toHaveBeenCalledWith("sess-1", "compacted");
    });

    it("all hooks return { continue: true } even on error", async () => {
      const engine = createEngine();
      vi.spyOn(engine, "processSessionEnd").mockRejectedValue(
        new Error("boom"),
      );
      vi.spyOn(engine, "processCompaction").mockRejectedValue(
        new Error("boom"),
      );
      const hooks = createIngestionHooks(engine, logger);

      // session:end with error
      const ctx1 = createHookContext("session:end", {
        sessionId: "sess-1",
        history: [{ role: "user", content: "x" }],
      });
      const result1 = await hooks[1].handler(ctx1);
      expect(result1.continue).toBe(true);

      // session:compact with error
      const ctx2 = createHookContext("session:compact", {
        sessionId: "sess-1",
        summary: "test",
      });
      const result2 = await hooks[2].handler(ctx2);
      expect(result2.continue).toBe(true);
    });

    it("hooks handle missing payload fields gracefully (log warning, continue)", async () => {
      const engine = createEngine();
      const hooks = createIngestionHooks(engine, logger);

      // message:outbound without required fields
      const ctx1 = createHookContext("message:outbound", {});
      const result1 = await hooks[0].handler(ctx1);
      expect(result1.continue).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("missing or invalid payload fields"),
      );

      // session:end without required fields
      const ctx2 = createHookContext("session:end", { sessionId: 123 });
      const result2 = await hooks[1].handler(ctx2);
      expect(result2.continue).toBe(true);

      // session:compact without required fields
      const ctx3 = createHookContext("session:compact", {});
      const result3 = await hooks[2].handler(ctx3);
      expect(result3.continue).toBe(true);
    });
  });
});
