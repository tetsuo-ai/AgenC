/**
 * Shared types for the AgenC Concordia bridge plugin.
 *
 * @module
 */

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
  readonly observation: string;
}

export interface SetupRequest {
  readonly world_id: string;
  readonly workspace_id: string;
  readonly agents: readonly AgentSetupConfig[];
  readonly premise: string;
}

export interface AgentSetupConfig {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly personality: string;
  readonly goal?: string;
}

export interface EventNotification {
  readonly type: "resolution" | "observation" | "scene_change";
  readonly step: number;
  readonly acting_agent?: string;
  readonly target_agents?: readonly string[];
  readonly content: string;
  readonly world_id: string;
}

export interface AgentStateResponse {
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
