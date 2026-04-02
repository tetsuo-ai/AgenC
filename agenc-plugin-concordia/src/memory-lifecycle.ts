/**
 * Memory lifecycle operations for Concordia simulations.
 *
 * Handles periodic tasks that run during and between simulations:
 * - Reflection (belief formation every N steps)
 * - Consolidation (episodic → semantic every N steps)
 * - Retention (cleanup every N steps)
 * - Activation score updates
 * - Export after simulation
 *
 * Phase 10 of the CONCORDIA_TODO.MD implementation plan.
 *
 * @module
 */

import type { MemoryBackendLike, MemoryWiringContext } from "./memory-wiring.js";
import { deriveSessionId } from "./session-manager.js";

// ============================================================================
// Periodic task scheduling
// ============================================================================

export interface PeriodicTaskConfig {
  readonly reflectionInterval: number;   // Run reflection every N steps
  readonly consolidationInterval: number; // Run consolidation every N steps
  readonly retentionInterval: number;     // Run retention every N steps
}

const DEFAULT_CONFIG: PeriodicTaskConfig = {
  reflectionInterval: 5,
  consolidationInterval: 20,
  retentionInterval: 20,
};

/**
 * Check and run periodic memory tasks based on current step.
 * Fire-safe — errors are logged but never propagate.
 */
export async function runPeriodicTasks(
  ctx: MemoryWiringContext,
  step: number,
  agentIds: readonly string[],
  config: Partial<PeriodicTaskConfig> = {},
  logger?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void },
): Promise<void> {
  const c = { ...DEFAULT_CONFIG, ...config };

  // Reflection: update agent beliefs based on recent experience
  if (step > 0 && step % c.reflectionInterval === 0) {
    for (const agentId of agentIds) {
      try {
        await runReflectionForAgent(ctx, agentId);
        logger?.debug?.(`[concordia] Reflection complete for ${agentId} at step ${step}`);
      } catch (err) {
        logger?.warn?.(`[concordia] Reflection failed for ${agentId}:`, err);
      }
    }
  }

  // Consolidation: compress episodic memories into semantic facts
  if (step > 0 && step % c.consolidationInterval === 0) {
    try {
      await runConsolidation(ctx);
      logger?.debug?.(`[concordia] Consolidation complete at step ${step}`);
    } catch (err) {
      logger?.warn?.(`[concordia] Consolidation failed:`, err);
    }
  }

  // Retention: clean up expired/cold entries
  if (step > 0 && step % c.retentionInterval === 0) {
    try {
      await runRetention(ctx);
      logger?.debug?.(`[concordia] Retention cleanup at step ${step}`);
    } catch (err) {
      logger?.warn?.(`[concordia] Retention failed:`, err);
    }
  }
}

// ============================================================================
// Individual lifecycle operations
// ============================================================================

/**
 * Run reflection for a single agent — synthesize beliefs from recent experience.
 *
 * In a full integration with @tetsuo-ai/runtime, this would call:
 *   import { runReflection } from "@tetsuo-ai/runtime/memory/reflection";
 *
 * The duck-typed version stores a reflection summary in the agent's KV store.
 */
async function runReflectionForAgent(
  ctx: MemoryWiringContext,
  agentId: string,
): Promise<void> {
  if (ctx.lifecycle) {
    await ctx.lifecycle.reflectAgent({
      agentId,
      sessionId: deriveSessionId(ctx.worldId, agentId),
      workspaceId: ctx.workspaceId,
    });
    return;
  }

  // Load the agent's identity
  const identity = await ctx.identityManager.load(agentId, ctx.workspaceId);
  if (!identity) return;

  // Store a reflection marker so the system knows when it last ran
  await ctx.memoryBackend.set(
    `${ctx.workspaceId}:reflection:${agentId}:latest`,
    {
      agentId,
      worldId: ctx.worldId,
      timestamp: Date.now(),
      beliefCount: Object.keys(identity.beliefs).length,
      traitCount: identity.learnedTraits.length,
    },
  );
}

/**
 * Run consolidation — compress episodic memories into semantic facts.
 *
 * In a full integration, this would call:
 *   import { runConsolidation } from "@tetsuo-ai/runtime/memory/consolidation";
 */
async function runConsolidation(ctx: MemoryWiringContext): Promise<void> {
  if (ctx.lifecycle) {
    await ctx.lifecycle.consolidate({ workspaceId: ctx.workspaceId });
    return;
  }

  await ctx.memoryBackend.set(
    `${ctx.workspaceId}:consolidation:${ctx.worldId}:latest`,
    {
      worldId: ctx.worldId,
      timestamp: Date.now(),
      status: "completed",
    },
  );
}

/**
 * Run retention cleanup — remove expired/cold entries.
 *
 * In a full integration, this would call:
 *   import { runRetention } from "@tetsuo-ai/runtime/memory/consolidation";
 */
async function runRetention(ctx: MemoryWiringContext): Promise<void> {
  if (ctx.lifecycle) {
    await ctx.lifecycle.retain();
    return;
  }

  await ctx.memoryBackend.set(
    `${ctx.workspaceId}:retention:${ctx.worldId}:latest`,
    {
      worldId: ctx.worldId,
      timestamp: Date.now(),
      status: "completed",
    },
  );
}

export async function runCheckpointMaintenance(
  ctx: MemoryWiringContext,
): Promise<void> {
  await runConsolidation(ctx);
  await runRetention(ctx);
}

// ============================================================================
// Post-simulation operations
// ============================================================================

/**
 * Run post-simulation cleanup and export.
 */
export async function postSimulationCleanup(
  ctx: MemoryWiringContext,
  agentIds: readonly string[],
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void },
): Promise<Record<string, unknown>> {
  // Final consolidation
  await runConsolidation(ctx);

  // Final retention
  await runRetention(ctx);

  // Final reflection for all agents
  for (const agentId of agentIds) {
    try {
      await runReflectionForAgent(ctx, agentId);
    } catch {
      // Non-blocking
    }
  }

  // Collect summary
  const summary: Record<string, unknown> = {
    worldId: ctx.worldId,
    workspaceId: ctx.workspaceId,
    agentCount: agentIds.length,
    timestamp: Date.now(),
  };

  logger?.info?.(`[concordia] Post-simulation cleanup complete for ${ctx.worldId}`);
  return summary;
}

// ============================================================================
// Trust source tagging helpers
// ============================================================================

/** Trust source for GM-generated observations (highest trust). */
export const TRUST_SOURCE_GM = "system" as const;

/** Trust source for agent-generated actions. */
export const TRUST_SOURCE_AGENT = "agent" as const;

/** Trust source for user-configured premises. */
export const TRUST_SOURCE_USER = "user" as const;

/** Trust source for external/shared memory facts. */
export const TRUST_SOURCE_EXTERNAL = "external" as const;

/**
 * Build metadata with appropriate trust source tagging.
 */
export function buildTrustMetadata(
  source: "system" | "agent" | "user" | "external",
  confidence: number,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    trustSource: source,
    confidence: Math.max(0, Math.min(1, confidence)),
    ...extra,
  };
}
