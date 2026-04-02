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
 * - handleAct() calls buildFullActContext() + runPeriodicTasks()
 * - handleEvent() calls recordSocialEvent() + updateTemporalEdges() + logSimulationEvent()
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
import { SessionManager } from "./session-manager.js";
import { createBridgeServer } from "./bridge-http.js";
import type { Server } from "node:http";
import type { MemoryWiringContext } from "./memory-wiring.js";
import {
  setupAgentIdentity,
  ingestObservation,
  buildFullActContext,
  recordSocialEvent,
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

const MAX_GENERATED_AGENTS = 25;

// ============================================================================
// Pending request tracking
// ============================================================================

interface PendingResponseRequest {
  readonly agentId?: string;
  readonly sessionId: string;
  resolve: (content: string) => void;
  timeout: ReturnType<typeof setTimeout>;
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
      getAgentState: (agentId) => this.handleGetAgentState(agentId),
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
        const agentIds = this.sessionManager.listAgentIds();
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

    this.clearPendingResponses("");

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
    this.context.logger.info?.("[concordia] Bridge server stopped");
  }

  /**
   * Called by the daemon when the ChatExecutor produces a response.
   * Routes the response to the pending /act request for the matching session.
   */
  async send(message: ChannelOutboundMessage): Promise<void> {
    // Skip partial streaming chunks — wait for the complete response
    if (message.is_partial) return;

    const requestId = extractRequestId(message.metadata);
    if (!requestId) {
      this.context.logger.warn?.(
        `[concordia] send() missing request_id for session: ${message.session_id}`,
      );
      return;
    }

    const pending = this.pendingResponses.get(requestId);
    if (!pending) {
      this.context.logger.warn?.(
        `[concordia] send() for unknown request_id: ${requestId}`,
      );
      return;
    }

    if (pending.sessionId !== message.session_id) {
      this.context.logger.warn?.(
        `[concordia] send() session mismatch for request ${requestId}: expected ${pending.sessionId}, got ${message.session_id}`,
      );
      return;
    }

    clearTimeout(pending.timeout);
    pending.resolve(message.content);
    this.pendingResponses.delete(requestId);
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
    this.clearPendingResponses("");

    // Resolve memory wiring context for this simulation
    this.memoryCtx = await resolveConcordiaMemoryContext(
      this.context,
      request.world_id,
      request.workspace_id,
    );
    this.simulationStep = 0;
    this.simulationPremise = request.premise;

    for (const agent of request.agents) {
      const session = this.sessionManager.getOrCreate({
        agentId: agent.agent_id,
        agentName: agent.agent_name,
        worldId: request.world_id,
        workspaceId: request.workspace_id,
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
    this.clearPendingResponses("");
    await stopSimulationRunner(this.simulationRunner);
    this.simulationRunner = null;
    this.memoryCtx = null;
    this.simulationStep = 0;
    this.simulationPremise = "";
  }

  private async handleCheckpoint(
    request: CheckpointRequest,
  ): Promise<Record<string, unknown>> {
    if (
      !this.memoryCtx ||
      this.memoryCtx.worldId !== request.world_id ||
      this.memoryCtx.workspaceId !== request.workspace_id
    ) {
      this.memoryCtx = await resolveConcordiaMemoryContext(
        this.context,
        request.world_id,
        request.workspace_id,
      );
    }

    if (this.memoryCtx) {
      await runCheckpointMaintenance(this.memoryCtx);
    }

    const sessions = this.sessionManager
      .getAll()
      .filter((session) => session.worldId === request.world_id)
      .map((session) => ({
        agent_id: session.agentId,
        agent_name: session.agentName,
        session_id: session.sessionId,
        turn_count: session.turnCount,
        last_action: session.lastAction,
      }));

    const agent_states = await Promise.all(
      sessions.map(async (session) => ({
        agent_id: session.agent_id,
        state: await this.handleGetAgentState(session.agent_id),
      })),
    );

    return {
      world_id: request.world_id,
      workspace_id: request.workspace_id,
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
    const premise = asString(config.premise) ?? "";
    const agents = Array.isArray(config.agents) ? config.agents : [];
    const entityStates = asRecord(checkpoint.entity_states);

    await this.handleReset();

    this.memoryCtx = await resolveConcordiaMemoryContext(
      this.context,
      worldId,
      workspaceId,
    );
    this.simulationPremise = premise;
    this.simulationStep = asNumber(checkpoint.step) ?? 0;

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

    // Wire: build enriched context from memory (identity + procedural + KG + shared)
    const simulationContext = buildSimulationSystemContext({
      worldId: session.worldId,
      agentName: session.agentName,
      turnCount: session.turnCount,
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

    // Create a ChannelInboundMessage and send through the daemon pipeline
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
      },
    };

    // Create a promise that resolves when send() is called
    const actionPromise = this.createPendingResponse(
      requestId,
      sessionId,
      agentId,
      "",
      120_000,
      `[concordia] /act timeout for ${session.agentName} after 120000ms`,
    );

    // Fire the message into the daemon pipeline
    await this.context.on_message(inbound);

    // Wait for the daemon to call send() with the response
    const action = await actionPromise;

    // Wire: run periodic memory tasks (reflection, consolidation, retention)
    this.simulationStep++;
    if (this.memoryCtx) {
      try {
        const agentIds = this.sessionManager.listAgentIds();
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
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] runPeriodicTasks failed at step ${this.simulationStep}:`,
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
        world_id: session?.worldId,
        agent_id: agentId,
        is_observation: true,
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
      `[concordia] Event: step=${event.step} type=${event.type} agent=${event.acting_agent ?? "gm"}`,
    );

    if (!this.memoryCtx) return;

    // Wire: record social interactions between agents
    try {
      const knownAgentIds = this.sessionManager.listAgentIds();
      await recordSocialEvent(this.memoryCtx, event, knownAgentIds);
    } catch (err) {
      this.context.logger.warn?.("[concordia] recordSocialEvent failed:", err);
    }

    // Wire: update temporal edges in knowledge graph on contradicting events
    if (event.acting_agent) {
      try {
        await updateTemporalEdges(
          this.memoryCtx,
          event.acting_agent,
          event.content,
        );
      } catch (err) {
        this.context.logger.warn?.(
          "[concordia] updateTemporalEdges failed:", err,
        );
      }
    }

    // Wire: log simulation event to daily log transcript
    try {
      const agentSession = event.acting_agent
        ? this.sessionManager.get(event.acting_agent)
        : this.sessionManager.getAll()[0];
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
        "[concordia] logSimulationEvent failed:", err,
      );
    }
  }

  private async handleGetAgentState(
    agentId: string,
  ): Promise<AgentStateResponse | null> {
    const session = this.sessionManager.get(agentId);
    if (!session) return null;

    if (this.memoryCtx) {
      try {
        return await loadAgentState(
          this.memoryCtx,
          agentId,
          session.sessionId,
          session.turnCount,
          session.lastAction,
        ) as unknown as AgentStateResponse;
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] getAgentState failed for ${agentId}:`,
          err,
        );
      }
    }

    return {
      identity: {
        name: session.agentName,
        personality: "",
        learnedTraits: [],
        beliefs: {},
      },
      memoryCount: session.observations.length,
      recentMemories: session.observations.slice(-5).map((content) => ({
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

    const responsePromise = this.createPendingResponse(
      requestId,
      sessionId,
      "concordia-agent-generator",
      "",
      60_000,
      "[concordia] /generate-agents timed out after 60000ms",
    );

    const inbound: ChannelInboundMessage = {
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
        world_id: request.worldId ?? "generated-world",
      },
    };

    await this.context.on_message(inbound);
    const rawResponse = await responsePromise;
    const agents = this.parseGeneratedAgents(rawResponse);
    return { agents };
  }

  private async handleLaunch(
    request: LaunchRequest,
  ): Promise<Record<string, unknown>> {
    const defaults = resolveConcordiaLaunchDefaults(this.context);
    const launchRequest: LaunchRequest = {
      ...request,
      gm_provider: request.gm_provider ?? defaults.gm_provider,
      gm_model: request.gm_model ?? defaults.gm_model,
      gm_api_key: request.gm_api_key ?? defaults.gm_api_key,
      gm_base_url: request.gm_base_url ?? defaults.gm_base_url,
    };

    await stopSimulationRunner(this.simulationRunner);
    this.simulationRunner = null;

    this.simulationRunner = await launchSimulationRunner({
      request: launchRequest,
      config: this.context.config,
      logger: this.context.logger,
    });

    const launchedRunner = this.simulationRunner;
    launchedRunner.child.once("exit", (code, signal) => {
      this.context.logger.info?.(
        `[concordia] runner exited code=${String(code)} signal=${String(signal)}`,
      );
      if (this.simulationRunner === launchedRunner) {
        this.simulationRunner = null;
      }
    });

    return {
      world_id: launchRequest.world_id,
      pid: this.simulationRunner.child.pid ?? null,
      control_port: launchRequest.control_port ?? 3202,
      event_port: launchRequest.event_port ?? 3201,
    };
  }

  private createPendingResponse(
    requestId: string,
    sessionId: string,
    agentId: string | undefined,
    fallback: string,
    timeoutMs: number,
    timeoutLog: string,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        resolve(fallback);
        this.context.logger.warn?.(timeoutLog);
      }, timeoutMs);

      this.pendingResponses.set(requestId, {
        agentId,
        sessionId,
        resolve,
        timeout,
      });
    });
  }

  private clearPendingResponses(fallback: string): void {
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout);
      pending.resolve(fallback);
    }
    this.pendingResponses.clear();
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
