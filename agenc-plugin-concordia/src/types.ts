/**
 * Shared types for the AgenC Concordia bridge plugin.
 *
 * @module
 */

import type {
  ConcordiaCheckpointManifest,
  ConcordiaCheckpointResumeState,
  ConcordiaCheckpointStatus,
  ConcordiaCheckpointSummary,
} from "./checkpoint-manifest.js";

export type {
  ConcordiaCheckpointManifest,
  ConcordiaCheckpointMemoryNamespaceRefs,
  ConcordiaCheckpointReplayCursor,
  ConcordiaCheckpointResumeState,
  ConcordiaCheckpointRuntimeCursor,
  ConcordiaCheckpointSceneCursor,
  ConcordiaCheckpointSessionMapping,
  ConcordiaCheckpointStatus,
  ConcordiaCheckpointSubsystem,
  ConcordiaCheckpointSubsystemRestore,
  ConcordiaCheckpointSummary,
  ConcordiaCheckpointWorldStateRefs,
  ConcordiaReplayCursorState,
  ConcordiaRuntimeCursorState,
  ConcordiaSceneCursorState,
  ConcordiaWorldStateRefs,
} from "./checkpoint-manifest.js";

// ============================================================================
// Lifecycle and structured world state types
// ============================================================================

export type SimulationLifecycleStatus =
  | "launching"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "finished"
  | "failed"
  | "archived"
  | "deleted";

export type WorldTaskStatus = "pending" | "active" | "completed" | "blocked";

export type ConcordiaVisibilityTier =
  | "private"
  | "shared"
  | "world-visible"
  | "lineage-shared";

export type ConcordiaTrustSource = "system" | "agent" | "user" | "external";

export type ConcordiaAuthorizationMode =
  | "auto"
  | "requires-user-authorization"
  | "requires-system-authorization";

export interface ConcordiaProvenanceRecord {
  readonly type: string;
  readonly source: ConcordiaTrustSource;
  readonly source_id: string;
  readonly simulation_id?: string | null;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly world_id?: string | null;
  readonly workspace_id?: string | null;
  readonly event_id?: string | null;
  readonly timestamp: number;
  readonly metadata?: Record<string, unknown> | null;
}

export interface ConcordiaTrustRecord {
  readonly source: ConcordiaTrustSource;
  readonly score: number;
  readonly confidence: number;
  readonly threshold: number;
}

export interface ConcordiaAuthorizationRecord {
  readonly mode: ConcordiaAuthorizationMode;
  readonly approved: boolean;
  readonly approved_by?: string | null;
  readonly approved_at?: number | null;
  readonly reason?: string | null;
}

export interface ConcordiaAuditRecord {
  readonly timestamp: number;
  readonly action: string;
  readonly actor: string;
  readonly visibility?: ConcordiaVisibilityTier | null;
  readonly authorization_mode?: ConcordiaAuthorizationMode | null;
  readonly authorized_by?: string | null;
  readonly reason?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface WorldCoordinate {
  readonly location_id: string | null;
  readonly scene_id: string | null;
  readonly zone_id: string | null;
  readonly label?: string | null;
}

export interface WorldTask {
  readonly task_id: string;
  readonly title: string;
  readonly status: WorldTaskStatus;
  readonly assigned_agent_id?: string | null;
  readonly description?: string | null;
  readonly due_step?: number | null;
  readonly scene_id?: string | null;
  readonly zone_id?: string | null;
  readonly location_id?: string | null;
}

export interface RelationshipSummary {
  readonly otherAgentId: string;
  readonly relationship: string;
  readonly sentiment: number;
  readonly interactionCount: number;
}

export interface WorldFactSummary {
  readonly id?: string;
  readonly content: string;
  readonly observedBy: string;
  readonly confirmations: number;
  readonly confirmedBy?: readonly string[];
  readonly visibility?: ConcordiaVisibilityTier;
  readonly trust?: ConcordiaTrustRecord | null;
  readonly provenance?: readonly ConcordiaProvenanceRecord[];
  readonly audit?: readonly ConcordiaAuditRecord[];
}

export interface WorldObjectState {
  readonly object_id: string;
  readonly label: string;
  readonly kind: string;
  readonly location_id: string | null;
  readonly scene_id: string | null;
  readonly zone_id: string | null;
  readonly status?: string | null;
  readonly tags: readonly string[];
  readonly metadata?: Record<string, unknown> | null;
}

export interface AgentIntentTask {
  readonly title: string;
  readonly status?: WorldTaskStatus | null;
  readonly note?: string | null;
}

export interface AgentIntentWorldObjectUpdate {
  readonly object_id: string;
  readonly label?: string | null;
  readonly kind?: string | null;
  readonly location_id?: string | null;
  readonly scene_id?: string | null;
  readonly zone_id?: string | null;
  readonly status?: string | null;
  readonly tags?: readonly string[];
}

export interface AgentIntentRelationshipUpdate {
  readonly other_agent_id: string;
  readonly relationship?: string | null;
  readonly sentiment_delta?: number | null;
  readonly note?: string | null;
}

export interface AgentIntent {
  readonly summary: string;
  readonly mode:
    | "action"
    | "speech"
    | "move"
    | "interact"
    | "observe"
    | "wait"
    | "choice"
    | "measurement";
  readonly destination: WorldCoordinate | null;
  readonly target_agent_ids: readonly string[];
  readonly target_object_ids: readonly string[];
  readonly task: AgentIntentTask | null;
  readonly inventory_add: readonly string[];
  readonly inventory_remove: readonly string[];
  readonly world_object_updates: readonly AgentIntentWorldObjectUpdate[];
  readonly relationship_updates: readonly AgentIntentRelationshipUpdate[];
  readonly notes: readonly string[];
}

export interface AgentOutcome {
  readonly summary: string;
  readonly narration: string | null;
  readonly succeeded: boolean;
  readonly scene_id?: string | null;
  readonly zone_id?: string | null;
  readonly location_id?: string | null;
  readonly task_status?: WorldTaskStatus | null;
  readonly inventory_add?: readonly string[];
  readonly inventory_remove?: readonly string[];
  readonly metadata?: Record<string, unknown> | null;
}

export interface WorldEvent {
  readonly event_id?: string;
  readonly type: string;
  readonly step: number;
  readonly timestamp: number;
  readonly summary: string;
  readonly agent_id?: string | null;
  readonly agent_name?: string | null;
  readonly scene_id?: string | null;
  readonly zone_id?: string | null;
  readonly location_id?: string | null;
  readonly intent?: AgentIntent | null;
  readonly outcome?: AgentOutcome | null;
  readonly trust?: ConcordiaTrustRecord | null;
  readonly provenance?: readonly ConcordiaProvenanceRecord[] | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface EmbodiedAgentState {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly location_id: string | null;
  readonly scene_id: string | null;
  readonly zone_id: string | null;
  readonly nearby_agent_ids: readonly string[];
  readonly inventory: readonly string[];
  readonly world_object_ids: readonly string[];
  readonly relationships: readonly RelationshipSummary[];
  readonly schedule: readonly WorldTask[];
  readonly current_task: WorldTask | null;
  readonly last_observation: string | null;
  readonly last_action: string | null;
  readonly last_intent: AgentIntent | null;
  readonly last_outcome: AgentOutcome | null;
  readonly turn_count: number;
  readonly metadata?: Record<string, unknown> | null;
}

export interface WorldProjection {
  readonly simulation_id: string;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly agent_id: string;
  readonly clock: {
    readonly tick: number;
    readonly step: number;
    readonly phase: SimulationLifecycleStatus;
    readonly updated_at: number;
  };
  readonly premise: string;
  readonly self: EmbodiedAgentState | null;
  readonly active_scene_id: string | null;
  readonly active_zone_id: string | null;
  readonly active_location_id: string | null;
  readonly visible_agents: readonly EmbodiedAgentState[];
  readonly visible_objects: readonly WorldObjectState[];
  readonly world_facts: readonly WorldFactSummary[];
  readonly recent_events: readonly WorldEvent[];
}

export interface WorldStateSnapshot {
  readonly simulation_id: string;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly premise: string;
  readonly clock: {
    readonly tick: number;
    readonly step: number;
    readonly phase: SimulationLifecycleStatus;
    readonly updated_at: number;
  };
  readonly active_scene_id: string | null;
  readonly active_zone_id: string | null;
  readonly active_location_id: string | null;
  readonly agent_states: Record<string, EmbodiedAgentState>;
  readonly world_objects: Record<string, WorldObjectState>;
  readonly world_facts: readonly WorldFactSummary[];
  readonly recent_events: readonly WorldEvent[];
  readonly updated_at: number;
  readonly snapshot_ref: string;
}

// ============================================================================
// Bridge HTTP request/response types
// ============================================================================

export interface ConcordiaActionSpec {
  readonly call_to_action: string;
  readonly output_type: "free" | "choice" | "float";
  readonly options: readonly string[];
  readonly tag: string | null;
}

export interface ActRequest {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly simulation_id: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly action_spec: ConcordiaActionSpec;
  readonly turn_count?: number;
  readonly world_projection?: WorldProjection | null;
}

export interface ActResponse {
  readonly action: string;
  readonly narration?: string | null;
  readonly intent?: AgentIntent | null;
}

export interface ObserveRequest {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly simulation_id: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly observation: string;
}

export interface SetupRequest {
  readonly world_id: string;
  readonly workspace_id: string;
  readonly simulation_id: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly user_id?: string;
  readonly agents: readonly AgentSetupConfig[];
  readonly premise: string;
}

export interface LaunchRequest {
  readonly world_id: string;
  readonly workspace_id: string;
  readonly simulation_id?: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly user_id?: string;
  readonly agents: readonly AgentSetupConfig[];
  readonly premise: string;
  readonly max_steps?: number;
  readonly gm_model?: string;
  readonly gm_provider?: string;
  readonly gm_api_key?: string;
  readonly gm_base_url?: string;
  readonly event_port?: number;
  readonly control_port?: number;
  readonly engine_type?: "sequential" | "simultaneous";
  readonly gm_prefab?: string;
  readonly run_budget?: ConcordiaRunBudget;
}

export interface GenerateAgentsRequest {
  readonly count: number;
  readonly premise: string;
  readonly worldId?: string;
}

export interface CheckpointRequest
  extends Omit<Partial<ConcordiaCheckpointManifest>, "checkpoint_path"> {
  readonly world_id: string;
  readonly workspace_id: string;
  readonly simulation_id: string;
  readonly step: number;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly checkpoint_id?: string;
  readonly checkpoint_path?: string | null;
  readonly checkpoint_manifest?: ConcordiaCheckpointManifest | null;
}

export interface ResumeRequest {
  readonly checkpoint: ConcordiaCheckpointManifest;
  readonly simulation_id?: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly user_id?: string;
}

export interface GeneratedAgent {
  readonly id: string;
  readonly name: string;
  readonly personality: string;
  readonly goal: string;
}

export interface AgentSetupConfig {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly personality: string;
  readonly goal?: string;
}

export interface EventNotification {
  readonly type:
    | "step"
    | "observation"
    | "action"
    | "resolution"
    | "scene_change"
    | "terminate"
    | "error";
  readonly step: number;
  readonly acting_agent?: string;
  readonly agent_name?: string;
  readonly target_agents?: readonly string[];
  readonly content?: string;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly simulation_id: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly timestamp?: number;
  readonly action_spec?: Record<string, unknown> | null;
  readonly resolved_event?: string | null;
  readonly scene?: string | null;
  readonly visibility?: ConcordiaVisibilityTier | null;
  readonly trust?: ConcordiaTrustRecord | null;
  readonly provenance?: readonly ConcordiaProvenanceRecord[] | null;
  readonly authorization?: ConcordiaAuthorizationRecord | null;
  readonly metadata?: Record<string, unknown> | null;
  readonly intent?: AgentIntent | null;
  readonly outcome?: AgentOutcome | null;
  readonly world_event?: WorldEvent | null;
}

export type SimulationCommand = "play" | "pause" | "step" | "stop";

export interface SimulationSummary {
  readonly simulation_id: string;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly lineage_id: string | null;
  readonly parent_simulation_id: string | null;
  readonly status: SimulationLifecycleStatus;
  readonly reason: string | null;
  readonly error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly agent_ids: readonly string[];
  readonly current_alias: boolean;
  readonly pid: number | null;
  readonly last_completed_step: number;
  readonly last_step_outcome: string | null;
  readonly replay_event_count: number;
  readonly checkpoint: ConcordiaCheckpointStatus | null;
}

export interface SimulationRecord extends SimulationSummary {
  readonly agents: readonly AgentSetupConfig[];
  readonly premise: string;
  readonly max_steps: number | null;
  readonly gm_model?: string;
  readonly gm_provider?: string;
  readonly run_budget?: ConcordiaRunBudget | null;
}

export interface MemoryEntrySummary {
  readonly content: string;
  readonly role: string;
  readonly timestamp: number;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentStateResponse {
  readonly simulationId?: string;
  readonly lineageId?: string | null;
  readonly parentSimulationId?: string | null;
  readonly identity: Record<string, unknown> | null;
  readonly memoryCount: number;
  readonly recentMemories: readonly MemoryEntrySummary[];
  readonly relationships: readonly RelationshipSummary[];
  readonly worldFacts: readonly WorldFactSummary[];
  readonly turnCount: number;
  readonly lastAction: string | null;
  readonly embodiedState?: EmbodiedAgentState | null;
  readonly worldProjection?: WorldProjection | null;
}

export interface SimulationStatusResponse {
  readonly simulation_id: string;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly status: SimulationLifecycleStatus;
  readonly reason: string | null;
  readonly error: string | null;
  readonly step: number;
  readonly max_steps: number | null;
  readonly running: boolean;
  readonly paused: boolean;
  readonly agent_count: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly updated_at: number;
  readonly last_step_outcome: string | null;
  readonly terminal_reason: string | null;
  readonly checkpoint: ConcordiaCheckpointStatus | null;
}

export interface SimulationReplayEvent extends EventNotification {
  readonly event_id: string;
}

export interface SimulationEventsResponse {
  readonly simulation_id: string;
  readonly events: readonly SimulationReplayEvent[];
  readonly next_cursor: string | null;
}

export type SimulationWorldStateResponse = WorldStateSnapshot;

// ============================================================================
// Plugin configuration
// ============================================================================

export interface ConcordiaRunBudget {
  readonly act_timeout_ms?: number;
  readonly proxy_action_timeout_seconds?: number;
  readonly proxy_action_max_retries?: number;
  readonly proxy_retry_delay_seconds?: number;
  readonly simultaneous_max_workers?: number;
}

export interface ConcordiaChannelConfig {
  readonly bridge_port?: number;
  readonly event_port?: number;
  readonly world_id?: string;
  readonly workspace_id?: string;
  readonly encryption_key?: string;
  readonly reflection_interval?: number;
  readonly consolidation_interval?: number;
  readonly python_command?: string;
  readonly max_concurrent_simulations?: number;
  readonly max_historical_simulations?: number;
  readonly archived_simulation_retention_ms?: number;
  readonly replay_buffer_limit?: number;
  readonly archived_replay_event_limit?: number;
  readonly runner_startup_timeout_ms?: number;
  readonly runner_shutdown_timeout_ms?: number;
  readonly step_stuck_timeout_ms?: number;
  readonly act_timeout_ms?: number;
  readonly generate_agents_timeout_ms?: number;
  readonly simultaneous_max_workers?: number;
  readonly proxy_action_timeout_seconds?: number;
  readonly proxy_action_max_retries?: number;
  readonly proxy_retry_delay_seconds?: number;
  [key: string]: unknown;
}

export interface ConcordiaOperationalMetrics {
  readonly max_concurrent_simulations: number;
  readonly max_historical_simulations: number;
  readonly archived_simulation_retention_ms: number;
  readonly replay_buffer_limit: number;
  readonly archived_replay_event_limit: number;
  readonly runner_startup_timeout_ms: number;
  readonly runner_shutdown_timeout_ms: number;
  readonly step_stuck_timeout_ms: number;
  readonly act_timeout_ms: number;
  readonly generate_agents_timeout_ms: number;
  readonly simultaneous_max_workers: number;
  readonly proxy_action_timeout_seconds: number;
  readonly proxy_action_max_retries: number;
  readonly proxy_retry_delay_seconds: number;
  readonly active_simulations: number;
  readonly historical_simulations: number;
  readonly stuck_simulations: number;
  readonly pending_action_count: number;
  readonly replay_buffer_events: number;
  readonly reserved_port_count: number;
  readonly configured_thread_budget: number;
  readonly checkpoint_volume: number;
  readonly launch_requests: number;
  readonly rejected_launches: number;
}

// ============================================================================
// Bridge metrics
// ============================================================================

export interface BridgeMetrics {
  actRequests: number;
  observeRequests: number;
  setupRequests: number;
  launchRequests: number;
  rejectedLaunches: number;
  eventNotifications: number;
  errors: number;
  actLatencyMs: number[];
  startedAt: number;
}

export function createEmptyMetrics(): BridgeMetrics {
  return {
    actRequests: 0,
    observeRequests: 0,
    setupRequests: 0,
    launchRequests: 0,
    rejectedLaunches: 0,
    eventNotifications: 0,
    errors: 0,
    actLatencyMs: [],
    startedAt: Date.now(),
  };
}
