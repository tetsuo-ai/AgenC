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
  ConcordiaChannelConfig,
  SetupRequest,
  EventNotification,
  LaunchRequest,
  GenerateAgentsRequest,
  GeneratedAgent,
  AgentStateResponse,
  CheckpointRequest,
  ResumeRequest,
  SimulationRecord,
  SimulationSummary,
  SimulationLifecycleStatus,
} from "./types.js";
import { SessionManager, type AgentSession } from "./session-manager.js";
import {
  SimulationRegistry,
  type NormalizedLaunchRequest,
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

const MAX_GENERATED_AGENTS = 25;

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
  private healthy = false;

  async initialize(
    context: ChannelAdapterContext<ConcordiaChannelConfig>,
  ): Promise<void> {
    this.context = context;
    this.registry = new SimulationRegistry(context.logger);
  }

  async start(): Promise<void> {
    const port = this.context.config.bridge_port ?? 3200;
    const host = "127.0.0.1";

    this.bridgeServer = createBridgeServer(this.buildBridgeServerConfig(port, host));
    await this.listenBridgeServer(port, host);
  }

  async stop(): Promise<void> {
    this.healthy = false;

    await this.cleanupAllSimulations("Concordia bridge stopped", {
      status: "stopped",
      removeHandle: false,
      stopRunner: true,
      removeSessions: true,
      runPostCleanup: true,
      clearMemoryContext: true,
    });

    this.registry.clear();
    this.sessionManager.clear();

    await this.closeBridgeServer();

    this.context.logger.info?.("[concordia] Bridge server stopped");
  }

  /**
   * Called by the daemon when the ChatExecutor produces a response.
   * Routes the response to the pending /act request for the matching session.
   */
  async send(message: ChannelOutboundMessage): Promise<void> {
    if (message.is_partial) return;

    const target = this.resolvePendingSendTarget(message);
    if (!target) {
      return;
    }

    const { handle, requestId, pending, usedSessionFallback } = target;
    if (pending.sessionId !== message.session_id) {
      this.rejectPendingResponse(
        handle,
        requestId,
        new Error(
          `[concordia] send() session mismatch for request ${requestId}: expected ${pending.sessionId}, got ${message.session_id}`,
        ),
        "session_mismatch",
      );
      return;
    }

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

  // ==========================================================================
  // Internal handlers
  // ==========================================================================

  private async handleSetup(
    request: SetupRequest,
  ): Promise<Record<string, string>> {
    const sessions: Record<string, string> = {};
    let handle = this.registry.get(request.simulation_id) ?? null;

    if (!handle) {
      handle = await this.createSimulationHandle(
        this.buildSetupHandleRequest(request),
        {
          status: "launching",
          reservePorts: false,
          currentAlias: true,
        },
      );
    } else {
      handle = this.registry.setLaunchMetadata(handle.simulationId, {
        worldId: request.world_id,
        workspaceId: request.workspace_id,
        lineageId: request.lineage_id ?? handle.lineageId,
        parentSimulationId:
          request.parent_simulation_id ?? handle.parentSimulationId,
        premise: request.premise,
        userId: request.user_id ?? handle.userId,
        agents: request.agents,
      });
      this.registry.updateLifecycle(handle.simulationId, {
        reason: null,
        error: null,
      });
      this.registry.setCurrentAlias(handle.simulationId);
    }

    const resolvedMemory = await this.resolveHandleMemoryContext(
      handle,
      request.world_id,
      request.workspace_id,
    );
    handle = resolvedMemory.handle;
    const { memoryCtx } = resolvedMemory;
    this.sessionManager.clearSimulation(handle.simulationId, handle.workspaceId);

    for (const agent of request.agents) {
      const session = this.sessionManager.getOrCreate({
        agentId: agent.agent_id,
        agentName: agent.agent_name,
        worldId: request.world_id,
        workspaceId: request.workspace_id,
        simulationId: handle.simulationId,
        lineageId: handle.lineageId,
        parentSimulationId: handle.parentSimulationId,
      });
      sessions[agent.agent_id] = session.sessionId;

      if (memoryCtx) {
        try {
          await setupAgentIdentity(
            memoryCtx,
            agent.agent_id,
            agent.agent_name,
            agent.personality,
            agent.goal ?? "",
          );
        } catch (err) {
          this.context.logger.warn?.(
            `[concordia] Failed to setup identity for ${agent.agent_name}:`,
            err,
          );
        }
      }

      this.context.logger.info?.(
        `[concordia] Agent setup: ${agent.agent_name} (${agent.agent_id}) -> ${session.sessionId}`,
      );
    }

    if (memoryCtx && request.premise) {
      try {
        await storePremise(memoryCtx, request.premise);
      } catch (err) {
        this.context.logger.warn?.(
          "[concordia] Failed to store premise:",
          err,
        );
      }
    }

    return sessions;
  }

  private async handleReset(): Promise<void> {
    await this.cleanupAllSimulations("Concordia simulation reset", {
      status: "stopped",
      removeHandle: true,
      stopRunner: true,
      removeSessions: true,
      runPostCleanup: true,
      clearMemoryContext: true,
    });
    this.registry.clear();
    this.sessionManager.clear();
  }

  private async handleCheckpoint(
    request: CheckpointRequest,
  ): Promise<Record<string, unknown>> {
    let handle = this.registry.get(request.simulation_id) ?? null;
    if (!handle) {
      handle = await this.createSimulationHandle(
        {
          world_id: request.world_id,
          workspace_id: request.workspace_id,
          simulation_id: request.simulation_id,
          lineage_id: request.lineage_id ?? null,
          parent_simulation_id: request.parent_simulation_id ?? null,
          agents: this.sessionManager.getAllForSimulation(
            request.simulation_id,
            request.workspace_id,
          ).map((session) => ({
            agent_id: session.agentId,
            agent_name: session.agentName,
            personality: "",
          })),
          premise: "",
        },
        {
          status: "paused",
          reservePorts: false,
          currentAlias: false,
        },
      );
    } else {
      handle = this.registry.setLaunchMetadata(handle.simulationId, {
        worldId: request.world_id,
        workspaceId: request.workspace_id,
        lineageId: request.lineage_id ?? handle.lineageId,
        parentSimulationId:
          request.parent_simulation_id ?? handle.parentSimulationId,
      });
    }

    const resolvedMemory = await this.resolveHandleMemoryContext(
      handle,
      request.world_id,
      request.workspace_id,
    );
    handle = resolvedMemory.handle;
    const { memoryCtx } = resolvedMemory;

    if (memoryCtx) {
      await runCheckpointMaintenance(memoryCtx);
    }
    handle = await this.refreshSimulationStatus(handle);

    const sessions = this.sessionManager
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

    const agent_states = await Promise.all(
      sessions.map(async (session) => ({
        agent_id: session.agent_id,
        state: await this.handleGetAgentState(
          session.agent_id,
          request.simulation_id,
        ),
      })),
    );

    return {
      world_id: request.world_id,
      workspace_id: request.workspace_id,
      simulation_id: request.simulation_id,
      lineage_id: handle.lineageId,
      parent_simulation_id: handle.parentSimulationId,
      step: request.step,
      sessions,
      agent_states,
    };
  }

  private async handleResume(
    request: ResumeRequest,
  ): Promise<Record<string, unknown>> {
    const checkpoint = request.checkpoint;
    const config = asRecord(checkpoint.config);
    const worldId =
      asString(checkpoint.world_id) ?? asString(config.world_id) ?? "default";
    const workspaceId =
      asString(checkpoint.workspace_id) ??
      asString(config.workspace_id) ??
      "concordia-sim";
    const checkpointSimulationId =
      asString(checkpoint.simulation_id) ?? asString(config.simulation_id);
    const checkpointLineageId =
      asString(checkpoint.lineage_id) ?? asString(config.lineage_id);
    const resumedSimulationId = request.simulation_id ?? randomUUID();
    const resumedLineageId =
      request.lineage_id ??
      checkpointLineageId ??
      checkpointSimulationId ??
      resumedSimulationId;
    const resumedParentSimulationId =
      request.parent_simulation_id ??
      checkpointSimulationId ??
      asString(checkpoint.parent_simulation_id) ??
      null;
    const premise = asString(config.premise) ?? "";
    const rawAgents = Array.isArray(config.agents) ? config.agents : [];
    const agents = rawAgents.flatMap((rawAgent) => {
      const agent = asRecord(rawAgent);
      const agentId = asString(agent.id) ?? asString(agent.agent_id);
      const agentName = asString(agent.name) ?? asString(agent.agent_name);
      if (!agentId || !agentName) {
        return [];
      }
      const normalized = {
        agent_id: agentId,
        agent_name: agentName,
        personality: asString(agent.personality) ?? "",
        ...(asString(agent.goal) ? { goal: asString(agent.goal) } : {}),
      };
      return [normalized];
    });
    const entityStates = asRecord(checkpoint.entity_states);
    const existing = this.registry.get(resumedSimulationId);
    if (existing) {
      await this.cleanupSimulationHandle(
        existing,
        "Concordia simulation resume replacement",
        {
          status: "stopped",
          removeHandle: true,
          stopRunner: true,
          removeSessions: true,
          runPostCleanup: false,
          clearMemoryContext: true,
        },
      );
    }

    let handle = await this.createSimulationHandle(
      {
        world_id: worldId,
        workspace_id: workspaceId,
        simulation_id: resumedSimulationId,
        lineage_id: resumedLineageId,
        parent_simulation_id: resumedParentSimulationId,
        user_id:
          request.user_id ??
          asString(checkpoint.user_id) ??
          asString(config.user_id),
        agents,
        premise,
        ...(asNumber(config.max_steps) !== undefined
          ? { max_steps: asNumber(config.max_steps) }
          : {}),
        ...(asString(config.gm_model)
          ? { gm_model: asString(config.gm_model) }
          : {}),
        ...(asString(config.gm_provider)
          ? { gm_provider: asString(config.gm_provider) }
          : {}),
        ...(asString(config.gm_api_key)
          ? { gm_api_key: asString(config.gm_api_key) }
          : {}),
        ...(asString(config.gm_base_url)
          ? { gm_base_url: asString(config.gm_base_url) }
          : {}),
        ...(asString(config.engine_type)
          ? {
              engine_type: asString(config.engine_type) as
                | "sequential"
                | "simultaneous",
            }
          : {}),
        ...(asString(config.gm_prefab)
          ? { gm_prefab: asString(config.gm_prefab) }
          : {}),
      },
      {
        status: "paused",
        reservePorts: false,
        currentAlias: true,
      },
    );

    const resolvedMemory = await this.resolveHandleMemoryContext(
      handle,
      worldId,
      workspaceId,
    );
    handle = resolvedMemory.handle;
    const { memoryCtx } = resolvedMemory;
    const resumedFromStep = asNumber(checkpoint.step) ?? 0;
    this.registry.updateLifecycle(handle.simulationId, {
      status: "paused",
      reason: "resumed_from_checkpoint",
      error: null,
      lastCompletedStep: resumedFromStep,
      endedAt: null,
    });
    this.sessionManager.clearSimulation(handle.simulationId, handle.workspaceId);

    const sessions: Record<string, string> = {};
    for (const agent of agents) {
      const session = this.sessionManager.getOrCreate({
        agentId: agent.agent_id,
        agentName: agent.agent_name,
        worldId,
        workspaceId,
        simulationId: resumedSimulationId,
        lineageId: resumedLineageId,
        parentSimulationId: resumedParentSimulationId,
      });
      sessions[agent.agent_id] = session.sessionId;

      if (memoryCtx) {
        await setupAgentIdentity(
          memoryCtx,
          agent.agent_id,
          agent.agent_name,
          agent.personality,
          agent.goal ?? "",
        );
      }

      const entityState = asRecord(entityStates[agent.agent_name]);
      const turnCount = asNumber(entityState.turn_count);
      session.turnCount = turnCount ?? session.turnCount;
      const lastLog = asRecord(entityState.last_log);
      const lastAction = asString(lastLog.action);
      session.lastAction = lastAction ?? session.lastAction;
    }

    return {
      world_id: worldId,
      workspace_id: workspaceId,
      simulation_id: resumedSimulationId,
      lineage_id: resumedLineageId,
      parent_simulation_id: resumedParentSimulationId,
      resumed_from_step: resumedFromStep,
      sessions,
    };
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
    const simulationContext = buildSimulationSystemContext({
      worldId: session.worldId,
      agentName: session.agentName,
      turnCount: session.turnCount + 1,
      premise: handle?.premise ?? "",
    });
    const contextBlocks: string[] = [simulationContext];
    if (handle?.memoryCtx) {
      try {
        const memoryContext = await buildFullActContext(
          handle.memoryCtx,
          agentId,
          sessionId,
          message,
          handle.userId,
        );
        if (memoryContext) {
          contextBlocks.push(memoryContext);
        }
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] buildFullActContext failed for ${agentId}:`,
          err,
        );
      }
    }
    contextBlocks.push(message);
    const enrichedMessage = contextBlocks.join("\n\n");

    const inbound: ChannelInboundMessage = {
      id: randomUUID(),
      channel: "concordia",
      sender_id: agentId,
      sender_name: session.agentName,
      session_id: sessionId,
      scope: "dm",
      content: enrichedMessage,
      timestamp: Date.now(),
      metadata: {
        type: "concordia_agent_turn",
        turn_contract: "concordia_simulation_turn",
        concordia_turn_contract: "concordia_simulation_turn",
        request_id: requestId,
        world_id: session.worldId,
        workspace_id: session.workspaceId,
        concordia_turn: session.turnCount,
        ...withSimulationIdentity({}, this.sessionIdentity(session)),
      },
    };

    const pendingHandle = handle ?? (await this.createSimulationHandle(
      {
        world_id: session.worldId,
        workspace_id: session.workspaceId,
        simulation_id: session.simulationId,
        lineage_id: session.lineageId ?? null,
        parent_simulation_id: session.parentSimulationId ?? null,
        agents: [
          {
            agent_id: session.agentId,
            agent_name: session.agentName,
            personality: "",
          },
        ],
        premise: "",
      },
      {
        status: "running",
        reservePorts: false,
        currentAlias: false,
      },
    ));

    const action = await this.dispatchInboundAwaitingResponse(pendingHandle, {
      requestId,
      inbound,
      sessionId,
      agentId,
      timeoutMs: 120_000,
      timeoutLog: `[concordia] /act timeout for ${session.agentName} after 120000ms`,
      worldId: session.worldId,
      step: pendingHandle.lastCompletedStep,
      simulationId: session.simulationId,
      logMessageLength: message.length,
    });

    session.lastAction = action;
    session.turnCount += 1;

    if (pendingHandle.memoryCtx) {
      try {
        await recordAgentAction(
          pendingHandle.memoryCtx,
          agentId,
          sessionId,
          action,
        );
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] recordAgentAction failed for ${agentId}:`,
          err,
        );
      }
    }

    return action;
  }

  private async handleObserve(
    agentId: string,
    sessionId: string,
    observation: string,
  ): Promise<void> {
    const session = this.sessionManager.findBySessionId(sessionId);
    const handle = session ? this.registry.get(session.simulationId) ?? null : null;

    if (handle?.memoryCtx) {
      try {
        await ingestObservation(handle.memoryCtx, agentId, sessionId, observation);
        await recordObservationWorldFact(
          handle.memoryCtx,
          agentId,
          observation,
        );
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] ingestObservation failed for ${agentId}:`,
          err,
        );
      }
    }

    const inbound: ChannelInboundMessage = {
      id: randomUUID(),
      channel: "concordia",
      sender_id: "concordia-gm",
      sender_name: "Game Master",
      session_id: sessionId,
      scope: "dm",
      content: `[Observation] ${observation}`,
      timestamp: Date.now(),
      metadata: {
        type: "concordia_observation",
        provenance: "concordia:gm_observation",
        concordia_tag: "observation",
        ingest_only: true,
        history_role: "system",
        world_id: session?.worldId,
        workspace_id: session?.workspaceId,
        agent_id: agentId,
        is_observation: true,
        ...withSimulationIdentity(
          {},
          session ? this.sessionIdentity(session) : this.handleIdentity(handle),
        ),
      },
    };

    try {
      await this.context.on_message(inbound);
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] observe ingestion failed for ${agentId}:`,
        err,
      );
    }
  }

  private async handleEvent(event: EventNotification): Promise<void> {
    this.context.logger.debug?.(
      `[concordia] Event: simulation=${event.simulation_id} step=${event.step} type=${event.type} agent=${event.acting_agent ?? "gm"}`,
    );

    const handle = this.registry.get(event.simulation_id) ?? null;
    if (!handle) {
      this.context.logger.warn?.(
        `[concordia] Ignoring event for unknown simulation ${event.simulation_id}`,
      );
      return;
    }

    this.registry.incrementReplayEventCount(handle.simulationId);
    this.registry.updateLifecycle(handle.simulationId, {
      lastStepOutcome:
        event.type === "resolution"
          ? event.content.slice(0, 240)
          : handle.lastStepOutcome,
    });

    if (!handle.memoryCtx) {
      return;
    }

    await this.maybeRunResolutionPeriodicTasks(handle, event);
    await this.recordSimulationEventSideEffects(handle, event);
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

    if (memoryCtx) {
      try {
        const state = (await loadAgentState(
          memoryCtx,
          agentId,
          session.sessionId,
          session.turnCount,
          session.lastAction,
        )) as unknown as AgentStateResponse;
        return {
          simulationId: session.simulationId,
          lineageId: session.lineageId ?? null,
          parentSimulationId: session.parentSimulationId ?? null,
          ...state,
        };
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] getAgentState failed for ${agentId}:`,
          err,
        );
      }
    }

    return {
      simulationId: session.simulationId,
      lineageId: session.lineageId ?? null,
      parentSimulationId: session.parentSimulationId ?? null,
      identity: {
        name: session.agentName,
        personality: "",
        learnedTraits: [],
        beliefs: {},
      },
      memoryCount: session.observations.length,
      recentMemories: session.observations.slice(-5).map((content: string) => ({
        content: content.slice(0, 200),
        role: "system",
        timestamp: Date.now(),
      })),
      relationships: [],
      worldFacts: [],
      turnCount: session.turnCount,
      lastAction: session.lastAction,
    };
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
    let handle = this.registry.getCurrentHandle() ?? null;
    let ephemeralHandle: ConcordiaSimulationHandle | null = null;

    if (!handle) {
      ephemeralHandle = await this.createSimulationHandle(
        {
          world_id: worldId,
          workspace_id: "concordia-generator",
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
      handle = ephemeralHandle;
    }

    try {
      const rawResponse = await this.dispatchInboundAwaitingResponse(handle, {
        requestId,
        inbound: {
          id: randomUUID(),
          channel: "concordia",
          sender_id: "concordia-agent-generator",
          sender_name: "Concordia Agent Generator",
          session_id: sessionId,
          scope: "dm",
          content: prompt,
          timestamp: Date.now(),
          metadata: {
            type: "concordia_generate_agents",
            request_id: requestId,
            world_id: worldId,
            ...withSimulationIdentity({}, this.handleIdentity(handle)),
          },
        },
        sessionId,
        agentId: "concordia-agent-generator",
        timeoutMs: 60_000,
        timeoutLog: "[concordia] /generate-agents timed out after 60000ms",
        worldId,
        step: handle.lastCompletedStep,
        simulationId: handle.simulationId,
        logMessageLength: prompt.length,
      });
      const agents = this.parseGeneratedAgents(rawResponse);
      return { agents };
    } finally {
      if (ephemeralHandle) {
        this.clearPendingResponsesForSimulation(
          ephemeralHandle,
          "Concordia agent generation cleanup",
        );
        this.registry.deleteHandle(ephemeralHandle.simulationId);
      }
    }
  }

  private async handleLaunch(
    request: LaunchRequest,
  ): Promise<Record<string, unknown>> {
    const defaults = resolveConcordiaLaunchDefaults(this.context);
    const launchRequest = this.normalizeLaunchRequest({
      ...request,
      gm_provider: request.gm_provider ?? defaults.gm_provider,
      gm_model: request.gm_model ?? defaults.gm_model,
      gm_api_key: request.gm_api_key ?? defaults.gm_api_key,
      gm_base_url: request.gm_base_url ?? defaults.gm_base_url,
    });

    let handle = this.registry.get(launchRequest.simulation_id) ?? null;
    if (handle?.runner) {
      await this.cleanupSimulationHandle(
        handle,
        "Concordia simulation launch replacement",
        {
          status: "stopped",
          removeHandle: false,
          stopRunner: true,
          removeSessions: true,
          runPostCleanup: true,
          clearMemoryContext: true,
        },
      );
      handle = this.registry.get(launchRequest.simulation_id) ?? null;
    }

    if (!handle) {
      handle = await this.createSimulationHandle(launchRequest, {
        status: "launching",
        currentAlias: true,
      });
    } else {
      const reserved = await this.registry.reservePorts({
        controlPort:
          launchRequest.control_port ?? handle.controlPort ?? undefined,
        eventPort: launchRequest.event_port ?? handle.eventPort ?? undefined,
      });
      handle = this.registry.setLaunchMetadata(handle.simulationId, {
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
      });
      handle.launchRequest = {
        ...handle.launchRequest,
        ...launchRequest,
        control_port: reserved.controlPort,
        event_port: reserved.eventPort,
      };
      handle = this.registry.updateLifecycle(handle.simulationId, {
        status: "launching",
        reason: null,
        error: null,
        startedAt: null,
        endedAt: null,
        pid: null,
        controlPort: reserved.controlPort,
        eventPort: reserved.eventPort,
      });
      this.registry.setCurrentAlias(handle.simulationId);
    }

    try {
      const runner = await launchSimulationRunner({
        request: handle.launchRequest,
        config: this.context.config,
        logger: this.context.logger,
      });
      handle = this.registry.attachRunner(
        handle.simulationId,
        runner,
        runner.child.pid ?? null,
      );

      const launchedRunner = runner;
      const launchedSimulationId = handle.simulationId;
      runner.child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        const exitMessage = `[concordia] runner exited code=${String(code)} signal=${String(signal)}`;
        this.context.logger.info?.(exitMessage);
        const currentHandle = this.registry.get(launchedSimulationId) ?? null;
        if (!currentHandle || currentHandle.runner !== launchedRunner) {
          return;
        }
        const status: SimulationLifecycleStatus =
          signal === "SIGTERM"
            ? "stopped"
            : code === 0
              ? "finished"
              : "failed";
        void this.cleanupSimulationHandle(currentHandle, exitMessage, {
          status,
          removeHandle: false,
          stopRunner: false,
          removeSessions: false,
          runPostCleanup: true,
          clearMemoryContext: false,
          error: status === "failed" ? exitMessage : null,
        });
      });
    } catch (error) {
      this.registry.detachRunner(handle.simulationId);
      this.registry.updateLifecycle(handle.simulationId, {
        status: "failed",
        reason: "launch_failed",
        error: error instanceof Error ? error.message : String(error),
        endedAt: Date.now(),
      });
      throw error;
    }

    return {
      world_id: handle.worldId,
      workspace_id: handle.workspaceId,
      simulation_id: handle.simulationId,
      lineage_id: handle.lineageId,
      parent_simulation_id: handle.parentSimulationId,
      pid: handle.pid,
      control_port: handle.controlPort,
      event_port: handle.eventPort,
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
      getAgentState: (agentId, simulationId) =>
        this.handleGetAgentState(agentId, simulationId),
      listSimulations: () => this.handleListSimulations(),
      getSimulation: (simulationId) => this.handleGetSimulation(simulationId),
    };
  }

  private async listenBridgeServer(port: number, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.bridgeServer!.on("error", reject);
      this.bridgeServer!.listen(port, host, () => {
        this.healthy = true;
        this.context.logger.info?.(
          `[concordia] Bridge server listening on ${host}:${port}`,
        );
        resolve();
      });
    });
  }

  private async cleanupAllSimulations(
    reason: string,
    options: {
      readonly status?: SimulationLifecycleStatus;
      readonly removeHandle?: boolean;
      readonly stopRunner?: boolean;
      readonly removeSessions?: boolean;
      readonly runPostCleanup?: boolean;
      readonly clearMemoryContext?: boolean;
      readonly error?: string | null;
    },
  ): Promise<void> {
    for (const handle of this.registry.listHandles()) {
      await this.cleanupSimulationHandle(handle, reason, options);
    }
  }

  private async resolveHandleMemoryContext(
    handle: ConcordiaSimulationHandle,
    worldId: string,
    workspaceId: string,
  ): Promise<{
    handle: ConcordiaSimulationHandle;
    memoryCtx: MemoryWiringContext | null;
  }> {
    const existingMemory = handle.memoryCtx;
    if (
      existingMemory &&
      existingMemory.worldId === worldId &&
      existingMemory.workspaceId === workspaceId &&
      existingMemory.simulationId === handle.simulationId
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
    );
    return {
      handle: this.registry.attachMemoryContext(handle.simulationId, memoryCtx),
      memoryCtx,
    };
  }

  private currentSimulationIdentity(): SimulationIdentity {
    return this.handleIdentity(this.registry.getCurrentHandle() ?? null);
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

  private async createSimulationHandle(
    request: NormalizedLaunchRequest,
    options: {
      readonly status?: SimulationLifecycleStatus;
      readonly reservePorts?: boolean;
      readonly currentAlias?: boolean;
    } = {},
  ): Promise<ConcordiaSimulationHandle> {
    const reserved = options.reservePorts === false
      ? {
          controlPort: request.control_port ?? null,
          eventPort: request.event_port ?? null,
        }
      : await this.registry.reservePorts({
          controlPort: request.control_port ?? null,
          eventPort: request.event_port ?? null,
        });
    return this.registry.createHandle({
      request: {
        ...request,
        control_port: reserved.controlPort ?? request.control_port,
        event_port: reserved.eventPort ?? request.event_port,
      },
      status: options.status,
      controlPort: reserved.controlPort ?? request.control_port ?? null,
      eventPort: reserved.eventPort ?? request.event_port ?? null,
      currentAlias: options.currentAlias,
    });
  }

  private async refreshSimulationStatus(
    handle: ConcordiaSimulationHandle,
  ): Promise<ConcordiaSimulationHandle> {
    if (!handle.controlPort || isTerminalSimulationStatus(handle.status)) {
      return handle;
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${handle.controlPort}/simulation/status`,
      );
      if (!response.ok) {
        return handle;
      }
      const status = await response.json() as RunnerStatusSnapshot;
      const mapped = this.mapRunnerStatus(status, handle.status);
      return this.registry.updateLifecycle(handle.simulationId, mapped);
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

  private resolvePendingSendTarget(
    message: ChannelOutboundMessage,
  ): PendingSendTarget | null {
    const metadataRequestId = extractRequestId(message.metadata);
    if (!metadataRequestId) {
      const sessionMatch = this.getHandleForSession(message.session_id);
      if (!sessionMatch) {
        this.context.logger.debug?.(
          `[concordia] send() ignored outbound message without request_id ${JSON.stringify({
            session_id: message.session_id,
          })}`,
        );
        return null;
      }
      const matches = this.registry.findPendingBySession(
        sessionMatch.handle.simulationId,
        message.session_id,
        (pending) => pending.sessionId,
      );
      if (matches.length === 1) {
        const [requestId, pending] = matches[0];
        this.logPendingResponse(
          "missing_request_id_fallback",
          requestId,
          pending,
          {},
          "warn",
        );
        return {
          handle: sessionMatch.handle,
          requestId,
          pending,
          usedSessionFallback: true,
        };
      }
      if (matches.length === 0) {
        this.context.logger.debug?.(
          `[concordia] send() ignored outbound message without request_id ${JSON.stringify({
            session_id: message.session_id,
          })}`,
        );
        return null;
      }
      this.context.logger.warn?.(
        `[concordia] send() missing request_id ${JSON.stringify({
          session_id: message.session_id,
          pending_matches: matches.length,
          simulation_id: sessionMatch.handle.simulationId,
        })}`,
      );
      return null;
    }

    const target = this.registry.getPendingByRequestId(metadataRequestId);
    if (!target) {
      this.context.logger.warn?.(
        `[concordia] send() for unknown request_id ${JSON.stringify({
          request_id: metadataRequestId,
          session_id: message.session_id,
        })}`,
      );
      return null;
    }

    return {
      handle: target.handle,
      requestId: metadataRequestId,
      pending: target.pending,
      usedSessionFallback: false,
    };
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
    if (
      !handle.memoryCtx ||
      event.type !== "resolution" ||
      event.step <= handle.lastCompletedStep
    ) {
      return;
    }

    this.registry.updateLifecycle(handle.simulationId, {
      lastCompletedStep: event.step,
    });
    try {
      const agentIds = this.sessionManager
        .getAllForWorld(
          event.world_id,
          handle.workspaceId,
          event.simulation_id,
        )
        .map((session) => session.agentId);
      await runPeriodicTasks(
        handle.memoryCtx,
        event.step,
        agentIds,
        {
          reflectionInterval: this.context.config.reflection_interval,
          consolidationInterval: this.context.config.consolidation_interval,
        },
        this.context.logger,
      );
      const promotedFacts = await promoteCollectiveEmergenceFacts(
        handle.memoryCtx,
        event.step,
      );
      if (promotedFacts.length > 0) {
        this.context.logger.info?.(
          `[concordia] Promoted ${promotedFacts.length} collectively confirmed world facts at step ${event.step}`,
        );
      }
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] runPeriodicTasks failed at step ${event.step}:`,
        err,
      );
    }
  }

  private async recordSimulationEventSideEffects(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): Promise<void> {
    if (!handle.memoryCtx) {
      return;
    }

    try {
      await recordSocialEvent(
        handle.memoryCtx,
        event,
        this.knownAgentsForEvent(handle, event),
      );
    } catch (err) {
      this.context.logger.warn?.("[concordia] recordSocialEvent failed:", err);
    }

    try {
      await updateTemporalEdges(
        handle.memoryCtx,
        event.acting_agent,
        event.content,
      );
    } catch (err) {
      this.context.logger.warn?.(
        "[concordia] updateTemporalEdges failed:",
        err,
      );
    }

    try {
      const agentSession = this.resolveAgentSessionForEvent(handle, event);
      if (agentSession) {
        await logSimulationEvent(handle.memoryCtx, agentSession.sessionId, {
          step: event.step,
          actingAgent: event.acting_agent,
          content: event.content,
          type: event.type,
        });
      }
    } catch (err) {
      this.context.logger.warn?.(
        "[concordia] logSimulationEvent failed:",
        err,
      );
    }
  }

  private knownAgentsForEvent(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): KnownAgentReference[] {
    return this.sessionManager
      .getAllForWorld(
        event.world_id,
        handle.workspaceId,
        event.simulation_id,
      )
      .map((session) => ({
        agentId: session.agentId,
        agentName: session.agentName,
      }));
  }

  private resolveAgentSessionForEvent(
    handle: ConcordiaSimulationHandle,
    event: EventNotification,
  ): AgentSession | undefined {
    return event.acting_agent
      ? this.sessionManager.getForWorld({
          agentId: event.acting_agent,
          worldId: event.world_id,
          workspaceId: handle.workspaceId,
          simulationId: event.simulation_id,
        })
      : this.sessionManager.getAllForWorld(
          event.world_id,
          handle.workspaceId,
          event.simulation_id,
        )[0];
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
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectPendingResponse(
          handle,
          requestId,
          new Error(timeoutLog),
          "timeout",
        );
      }, timeoutMs);

      const pending: PendingResponseRequest = {
        agentId,
        sessionId,
        worldId,
        simulationId,
        step,
        createdAt: Date.now(),
        resolve,
        reject,
        timeout,
      };
      this.registry.registerPendingResponse(handle.simulationId, requestId, pending);
      this.logPendingResponse(
        "created",
        requestId,
        pending,
        { timeout_ms: timeoutMs },
        "info",
      );
    });
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

    let runnerToStop: SpawnedSimulationRunner | null = null;
    if (handle.runner) {
      runnerToStop = options.stopRunner === false ? null : handle.runner;
      this.registry.detachRunner(handle.simulationId);
    }
    if (options.clearMemoryContext) {
      this.registry.attachMemoryContext(handle.simulationId, null);
    }
    if (runnerToStop) {
      await stopSimulationRunner(runnerToStop);
    }
    this.registry.updateLifecycle(handle.simulationId, {
      status: options.status ?? "stopped",
      reason,
      error: options.error ?? null,
      endedAt: Date.now(),
    });

    if (options.removeSessions !== false) {
      this.sessionManager.clearSimulation(handle.simulationId, handle.workspaceId);
    }

    if (options.removeHandle) {
      this.registry.deleteHandle(handle.simulationId);
    }
  }

  private parseGeneratedAgents(rawResponse: string): GeneratedAgent[] {
    const trimmed = rawResponse.trim();
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonText = match ? match[1].trim() : trimmed;
    const parsed = JSON.parse(jsonText) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error("Expected JSON array of generated agents");
    }

    const agents = parsed.map((entry, index) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as Record<string, unknown>).id !== "string" ||
        typeof (entry as Record<string, unknown>).name !== "string" ||
        typeof (entry as Record<string, unknown>).personality !== "string" ||
        typeof (entry as Record<string, unknown>).goal !== "string"
      ) {
        throw new Error(`Generated agent ${index} is missing required fields`);
      }

      const agent = entry as Record<string, string>;
      return {
        id: agent.id,
        name: agent.name,
        personality: agent.personality,
        goal: agent.goal,
      };
    });

    return agents;
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
