export type ConcordiaCheckpointSubsystem =
  | "gm_state"
  | "entity_states"
  | "scene_cursor"
  | "runtime_cursor"
  | "replay_cursor"
  | "session_mappings"
  | "world_state_refs"
  | "memory_namespaces"
  | "control_port"
  | "event_port"
  | "pending_responses"
  | "live_subscribers"
  | "runner_process";

export interface ConcordiaCheckpointSessionMapping {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly session_id: string;
  readonly simulation_id: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly turn_count: number;
  readonly last_action: string | null;
}

export interface ConcordiaCheckpointSceneCursor {
  readonly scene_index: number;
  readonly scene_round: number;
  readonly current_scene_name?: string | null;
}

export interface ConcordiaCheckpointRuntimeCursor {
  readonly current_step: number;
  readonly start_step: number;
  readonly max_steps: number;
  readonly last_acting_agent?: string | null;
  readonly last_step_outcome?: string | null;
  readonly engine_type?: string | null;
}

export interface ConcordiaCheckpointReplayCursor {
  readonly replay_cursor: number;
  readonly replay_event_count: number;
  readonly last_event_id?: string | null;
}

export interface ConcordiaCheckpointWorldStateRefs {
  readonly source: "inline_checkpoint";
  readonly gm_state_key?: string | null;
  readonly entity_state_keys: readonly string[];
  readonly authoritative_snapshot_ref?: string | null;
}

export interface ConcordiaCheckpointMemoryNamespaceRefs {
  readonly continuity_mode?: "isolated" | "lineage_resume";
  readonly simulation_scope_id?: string;
  readonly lineage_scope_id?: string;
  readonly continuity_scope_id?: string;
  readonly world_scope_id?: string;
  readonly effective_storage_key?: string;
  readonly log_storage_key?: string;
  readonly memory_workspace_id?: string;
  readonly identity_workspace_id?: string;
  readonly procedural_workspace_id?: string;
  readonly graph_workspace_id?: string;
  readonly activation_key_prefix?: string;
  readonly lifecycle_key_prefix?: string;
  readonly observation_fact_index_key?: string;
  readonly collective_emergence_key?: string;
  readonly shared_author?: string;
  readonly shared_source_scope?: string;
}

export interface ConcordiaCheckpointResumeState {
  readonly resumed: readonly ConcordiaCheckpointSubsystem[];
  readonly reset: readonly ConcordiaCheckpointSubsystem[];
}

export interface ConcordiaCheckpointSummary {
  readonly checkpoint_id: string;
  readonly checkpoint_path: string;
  readonly schema_version: number;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly simulation_id: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly step: number;
  readonly timestamp: number;
}

export interface ConcordiaCheckpointManifest extends ConcordiaCheckpointSummary {
  readonly version?: number;
  readonly user_id?: string | null;
  readonly max_steps: number;
  readonly config: Record<string, unknown>;
  readonly restored_sessions: readonly ConcordiaCheckpointSessionMapping[];
  readonly scene_cursor: ConcordiaCheckpointSceneCursor | null;
  readonly runtime_cursor: ConcordiaCheckpointRuntimeCursor;
  readonly replay_cursor: ConcordiaCheckpointReplayCursor;
  readonly world_state_refs: ConcordiaCheckpointWorldStateRefs;
  readonly memory_namespace_refs: ConcordiaCheckpointMemoryNamespaceRefs;
  readonly subsystem_state: ConcordiaCheckpointResumeState;
  readonly entity_logs: Record<string, unknown>;
  readonly entity_states: Record<string, unknown>;
  readonly gm_state: Record<string, unknown>;
  readonly agent_ids: readonly string[];
}

export interface ConcordiaCheckpointStatus extends ConcordiaCheckpointSummary {
  readonly max_steps: number;
  readonly scene_cursor: ConcordiaCheckpointSceneCursor | null;
  readonly runtime_cursor: ConcordiaCheckpointRuntimeCursor;
  readonly replay_cursor: ConcordiaCheckpointReplayCursor;
  readonly world_state_refs: ConcordiaCheckpointWorldStateRefs;
  readonly memory_namespace_refs: ConcordiaCheckpointMemoryNamespaceRefs;
  readonly subsystem_state: ConcordiaCheckpointResumeState;
}

export type ConcordiaSceneCursorState = ConcordiaCheckpointSceneCursor;
export type ConcordiaRuntimeCursorState = ConcordiaCheckpointRuntimeCursor;
export type ConcordiaReplayCursorState = ConcordiaCheckpointReplayCursor;
export type ConcordiaCheckpointSubsystemRestore = ConcordiaCheckpointResumeState;
export type ConcordiaWorldStateRefs = ConcordiaCheckpointWorldStateRefs;

export const CONCORDIA_CHECKPOINT_SCHEMA_VERSION = 3;
export const CONCORDIA_SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS = [1, 2, 3] as const;

const CHECKPOINT_SCHEMA_VERSION = CONCORDIA_CHECKPOINT_SCHEMA_VERSION;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeSessionMapping(value: unknown): ConcordiaCheckpointSessionMapping | null {
  const record = asRecord(value);
  const agentId = asString(record.agent_id);
  const agentName = asString(record.agent_name);
  const sessionId = asString(record.session_id);
  const simulationId = asString(record.simulation_id);
  if (!agentId || !agentName || !sessionId || !simulationId) {
    return null;
  }
  return {
    agent_id: agentId,
    agent_name: agentName,
    session_id: sessionId,
    simulation_id: simulationId,
    lineage_id: asString(record.lineage_id) ?? null,
    parent_simulation_id: asString(record.parent_simulation_id) ?? null,
    turn_count: asNumber(record.turn_count) ?? 0,
    last_action: asString(record.last_action) ?? null,
  };
}

function normalizeSceneCursor(value: unknown): ConcordiaCheckpointSceneCursor | null {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }
  return {
    scene_index: asNumber(record.scene_index) ?? 0,
    scene_round: asNumber(record.scene_round) ?? 0,
    current_scene_name: asString(record.current_scene_name) ?? null,
  };
}

function normalizeRuntimeCursor(
  value: unknown,
  fallback: { step: number; maxSteps: number; engineType?: string | null },
): ConcordiaCheckpointRuntimeCursor {
  const record = asRecord(value);
  return {
    current_step: asNumber(record.current_step) ?? fallback.step,
    start_step: asNumber(record.start_step) ?? fallback.step + 1,
    max_steps: asNumber(record.max_steps) ?? fallback.maxSteps,
    last_acting_agent: asString(record.last_acting_agent) ?? null,
    last_step_outcome: asString(record.last_step_outcome) ?? null,
    engine_type: asString(record.engine_type) ?? fallback.engineType ?? null,
  };
}

function normalizeReplayCursor(value: unknown): ConcordiaCheckpointReplayCursor {
  const record = asRecord(value);
  const replayCursor = asNumber(record.replay_cursor) ?? 0;
  const replayEventCount = asNumber(record.replay_event_count) ?? replayCursor;
  return {
    replay_cursor: replayCursor,
    replay_event_count: replayEventCount,
    last_event_id: asString(record.last_event_id) ?? (replayCursor > 0 ? String(replayCursor) : null),
  };
}

function normalizeWorldStateRefs(
  value: unknown,
  fallbackEntityStateKeys: readonly string[],
  hasGmState: boolean,
): ConcordiaCheckpointWorldStateRefs {
  const record = asRecord(value);
  const entityStateKeys = Array.isArray(record.entity_state_keys)
    ? record.entity_state_keys.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [...fallbackEntityStateKeys];
  return {
    source: "inline_checkpoint",
    gm_state_key: asString(record.gm_state_key) ?? (hasGmState ? "gm_state" : null),
    entity_state_keys: entityStateKeys,
    authoritative_snapshot_ref: asString(record.authoritative_snapshot_ref) ?? null,
  };
}

function normalizeMemoryNamespaceRefs(value: unknown): ConcordiaCheckpointMemoryNamespaceRefs {
  return asRecord(value) as ConcordiaCheckpointMemoryNamespaceRefs;
}

interface CheckpointIdentityFields {
  readonly simulationId: string;
  readonly worldId: string;
  readonly workspaceId: string;
  readonly lineageId: string | null;
  readonly parentSimulationId: string | null;
}

interface NormalizedCheckpointDefaults {
  readonly checkpointId: string;
  readonly checkpointPath: string;
  readonly schemaVersion: number;
  readonly maxSteps: number;
  readonly entityStates: Record<string, unknown>;
  readonly gmState: Record<string, unknown>;
  readonly runtimeCursor: ConcordiaCheckpointRuntimeCursor;
}

function resolveCheckpointIdentity(
  source: Record<string, unknown>,
  config: Record<string, unknown>,
): CheckpointIdentityFields {
  const simulationId =
    asString(source.simulation_id) ??
    asString(config.simulation_id) ??
    asString(source.world_id) ??
    asString(config.world_id) ??
    'checkpoint-simulation';
  return {
    simulationId,
    worldId: asString(source.world_id) ?? asString(config.world_id) ?? 'default',
    workspaceId: asString(source.workspace_id) ?? asString(config.workspace_id) ?? 'concordia-sim',
    lineageId: asString(source.lineage_id) ?? asString(config.lineage_id) ?? null,
    parentSimulationId:
      asString(source.parent_simulation_id) ?? asString(config.parent_simulation_id) ?? null,
  };
}

function buildEnrichedCheckpointConfig(
  config: Record<string, unknown>,
  identity: CheckpointIdentityFields,
): Record<string, unknown> {
  return {
    ...config,
    world_id: asString(config.world_id) ?? identity.worldId,
    workspace_id: asString(config.workspace_id) ?? identity.workspaceId,
    simulation_id: asString(config.simulation_id) ?? identity.simulationId,
    lineage_id: asString(config.lineage_id) ?? identity.lineageId,
    parent_simulation_id: asString(config.parent_simulation_id) ?? identity.parentSimulationId,
  };
}

function buildNormalizedCheckpointDefaults(
  source: Record<string, unknown>,
  step: number,
  enrichedConfig: Record<string, unknown>,
  simulationId: string,
): NormalizedCheckpointDefaults {
  const maxSteps = asNumber(source.max_steps) ?? asNumber(enrichedConfig['max_steps']) ?? step;
  const checkpointId = asString(source.checkpoint_id) ?? `${simulationId}:step:${step}`;
  const checkpointPath = asString(source.checkpoint_path) ?? `${checkpointId}.json`;
  const entityStates = asRecord(source.entity_states);
  const gmState = asRecord(source.gm_state);
  const schemaVersion =
    asNumber(source.schema_version) ??
    asNumber(source.version) ??
    CHECKPOINT_SCHEMA_VERSION;
  return {
    checkpointId,
    checkpointPath,
    schemaVersion,
    maxSteps,
    entityStates,
    gmState,
    runtimeCursor: normalizeRuntimeCursor(source.runtime_cursor, {
      step,
      maxSteps,
      engineType: asString(enrichedConfig['engine_type']) ?? null,
    }),
  };
}

function normalizeRestoredSessions(
  value: unknown,
): readonly ConcordiaCheckpointSessionMapping[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeSessionMapping(entry))
    .filter((entry): entry is ConcordiaCheckpointSessionMapping => entry !== null);
}

function normalizeAgentIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
}

export function buildDefaultSubsystemRestore(): ConcordiaCheckpointResumeState {
  return {
    resumed: [
      "gm_state",
      "entity_states",
      "scene_cursor",
      "runtime_cursor",
      "replay_cursor",
      "session_mappings",
      "world_state_refs",
      "memory_namespaces",
    ],
    reset: [
      "control_port",
      "event_port",
      "pending_responses",
      "live_subscribers",
      "runner_process",
    ],
  };
}

function normalizeSubsystemRestore(value: unknown): ConcordiaCheckpointResumeState {
  const record = asRecord(value);
  const fallback = buildDefaultSubsystemRestore();
  const resumed = Array.isArray(record.resumed)
    ? record.resumed.filter((entry): entry is ConcordiaCheckpointSubsystem => typeof entry === "string")
    : fallback.resumed;
  const reset = Array.isArray(record.reset)
    ? record.reset.filter((entry): entry is ConcordiaCheckpointSubsystem => typeof entry === "string")
    : fallback.reset;
  return { resumed, reset };
}

export function normalizeCheckpointManifest(
  input: Record<string, unknown> | Partial<ConcordiaCheckpointManifest>,
): ConcordiaCheckpointManifest {
  const source = input as Record<string, unknown>;
  const config = asRecord(source.config);
  const step = asNumber(source.step) ?? 0;
  const identity = resolveCheckpointIdentity(source, config);
  const enrichedConfig = buildEnrichedCheckpointConfig(config, identity);
  const defaults = buildNormalizedCheckpointDefaults(
    source,
    step,
    enrichedConfig,
    identity.simulationId,
  );
  return {
    checkpoint_id: defaults.checkpointId,
    checkpoint_path: defaults.checkpointPath,
    schema_version: defaults.schemaVersion,
    version: defaults.schemaVersion,
    world_id: identity.worldId,
    workspace_id: identity.workspaceId,
    simulation_id: identity.simulationId,
    lineage_id: identity.lineageId,
    parent_simulation_id: identity.parentSimulationId,
    step,
    timestamp: asNumber(source.timestamp) ?? Date.now(),
    user_id: asString(source.user_id) ?? asString(enrichedConfig['user_id']) ?? null,
    max_steps: defaults.maxSteps,
    config: enrichedConfig,
    restored_sessions: normalizeRestoredSessions(source.restored_sessions),
    scene_cursor: normalizeSceneCursor(source.scene_cursor),
    runtime_cursor: defaults.runtimeCursor,
    replay_cursor: normalizeReplayCursor(source.replay_cursor),
    world_state_refs: normalizeWorldStateRefs(
      source.world_state_refs,
      Object.keys(defaults.entityStates),
      Object.keys(defaults.gmState).length > 0,
    ),
    memory_namespace_refs: normalizeMemoryNamespaceRefs(source.memory_namespace_refs),
    subsystem_state: normalizeSubsystemRestore(source.subsystem_state),
    entity_logs: asRecord(source.entity_logs),
    entity_states: defaults.entityStates,
    gm_state: defaults.gmState,
    agent_ids: normalizeAgentIds(source.agent_ids),
  };
}

export function buildCheckpointStatusFromManifest(
  manifest: ConcordiaCheckpointManifest,
): ConcordiaCheckpointStatus {
  return {
    checkpoint_id: manifest.checkpoint_id,
    checkpoint_path: manifest.checkpoint_path,
    schema_version: manifest.schema_version,
    world_id: manifest.world_id,
    workspace_id: manifest.workspace_id,
    simulation_id: manifest.simulation_id,
    lineage_id: manifest.lineage_id ?? null,
    parent_simulation_id: manifest.parent_simulation_id ?? null,
    step: manifest.step,
    timestamp: manifest.timestamp,
    max_steps: manifest.max_steps,
    scene_cursor: manifest.scene_cursor,
    runtime_cursor: manifest.runtime_cursor,
    replay_cursor: manifest.replay_cursor,
    world_state_refs: manifest.world_state_refs,
    memory_namespace_refs: manifest.memory_namespace_refs,
    subsystem_state: manifest.subsystem_state,
  };
}

export function buildCheckpointMetadataFromManifest(
  manifest: ConcordiaCheckpointManifest,
): Record<string, unknown> {
  return {
    checkpointId: manifest.checkpoint_id,
    checkpointPath: manifest.checkpoint_path,
    checkpointSchemaVersion: manifest.schema_version,
    checkpointSimulationId: manifest.simulation_id,
    checkpointLineageId: manifest.lineage_id ?? null,
    checkpointParentSimulationId: manifest.parent_simulation_id ?? null,
    checkpointWorldId: manifest.world_id,
    checkpointWorkspaceId: manifest.workspace_id,
    resumedFromStep: manifest.step,
    runtimeCursor: manifest.runtime_cursor,
    sceneCursor: manifest.scene_cursor,
    replayCursor: manifest.replay_cursor,
    worldStateRefs: manifest.world_state_refs,
    memoryNamespaceRefs: manifest.memory_namespace_refs,
    subsystemRestore: manifest.subsystem_state,
    checkpointManifest: manifest,
    checkpointStatus: buildCheckpointStatusFromManifest(manifest),
  };
}
