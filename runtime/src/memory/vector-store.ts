/**
 * Vector memory store with semantic search and BM25 hybrid retrieval.
 *
 * Provides in-memory vector storage backed by InMemoryBackend via composition.
 * Supports cosine similarity search, BM25 keyword search, and hybrid
 * (weighted combination) search modes.
 *
 * @module
 */

import type {
  MemoryBackend,
  MemoryEntry,
  MemoryQuery,
  AddEntryOptions,
  DurabilityInfo,
} from './types.js';
import { InMemoryBackend, type InMemoryBackendConfig } from './in-memory/index.js';
import { MemoryBackendError } from './errors.js';

// ============================================================================
// Interfaces
// ============================================================================

/** Options for vector similarity search. */
export interface VectorSearchOptions {
  /** Maximum number of results to return. Default: 10 */
  limit?: number;
  /** Minimum cosine similarity threshold. Default: 0 */
  threshold?: number;
  /** Filter by session ID. */
  sessionId?: string;
  /** Filter by channel (entry.metadata.channel). */
  channel?: string;
  /** Filter entries after this timestamp (exclusive). */
  after?: number;
  /** Filter entries before this timestamp (exclusive). */
  before?: number;
  /** Filter entries that have ALL of these tags (entry.metadata.tags). */
  tags?: string[];
}

/** Options for hybrid vector + keyword search. */
export interface HybridSearchOptions extends VectorSearchOptions {
  /** Weight for vector similarity score. Default: 0.7 */
  vectorWeight?: number;
  /** Weight for BM25 keyword score. Default: 0.3 */
  keywordWeight?: number;
}

/** A memory entry with a relevance score. */
export interface ScoredMemoryEntry {
  entry: MemoryEntry;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
}

/** Memory backend extended with vector storage and semantic search. */
export interface VectorMemoryBackend extends MemoryBackend {
  /** Store an entry with its embedding vector. */
  storeWithEmbedding(options: AddEntryOptions, embedding: number[]): Promise<MemoryEntry>;
  /** Search by cosine similarity to a query embedding. */
  searchSimilar(queryEmbedding: number[], options?: VectorSearchOptions): Promise<ScoredMemoryEntry[]>;
  /** Hybrid search combining vector similarity and BM25 keyword scoring. */
  searchHybrid(queryText: string, queryEmbedding: number[], options?: HybridSearchOptions): Promise<ScoredMemoryEntry[]>;
  /** Get the embedding dimension (0 if not yet inferred). */
  getVectorDimension(): number;
}

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for InMemoryVectorStore. */
export interface InMemoryVectorStoreConfig extends InMemoryBackendConfig {
  /** Expected embedding dimension. If omitted, inferred from first store call. */
  dimension?: number;
}

// ============================================================================
// BM25 Implementation
// ============================================================================

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Tokenize text: lowercase, strip punctuation, split on whitespace. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

interface CorpusStats {
  avgDocLen: number;
  docCount: number;
  termDocFreq: Map<string, number>;
}

/** Compute corpus-level statistics for BM25 scoring. */
function computeCorpusStats(docs: string[][]): CorpusStats {
  const termDocFreq = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    totalLen += doc.length;
    const seen = new Set<string>();
    for (const term of doc) {
      if (!seen.has(term)) {
        seen.add(term);
        termDocFreq.set(term, (termDocFreq.get(term) ?? 0) + 1);
      }
    }
  }

  return {
    avgDocLen: docs.length > 0 ? totalLen / docs.length : 0,
    docCount: docs.length,
    termDocFreq,
  };
}

/** Compute BM25 score for a single document against query terms. */
function bm25Score(
  queryTerms: string[],
  docTerms: string[],
  stats: CorpusStats,
): number {
  if (queryTerms.length === 0 || docTerms.length === 0 || stats.docCount === 0) {
    return 0;
  }

  const termFreq = new Map<string, number>();
  for (const term of docTerms) {
    termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
  }

  let score = 0;
  for (const term of queryTerms) {
    const tf = termFreq.get(term) ?? 0;
    if (tf === 0) continue;

    const df = stats.termDocFreq.get(term) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((stats.docCount - df + 0.5) / (df + 0.5) + 1);
    // TF component with length normalization
    const tfNorm = (tf * (BM25_K1 + 1)) /
      (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docTerms.length / stats.avgDocLen)));
    score += idf * tfNorm;
  }

  return score;
}

// ============================================================================
// Score normalization and merge
// ============================================================================

/** Min-max normalize scores to [0, 1]. */
function normalizeScores(scored: ScoredMemoryEntry[]): void {
  if (scored.length === 0) return;

  let min = Infinity;
  let max = -Infinity;
  for (const s of scored) {
    if (s.score < min) min = s.score;
    if (s.score > max) max = s.score;
  }

  const range = max - min;
  if (range === 0) {
    // All entries equally relevant — normalize to 1 (not 0)
    for (const s of scored) {
      s.score = 1;
    }
    return;
  }

  for (const s of scored) {
    s.score = (s.score - min) / range;
  }
}

/** Merge vector and keyword results with weighted combination. */
function mergeSearchResults(
  vectorResults: ScoredMemoryEntry[],
  keywordResults: ScoredMemoryEntry[],
  vectorWeight: number,
  keywordWeight: number,
): ScoredMemoryEntry[] {
  const merged = new Map<string, ScoredMemoryEntry>();

  for (const r of vectorResults) {
    merged.set(r.entry.id, {
      entry: r.entry,
      score: r.score * vectorWeight,
      vectorScore: r.score,
      keywordScore: 0,
    });
  }

  for (const r of keywordResults) {
    const existing = merged.get(r.entry.id);
    if (existing) {
      existing.keywordScore = r.score;
      existing.score = (existing.vectorScore ?? 0) * vectorWeight + r.score * keywordWeight;
    } else {
      merged.set(r.entry.id, {
        entry: r.entry,
        score: r.score * keywordWeight,
        vectorScore: 0,
        keywordScore: r.score,
      });
    }
  }

  const results = Array.from(merged.values());
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ============================================================================
// InMemoryVectorStore
// ============================================================================

export class InMemoryVectorStore implements VectorMemoryBackend {
  readonly name = 'in-memory-vector';

  private readonly backend: InMemoryBackend;
  private readonly embeddings = new Map<string, number[]>();
  private readonly entryCache = new Map<string, MemoryEntry>();
  private readonly vectorNorms = new Map<string, number>();
  /** Per-session entry IDs in insertion order, for eviction sync with backend. */
  private readonly sessionEntryIds = new Map<string, string[]>();
  private readonly maxEntriesPerSession: number;
  private dimension: number;

  constructor(config: InMemoryVectorStoreConfig = {}) {
    this.backend = new InMemoryBackend(config);
    this.dimension = config.dimension ?? 0;
    this.maxEntriesPerSession = config.maxEntriesPerSession ?? 1000;
  }

  // ---------- Vector Operations ----------

  async storeWithEmbedding(options: AddEntryOptions, embedding: number[]): Promise<MemoryEntry> {
    // Validate / infer dimension
    if (this.dimension === 0) {
      if (embedding.length === 0) {
        throw new MemoryBackendError(this.name, 'Embedding must not be empty');
      }
      this.dimension = embedding.length;
    } else if (embedding.length !== this.dimension) {
      throw new MemoryBackendError(
        this.name,
        `Embedding dimension mismatch: expected ${this.dimension}, got ${embedding.length}`,
      );
    }

    const entry = await this.backend.addEntry(options);

    // Store embedding and pre-compute norm
    this.embeddings.set(entry.id, embedding);
    this.entryCache.set(entry.id, entry);
    this.vectorNorms.set(entry.id, computeNorm(embedding));

    // Track per-session entry order and evict to stay in sync with backend
    let sessionIds = this.sessionEntryIds.get(options.sessionId);
    if (!sessionIds) {
      sessionIds = [];
      this.sessionEntryIds.set(options.sessionId, sessionIds);
    }
    sessionIds.push(entry.id);
    while (sessionIds.length > this.maxEntriesPerSession) {
      const evictedId = sessionIds.shift()!;
      this.embeddings.delete(evictedId);
      this.entryCache.delete(evictedId);
      this.vectorNorms.delete(evictedId);
    }

    return entry;
  }

  async searchSimilar(
    queryEmbedding: number[],
    options: VectorSearchOptions = {},
  ): Promise<ScoredMemoryEntry[]> {
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0;

    if (this.dimension > 0 && queryEmbedding.length !== this.dimension) {
      throw new MemoryBackendError(
        this.name,
        `Query embedding dimension mismatch: expected ${this.dimension}, got ${queryEmbedding.length}`,
      );
    }

    const queryNorm = computeNorm(queryEmbedding);
    const candidates = this.getFilteredEntries(options);
    const scored: ScoredMemoryEntry[] = [];

    for (const entry of candidates) {
      const embedding = this.embeddings.get(entry.id);
      if (!embedding) continue;

      const entryNorm = this.vectorNorms.get(entry.id) ?? 0;
      const score = fastCosineSimilarity(queryEmbedding, embedding, queryNorm, entryNorm);

      if (score >= threshold) {
        scored.push({ entry, score, vectorScore: score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async searchHybrid(
    queryText: string,
    queryEmbedding: number[],
    options: HybridSearchOptions = {},
  ): Promise<ScoredMemoryEntry[]> {
    const vectorWeight = options.vectorWeight ?? 0.7;
    const keywordWeight = options.keywordWeight ?? 0.3;
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0;

    // Run vector search (without limit/threshold — merge first)
    const vectorResults = await this.searchSimilar(queryEmbedding, {
      ...options,
      limit: undefined,
      threshold: 0,
    });

    // Run BM25 keyword search
    const keywordResults = this.searchBM25(queryText, options);

    // Normalize scores independently
    normalizeScores(vectorResults);
    normalizeScores(keywordResults);

    // Merge with weights
    const merged = mergeSearchResults(vectorResults, keywordResults, vectorWeight, keywordWeight);

    // Apply threshold and limit
    return merged.filter((r) => r.score >= threshold).slice(0, limit);
  }

  getVectorDimension(): number {
    return this.dimension;
  }

  // ---------- MemoryBackend Delegation ----------

  async addEntry(options: AddEntryOptions): Promise<MemoryEntry> {
    return this.backend.addEntry(options);
  }

  async getThread(sessionId: string, limit?: number): Promise<MemoryEntry[]> {
    return this.backend.getThread(sessionId, limit);
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    return this.backend.query(query);
  }

  async deleteThread(sessionId: string): Promise<number> {
    // Clean up vector data using our tracking (covers entries the backend may have evicted)
    const ids = this.sessionEntryIds.get(sessionId);
    if (ids) {
      for (const id of ids) {
        this.embeddings.delete(id);
        this.entryCache.delete(id);
        this.vectorNorms.delete(id);
      }
      this.sessionEntryIds.delete(sessionId);
    }
    return this.backend.deleteThread(sessionId);
  }

  async listSessions(prefix?: string): Promise<string[]> {
    return this.backend.listSessions(prefix);
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    return this.backend.set(key, value, ttlMs);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.backend.get<T>(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.backend.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.backend.has(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return this.backend.listKeys(prefix);
  }

  getDurability(): DurabilityInfo {
    return this.backend.getDurability();
  }

  async flush(): Promise<void> {
    return this.backend.flush();
  }

  async clear(): Promise<void> {
    this.embeddings.clear();
    this.entryCache.clear();
    this.vectorNorms.clear();
    this.sessionEntryIds.clear();
    this.dimension = 0;
    return this.backend.clear();
  }

  async close(): Promise<void> {
    this.embeddings.clear();
    this.entryCache.clear();
    this.vectorNorms.clear();
    this.sessionEntryIds.clear();
    return this.backend.close();
  }

  async healthCheck(): Promise<boolean> {
    return this.backend.healthCheck();
  }

  // ---------- Private Helpers ----------

  private getFilteredEntries(options: VectorSearchOptions): MemoryEntry[] {
    const entries: MemoryEntry[] = [];

    for (const [id, entry] of this.entryCache) {
      // Must have an embedding
      if (!this.embeddings.has(id)) continue;

      // Session filter
      if (options.sessionId && entry.sessionId !== options.sessionId) continue;

      // Time range filters
      if (options.after !== undefined && entry.timestamp <= options.after) continue;
      if (options.before !== undefined && entry.timestamp >= options.before) continue;

      // Channel filter (metadata.channel)
      if (options.channel) {
        const entryChannel = entry.metadata?.channel;
        if (entryChannel !== options.channel) continue;
      }

      // Tags filter (metadata.tags must contain ALL specified tags)
      if (options.tags && options.tags.length > 0) {
        const entryTags = entry.metadata?.tags;
        if (!Array.isArray(entryTags)) continue;
        const tagSet = new Set(entryTags as string[]);
        if (!options.tags.every((t) => tagSet.has(t))) continue;
      }

      entries.push(entry);
    }

    return entries;
  }

  private searchBM25(queryText: string, options: VectorSearchOptions): ScoredMemoryEntry[] {
    const queryTerms = tokenize(queryText);
    if (queryTerms.length === 0) return [];

    const candidates = this.getFilteredEntries(options);
    if (candidates.length === 0) return [];

    // Tokenize all docs and compute corpus stats
    const docTokens: string[][] = [];
    for (const entry of candidates) {
      docTokens.push(tokenize(entry.content));
    }
    const stats = computeCorpusStats(docTokens);

    const scored: ScoredMemoryEntry[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const score = bm25Score(queryTerms, docTokens[i], stats);
      if (score > 0) {
        scored.push({ entry: candidates[i], score, keywordScore: score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}

// ============================================================================
// Vector math helpers
// ============================================================================

/** Compute the L2 norm of a vector. */
function computeNorm(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i];
  }
  return Math.sqrt(sum);
}

/** Cosine similarity using pre-computed norms. */
function fastCosineSimilarity(
  a: number[],
  b: number[],
  normA: number,
  normB: number,
): number {
  const denom = normA * normB;
  if (denom === 0) return 0;

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot / denom;
}
