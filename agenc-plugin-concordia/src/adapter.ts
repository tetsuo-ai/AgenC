/**
 * ConcordiaChannelAdapter — the main plugin-kit ChannelAdapter implementation.
 *
 * Bridges Google DeepMind's Concordia generative simulation engine to AgenC
 * agents via an HTTP server. The daemon loads this as a channel plugin and
 * routes agent messages through the standard ChatExecutor pipeline.
 *
 * Flow:
 * 1. Python ProxyEntity POSTs /act to the bridge HTTP server
 * 2. The adapter creates a ChannelInboundMessage and calls on_message()
 * 3. The daemon runs the message through ChatExecutor (system prompt, identity,
 *    memory retrieval, LLM, tools)
 * 4. The daemon calls adapter.send() with the agent's response
 * 5. send() resolves the pending /act Promise, returning the action to Python
 *
 * Memory wiring (Phases 5 + 10):
 * - handleSetup() calls setupAgentIdentity() + storePremise()
 * - handleObserve() calls ingestObservation()
 * - handleAct() calls buildFullActContext()
 * - handleEvent() calls recordSocialEvent() + updateTemporalEdges() + logSimulationEvent() + runPeriodicTasks()
 * - stop() calls postSimulationCleanup()
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelInboundMessage,
  ChannelOutboundMessage,
} from "@tetsuo-ai/plugin-kit";
import type {
  BridgeMetrics,
  ConcordiaChannelConfig,
  ConcordiaExecutionPhase,
  ConcordiaOperationalMetrics,
  ConcordiaProvenanceRecord,
  ConcordiaTrustRecord,
  ConcordiaTrustSource,
  ActRequest,
  SetupRequest,
  EventNotification,
  LaunchRequest,
  GenerateAgentsRequest,
  GeneratedAgent,
  AgentIntent,
  AgentOutcome,
  AgentStateResponse,
  CheckpointRequest,
  ResumeRequest,
  SimulationRecord,
  SimulationReplayEvent,
  SimulationEventsResponse,
  SimulationSummary,
  SimulationLifecycleStatus,
  SimulationCommand,
  SimulationStatusResponse,
  WorldProjection,
  WorldStateSnapshot,
} from "./types.js";
import { SessionManager, type AgentSession } from "./session-manager.js";
import {
  SimulationRegistry,
  type NormalizedLaunchRequest,
  type ReservedSimulationPorts,
  type SimulationHandle,
} from "./simulation-registry.js";
import { createBridgeServer, type BridgeServerConfig } from "./bridge-http.js";
import type { Server } from "node:http";
import type { MemoryWiringContext } from "./memory-wiring.js";
import {
  type KnownAgentReference,
  setupAgentIdentity,
  ingestObservation,
  recordObservationWorldFact,
  recordAgentAction,
  buildFullActContext,
  recordSocialEvent,
  promoteCollectiveEmergenceFacts,
  updateTemporalEdges,
  logSimulationEvent,
  storePremise,
  getAgentState as loadAgentState,
} from "./memory-wiring.js";
import {
  runPeriodicTasks,
  postSimulationCleanup,
  runCheckpointMaintenance,
} from "./memory-lifecycle.js";
import {
  resolveConcordiaLaunchDefaults,
  resolveConcordiaMemoryContext,
} from "./host-services.js";
import { buildSimulationSystemContext } from "./prompt-builder.js";
import {
  launchSimulationRunner,
  stopSimulationRunner,
  type SpawnedSimulationRunner,
} from "./simulation-runner.js";
import {
  createSimulationIdentity,
  withSimulationIdentity,
  type SimulationIdentity,
} from "./simulation-identity.js";
import {
  buildIgnoredRequestIdLogMessage,
  buildMissingRequestIdLogMessage,
  buildPendingSendTarget,
  buildPeriodicTaskIntervals,
  buildResumeHandleParamsFromState,
  buildUnknownRequestIdLogMessage,
  type ResumeHandleParamsInput,
  type ResumeHandleStateInput,
} from "./adapter-utils.js";
import {
  buildOperationalMetricsSnapshot,
  ConcordiaAdmissionError,
  resolveOperationsConfig,
  resolveRunBudget,
  type ConcordiaResolvedOperationsConfig,
} from "./operations.js";
import {
  applyEventToWorldState,
  applyStructuredActResult,
  buildAgentStateFromWorldState,
  buildWorldProjection,
  createInitialWorldState,
  reconcileWorldStateSnapshot,
} from "./world-state.js";
import {
  buildCheckpointMetadataFromManifest,
  buildCheckpointStatusFromManifest,
  buildDefaultSubsystemRestore,
  normalizeCheckpointManifest,
  type ConcordiaCheckpointManifest,
  type ConcordiaCheckpointStatus,
} from "./checkpoint-manifest.js";

const MAX_GENERATED_AGENTS = 25;
const LOOPBACK_HOST = "127.0.0.1";
const CREATE_LAUNCHING_HANDLE_OPTIONS = {
  status: "launching" as const,
  currentAlias: true,
};
const CREATE_SETUP_HANDLE_OPTIONS = {
  status: "launching" as const,
  reservePorts: false,
  currentAlias: true,
};
const CREATE_CHECKPOINT_HANDLE_OPTIONS = {
  status: "paused" as const,
  reservePorts: false,
  currentAlias: false,
};
const CREATE_RESUME_HANDLE_OPTIONS = {
  status: "paused" as const,
  reservePorts: false,
  currentAlias: true,
};
const STOP_CLEANUP_OPTIONS: SimulationCleanupOptions = {
  status: "stopped",
  removeHandle: false,
  stopRunner: true,
  removeSessions: true,
  runPostCleanup: true,
  clearMemoryContext: true,
};
const RESET_CLEANUP_OPTIONS: SimulationCleanupOptions = {
  ...STOP_CLEANUP_OPTIONS,
  removeHandle: true,
};

// ============================================================================
// Pending request tracking
// ============================================================================

interface PendingResponseRequest {
  readonly agentId?: string;
  readonly sessionId: string;
  readonly worldId: string | null;
  readonly simulationId: string | null;
  readonly step: number;
  readonly createdAt: number;
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingSendTarget {
  readonly handle: ConcordiaSimulationHandle;
  readonly requestId: string;
  readonly pending: PendingResponseRequest;
  readonly usedSessionFallback: boolean;
}

interface PendingDispatchRequest {
  readonly requestId: string;
  readonly inbound: ChannelInboundMessage;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly timeoutMs: number;
  readonly timeoutLog: string;
  readonly worldId: string | null;
  readonly step: number;
  readonly simulationId?: string | null;
  readonly logMessageLength?: number;
}

interface PendingResponseInit {
  readonly handle: ConcordiaSimulationHandle;
  readonly requestId: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly timeoutMs: number;
  readonly timeoutLog: string;
  readonly worldId: string | null;
  readonly step: number;
  readonly simulationId: string | null;
  readonly resolve: (content: string) => void;
  readonly reject: (error: Error) => void;
}

interface StructuredActRecord {
  readonly action: string;
  readonly narration: string | null;
  readonly intent: AgentIntent | null;
  readonly step: number;
  readonly recordedAt: number;
}

type SimulationCleanupOptions = {
  status?: SimulationLifecycleStatus;
  removeHandle?: boolean;
  stopRunner?: boolean;
  removeSessions?: boolean;
  runPostCleanup?: boolean;
  clearMemoryContext?: boolean;
  error?: string | null;
};

function buildResumeHandleState(
  worldId: string,
  workspaceId: string,
  simulationId: string,
  lineageId: string,
  parentSimulationId: string | null,
  request: ResumeRequest,
  checkpoint: ConcordiaCheckpointManifest,
  config: Record<string, unknown>,
  agents: SetupRequest["agents"],
  premise: string,
): ResumeHandleStateInput {
  return {
    worldId,
    workspaceId,
    simulationId,
    lineageId,
    parentSimulationId,
    request,
    checkpoint,
    config,
    agents,
    premise,
  };
}

function buildResumeResponse(
  worldId: string,
  workspaceId: string,
  simulationId: string,
  lineageId: string,
  parentSimulationId: string | null,
  resumedFromStep: number,
  sessions: Record<string, string>,
  checkpoint: ConcordiaCheckpointStatus,
): Record<string, unknown> {
  return {
    world_id: worldId,
    workspace_id: workspaceId,
    simulation_id: simulationId,
    lineage_id: lineageId,
    parent_simulation_id: parentSimulationId,
    resumed_from_step: resumedFromStep,
    sessions,
    checkpoint,
  };
}

interface SimulationMemoryEventEntry {
  readonly step: number;
  readonly actingAgent?: string;
  readonly content: string;
  readonly type: EventNotification["type"];
}

function buildSimulationMemoryEventEntry(
  event: EventNotification,
): SimulationMemoryEventEntry {
  return {
    step: event.step,
    actingAgent: event.acting_agent,
    content: event.content ?? "",
    type: event.type,
  };
}

function buildSingleAgentSetup(
  agentId: string,
  agentName: string,
): SetupRequest["agents"][number] {
  return {
    agent_id: agentId,
    agent_name: agentName,
    personality: "",
  };
}

function buildCheckpointHandleRequestFromSessions(
  request: CheckpointRequest,
  sessions: readonly AgentSession[],
): MutableNormalizedLaunchRequest {
  return {
    world_id: request.world_id,
    workspace_id: request.workspace_id,
    simulation_id: request.simulation_id,
    lineage_id: request.lineage_id ?? null,
    parent_simulation_id: request.parent_simulation_id ?? null,
    agents: sessions.map((session) =>
      buildSingleAgentSetup(session.agentId, session.agentName),
    ),
    premise: "",
  };
}

function buildCheckpointLaunchMetadata(
  request: CheckpointRequest,
  existingHandle: ConcordiaSimulationHandle,
): Parameters<SimulationRegistry["setLaunchMetadata"]>[1] {
  return {
    worldId: request.world_id,
    workspaceId: request.workspace_id,
    lineageId: request.lineage_id ?? existingHandle.lineageId,
    parentSimulationId:
      request.parent_simulation_id ?? existingHandle.parentSimulationId,
  };
}

function buildCheckpointRequestManifest(
  request: CheckpointRequest,
): ConcordiaCheckpointManifest {
  return normalizeCheckpointManifest({
    ...(request.checkpoint_manifest ?? {}),
    world_id: request.world_id,
    workspace_id: request.workspace_id,
    simulation_id: request.simulation_id,
    lineage_id: request.lineage_id ?? request.checkpoint_manifest?.lineage_id ?? null,
    parent_simulation_id:
      request.parent_simulation_id ??
      request.checkpoint_manifest?.parent_simulation_id ??
      null,
    step: request.step,
    checkpoint_id:
      request.checkpoint_id ?? request.checkpoint_manifest?.checkpoint_id,
    checkpoint_path:
      request.checkpoint_path ?? request.checkpoint_manifest?.checkpoint_path,
  });
}

function mapAgentSessionToKnownAgent(
  session: AgentSession,
): KnownAgentReference {
  return {
    agentId: session.agentId,
    agentName: session.agentName,
  };
}

function extractRequestId(
  metadata: ChannelOutboundMessage["metadata"],
): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const value = (metadata as Record<string, unknown>).request_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface RunnerStatusSnapshot {
  readonly step: number;
  readonly max_steps: number;
  readonly running: boolean;
  readonly paused: boolean;
  readonly world_id?: string;
  readonly simulation_id?: string;
  readonly agent_count?: number;
  readonly execution_phase?: ConcordiaExecutionPhase | null;
  readonly last_step_outcome?: string;
  readonly terminal_reason?: string | null;
}

const TERMINAL_SIMULATION_STATUSES = new Set<SimulationLifecycleStatus>([
  "stopped",
  "finished",
  "failed",
  "archived",
  "deleted",
]);

function isTerminalSimulationStatus(status: SimulationLifecycleStatus): boolean {
  return TERMINAL_SIMULATION_STATUSES.has(status);
}

// ============================================================================
// Adapter
// ============================================================================

type ConcordiaSimulationHandle = SimulationHandle<
  SpawnedSimulationRunner,
  MemoryWiringContext,
  PendingResponseRequest
>;

type MutableNormalizedLaunchRequest = {
  -readonly [K in keyof NormalizedLaunchRequest]: NormalizedLaunchRequest[K];
};

type MutableSetupAgent = {
  -readonly [K in keyof SetupRequest["agents"][number]]: SetupRequest["agents"][number][K];
};

export class ConcordiaChannelAdapter
  implements ChannelAdapter<ConcordiaChannelConfig>
{
  readonly name = "concordia";

  private context!: ChannelAdapterContext<ConcordiaChannelConfig>;
  private bridgeServer: Server | null = null;
  private sessionManager = new SessionManager();
  private registry!: SimulationRegistry<
    SpawnedSimulationRunner,
    MemoryWiringContext,
    PendingResponseRequest
  >;
  private operations!: ConcordiaResolvedOperationsConfig;
  private readonly worldStates = new Map<string, WorldStateSnapshot>();
  private readonly structuredActs = new Map<string, Map<string, StructuredActRecord>>();
  private healthy = false;

  async initialize(
    context: ChannelAdapterContext<ConcordiaChannelConfig>,
  ): Promise<void> {
    this.context = context;
    this.operations = resolveOperationsConfig(context.config);
    this.registry = new SimulationRegistry(context.logger, {
      replayBufferLimit: this.operations.replayBufferLimit,
      archivedReplayEventLimit: this.operations.archivedReplayEventLimit,
    });
  }

  async start(): Promise<void> {
    const port = this.context.config.bridge_port ?? 3200;
    const host = LOOPBACK_HOST;

    this.bridgeServer = createBridgeServer(this.buildBridgeServerConfig(port, host));
    await this.listenBridgeServer(port, host);
  }

  async stop(): Promise<void> {
    this.healthy = false;

    await this.stopAllSimulations();

    this.registry.clear();
    this.sessionManager.clear();
    this.worldStates.clear();
    this.structuredActs.clear();

    await this.closeBridgeServer();

    this.context.logger.info?.("[concordia] Bridge server stopped");
  }

  /**
   * Called by the daemon when the ChatExecutor produces a response.
   * Routes the response to the pending /act request for the matching session.
   */
  async send(message: ChannelOutboundMessage): Promise<void> {
    if (message.is_partial) return;

    const target = this.resolveValidatedPendingSendTarget(message);
    if (!target) return;

    const { handle, requestId, pending, usedSessionFallback } = target;
    this.resolvePendingResponse(
      handle,
      requestId,
      pending,
      message.content,
      usedSessionFallback ? "resolved_session_fallback" : "resolved",
    );
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  private syncWorldStateForHandle(
    handle: ConcordiaSimulationHandle,
  ): WorldStateSnapshot {
    const snapshot = reconcileWorldStateSnapshot(
      this.worldStates.get(handle.simulationId) ?? null,
      {
        simulation_id: handle.simulationId,
        world_id: handle.worldId,
        workspace_id: handle.workspaceId,
        lineage_id: handle.lineageId ?? null,
        parent_simulation_id: handle.parentSimulationId ?? null,
        premise: handle.premise,
        agents: handle.agents,
        status: handle.status,
        initial_scene_id: handle.launchRequest.scenes?.[0]?.scene_id ?? null,
        initial_scene_name: handle.launchRequest.scenes?.[0]?.name ?? null,
        initial_zone_id: handle.launchRequest.scenes?.[0]?.zone_id ?? null,
        initial_location_id: handle.launchRequest.scenes?.[0]?.location_id ?? null,
        initial_time_of_day: handle.launchRequest.scenes?.[0]?.time_of_day ?? null,
        initial_day_index: handle.launchRequest.scenes?.[0]?.day_index ?? null,
      },
    );

    const sessions = this.sessionManager.getAllForSimulation(
      handle.simulationId,
      handle.workspaceId,
    );
    const agentStates = { ...snapshot.agent_states };
    for (const session of sessions) {
      const current = agentStates[session.agentId];
      if (!current) {
        continue;
      }
      agentStates[session.agentId] = {
        ...current,
        turn_count: session.turnCount,
        last_action: session.lastAction,
        last_observation:
          session.observations[session.observations.length - 1] ??
          current.last_observation,
      };
    }

    const synced: WorldStateSnapshot = {
      ...snapshot,
      agent_states: agentStates,
    };
    this.worldStates.set(handle.simulationId, synced);
    return synced;
  }

  private rememberStructuredAct(
    simulationId: string,
    agentId: string,
    record: StructuredActRecord,
  ): void {
    const records = this.structuredActs.get(simulationId) ?? new Map<string, StructuredActRecord>();
    records.set(agentId, record);
    this.structuredActs.set(simulationId, records);
  }

  private peekStructuredAct(
    simulationId: string,
    agentId: string | null,
  ): StructuredActRecord | null {
    if (!agentId) {
      return null;
    }
    return this.structuredActs.get(simulationId)?.get(agentId) ?? null;
  }

  private clearStructuredAct(
    simulationId: string,
    agentId: string | null,
  ): void {
    if (!agentId) {
      return;
    }
    const records = this.structuredActs.get(simulationId);
    if (!records) {
      return;
    }
    records.delete(agentId);
    if (records.size === 0) {
      this.structuredActs.delete(simulationId);
    }
  }

  private resolveEventAgentId(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): string | null {
    if (event.acting_agent && handle.agentIds.includes(event.acting_agent)) {
      return event.acting_agent;
    }
    if (!event.agent_name) {
      return null;
    }
    const session = this.sessionManager
      .getAllForSimulation(handle.simulationId, handle.workspaceId)
      .find((candidate) => candidate.agentName === event.agent_name);
    return session?.agentId ?? null;
  }

  private buildStructuredOutcome(
    event: EventNotification,
    pendingAct: StructuredActRecord | null,
    snapshot: WorldStateSnapshot,
  ): AgentOutcome | null {
    if (event.outcome) {
      return event.outcome;
    }
    if (event.type !== "resolution") {
      return null;
    }
    const summary =
      (event.resolved_event ?? event.content ?? pendingAct?.action ?? event.type).trim() ||
      event.type;
    return {
      summary,
      narration:
        (event.resolved_event ?? event.content ?? pendingAct?.narration ?? null) as string | null,
      succeeded: true,
      scene_id: snapshot.active_scene_id,
      zone_id: snapshot.active_zone_id,
      location_id: snapshot.active_location_id,
      task_status: "completed",
      metadata: event.metadata ? { ...event.metadata } : null,
    };
  }

  private applyWorldStateEvent(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): EventNotification {
    const snapshot = this.syncWorldStateForHandle(handle);
    const agentId = this.resolveEventAgentId(handle, event);
    const pendingAct = this.peekStructuredAct(handle.simulationId, agentId);
    const enrichedEvent: EventNotification = {
      ...event,
      acting_agent: event.acting_agent ?? agentId ?? undefined,
      intent: event.intent ?? pendingAct?.intent ?? null,
      outcome: this.buildStructuredOutcome(event, pendingAct, snapshot),
    };
    const applied = applyEventToWorldState(snapshot, enrichedEvent);
    this.worldStates.set(handle.simulationId, applied.snapshot);

    if (
      enrichedEvent.type === "resolution" ||
      enrichedEvent.type === "error" ||
      enrichedEvent.type === "terminate"
    ) {
      this.clearStructuredAct(handle.simulationId, agentId);
    }

    return {
      ...enrichedEvent,
      world_event: {
        ...applied.worldEvent,
        event_id: String(handle.replayCursor + 1),
      },
    };
  }

  private inferEventTrustSource(event: EventNotification): ConcordiaTrustSource {
    if (event.type === "action") {
      return "agent";
    }
    if (event.type === "error") {
      return "external";
    }
    return "system";
  }

  private buildEventTrustRecord(
    event: EventNotification,
    source: ConcordiaTrustSource,
  ): ConcordiaTrustRecord {
    const base = source === "system"
      ? 0.96
      : source === "user"
        ? 0.88
        : source === "external"
          ? 0.72
          : 0.6;
    const confidence = source === "system" ? 0.94 : source === "external" ? 0.7 : 0.78;
    return {
      source,
      confidence,
      threshold: 0.58,
      score: Math.min(1, base * 0.7 + confidence * 0.3),
    };
  }

  private buildEventProvenance(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
    source: ConcordiaTrustSource,
  ): readonly ConcordiaProvenanceRecord[] {
    return [{
      type: `concordia_event:${event.type}`,
      source,
      source_id: event.acting_agent ?? event.agent_name ?? "concordia-gm",
      simulation_id: handle.simulationId,
      lineage_id: handle.lineageId,
      parent_simulation_id: handle.parentSimulationId,
      world_id: handle.worldId,
      workspace_id: handle.workspaceId,
      event_id: event.world_event?.event_id ?? String(handle.replayCursor + 1),
      timestamp: event.timestamp ?? Date.now(),
      metadata: {
        step: event.step,
        type: event.type,
      },
    }];
  }

  private applyEventGovernance(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): EventNotification {
    const source = this.inferEventTrustSource(event);
    const trust = event.trust ?? this.buildEventTrustRecord(event, source);
    const provenance = event.provenance ?? this.buildEventProvenance(handle, event, source);
    return {
      ...event,
      visibility: event.visibility ?? "world-visible",
      trust,
      provenance,
      world_event: event.world_event
        ? {
            ...event.world_event,
            trust: event.world_event.trust ?? trust,
            provenance: event.world_event.provenance ?? provenance,
          }
        : event.world_event,
      metadata: {
        ...(event.metadata ?? {}),
        provenance_type: provenance[0]?.type ?? null,
        trust_source: trust.source,
        trust_score: trust.score,
      },
    };
  }
  private async handleActResult(params: {
    readonly request: ActRequest;
    readonly sessionId: string;
    readonly action: string;
    readonly narration: string | null;
    readonly intent: AgentIntent | null;
  }): Promise<void> {
    const session = this.sessionManager.findBySessionId(params.sessionId);
    if (!session) {
      return;
    }
    const handle = this.registry.get(session.simulationId) ?? null;
    if (!handle) {
      return;
    }
    const snapshot = this.syncWorldStateForHandle(handle);
    const applied = applyStructuredActResult(snapshot, {
      agentId: params.request.agent_id,
      agentName: params.request.agent_name,
      action: params.action,
      narration: params.narration,
      intent: params.intent,
      turnCount: session.turnCount,
      step: Math.max(handle.lastCompletedStep + 1, session.turnCount),
    });
    this.worldStates.set(handle.simulationId, applied.snapshot);
    this.rememberStructuredAct(handle.simulationId, params.request.agent_id, {
      action: params.action,
      narration: params.narration,
      intent: params.intent,
      step: Math.max(handle.lastCompletedStep + 1, session.turnCount),
      recordedAt: Date.now(),
    });
  }

  private async handleGetSimulationWorldState(
    simulationId: string,
  ): Promise<WorldStateSnapshot | null> {
    const handle = this.registry.get(simulationId) ?? null;
    if (handle) {
      return this.syncWorldStateForHandle(handle);
    }
    return this.worldStates.get(simulationId) ?? null;
  }

  private async handleGetWorldProjection(
    simulationId: string,
    agentId: string,
  ): Promise<WorldProjection | null> {
    const snapshot = await this.handleGetSimulationWorldState(simulationId);
    return snapshot ? buildWorldProjection(snapshot, agentId) : null;
  }

  // ==========================================================================
  // Internal handlers
  // ==========================================================================

  private async handleSetup(
    request: SetupRequest,
  ): Promise<Record<string, string>> {
    let handle = await this.prepareSetupHandle(request);
    const resolvedMemory = await this.resolveHandleMemoryContext(
      handle,
      request.world_id,
      request.workspace_id,
    );
    handle = resolvedMemory.handle;
    const { memoryCtx } = resolvedMemory;

    this.sessionManager.clearSimulation(handle.simulationId, handle.workspaceId);
    const sessions = await this.hydrateSetupSessions(handle, request, memoryCtx);
    this.syncWorldStateForHandle(handle);
    await this.storePremiseIfPresent(memoryCtx, request.premise);
    return sessions;
  }

  private async handleReset(): Promise<void> {
    await this.resetAllSimulations();
    this.registry.clear();
    this.sessionManager.clear();
    this.worldStates.clear();
    this.structuredActs.clear();
  }

  private async handleCheckpoint(
    request: CheckpointRequest,
  ): Promise<Record<string, unknown>> {
    const manifest = buildCheckpointRequestManifest(request);
    let handle = await this.ensureCheckpointHandle(request);

    const resolvedMemory = await this.resolveHandleMemoryContext(
      handle,
      request.world_id,
      request.workspace_id,
    );
    handle = resolvedMemory.handle;
    const { memoryCtx } = resolvedMemory;

    await this.runCheckpointMaintenanceIfNeeded(memoryCtx);
    handle = await this.refreshSimulationStatus(handle);

    const sessions = this.buildCheckpointSessions(request);
    const agent_states = await this.buildCheckpointAgentStates(
      sessions,
      request.simulation_id,
    );
    const enrichedManifest = this.buildCheckpointManifestForHandle(
      manifest,
      handle,
      sessions,
      memoryCtx,
    );
    const checkpointStatus = this.buildCheckpointStatusForHandle(
      enrichedManifest,
      memoryCtx,
    );
    this.registry.setCheckpoint(handle.simulationId, checkpointStatus);

    return this.buildCheckpointResponse(
      request,
      handle,
      sessions,
      agent_states,
      enrichedManifest,
      checkpointStatus,
    );
  }

  private async handleResume(
    request: ResumeRequest,
  ): Promise<Record<string, unknown>> {
    const checkpoint = normalizeCheckpointManifest(request.checkpoint);
    const config = checkpoint.config;
    const worldId = checkpoint.world_id;
    const workspaceId = checkpoint.workspace_id;
    const checkpointSimulationId = checkpoint.simulation_id;
    const checkpointLineageId = checkpoint.lineage_id;
    const resumedSimulationId = request.simulation_id ?? randomUUID();
    const resumedLineageId =
      request.lineage_id ??
      checkpointLineageId ??
      checkpointSimulationId ??
      resumedSimulationId;
    const resumedParentSimulationId =
      request.parent_simulation_id ??
      checkpointSimulationId ??
      checkpoint.parent_simulation_id ??
      null;
    const premise = asString(config.premise) ?? "";
    const rawAgents = Array.isArray(config.agents) ? config.agents : [];
    const agents = this.normalizeResumeAgents(rawAgents);
    const entityStates = asRecord(checkpoint.entity_states);
    await this.cleanupExistingSimulationHandle(
      resumedSimulationId,
      "Concordia simulation resume replacement",
      this.buildResumeReplacementCleanupOptions(),
    );

    const resumeState = buildResumeHandleState(
      worldId,
      workspaceId,
      resumedSimulationId,
      resumedLineageId,
      resumedParentSimulationId,
      request,
      checkpoint,
      config,
      agents,
      premise,
    );
    const resumeHandleRequest = this.resolveResumeHandleRequest(resumeState);
    const resumedFromStep = checkpoint.step;

    const { handle, memoryCtx } = await this.createResumedHandleWithMemory(
      resumeHandleRequest,
      worldId,
      workspaceId,
      buildCheckpointMetadataFromManifest(checkpoint),
    );
    const sessions = await this.resumeSimulationSessions(
      handle,
      agents,
      worldId,
      workspaceId,
      memoryCtx,
      entityStates,
      resumedFromStep,
    );
    this.syncWorldStateForHandle(handle);
    const checkpointStatus = this.buildCheckpointStatusForHandle(checkpoint, memoryCtx);
    this.registry.setCheckpoint(handle.simulationId, checkpointStatus);

    return buildResumeResponse(
      worldId,
      workspaceId,
      resumedSimulationId,
      resumedLineageId,
      resumedParentSimulationId,
      resumedFromStep,
      sessions,
      checkpointStatus,
    );
  }

  private async createResumedHandleWithMemory(
    resumeHandleRequest: NormalizedLaunchRequest,
    worldId: string,
    workspaceId: string,
    checkpointMetadata: Record<string, unknown>,
  ): Promise<{
    handle: ConcordiaSimulationHandle;
    memoryCtx: MemoryWiringContext | null;
  }> {
    const handle = await this.createSimulationHandle(
      resumeHandleRequest,
      CREATE_RESUME_HANDLE_OPTIONS,
    );
    const resolvedMemory = await this.resolveHandleMemoryContext(
      handle,
      worldId,
      workspaceId,
      {
        continuityMode: "lineage_resume",
        checkpointMetadata,
      },
    );
    return {
      handle: resolvedMemory.handle,
      memoryCtx: resolvedMemory.memoryCtx,
    };
  }

  private async resumeSimulationSessions(
    handle: ConcordiaSimulationHandle,
    agents: SetupRequest["agents"],
    worldId: string,
    workspaceId: string,
    memoryCtx: MemoryWiringContext | null,
    entityStates: Record<string, unknown>,
    resumedFromStep: number,
  ): Promise<Record<string, string>> {
    this.registry.updateLifecycle(
      handle.simulationId,
      this.buildResumeLifecycleUpdate(resumedFromStep),
    );
    this.sessionManager.clearSimulation(handle.simulationId, handle.workspaceId);
    return this.hydrateResumedSimulationSessions(
      handle,
      agents,
      worldId,
      workspaceId,
      memoryCtx,
      entityStates,
    );
  }

  private buildResumeLifecycleUpdate(
    resumedFromStep: number,
  ): Parameters<SimulationRegistry["updateLifecycle"]>[1] {
    return {
      status: "paused",
      reason: "resumed_from_checkpoint",
      error: null,
      lastCompletedStep: resumedFromStep,
      endedAt: null,
    };
  }

  private hydrateResumedSimulationSessions(
    handle: ConcordiaSimulationHandle,
    agents: SetupRequest["agents"],
    worldId: string,
    workspaceId: string,
    memoryCtx: MemoryWiringContext | null,
    entityStates: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    return this.hydrateSimulationSessions({
      handle,
      agents,
      worldId,
      workspaceId,
      memoryCtx,
      entityStates,
    });
  }

  private async handleAct(
    agentId: string,
    sessionId: string,
    message: string,
    requestId: string,
  ): Promise<string> {
    const session = this.sessionManager.findBySessionId(sessionId);
    if (!session) {
      return "Agent not found — cannot act.";
    }

    const handle = this.registry.get(session.simulationId) ?? null;
    if (!handle) {
      this.context.logger.warn?.(
        `[concordia] Rejecting /act for unknown simulation ${session.simulationId}`,
      );
      throw new Error(`Simulation ${session.simulationId} is not active`);
    }

    const simulationContext = buildSimulationSystemContext({
      worldId: session.worldId,
      agentName: session.agentName,
      turnCount: session.turnCount + 1,
      premise: handle.premise,
    });
    const contextBlocks: string[] = [simulationContext];
    const memoryContext = await this.loadActMemoryContext(
      handle,
      agentId,
      sessionId,
      message,
    );
    if (memoryContext) {
      contextBlocks.push(memoryContext);
    }
    contextBlocks.push(message);
    const enrichedMessage = contextBlocks.join("\n\n");

    const inbound = this.buildActInboundMessage({
      agentId,
      session,
      sessionId,
      requestId,
      enrichedMessage,
    });

    const action = await this.dispatchInboundAwaitingResponse(handle, {
      requestId,
      inbound,
      sessionId,
      agentId,
      timeoutMs: handle.launchRequest.run_budget?.act_timeout_ms ?? this.operations.actTimeoutMs,
      timeoutLog: `[concordia] /act timeout for ${session.agentName} after ${handle.launchRequest.run_budget?.act_timeout_ms ?? this.operations.actTimeoutMs}ms`,
      worldId: session.worldId,
      step: handle.lastCompletedStep,
      simulationId: session.simulationId,
      logMessageLength: message.length,
    });

    session.lastAction = action;
    session.turnCount += 1;

    await this.recordAgentActionIfAvailable(
      handle,
      agentId,
      sessionId,
      action,
    );

    return action;
  }

  private async handleObserve(
    agentId: string,
    sessionId: string,
    observation: string,
  ): Promise<void> {
    const session = this.sessionManager.findBySessionId(sessionId);
    const handle = session ? this.registry.get(session.simulationId) ?? null : null;
    if (session && !handle) {
      this.context.logger.warn?.(
        `[concordia] Ignoring /observe for unknown simulation ${session.simulationId}`,
      );
      return;
    }

    await this.recordObservationIfAvailable(
      handle,
      agentId,
      sessionId,
      observation,
    );

    const inbound = this.buildObservationInboundMessage({
      agentId,
      sessionId,
      observation,
      session: session ?? null,
      handle,
    });

    try {
      await this.context.on_message(inbound);
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] observe ingestion failed for ${agentId}:`,
        err,
      );
    }
  }

  private buildObservationInboundMessage(params: {
    agentId: string;
    sessionId: string;
    observation: string;
    session: AgentSession | null;
    handle: ConcordiaSimulationHandle | null;
  }): ChannelInboundMessage {
    const identity = params.session
      ? this.sessionIdentity(params.session)
      : this.handleIdentity(params.handle);

    return {
      id: randomUUID(),
      channel: "concordia",
      sender_id: "concordia-gm",
      sender_name: "Game Master",
      session_id: params.sessionId,
      scope: "dm",
      content: `[Observation] ${params.observation}`,
      timestamp: Date.now(),
      metadata: this.buildObservationMetadata(params.agentId, params.session, identity),
    };
  }

  private buildObservationMetadata(
    agentId: string,
    session: AgentSession | null,
    identity: SimulationIdentity,
  ): Record<string, unknown> {
    return {
      type: "concordia_observation",
      provenance: "concordia:gm_observation",
      concordia_tag: "observation",
      ingest_only: true,
      history_role: "system",
      world_id: session?.worldId,
      workspace_id: session?.workspaceId,
      agent_id: agentId,
      is_observation: true,
      ...withSimulationIdentity({}, identity),
    };
  }

  private async handleEvent(event: EventNotification): Promise<void> {
    const handle = this.registry.get(event.simulation_id) ?? null;
    if (!handle) {
      this.context.logger.warn?.(
        `[concordia] Ignoring event for unknown simulation ${event.simulation_id}`,
      );
      return;
    }

    const enrichedEvent = this.applyEventGovernance(
      handle,
      this.applyWorldStateEvent(handle, event),
    );
    const replayEvent = this.registry.appendReplayEvent(handle.simulationId, enrichedEvent);
    this.context.logger.debug?.(
      this.buildEventDebugLog(enrichedEvent, replayEvent.event_id),
    );

    this.registry.updateLifecycle(
      handle.simulationId,
      this.buildEventLifecycleUpdate(handle, enrichedEvent),
    );

    if (!handle.memoryCtx) {
      return;
    }

    const memoryEvent = this.normalizeMemoryEvent(enrichedEvent);
    await this.maybeRunResolutionPeriodicTasks(handle, memoryEvent);
    await this.recordSimulationEventSideEffects(handle, memoryEvent);
  }

  private buildEventDebugLog(
    event: EventNotification,
    replayEventId: string,
  ): string {
    const actingAgent = event.acting_agent ?? event.agent_name ?? "gm";
    const contentPreview = (event.resolved_event ?? event.content ?? "").slice(0, 80);
    return [
      "[concordia] Event:",
      `simulation=${event.simulation_id}`,
      `step=${event.step}`,
      `type=${event.type}`,
      `event_id=${replayEventId}`,
      `agent=${actingAgent}`,
      contentPreview,
    ].join(" ");
  }

  private buildEventLifecycleUpdate(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): {
    lastCompletedStep: number;
    lastStepOutcome: string | null;
  } {
    const lastCompletedStep =
      event.type === "step"
        ? Math.max(handle.lastCompletedStep, event.step)
        : handle.lastCompletedStep;
    const lastStepOutcome =
      event.type === "resolution"
        ? (event.resolved_event ?? event.content ?? "").slice(0, 240)
        : handle.lastStepOutcome;

    return {
      lastCompletedStep,
      lastStepOutcome,
    };
  }

  private async handleGetAgentState(
    agentId: string,
    simulationId: string | null = null,
  ): Promise<AgentStateResponse | null> {
    const handle = this.getHandleForSimulation(simulationId);
    const session = handle
      ? this.sessionManager.getForWorld({
          agentId,
          worldId: handle.worldId,
          workspaceId: handle.workspaceId,
          simulationId: handle.simulationId,
        })
      : this.sessionManager.findForSimulation({
          agentId,
          simulationId: simulationId ?? undefined,
        });
    if (!session) return null;

    const memoryCtx =
      handle?.memoryCtx ??
      this.registry.get(session.simulationId)?.memoryCtx ??
      null;
    const persistedState = await this.tryLoadPersistedAgentState(
      agentId,
      session,
      memoryCtx,
    );

    const worldState = handle
      ? this.syncWorldStateForHandle(handle)
      : this.worldStates.get(session.simulationId) ?? null;
    if (worldState) {
      const structuredState = buildAgentStateFromWorldState(worldState, agentId, {
        identity: persistedState?.identity ?? this.buildFallbackIdentity(session),
        memoryCount: persistedState?.memoryCount ?? session.observations.length,
        recentMemories:
          persistedState?.recentMemories ?? this.buildFallbackRecentMemories(session),
        simulationId: session.simulationId,
        lineageId: session.lineageId ?? null,
        parentSimulationId: session.parentSimulationId ?? null,
      });
      if (structuredState) {
        return structuredState;
      }
    }

    if (persistedState) {
      return persistedState;
    }

    return this.buildFallbackAgentState(session);
  }

  private async tryLoadPersistedAgentState(
    agentId: string,
    session: AgentSession,
    memoryCtx: MemoryWiringContext | null,
  ): Promise<AgentStateResponse | null> {
    if (!memoryCtx) {
      return null;
    }

    try {
      const state = (await loadAgentState(
        memoryCtx,
        agentId,
        session.sessionId,
        session.turnCount,
        session.lastAction,
      )) as unknown as AgentStateResponse;
      return this.attachSessionIdentity(state, session);
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] getAgentState failed for ${agentId}:`,
        err,
      );
      return null;
    }
  }

  private buildFallbackAgentState(session: AgentSession): AgentStateResponse {
    return {
      simulationId: session.simulationId,
      lineageId: session.lineageId ?? null,
      parentSimulationId: session.parentSimulationId ?? null,
      identity: this.buildFallbackIdentity(session),
      memoryCount: session.observations.length,
      recentMemories: this.buildFallbackRecentMemories(session),
      relationships: [],
      worldFacts: [],
      turnCount: session.turnCount,
      lastAction: session.lastAction,
    };
  }

  private attachSessionIdentity(
    state: AgentStateResponse,
    session: AgentSession,
  ): AgentStateResponse {
    return {
      simulationId: session.simulationId,
      lineageId: session.lineageId ?? null,
      parentSimulationId: session.parentSimulationId ?? null,
      ...state,
    };
  }

  private buildFallbackIdentity(session: AgentSession): NonNullable<AgentStateResponse["identity"]> {
    return {
      name: session.agentName,
      personality: "",
      learnedTraits: [],
      beliefs: {},
    };
  }

  private buildFallbackRecentMemories(
    session: AgentSession,
  ): AgentStateResponse["recentMemories"] {
    return session.observations.slice(-5).map((content: string) => ({
      content: content.slice(0, 200),
      role: "system",
      timestamp: Date.now(),
    }));
  }

  private async handleGenerateAgents(
    request: GenerateAgentsRequest,
    requestId: string,
  ): Promise<{ agents: readonly GeneratedAgent[] }> {
    const count = Math.max(
      2,
      Math.min(MAX_GENERATED_AGENTS, request.count || 3),
    );
    const sessionId = `concordia:generator:${randomUUID()}`;
    const prompt = [
      `Generate exactly ${count} diverse characters for this simulation scenario.`,
      "",
      `Premise: ${request.premise}`,
      "",
      'Respond exactly with ONLY a JSON array (no markdown, no prose). Each item must contain "id", "name", "personality", and "goal".',
      'Use lowercase hyphenated "id" values.',
      "Make the characters meaningfully different so the simulation has conflict, alliances, and competing incentives.",
    ].join("\n");

    const worldId = request.worldId ?? "generated-world";
    const { handle, ephemeralHandle } = await this.ensureGenerationHandle(
      request,
      worldId,
    );

    const dispatchRequest = this.buildGenerateAgentsDispatchRequest(
      requestId,
      sessionId,
      prompt,
      worldId,
      handle,
    );

    try {
      const rawResponse = await this.dispatchInboundAwaitingResponse(
        handle,
        dispatchRequest,
      );
      const agents = this.parseGeneratedAgents(rawResponse);
      return { agents };
    } finally {
      this.cleanupEphemeralGenerationHandle(ephemeralHandle);
    }
  }

  private buildResumeReplacementCleanupOptions(): SimulationCleanupOptions {
    return {
      status: "stopped",
      removeHandle: true,
      stopRunner: true,
      removeSessions: true,
      runPostCleanup: false,
      clearMemoryContext: true,
    };
  }

  private cleanupEphemeralGenerationHandle(
    handle: ConcordiaSimulationHandle | null,
  ): void {
    if (!handle) return;
    this.clearPendingResponsesForSimulation(
      handle,
      "Concordia agent generation cleanup",
    );
    this.registry.deleteHandle(handle.simulationId);
  }

  private buildGenerateAgentsDispatchRequest(
    requestId: string,
    sessionId: string,
    prompt: string,
    worldId: string,
    handle: ConcordiaSimulationHandle,
  ): PendingDispatchRequest {
    return {
      requestId,
      inbound: this.buildGenerateAgentsInboundMessage(
        sessionId,
        prompt,
        requestId,
        worldId,
        handle,
      ),
      sessionId,
      agentId: "concordia-agent-generator",
      timeoutMs: this.operations.generateAgentsTimeoutMs,
      timeoutLog: `[concordia] /generate-agents timed out after ${this.operations.generateAgentsTimeoutMs}ms`,
      worldId,
      step: handle.lastCompletedStep,
      simulationId: handle.simulationId,
      logMessageLength: prompt.length,
    };
  }

  private buildGenerateAgentsInboundMessage(
    sessionId: string,
    prompt: string,
    requestId: string,
    worldId: string,
    handle: ConcordiaSimulationHandle,
  ): ChannelInboundMessage {
    const metadata = this.buildGenerateAgentsMetadata(
      requestId,
      worldId,
      handle,
    );
    return {
      id: randomUUID(),
      channel: "concordia",
      sender_id: "concordia-agent-generator",
      sender_name: "Concordia Agent Generator",
      session_id: sessionId,
      scope: "dm",
      content: prompt,
      timestamp: Date.now(),
      metadata,
    };
  }

  private buildGenerateAgentsMetadata(
    requestId: string,
    worldId: string,
    handle: ConcordiaSimulationHandle,
  ): Record<string, unknown> {
    return {
      type: "concordia_generate_agents",
      request_id: requestId,
      world_id: worldId,
      ...withSimulationIdentity({}, this.handleIdentity(handle)),
    };
  }

  private async ensureGenerationHandle(
    request: GenerateAgentsRequest,
    worldId: string,
  ): Promise<{
    handle: ConcordiaSimulationHandle;
    ephemeralHandle: ConcordiaSimulationHandle | null;
  }> {
    const ephemeralHandle = await this.createSimulationHandle(
      {
        world_id: worldId,
        workspace_id: `concordia-generator:${randomUUID()}`,
        simulation_id: randomUUID(),
        lineage_id: null,
        parent_simulation_id: null,
        agents: [],
        premise: request.premise,
      },
      {
        status: "paused",
        reservePorts: false,
        currentAlias: false,
      },
    );
    return {
      handle: ephemeralHandle,
      ephemeralHandle,
    };
  }

  private buildLaunchReplacementCleanupOptions(): SimulationCleanupOptions {
    return {
      status: "stopped",
      removeHandle: false,
      stopRunner: true,
      removeSessions: true,
      runPostCleanup: true,
      clearMemoryContext: true,
    };
  }

  private async prepareLaunchHandle(
    launchRequest: NormalizedLaunchRequest,
  ): Promise<ConcordiaSimulationHandle> {
    const existingHandle = await this.loadReusableLaunchHandle(launchRequest);
    if (!existingHandle) {
      return this.createLaunchingHandle(launchRequest);
    }
    return this.refreshLaunchHandle(existingHandle, launchRequest);
  }

  private createLaunchingHandle(
    launchRequest: NormalizedLaunchRequest,
  ): Promise<ConcordiaSimulationHandle> {
    return this.createSimulationHandle(
      launchRequest,
      CREATE_LAUNCHING_HANDLE_OPTIONS,
    );
  }

  private async loadReusableLaunchHandle(
    launchRequest: NormalizedLaunchRequest,
  ): Promise<ConcordiaSimulationHandle | null> {
    let handle = this.registry.get(launchRequest.simulation_id) ?? null;
    if (!handle?.runner) {
      return handle;
    }
    await this.cleanupSimulationHandle(
      handle,
      "Concordia simulation launch replacement",
      this.buildLaunchReplacementCleanupOptions(),
    );
    handle = this.registry.get(launchRequest.simulation_id) ?? null;
    return handle;
  }

  private async refreshLaunchHandle(
    handle: ConcordiaSimulationHandle,
    launchRequest: NormalizedLaunchRequest,
  ): Promise<ConcordiaSimulationHandle> {
    const reserved = await this.registry.reservePorts(
      this.buildLaunchPortReservation(handle, launchRequest),
    );
    handle = this.registry.setLaunchMetadata(
      handle.simulationId,
      this.buildLaunchMetadata(launchRequest),
    );
    handle.launchRequest = this.mergeLaunchRequestWithReservedPorts(
      handle,
      launchRequest,
      reserved,
    );
    handle = this.registry.updateLifecycle(
      handle.simulationId,
      this.buildLaunchLifecycleUpdate(reserved),
    );
    this.registry.setCurrentAlias(handle.simulationId);
    return handle;
  }

  private buildLaunchPortReservation(
    handle: ConcordiaSimulationHandle,
    launchRequest: NormalizedLaunchRequest,
  ): {
    readonly controlPort?: number;
    readonly eventPort?: number;
  } {
    return {
      controlPort:
        launchRequest.control_port ?? handle.controlPort ?? undefined,
      eventPort: launchRequest.event_port ?? handle.eventPort ?? undefined,
    };
  }

  private buildLaunchMetadata(
    launchRequest: NormalizedLaunchRequest,
  ): Parameters<ConcordiaChannelAdapter["registry"]["setLaunchMetadata"]>[1] {
    return {
      worldId: launchRequest.world_id,
      workspaceId: launchRequest.workspace_id,
      lineageId: launchRequest.lineage_id,
      parentSimulationId: launchRequest.parent_simulation_id,
      premise: launchRequest.premise,
      userId: launchRequest.user_id,
      agents: launchRequest.agents,
      maxSteps: launchRequest.max_steps ?? null,
      gmModel: launchRequest.gm_model,
      gmProvider: launchRequest.gm_provider,
      gmInstructions: launchRequest.gm_instructions,
      scenes: launchRequest.scenes,
      runBudget: launchRequest.run_budget ?? null,
    };
  }

  private mergeLaunchRequestWithReservedPorts(
    handle: ConcordiaSimulationHandle,
    launchRequest: NormalizedLaunchRequest,
    reserved: ReservedSimulationPorts,
  ): ConcordiaSimulationHandle["launchRequest"] {
    return {
      ...handle.launchRequest,
      ...launchRequest,
      control_port: reserved.controlPort,
      event_port: reserved.eventPort,
    };
  }

  private buildLaunchLifecycleUpdate(
    reserved: ReservedSimulationPorts,
  ): Parameters<ConcordiaChannelAdapter["registry"]["updateLifecycle"]>[1] {
    return {
      status: "launching",
      executionPhase: "launching",
      reason: null,
      error: null,
      startedAt: null,
      endedAt: null,
      pid: null,
      controlPort: reserved.controlPort,
      eventPort: reserved.eventPort,
    };
  }

  private buildRunnerLaunchInput(
    handle: ConcordiaSimulationHandle,
  ): Parameters<typeof launchSimulationRunner>[0] {
    return {
      request: handle.launchRequest,
      config: this.context.config,
      logger: this.context.logger,
      runnerStartupTimeoutMs: this.operations.runnerStartupTimeoutMs,
      runnerShutdownTimeoutMs: this.operations.runnerShutdownTimeoutMs,
    };
  }

  private async startSimulationRunner(
    handle: ConcordiaSimulationHandle,
  ): Promise<ConcordiaSimulationHandle> {
    const runner = await launchSimulationRunner(this.buildRunnerLaunchInput(handle));
    const updatedHandle = this.registry.attachRunner(
      handle.simulationId,
      runner,
      runner.child.pid ?? null,
    );
    runner.child.once(
      "exit",
      this.handleRunnerExit.bind(this, updatedHandle.simulationId, runner),
    );
    return updatedHandle;
  }

  private handleRunnerExit(
    simulationId: string,
    runner: SpawnedSimulationRunner,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const exitMessage = `[concordia] runner exited code=${String(code)} signal=${String(signal)}`;
    this.context.logger.info?.(exitMessage);
    const currentHandle = this.registry.get(simulationId) ?? null;
    if (!currentHandle || currentHandle.runner !== runner) {
      return;
    }
    const stopRequested = currentHandle.status === "stopping" ||
      currentHandle.status === "stopped" ||
      currentHandle.reason === "stop_requested" ||
      currentHandle.reason === "stopped_by_user";
    const status: SimulationLifecycleStatus = stopRequested
      ? "stopped"
      : signal === "SIGTERM"
        ? "stopped"
        : code === 0
          ? "finished"
          : "failed";
    const reason = stopRequested
      ? "stopped_by_user"
      : status === "finished"
        ? currentHandle.reason ?? "completed"
        : exitMessage;
    void this.cleanupSimulationHandle(
      currentHandle,
      reason,
      this.buildRunnerExitCleanupOptions(status, exitMessage),
    );
  }

  private buildRunnerExitCleanupOptions(
    status: SimulationLifecycleStatus,
    exitMessage: string,
  ): SimulationCleanupOptions {
    return {
      status,
      removeHandle: false,
      stopRunner: false,
      removeSessions: false,
      runPostCleanup: true,
      clearMemoryContext: false,
      error: status === "failed" ? exitMessage : null,
    };
  }

  private async handleLaunch(
    request: LaunchRequest,
  ): Promise<Record<string, unknown>> {
    this.pruneHistoricalSimulations();
    const defaults = resolveConcordiaLaunchDefaults(this.context);
    const launchRequest = this.normalizeLaunchRequest({
      ...request,
      gm_provider: request.gm_provider ?? defaults.gm_provider,
      gm_model: request.gm_model ?? defaults.gm_model,
      gm_api_key: request.gm_api_key ?? defaults.gm_api_key,
      gm_base_url: request.gm_base_url ?? defaults.gm_base_url,
      run_budget: resolveRunBudget(request, this.operations),
    });

    this.ensureLaunchAdmission(launchRequest.simulation_id);
    let handle = await this.prepareLaunchHandle(launchRequest);

    try {
      handle = await this.startSimulationRunner(handle);
    } catch (error) {
      this.registry.detachRunner(handle.simulationId);
      this.registry.updateLifecycle(
        handle.simulationId,
        this.buildLaunchFailureLifecycleUpdate(error),
      );
      this.pruneHistoricalSimulations();
      throw error;
    }

    return {
      world_id: handle.worldId,
      workspace_id: handle.workspaceId,
      simulation_id: handle.simulationId,
      lineage_id: handle.lineageId,
      parent_simulation_id: handle.parentSimulationId,
      pid: handle.pid,
    };
  }

  private async closeBridgeServer(): Promise<void> {
    if (!this.bridgeServer) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.bridgeServer!.close(() => resolve());
    });
    this.bridgeServer = null;
  }

  private buildLaunchFailureLifecycleUpdate(
    error: unknown,
  ): Parameters<ConcordiaChannelAdapter["registry"]["updateLifecycle"]>[1] {
    return {
      status: "failed",
      reason: "launch_failed",
      error: error instanceof Error ? error.message : String(error),
      endedAt: Date.now(),
    };
  }


  private ensureLaunchAdmission(
    reusableSimulationId: string,
  ): void {
    const activeCount = this.registry.countActiveHandles(reusableSimulationId);
    if (activeCount >= this.operations.maxConcurrentSimulations) {
      throw new ConcordiaAdmissionError(
        this.operations.maxConcurrentSimulations,
        activeCount,
      );
    }
  }

  private pruneHistoricalSimulations(): void {
    const pruned = this.registry.pruneHistoricalHandles({
      maxHistoricalSimulations: this.operations.maxHistoricalSimulations,
      archivedSimulationRetentionMs: this.operations.archivedSimulationRetentionMs,
      archivedReplayEventLimit: this.operations.archivedReplayEventLimit,
    });
    for (const removed of pruned.removedSessions) {
      this.sessionManager.clearSimulation(
        removed.simulationId,
        removed.workspaceId,
      );
      this.worldStates.delete(removed.simulationId);
      this.structuredActs.delete(removed.simulationId);
    }
    if (pruned.removedSimulationIds.length > 0 || pruned.trimmedReplayEvents > 0) {
      this.context.logger.info?.(
        `[concordia] pruned historical simulations removed=${pruned.removedSimulationIds.length} trimmed_replay_events=${pruned.trimmedReplayEvents}`,
      );
    }
  }

  private buildOperationalMetrics(
    metrics: BridgeMetrics,
  ): ConcordiaOperationalMetrics {
    return buildOperationalMetricsSnapshot(this.registry, this.operations, {
      launchRequests: metrics.launchRequests,
      rejectedLaunches: metrics.rejectedLaunches,
    });
  }

  private createSetupHandle(
    request: SetupRequest,
  ): Promise<ConcordiaSimulationHandle> {
    return this.createSimulationHandle(
      this.buildSetupHandleRequest(request),
      CREATE_SETUP_HANDLE_OPTIONS,
    );
  }

  private buildSetupLaunchMetadata(
    request: SetupRequest,
    existingHandle: ConcordiaSimulationHandle,
  ): Parameters<ConcordiaChannelAdapter["registry"]["setLaunchMetadata"]>[1] {
    return {
      worldId: request.world_id,
      workspaceId: request.workspace_id,
      lineageId: request.lineage_id ?? existingHandle.lineageId,
      parentSimulationId:
        request.parent_simulation_id ?? existingHandle.parentSimulationId,
      premise: request.premise,
      userId: request.user_id ?? existingHandle.userId,
      agents: request.agents,
    };
  }

  private buildSetupLifecycleReset():
    Parameters<ConcordiaChannelAdapter["registry"]["updateLifecycle"]>[1] {
    return {
      reason: null,
      error: null,
    };
  }

  private buildResumeRunBudget(
    config: Record<string, unknown>,
  ): LaunchRequest["run_budget"] | null {
    const actTimeoutMs = asNumber(config.act_timeout_ms);
    const simultaneousMaxWorkers = asNumber(config.simultaneous_max_workers);
    const proxyActionTimeoutSeconds = asNumber(config.proxy_action_timeout_seconds);
    const proxyActionMaxRetries = asNumber(config.proxy_action_max_retries);
    const proxyRetryDelaySeconds = asNumber(config.proxy_retry_delay_seconds);

    if (
      actTimeoutMs === undefined &&
      simultaneousMaxWorkers === undefined &&
      proxyActionTimeoutSeconds === undefined &&
      proxyActionMaxRetries === undefined &&
      proxyRetryDelaySeconds === undefined
    ) {
      return null;
    }

    return {
      ...(actTimeoutMs !== undefined ? { act_timeout_ms: actTimeoutMs } : {}),
      ...(simultaneousMaxWorkers !== undefined
        ? { simultaneous_max_workers: simultaneousMaxWorkers }
        : {}),
      ...(proxyActionTimeoutSeconds !== undefined
        ? { proxy_action_timeout_seconds: proxyActionTimeoutSeconds }
        : {}),
      ...(proxyActionMaxRetries !== undefined
        ? { proxy_action_max_retries: proxyActionMaxRetries }
        : {}),
      ...(proxyRetryDelaySeconds !== undefined
        ? { proxy_retry_delay_seconds: proxyRetryDelaySeconds }
        : {}),
    };
  }

  private assignOptionalResumeLaunchFields(
    request: MutableNormalizedLaunchRequest,
    config: Record<string, unknown>,
  ): void {
    const maxSteps = asNumber(config.max_steps);
    const gmModel = asString(config.gm_model);
    const gmProvider = asString(config.gm_provider);
    const gmApiKey = asString(config.gm_api_key);
    const gmBaseUrl = asString(config.gm_base_url);
    const engineType = asString(config.engine_type);
    const gmPrefab = asString(config.gm_prefab);
    const runBudget = this.buildResumeRunBudget(config);

    if (maxSteps !== undefined) {
      request.max_steps = maxSteps;
    }
    if (gmModel) {
      request.gm_model = gmModel;
    }
    if (gmProvider) {
      request.gm_provider = gmProvider;
    }
    if (gmApiKey) {
      request.gm_api_key = gmApiKey;
    }
    if (gmBaseUrl) {
      request.gm_base_url = gmBaseUrl;
    }
    if (engineType) {
      request.engine_type = engineType as "sequential" | "simultaneous";
    }
    if (gmPrefab) {
      request.gm_prefab = gmPrefab;
    }
    const gmInstructions = asString(config.gm_instructions);
    if (gmInstructions) {
      request.gm_instructions = gmInstructions;
    }
    const scenes = config.scenes;
    if (Array.isArray(scenes)) {
      request.scenes = scenes as NormalizedLaunchRequest["scenes"];
    }
    if (runBudget) {
      request.run_budget = runBudget;
    }
  }

  private buildSetupHandleRequest(
    request: SetupRequest,
  ): NormalizedLaunchRequest {
    return {
      world_id: request.world_id,
      workspace_id: request.workspace_id,
      simulation_id: request.simulation_id,
      lineage_id: request.lineage_id ?? null,
      parent_simulation_id: request.parent_simulation_id ?? null,
      user_id: request.user_id,
      agents: request.agents,
      premise: request.premise,
    };
  }

  private async prepareSetupHandle(
    request: SetupRequest,
  ): Promise<ConcordiaSimulationHandle> {
    const existingHandle = this.registry.get(request.simulation_id) ?? null;
    if (!existingHandle) {
      return this.createSetupHandle(request);
    }

    const updatedHandle = this.registry.setLaunchMetadata(
      existingHandle.simulationId,
      this.buildSetupLaunchMetadata(request, existingHandle),
    );
    this.registry.updateLifecycle(
      updatedHandle.simulationId,
      this.buildSetupLifecycleReset(),
    );
    this.registry.setCurrentAlias(updatedHandle.simulationId);
    this.syncWorldStateForHandle(updatedHandle);
    return updatedHandle;
  }

  private async storePremiseIfPresent(
    memoryCtx: MemoryWiringContext | null,
    premise: string,
  ): Promise<void> {
    if (!memoryCtx || !premise) {
      return;
    }
    try {
      await storePremise(memoryCtx, premise);
    } catch (err) {
      this.context.logger.warn?.("[concordia] Failed to store premise:", err);
    }
  }

  private async hydrateSimulationSessions(params: {
    handle: ConcordiaSimulationHandle;
    agents: SetupRequest["agents"];
    worldId: string;
    workspaceId: string;
    memoryCtx: MemoryWiringContext | null;
    entityStates?: Record<string, unknown>;
    logSessionMapping?: boolean;
  }): Promise<Record<string, string>> {
    const sessions: Record<string, string> = {};
    for (const agent of params.agents) {
      const session = this.getOrCreateHydratedSession(params, agent);
      sessions[agent.agent_id] = session.sessionId;

      await this.setupAgentIdentityIfAvailable(
        params.memoryCtx,
        agent.agent_id,
        agent.agent_name,
        agent.personality,
        agent.goal ?? "",
      );
      this.restoreSessionStateFromEntityState(
        session,
        params.entityStates,
        agent.agent_name,
      );

      this.logHydratedSessionMapping(params.logSessionMapping, agent, session);
    }
    return sessions;
  }

  private getOrCreateHydratedSession(
    params: {
      handle: ConcordiaSimulationHandle;
      agents: SetupRequest["agents"];
      worldId: string;
      workspaceId: string;
      memoryCtx: MemoryWiringContext | null;
      entityStates?: Record<string, unknown>;
      logSessionMapping?: boolean;
    },
    agent: SetupRequest["agents"][number],
  ): AgentSession {
    return this.sessionManager.getOrCreate({
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      worldId: params.worldId,
      workspaceId: params.workspaceId,
      simulationId: params.handle.simulationId,
      lineageId: params.handle.lineageId,
      parentSimulationId: params.handle.parentSimulationId,
    });
  }

  private logHydratedSessionMapping(
    shouldLog: boolean | undefined,
    agent: SetupRequest["agents"][number],
    session: AgentSession,
  ): void {
    if (!shouldLog) return;
    this.context.logger.info?.(
      `[concordia] Agent setup: ${agent.agent_name} (${agent.agent_id}) -> ${session.sessionId}`,
    );
  }

  private async setupAgentIdentityIfAvailable(
    memoryCtx: MemoryWiringContext | null,
    agentId: string,
    agentName: string,
    personality: string,
    goal: string,
  ): Promise<void> {
    if (!memoryCtx) {
      return;
    }
    try {
      await setupAgentIdentity(memoryCtx, agentId, agentName, personality, goal);
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] Failed to setup identity for ${agentName}:`,
        err,
      );
    }
  }

  private restoreSessionStateFromEntityState(
    session: AgentSession,
    entityStates: Record<string, unknown> | undefined,
    agentName: string,
  ): void {
    if (!entityStates) {
      return;
    }
    const entityState = asRecord(entityStates[agentName]);
    const turnCount = asNumber(entityState.turn_count);
    session.turnCount = turnCount ?? session.turnCount;
    const lastLog = asRecord(entityState.last_log);
    const lastAction = asString(lastLog.action);
    session.lastAction = lastAction ?? session.lastAction;
  }

  private resolveResumeHandleRequest(
    params: ResumeHandleStateInput,
  ): NormalizedLaunchRequest {
    return this.buildResumeHandleRequest(
      buildResumeHandleParamsFromState(params),
    );
  }

  private buildResumeHandleRequest(
    params: ResumeHandleParamsInput,
  ): NormalizedLaunchRequest {
    const { config } = params;
    const request: MutableNormalizedLaunchRequest = {
      world_id: params.worldId,
      workspace_id: params.workspaceId,
      simulation_id: params.simulationId,
      lineage_id: params.lineageId,
      parent_simulation_id: params.parentSimulationId,
      user_id: params.userId,
      agents: params.agents,
      premise: params.premise,
    };
    this.assignOptionalResumeLaunchFields(request, config);
    return request;
  }

  private async cleanupExistingSimulationHandle(
    simulationId: string,
    reason: string,
    options: SimulationCleanupOptions,
  ): Promise<void> {
    const existingHandle = this.registry.get(simulationId) ?? null;
    if (!existingHandle) {
      return;
    }
    await this.cleanupSimulationHandle(existingHandle, reason, options);
  }

  private async stopAllSimulations(): Promise<void> {
    await this.cleanupAllSimulations(
      "Concordia bridge stopped",
      STOP_CLEANUP_OPTIONS,
    );
  }

  private async resetAllSimulations(): Promise<void> {
    await this.cleanupAllSimulations(
      "Concordia simulation reset",
      RESET_CLEANUP_OPTIONS,
    );
  }

  private async ensureCheckpointHandle(
    request: CheckpointRequest,
  ): Promise<ConcordiaSimulationHandle> {
    const existingHandle = this.registry.get(request.simulation_id) ?? null;
    if (!existingHandle) {
      const sessions = this.sessionManager.getAllForSimulation(
        request.simulation_id,
        request.workspace_id,
      );
      return this.createSimulationHandle(
        buildCheckpointHandleRequestFromSessions(request, sessions),
        CREATE_CHECKPOINT_HANDLE_OPTIONS,
      );
    }

    const updatedHandle = this.registry.setLaunchMetadata(
      existingHandle.simulationId,
      buildCheckpointLaunchMetadata(request, existingHandle),
    );
    this.syncWorldStateForHandle(updatedHandle);
    return updatedHandle;
  }

  private async hydrateSetupSessions(
    handle: ConcordiaSimulationHandle,
    request: SetupRequest,
    memoryCtx: MemoryWiringContext | null,
  ): Promise<Record<string, string>> {
    return this.hydrateSimulationSessions({
      handle,
      agents: request.agents,
      worldId: request.world_id,
      workspaceId: request.workspace_id,
      memoryCtx,
      logSessionMapping: true,
    });
  }

  private async runCheckpointMaintenanceIfNeeded(
    memoryCtx: MemoryWiringContext | null,
  ): Promise<void> {
    if (!memoryCtx) {
      return;
    }
    await runCheckpointMaintenance(memoryCtx);
  }

  private buildCheckpointSessions(request: CheckpointRequest) {
    return this.sessionManager
      .getAllForWorld(
        request.world_id,
        request.workspace_id,
        request.simulation_id,
      )
      .map((session) => ({
        agent_id: session.agentId,
        agent_name: session.agentName,
        session_id: session.sessionId,
        simulation_id: session.simulationId,
        lineage_id: session.lineageId ?? null,
        parent_simulation_id: session.parentSimulationId ?? null,
        turn_count: session.turnCount,
        last_action: session.lastAction,
      }));
  }

  private async buildCheckpointAgentStates(
    sessions: Array<{ agent_id: string }>,
    simulationId: string,
  ) {
    return Promise.all(
      sessions.map(async (session) => ({
        agent_id: session.agent_id,
        state: await this.handleGetAgentState(session.agent_id, simulationId),
      })),
    );
  }

  private buildActMessageMetadata(params: {
    requestId: string;
    session: AgentSession;
  }): Record<string, unknown> {
    return {
      type: "concordia_agent_turn",
      turn_contract: "concordia_simulation_turn",
      concordia_turn_contract: "concordia_simulation_turn",
      request_id: params.requestId,
      world_id: params.session.worldId,
      workspace_id: params.session.workspaceId,
      concordia_turn: params.session.turnCount,
      ...withSimulationIdentity({}, this.sessionIdentity(params.session)),
    };
  }

  private buildActInboundMessage(params: {
    agentId: string;
    session: AgentSession;
    sessionId: string;
    requestId: string;
    enrichedMessage: string;
  }): ChannelInboundMessage {
    return {
      id: randomUUID(),
      channel: "concordia",
      sender_id: params.agentId,
      sender_name: params.session.agentName,
      session_id: params.sessionId,
      scope: "dm",
      content: params.enrichedMessage,
      timestamp: Date.now(),
      metadata: this.buildActMessageMetadata(params),
    };
  }

  private async recordAgentActionIfAvailable(
    handle: ConcordiaSimulationHandle,
    agentId: string,
    sessionId: string,
    action: string,
  ): Promise<void> {
    if (!handle.memoryCtx) {
      return;
    }

    try {
      await recordAgentAction(handle.memoryCtx, agentId, sessionId, action);
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] recordAgentAction failed for ${agentId}:`,
        err,
      );
    }
  }

  private buildCheckpointMemoryNamespaceRefs(
    manifest: ConcordiaCheckpointManifest,
    memoryCtx: MemoryWiringContext | null,
  ): ConcordiaCheckpointManifest["memory_namespace_refs"] {
    if (!memoryCtx) {
      return manifest.memory_namespace_refs;
    }
    return {
      ...manifest.memory_namespace_refs,
      continuity_mode: memoryCtx.continuityMode,
      simulation_scope_id: memoryCtx.namespaces.simulationScopeId,
      lineage_scope_id: memoryCtx.namespaces.lineageScopeId,
      continuity_scope_id: memoryCtx.namespaces.continuityScopeId,
      world_scope_id: memoryCtx.namespaces.worldScopeId,
      effective_storage_key: memoryCtx.effectiveStorageKey,
      log_storage_key: memoryCtx.namespaces.logStorageKey,
      memory_workspace_id: memoryCtx.namespaces.memoryWorkspaceId,
      identity_workspace_id: memoryCtx.namespaces.identityWorkspaceId,
      procedural_workspace_id: memoryCtx.namespaces.proceduralWorkspaceId,
      graph_workspace_id: memoryCtx.namespaces.graphWorkspaceId,
      activation_key_prefix: memoryCtx.namespaces.activationKeyPrefix,
      lifecycle_key_prefix: memoryCtx.namespaces.lifecycleKeyPrefix,
      observation_fact_index_key: memoryCtx.namespaces.observationFactIndexKey,
      collective_emergence_key: memoryCtx.namespaces.collectiveEmergenceKey,
      shared_author: memoryCtx.namespaces.sharedAuthor,
      shared_source_scope: memoryCtx.namespaces.sharedSourceScope,
    };
  }

  private buildCheckpointManifestForHandle(
    manifest: ConcordiaCheckpointManifest,
    handle: ConcordiaSimulationHandle,
    sessions: Awaited<ReturnType<ConcordiaChannelAdapter["buildCheckpointSessions"]>>,
    memoryCtx: MemoryWiringContext | null,
  ): ConcordiaCheckpointManifest {
    const namespaceRefs = this.buildCheckpointMemoryNamespaceRefs(manifest, memoryCtx);
    const worldState = this.worldStates.get(handle.simulationId) ?? null;
    const replayCursor = Math.max(manifest.replay_cursor.replay_cursor, handle.replayCursor);
    const replayEventCount = Math.max(
      manifest.replay_cursor.replay_event_count,
      handle.replayEventCount,
    );
    const currentStep = manifest.runtime_cursor.current_step || manifest.step;
    return {
      ...manifest,
      world_id: handle.worldId,
      workspace_id: handle.workspaceId,
      simulation_id: handle.simulationId,
      lineage_id: handle.lineageId ?? manifest.lineage_id ?? null,
      parent_simulation_id: handle.parentSimulationId ?? manifest.parent_simulation_id ?? null,
      agent_ids: manifest.agent_ids.length > 0 ? manifest.agent_ids : [...handle.agentIds],
      restored_sessions: sessions,
      runtime_cursor: {
        ...manifest.runtime_cursor,
        current_step: currentStep,
        start_step: manifest.runtime_cursor.start_step || currentStep + 1,
        max_steps: manifest.runtime_cursor.max_steps || handle.maxSteps || manifest.max_steps,
        last_step_outcome:
          manifest.runtime_cursor.last_step_outcome ?? handle.lastStepOutcome ?? null,
        engine_type:
          manifest.runtime_cursor.engine_type ??
          handle.launchRequest.engine_type ??
          null,
      },
      replay_cursor: {
        ...manifest.replay_cursor,
        replay_cursor: replayCursor,
        replay_event_count: replayEventCount,
        last_event_id:
          manifest.replay_cursor.last_event_id ??
          (replayCursor > 0 ? String(replayCursor) : null),
      },
      world_state_refs: {
        ...manifest.world_state_refs,
        authoritative_snapshot_ref:
          worldState?.snapshot_ref ??
          manifest.world_state_refs.authoritative_snapshot_ref ??
          null,
      },
      memory_namespace_refs: namespaceRefs,
      subsystem_state:
        manifest.subsystem_state ?? buildDefaultSubsystemRestore(),
    };
  }

  private buildCheckpointStatusForHandle(
    manifest: ConcordiaCheckpointManifest,
    memoryCtx: MemoryWiringContext | null,
  ): ConcordiaCheckpointStatus {
    const checkpointStatus = buildCheckpointStatusFromManifest(manifest);
    if (!memoryCtx) {
      return checkpointStatus;
    }
    return {
      ...checkpointStatus,
      memory_namespace_refs: this.buildCheckpointMemoryNamespaceRefs(
        manifest,
        memoryCtx,
      ),
    };
  }

  private buildCheckpointResponse(
    request: CheckpointRequest,
    handle: ConcordiaSimulationHandle,
    sessions: Awaited<ReturnType<ConcordiaChannelAdapter["buildCheckpointSessions"]>>,
    agentStates: Awaited<
      ReturnType<ConcordiaChannelAdapter["buildCheckpointAgentStates"]>
    >,
    checkpointManifest: ConcordiaCheckpointManifest,
    checkpoint: ConcordiaCheckpointStatus,
  ): Record<string, unknown> {
    return {
      world_id: request.world_id,
      workspace_id: request.workspace_id,
      simulation_id: request.simulation_id,
      lineage_id: handle.lineageId,
      parent_simulation_id: handle.parentSimulationId,
      step: request.step,
      sessions,
      agent_states: agentStates,
      checkpoint_manifest: checkpointManifest,
      checkpoint,
    };
  }

  private async recordObservationIfAvailable(
    handle: ConcordiaSimulationHandle | null,
    agentId: string,
    sessionId: string,
    observation: string,
  ): Promise<void> {
    if (!handle?.memoryCtx) {
      return;
    }

    try {
      await ingestObservation(handle.memoryCtx, agentId, sessionId, observation);
      await recordObservationWorldFact(handle.memoryCtx, agentId, observation);
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] ingestObservation failed for ${agentId}:`,
        err,
      );
    }
  }

  private resolveValidatedPendingSendTarget(
    message: ChannelOutboundMessage,
  ): PendingSendTarget | null {
    const target = this.resolvePendingSendTarget(message);
    if (!target || this.rejectMismatchedPendingSend(target, message)) {
      return null;
    }
    return target;
  }

  private rejectMismatchedPendingSend(
    target: PendingSendTarget,
    message: ChannelOutboundMessage,
  ): boolean {
    if (target.pending.sessionId === message.session_id) {
      return false;
    }

    this.rejectPendingResponse(
      target.handle,
      target.requestId,
      new Error(
        `[concordia] send() session mismatch for request ${target.requestId}: expected ${target.pending.sessionId}, got ${message.session_id}`,
      ),
      "session_mismatch",
    );
    return true;
  }

  private normalizeResumeAgents(rawAgents: readonly unknown[]): SetupRequest["agents"] {
    return rawAgents.flatMap((rawAgent) => {
      const agent = this.normalizeResumeAgent(rawAgent);
      return agent ? [agent] : [];
    });
  }

  private normalizeResumeAgent(
    rawAgent: unknown,
  ): SetupRequest["agents"][number] | null {
    const agent = asRecord(rawAgent);
    const agentId = asString(agent.id) ?? asString(agent.agent_id);
    const agentName = asString(agent.name) ?? asString(agent.agent_name);
    if (!agentId || !agentName) {
      return null;
    }

    const normalizedAgent: MutableSetupAgent = {
      agent_id: agentId,
      agent_name: agentName,
      personality: asString(agent.personality) ?? "",
    };
    const goal = asString(agent.goal);
    if (goal) {
      normalizedAgent.goal = goal;
    }
    return normalizedAgent;
  }

  private async loadActMemoryContext(
    handle: ConcordiaSimulationHandle | null,
    agentId: string,
    sessionId: string,
    message: string,
  ): Promise<string | null> {
    if (!handle?.memoryCtx) {
      return null;
    }

    try {
      return await buildFullActContext(
        handle.memoryCtx,
        agentId,
        sessionId,
        message,
        handle.userId,
      );
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] buildFullActContext failed for ${agentId}:`,
        err,
      );
      return null;
    }
  }

  private buildBridgeServerConfig(
    port: number,
    host: string,
  ): BridgeServerConfig {
    return {
      port,
      host,
      logger: this.context.logger,
      sessionManager: this.sessionManager,
      onAct: (agentId, sessionId, message, requestId) =>
        this.handleAct(agentId, sessionId, message, requestId),
      onObserve: (agentId, sessionId, observation) =>
        this.handleObserve(agentId, sessionId, observation),
      onSetup: (request) => this.handleSetup(request),
      onReset: () => this.handleReset(),
      onCheckpoint: (request) => this.handleCheckpoint(request),
      onResume: (request) => this.handleResume(request),
      onLaunch: (request) => this.handleLaunch(request),
      onGenerateAgents: (request, requestId) =>
        this.handleGenerateAgents(request, requestId),
      onEvent: (event) => this.handleEvent(event),
      getOperationalMetrics: (metrics) => this.buildOperationalMetrics(metrics),
      getAgentState: (agentId, simulationId) =>
        this.handleGetAgentState(agentId, simulationId),
      getWorldProjection: (simulationId, agentId) =>
        this.handleGetWorldProjection(simulationId, agentId),
      getSimulationWorldState: (simulationId) =>
        this.handleGetSimulationWorldState(simulationId),
      onActResult: (result) => this.handleActResult({ ...result, intent: result.intent ?? null }),
      getCurrentSimulationId: () => this.handleGetCurrentSimulationId(),
      listSimulations: () => this.handleListSimulations(),
      getSimulation: (simulationId) => this.handleGetSimulation(simulationId),
      getSimulationStatus: (simulationId) =>
        this.handleGetSimulationStatus(simulationId),
      controlSimulation: (simulationId, command) =>
        this.handleControlSimulation(simulationId, command),
      listSimulationEvents: (simulationId, cursor) =>
        this.handleListSimulationEvents(simulationId, cursor),
      openSimulationEventStream: (simulationId, cursor, subscriber) =>
        this.handleOpenSimulationEventStream(simulationId, cursor, subscriber),
    };
  }

  private handleBridgeServerListening(
    host: string,
    port: number,
    resolve: () => void,
  ): () => void {
    return () => {
      this.healthy = true;
      this.context.logger.info?.(
        `[concordia] Bridge server listening on ${host}:${port}`,
      );
      resolve();
    };
  }

  private async listenBridgeServer(port: number, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // Audit S1.8: remove the temporary `error` listener once listen
      // resolves or rejects so the server doesn't carry a one-shot
      // reject as a permanent error handler. The previous code left
      // the listener attached; while listenBridgeServer is only
      // called once per server instance under current call sites, the
      // explicit cleanup makes a future restart-without-recreate
      // pattern safe and avoids polluting the server's error event.
      const onError = (err: unknown): void => {
        this.bridgeServer!.off("error", onError);
        reject(err);
      };
      const onListen = (): void => {
        this.bridgeServer!.off("error", onError);
        this.handleBridgeServerListening(host, port, resolve)();
      };
      this.bridgeServer!.on("error", onError);
      this.bridgeServer!.listen(port, host, onListen);
    });
  }

  private async cleanupAllSimulations(
    reason: string,
    options: SimulationCleanupOptions,
  ): Promise<void> {
    for (const handle of this.registry.listHandles()) {
      await this.cleanupSimulationHandle(handle, reason, options);
    }
  }

  private async resolveHandleMemoryContext(
    handle: ConcordiaSimulationHandle,
    worldId: string,
    workspaceId: string,
    options: {
      continuityMode?: "isolated" | "lineage_resume";
      checkpointMetadata?: Record<string, unknown> | null;
    } = {},
  ): Promise<{
    handle: ConcordiaSimulationHandle;
    memoryCtx: MemoryWiringContext | null;
  }> {
    const existingMemory = handle.memoryCtx;
    if (
      existingMemory &&
      existingMemory.worldId === worldId &&
      existingMemory.workspaceId === workspaceId &&
      existingMemory.simulationId === handle.simulationId &&
      (!options.continuityMode || existingMemory.continuityMode === options.continuityMode)
    ) {
      return { handle, memoryCtx: existingMemory };
    }

    const memoryCtx = await resolveConcordiaMemoryContext(
      this.context,
      worldId,
      workspaceId,
      {
        simulationId: handle.simulationId,
        lineageId: handle.lineageId,
        parentSimulationId: handle.parentSimulationId,
      },
      {
        continuityMode: options.continuityMode,
        checkpointMetadata: options.checkpointMetadata ?? null,
      },
    );
    return {
      handle: this.registry.attachMemoryContext(handle.simulationId, memoryCtx),
      memoryCtx,
    };
  }

  private currentSimulationIdentity(): SimulationIdentity {
    return this.handleIdentity(this.registry.getCurrentHandle() ?? null);
  }

  private handleGetCurrentSimulationId(): string | null {
    return this.registry.getCurrentAlias();
  }

  private handleIdentity(
    handle: Pick<ConcordiaSimulationHandle, "simulationId" | "lineageId" | "parentSimulationId"> | null | undefined,
  ): SimulationIdentity {
    return createSimulationIdentity({
      simulationId: handle?.simulationId ?? null,
      lineageId: handle?.lineageId ?? null,
      parentSimulationId: handle?.parentSimulationId ?? null,
    });
  }

  private sessionIdentity(
    session: Pick<AgentSession, "simulationId" | "lineageId" | "parentSimulationId">,
  ): SimulationIdentity {
    return createSimulationIdentity({
      simulationId: session.simulationId,
      lineageId: session.lineageId,
      parentSimulationId: session.parentSimulationId,
    });
  }

  private getHandleForSimulation(
    simulationId: string | null | undefined,
  ): ConcordiaSimulationHandle | null {
    if (simulationId) {
      return this.registry.get(simulationId) ?? null;
    }
    return this.registry.getCurrentHandle() ?? null;
  }

  private getHandleForSession(sessionId: string): {
    handle: ConcordiaSimulationHandle;
    session: AgentSession;
  } | null {
    const session = this.sessionManager.findBySessionId(sessionId);
    if (!session) {
      return null;
    }
    const handle = this.registry.get(session.simulationId);
    if (!handle) {
      return null;
    }
    return { handle, session };
  }

  private normalizeLaunchRequest(request: LaunchRequest): NormalizedLaunchRequest {
    return {
      ...request,
      simulation_id: request.simulation_id ?? randomUUID(),
      lineage_id: request.lineage_id ?? null,
      parent_simulation_id: request.parent_simulation_id ?? null,
    };
  }

  private buildReservedLaunchRequest(
    request: NormalizedLaunchRequest,
    reserved: {
      controlPort: number | null;
      eventPort: number | null;
    },
  ): MutableNormalizedLaunchRequest {
    return {
      ...request,
      control_port: reserved.controlPort ?? request.control_port,
      event_port: reserved.eventPort ?? request.event_port,
    };
  }

  private buildCreateHandleInput(
    request: NormalizedLaunchRequest,
    reserved: {
      controlPort: number | null;
      eventPort: number | null;
    },
    options: {
      readonly status?: SimulationLifecycleStatus;
      readonly currentAlias?: boolean;
    },
  ): Parameters<ConcordiaChannelAdapter["registry"]["createHandle"]>[0] {
    return {
      request: this.buildReservedLaunchRequest(request, reserved),
      status: options.status,
      controlPort: reserved.controlPort ?? request.control_port ?? null,
      eventPort: reserved.eventPort ?? request.event_port ?? null,
      currentAlias: options.currentAlias,
    };
  }

  private buildRequestedPorts(
    request: NormalizedLaunchRequest,
  ): {
    controlPort: number | null;
    eventPort: number | null;
  } {
    return {
      controlPort: request.control_port ?? null,
      eventPort: request.event_port ?? null,
    };
  }

  private async resolveHandleReservedPorts(
    request: NormalizedLaunchRequest,
    options: {
      readonly reservePorts?: boolean;
    },
  ): Promise<{
    controlPort: number | null;
    eventPort: number | null;
  }> {
    const requestedPorts = this.buildRequestedPorts(request);
    if (options.reservePorts === false) {
      return requestedPorts;
    }
    return this.registry.reservePorts(requestedPorts);
  }

  private async createSimulationHandle(
    request: NormalizedLaunchRequest,
    options: {
      readonly status?: SimulationLifecycleStatus;
      readonly reservePorts?: boolean;
      readonly currentAlias?: boolean;
    } = {},
  ): Promise<ConcordiaSimulationHandle> {
    const reserved = await this.resolveHandleReservedPorts(request, options);
    const handle = this.registry.createHandle(
      this.buildCreateHandleInput(request, reserved, options),
    );
    this.syncWorldStateForHandle(handle);
    return handle;
  }

  private async fetchRunnerStatus(
    controlPort: number,
  ): Promise<RunnerStatusSnapshot | null> {
    const response = await fetch(
      `http://${LOOPBACK_HOST}:${controlPort}/simulation/status`,
    );
    if (!response.ok) {
      return null;
    }
    return await response.json() as RunnerStatusSnapshot;
  }

  private applyRunnerStatusUpdate(
    handle: ConcordiaSimulationHandle,
    status: RunnerStatusSnapshot | null,
  ): ConcordiaSimulationHandle {
    if (!status) {
      return handle;
    }
    const mapped = this.mapRunnerStatus(status, handle.status);
    return this.registry.updateLifecycle(handle.simulationId, mapped);
  }

  private async refreshSimulationStatus(
    handle: ConcordiaSimulationHandle,
  ): Promise<ConcordiaSimulationHandle> {
    if (!handle.controlPort || isTerminalSimulationStatus(handle.status)) {
      return handle;
    }

    try {
      const status = await this.fetchRunnerStatus(handle.controlPort);
      return this.applyRunnerStatusUpdate(handle, status);
    } catch (error) {
      this.context.logger.debug?.(
        `[concordia] Failed to refresh simulation status for ${handle.simulationId}: ${String(error)}`,
      );
      return handle;
    }
  }

  private mapRunnerStatus(
    status: RunnerStatusSnapshot,
    previousStatus: SimulationLifecycleStatus,
  ): {
    status: SimulationLifecycleStatus;
    executionPhase: RunnerStatusSnapshot["execution_phase"];
    reason: string | null;
    error: string | null;
    lastCompletedStep: number;
    lastStepOutcome: string | null;
    endedAt?: number | null;
  } {
    const terminalReason = typeof status.terminal_reason === "string"
      ? status.terminal_reason
      : null;
    let lifecycleStatus: SimulationLifecycleStatus = previousStatus;
    let error: string | null = null;

    if (status.running && status.paused) {
      lifecycleStatus = "paused";
    } else if (status.running) {
      lifecycleStatus = "running";
    } else if (terminalReason === "completed") {
      lifecycleStatus = "finished";
    } else if (terminalReason === "stopped" || terminalReason === "stopped_by_user") {
      lifecycleStatus = "stopped";
    } else if (terminalReason && terminalReason.startsWith("error:")) {
      lifecycleStatus = "failed";
      error = terminalReason;
    } else if (!status.running && !status.paused && previousStatus === "launching") {
      lifecycleStatus = "launching";
    }

    return {
      status: lifecycleStatus,
      executionPhase: status.execution_phase ?? null,
      reason: terminalReason,
      error,
      lastCompletedStep: status.step,
      lastStepOutcome: status.last_step_outcome ?? null,
      ...(isTerminalSimulationStatus(lifecycleStatus)
        ? { endedAt: Date.now() }
        : {}),
    };
  }

  private async handleListSimulations(): Promise<SimulationSummary[]> {
    const handles = this.registry.listHandles();
    for (const handle of handles) {
      await this.refreshSimulationStatus(handle);
    }
    return this.registry.listSummaries();
  }

  private async handleGetSimulation(
    simulationId: string,
  ): Promise<SimulationRecord | null> {
    const handle = this.registry.get(simulationId);
    if (!handle) {
      return null;
    }
    await this.refreshSimulationStatus(handle);
    return this.registry.getRecord(simulationId);
  }

  private async handleGetSimulationStatus(
    simulationId: string,
  ): Promise<SimulationStatusResponse | null> {
    const handle = this.registry.get(simulationId);
    if (!handle) {
      return null;
    }
    const refreshed = await this.refreshSimulationStatus(handle);
    return this.toSimulationStatus(refreshed);
  }

  private markSimulationStopRequested(simulationId: string): void {
    this.registry.updateLifecycle(simulationId, {
      status: "stopping",
      executionPhase: "stopped",
      reason: "stop_requested",
    });
  }

  private async handleControlSimulation(
    simulationId: string,
    command: SimulationCommand,
  ): Promise<SimulationStatusResponse | null> {
    const handle = this.registry.get(simulationId);
    if (!handle) {
      return null;
    }
    if (!handle.controlPort) {
      return this.toSimulationStatus(handle);
    }

    const response = await fetch(
      `http://${LOOPBACK_HOST}:${handle.controlPort}/simulation/${command}`,
      { method: "POST" },
    );
    if (!response.ok) {
      throw new Error(
        `Simulation control command failed: ${command} ${response.status}`,
      );
    }

    if (command === "stop") {
      this.markSimulationStopRequested(simulationId);
    }

    const refreshed = await this.refreshSimulationStatus(
      this.registry.get(simulationId) ?? handle,
    );
    return this.toSimulationStatus(refreshed);
  }

  private async handleListSimulationEvents(
    simulationId: string,
    cursor: string | null = null,
  ): Promise<SimulationEventsResponse | null> {
    if (!this.registry.has(simulationId)) {
      return null;
    }

    const events = this.registry.listReplayEvents(simulationId, cursor);
    return {
      simulation_id: simulationId,
      events,
      next_cursor: events.at(-1)?.event_id ?? cursor ?? null,
    };
  }

  private async handleOpenSimulationEventStream(
    simulationId: string,
    cursor: string | null,
    subscriber: (event: SimulationReplayEvent) => void,
  ): Promise<{
    history: readonly SimulationReplayEvent[];
    unsubscribe: () => void;
  } | null> {
    return this.registry.openReplayStream(simulationId, cursor, subscriber);
  }

  private toSimulationStatus(
    handle: ConcordiaSimulationHandle,
  ): SimulationStatusResponse {
    const active = handle.status === "running" || handle.status === "paused";
    return {
      simulation_id: handle.simulationId,
      world_id: handle.worldId,
      workspace_id: handle.workspaceId,
      status: handle.status,
      execution_phase: handle.executionPhase ?? null,
      reason: handle.reason,
      error: handle.error,
      step: handle.lastCompletedStep,
      max_steps: handle.maxSteps,
      running: active,
      paused: handle.status === "paused",
      agent_count: handle.agentIds.length,
      started_at: handle.startedAt,
      ended_at: handle.endedAt,
      updated_at: handle.updatedAt,
      last_step_outcome: handle.lastStepOutcome,
      terminal_reason: isTerminalSimulationStatus(handle.status)
        ? handle.reason
        : null,
      checkpoint: handle.checkpoint,
    };
  }

  private resolvePendingSendTargetBySession(
    message: ChannelOutboundMessage,
  ): PendingSendTarget | null {
    const sessionMatch = this.getHandleForSession(message.session_id);
    if (!sessionMatch) {
      this.logIgnoredOutboundWithoutRequestId(message.session_id);
      return null;
    }
    const matches = this.registry.findPendingBySession(
      sessionMatch.handle.simulationId,
      message.session_id,
      (pending) => pending.sessionId,
    );
    if (matches.length === 0) {
      this.logIgnoredOutboundWithoutRequestId(message.session_id);
      return null;
    }
    if (matches.length > 1) {
      this.logAmbiguousPendingResponseMatch(
        message.session_id,
        matches.length,
        sessionMatch.handle.simulationId,
      );
      return null;
    }
    const [requestId, pending] = matches[0];
    this.logPendingResponse(
      "missing_request_id_fallback",
      requestId,
      pending,
      {},
      "warn",
    );
    return buildPendingSendTarget(
      sessionMatch.handle,
      requestId,
      pending,
      true,
    );
  }

  private logAmbiguousPendingResponseMatch(
    sessionId: string,
    pendingMatches: number,
    simulationId: string,
  ): void {
    this.context.logger.warn?.(
      buildMissingRequestIdLogMessage(sessionId, pendingMatches, simulationId),
    );
  }

  private logIgnoredOutboundWithoutRequestId(sessionId: string): void {
    this.context.logger.debug?.(
      buildIgnoredRequestIdLogMessage(sessionId),
    );
  }

  private resolvePendingSendTarget(
    message: ChannelOutboundMessage,
  ): PendingSendTarget | null {
    const metadataRequestId = extractRequestId(message.metadata);
    if (!metadataRequestId) {
      return this.resolvePendingSendTargetBySession(message);
    }

    const target = this.registry.getPendingByRequestId(metadataRequestId);
    if (!target) {
      this.context.logger.warn?.(
        buildUnknownRequestIdLogMessage(metadataRequestId, message.session_id),
      );
      return null;
    }

    return buildPendingSendTarget(
      target.handle,
      metadataRequestId,
      target.pending,
      false,
    );
  }

  private async dispatchInboundAwaitingResponse(
    handle: ConcordiaSimulationHandle,
    {
      requestId,
      inbound,
      sessionId,
      agentId,
      timeoutMs,
      timeoutLog,
      worldId,
      step,
      simulationId = null,
      logMessageLength,
    }: PendingDispatchRequest,
  ): Promise<string> {
    const responsePromise = this.createPendingResponse(
      handle,
      requestId,
      sessionId,
      agentId,
      timeoutMs,
      timeoutLog,
      worldId,
      step,
      simulationId,
    );

    this.logPendingResponse(
      "dispatch",
      requestId,
      this.registry.getPendingByRequestId(requestId)?.pending,
      logMessageLength === undefined ? {} : { message_length: logMessageLength },
      "debug",
    );

    try {
      await this.context.on_message(inbound);
    } catch (err) {
      this.rejectPendingResponse(
        handle,
        requestId,
        err instanceof Error ? err : new Error(String(err)),
        "dispatch_failed",
      );
      await responsePromise.catch(() => undefined);
      throw err;
    }

    return responsePromise;
  }

  private isEventForHandle(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): boolean {
    return (
      handle.worldId === event.world_id &&
      handle.workspaceId === event.workspace_id &&
      handle.simulationId === event.simulation_id
    );
  }

  private async maybeRunResolutionPeriodicTasks(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): Promise<void> {
    if (!this.shouldRunResolutionPeriodicTasks(handle, event)) {
      return;
    }

    this.markResolutionStepProcessed(handle.simulationId, event.step);
    try {
      const promotedCount = await this.runResolutionPeriodicTasks(handle, event);
      this.logPromotedCollectiveFactsIfAny(promotedCount, event.step);
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] runPeriodicTasks failed at step ${event.step}:`,
        err,
      );
    }
  }

  private shouldRunResolutionPeriodicTasks(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): boolean {
    return Boolean(
      handle.memoryCtx &&
        event.type === "resolution" &&
        event.step > handle.lastProcessedResolutionStep &&
        event.content,
    );
  }

  private markResolutionStepProcessed(
    simulationId: string,
    step: number,
  ): void {
    this.registry.mutateHandle(simulationId, (currentHandle) => {
      currentHandle.lastProcessedResolutionStep = step;
    });
  }

  private async runResolutionPeriodicTasks(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): Promise<number> {
    if (!handle.memoryCtx) {
      return 0;
    }

    const agentIds = this.collectSimulationAgentIds(handle, event);
    await runPeriodicTasks(
      handle.memoryCtx,
      event.step,
      agentIds,
      buildPeriodicTaskIntervals(this.context.config),
      this.context.logger,
    );
    return this.promoteCollectiveFacts(handle.memoryCtx, event.step);
  }

  private collectSimulationAgentIds(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): string[] {
    return this.sessionManager
      .getAllForWorld(event.world_id, handle.workspaceId, event.simulation_id)
      .map((session) => session.agentId);
  }

  private async promoteCollectiveFacts(
    memoryCtx: MemoryWiringContext,
    step: number,
  ): Promise<number> {
    const promotedFacts = await promoteCollectiveEmergenceFacts(memoryCtx, step);
    return promotedFacts.length;
  }

  private logPromotedCollectiveFactsIfAny(
    count: number,
    step: number,
  ): void {
    if (count === 0) {
      return;
    }
    this.context.logger.info?.(
      `[concordia] Promoted ${count} collectively confirmed world facts at step ${step}`,
    );
  }

  private async recordSimulationEventSideEffects(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): Promise<void> {
    if (!handle.memoryCtx || !event.content) {
      return;
    }

    await this.runLoggedEventSideEffect("recordSocialEvent", async () => {
      await recordSocialEvent(
        handle.memoryCtx!,
        event,
        this.knownAgentsForEvent(handle, event),
      );
    });
    await this.runLoggedEventSideEffect("updateTemporalEdges", async () => {
      await updateTemporalEdges(
        handle.memoryCtx!,
        event.acting_agent,
        event.content!,
      );
    });
    await this.runLoggedEventSideEffect("logSimulationEvent", async () => {
      await this.logSimulationEventForResolvedSession(handle, event);
    });
  }

  private async runLoggedEventSideEffect(
    label: string,
    effect: () => Promise<void>,
  ): Promise<void> {
    try {
      await effect();
    } catch (err) {
      this.context.logger.warn?.(`[concordia] ${label} failed:`, err);
    }
  }

  private async logSimulationEventForResolvedSession(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): Promise<void> {
    if (!handle.memoryCtx || !event.content) {
      return;
    }

    const agentSession = this.resolveAgentSessionForEvent(handle, event);
    if (!agentSession) {
      return;
    }

    await logSimulationEvent(
      handle.memoryCtx,
      agentSession.sessionId,
      buildSimulationMemoryEventEntry(event),
    );
  }

  private knownAgentsForEvent(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): KnownAgentReference[] {
    return this.getSimulationSessionsForEvent(handle, event).map(
      mapAgentSessionToKnownAgent,
    );
  }

  private resolveAgentSessionForEvent(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): AgentSession | undefined {
    const sessions = this.getSimulationSessionsForEvent(handle, event);
    if (!event.acting_agent) {
      return sessions[0];
    }
    return sessions.find((session) => session.agentId === event.acting_agent);
  }

  private getSimulationSessionsForEvent(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): AgentSession[] {
    return this.sessionManager.getAllForWorld(
      event.world_id,
      handle.workspaceId,
      event.simulation_id,
    );
  }

  private normalizeMemoryEvent(event: EventNotification): EventNotification {
    return {
      ...event,
      acting_agent: event.acting_agent ?? event.agent_name,
      content: event.resolved_event ?? event.content ?? "",
    };
  }

  private createPendingResponse(
    handle: ConcordiaSimulationHandle,
    requestId: string,
    sessionId: string,
    agentId: string | undefined,
    timeoutMs: number,
    timeoutLog: string,
    worldId: string | null,
    step: number,
    simulationId: string | null = null,
  ): Promise<string> {
    const responsePromise = new Promise<string>((resolve, reject) => {
      this.initializePendingResponse({
        handle,
        requestId,
        sessionId,
        agentId,
        timeoutMs,
        timeoutLog,
        worldId,
        step,
        simulationId,
        resolve,
        reject,
      });
    });
    responsePromise.catch(() => undefined);
    return responsePromise;
  }

  private initializePendingResponse(params: PendingResponseInit): void {
    const timeout = this.createPendingResponseTimeout(params);
    const pending = this.buildPendingResponseRequest(params, timeout);
    this.registry.registerPendingResponse(
      params.handle.simulationId,
      params.requestId,
      pending,
    );
    this.logPendingResponse(
      "created",
      params.requestId,
      pending,
      { timeout_ms: params.timeoutMs },
      "info",
    );
  }

  private createPendingResponseTimeout(
    params: Pick<
      PendingResponseInit,
      "handle" | "requestId" | "timeoutLog" | "timeoutMs"
    >,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.rejectPendingResponse(
        params.handle,
        params.requestId,
        new Error(params.timeoutLog),
        "timeout",
      );
    }, params.timeoutMs);
  }

  private buildPendingResponseRequest(
    params: PendingResponseInit,
    timeout: ReturnType<typeof setTimeout>,
  ): PendingResponseRequest {
    return {
      agentId: params.agentId,
      sessionId: params.sessionId,
      worldId: params.worldId,
      simulationId: params.simulationId,
      step: params.step,
      createdAt: Date.now(),
      resolve: params.resolve,
      reject: params.reject,
      timeout,
    };
  }

  private resolvePendingResponse(
    handle: ConcordiaSimulationHandle,
    requestId: string,
    pending: PendingResponseRequest,
    content: string,
    event: string,
  ): void {
    clearTimeout(pending.timeout);
    this.registry.deletePendingResponse(handle.simulationId, requestId);
    this.logPendingResponse(
      event,
      requestId,
      pending,
      { content_length: content.length },
      event === "resolved" ? "info" : "warn",
    );
    pending.resolve(content);
  }

  private rejectPendingResponse(
    handle: ConcordiaSimulationHandle,
    requestId: string,
    error: Error,
    event: string,
  ): void {
    const target = this.registry.getPendingByRequestId(requestId);
    if (!target) {
      return;
    }
    clearTimeout(target.pending.timeout);
    this.registry.deletePendingResponse(handle.simulationId, requestId);
    this.logPendingResponse(
      event,
      requestId,
      target.pending,
      { error: error.message },
      "warn",
    );
    target.pending.reject(error);
  }

  private clearPendingResponsesForSimulation(
    handle: ConcordiaSimulationHandle,
    reason: string,
  ): void {
    this.registry.clearPending(handle.simulationId, (requestId, pending) => {
      clearTimeout(pending.timeout);
      this.registry.deletePendingResponse(handle.simulationId, requestId);
      this.logPendingResponse(
        "cleared",
        requestId,
        pending,
        { error: reason },
        "warn",
      );
      pending.reject(new Error(reason));
    });
  }

  private logPendingResponse(
    event: string,
    requestId: string,
    pending: PendingResponseRequest | undefined,
    extras: Record<string, unknown> = {},
    level: "debug" | "info" | "warn" = "debug",
  ): void {
    const payload = {
      request_id: requestId,
      session_id: pending?.sessionId ?? null,
      agent_id: pending?.agentId ?? null,
      world_id: pending?.worldId ?? null,
      simulation_id: pending?.simulationId ?? null,
      step: pending?.step ?? null,
      ...extras,
    };
    const message = `[concordia] pending_response ${event} ${JSON.stringify(payload)}`;
    const logger = this.context.logger;
    if (level === "warn") {
      logger.warn?.(message);
      return;
    }
    if (level === "info") {
      logger.info?.(message);
      return;
    }
    logger.debug?.(message);
  }

  private async cleanupSimulationHandle(
    handle: ConcordiaSimulationHandle,
    reason: string,
    options: {
      readonly status?: SimulationLifecycleStatus;
      readonly removeHandle?: boolean;
      readonly stopRunner?: boolean;
      readonly removeSessions?: boolean;
      readonly runPostCleanup?: boolean;
      readonly clearMemoryContext?: boolean;
      readonly error?: string | null;
    } = {},
  ): Promise<void> {
    if (options.runPostCleanup !== false && handle.memoryCtx) {
      try {
        const agentIds = this.sessionManager
          .getAllForSimulation(handle.simulationId, handle.workspaceId)
          .map((session) => session.agentId);
        await postSimulationCleanup(
          handle.memoryCtx,
          agentIds,
          this.context.logger,
        );
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] postSimulationCleanup failed for ${handle.simulationId}:`,
          err,
        );
      }
    }

    this.clearPendingResponsesForSimulation(handle, reason);
    this.structuredActs.delete(handle.simulationId);

    let runnerToStop: SpawnedSimulationRunner | null = null;
    if (handle.runner) {
      runnerToStop = options.stopRunner === false ? null : handle.runner;
      this.registry.detachRunner(handle.simulationId);
    }
    if (options.clearMemoryContext) {
      this.registry.attachMemoryContext(handle.simulationId, null);
    }
    if (runnerToStop) {
      await stopSimulationRunner(
        runnerToStop,
        this.operations.runnerShutdownTimeoutMs,
      );
    }
    this.registry.updateLifecycle(handle.simulationId, {
      status: options.status ?? "stopped",
      executionPhase: "stopped",
      reason,
      error: options.error ?? null,
      endedAt: Date.now(),
    });

    if (options.removeSessions !== false) {
      this.sessionManager.clearSimulation(handle.simulationId, handle.workspaceId);
    }

    if (options.removeHandle) {
      this.registry.deleteHandle(handle.simulationId);
      this.worldStates.delete(handle.simulationId);
      this.structuredActs.delete(handle.simulationId);
    }

    this.pruneHistoricalSimulations();
  }

  private parseGeneratedAgents(rawResponse: string): GeneratedAgent[] {
    const parsed = extractGeneratedAgentsPayload(rawResponse);
    const record = asRecord(parsed);
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(record.agents)
        ? record.agents as unknown[]
        : null;

    if (!entries) {
      throw new Error("Expected generated agents JSON array or object with agents");
    }

    const agents = entries.map((entry, index) =>
      normalizeGeneratedAgent(entry, index),
    );

    return dedupeGeneratedAgents(agents);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slugifyGeneratedAgentId(value: string, fallbackIndex: number): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `agent-${fallbackIndex + 1}`;
}

function extractGeneratedAgentsPayload(rawResponse: string): unknown {
  const trimmed = rawResponse.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    fenced?.[1]?.trim(),
    trimmed,
    ...extractJsonCandidates(trimmed),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.length > 0));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  throw new Error("Unable to parse generated agents response as JSON");
}

function extractJsonCandidates(rawResponse: string): string[] {
  const candidates: string[] = [];
  for (const opener of ["[", "{"]) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    for (let index = 0; index < rawResponse.length; index += 1) {
      const char = rawResponse[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === opener && depth === 0) {
        start = index;
        depth = 1;
        continue;
      }
      if (start !== -1) {
        if (char === opener) {
          depth += 1;
          continue;
        }
        if ((opener === "[" && char === "]") || (opener === "{" && char === "}")) {
          depth -= 1;
          if (depth === 0) {
            candidates.push(rawResponse.slice(start, index + 1));
            start = -1;
          }
        }
      }
    }
  }
  return candidates;
}

function normalizeGeneratedAgent(entry: unknown, index: number): GeneratedAgent {
  const record = asRecord(entry);
  const name = asString(record.name)?.trim();
  const personality = asString(record.personality)?.trim();
  const goal = asString(record.goal)?.trim();
  if (!name || !personality || !goal) {
    throw new Error(`Generated agent ${index} is missing required fields`);
  }
  const idSource = asString(record.id)?.trim() || name;
  return {
    id: slugifyGeneratedAgentId(idSource, index),
    name,
    personality,
    goal,
  };
}

function dedupeGeneratedAgents(agents: readonly GeneratedAgent[]): GeneratedAgent[] {
  const seen = new Set<string>();
  return agents.map((agent) => {
    let candidate = agent.id;
    let suffix = 2;
    while (seen.has(candidate)) {
      candidate = `${agent.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(candidate);
    return candidate === agent.id ? agent : { ...agent, id: candidate };
  });
}
