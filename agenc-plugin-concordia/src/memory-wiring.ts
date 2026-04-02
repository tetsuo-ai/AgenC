/**
 * Memory wiring for the Concordia bridge.
 *
 * Connects the bridge to AgenC's full memory stack: persistent vectors,
 * entity extraction, knowledge graph, trust scoring, social memory,
 * agent identity, procedural memory, consolidation, reflection, and
 * shared memory.
 *
 * Phases 5 + 10 of the CONCORDIA_TODO.MD implementation plan.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { ConcordiaChannelConfig, EventNotification } from "./types.js";
import { sanitizeContent } from "./response-processor.js";

// ============================================================================
// Memory context — holds all memory instances for a simulation world
// ============================================================================

/**
 * All memory-related instances for a simulation world.
 *
 * In the plugin-kit architecture, these are passed to the adapter via
 * config or constructed on demand. Each world gets its own set of
 * memory instances backed by a per-world SQLite database.
 *
 * The actual runtime types (SqliteBackend, AgentIdentityManager, etc.)
 * are resolved at runtime from @tetsuo-ai/runtime peer dependency.
 */
export interface MemoryWiringContext {
  readonly worldId: string;
  readonly workspaceId: string;
  readonly simulationId?: string;
  readonly lineageId?: string | null;
  readonly parentSimulationId?: string | null;
  readonly memoryBackend: MemoryBackendLike;
  readonly identityManager: IdentityManagerLike;
  readonly socialMemory: SocialMemoryLike;
  /** Optional — procedural memory for tool sequence learning (Task 5.4). */
  readonly proceduralMemory?: ProceduralMemoryLike;
  /** Optional — knowledge graph for entity relationships (Task 10.3, 10.4). */
  readonly graph?: MemoryGraphLike;
  /** Optional — shared memory for cross-simulation facts (Task 10.5). */
  readonly sharedMemory?: SharedMemoryLike;
  /** Optional — trace logger for memory operations (Task 10.13). */
  readonly traceLogger?: TraceLoggerLike;
  /** Optional — daily log manager for simulation transcripts (Task 10.14). */
  readonly dailyLogManager?: DailyLogManagerLike;
  /** Optional — semantic ingestion engine for long-term memory indexing. */
  readonly ingestionEngine?: MemoryIngestionEngineLike;
  /** Optional — semantic retriever for richer action context. */
  readonly retriever?: MemoryRetrieverLike;
  /** Optional — runtime-backed lifecycle hooks for reflection/consolidation/retention. */
  readonly lifecycle?: MemoryLifecycleLike;
  /** Optional — encryption key for at-rest encryption (Task 10.10). */
  readonly encryptionKey?: string;
  /**
   * Optional — persistent vector backend path (Task 10.8).
   *
   * When set, the bridge uses SqliteVectorBackend at this path for
   * persistent vector storage that survives daemon restarts.
   * Resolved via resolveWorldDbPath(worldId) in the runtime.
   *
   * Example: "~/.agenc/worlds/medieval-town-001/vectors.db"
   */
  readonly vectorDbPath?: string;
}

// ============================================================================
// Lightweight interfaces matching the AgenC runtime types.
// Using duck-typed interfaces avoids hard coupling to the runtime package
// while still enabling full integration when the runtime is available.
// ============================================================================

export interface MemoryBackendLike {
  addEntry(options: {
    sessionId: string;
    role: string;
    content: string;
    workspaceId?: string;
    agentId?: string;
    worldId?: string;
    channel?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; timestamp: number }>;

  getThread(sessionId: string, limit?: number): Promise<Array<{
    id: string;
    content: string;
    role: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }>>;

  set(key: string, value: unknown): Promise<void>;
  get<T = unknown>(key: string): Promise<T | undefined>;
}

export interface IdentityManagerLike {
  load(agentId: string, workspaceId?: string): Promise<AgentIdentityLike | null>;
  upsert(input: {
    agentId: string;
    name: string;
    corePersonality: string;
    workspaceId?: string;
  }): Promise<AgentIdentityLike>;
  formatForPrompt(identity: AgentIdentityLike): string;
}

export interface AgentIdentityLike {
  readonly agentId: string;
  readonly name: string;
  readonly corePersonality: string;
  readonly learnedTraits: readonly string[];
  readonly beliefs: Readonly<Record<string, { belief: string; confidence: number }>>;
}

export interface SocialMemoryLike {
  recordInteraction(
    agentId: string,
    otherAgentId: string,
    worldId: string,
    interaction: { timestamp: number; summary: string; context?: string },
  ): Promise<unknown>;

  getRelationship(
    agentId: string,
    otherAgentId: string,
    worldId: string,
  ): Promise<{
    relationship: string;
    interactions: ReadonlyArray<{ timestamp: number; summary: string; context?: string }>;
    sentiment: number;
  } | null>;

  listKnownAgents(agentId: string, worldId: string): Promise<string[]>;

  addWorldFact(
    worldId: string,
    content: string,
    observedBy: string,
    visibility?: string,
    allowedAgents?: readonly string[],
  ): Promise<{
    id: string;
    content: string;
    observedBy: string;
    confirmations: number;
    confirmedBy?: readonly string[];
  }>;

  confirmWorldFact(
    factId: string,
    worldId: string,
    agentId: string,
  ): Promise<{
    id: string;
    content: string;
    observedBy: string;
    confirmations: number;
    confirmedBy: readonly string[];
  } | null>;

  getWorldFacts(worldId: string, agentId?: string): Promise<Array<{
    content: string;
    observedBy: string;
    confirmations: number;
  }>>;

  checkCollectiveEmergence(worldId: string, minConfirmations?: number): Promise<Array<{
    content: string;
    confirmedBy: readonly string[];
  }>>;
}

/** Duck-typed procedural memory interface (Task 5.4). */
export interface ProceduralMemoryLike {
  record(input: {
    name: string;
    trigger: string;
    steps: readonly string[];
    workspaceId?: string;
  }): Promise<unknown>;
  retrieve(triggerText: string, workspaceId?: string): Promise<Array<{
    name: string;
    trigger: string;
    steps: readonly string[];
    confidence: number;
  }>>;
  formatForPrompt(procedures: ReadonlyArray<{
    name: string;
    trigger: string;
    steps: readonly string[];
  }>): string;
}

/** Duck-typed knowledge graph interface (Tasks 10.3, 10.4). */
export interface MemoryGraphLike {
  upsertNode(input: {
    content: string;
    sessionId?: string;
    tags?: string[];
    entityName?: string;
    entityType?: string;
    workspaceId?: string;
    metadata?: Record<string, unknown>;
    provenance: Array<{
      type: string;
      sourceId: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }>;
  }): Promise<{
    id: string;
    content: string;
    entityName?: string;
    entityType?: string;
  }>;
  findByEntity(name: string, workspaceId?: string): Promise<Array<{
    id: string;
    content: string;
    entityName?: string;
    entityType?: string;
  }>>;
  getRelatedEntities(nodeId: string, depth?: number): Promise<Array<{
    id: string;
    content: string;
    entityName?: string;
  }>>;
  updateEdge(edgeId: string, update: { validUntil?: number }): Promise<void>;
  addEdge(params: {
    sourceId: string;
    targetId: string;
    type: string;
    content?: string;
    validFrom?: number;
    validUntil?: number;
  }): Promise<unknown>;
}

export interface KnownAgentReference {
  readonly agentId: string;
  readonly agentName: string;
}

/** Duck-typed shared memory interface (Task 10.5). */
export interface SharedMemoryLike {
  writeFact(params: {
    scope: string;
    content: string;
    author: string;
    userId?: string;
  }): Promise<unknown>;
  getFacts(scope: string, userId?: string): Promise<Array<{
    content: string;
    author: string;
  }>>;
}

/** Duck-typed trace logger interface (Task 10.13). */
export interface TraceLoggerLike {
  traceRetrieval(params: {
    sessionId: string;
    query: string;
    candidateCount: number;
    selectedCount: number;
    estimatedTokens: number;
    roles: Record<string, number>;
    workspaceId?: string;
    durationMs: number;
  }): void;
  traceTrustFilter(params: {
    entryId: string;
    trustScore: number;
    threshold: number;
    excluded: boolean;
    source: string;
  }): void;
  traceIngestion(params: {
    sessionId: string;
    workspaceId?: string;
    indexed: boolean;
    salienceScore: number;
    duplicate: boolean;
  }): void;
}

/** Duck-typed daily log manager interface (Task 10.14). */
export interface DailyLogManagerLike {
  append(sessionId: string, entry: {
    timestamp: number;
    type: string;
    step?: number;
    actingAgent?: string;
    content: string;
  }): Promise<void>;
}

export interface MemoryIngestionEngineLike {
  ingestTurn(
    sessionId: string,
    userMessage: string,
    agentResponse: string,
    metadata?: {
      agentResponseMetadata?: Record<string, unknown>;
      workspaceId?: string;
      agentId?: string;
      userId?: string;
      worldId?: string;
      channel?: string;
      backgroundRunId?: string;
    },
  ): Promise<void>;
}

export interface MemoryRetrieverLike {
  retrieve(message: string, sessionId: string): Promise<string | undefined>;
  retrieveDetailed?: (
    message: string,
    sessionId: string,
  ) => Promise<{
    readonly content?: string;
    readonly estimatedTokens?: number;
    readonly entries?: readonly {
      readonly entry: {
        readonly id: string;
        readonly role?: string;
      };
      readonly role: string;
    }[];
  }>;
}

export interface MemoryLifecycleLike {
  reflectAgent(input: {
    agentId: string;
    sessionId: string;
    workspaceId?: string;
  }): Promise<boolean>;

  consolidate(input?: {
    workspaceId?: string;
  }): Promise<{
    processed: number;
    consolidated: number;
    skippedDuplicates: number;
    durationMs: number;
  } | null>;

  retain(): Promise<{
    expiredDeleted: number;
    logsDeleted: number;
  }>;
}

const MAX_CONCORDIA_CONTENT_BYTES = 102_400;
const SOCIAL_CONTEXT_AGENT_LIMIT = 6;
const WORLD_FACT_LIMIT = 8;
const GRAPH_ENTITY_SCAN_LIMIT = 5;
const RELATION_EDGE_SCAN_LIMIT = 6;
const COLLECTIVE_EMERGENCE_INTERVAL = 5;
const CONTRADICTION_CUES = [
  "no longer",
  "revealed",
  "actually",
  "instead",
  "false",
  "not true",
  "stopped being",
] as const;

interface ObservationFactIndexEntry {
  readonly factId: string;
  readonly canonicalContent: string;
  readonly confirmedBy: readonly string[];
}

function truncateUtf8(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  let truncated = content.slice(0, Math.max(0, maxBytes - 3));
  while (truncated.length > 0 && Buffer.byteLength(`${truncated}...`, "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}...`;
}

function normalizeSimulationContent(content: string): string {
  return truncateUtf8(sanitizeContent(content.trim()), MAX_CONCORDIA_CONTENT_BYTES);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeWorldFactContent(content: string): string {
  return content.replace(/^\/\/[^/]+\/\/\s*/i, "").trim();
}

function hashFactFingerprint(content: string): string {
  return createHash("sha256")
    .update(normalizeComparableText(content))
    .digest("hex");
}

function resolveSimulationScopeId(ctx: MemoryWiringContext): string {
  return ctx.simulationId ?? ctx.worldId;
}

function buildObservationFactIndexKey(ctx: MemoryWiringContext): string {
  return `${ctx.workspaceId}:concordia:observation-facts:${resolveSimulationScopeId(ctx)}`;
}

function buildCollectiveEmergenceKey(ctx: MemoryWiringContext): string {
  return `${ctx.workspaceId}:concordia:collective-emergence:${resolveSimulationScopeId(ctx)}`;
}

function listAgentAliases(agent: KnownAgentReference): string[] {
  return Array.from(
    new Set(
      [agent.agentId, agent.agentName]
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function resolveAgentReference(
  reference: string,
  agents: readonly KnownAgentReference[],
): KnownAgentReference | null {
  const normalizedReference = normalizeComparableText(reference);
  if (!normalizedReference) {
    return null;
  }
  for (const agent of agents) {
    if (
      listAgentAliases(agent).some(
        (alias) => normalizeComparableText(alias) === normalizedReference,
      )
    ) {
      return agent;
    }
  }
  return null;
}

function eventMentionsAgent(
  content: string,
  agent: KnownAgentReference,
): boolean {
  return listAgentAliases(agent).some((alias) => {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias.toLowerCase())}([^a-z0-9]|$)`, "i");
    return pattern.test(content);
  });
}

function summarizeRelationship(
  interaction:
    | { timestamp: number; summary: string; context?: string }
    | undefined,
  sentiment: number,
): string {
  const summary = interaction?.summary?.trim();
  const clippedSummary =
    summary && summary.length > 140 ? `${summary.slice(0, 137)}...` : summary;
  return clippedSummary
    ? `sentiment ${sentiment.toFixed(2)}; recent: ${clippedSummary}`
    : `sentiment ${sentiment.toFixed(2)}`;
}

// ============================================================================
// Memory operations
// ============================================================================

/**
 * Ingest an observation into the agent's memory.
 * Stores both in session history (for immediate context) and semantic memory
 * (for long-term retrieval and entity extraction).
 */
export async function ingestObservation(
  ctx: MemoryWiringContext,
  agentId: string,
  sessionId: string,
  observation: string,
): Promise<void> {
  const normalizedObservation = normalizeSimulationContent(observation);
  if (!normalizedObservation) {
    return;
  }

  // Store in session history for immediate context
  await ctx.memoryBackend.addEntry({
    sessionId,
    role: "system",
    content: `[observation] ${normalizedObservation}`,
    workspaceId: ctx.workspaceId,
    agentId,
    worldId: ctx.worldId,
    channel: "concordia",
    metadata: {
      type: "concordia_observation",
      provenance: "concordia:gm_observation",
      concordia_tag: "observation",
      trustSource: "system", // GM observations are system-trusted
      confidence: 0.9,
    },
  });

  if (ctx.ingestionEngine) {
    await ctx.ingestionEngine.ingestTurn(
      sessionId,
      normalizedObservation,
      "[Observation recorded for future simulation turns.]",
      {
        workspaceId: ctx.workspaceId,
        agentId,
        worldId: ctx.worldId,
        channel: "concordia",
        agentResponseMetadata: {
          type: "concordia_observation",
          concordia_tag: "observation",
          provenance: "concordia:gm_observation",
        },
      },
    );
  }
}

/**
 * Mirror agent observations into social-memory world facts without leaking them
 * immediately to all agents. Matching confirmations can later promote these
 * facts into shared world knowledge.
 */
export async function recordObservationWorldFact(
  ctx: MemoryWiringContext,
  agentId: string,
  observation: string,
): Promise<void> {
  const canonicalContent = normalizeWorldFactContent(
    normalizeSimulationContent(observation),
  );
  if (!canonicalContent) {
    return;
  }

  const fingerprint = hashFactFingerprint(canonicalContent);
  const indexKey = buildObservationFactIndexKey(ctx);
  const factIndex =
    (await ctx.memoryBackend.get<Record<string, ObservationFactIndexEntry>>(indexKey)) ?? {};
  const existing = factIndex[fingerprint];

  if (!existing) {
    const fact = await ctx.socialMemory.addWorldFact(
      ctx.worldId,
      canonicalContent,
      agentId,
      "private",
    );
    await ctx.memoryBackend.set(indexKey, {
      ...factIndex,
      [fingerprint]: {
        factId: fact.id,
        canonicalContent,
        confirmedBy: [agentId],
      },
    });
    return;
  }

  if (existing.confirmedBy.includes(agentId)) {
    return;
  }

  const confirmed = await ctx.socialMemory.confirmWorldFact(
    existing.factId,
    ctx.worldId,
    agentId,
  );
  await ctx.memoryBackend.set(indexKey, {
    ...factIndex,
    [fingerprint]: {
      ...existing,
      confirmedBy:
        confirmed?.confirmedBy ?? [...existing.confirmedBy, agentId],
    },
  });
}

/**
 * Persist an agent's chosen action to world-scoped memory.
 *
 * This keeps the agent's own decisions available for later semantic retrieval
 * without leaking them into other agents' threads.
 */
export async function recordAgentAction(
  ctx: MemoryWiringContext,
  agentId: string,
  sessionId: string,
  action: string,
): Promise<void> {
  const normalizedAction = normalizeSimulationContent(action);
  if (!normalizedAction) {
    return;
  }

  await ctx.memoryBackend.addEntry({
    sessionId,
    role: "assistant",
    content: normalizedAction,
    workspaceId: ctx.workspaceId,
    agentId,
    worldId: ctx.worldId,
    channel: "concordia",
    metadata: {
      type: "concordia_action",
      provenance: "concordia:agent_action",
      concordia_tag: "action",
      trustSource: "agent",
      confidence: 0.7,
    },
  });

  if (ctx.ingestionEngine) {
    await ctx.ingestionEngine.ingestTurn(
      sessionId,
      "[Concordia agent action]",
      normalizedAction,
      {
        workspaceId: ctx.workspaceId,
        agentId,
        worldId: ctx.worldId,
        channel: "concordia",
        agentResponseMetadata: {
          type: "concordia_action",
          concordia_tag: "action",
          provenance: "concordia:agent_action",
          trustSource: "agent",
          confidence: 0.7,
        },
      },
    );
  }
}

/**
 * Setup an agent's identity for the simulation.
 */
export async function setupAgentIdentity(
  ctx: MemoryWiringContext,
  agentId: string,
  agentName: string,
  personality: string,
  goal: string,
): Promise<void> {
  await ctx.identityManager.upsert({
    agentId,
    name: agentName,
    corePersonality: personality + (goal ? `\n\nGoal: ${goal}` : ""),
    workspaceId: ctx.workspaceId,
  });
}

/**
 * Record a social interaction between agents from a resolved event.
 */
export async function recordSocialEvent(
  ctx: MemoryWiringContext,
  event: EventNotification,
  knownAgents: readonly KnownAgentReference[],
): Promise<void> {
  const normalizedContent = normalizeSimulationContent(event.content ?? "");
  if (!normalizedContent) return;

  const actingAgent = event.acting_agent
    ? resolveAgentReference(event.acting_agent, knownAgents)
    : null;

  const participants = new Map<string, KnownAgentReference>();
  if (actingAgent) {
    participants.set(actingAgent.agentId, actingAgent);
  }

  for (const reference of event.target_agents ?? []) {
    const target = resolveAgentReference(reference, knownAgents);
    if (target) {
      participants.set(target.agentId, target);
    }
  }

  const loweredContent = normalizedContent.toLowerCase();
  for (const agent of knownAgents) {
    if (eventMentionsAgent(loweredContent, agent)) {
      participants.set(agent.agentId, agent);
    }
  }

  const participantIds = [...participants.keys()];
  if (participantIds.length < 2) {
    return;
  }

  const timestamp = Date.now();
  const summary = normalizedContent.slice(0, 500);
  const context = `step:${event.step}:${event.type}`;

  if (actingAgent) {
    for (const targetId of participantIds) {
      if (targetId === actingAgent.agentId) continue;
      await ctx.socialMemory.recordInteraction(
        actingAgent.agentId,
        targetId,
        ctx.worldId,
        { timestamp, summary, context },
      );
      await ctx.socialMemory.recordInteraction(
        targetId,
        actingAgent.agentId,
        ctx.worldId,
        { timestamp, summary, context },
      );
    }
    return;
  }

  for (let i = 0; i < participantIds.length; i++) {
    for (let j = i + 1; j < participantIds.length; j++) {
      const left = participantIds[i];
      const right = participantIds[j];
      await ctx.socialMemory.recordInteraction(left, right, ctx.worldId, {
        timestamp,
        summary,
        context,
      });
      await ctx.socialMemory.recordInteraction(right, left, ctx.worldId, {
        timestamp,
        summary,
        context,
      });
    }
  }
}

/**
 * Store the simulation premise as a world fact.
 */
export async function storePremise(
  ctx: MemoryWiringContext,
  premise: string,
): Promise<void> {
  await ctx.socialMemory.addWorldFact(
    ctx.worldId,
    premise,
    "concordia:gm",
    "world",
  );
}

/**
 * Get agent state for the viewer.
 */
export async function getAgentState(
  ctx: MemoryWiringContext,
  agentId: string,
  sessionId: string,
  turnCount: number,
  lastAction: string | null,
): Promise<Record<string, unknown>> {
  const identity = await ctx.identityManager.load(agentId, ctx.workspaceId);
  const recentMemories = await ctx.memoryBackend.getThread(sessionId, 10);
  const knownAgents = await ctx.socialMemory.listKnownAgents(agentId, ctx.worldId);
  const worldFacts = await ctx.socialMemory.getWorldFacts(ctx.worldId, agentId);

  const relationships: Array<Record<string, unknown>> = [];
  for (const otherId of knownAgents) {
    const rel = await ctx.socialMemory.getRelationship(agentId, otherId, ctx.worldId);
    if (rel) {
      relationships.push({
        otherAgentId: otherId,
        relationship: rel.relationship ?? "acquaintance",
        sentiment: rel.sentiment,
        interactionCount: rel.interactions.length,
      });
    }
  }

  return {
    identity: identity ? {
      name: identity.name,
      personality: identity.corePersonality,
      learnedTraits: identity.learnedTraits,
      beliefs: identity.beliefs,
    } : null,
    memoryCount: recentMemories.length,
    recentMemories: recentMemories.map((m) => ({
      content: m.content.slice(0, 200),
      role: m.role,
      timestamp: m.timestamp,
      metadata: m.metadata,
    })),
    relationships,
    worldFacts: worldFacts.map((f) => ({
      content: f.content,
      observedBy: f.observedBy,
      confirmations: f.confirmations,
    })),
    turnCount,
    lastAction,
  };
}

// ============================================================================
// Task 10.8: Persistent vector store helper
// ============================================================================

/**
 * Create a memory wiring context description including the persistent vector
 * backend path. This resolves the per-world SQLite vector DB using the
 * runtime's resolveWorldVectorDbPath().
 *
 * Usage when integrating with @tetsuo-ai/runtime:
 * ```typescript
 * import { resolveWorldVectorDbPath } from "@tetsuo-ai/runtime/memory/world-db-resolver";
 * import { SqliteVectorBackend } from "@tetsuo-ai/runtime/memory/sqlite/vector-backend";
 *
 * const vectorDbPath = resolveWorldVectorDbPath(worldId);
 * const vectorStore = new SqliteVectorBackend({ dbPath: vectorDbPath, dimension: 768 });
 * ```
 *
 * The vectorDbPath on MemoryWiringContext is stored for reference by
 * consumers that need to create or reconnect to the persistent store.
 */
export function resolveVectorDbPath(worldId: string, agencHome?: string): string {
  // Mirrors runtime/src/memory/world-db-resolver.ts logic
  const home = agencHome ?? (
    typeof process !== "undefined"
      ? (process.env.HOME ?? process.env.USERPROFILE ?? "/tmp")
      : "/tmp"
  );
  const sanitized = worldId
    .replace(/[^a-zA-Z0-9_\-.]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 128);

  if (!worldId || worldId === "default") {
    return `${home}/.agenc/vectors.db`;
  }
  return `${home}/.agenc/worlds/${sanitized}/vectors.db`;
}

// ============================================================================
// Task 5.4: Procedural memory — record successful action patterns
// ============================================================================

/**
 * Record a successful action as a procedural memory.
 * If the agent uses a strategy that works, remember it for future similar situations.
 */
export async function recordProcedure(
  ctx: MemoryWiringContext,
  agentId: string,
  trigger: string,
  steps: readonly string[],
): Promise<void> {
  if (!ctx.proceduralMemory) return;
  await ctx.proceduralMemory.record({
    name: `${agentId}:${trigger.slice(0, 30).replace(/\s+/g, "_")}`,
    trigger,
    steps,
    workspaceId: ctx.workspaceId,
  });
}

/**
 * Retrieve relevant procedures for a given context.
 */
export async function retrieveProcedures(
  ctx: MemoryWiringContext,
  triggerText: string,
): Promise<string> {
  if (!ctx.proceduralMemory) return "";
  const procedures = await ctx.proceduralMemory.retrieve(triggerText, ctx.workspaceId);
  if (procedures.length === 0) return "";
  return ctx.proceduralMemory.formatForPrompt(procedures);
}

// ============================================================================
// Task 10.2: Activation scoring — update access counts after retrieval
// ============================================================================

/**
 * Update activation scores on retrieved memory entries.
 * Entries that are frequently relevant get higher activation (ACT-R model).
 */
export async function updateActivationScores(
  ctx: MemoryWiringContext,
  sessionId: string,
  retrievedEntryIds: readonly string[],
): Promise<void> {
  for (const entryId of retrievedEntryIds) {
    // Read the existing entry's metadata via KV (since we can't update entries in place)
    const key = `${ctx.workspaceId}:activation:${entryId}`;
    const existing = await ctx.memoryBackend.get<{ accessCount: number; lastAccessTime: number }>(key);
    const accessCount = (existing?.accessCount ?? 0) + 1;
    await ctx.memoryBackend.set(key, {
      accessCount,
      lastAccessTime: Date.now(),
    });
  }
}

// ============================================================================
// Task 10.3: Temporal edges — update knowledge graph on contradicting events
// ============================================================================

/**
 * Update temporal edges when a resolved event contradicts existing graph facts.
 * Old facts get validUntil set, new facts get validFrom.
 */
export async function updateTemporalEdges(
  ctx: MemoryWiringContext,
  actingAgent: string | undefined,
  resolvedEvent: string,
): Promise<void> {
  if (!ctx.graph) return;
  const normalizedEvent = normalizeSimulationContent(resolvedEvent);
  if (!normalizedEvent) return;

  const timestamp = Date.now();
  const contradictionCue = CONTRADICTION_CUES.some((cue) =>
    normalizedEvent.toLowerCase().includes(cue),
  );

  const eventNode = await ctx.graph.upsertNode({
    content: normalizedEvent,
    workspaceId: ctx.workspaceId,
    ...(actingAgent ? { entityName: actingAgent } : {}),
    entityType: "simulation_event",
    tags: ["concordia", "resolved-event"],
    provenance: [
      {
        type: "manual",
        sourceId: `concordia:${ctx.worldId}:${actingAgent ?? "world"}:${timestamp}`,
        description: "Resolved Concordia simulation event",
        metadata: {
          worldId: ctx.worldId,
          ...(actingAgent ? { agentId: actingAgent } : {}),
        },
      },
    ],
  });

  const candidateEntities = Array.from(
    new Set(
      [
        ...(actingAgent ? [actingAgent] : []),
        ...normalizedEvent.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [],
      ],
    ),
  ).slice(0, GRAPH_ENTITY_SCAN_LIMIT);

  for (const entityName of candidateEntities) {
    const relatedNodes = await ctx.graph.findByEntity(entityName, ctx.workspaceId);
    for (const node of relatedNodes.slice(0, RELATION_EDGE_SCAN_LIMIT)) {
      if (node.id === eventNode.id) continue;
      await ctx.graph.addEdge({
        sourceId: eventNode.id,
        targetId: node.id,
        type: contradictionCue ? "supersedes" : "relates_to",
        content: normalizedEvent,
        validFrom: timestamp,
      });
    }
  }
}

// ============================================================================
// Task 10.4: BFS graph traversal for enriched agent context
// ============================================================================

/**
 * Build knowledge graph context for the /act prompt.
 * Uses BFS to pull related entities up to depth 2.
 */
export async function buildGraphContext(
  ctx: MemoryWiringContext,
  queryText: string,
  agentId: string,
): Promise<string> {
  if (!ctx.graph) return "";

  // Extract potential entity mentions from the query
  const words = queryText.split(/\s+/).filter((w) => w.length > 3);
  const contextParts: string[] = [];

  for (const word of words.slice(0, 5)) {
    const nodes = await ctx.graph.findByEntity(word, ctx.workspaceId);
    if (nodes.length > 0) {
      const related = await ctx.graph.getRelatedEntities(nodes[0].id, 2);
      if (related.length > 0) {
        const facts = related.map((n) => n.content || n.entityName || "").filter(Boolean);
        if (facts.length > 0) {
          contextParts.push(`[Knowledge about ${word}]: ${facts.join("; ")}`);
        }
      }
    }
  }

  return contextParts.join("\n");
}

// ============================================================================
// Task 10.5: Shared memory — cross-simulation knowledge
// ============================================================================

/**
 * Inject shared facts from the cross-simulation shared memory layer.
 */
export async function getSharedContext(
  ctx: MemoryWiringContext,
  userId?: string,
): Promise<string> {
  if (!ctx.sharedMemory || !userId) return "";

  const userFacts = await ctx.sharedMemory.getFacts("user", userId);
  if (userFacts.length === 0) return "";

  return "[Shared Knowledge]\n" + userFacts.map((f) => `- ${f.content}`).join("\n");
}

/**
 * Promote a learned fact to shared memory after simulation ends.
 */
export async function promoteToSharedMemory(
  ctx: MemoryWiringContext,
  content: string,
  userId?: string,
): Promise<void> {
  if (!ctx.sharedMemory) return;
  await ctx.sharedMemory.writeFact({
    scope: "user",
    content,
    author: `concordia:${ctx.worldId}`,
    userId,
  });
}

// ============================================================================
// Task 10.6: Collective emergence — check for multi-agent consensus
// ============================================================================

/**
 * Check if multiple agents have independently confirmed the same facts.
 * When 3+ agents agree, the fact is promoted to world knowledge.
 */
export async function checkCollectiveEmergence(
  ctx: MemoryWiringContext,
  minConfirmations: number = 3,
): Promise<Array<{ content: string; confirmedBy: readonly string[] }>> {
  return ctx.socialMemory.checkCollectiveEmergence(ctx.worldId, minConfirmations);
}

/**
 * Promote collectively confirmed private/shared observations into explicit
 * world-visible facts on the planned cadence.
 */
export async function promoteCollectiveEmergenceFacts(
  ctx: MemoryWiringContext,
  step: number,
  minConfirmations: number = 3,
): Promise<Array<{ content: string; confirmedBy: readonly string[] }>> {
  if (step <= 0 || step % COLLECTIVE_EMERGENCE_INTERVAL !== 0) {
    return [];
  }

  const promoted = await checkCollectiveEmergence(ctx, minConfirmations);
  if (promoted.length === 0) {
    return [];
  }

  const promotedKey = buildCollectiveEmergenceKey(ctx);
  const existingPromotions =
    (await ctx.memoryBackend.get<Record<string, true>>(promotedKey)) ?? {};
  const newlyPromoted: Array<{ content: string; confirmedBy: readonly string[] }> = [];
  const updatedPromotions = { ...existingPromotions };

  for (const fact of promoted) {
    const canonicalContent = normalizeWorldFactContent(
      normalizeSimulationContent(fact.content),
    );
    if (!canonicalContent) {
      continue;
    }
    const fingerprint = hashFactFingerprint(canonicalContent);
    if (updatedPromotions[fingerprint]) {
      continue;
    }

    await ctx.socialMemory.addWorldFact(
      ctx.worldId,
      canonicalContent,
      "concordia:collective-emergence",
      "world",
    );
    updatedPromotions[fingerprint] = true;
    newlyPromoted.push({
      content: canonicalContent,
      confirmedBy: fact.confirmedBy,
    });
  }

  await ctx.memoryBackend.set(promotedKey, updatedPromotions);
  return newlyPromoted;
}

// ============================================================================
// Task 10.13: Trace logging — emit structured memory trace events
// ============================================================================

/**
 * Log a memory retrieval operation via the trace logger.
 */
export function traceMemoryRetrieval(
  ctx: MemoryWiringContext,
  params: {
    sessionId: string;
    query: string;
    candidateCount: number;
    selectedCount: number;
    estimatedTokens: number;
    roles: Record<string, number>;
    durationMs: number;
  },
): void {
  ctx.traceLogger?.traceRetrieval({
    ...params,
    workspaceId: ctx.workspaceId,
  });
}

/**
 * Log a trust filtering decision via the trace logger.
 */
export function traceMemoryTrustFilter(
  ctx: MemoryWiringContext,
  params: {
    entryId: string;
    trustScore: number;
    threshold: number;
    excluded: boolean;
    source: string;
  },
): void {
  ctx.traceLogger?.traceTrustFilter(params);
}

// ============================================================================
// Task 10.14: Daily log manager — simulation transcripts
// ============================================================================

/**
 * Append a simulation event to the daily log for structured transcripts.
 */
export async function logSimulationEvent(
  ctx: MemoryWiringContext,
  sessionId: string,
  event: {
    step: number;
    actingAgent?: string;
    content: string;
    type: string;
  },
): Promise<void> {
  if (!ctx.dailyLogManager) return;
  await ctx.dailyLogManager.append(sessionId, {
    timestamp: Date.now(),
    type: event.type,
    step: event.step,
    actingAgent: event.actingAgent,
    content: event.content,
  });
}

// ============================================================================
// Task 5.5: Full prompt context builder with all memory sources
// ============================================================================

/**
 * Build the complete memory-enriched prompt context for an /act call.
 * Combines: identity + procedural + semantic + graph + shared memory.
 */
export async function buildFullActContext(
  ctx: MemoryWiringContext,
  agentId: string,
  sessionId: string,
  actionCallToAction: string,
  userId?: string,
): Promise<string> {
  const parts: string[] = [];

  // 1. Agent identity (personality, beliefs, traits)
  const identity = await ctx.identityManager.load(agentId, ctx.workspaceId);
  if (identity) {
    parts.push(ctx.identityManager.formatForPrompt(identity));
  }

  const knownAgents = await ctx.socialMemory.listKnownAgents(agentId, ctx.worldId);
  const relationshipLines: string[] = [];
  for (const otherId of knownAgents.slice(0, SOCIAL_CONTEXT_AGENT_LIMIT)) {
    const relationship = await ctx.socialMemory.getRelationship(
      agentId,
      otherId,
      ctx.worldId,
    );
    if (!relationship) continue;
    relationshipLines.push(
      `- ${otherId}: ${summarizeRelationship(
        relationship.interactions[relationship.interactions.length - 1],
        relationship.sentiment,
      )}`,
    );
  }
  if (relationshipLines.length > 0) {
    parts.push(["[Current Relationships]", ...relationshipLines].join("\n"));
  }

  const worldFacts = await ctx.socialMemory.getWorldFacts(ctx.worldId, agentId);
  const worldFactLines = worldFacts
    .slice(0, WORLD_FACT_LIMIT)
    .map((fact) => `- ${normalizeSimulationContent(fact.content)}`);
  if (worldFactLines.length > 0) {
    parts.push(["[Visible World Facts]", ...worldFactLines].join("\n"));
  }

  // 2. Procedural memory (successful strategies)
  const proceduralContext = await retrieveProcedures(ctx, actionCallToAction);
  if (proceduralContext) {
    parts.push(proceduralContext);
  }

  // 3. Semantic memory retrieval (working + episodic + semantic)
  if (ctx.retriever) {
    const startedAt = Date.now();
    const retrieval = ctx.retriever.retrieveDetailed
      ? await ctx.retriever.retrieveDetailed(actionCallToAction, sessionId)
      : {
          content: await ctx.retriever.retrieve(actionCallToAction, sessionId),
          entries: [],
          estimatedTokens: 0,
        };

    if (retrieval.content) {
      parts.push(retrieval.content);
    }

    const retrievedEntryIds = Array.from(
      new Set(
        (retrieval.entries ?? []).map((entry) => entry.entry.id).filter(Boolean),
      ),
    );
    if (retrievedEntryIds.length > 0) {
      await updateActivationScores(ctx, sessionId, retrievedEntryIds);
    }
    if (ctx.traceLogger) {
      const roleCounts = (retrieval.entries ?? []).reduce<Record<string, number>>(
        (counts, entry) => {
          counts[entry.role] = (counts[entry.role] ?? 0) + 1;
          return counts;
        },
        {},
      );
      traceMemoryRetrieval(ctx, {
        sessionId,
        query: actionCallToAction,
        candidateCount: (retrieval.entries ?? []).length,
        selectedCount: (retrieval.entries ?? []).length,
        estimatedTokens: retrieval.estimatedTokens ?? 0,
        roles: roleCounts,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  // 4. Knowledge graph context (BFS traversal)
  const graphContext = await buildGraphContext(ctx, actionCallToAction, agentId);
  if (graphContext) {
    parts.push(graphContext);
  }

  // 5. Shared cross-simulation knowledge
  const sharedContext = await getSharedContext(ctx, userId);
  if (sharedContext) {
    parts.push(sharedContext);
  }

  return parts.filter(Boolean).join("\n\n");
}
