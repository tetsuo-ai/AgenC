/**
 * Semantic memory retriever — context-aware retrieval for prompt assembly.
 *
 * Blends three memory roles before prompt injection:
 * - working: recent session horizon
 * - episodic: session/compaction summaries
 * - semantic: long-lived retrieval index
 *
 * The retriever applies salience-aware ranking and diversity-aware packing,
 * then emits auditable `<memory ...>` blocks with provenance/confidence tags.
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
const DEFAULT_WORKING_WINDOW = 12;
const DEFAULT_MAX_CANDIDATES_PER_ROLE = 24;
const DEFAULT_DIVERSITY_THRESHOLD = 0.86;
const DEFAULT_ROLE_WEIGHTS = {
  working: 0.34,
  episodic: 0.22,
  semantic: 0.44,
} as const;

const TOKEN_RE = /[a-z0-9]{3,}/g;

// ============================================================================
// Types
// ============================================================================

export type RetrievalMemoryRole = "working" | "episodic" | "semantic";

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
  /** How many latest thread messages to inspect for working-memory candidates. */
  workingMemoryWindow?: number;
  /** Candidate cap per memory role before cross-role packing. */
  maxCandidatesPerRole?: number;
  /** Near-duplicate threshold for diversity-aware packing (token Jaccard). */
  diversityThreshold?: number;
  /** Relative role budget split within memory budget. */
  roleBudgetWeights?: Partial<Record<RetrievalMemoryRole, number>>;
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
  role: RetrievalMemoryRole;
  source: "thread" | "vector";
  provenance: string;
  confidence: number;
  relevanceScore: number;
  recencyScore: number;
  salienceScore: number;
  combinedScore: number;
}

interface RetrievalCandidate extends ScoredRetrievalEntry {
  canonical: string;
  tokenSet: Set<string>;
  formattedBlock: string;
  blockTokens: number;
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function attrEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeWeight(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeRoleWeights(
  overrides: Partial<Record<RetrievalMemoryRole, number>> | undefined,
): Record<RetrievalMemoryRole, number> {
  const raw = {
    working: normalizeWeight(
      overrides?.working,
      DEFAULT_ROLE_WEIGHTS.working,
    ),
    episodic: normalizeWeight(
      overrides?.episodic,
      DEFAULT_ROLE_WEIGHTS.episodic,
    ),
    semantic: normalizeWeight(
      overrides?.semantic,
      DEFAULT_ROLE_WEIGHTS.semantic,
    ),
  };

  const total = raw.working + raw.episodic + raw.semantic;
  if (total <= 0) {
    return { ...DEFAULT_ROLE_WEIGHTS };
  }

  return {
    working: raw.working / total,
    episodic: raw.episodic / total,
    semantic: raw.semantic / total,
  };
}

function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(TOKEN_RE);
  return new Set(matches ?? []);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function keywordOverlapScore(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  return clamp01(overlap / queryTokens.size);
}

function inferRole(
  entry: MemoryEntry,
  fallback: RetrievalMemoryRole,
): RetrievalMemoryRole {
  const metadata = entry.metadata;
  if (metadata) {
    const primary = metadata.memoryRole;
    if (
      primary === "working" ||
      primary === "episodic" ||
      primary === "semantic"
    ) {
      return primary;
    }

    const roles = metadata.memoryRoles;
    if (Array.isArray(roles)) {
      if (roles.includes("semantic")) return "semantic";
      if (roles.includes("episodic")) return "episodic";
      if (roles.includes("working")) return "working";
    }

    const type = metadata.type;
    if (type === "session_summary" || type === "compaction_summary") {
      return "episodic";
    }
  }
  return fallback;
}

function inferConfidence(entry: MemoryEntry): number {
  const confidence = entry.metadata?.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return 0.6;
  }
  return clamp01(confidence);
}

function inferSalience(entry: MemoryEntry): number {
  const salience = entry.metadata?.salienceScore;
  if (typeof salience === "number" && Number.isFinite(salience)) {
    return clamp01(salience);
  }
  return clamp01(Math.min(1, entry.content.length / 1200));
}

function inferProvenance(entry: MemoryEntry): string {
  const provenance = entry.metadata?.provenance;
  if (typeof provenance === "string" && provenance.trim().length > 0) {
    return provenance.trim();
  }
  return "unknown";
}

function truncateByTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 3)}...`;
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
  private readonly workingMemoryWindow: number;
  private readonly maxCandidatesPerRole: number;
  private readonly diversityThreshold: number;
  private readonly roleBudgetWeights: Record<RetrievalMemoryRole, number>;
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
    this.workingMemoryWindow = Math.max(
      1,
      Math.floor(config.workingMemoryWindow ?? DEFAULT_WORKING_WINDOW),
    );
    this.maxCandidatesPerRole = Math.max(
      this.maxResults,
      Math.floor(config.maxCandidatesPerRole ?? DEFAULT_MAX_CANDIDATES_PER_ROLE),
    );
    this.diversityThreshold = clamp01(
      config.diversityThreshold ?? DEFAULT_DIVERSITY_THRESHOLD,
    );
    this.roleBudgetWeights = normalizeRoleWeights(config.roleBudgetWeights);
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
    const queryTokens = tokenize(message);
    const now = Date.now();

    const curatedContent = await this.loadCurated();
    const workingCandidates = await this.retrieveWorkingCandidates(
      queryTokens,
      sessionId,
      now,
    );

    // Semantic/episodic retrieval uses embeddings when available.
    let semanticCandidates: RetrievalCandidate[] = [];
    let episodicCandidates: RetrievalCandidate[] = [];
    let embedding: number[] = [];
    try {
      embedding = await this.embeddingProvider.embed(message);
    } catch (err) {
      this.logger?.warn("Memory query embedding failed, using non-embedding roles", err);
      embedding = [];
    }

    if (embedding.length > 0) {
      [semanticCandidates, episodicCandidates] = await Promise.all([
        this.retrieveVectorCandidates(
          message,
          sessionId,
          now,
          "semantic",
          embedding,
        ),
        this.retrieveVectorCandidates(
          message,
          sessionId,
          now,
          "episodic",
          embedding,
        ),
      ]);
    } else {
      this.logger?.debug("Empty memory query embedding, skipping semantic/episodic retrieval");
    }

    const candidates = this.deduplicateCandidates([
      ...workingCandidates,
      ...episodicCandidates,
      ...semanticCandidates,
    ]);

    let remainingBudget = this.maxTokenBudget;
    const selected: RetrievalCandidate[] = [];
    const blocks: string[] = [];
    let curatedIncluded = false;

    // Curated memory is authoritative but bounded to avoid starving live context.
    if (curatedContent && remainingBudget > 0) {
      const curatedCap = Math.max(64, Math.floor(this.maxTokenBudget * 0.25));
      const curatedText = truncateByTokens(
        curatedContent,
        Math.min(curatedCap, remainingBudget),
      );
      const curatedBlock = `<memory source="curated" role="semantic" provenance="curated:memory.md" confidence="1.00" salience="1.00" score="1.00">\n${curatedText}\n</memory>`;
      const curatedTokens = estimateTokens(curatedBlock);
      if (curatedTokens <= remainingBudget) {
        blocks.push(curatedBlock);
        remainingBudget -= curatedTokens;
        curatedIncluded = true;
      }
    }

    const roleBudgets = {
      working: Math.floor(remainingBudget * this.roleBudgetWeights.working),
      episodic: Math.floor(remainingBudget * this.roleBudgetWeights.episodic),
      semantic: Math.floor(remainingBudget * this.roleBudgetWeights.semantic),
    };

    const byRole: Record<RetrievalMemoryRole, RetrievalCandidate[]> = {
      working: [],
      episodic: [],
      semantic: [],
    };
    for (const candidate of candidates) {
      byRole[candidate.role].push(candidate);
    }

    for (const role of ["working", "episodic", "semantic"] as const) {
      const picked = this.packRoleCandidates(
        byRole[role],
        roleBudgets[role],
        selected,
      );
      for (const entry of picked) {
        selected.push(entry);
        blocks.push(entry.formattedBlock);
        remainingBudget -= entry.blockTokens;
      }
    }

    // Fill leftover budget across all roles by score/diversity.
    if (remainingBudget > 0) {
      const selectedIds = new Set(selected.map((entry) => entry.entry.id));
      const leftovers = candidates
        .filter((candidate) => !selectedIds.has(candidate.entry.id))
        .sort((a, b) => b.combinedScore - a.combinedScore);

      for (const candidate of leftovers) {
        if (candidate.blockTokens > remainingBudget) continue;
        if (this.isTooSimilar(candidate, selected)) continue;
        selected.push(candidate);
        blocks.push(candidate.formattedBlock);
        remainingBudget -= candidate.blockTokens;
        if (remainingBudget <= 0) break;
      }
    }

    const content = blocks.length > 0 ? blocks.join("\n") : undefined;
    const totalTokens = this.maxTokenBudget - remainingBudget;

    return {
      content,
      entries: selected,
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

  private async retrieveWorkingCandidates(
    queryTokens: Set<string>,
    sessionId: string,
    now: number,
  ): Promise<RetrievalCandidate[]> {
    let thread: MemoryEntry[] = [];
    try {
      thread = await this.vectorBackend.getThread(
        sessionId,
        this.workingMemoryWindow * 3,
      );
    } catch (err) {
      this.logger?.warn("Working-memory retrieval failed", err);
      return [];
    }

    const scored: RetrievalCandidate[] = [];
    for (const entry of [...thread].reverse()) {
      const role = inferRole(entry, "working");
      if (role !== "working") continue;

      const relevance = keywordOverlapScore(queryTokens, entry.content);
      const recency = this.computeRecency(entry.timestamp, now);
      const confidence = inferConfidence(entry);
      const salience = inferSalience(entry);
      const combined =
        computeRetrievalScore(
          relevance,
          entry.timestamp,
          now,
          this.recencyWeight,
          this.recencyHalfLifeMs,
        ) *
          0.45 +
        confidence * 0.25 +
        salience * 0.3;

      if (combined < this.minScore) continue;
      const candidate = this.toCandidate({
        entry,
        role,
        source: "thread",
        provenance: inferProvenance(entry),
        confidence,
        relevanceScore: relevance,
        recencyScore: recency,
        salienceScore: salience,
        combinedScore: clamp01(combined),
      });
      scored.push(candidate);
      if (scored.length >= this.maxCandidatesPerRole) break;
    }

    return scored.sort((a, b) => b.combinedScore - a.combinedScore);
  }

  private async retrieveVectorCandidates(
    message: string,
    sessionId: string,
    now: number,
    role: RetrievalMemoryRole,
    embedding: number[],
  ): Promise<RetrievalCandidate[]> {
    const searchResults = await this.vectorBackend.searchHybrid(
      message,
      embedding,
      {
        limit: this.maxCandidatesPerRole,
        sessionId,
        vectorWeight: this.hybridVectorWeight,
        keywordWeight: this.hybridKeywordWeight,
        memoryRoles: [role],
      },
    );

    const scored: RetrievalCandidate[] = [];
    for (const result of searchResults) {
      const entryRole = inferRole(result.entry, role);
      if (entryRole !== role) continue;

      const recency = this.computeRecency(result.entry.timestamp, now);
      const confidence = inferConfidence(result.entry);
      const salience = inferSalience(result.entry);
      const blended =
        computeRetrievalScore(
          result.score,
          result.entry.timestamp,
          now,
          this.recencyWeight,
          this.recencyHalfLifeMs,
        ) *
          0.5 +
        confidence * 0.2 +
        salience * 0.3;

      if (blended < this.minScore) continue;

      scored.push(
        this.toCandidate({
          entry: result.entry,
          role,
          source: "vector",
          provenance: inferProvenance(result.entry),
          confidence,
          relevanceScore: result.score,
          recencyScore: recency,
          salienceScore: salience,
          combinedScore: clamp01(blended),
        }),
      );
    }

    return scored.sort((a, b) => b.combinedScore - a.combinedScore);
  }

  private toCandidate(base: ScoredRetrievalEntry): RetrievalCandidate {
    const canonical = normalizeText(base.entry.content);
    const tokenSet = tokenize(base.entry.content);
    const block = this.formatMemoryBlock(base);
    const blockTokens = estimateTokens(block);
    return {
      ...base,
      canonical,
      tokenSet,
      formattedBlock: block,
      blockTokens,
    };
  }

  private formatMemoryBlock(entry: ScoredRetrievalEntry): string {
    return `<memory source="${attrEscape(entry.source)}" role="${entry.role}" provenance="${attrEscape(entry.provenance)}" confidence="${entry.confidence.toFixed(2)}" salience="${entry.salienceScore.toFixed(2)}" score="${entry.combinedScore.toFixed(2)}">\n${entry.entry.content}\n</memory>`;
  }

  private packRoleCandidates(
    candidates: readonly RetrievalCandidate[],
    roleBudget: number,
    alreadySelected: readonly RetrievalCandidate[],
  ): RetrievalCandidate[] {
    if (roleBudget <= 0) return [];

    let remaining = roleBudget;
    const selected: RetrievalCandidate[] = [];
    for (const candidate of candidates) {
      if (candidate.blockTokens > remaining) continue;
      if (this.isTooSimilar(candidate, [...alreadySelected, ...selected])) {
        continue;
      }
      selected.push(candidate);
      remaining -= candidate.blockTokens;
      if (remaining <= 0) break;
    }
    return selected;
  }

  private deduplicateCandidates(
    candidates: readonly RetrievalCandidate[],
  ): RetrievalCandidate[] {
    const bestByCanonical = new Map<string, RetrievalCandidate>();
    for (const candidate of candidates) {
      const existing = bestByCanonical.get(candidate.canonical);
      if (!existing || existing.combinedScore < candidate.combinedScore) {
        bestByCanonical.set(candidate.canonical, candidate);
      }
    }

    const deduped = Array.from(bestByCanonical.values()).sort(
      (a, b) => b.combinedScore - a.combinedScore,
    );

    const selected: RetrievalCandidate[] = [];
    for (const candidate of deduped) {
      if (this.isTooSimilar(candidate, selected)) continue;
      selected.push(candidate);
    }
    return selected;
  }

  private isTooSimilar(
    candidate: RetrievalCandidate,
    selected: readonly RetrievalCandidate[],
  ): boolean {
    for (const existing of selected) {
      const similarity = jaccard(candidate.tokenSet, existing.tokenSet);
      if (similarity >= this.diversityThreshold) {
        return true;
      }
    }
    return false;
  }

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
