/**
 * Automatic memory ingestion engine.
 *
 * Bridges ephemeral conversation data into persistent semantic memory by
 * capturing turns (embed + store + daily log), generating session summaries,
 * and extracting entities at session end. Provides hook handlers for
 * integration with the Gateway HookDispatcher.
 *
 * Phase 5.4 — depends on embeddings (#1079), vector store (#1082),
 * and structured memory (#1080).
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./embeddings.js";
import type { VectorMemoryBackend } from "./vector-store.js";
import type {
  DailyLogManager,
  CuratedMemoryManager,
  EntityExtractor,
  StructuredMemoryEntry,
} from "./structured.js";
import { NoopEntityExtractor } from "./structured.js";
import type { LLMProvider, LLMMessage } from "../llm/types.js";
import type { HookHandler, HookContext, HookResult } from "../gateway/hooks.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

// ============================================================================
// Configuration
// ============================================================================

export interface IngestionConfig {
  readonly embeddingProvider: EmbeddingProvider;
  readonly vectorStore: VectorMemoryBackend;
  readonly logManager: DailyLogManager;
  readonly curatedMemory: CuratedMemoryManager;
  readonly entityExtractor?: EntityExtractor;
  readonly generateSummaries: boolean;
  readonly llmProvider?: LLMProvider;
  readonly enableDailyLogs?: boolean;
  readonly enableEntityExtraction?: boolean;
  /** Minimum salience score required before turn content is indexed. */
  readonly minTurnSalienceScore?: number;
  /** How many recent entries to inspect for deduplication checks. */
  readonly dedupRecentEntries?: number;
  /** Maximum chars retained for generated/session summaries before indexing. */
  readonly maxSummaryChars?: number;
  readonly logger?: Logger;
}

// ============================================================================
// Result types
// ============================================================================

export interface SessionEndResult {
  readonly summary: string;
  readonly entities: readonly StructuredMemoryEntry[];
  /** Formatted strings for user review — NOT persisted automatically. */
  readonly proposedFacts: readonly string[];
}

// ============================================================================
// Constants
// ============================================================================

const SUMMARY_PROMPT =
  "Summarize this conversation in 2-3 sentences, focusing on key decisions and learnings.";
/** Maximum chars retained per turn message during ingestion. */
const MAX_INGEST_MESSAGE_CHARS = 12_000;
const DEFAULT_MIN_TURN_SALIENCE_SCORE = 0.01;
const DEFAULT_DEDUP_RECENT_ENTRIES = 40;
const DEFAULT_MAX_SUMMARY_CHARS = 1_200;
const DEDUP_SIMILARITY_THRESHOLD = 0.92;
const ACTION_SIGNAL_RE =
  /\b(decide|decision|fix|fixed|resolve|resolved|failed|error|next step|todo|ship|deploy|run|command|retry|blocked|unblocked|summary|root cause)\b/i;
const STRUCTURE_SIGNAL_RE =
  /(```|`|https?:\/\/|\b\d{2,}\b|exitCode|stderr|stdout|\b[A-Z]{2,}\b)/;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function tokenizeForSimilarity(text: string): Set<string> {
  return new Set(
    normalizeForDedup(text)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scoreTurnSalience(userMessage: string, agentResponse: string): number {
  const combined = `${userMessage}\n${agentResponse}`;
  const lenScore = Math.min(1, combined.length / 900);
  const actionScore = ACTION_SIGNAL_RE.test(combined) ? 1 : 0;
  const structureScore = STRUCTURE_SIGNAL_RE.test(combined) ? 1 : 0;
  return clamp01(lenScore * 0.35 + actionScore * 0.4 + structureScore * 0.25);
}

function roundToTwoDecimals(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

function memoryRoleFromMetadata(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const roles: string[] = [];
  if (typeof metadata.memoryRole === "string" && metadata.memoryRole.length > 0) {
    roles.push(metadata.memoryRole);
  }
  if (Array.isArray(metadata.memoryRoles)) {
    for (const value of metadata.memoryRoles) {
      if (typeof value === "string" && value.length > 0) {
        roles.push(value);
      }
    }
  }
  return roles;
}

function normalizeSummary(summary: string, maxChars: number): string {
  const compact = summary.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  if (maxChars <= 3) return compact.slice(0, Math.max(0, maxChars));
  return `${compact.slice(0, maxChars - 3)}...`;
}

function hasSalienceOverrideSignal(text: string): boolean {
  return ACTION_SIGNAL_RE.test(text) || STRUCTURE_SIGNAL_RE.test(text);
}

function truncateForIngestion(text: string): string {
  if (text.length <= MAX_INGEST_MESSAGE_CHARS) return text;
  if (MAX_INGEST_MESSAGE_CHARS <= 3) {
    return text.slice(0, Math.max(0, MAX_INGEST_MESSAGE_CHARS));
  }
  return (
    text.slice(0, MAX_INGEST_MESSAGE_CHARS - 3) +
    "..."
  );
}

// ============================================================================
// MemoryIngestionEngine
// ============================================================================

export class MemoryIngestionEngine {
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly vectorStore: VectorMemoryBackend;
  private readonly logManager: DailyLogManager;
  private readonly curatedMemory: CuratedMemoryManager;
  private readonly entityExtractor: EntityExtractor;
  private readonly generateSummaries: boolean;
  private readonly llmProvider?: LLMProvider;
  private readonly enableDailyLogs: boolean;
  private readonly enableEntityExtraction: boolean;
  private readonly minTurnSalienceScore: number;
  private readonly dedupRecentEntries: number;
  private readonly maxSummaryChars: number;
  private readonly logger: Logger;

  constructor(config: IngestionConfig) {
    this.embeddingProvider = config.embeddingProvider;
    this.vectorStore = config.vectorStore;
    this.logManager = config.logManager;
    this.curatedMemory = config.curatedMemory;
    this.entityExtractor = config.entityExtractor ?? new NoopEntityExtractor();
    this.generateSummaries = config.generateSummaries;
    this.llmProvider = config.llmProvider;
    this.enableDailyLogs = config.enableDailyLogs !== false;
    this.enableEntityExtraction = config.enableEntityExtraction !== false;
    this.minTurnSalienceScore =
      config.minTurnSalienceScore ?? DEFAULT_MIN_TURN_SALIENCE_SCORE;
    this.dedupRecentEntries =
      config.dedupRecentEntries ?? DEFAULT_DEDUP_RECENT_ENTRIES;
    this.maxSummaryChars = config.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
    this.logger = config.logger ?? silentLogger;
  }

  /**
   * Ingest a single conversation turn into semantic memory.
   *
   * Embeds the combined user+agent text, stores it in the vector store,
   * and appends both messages to the daily log. Each operation is
   * independently try/caught — one failure doesn't prevent others.
   */
  async ingestTurn(
    sessionId: string,
    userMessage: string,
    agentResponse: string,
  ): Promise<void> {
    const safeUserMessage = truncateForIngestion(userMessage);
    const safeAgentResponse = truncateForIngestion(agentResponse);
    const combinedText = `User: ${safeUserMessage}\nAssistant: ${safeAgentResponse}`;
    const normalized = normalizeForDedup(combinedText);
    const contentHash = createHash("sha256").update(normalized).digest("hex");
    const salience = scoreTurnSalience(safeUserMessage, safeAgentResponse);
    const hasOverrideSignal = hasSalienceOverrideSignal(combinedText);
    const shouldIndex =
      salience >= this.minTurnSalienceScore || hasOverrideSignal;
    const confidence = roundToTwoDecimals(0.45 + salience * 0.45);

    // 1. Generate embedding
    let embedding: number[] | undefined;
    if (shouldIndex) {
      try {
        embedding = await this.embeddingProvider.embed(combinedText);
      } catch (err) {
        this.logger.error("Failed to generate embedding for turn", err);
      }
    } else {
      this.logger.debug(
        "Skipping vector indexing for low-salience turn",
      );
    }

    // 2. Store in vector store (requires embedding)
    if (embedding) {
      try {
        const wasWorkingDuplicate = await this.isNearDuplicate(
          sessionId,
          combinedText,
          "working",
        );
        if (!wasWorkingDuplicate) {
          await this.vectorStore.storeWithEmbedding(
            {
              sessionId,
              role: "assistant",
              content: combinedText,
              metadata: {
                type: "conversation_turn",
                memoryRole: "working",
                memoryRoles: ["working"],
                provenance: "ingestion:turn",
                confidence,
                salienceScore: roundToTwoDecimals(salience),
                contentHash,
              },
            },
            embedding,
          );
        }

        const wasSemanticDuplicate = await this.isNearDuplicate(
          sessionId,
          combinedText,
          "semantic",
        );
        if (!wasSemanticDuplicate) {
          await this.vectorStore.storeWithEmbedding(
            {
              sessionId,
              role: "assistant",
              content: combinedText,
              metadata: {
                type: "conversation_turn_index",
                memoryRole: "semantic",
                memoryRoles: ["semantic"],
                provenance: "ingestion:turn",
                confidence,
                salienceScore: roundToTwoDecimals(salience),
                contentHash,
              },
            },
            embedding,
          );
        }
      } catch (err) {
        this.logger.error("Failed to store turn in vector store", err);
      }
    }

    // 3. Append to daily log
    if (this.enableDailyLogs) {
      try {
        await this.logManager.append(sessionId, "user", safeUserMessage);
      } catch (err) {
        this.logger.error("Failed to append user message to daily log", err);
      }

      try {
        await this.logManager.append(sessionId, "assistant", safeAgentResponse);
      } catch (err) {
        this.logger.error("Failed to append agent response to daily log", err);
      }
    }
  }

  /**
   * Process session end: generate a summary and extract entities.
   *
   * Summary generation and entity extraction are independent — if one fails,
   * the other's results are still returned.
   */
  async processSessionEnd(
    sessionId: string,
    history: readonly LLMMessage[],
  ): Promise<SessionEndResult> {
    if (history.length === 0) {
      return { summary: "", entities: [], proposedFacts: [] };
    }

    // Build conversation text from history
    const conversationText = history
      .filter((msg) => msg.role === "user" || msg.role === "assistant")
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join("\n");

    // 1. Summary generation
    let summary = "";
    if (this.generateSummaries && this.llmProvider) {
      try {
        const response = await this.llmProvider.chat([
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: conversationText },
        ]);
        summary = normalizeSummary(response.content, this.maxSummaryChars);

        // Store summary with embedding in vector store
        try {
          const embedding = await this.embeddingProvider.embed(summary);
          if (
            !(await this.isNearDuplicate(sessionId, summary, "episodic"))
          ) {
            await this.vectorStore.storeWithEmbedding(
              {
                sessionId,
                role: "system",
                content: summary,
                metadata: {
                  type: "session_summary",
                  priority: "high",
                  memoryRole: "episodic",
                  memoryRoles: ["episodic"],
                  provenance: "ingestion:session_end",
                  confidence: 0.9,
                  salienceScore: 1,
                  contentHash: createHash("sha256")
                    .update(normalizeForDedup(summary))
                    .digest("hex"),
                },
              },
              embedding,
            );
          }
        } catch (err) {
          this.logger.error("Failed to store session summary embedding", err);
        }
      } catch (err) {
        this.logger.error("Failed to generate session summary", err);
        summary = "";
      }
    }

    // 2. Entity extraction
    let entities: StructuredMemoryEntry[] = [];
    if (this.enableEntityExtraction) {
      try {
        entities = await this.entityExtractor.extract(
          conversationText,
          sessionId,
        );

        for (const entity of entities) {
          const confidence = roundToTwoDecimals(entity.confidence);
          const fact = `${entity.entityName}: ${entity.content}`;
          if (await this.isNearDuplicate(sessionId, fact, "semantic")) {
            continue;
          }

          try {
            const entityEmbedding = await this.embeddingProvider.embed(fact);
            await this.vectorStore.storeWithEmbedding(
              {
                sessionId,
                role: "system",
                content: fact,
                metadata: {
                  type: "entity_fact",
                  memoryRole: "semantic",
                  memoryRoles: ["semantic"],
                  provenance: `entity_extractor:${entity.source}`,
                  confidence,
                  salienceScore: confidence,
                  entityName: entity.entityName,
                  entityType: entity.entityType,
                  tags: entity.tags,
                  contentHash: createHash("sha256")
                    .update(normalizeForDedup(fact))
                    .digest("hex"),
                },
              },
              entityEmbedding,
            );
          } catch (storeErr) {
            this.logger.error("Failed to store extracted entity", storeErr);
          }
        }
      } catch (err) {
        this.logger.error("Failed to extract entities", err);
        entities = [];
      }
    }

    // 3. Format proposed facts
    const proposedFacts = entities.map((e) =>
      this.curatedMemory.proposeAddition(e.content, e.source),
    );

    return { summary, entities, proposedFacts };
  }

  /**
   * Process a session compaction event by storing the summary with an embedding.
   */
  async processCompaction(sessionId: string, summary: string): Promise<void> {
    if (summary.trim() === "") return;

    try {
      const normalizedSummary = normalizeSummary(summary, this.maxSummaryChars);
      if (await this.isNearDuplicate(sessionId, normalizedSummary, "episodic")) {
        return;
      }

      const embedding = await this.embeddingProvider.embed(normalizedSummary);
      await this.vectorStore.storeWithEmbedding(
        {
          sessionId,
          role: "system",
          content: normalizedSummary,
          metadata: {
            type: "compaction_summary",
            memoryRole: "episodic",
            memoryRoles: ["episodic"],
            provenance: "ingestion:session_compaction",
            confidence: 0.85,
            salienceScore: 0.9,
            contentHash: createHash("sha256")
              .update(normalizeForDedup(normalizedSummary))
              .digest("hex"),
          },
        },
        embedding,
      );
    } catch (err) {
      this.logger.error("Failed to store compaction summary", err);
    }
  }

  private async isNearDuplicate(
    sessionId: string,
    content: string,
    memoryRole: "working" | "episodic" | "semantic",
  ): Promise<boolean> {
    try {
      const normalized = normalizeForDedup(content);
      const tokenized = tokenizeForSimilarity(content);
      const recent = await this.vectorStore.query({
        sessionId,
        order: "desc",
        limit: this.dedupRecentEntries,
      });

      for (const entry of recent) {
        const roles = memoryRoleFromMetadata(
          entry.metadata as Record<string, unknown> | undefined,
        );
        if (!roles.includes(memoryRole)) continue;

        const existingHash =
          typeof entry.metadata?.contentHash === "string"
            ? entry.metadata.contentHash
            : undefined;
        const existingNormalized = normalizeForDedup(entry.content);
        const hash = createHash("sha256").update(normalized).digest("hex");
        if (existingHash && existingHash === hash) return true;
        if (existingNormalized === normalized) return true;

        const similarity = jaccardSimilarity(
          tokenized,
          tokenizeForSimilarity(entry.content),
        );
        if (similarity >= DEDUP_SIMILARITY_THRESHOLD) return true;
      }
      return false;
    } catch (err) {
      this.logger.error("Failed duplicate check for ingestion entry", err);
      return false;
    }
  }
}

// ============================================================================
// Hook factory
// ============================================================================

/**
 * Create hook handlers that wire the MemoryIngestionEngine into the
 * Gateway lifecycle. All handlers are fire-safe: they always return
 * `{ continue: true }` even on error, and never block the response pipeline.
 */
export function createIngestionHooks(
  engine: MemoryIngestionEngine,
  logger?: Logger,
): HookHandler[] {
  const log = logger ?? silentLogger;

  const turnHook: HookHandler = {
    event: "message:outbound",
    name: "memory-ingestion-turn",
    priority: 200,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      try {
        const { sessionId, userMessage, agentResponse } = ctx.payload;
        if (
          typeof sessionId !== "string" ||
          typeof userMessage !== "string" ||
          typeof agentResponse !== "string"
        ) {
          log.warn(
            "memory-ingestion-turn: missing or invalid payload fields, skipping",
          );
          return { continue: true };
        }

        // Fire-and-forget — do not block the response pipeline
        void engine
          .ingestTurn(sessionId, userMessage, agentResponse)
          .catch((err) => {
            log.error("memory-ingestion-turn: ingestTurn failed", err);
          });
      } catch (err) {
        log.error("memory-ingestion-turn: unexpected error", err);
      }
      return { continue: true };
    },
  };

  const sessionEndHook: HookHandler = {
    event: "session:end",
    name: "memory-ingestion-session-end",
    priority: 200,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      try {
        const { sessionId, history } = ctx.payload;
        if (typeof sessionId !== "string" || !Array.isArray(history)) {
          log.warn(
            "memory-ingestion-session-end: missing or invalid payload fields, skipping",
          );
          return { continue: true };
        }

        const result = await engine.processSessionEnd(
          sessionId,
          history as LLMMessage[],
        );
        ctx.payload.ingestionResult = result;
      } catch (err) {
        log.error(
          "memory-ingestion-session-end: processSessionEnd failed",
          err,
        );
      }
      return { continue: true };
    },
  };

  const compactHook: HookHandler = {
    event: "session:compact",
    name: "memory-ingestion-compact",
    priority: 200,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      try {
        const phase = typeof ctx.payload.phase === "string"
          ? ctx.payload.phase
          : undefined;
        // SessionManager emits compaction hooks for before/after/error phases.
        // Only "after" can carry a usable summary for ingestion.
        if (phase && phase !== "after") {
          return { continue: true };
        }

        const { sessionId, summary } = ctx.payload;
        if (typeof sessionId !== "string" || typeof summary !== "string") {
          log.warn(
            "memory-ingestion-compact: missing or invalid payload fields, skipping",
          );
          return { continue: true };
        }

        await engine.processCompaction(sessionId, summary);
      } catch (err) {
        log.error("memory-ingestion-compact: processCompaction failed", err);
      }
      return { continue: true };
    },
  };

  return [turnHook, sessionEndHook, compactHook];
}
