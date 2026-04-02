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
} from "./types.js";
import { SessionManager, type AgentSession } from "./session-manager.js";
import { createBridgeServer } from "./bridge-http.js";
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

// ============================================================================
// Adapter
// ============================================================================

export class ConcordiaChannelAdapter
  implements ChannelAdapter<ConcordiaChannelConfig>
{
  readonly name = "concordia";

  private context!: ChannelAdapterContext<ConcordiaChannelConfig>;
  private bridgeServer: Server | null = null;
  private sessionManager = new SessionManager();
  private pendingResponses = new Map<string, PendingResponseRequest>();
  private healthy = false;
  private simulationRunner: SpawnedSimulationRunner | null = null;
  private simulationPremise = "";
  private simulationUserId: string | undefined;
  private simulationId: string | null = null;
  private lineageId: string | null = null;
  private parentSimulationId: string | null = null;

  // Memory wiring state
  private memoryCtx: MemoryWiringContext | null = null;
  private simulationStep = 0;

  async initialize(
    context: ChannelAdapterContext<ConcordiaChannelConfig>,
  ): Promise<void> {
    this.context = context;
  }

  async start(): Promise<void> {
    const port = this.context.config.bridge_port ?? 3200;
    const host = "127.0.0.1";

    this.bridgeServer = createBridgeServer({
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
    });

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

  async stop(): Promise<void> {
    this.healthy = false;

    // Wire: post-simulation cleanup
    if (this.memoryCtx) {
      try {
        const agentIds = this.sessionManager
          .getAllForWorld(
            this.memoryCtx.worldId,
            this.memoryCtx.workspaceId,
            this.simulationId ?? undefined,
          )
          .map((session) => session.agentId);
        await postSimulationCleanup(
          this.memoryCtx,
          agentIds,
          this.context.logger,
        );
      } catch (err) {
        this.context.logger.warn?.(
          "[concordia] postSimulationCleanup failed:", err,
        );
      }
    }

    await stopSimulationRunner(this.simulationRunner);
    this.simulationRunner = null;

    this.clearPendingResponses("Concordia bridge stopped");

    // Close HTTP server
    if (this.bridgeServer) {
      await new Promise<void>((resolve) => {
        this.bridgeServer!.close(() => resolve());
      });
      this.bridgeServer = null;
    }

    this.memoryCtx = null;
    this.simulationStep = 0;
    this.simulationPremise = "";
    this.simulationUserId = undefined;
    this.simulationId = null;
    this.lineageId = null;
    this.parentSimulationId = null;
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

    const { requestId, pending, usedSessionFallback } = target;
    if (pending.sessionId !== message.session_id) {
      this.rejectPendingResponse(
        requestId,
        new Error(
          `[concordia] send() session mismatch for request ${requestId}: expected ${pending.sessionId}, got ${message.session_id}`,
        ),
        "session_mismatch",
      );
      return;
    }

    this.resolvePendingResponse(
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

    this.sessionManager.resetSimulation();
    this.clearPendingResponses("Concordia simulation reset");

    this.simulationId = request.simulation_id;
    this.lineageId = request.lineage_id ?? null;
    this.parentSimulationId = request.parent_simulation_id ?? null;

    // Resolve memory wiring context for this simulation
    this.memoryCtx = await resolveConcordiaMemoryContext(
      this.context,
      request.world_id,
      request.workspace_id,
      {
        simulationId: this.simulationId,
        lineageId: this.lineageId,
        parentSimulationId: this.parentSimulationId,
      },
    );
    this.simulationStep = 0;
    this.simulationPremise = request.premise;
    this.simulationUserId = request.user_id ?? this.simulationUserId;

    for (const agent of request.agents) {
      const session = this.sessionManager.getOrCreate({
        agentId: agent.agent_id,
        agentName: agent.agent_name,
        worldId: request.world_id,
        workspaceId: request.workspace_id,
        simulationId: request.simulation_id,
        lineageId: request.lineage_id,
        parentSimulationId: request.parent_simulation_id,
      });
      sessions[agent.agent_id] = session.sessionId;

      // Wire: setup agent identity in memory
      if (this.memoryCtx) {
        try {
          await setupAgentIdentity(
            this.memoryCtx,
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

    // Wire: store premise as world fact
    if (this.memoryCtx && request.premise) {
      try {
        await storePremise(this.memoryCtx, request.premise);
      } catch (err) {
        this.context.logger.warn?.(
          "[concordia] Failed to store premise:", err,
        );
      }
    }

    return sessions;
  }

  private async handleReset(): Promise<void> {
    this.sessionManager.clear();
    this.clearPendingResponses("Concordia simulation reset");
    await stopSimulationRunner(this.simulationRunner);
    this.simulationRunner = null;
    this.memoryCtx = null;
    this.simulationStep = 0;
    this.simulationPremise = "";
    this.simulationUserId = undefined;
    this.simulationId = null;
    this.lineageId = null;
    this.parentSimulationId = null;
  }

  private async handleCheckpoint(
    request: CheckpointRequest,
  ): Promise<Record<string, unknown>> {
    if (
      !this.memoryCtx ||
      this.memoryCtx.worldId !== request.world_id ||
      this.memoryCtx.workspaceId !== request.workspace_id ||
      this.simulationId !== request.simulation_id
    ) {
      this.simulationId = request.simulation_id;
      this.lineageId = request.lineage_id ?? this.lineageId ?? null;
      this.parentSimulationId =
        request.parent_simulation_id ?? this.parentSimulationId ?? null;
      this.memoryCtx = await resolveConcordiaMemoryContext(
        this.context,
        request.world_id,
        request.workspace_id,
        {
          simulationId: this.simulationId,
          lineageId: this.lineageId,
          parentSimulationId: this.parentSimulationId,
        },
      );
    }

    if (this.memoryCtx) {
      await runCheckpointMaintenance(this.memoryCtx);
    }

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
          session.simulation_id,
        ),
      })),
    );

    return {
      world_id: request.world_id,
      workspace_id: request.workspace_id,
      simulation_id: request.simulation_id,
      lineage_id: this.lineageId,
      parent_simulation_id: this.parentSimulationId,
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
    const worldId = asString(checkpoint.world_id) ?? asString(config.world_id) ?? "default";
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
    const agents = Array.isArray(config.agents) ? config.agents : [];
    const entityStates = asRecord(checkpoint.entity_states);

    await this.handleReset();

    this.simulationId = resumedSimulationId;
    this.lineageId = resumedLineageId;
    this.parentSimulationId = resumedParentSimulationId;
    this.memoryCtx = await resolveConcordiaMemoryContext(
      this.context,
      worldId,
      workspaceId,
      {
        simulationId: this.simulationId,
        lineageId: this.lineageId,
        parentSimulationId: this.parentSimulationId,
      },
    );
    this.simulationPremise = premise;
    this.simulationStep = asNumber(checkpoint.step) ?? 0;
    this.simulationUserId =
      request.user_id ??
      asString(checkpoint.user_id) ??
      asString(config.user_id) ??
      this.simulationUserId;

    const sessions: Record<string, string> = {};
    for (const rawAgent of agents) {
      const agent = asRecord(rawAgent);
      const agentId = asString(agent.id);
      const agentName = asString(agent.name);
      if (!agentId || !agentName) {
        continue;
      }

      const session = this.sessionManager.getOrCreate({
        agentId,
        agentName,
        worldId,
        workspaceId,
        simulationId: resumedSimulationId,
        lineageId: resumedLineageId,
        parentSimulationId: resumedParentSimulationId,
      });
      sessions[agentId] = session.sessionId;

      if (this.memoryCtx) {
        await setupAgentIdentity(
          this.memoryCtx,
          agentId,
          agentName,
          asString(agent.personality) ?? "",
          asString(agent.goal) ?? "",
        );
      }

      const entityState = asRecord(entityStates[agentName]);
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
      resumed_from_step: this.simulationStep,
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

    const simulationContext = buildSimulationSystemContext({
      worldId: session.worldId,
      agentName: session.agentName,
      turnCount: session.turnCount + 1,
      premise: this.simulationPremise,
    });
    const contextBlocks: string[] = [simulationContext];
    if (this.memoryCtx) {
      try {
        const memoryContext = await buildFullActContext(
          this.memoryCtx,
          agentId,
          sessionId,
          message,
          this.simulationUserId,
        );
        if (memoryContext) {
          contextBlocks.push(memoryContext);
        }
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] buildFullActContext failed for ${agentId}:`, err,
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

    const action = await this.dispatchInboundAwaitingResponse({
      requestId,
      inbound,
      sessionId,
      agentId,
      timeoutMs: 120_000,
      timeoutLog: `[concordia] /act timeout for ${session.agentName} after 120000ms`,
      worldId: session.worldId,
      step: this.simulationStep,
      simulationId: session.simulationId,
      logMessageLength: message.length,
    });

    session.lastAction = action;
    session.turnCount += 1;

    if (this.memoryCtx) {
      try {
        await recordAgentAction(this.memoryCtx, agentId, sessionId, action);
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

    // Wire: ingest observation into persistent memory
    if (this.memoryCtx) {
      try {
        await ingestObservation(this.memoryCtx, agentId, sessionId, observation);
        await recordObservationWorldFact(
          this.memoryCtx,
          agentId,
          observation,
        );
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] ingestObservation failed for ${agentId}:`, err,
        );
      }
    }

    // Send the observation as a system message so it appears in the agent's
    // context window on the next /act call.
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
          session ? this.sessionIdentity(session) : this.currentSimulationIdentity(),
        ),
      },
    };

    // Fire-and-forget — observations should not block the simulation
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

    if (!this.memoryCtx) {
      return;
    }
    if (!this.isActiveSimulationEvent(event)) {
      this.context.logger.warn?.(
        `[concordia] Ignoring event for inactive simulation ${event.simulation_id}; active simulation is ${this.simulationId}`,
      );
      return;
    }

    await this.maybeRunResolutionPeriodicTasks(event);
    await this.recordSimulationEventSideEffects(event);
  }

  private async handleGetAgentState(
    agentId: string,
    simulationId: string | null = this.simulationId,
  ): Promise<AgentStateResponse | null> {
    const session = this.memoryCtx
      ? this.sessionManager.getForWorld({
          agentId,
          worldId: this.memoryCtx.worldId,
          workspaceId: this.memoryCtx.workspaceId,
          simulationId: simulationId ?? undefined,
        })
      : this.sessionManager.findForSimulation({
          agentId,
          simulationId: simulationId ?? undefined,
        });
    if (!session) return null;

    if (this.memoryCtx) {
      try {
        const state = await loadAgentState(
          this.memoryCtx,
          agentId,
          session.sessionId,
          session.turnCount,
          session.lastAction,
        ) as unknown as AgentStateResponse;
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
    const identity = this.currentSimulationIdentity();
    const rawResponse = await this.dispatchInboundAwaitingResponse({
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
          ...withSimulationIdentity({}, identity),
        },
      },
      sessionId,
      agentId: "concordia-agent-generator",
      timeoutMs: 60_000,
      timeoutLog: "[concordia] /generate-agents timed out after 60000ms",
      worldId,
      step: this.simulationStep,
      simulationId: identity.simulationId,
      logMessageLength: prompt.length,
    });
    const agents = this.parseGeneratedAgents(rawResponse);
    return { agents };
  }

  private async handleLaunch(
    request: LaunchRequest,
  ): Promise<Record<string, unknown>> {
    const defaults = resolveConcordiaLaunchDefaults(this.context);
    const simulationId = request.simulation_id ?? randomUUID();
    const lineageId = request.lineage_id ?? null;
    const parentSimulationId = request.parent_simulation_id ?? null;
    const launchRequest: LaunchRequest = {
      ...request,
      simulation_id: simulationId,
      lineage_id: lineageId,
      parent_simulation_id: parentSimulationId,
      gm_provider: request.gm_provider ?? defaults.gm_provider,
      gm_model: request.gm_model ?? defaults.gm_model,
      gm_api_key: request.gm_api_key ?? defaults.gm_api_key,
      gm_base_url: request.gm_base_url ?? defaults.gm_base_url,
    };
    this.simulationUserId = launchRequest.user_id ?? this.simulationUserId;
    this.simulationId = simulationId;
    this.lineageId = lineageId;
    this.parentSimulationId = parentSimulationId;

    await stopSimulationRunner(this.simulationRunner);
    this.simulationRunner = null;

    this.simulationRunner = await launchSimulationRunner({
      request: launchRequest,
      config: this.context.config,
      logger: this.context.logger,
    });

    const launchedRunner = this.simulationRunner;
    launchedRunner.child.once("exit", (code, signal) => {
      const exitMessage = `[concordia] runner exited code=${String(code)} signal=${String(signal)}`;
      this.context.logger.info?.(exitMessage);
      if (this.simulationRunner === launchedRunner) {
        this.simulationRunner = null;
        this.clearPendingResponses(exitMessage);
      }
    });

    return {
      world_id: launchRequest.world_id,
      workspace_id: launchRequest.workspace_id,
      simulation_id: simulationId,
      lineage_id: lineageId,
      parent_simulation_id: parentSimulationId,
      pid: this.simulationRunner.child.pid ?? null,
      control_port: launchRequest.control_port ?? 3202,
      event_port: launchRequest.event_port ?? 3201,
    };
  }

  private currentSimulationIdentity(): SimulationIdentity {
    return createSimulationIdentity({
      simulationId: this.simulationId,
      lineageId: this.lineageId,
      parentSimulationId: this.parentSimulationId,
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

  private resolvePendingSendTarget(
    message: ChannelOutboundMessage,
  ): PendingSendTarget | null {
    const metadataRequestId = extractRequestId(message.metadata);
    if (!metadataRequestId) {
      const matches = this.findPendingResponsesBySession(message.session_id);
      if (matches.length === 1) {
        const [requestId, pending] = matches[0];
        this.logPendingResponse(
          "missing_request_id_fallback",
          requestId,
          pending,
          {},
          "warn",
        );
        return { requestId, pending, usedSessionFallback: true };
      }
      this.context.logger.warn?.(
        `[concordia] send() missing request_id ${JSON.stringify({
          session_id: message.session_id,
          pending_matches: matches.length,
        })}`,
      );
      return null;
    }

    const pending = this.pendingResponses.get(metadataRequestId);
    if (!pending) {
      this.context.logger.warn?.(
        `[concordia] send() for unknown request_id ${JSON.stringify({
          request_id: metadataRequestId,
          session_id: message.session_id,
        })}`,
      );
      return null;
    }

    return {
      requestId: metadataRequestId,
      pending,
      usedSessionFallback: false,
    };
  }

  private async dispatchInboundAwaitingResponse({
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
  }: PendingDispatchRequest): Promise<string> {
    const responsePromise = this.createPendingResponse(
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
      this.pendingResponses.get(requestId),
      logMessageLength === undefined ? {} : { message_length: logMessageLength },
      "debug",
    );

    try {
      await this.context.on_message(inbound);
    } catch (err) {
      this.rejectPendingResponse(
        requestId,
        err instanceof Error ? err : new Error(String(err)),
        "dispatch_failed",
      );
      await responsePromise.catch(() => undefined);
      throw err;
    }

    return responsePromise;
  }

  private isActiveSimulationEvent(event: EventNotification): boolean {
    return !!this.memoryCtx && (
      this.memoryCtx.worldId === event.world_id &&
      this.memoryCtx.workspaceId === event.workspace_id &&
      this.simulationId === event.simulation_id
    );
  }

  private async maybeRunResolutionPeriodicTasks(
    event: EventNotification,
  ): Promise<void> {
    if (
      !this.memoryCtx ||
      event.type !== "resolution" ||
      event.step <= this.simulationStep
    ) {
      return;
    }

    this.simulationStep = event.step;
    try {
      const agentIds = this.sessionManager
        .getAllForWorld(
          event.world_id,
          this.memoryCtx.workspaceId,
          event.simulation_id,
        )
        .map((session) => session.agentId);
      await runPeriodicTasks(
        this.memoryCtx,
        this.simulationStep,
        agentIds,
        {
          reflectionInterval: this.context.config.reflection_interval,
          consolidationInterval: this.context.config.consolidation_interval,
        },
        this.context.logger,
      );
      const promotedFacts = await promoteCollectiveEmergenceFacts(
        this.memoryCtx,
        this.simulationStep,
      );
      if (promotedFacts.length > 0) {
        this.context.logger.info?.(
          `[concordia] Promoted ${promotedFacts.length} collectively confirmed world facts at step ${this.simulationStep}`,
        );
      }
    } catch (err) {
      this.context.logger.warn?.(
        `[concordia] runPeriodicTasks failed at step ${this.simulationStep}:`,
        err,
      );
    }
  }

  private async recordSimulationEventSideEffects(
    event: EventNotification,
  ): Promise<void> {
    if (!this.memoryCtx) {
      return;
    }

    try {
      await recordSocialEvent(this.memoryCtx, event, this.knownAgentsForEvent(event));
    } catch (err) {
      this.context.logger.warn?.("[concordia] recordSocialEvent failed:", err);
    }

    try {
      await updateTemporalEdges(
        this.memoryCtx,
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
      const agentSession = this.resolveAgentSessionForEvent(event);
      if (agentSession) {
        await logSimulationEvent(this.memoryCtx, agentSession.sessionId, {
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

  private knownAgentsForEvent(event: EventNotification): KnownAgentReference[] {
    if (!this.memoryCtx) {
      return [];
    }
    return this.sessionManager
      .getAllForWorld(
        event.world_id,
        this.memoryCtx.workspaceId,
        event.simulation_id,
      )
      .map((session) => ({
        agentId: session.agentId,
        agentName: session.agentName,
      }));
  }

  private resolveAgentSessionForEvent(
    event: EventNotification,
  ): AgentSession | undefined {
    if (!this.memoryCtx) {
      return undefined;
    }
    return event.acting_agent
      ? this.sessionManager.getForWorld({
          agentId: event.acting_agent,
          worldId: event.world_id,
          workspaceId: this.memoryCtx.workspaceId,
          simulationId: event.simulation_id,
        })
      : this.sessionManager.getAllForWorld(
          event.world_id,
          this.memoryCtx.workspaceId,
          event.simulation_id,
        )[0];
  }

  private createPendingResponse(
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
      this.pendingResponses.set(requestId, pending);
      this.logPendingResponse(
        "created",
        requestId,
        pending,
        { timeout_ms: timeoutMs },
        "info",
      );
    });
  }

  private findPendingResponsesBySession(
    sessionId: string,
  ): Array<[string, PendingResponseRequest]> {
    return Array.from(this.pendingResponses.entries()).filter(([, pending]) => (
      pending.sessionId === sessionId
    ));
  }

  private resolvePendingResponse(
    requestId: string,
    pending: PendingResponseRequest,
    content: string,
    event: string,
  ): void {
    clearTimeout(pending.timeout);
    this.pendingResponses.delete(requestId);
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
    requestId: string,
    error: Error,
    event: string,
  ): void {
    const pending = this.pendingResponses.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingResponses.delete(requestId);
    this.logPendingResponse(
      event,
      requestId,
      pending,
      { error: error.message },
      "warn",
    );
    pending.reject(error);
  }

  private clearPendingResponses(reason: string): void {
    for (const [requestId, pending] of Array.from(this.pendingResponses.entries())) {
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(requestId);
      this.logPendingResponse(
        "cleared",
        requestId,
        pending,
        { error: reason },
        "warn",
      );
      pending.reject(new Error(reason));
    }
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
