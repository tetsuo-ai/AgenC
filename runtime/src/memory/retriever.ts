/**
 * Semantic memory retriever — context-aware retrieval for prompt assembly.
 *
 * Embeds user messages, runs hybrid search on a VectorMemoryBackend,
 * re-ranks by recency * relevance, loads curated MEMORY.md, and
 * formats results as `<memory>` blocks within a token budget.
 *
 * Implements the {@link MemoryRetriever} interface consumed by ChatExecutor.
 *
 * @module
 */

import type { MemoryEntry } from "./types.js";
import type { VectorMemoryBackend } from "./vector-store.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { CuratedMemoryManager } from "./structured.js";
import type { MemoryRetriever } from "../llm/chat-executor.js";
import type { Logger } from "../utils/logger.js";

// ============================================================================
// Constants
// ============================================================================

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKEN_BUDGET = 2000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_RECENCY_WEIGHT = 0.3;
const DEFAULT_RECENCY_HALF_LIFE_MS = 86_400_000; // 24h
const DEFAULT_CURATED_CACHE_TTL_MS = 60_000; // 1min
const DEFAULT_MIN_SCORE = 0.01;
const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7;
const DEFAULT_HYBRID_KEYWORD_WEIGHT = 0.3;

// ============================================================================
// Types
// ============================================================================

export interface SemanticMemoryRetrieverConfig {
  vectorBackend: VectorMemoryBackend;
  embeddingProvider: EmbeddingProvider;
  curatedMemory?: CuratedMemoryManager;
  maxTokenBudget?: number;
  maxResults?: number;
  recencyWeight?: number;
  recencyHalfLifeMs?: number;
  curatedCacheTtlMs?: number;
  minScore?: number;
  hybridVectorWeight?: number;
  hybridKeywordWeight?: number;
  logger?: Logger;
}

export interface RetrievalResult {
  content: string | undefined;
  entries: readonly ScoredRetrievalEntry[];
  curatedIncluded: boolean;
  estimatedTokens: number;
}

export interface ScoredRetrievalEntry {
  entry: MemoryEntry;
  relevanceScore: number;
  recencyScore: number;
  combinedScore: number;
}

// ============================================================================
// Pure helpers
// ============================================================================

/** Estimate token count from text (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Compute a blended retrieval score from relevance and recency.
 *
 * `recency = exp(-ln2 * age / halfLife)` — decays to 0.5 at halfLife.
 * `combined = relevance * (1 - recencyWeight) + recency * recencyWeight`
 */
export function computeRetrievalScore(
  relevanceScore: number,
  entryTimestamp: number,
  now: number,
  recencyWeight: number,
  halfLifeMs: number,
): number {
  const age = Math.max(0, now - entryTimestamp);
  const recencyScore =
    halfLifeMs > 0
      ? Math.exp((-Math.LN2 * age) / halfLifeMs)
      : age === 0
        ? 1
        : 0;
  return relevanceScore * (1 - recencyWeight) + recencyScore * recencyWeight;
}

// ============================================================================
// SemanticMemoryRetriever
// ============================================================================

export class SemanticMemoryRetriever implements MemoryRetriever {
  private readonly vectorBackend: VectorMemoryBackend;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly curatedMemory: CuratedMemoryManager | undefined;
  private readonly maxTokenBudget: number;
  private readonly maxResults: number;
  private readonly recencyWeight: number;
  private readonly recencyHalfLifeMs: number;
  private readonly curatedCacheTtlMs: number;
  private readonly minScore: number;
  private readonly hybridVectorWeight: number;
  private readonly hybridKeywordWeight: number;
  private readonly logger: Logger | undefined;

  // Curated memory cache
  private curatedCacheContent: string | undefined;
  private curatedCacheTimestamp = 0;

  constructor(config: SemanticMemoryRetrieverConfig) {
    this.vectorBackend = config.vectorBackend;
    this.embeddingProvider = config.embeddingProvider;
    this.curatedMemory = config.curatedMemory;
    this.maxTokenBudget = config.maxTokenBudget ?? DEFAULT_MAX_TOKEN_BUDGET;
    this.maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;
    this.recencyWeight = config.recencyWeight ?? DEFAULT_RECENCY_WEIGHT;
    this.recencyHalfLifeMs =
      config.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS;
    this.curatedCacheTtlMs =
      config.curatedCacheTtlMs ?? DEFAULT_CURATED_CACHE_TTL_MS;
    this.minScore = config.minScore ?? DEFAULT_MIN_SCORE;
    this.hybridVectorWeight =
      config.hybridVectorWeight ?? DEFAULT_HYBRID_VECTOR_WEIGHT;
    this.hybridKeywordWeight =
      config.hybridKeywordWeight ?? DEFAULT_HYBRID_KEYWORD_WEIGHT;
    this.logger = config.logger;
  }

  /** Retrieve formatted memory context for prompt assembly. */
  async retrieve(
    message: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const result = await this.retrieveDetailed(message, sessionId);
    return result.content;
  }

  /** Retrieve with full scoring details. */
  async retrieveDetailed(
    message: string,
    sessionId: string,
  ): Promise<RetrievalResult> {
    // 1. Embed user message
    const embedding = await this.embeddingProvider.embed(message);
    if (embedding.length === 0) {
      this.logger?.debug("Empty embedding returned, skipping retrieval");
      return {
        content: undefined,
        entries: [],
        curatedIncluded: false,
        estimatedTokens: 0,
      };
    }

    // 2. Hybrid search
    const searchResults = await this.vectorBackend.searchHybrid(
      message,
      embedding,
      {
        limit: this.maxResults,
        sessionId,
        vectorWeight: this.hybridVectorWeight,
        keywordWeight: this.hybridKeywordWeight,
      },
    );

    // 3. Re-rank with recency
    const now = Date.now();
    const scored: ScoredRetrievalEntry[] = searchResults.map((sr) => {
      const recencyScore = this.computeRecency(sr.entry.timestamp, now);
      const combinedScore = computeRetrievalScore(
        sr.score,
        sr.entry.timestamp,
        now,
        this.recencyWeight,
        this.recencyHalfLifeMs,
      );
      return {
        entry: sr.entry,
        relevanceScore: sr.score,
        recencyScore,
        combinedScore,
      };
    });

    // 4. Filter by minScore and sort descending
    const filtered = scored
      .filter((e) => e.combinedScore >= this.minScore)
      .sort((a, b) => b.combinedScore - a.combinedScore);

    // 5. Load curated memory (with cache)
    const curatedContent = await this.loadCurated();

    // 6. Pack into token budget
    let remainingBudget = this.maxTokenBudget;
    const blocks: string[] = [];
    let curatedIncluded = false;

    // Curated memory first
    if (curatedContent) {
      const curatedTokens = estimateTokens(curatedContent);
      if (curatedTokens <= remainingBudget) {
        blocks.push(
          `<memory source="curated" score="1.00">\n${curatedContent}\n</memory>`,
        );
        remainingBudget -= estimateTokens(blocks[blocks.length - 1]);
        curatedIncluded = true;
      } else {
        this.logger?.warn(
          `Curated memory (${curatedTokens} tokens) exceeds remaining budget (${remainingBudget})`,
        );
      }
    }

    // Vector results — greedy packing with skip
    for (const entry of filtered) {
      const block = `<memory source="vector" score="${entry.combinedScore.toFixed(2)}">\n${entry.entry.content}\n</memory>`;
      const blockTokens = estimateTokens(block);
      if (blockTokens <= remainingBudget) {
        blocks.push(block);
        remainingBudget -= blockTokens;
      }
      // Skip (not break) — try smaller entries
    }

    const content = blocks.length > 0 ? blocks.join("\n") : undefined;
    const totalTokens = this.maxTokenBudget - remainingBudget;

    return {
      content,
      entries: filtered,
      curatedIncluded,
      estimatedTokens: totalTokens,
    };
  }

  /** Invalidate the curated memory cache. */
  clearCache(): void {
    this.curatedCacheContent = undefined;
    this.curatedCacheTimestamp = 0;
  }

  // ---------- Private helpers ----------

  private computeRecency(entryTimestamp: number, now: number): number {
    const age = Math.max(0, now - entryTimestamp);
    if (this.recencyHalfLifeMs <= 0) return age === 0 ? 1 : 0;
    return Math.exp((-Math.LN2 * age) / this.recencyHalfLifeMs);
  }

  private async loadCurated(): Promise<string | undefined> {
    if (!this.curatedMemory) return undefined;

    const now = Date.now();
    if (
      this.curatedCacheContent !== undefined &&
      now - this.curatedCacheTimestamp < this.curatedCacheTtlMs
    ) {
      return this.curatedCacheContent || undefined;
    }

    const content = await this.curatedMemory.load();
    this.curatedCacheContent = content;
    this.curatedCacheTimestamp = now;
    return content || undefined;
  }
}
