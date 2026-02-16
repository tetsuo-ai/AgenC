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

import type { EmbeddingProvider } from './embeddings.js';
import type { VectorMemoryBackend } from './vector-store.js';
import type {
  DailyLogManager,
  CuratedMemoryManager,
  EntityExtractor,
  StructuredMemoryEntry,
} from './structured.js';
import { NoopEntityExtractor } from './structured.js';
import type { LLMProvider, LLMMessage } from '../llm/types.js';
import type { HookHandler, HookContext, HookResult } from '../gateway/hooks.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';

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
  'Summarize this conversation in 2-3 sentences, focusing on key decisions and learnings.';

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
    const combinedText = `User: ${userMessage}\nAssistant: ${agentResponse}`;

    // 1. Generate embedding
    let embedding: number[] | undefined;
    try {
      embedding = await this.embeddingProvider.embed(combinedText);
    } catch (err) {
      this.logger.error('Failed to generate embedding for turn', err);
    }

    // 2. Store in vector store (requires embedding)
    if (embedding) {
      try {
        await this.vectorStore.storeWithEmbedding(
          {
            sessionId,
            role: 'assistant',
            content: combinedText,
            metadata: { type: 'conversation_turn' },
          },
          embedding,
        );
      } catch (err) {
        this.logger.error('Failed to store turn in vector store', err);
      }
    }

    // 3. Append to daily log
    if (this.enableDailyLogs) {
      try {
        await this.logManager.append(sessionId, 'user', userMessage);
      } catch (err) {
        this.logger.error('Failed to append user message to daily log', err);
      }

      try {
        await this.logManager.append(sessionId, 'assistant', agentResponse);
      } catch (err) {
        this.logger.error('Failed to append agent response to daily log', err);
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
      return { summary: '', entities: [], proposedFacts: [] };
    }

    // Build conversation text from history
    const conversationText = history
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n');

    // 1. Summary generation
    let summary = '';
    if (this.generateSummaries && this.llmProvider) {
      try {
        const response = await this.llmProvider.chat([
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: conversationText },
        ]);
        summary = response.content;

        // Store summary with embedding in vector store
        try {
          const embedding = await this.embeddingProvider.embed(summary);
          await this.vectorStore.storeWithEmbedding(
            {
              sessionId,
              role: 'system',
              content: summary,
              metadata: { type: 'session_summary', priority: 'high' },
            },
            embedding,
          );
        } catch (err) {
          this.logger.error('Failed to store session summary embedding', err);
        }
      } catch (err) {
        this.logger.error('Failed to generate session summary', err);
        summary = '';
      }
    }

    // 2. Entity extraction
    let entities: StructuredMemoryEntry[] = [];
    if (this.enableEntityExtraction) {
      try {
        entities = await this.entityExtractor.extract(conversationText, sessionId);
      } catch (err) {
        this.logger.error('Failed to extract entities', err);
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
    if (summary.trim() === '') return;

    try {
      const embedding = await this.embeddingProvider.embed(summary);
      await this.vectorStore.storeWithEmbedding(
        {
          sessionId,
          role: 'system',
          content: summary,
          metadata: { type: 'compaction_summary' },
        },
        embedding,
      );
    } catch (err) {
      this.logger.error('Failed to store compaction summary', err);
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
    event: 'message:outbound',
    name: 'memory-ingestion-turn',
    priority: 200,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      try {
        const { sessionId, userMessage, agentResponse } = ctx.payload;
        if (
          typeof sessionId !== 'string' ||
          typeof userMessage !== 'string' ||
          typeof agentResponse !== 'string'
        ) {
          log.warn('memory-ingestion-turn: missing or invalid payload fields, skipping');
          return { continue: true };
        }

        // Fire-and-forget — do not block the response pipeline
        void engine.ingestTurn(sessionId, userMessage, agentResponse).catch((err) => {
          log.error('memory-ingestion-turn: ingestTurn failed', err);
        });
      } catch (err) {
        log.error('memory-ingestion-turn: unexpected error', err);
      }
      return { continue: true };
    },
  };

  const sessionEndHook: HookHandler = {
    event: 'session:end',
    name: 'memory-ingestion-session-end',
    priority: 200,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      try {
        const { sessionId, history } = ctx.payload;
        if (typeof sessionId !== 'string' || !Array.isArray(history)) {
          log.warn('memory-ingestion-session-end: missing or invalid payload fields, skipping');
          return { continue: true };
        }

        const result = await engine.processSessionEnd(
          sessionId,
          history as LLMMessage[],
        );
        ctx.payload.ingestionResult = result;
      } catch (err) {
        log.error('memory-ingestion-session-end: processSessionEnd failed', err);
      }
      return { continue: true };
    },
  };

  const compactHook: HookHandler = {
    event: 'session:compact',
    name: 'memory-ingestion-compact',
    priority: 200,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      try {
        const { sessionId, summary } = ctx.payload;
        if (typeof sessionId !== 'string' || typeof summary !== 'string') {
          log.warn('memory-ingestion-compact: missing or invalid payload fields, skipping');
          return { continue: true };
        }

        await engine.processCompaction(sessionId, summary);
      } catch (err) {
        log.error('memory-ingestion-compact: processCompaction failed', err);
      }
      return { continue: true };
    },
  };

  return [turnHook, sessionEndHook, compactHook];
}
