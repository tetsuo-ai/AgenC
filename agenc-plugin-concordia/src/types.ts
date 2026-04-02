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
}

export interface ActResponse {
  readonly action: string;
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
  readonly metadata?: Record<string, unknown> | null;
}

export type SimulationCommand = "play" | "pause" | "step" | "stop";

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
}

export interface MemoryEntrySummary {
  readonly content: string;
  readonly role: string;
  readonly timestamp: number;
  readonly metadata?: Record<string, unknown>;
}

export interface RelationshipSummary {
  readonly otherAgentId: string;
  readonly relationship: string;
  readonly sentiment: number;
  readonly interactionCount: number;
}

export interface WorldFactSummary {
  readonly content: string;
  readonly observedBy: string;
  readonly confirmations: number;
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

// ============================================================================
// Plugin configuration
// ============================================================================

export interface ConcordiaChannelConfig {
  readonly bridge_port?: number;
  readonly event_port?: number;
  readonly world_id?: string;
  readonly workspace_id?: string;
  readonly encryption_key?: string;
  readonly reflection_interval?: number;
  readonly consolidation_interval?: number;
  readonly python_command?: string;
  [key: string]: unknown;
}

// ============================================================================
// Bridge metrics
// ============================================================================

export interface BridgeMetrics {
  actRequests: number;
  observeRequests: number;
  setupRequests: number;
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
    eventNotifications: 0,
    errors: 0,
    actLatencyMs: [],
    startedAt: Date.now(),
  };
}
