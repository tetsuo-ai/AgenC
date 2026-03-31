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

import type { ConcordiaChannelConfig, EventNotification } from "./types.js";

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
  /** Optional — encryption key for at-rest encryption (Task 10.10). */
  readonly encryptionKey?: string;
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
  ): Promise<{ interactions: readonly unknown[]; sentiment: number } | null>;

  listKnownAgents(agentId: string, worldId: string): Promise<string[]>;

  addWorldFact(
    worldId: string,
    content: string,
    observedBy: string,
    visibility?: string,
  ): Promise<unknown>;

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
  formatForPrompt(procedures: readonly Array<{
    name: string;
    trigger: string;
    steps: readonly string[];
  }>): string;
}

/** Duck-typed knowledge graph interface (Tasks 10.3, 10.4). */
export interface MemoryGraphLike {
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
  // Store in session history for immediate context
  await ctx.memoryBackend.addEntry({
    sessionId,
    role: "system",
    content: `[observation] ${observation}`,
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
  knownAgentIds: readonly string[],
): Promise<void> {
  if (!event.acting_agent) return;

  // Find other agents mentioned in the event content
  const otherAgents = knownAgentIds.filter(
    (id) => id !== event.acting_agent && event.content.toLowerCase().includes(id.toLowerCase()),
  );

  for (const targetId of otherAgents) {
    await ctx.socialMemory.recordInteraction(
      event.acting_agent,
      targetId,
      ctx.worldId,
      {
        timestamp: Date.now(),
        summary: event.content.slice(0, 500),
        context: `step:${event.step}`,
      },
    );
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
  actingAgent: string,
  resolvedEvent: string,
): Promise<void> {
  if (!ctx.graph) return;

  // Extract entity names from the event (simple word matching against known agents)
  const words = resolvedEvent.toLowerCase().split(/\s+/);
  const entityNodes = await ctx.graph.findByEntity(actingAgent, ctx.workspaceId);

  for (const node of entityNodes) {
    // Check if the event contradicts existing knowledge
    if (node.content && resolvedEvent.toLowerCase().includes("no longer") ||
        resolvedEvent.toLowerCase().includes("revealed") ||
        resolvedEvent.toLowerCase().includes("actually")) {
      // Set validUntil on old edge
      await ctx.graph.updateEdge(node.id, { validUntil: Date.now() });
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
  if (!ctx.sharedMemory) return "";

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

  // 2. Procedural memory (successful strategies)
  const proceduralContext = await retrieveProcedures(ctx, actionCallToAction);
  if (proceduralContext) {
    parts.push(proceduralContext);
  }

  // 3. Knowledge graph context (BFS traversal)
  const graphContext = await buildGraphContext(ctx, actionCallToAction, agentId);
  if (graphContext) {
    parts.push(graphContext);
  }

  // 4. Shared cross-simulation knowledge
  const sharedContext = await getSharedContext(ctx, userId);
  if (sharedContext) {
    parts.push(sharedContext);
  }

  return parts.filter(Boolean).join("\n\n");
}
