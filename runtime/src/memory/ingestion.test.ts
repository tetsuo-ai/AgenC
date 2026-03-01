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

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "test",
    dimension: 128,
    embed: vi
      .fn<[string], Promise<number[]>>()
      .mockResolvedValue(new Array(128).fill(0.1)),
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

  describe("ingestTurn", () => {
    it("embeds combined turn text and stores working + semantic entries", async () => {
      const engine = createEngine();
      await engine.ingestTurn(
        "sess-1",
        "please fix error in server command",
        "run command and resolved issue",
      );

      expect(embeddingProvider.embed).toHaveBeenCalledWith(
        "User: please fix error in server command\nAssistant: run command and resolved issue",
      );

      expect(vectorStore.storeWithEmbedding).toHaveBeenCalledTimes(2);
      const firstCall = (vectorStore.storeWithEmbedding as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        metadata: Record<string, unknown>;
      };
      const secondCall = (vectorStore.storeWithEmbedding as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as {
        metadata: Record<string, unknown>;
      };

      expect(firstCall.metadata.memoryRole).toBe("working");
      expect(secondCall.metadata.memoryRole).toBe("semantic");
      expect(firstCall.metadata.provenance).toBe("ingestion:turn");
      expect(typeof firstCall.metadata.confidence).toBe("number");
      expect(typeof firstCall.metadata.contentHash).toBe("string");

      expect(logManager.append).toHaveBeenCalledTimes(2);
      expect(logManager.append).toHaveBeenCalledWith(
        "sess-1",
        "user",
        "please fix error in server command",
      );
      expect(logManager.append).toHaveBeenCalledWith(
        "sess-1",
        "assistant",
        "run command and resolved issue",
      );
    });

    it("skips vector indexing when salience is below configured threshold", async () => {
      const engine = createEngine({ minTurnSalienceScore: 0.95 });
      await engine.ingestTurn("sess-1", "ok", "fine");

      expect(embeddingProvider.embed).not.toHaveBeenCalled();
      expect(vectorStore.storeWithEmbedding).not.toHaveBeenCalled();
      expect(logManager.append).toHaveBeenCalledTimes(2);
    });

    it("deduplicates near-identical turns per role", async () => {
      (vectorStore.query as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "existing-1",
          sessionId: "sess-1",
          role: "assistant",
          content:
            "User: please fix error in server command\nAssistant: run command and resolved issue",
          timestamp: Date.now(),
          metadata: {
            memoryRole: "working",
            contentHash: "e3f6d5c5be6e56f026d95f62f7f96d0ae789c5c2d7442138f43c41af2ba4d85e",
          },
        },
        {
          id: "existing-2",
          sessionId: "sess-1",
          role: "assistant",
          content:
            "User: please fix error in server command\nAssistant: run command and resolved issue",
          timestamp: Date.now(),
          metadata: {
            memoryRole: "semantic",
            contentHash: "e3f6d5c5be6e56f026d95f62f7f96d0ae789c5c2d7442138f43c41af2ba4d85e",
          },
        },
      ]);

      const engine = createEngine();
      await engine.ingestTurn(
        "sess-1",
        "please fix error in server command",
        "run command and resolved issue",
      );

      expect(vectorStore.storeWithEmbedding).toHaveBeenCalledTimes(0);
    });
  });

  describe("processSessionEnd", () => {
    const sampleHistory: LLMMessage[] = [
      { role: "user", content: "What is Solana?" },
      { role: "assistant", content: "Solana is a blockchain." },
    ];

    it("stores summary in episodic memory with provenance and confidence", async () => {
      const engine = createEngine();
      await engine.processSessionEnd("sess-1", sampleHistory);

      expect(vectorStore.storeWithEmbedding).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          role: "system",
          content: "Test summary",
          metadata: expect.objectContaining({
            type: "session_summary",
            memoryRole: "episodic",
            provenance: "ingestion:session_end",
            confidence: 0.9,
          }),
        }),
        new Array(128).fill(0.1),
      );
    });

    it("stores extracted entities as semantic facts", async () => {
      const entities: StructuredMemoryEntry[] = [
        {
          id: "e1",
          content: "Solana has fast finality",
          entityName: "Solana",
          entityType: "technology",
          confidence: 0.87,
          source: "conversation",
          tags: ["blockchain"],
          createdAt: Date.now(),
        },
      ];
      (entityExtractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue(entities);

      const engine = createEngine();
      const result = await engine.processSessionEnd("sess-1", sampleHistory);

      const allCalls = (vectorStore.storeWithEmbedding as ReturnType<typeof vi.fn>).mock.calls;
      const entityCall = allCalls.find((call) => call[0]?.metadata?.type === "entity_fact");
      expect(entityCall).toBeDefined();
      expect(entityCall?.[0]).toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({
            memoryRole: "semantic",
            provenance: "entity_extractor:conversation",
            entityName: "Solana",
            entityType: "technology",
          }),
        }),
      );

      expect(result.entities).toEqual(entities);
      expect(result.proposedFacts).toEqual([
        "- Solana has fast finality (source: conversation)",
      ]);
    });

    it("returns empty summary when summarization disabled", async () => {
      const engine = createEngine({ generateSummaries: false });
      const result = await engine.processSessionEnd("sess-1", sampleHistory);

      expect(result.summary).toBe("");
      expect(llmProvider.chat).not.toHaveBeenCalled();
    });
  });

  describe("processCompaction", () => {
    it("stores compacted summary as episodic memory", async () => {
      const engine = createEngine();
      await engine.processCompaction("sess-1", "Compacted summary");

      expect(embeddingProvider.embed).toHaveBeenCalledWith("Compacted summary");
      expect(vectorStore.storeWithEmbedding).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            type: "compaction_summary",
            memoryRole: "episodic",
            provenance: "ingestion:session_compaction",
          }),
        }),
        new Array(128).fill(0.1),
      );
    });

    it("skips compaction storage when duplicate is detected", async () => {
      (vectorStore.query as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "dup",
          sessionId: "sess-1",
          role: "system",
          content: "Compacted summary",
          timestamp: Date.now(),
          metadata: {
            memoryRole: "episodic",
            contentHash: "f25e0f90f6462970bd284f6e87d7d2f7db4d1f3f75ea2f8037ef8fd95ad9e640",
          },
        },
      ]);

      const engine = createEngine();
      await engine.processCompaction("sess-1", "Compacted summary");

      expect(vectorStore.storeWithEmbedding).not.toHaveBeenCalled();
    });
  });

  describe("createIngestionHooks", () => {
    it("returns three lifecycle hooks", () => {
      const engine = createEngine();
      const hooks = createIngestionHooks(engine);

      expect(hooks).toHaveLength(3);
      expect(hooks.map((hook) => hook.event)).toEqual([
        "message:outbound",
        "session:end",
        "session:compact",
      ]);
    });

    it("message outbound hook triggers ingestTurn", async () => {
      const engine = createEngine();
      const ingestSpy = vi.spyOn(engine, "ingestTurn").mockResolvedValue(undefined);
      const hooks = createIngestionHooks(engine, logger);

      const ctx = createHookContext("message:outbound", {
        sessionId: "sess-1",
        userMessage: "hello",
        agentResponse: "hi",
      });

      const result = await hooks[0].handler(ctx);
      expect(result.continue).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(ingestSpy).toHaveBeenCalledWith("sess-1", "hello", "hi");
    });

    it("session end hook attaches ingestion result", async () => {
      const engine = createEngine();
      vi.spyOn(engine, "processSessionEnd").mockResolvedValue({
        summary: "sum",
        entities: [],
        proposedFacts: [],
      });
      const hooks = createIngestionHooks(engine, logger);

      const ctx = createHookContext("session:end", {
        sessionId: "sess-1",
        history: [{ role: "user", content: "test" }],
      });

      const result = await hooks[1].handler(ctx);
      expect(result.continue).toBe(true);
      expect(ctx.payload.ingestionResult).toEqual({
        summary: "sum",
        entities: [],
        proposedFacts: [],
      });
    });

    it("session compact hook processes only after-phase payloads", async () => {
      const engine = createEngine();
      const compactSpy = vi
        .spyOn(engine, "processCompaction")
        .mockResolvedValue(undefined);
      const hooks = createIngestionHooks(engine, logger);

      const beforeCtx = createHookContext("session:compact", {
        sessionId: "sess-1",
        phase: "before",
        summary: "ignored",
      });
      await hooks[2].handler(beforeCtx);
      expect(compactSpy).not.toHaveBeenCalled();

      const afterCtx = createHookContext("session:compact", {
        sessionId: "sess-1",
        phase: "after",
        summary: "kept",
      });
      await hooks[2].handler(afterCtx);
      expect(compactSpy).toHaveBeenCalledWith("sess-1", "kept");
    });
  });
});
