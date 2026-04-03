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

const MAX_TCP_PORT = 65535;

function validatePositiveInteger(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    errors.push(`${field} must be a positive integer`);
  }
}

function validatePositiveNumber(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(`${field} must be a positive number`);
  }
}

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
    if (typeof c.bridge_port !== "number" || c.bridge_port < 1 || c.bridge_port > MAX_TCP_PORT) {
      errors.push(`bridge_port must be a number between 1 and ${MAX_TCP_PORT}`);
    }
  }

  if (c.event_port !== undefined) {
    if (typeof c.event_port !== "number" || c.event_port < 1 || c.event_port > MAX_TCP_PORT) {
      errors.push(`event_port must be a number between 1 and ${MAX_TCP_PORT}`);
    }
  }

  validatePositiveInteger(c.reflection_interval, "reflection_interval", errors);
  validatePositiveInteger(c.consolidation_interval, "consolidation_interval", errors);
  validatePositiveInteger(c.max_concurrent_simulations, "max_concurrent_simulations", errors);
  validatePositiveInteger(c.max_historical_simulations, "max_historical_simulations", errors);
  validatePositiveInteger(c.archived_simulation_retention_ms, "archived_simulation_retention_ms", errors);
  validatePositiveInteger(c.replay_buffer_limit, "replay_buffer_limit", errors);
  validatePositiveInteger(c.archived_replay_event_limit, "archived_replay_event_limit", errors);
  validatePositiveInteger(c.runner_startup_timeout_ms, "runner_startup_timeout_ms", errors);
  validatePositiveInteger(c.runner_shutdown_timeout_ms, "runner_shutdown_timeout_ms", errors);
  validatePositiveInteger(c.step_stuck_timeout_ms, "step_stuck_timeout_ms", errors);
  validatePositiveInteger(c.act_timeout_ms, "act_timeout_ms", errors);
  validatePositiveInteger(c.generate_agents_timeout_ms, "generate_agents_timeout_ms", errors);
  validatePositiveInteger(c.simultaneous_max_workers, "simultaneous_max_workers", errors);
  validatePositiveNumber(c.proxy_action_timeout_seconds, "proxy_action_timeout_seconds", errors);
  validatePositiveInteger(c.proxy_action_max_retries, "proxy_action_max_retries", errors);
  validatePositiveNumber(c.proxy_retry_delay_seconds, "proxy_retry_delay_seconds", errors);

  return { valid: errors.length === 0, errors };
}

export function createChannelAdapter(): ChannelAdapter<ConcordiaChannelConfig> {
  return new ConcordiaChannelAdapter();
}

// Re-export types for consumers
export type {
  ConcordiaAlignedDocumentStatus,
  ConcordiaCompatibilityShimStatus,
  ConcordiaMigrationStatus,
  ConcordiaRollbackPoint,
  ConcordiaSchemaCompatibility,
  ConcordiaChannelConfig,
} from "./types.js";
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

// Re-export checkpoint manifest helpers (Phase 5)
export {
  buildCheckpointMetadataFromManifest,
  buildCheckpointStatusFromManifest,
  buildDefaultSubsystemRestore,
  normalizeCheckpointManifest,
} from "./checkpoint-manifest.js";
export type * from "./checkpoint-manifest.js";

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

// Re-export benchmark alignment helpers (Phase 12)
export {
  MEMORY_ARENA_INSPIRED_SCENARIOS,
  summarizeConcordiaBenchmarkResults,
} from "./benchmark-alignment.js";
export type {
  ConcordiaBenchmarkDimension,
  ConcordiaBenchmarkScenario,
  ConcordiaBenchmarkScenarioResult,
  ConcordiaBenchmarkSummary,
} from "./benchmark-alignment.js";

// Re-export migration compatibility helpers (Phase 11)
export {
  buildConcordiaMigrationStatus,
  CONCORDIA_REQUEST_RESPONSE_SCHEMA_VERSION,
  CONCORDIA_REPLAY_SCHEMA_VERSION,
  CONCORDIA_MEMORY_RESOLVER_CONTRACT_VERSION,
  CONCORDIA_HEADER_REQUEST_SCHEMA,
  CONCORDIA_HEADER_REPLAY_SCHEMA,
  CONCORDIA_HEADER_MIGRATION_STATUS,
  CONCORDIA_HEADER_COMPATIBILITY_SHIM,
  CONCORDIA_HEADER_DEPRECATED,
  COMPAT_SHIM_LEGACY_LAUNCH,
  COMPAT_SHIM_LEGACY_SIMULATION_STATUS,
  COMPAT_SHIM_LEGACY_SIMULATION_CONTROL,
  COMPAT_SHIM_LEGACY_AGENT_STATE,
} from "./migration-compatibility.js";

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
