import {
  CONCORDIA_CHECKPOINT_SCHEMA_VERSION,
  CONCORDIA_SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS,
} from "./checkpoint-manifest.js";
import { CONCORDIA_SESSION_DERIVATION_VERSION } from "./session-manager.js";
import type {
  ConcordiaAlignedDocumentStatus,
  ConcordiaCompatibilityShimStatus,
  ConcordiaMigrationStatus,
  ConcordiaRollbackPoint,
  ConcordiaSchemaCompatibility,
} from "./types.js";

export const CONCORDIA_REQUEST_RESPONSE_SCHEMA_VERSION = 2;
export const CONCORDIA_REPLAY_SCHEMA_VERSION = 2;
export const CONCORDIA_MEMORY_RESOLVER_CONTRACT_VERSION = 2;

export const CONCORDIA_HEADER_REQUEST_SCHEMA = "X-Concordia-Request-Schema-Version";
export const CONCORDIA_HEADER_REPLAY_SCHEMA = "X-Concordia-Replay-Schema-Version";
export const CONCORDIA_HEADER_MIGRATION_STATUS = "X-Concordia-Migration-Status";
export const CONCORDIA_HEADER_COMPATIBILITY_SHIM = "X-Concordia-Compatibility-Shim";
export const CONCORDIA_HEADER_DEPRECATED = "X-Concordia-Deprecated";

export const COMPAT_SHIM_LEGACY_LAUNCH = "legacy-launch-endpoint";
export const COMPAT_SHIM_LEGACY_SIMULATION_STATUS = "legacy-simulation-status-alias";
export const COMPAT_SHIM_LEGACY_SIMULATION_CONTROL = "legacy-simulation-control-alias";
export const COMPAT_SHIM_LEGACY_AGENT_STATE = "legacy-agent-state-endpoint";

const REQUEST_RESPONSE_SUPPORTED_VERSIONS = [1, 2] as const;
const REPLAY_SUPPORTED_VERSIONS = [1, 2] as const;
const MEMORY_RESOLVER_SUPPORTED_VERSIONS = [1, 2] as const;

function buildSchemaCompatibility(
  currentVersion: number,
  supportedVersions: readonly number[],
  compatibilityMode: string,
  migrationNotes: readonly string[],
): ConcordiaSchemaCompatibility {
  return {
    current_version: currentVersion,
    supported_versions: supportedVersions,
    compatibility_mode: compatibilityMode,
    migration_notes: migrationNotes,
  };
}

function buildCompatibilityShims(): readonly ConcordiaCompatibilityShimStatus[] {
  return [
    {
      shim_id: COMPAT_SHIM_LEGACY_LAUNCH,
      legacy_surface: "POST /launch",
      current_surface: "POST /simulations",
      status: "active",
      removal_gate: "Remove only after all launcher clients use /simulations directly.",
      rollback_phase: "Phase 3 bridge-owned control plane",
    },
    {
      shim_id: COMPAT_SHIM_LEGACY_SIMULATION_STATUS,
      legacy_surface: "GET /simulation/status",
      current_surface: "GET /simulations/:simulationId/status",
      status: "active",
      removal_gate: "Remove only after no current-alias consumers remain.",
      rollback_phase: "Phase 3 bridge-owned status routing",
    },
    {
      shim_id: COMPAT_SHIM_LEGACY_SIMULATION_CONTROL,
      legacy_surface: "POST /simulation/{play|pause|step|stop}",
      current_surface: "POST /simulations/:simulationId/{play|pause|step|stop}",
      status: "active",
      removal_gate: "Remove only after all control clients send explicit simulationId.",
      rollback_phase: "Phase 3 bridge-owned control routing",
    },
    {
      shim_id: COMPAT_SHIM_LEGACY_AGENT_STATE,
      legacy_surface: "GET /agent/:agentId/state",
      current_surface: "GET /simulations/:simulationId/agents/:agentId/state",
      status: "active",
      removal_gate: "Remove only after legacy viewers stop using implicit current simulation lookups.",
      rollback_phase: "Phase 3 bridge-owned agent-state routing",
    },
  ];
}

function buildRollbackPoints(): readonly ConcordiaRollbackPoint[] {
  return [
    {
      rollback_id: "request-response-schema-v2",
      area: "request and response routing",
      phase: "Phase 3",
      rollback_boundary: "Safe while legacy launch/status/control/state shims remain enabled.",
      rollback_strategy: "Route callers back through the legacy alias endpoints while keeping simulationId-aware internals intact.",
    },
    {
      rollback_id: "session-derivation-v2",
      area: "session ID derivation",
      phase: "Phase 1",
      rollback_boundary: "No safe runtime rollback after concurrent runs are allowed.",
      rollback_strategy: "Only rollback by reverting Phase 1 before rollout; do not re-enable world-scoped derivation in production.",
    },
    {
      rollback_id: "checkpoint-manifest-v3",
      area: "checkpoint manifest compatibility",
      phase: "Phase 5",
      rollback_boundary: "Read compatibility remains for schema versions 1-3.",
      rollback_strategy: "Keep loading old manifests through normalization while continuing to write schema v3 manifests.",
    },
    {
      rollback_id: "replay-schema-v2",
      area: "bridge-owned replay and SSE",
      phase: "Phase 3",
      rollback_boundary: "Safe while replay hydration and legacy status alias both remain available.",
      rollback_strategy: "Fall back to HTTP replay hydration plus current-alias status checks if a newer consumer must be disabled.",
    },
    {
      rollback_id: "memory-resolver-v2",
      area: "simulation-scoped memory namespaces",
      phase: "Phase 4",
      rollback_boundary: "No safe rollback to world-scoped writes once multiple concurrent runs exist.",
      rollback_strategy: "Use lineage and shared-memory policies to relax continuity, but do not revert simulation-scoped namespace enforcement.",
    },
  ];
}

function buildAlignedDocuments(): readonly ConcordiaAlignedDocumentStatus[] {
  return [
    {
      path: "TODO.MD",
      status: "authoritative",
      notes: [
        "Active execution roadmap for the run-scoped simulation system.",
        "Supersedes historical world-scoped lifecycle assumptions.",
      ],
    },
    {
      path: "CONCORDIA_TODO.MD",
      status: "historical-with-banner",
      notes: [
        "Historical implementation notes remain useful, but run identity and isolation are now simulation-scoped.",
        "Legacy endpoint examples are compatibility shims, not the primary product surface.",
      ],
    },
  ];
}

export function buildConcordiaMigrationStatus(
  now = Date.now(),
): ConcordiaMigrationStatus {
  return {
    generated_at: now,
    request_response_schema: buildSchemaCompatibility(
      CONCORDIA_REQUEST_RESPONSE_SCHEMA_VERSION,
      REQUEST_RESPONSE_SUPPORTED_VERSIONS,
      "bridge-owned v2 responses with legacy alias endpoints retained",
      [
        "simulation_id is the primary runtime identity for request and response routing.",
        "Legacy alias endpoints remain active for launch, current-status, legacy control, and agent-state lookups.",
      ],
    ),
    session_id_derivation: buildSchemaCompatibility(
      CONCORDIA_SESSION_DERIVATION_VERSION,
      [CONCORDIA_SESSION_DERIVATION_VERSION],
      "deterministic derivation from simulationId + agentId",
      [
        "World-scoped derivation is intentionally unsupported because it collapses concurrent runs.",
      ],
    ),
    checkpoint_manifest_schema: buildSchemaCompatibility(
      CONCORDIA_CHECKPOINT_SCHEMA_VERSION,
      CONCORDIA_SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS,
      "normalize-on-read, write-latest",
      [
        "Legacy world-scoped manifests are normalized onto simulation-scoped checkpoint metadata.",
        "New checkpoints continue to write schema v3 manifests.",
      ],
    ),
    replay_schema: buildSchemaCompatibility(
      CONCORDIA_REPLAY_SCHEMA_VERSION,
      REPLAY_SUPPORTED_VERSIONS,
      "bridge-owned replay hydration plus SSE streaming",
      [
        "Replay consumers should prefer /simulations/:id/events and /simulations/:id/events/stream.",
        "Legacy status aliases remain only for compatibility checks, not replay transport.",
      ],
    ),
    memory_resolver_contract: buildSchemaCompatibility(
      CONCORDIA_MEMORY_RESOLVER_CONTRACT_VERSION,
      MEMORY_RESOLVER_SUPPORTED_VERSIONS,
      "simulation-scoped memory namespaces with lineage-aware continuity",
      [
        "worldId is scenario metadata, not the primary memory isolation key.",
        "Continuity across runs must be explicit through lineage and carry-over policy.",
      ],
    ),
    compatibility_shims: buildCompatibilityShims(),
    rollback_points: buildRollbackPoints(),
    aligned_documents: buildAlignedDocuments(),
  };
}
