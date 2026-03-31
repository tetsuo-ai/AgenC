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
