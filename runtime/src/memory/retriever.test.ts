import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SemanticMemoryRetriever,
  estimateTokens,
  computeRetrievalScore,
  type SemanticMemoryRetrieverConfig,
} from './retriever.js';
import type { MemoryEntry } from './types.js';
import type { VectorMemoryBackend, ScoredMemoryEntry } from './vector-store.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { CuratedMemoryManager } from './structured.js';

// ============================================================================
// Test helpers
// ============================================================================

function makeEntry(
  content: string,
  timestamp = 1_000_000,
  sessionId = 'sess-1',
): MemoryEntry {
  return {
    id: `entry-${content.slice(0, 8)}`,
    sessionId,
    role: 'assistant',
    content,
    timestamp,
  };
}

function makeScoredEntry(
  content: string,
  score: number,
  timestamp = 1_000_000,
): ScoredMemoryEntry {
  return { entry: makeEntry(content, timestamp), score };
}

function createMockEmbedding(): EmbeddingProvider {
  return {
    name: 'mock',
    dimension: 8,
    embed: vi.fn().mockResolvedValue([1, 0, 0, 0, 0, 0, 0, 0]),
    embedBatch: vi.fn().mockResolvedValue([[1, 0, 0, 0, 0, 0, 0, 0]]),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

function createMockVectorBackend(results: ScoredMemoryEntry[] = []): VectorMemoryBackend {
  return {
    name: 'mock-vector',
    searchHybrid: vi.fn().mockResolvedValue(results),
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
    getDurability: vi.fn().mockReturnValue({ level: 'none', supportsFlush: false, description: '' }),
    flush: vi.fn(),
    clear: vi.fn(),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
  } as unknown as VectorMemoryBackend;
}

function createMockCurated(content = ''): CuratedMemoryManager {
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

// ============================================================================
// estimateTokens
// ============================================================================

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 1 for a single character', () => {
    expect(estimateTokens('a')).toBe(1);
  });

  it('returns 1 for exactly 4 characters', () => {
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('returns 2 for 5 characters', () => {
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('scales linearly', () => {
    expect(estimateTokens('a'.repeat(16))).toBe(4);
    expect(estimateTokens('a'.repeat(17))).toBe(5);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

// ============================================================================
// computeRetrievalScore
// ============================================================================

describe('computeRetrievalScore', () => {
  const now = 1_000_000;
  const halfLife = 86_400_000; // 24h

  it('returns pure relevance when recencyWeight=0', () => {
    const score = computeRetrievalScore(0.8, now - halfLife, now, 0, halfLife);
    expect(score).toBeCloseTo(0.8, 5);
  });

  it('returns pure recency when recencyWeight=1', () => {
    // At exactly halfLife age, recency should be 0.5
    const score = computeRetrievalScore(0.8, now - halfLife, now, 1, halfLife);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('returns 1.0 for perfect relevance and zero age', () => {
    const score = computeRetrievalScore(1.0, now, now, 0.5, halfLife);
    // relevance * 0.5 + 1.0 * 0.5 = 0.5 + 0.5 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('recency decays to 0.5 at half-life', () => {
    const score = computeRetrievalScore(0.0, now - halfLife, now, 1.0, halfLife);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('recency decays to 0.25 at two half-lives', () => {
    const score = computeRetrievalScore(0.0, now - 2 * halfLife, now, 1.0, halfLife);
    expect(score).toBeCloseTo(0.25, 5);
  });

  it('handles future timestamps (clamped age to 0)', () => {
    const score = computeRetrievalScore(0.5, now + 1000, now, 0.5, halfLife);
    // age clamped to 0 → recency = 1.0
    // 0.5 * 0.5 + 1.0 * 0.5 = 0.75
    expect(score).toBeCloseTo(0.75, 5);
  });

  it('blends relevance and recency correctly', () => {
    // weight=0.3, halfLife=24h, age=12h → recency ≈ 0.707
    const age = halfLife / 2;
    const score = computeRetrievalScore(0.6, now - age, now, 0.3, halfLife);
    const expectedRecency = Math.exp(-Math.LN2 * 0.5); // ≈ 0.707
    const expected = 0.6 * 0.7 + expectedRecency * 0.3;
    expect(score).toBeCloseTo(expected, 5);
  });
});

// ============================================================================
// SemanticMemoryRetriever — basic flow
// ============================================================================

describe('SemanticMemoryRetriever', () => {
  describe('basic flow', () => {
    it('returns formatted memory blocks', async () => {
      const results = [makeScoredEntry('relevant fact', 0.9)];
      const backend = createMockVectorBackend(results);
      const retriever = createRetriever({ vectorBackend: backend });

      const content = await retriever.retrieve('query', 'sess-1');

      expect(content).toContain('<memory source="vector"');
      expect(content).toContain('relevant fact');
      expect(content).toContain('</memory>');
    });

    it('returns undefined when no results found', async () => {
      const retriever = createRetriever();
      const content = await retriever.retrieve('query', 'sess-1');
      expect(content).toBeUndefined();
    });

    it('retrieve() delegates to retrieveDetailed()', async () => {
      const results = [makeScoredEntry('data', 0.8)];
      const backend = createMockVectorBackend(results);
      const retriever = createRetriever({ vectorBackend: backend });

      const detailed = await retriever.retrieveDetailed('query', 'sess-1');
      const simple = await retriever.retrieve('query', 'sess-1');

      expect(simple).toBe(detailed.content);
    });

    it('returns correct result shape from retrieveDetailed', async () => {
      const results = [makeScoredEntry('fact', 0.85)];
      const backend = createMockVectorBackend(results);
      const retriever = createRetriever({ vectorBackend: backend });

      const result = await retriever.retrieveDetailed('query', 'sess-1');

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].relevanceScore).toBe(0.85);
      expect(result.entries[0].combinedScore).toBeGreaterThan(0);
      expect(result.estimatedTokens).toBeGreaterThan(0);
    });

    it('returns empty result when embedding is empty', async () => {
      const embedding = createMockEmbedding();
      (embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const retriever = createRetriever({ embeddingProvider: embedding });

      const result = await retriever.retrieveDetailed('query', 'sess-1');

      expect(result.content).toBeUndefined();
      expect(result.entries).toHaveLength(0);
    });

    it('logs debug when embedding is empty', async () => {
      const embedding = createMockEmbedding();
      (embedding.embed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const retriever = createRetriever({
        embeddingProvider: embedding,
        logger: logger as any,
      });

      await retriever.retrieveDetailed('query', 'sess-1');
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Empty embedding'),
      );
    });
  });

  // ==========================================================================
  // Token budget
  // ==========================================================================

  describe('token budget', () => {
    it('curated memory takes priority over vector results', async () => {
      const results = [makeScoredEntry('vector data', 0.9)];
      const backend = createMockVectorBackend(results);
      const curated = createMockCurated('important curated fact');
      const retriever = createRetriever({
        vectorBackend: backend,
        curatedMemory: curated,
        maxTokenBudget: 2000,
      });

      const result = await retriever.retrieveDetailed('query', 'sess-1');

      expect(result.curatedIncluded).toBe(true);
      expect(result.content).toContain('source="curated"');
      // Curated appears before vector in the output
      const curatedIdx = result.content!.indexOf('source="curated"');
      const vectorIdx = result.content!.indexOf('source="vector"');
      expect(curatedIdx).toBeLessThan(vectorIdx);
    });

    it('greedy packing skips large entries and includes smaller ones', async () => {
      // Create a tight budget
      const largeContent = 'x'.repeat(200); // ~50 tokens content + block overhead
      const smallContent = 'y'.repeat(20);  // ~5 tokens content + block overhead
      const results = [
        makeScoredEntry(largeContent, 0.9),
        makeScoredEntry(smallContent, 0.8),
      ];
      const backend = createMockVectorBackend(results);
      // Budget enough for only the small entry (with block markup overhead)
      const retriever = createRetriever({
        vectorBackend: backend,
        maxTokenBudget: 25, // ~100 chars — fits small block but not large
      });

      const result = await retriever.retrieveDetailed('query', 'sess-1');

      expect(result.content).toContain(smallContent);
      expect(result.content).not.toContain(largeContent);
    });

    it('returns undefined content when budget is zero', async () => {
      const results = [makeScoredEntry('data', 0.9)];
      const backend = createMockVectorBackend(results);
      const retriever = createRetriever({
        vectorBackend: backend,
        maxTokenBudget: 0,
      });

      const result = await retriever.retrieveDetailed('query', 'sess-1');
      expect(result.content).toBeUndefined();
      expect(result.estimatedTokens).toBe(0);
    });

    it('logs warning when curated exceeds budget', async () => {
      const curated = createMockCurated('x'.repeat(10_000));
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const retriever = createRetriever({
        curatedMemory: curated,
        maxTokenBudget: 10,
        logger: logger as any,
      });

      await retriever.retrieveDetailed('query', 'sess-1');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeds remaining budget'),
      );
    });

    it('reports accurate estimatedTokens', async () => {
      const content = 'short fact';
      const results = [makeScoredEntry(content, 0.9)];
      const backend = createMockVectorBackend(results);
      const retriever = createRetriever({
        vectorBackend: backend,
        maxTokenBudget: 2000,
      });

      const result = await retriever.retrieveDetailed('query', 'sess-1');

      expect(result.estimatedTokens).toBe(estimateTokens(result.content!));
    });
  });

  // ==========================================================================
  // Curated memory
  // ==========================================================================

  describe('curated memory', () => {
    it('includes curated content when available', async () => {
      const curated = createMockCurated('User prefers TypeScript');
      const retriever = createRetriever({ curatedMemory: curated });

      const result = await retriever.retrieveDetailed('query', 'sess-1');
      expect(result.curatedIncluded).toBe(true);
      expect(result.content).toContain('User prefers TypeScript');
    });

    it('curatedIncluded is false when load returns empty', async () => {
      const curated = createMockCurated('');
      const retriever = createRetriever({ curatedMemory: curated });

      const result = await retriever.retrieveDetailed('query', 'sess-1');
      expect(result.curatedIncluded).toBe(false);
    });

    it('curatedIncluded is false when no curatedMemory configured', async () => {
      const retriever = createRetriever();
      const result = await retriever.retrieveDetailed('query', 'sess-1');
      expect(result.curatedIncluded).toBe(false);
    });

    it('curated gets score="1.00" in block', async () => {
      const curated = createMockCurated('important');
      const retriever = createRetriever({ curatedMemory: curated });

      const result = await retriever.retrieveDetailed('query', 'sess-1');
      expect(result.content).toContain('score="1.00"');
    });
  });

  // ==========================================================================
  // Curated caching
  // ==========================================================================

  describe('curated caching', () => {
    it('caches within TTL', async () => {
      const curated = createMockCurated('cached fact');
      const retriever = createRetriever({
        curatedMemory: curated,
        curatedCacheTtlMs: 60_000,
      });

      await retriever.retrieveDetailed('q1', 'sess-1');
      await retriever.retrieveDetailed('q2', 'sess-1');

      expect(curated.load).toHaveBeenCalledTimes(1);
    });

    it('reloads after TTL expires', async () => {
      const curated = createMockCurated('fact v1');
      const retriever = createRetriever({
        curatedMemory: curated,
        curatedCacheTtlMs: 100,
      });

      await retriever.retrieveDetailed('q1', 'sess-1');

      // Advance time past TTL
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 200);
      (curated.load as ReturnType<typeof vi.fn>).mockResolvedValue('fact v2');

      const result = await retriever.retrieveDetailed('q2', 'sess-1');

      expect(curated.load).toHaveBeenCalledTimes(2);
      expect(result.content).toContain('fact v2');

      vi.restoreAllMocks();
    });

    it('clearCache forces reload on next call', async () => {
      const curated = createMockCurated('original');
      const retriever = createRetriever({ curatedMemory: curated });

      await retriever.retrieveDetailed('q1', 'sess-1');
      retriever.clearCache();
      (curated.load as ReturnType<typeof vi.fn>).mockResolvedValue('updated');

      const result = await retriever.retrieveDetailed('q2', 'sess-1');
      expect(curated.load).toHaveBeenCalledTimes(2);
      expect(result.content).toContain('updated');
    });
  });

  // ==========================================================================
  // Re-ranking
  // ==========================================================================

  describe('re-ranking', () => {
    it('boosts recent entries', async () => {
      const now = Date.now();
      const old = makeScoredEntry('old fact', 0.8, now - 86_400_000 * 7); // 7 days old
      const recent = makeScoredEntry('new fact', 0.8, now - 1000); // 1 second old
      const backend = createMockVectorBackend([old, recent]);
      const retriever = createRetriever({
        vectorBackend: backend,
        recencyWeight: 0.5,
      });

      const result = await retriever.retrieveDetailed('query', 'sess-1');

      // Recent entry should rank higher
      expect(result.entries[0].entry.content).toBe('new fact');
      expect(result.entries[0].combinedScore).toBeGreaterThan(result.entries[1].combinedScore);
    });

    it('uses pure relevance when recencyWeight=0', async () => {
      const now = Date.now();
      const highRelevance = makeScoredEntry('high', 0.9, now - 86_400_000 * 30);
      const lowRelevance = makeScoredEntry('low', 0.3, now);
      const backend = createMockVectorBackend([highRelevance, lowRelevance]);
      const retriever = createRetriever({
        vectorBackend: backend,
        recencyWeight: 0,
      });

      const result = await retriever.retrieveDetailed('query', 'sess-1');

      expect(result.entries[0].entry.content).toBe('high');
      expect(result.entries[0].combinedScore).toBeCloseTo(0.9, 2);
    });

    it('uses pure recency when recencyWeight=1', async () => {
      const now = Date.now();
      const oldHighRelevance = makeScoredEntry('old-high', 0.95, now - 86_400_000 * 10);
      const recentLowRelevance = makeScoredEntry('new-low', 0.1, now - 1000);
      const backend = createMockVectorBackend([oldHighRelevance, recentLowRelevance]);
      const retriever = createRetriever({
        vectorBackend: backend,
        recencyWeight: 1,
      });

      const result = await retriever.retrieveDetailed('query', 'sess-1');

      expect(result.entries[0].entry.content).toBe('new-low');
    });
  });

  // ==========================================================================
  // Search params
  // ==========================================================================

  describe('search params', () => {
    it('forwards sessionId to searchHybrid', async () => {
      const backend = createMockVectorBackend();
      const retriever = createRetriever({ vectorBackend: backend });

      await retriever.retrieve('query', 'my-session');

      expect(backend.searchHybrid).toHaveBeenCalledWith(
        'query',
        expect.any(Array),
        expect.objectContaining({ sessionId: 'my-session' }),
      );
    });

    it('forwards maxResults as limit', async () => {
      const backend = createMockVectorBackend();
      const retriever = createRetriever({
        vectorBackend: backend,
        maxResults: 3,
      });

      await retriever.retrieve('query', 'sess-1');

      expect(backend.searchHybrid).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ limit: 3 }),
      );
    });

    it('forwards hybrid weights', async () => {
      const backend = createMockVectorBackend();
      const retriever = createRetriever({
        vectorBackend: backend,
        hybridVectorWeight: 0.6,
        hybridKeywordWeight: 0.4,
      });

      await retriever.retrieve('query', 'sess-1');

      expect(backend.searchHybrid).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          vectorWeight: 0.6,
          keywordWeight: 0.4,
        }),
      );
    });
  });

  // ==========================================================================
  // Config defaults
  // ==========================================================================

  describe('config defaults', () => {
    it('applies sensible defaults with minimal config', async () => {
      const backend = createMockVectorBackend();
      const retriever = createRetriever({ vectorBackend: backend });

      await retriever.retrieve('query', 'sess-1');

      expect(backend.searchHybrid).toHaveBeenCalledWith(
        'query',
        expect.any(Array),
        expect.objectContaining({
          limit: 5,
          vectorWeight: 0.7,
          keywordWeight: 0.3,
        }),
      );
    });
  });
});
