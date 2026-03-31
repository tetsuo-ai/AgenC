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
  // Internal handlers
  // ==========================================================================

  private async handleAct(
    agentId: string,
    sessionId: string,
    message: string,
  ): Promise<string> {
    const session = this.sessionManager.get(agentId);
    if (!session) {
      return "Agent not found — cannot act.";
    }

    // Create a ChannelInboundMessage and send through the daemon pipeline
    const inbound: ChannelInboundMessage = {
      id: randomUUID(),
      channel: "concordia",
      sender_id: agentId,
      sender_name: session.agentName,
      session_id: sessionId,
      scope: "dm",
      content: message,
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
    return actionPromise;
  }

  private async handleObserve(
    agentId: string,
    sessionId: string,
    observation: string,
  ): Promise<void> {
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

  private async handleSetup(
    request: SetupRequest,
  ): Promise<Record<string, string>> {
    const sessions: Record<string, string> = {};

    for (const agent of request.agents) {
      const session = this.sessionManager.getOrCreate({
        agentId: agent.agent_id,
        agentName: agent.agent_name,
        worldId: request.world_id,
        workspaceId: request.workspace_id,
      });
      sessions[agent.agent_id] = session.sessionId;

      this.context.logger.info?.(
        `[concordia] Agent setup: ${agent.agent_name} (${agent.agent_id}) -> ${session.sessionId}`,
      );
    }

    return sessions;
  }

  private async handleEvent(event: EventNotification): Promise<void> {
    // Event notifications from the Python engine (resolved events, scene changes)
    // are logged for observability. Social memory recording would go here if
    // the plugin has direct access to the memory modules.
    this.context.logger.debug?.(
      `[concordia] Event: step=${event.step} type=${event.type} agent=${event.acting_agent ?? "gm"}`,
    );
  }
}
