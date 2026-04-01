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
import type { ConcordiaChannelConfig, SetupRequest, EventNotification } from "./types.js";
import { SessionManager } from "./session-manager.js";
import { createBridgeServer } from "./bridge-http.js";
import type { Server } from "node:http";
import type { MemoryWiringContext } from "./memory-wiring.js";
import {
  setupAgentIdentity,
  ingestObservation,
  buildFullActContext,
  updateActivationScores,
  recordSocialEvent,
  updateTemporalEdges,
  logSimulationEvent,
  storePremise,
} from "./memory-wiring.js";
import { runPeriodicTasks, postSimulationCleanup } from "./memory-lifecycle.js";

// ============================================================================
// Pending request tracking
// ============================================================================

interface PendingActRequest {
  resolve: (action: string) => void;
  timeout: ReturnType<typeof setTimeout>;
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
  private pendingActs = new Map<string, PendingActRequest>();
  private healthy = false;

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
      onAct: (agentId, sessionId, message) =>
        this.handleAct(agentId, sessionId, message),
      onObserve: (agentId, sessionId, observation) =>
        this.handleObserve(agentId, sessionId, observation),
      onSetup: (request) => this.handleSetup(request),
      onEvent: (event) => this.handleEvent(event),
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

    // Clear all pending requests
    for (const [, pending] of this.pendingActs) {
      clearTimeout(pending.timeout);
      pending.resolve(""); // Resolve with empty to unblock
    }
    this.pendingActs.clear();

    // Close HTTP server
    if (this.bridgeServer) {
      await new Promise<void>((resolve) => {
        this.bridgeServer!.close(() => resolve());
      });
      this.bridgeServer = null;
    }

    this.memoryCtx = null;
    this.simulationStep = 0;
    this.context.logger.info?.("[concordia] Bridge server stopped");
  }

  /**
   * Called by the daemon when the ChatExecutor produces a response.
   * Routes the response to the pending /act request for the matching session.
   */
  async send(message: ChannelOutboundMessage): Promise<void> {
    // Skip partial streaming chunks — wait for the complete response
    if (message.is_partial) return;

    const session = this.sessionManager.findBySessionId(message.session_id);
    if (!session) {
      this.context.logger.warn?.(
        `[concordia] send() for unknown session: ${message.session_id}`,
      );
      return;
    }

    const pending = this.pendingActs.get(session.agentId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(message.content);
      this.pendingActs.delete(session.agentId);
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ==========================================================================
  // Memory context resolution
  // ==========================================================================

  /**
   * Attempt to resolve a MemoryWiringContext from the runtime peer dependency.
   * Memory wiring is optional — if the runtime modules are not available,
   * the adapter operates in passthrough mode.
   */
  private resolveMemoryContext(
    worldId: string,
    workspaceId: string,
  ): MemoryWiringContext | null {
    try {
      // The runtime provides these via the adapter context when available
      const ctx = this.context as unknown as Record<string, unknown>;
      const memoryBackend = ctx.memoryBackend as MemoryWiringContext["memoryBackend"] | undefined;
      const identityManager = ctx.identityManager as MemoryWiringContext["identityManager"] | undefined;
      const socialMemory = ctx.socialMemory as MemoryWiringContext["socialMemory"] | undefined;

      if (!memoryBackend || !identityManager || !socialMemory) {
        this.context.logger.debug?.(
          "[concordia] Memory backends not available on context — memory wiring disabled",
        );
        return null;
      }

      return {
        worldId,
        workspaceId,
        memoryBackend,
        identityManager,
        socialMemory,
        proceduralMemory: ctx.proceduralMemory as MemoryWiringContext["proceduralMemory"],
        graph: ctx.graph as MemoryWiringContext["graph"],
        sharedMemory: ctx.sharedMemory as MemoryWiringContext["sharedMemory"],
        traceLogger: ctx.traceLogger as MemoryWiringContext["traceLogger"],
        dailyLogManager: ctx.dailyLogManager as MemoryWiringContext["dailyLogManager"],
        encryptionKey: this.context.config.encryption_key,
      };
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Internal handlers
  // ==========================================================================

  private async handleSetup(
    request: SetupRequest,
  ): Promise<Record<string, string>> {
    const sessions: Record<string, string> = {};

    // Resolve memory wiring context for this simulation
    this.memoryCtx = this.resolveMemoryContext(
      request.world_id,
      request.workspace_id,
    );
    this.simulationStep = 0;

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

  private async handleAct(
    agentId: string,
    sessionId: string,
    message: string,
  ): Promise<string> {
    const session = this.sessionManager.get(agentId);
    if (!session) {
      return "Agent not found — cannot act.";
    }

    // Wire: build enriched context from memory (identity + procedural + KG + shared)
    let enrichedMessage = message;
    if (this.memoryCtx) {
      try {
        const memoryContext = await buildFullActContext(
          this.memoryCtx,
          agentId,
          sessionId,
          message,
        );
        if (memoryContext) {
          enrichedMessage = `${memoryContext}\n\n${message}`;
        }
      } catch (err) {
        this.context.logger.warn?.(
          `[concordia] buildFullActContext failed for ${agentId}:`, err,
        );
      }
    }

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
        world_id: session.worldId,
        workspace_id: session.workspaceId,
        concordia_turn: session.turnCount,
      },
    };

    // Create a promise that resolves when send() is called
    const actionPromise = new Promise<string>((resolve) => {
      const timeoutMs = 120_000;
      const timeout = setTimeout(() => {
        this.pendingActs.delete(agentId);
        resolve(`${session.agentName} hesitates and does nothing.`);
        this.context.logger.warn?.(
          `[concordia] /act timeout for ${session.agentName} after ${timeoutMs}ms`,
        );
      }, timeoutMs);

      this.pendingActs.set(agentId, { resolve, timeout });
    });

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
        world_id: this.sessionManager.get(agentId)?.worldId,
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
}
