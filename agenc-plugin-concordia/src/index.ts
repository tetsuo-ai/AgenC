/**
 * @tetsuo-ai/plugin-concordia — AgenC Concordia simulation bridge.
 *
 * A ChannelAdapter plugin that bridges Google DeepMind's Concordia
 * generative agent simulation engine to AgenC agents.
 *
 * Required exports per @tetsuo-ai/plugin-kit contract:
 * - manifest: ChannelAdapterManifest
 * - validateConfig: (config: unknown) => ChannelConfigValidationResult
 * - createChannelAdapter: () => ChannelAdapter
 *
 * @module
 */

import type {
  ChannelAdapterManifest,
  ChannelConfigValidationResult,
  ChannelAdapter,
} from "@tetsuo-ai/plugin-kit";
import type { ConcordiaChannelConfig } from "./types.js";
import { ConcordiaChannelAdapter } from "./adapter.js";

export const manifest: ChannelAdapterManifest = {
  schema_version: 1,
  plugin_id: "ai.tetsuo.channel.concordia",
  channel_name: "concordia",
  plugin_type: "channel_adapter",
  version: "0.1.0",
  display_name: "Concordia Simulation Bridge",
  description:
    "Bridges Google DeepMind Concordia generative simulations to AgenC agents with persistent memory, identity, and knowledge graphs",
  plugin_api_version: "1.0.0",
  host_api_version: "1.0.0",
};

export function validateConfig(
  config: unknown,
): ChannelConfigValidationResult {
  const errors: string[] = [];

  if (config === null || config === undefined || typeof config !== "object") {
    return { valid: true, errors: [] }; // All fields are optional
  }

  const c = config as Partial<ConcordiaChannelConfig>;

  if (c.bridge_port !== undefined) {
    if (typeof c.bridge_port !== "number" || c.bridge_port < 1 || c.bridge_port > 65535) {
      errors.push("bridge_port must be a number between 1 and 65535");
    }
  }

  if (c.event_port !== undefined) {
    if (typeof c.event_port !== "number" || c.event_port < 1 || c.event_port > 65535) {
      errors.push("event_port must be a number between 1 and 65535");
    }
  }

  if (c.reflection_interval !== undefined) {
    if (typeof c.reflection_interval !== "number" || c.reflection_interval < 1) {
      errors.push("reflection_interval must be a positive integer");
    }
  }

  if (c.consolidation_interval !== undefined) {
    if (typeof c.consolidation_interval !== "number" || c.consolidation_interval < 1) {
      errors.push("consolidation_interval must be a positive integer");
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createChannelAdapter(): ChannelAdapter<ConcordiaChannelConfig> {
  return new ConcordiaChannelAdapter();
}

// Re-export types for consumers
export type { ConcordiaChannelConfig } from "./types.js";
export type { ConcordiaChannelAdapter } from "./adapter.js";

// Re-export memory wiring for consumers (Phases 5 + 10)
export type { MemoryWiringContext } from "./memory-wiring.js";
export {
  ingestObservation,
  setupAgentIdentity,
  recordSocialEvent,
  storePremise,
  getAgentState,
  buildFullActContext,
  updateActivationScores,
  updateTemporalEdges,
  buildGraphContext,
  getSharedContext,
  promoteToSharedMemory,
  checkCollectiveEmergence,
  recordProcedure,
  retrieveProcedures,
  resolveVectorDbPath,
  traceMemoryRetrieval,
  traceMemoryTrustFilter,
  logSimulationEvent,
} from "./memory-wiring.js";

// Re-export simulation memory namespace policy helpers (Phase 4)
export {
  buildConcordiaCarryOverPolicy,
  buildConcordiaMemoryNamespaces,
  resolveConcordiaMemoryContinuityMode,
} from "./memory-namespaces.js";
export type {
  ConcordiaCarryOverPolicy,
  ConcordiaCheckpointMetadata,
  ConcordiaMemoryContinuityMode,
  ConcordiaMemoryNamespaceRefs,
} from "./memory-namespaces.js";

// Re-export memory lifecycle for consumers (Phase 10)
export {
  runPeriodicTasks,
  postSimulationCleanup,
  buildTrustMetadata,
  TRUST_SOURCE_GM,
  TRUST_SOURCE_AGENT,
  TRUST_SOURCE_USER,
  TRUST_SOURCE_EXTERNAL,
} from "./memory-lifecycle.js";

export default { manifest, validateConfig, createChannelAdapter };
