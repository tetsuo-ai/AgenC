/**
 * HTTP bridge server for the Concordia plugin.
 *
 * Receives POST requests from the Python ProxyEntity and routes them
 * through the AgenC daemon's ChannelAdapter pipeline.
 *
 * Uses only node:http — zero external dependencies.
 *
 * @module
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ChannelAdapterLogger } from "@tetsuo-ai/plugin-kit";
import type {
  ActRequest,
  ActResponse,
  ObserveRequest,
  SetupRequest,
  LaunchRequest,
  GenerateAgentsRequest,
  CheckpointRequest,
  ResumeRequest,
  EventNotification,
  AgentStateResponse,
  BridgeMetrics,
  SimulationRecord,
  SimulationSummary,
} from "./types.js";
import { createEmptyMetrics } from "./types.js";
import { buildActPrompt } from "./prompt-builder.js";
import { processResponse } from "./response-processor.js";
import type { SessionManager } from "./session-manager.js";
import { createSimulationIdentity, withSimulationIdentity } from "./simulation-identity.js";

// ============================================================================
// Types
// ============================================================================

export interface BridgeServerConfig {
  readonly port: number;
  readonly host: string;
  readonly logger: ChannelAdapterLogger;
  readonly sessionManager: SessionManager;
  readonly onAct: (
    agentId: string,
    sessionId: string,
    message: string,
    requestId: string,
  ) => Promise<string>;
  readonly onObserve: (agentId: string, sessionId: string, observation: string) => Promise<void>;
  readonly onSetup: (request: SetupRequest) => Promise<Record<string, string>>;
  readonly onReset?: () => Promise<void>;
  readonly onCheckpoint?: (request: CheckpointRequest) => Promise<Record<string, unknown>>;
  readonly onResume?: (request: ResumeRequest) => Promise<Record<string, unknown>>;
  readonly onLaunch?: (request: LaunchRequest) => Promise<Record<string, unknown>>;
  readonly onGenerateAgents?: (
    request: GenerateAgentsRequest,
    requestId: string,
  ) => Promise<{ agents: readonly { id: string; name: string; personality: string; goal: string }[] }>;
  readonly onEvent: (event: EventNotification) => Promise<void>;
  readonly getAgentState?: (agentId: string, simulationId?: string | null) => Promise<AgentStateResponse | null>;
  readonly listSimulations?: () => Promise<readonly SimulationSummary[]>;
  readonly getSimulation?: (simulationId: string) => Promise<SimulationRecord | null>;
}

// ============================================================================
// Bridge HTTP Server
// ============================================================================

export function createBridgeServer(config: BridgeServerConfig): Server {
  const { logger, sessionManager } = config;
  const metrics: BridgeMetrics = createEmptyMetrics();

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        sendEmpty(res, 204);
      } else if (req.method === "GET") {
        await handleGet(req, res, config, metrics);
      } else if (req.method === "POST") {
        await handlePost(req, res, config, metrics);
      } else {
        sendJson(res, 405, { error: "Method not allowed" });
      }
    } catch (err) {
      metrics.errors++;
      logger.error?.("Bridge HTTP error:", err);
      sendJson(res, 500, { error: String(err) });
    }
  });

  return server;
}

// ============================================================================
// GET handlers
// ============================================================================

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (path === "/health") {
    const simulations = config.listSimulations
      ? await config.listSimulations()
      : [];
    sendJson(res, 200, {
      status: "ok",
      active_sessions: config.sessionManager.size,
      active_simulations: simulations.filter((simulation) => (
        simulation.status === "launching" ||
        simulation.status === "running" ||
        simulation.status === "paused" ||
        simulation.status === "stopping"
      )).length,
      uptime_ms: Date.now() - metrics.startedAt,
    });
    return;
  }

  if (path === "/metrics") {
    const avgLatency =
      metrics.actLatencyMs.length > 0
        ? Math.round(
            metrics.actLatencyMs.reduce((a, b) => a + b, 0) /
              metrics.actLatencyMs.length,
          )
        : 0;
    sendJson(res, 200, {
      act_requests: metrics.actRequests,
      observe_requests: metrics.observeRequests,
      setup_requests: metrics.setupRequests,
      event_notifications: metrics.eventNotifications,
      errors: metrics.errors,
      avg_act_latency_ms: avgLatency,
      active_sessions: config.sessionManager.size,
      uptime_ms: Date.now() - metrics.startedAt,
    });
    return;
  }

  if (path === "/simulations" && config.listSimulations) {
    const simulations = await config.listSimulations();
    sendJson(res, 200, { simulations });
    return;
  }

  const simulationMatch = path.match(/^\/simulations\/([^/]+)$/);
  if (simulationMatch && config.getSimulation) {
    const simulationId = decodeURIComponent(simulationMatch[1]);
    const simulation = await config.getSimulation(simulationId);
    if (!simulation) {
      sendJson(res, 404, { error: `Simulation ${simulationId} not found` });
    } else {
      sendJson(res, 200, simulation);
    }
    return;
  }

  // GET /agent/:id/state
  const agentStateMatch = path.match(/^\/agent\/([^/]+)\/state$/);
  if (agentStateMatch && config.getAgentState) {
    const agentId = decodeURIComponent(agentStateMatch[1]);
    const simulationId = url.searchParams.get("simulation_id");
    const state = await config.getAgentState(agentId, simulationId);
    if (state) {
      sendJson(res, 200, state);
    } else {
      sendJson(res, 404, { error: `Agent ${agentId} not found` });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

// ============================================================================
// POST handlers
// ============================================================================

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<void> {
  const path = req.url ?? "/";
  const body = await readJsonBody(req);

  switch (path) {
    case "/act":
      await handleAct(body as ActRequest, res, config, metrics);
      break;
    case "/observe":
      await handleObserve(body as ObserveRequest, res, config, metrics);
      break;
    case "/setup":
      await handleSetup(body as SetupRequest, res, config, metrics);
      break;
    case "/launch":
      await handleLaunch(body as LaunchRequest, res, config);
      break;
    case "/checkpoint":
      await handleCheckpoint(body as CheckpointRequest, res, config);
      break;
    case "/resume":
      await handleResume(body as ResumeRequest, res, config);
      break;
    case "/generate-agents":
      await handleGenerateAgents(body as GenerateAgentsRequest, res, config);
      break;
    case "/event":
      await handleEvent(body as EventNotification, res, config, metrics);
      break;
    case "/reset":
      if (config.onReset) {
        await config.onReset();
      } else {
        config.sessionManager.clear();
      }
      sendJson(res, 200, { status: "ok" });
      break;
    default:
      sendJson(res, 404, { error: "Not found" });
  }
}

async function handleAct(
  request: ActRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<void> {
  metrics.actRequests++;
  const start = Date.now();

  const identity = requireSimulationIdentity(request);

  const session = config.sessionManager.getOrCreate({
    agentId: request.agent_id,
    agentName: request.agent_name,
    worldId: request.world_id,
    workspaceId: request.workspace_id,
    simulationId: identity.simulationId!,
    lineageId: identity.lineageId,
    parentSimulationId: identity.parentSimulationId,
  });

  // Build the prompt from the ActionSpec
  const message = buildActPrompt(request.action_spec, request.agent_name);
  const requestId = randomUUID();

  // Route through the daemon pipeline via the onAct callback
  const rawResponse = await config.onAct(
    request.agent_id,
    session.sessionId,
    message,
    requestId,
  );

  // Post-process: strip name prefix, enforce choice constraints, parse floats
  const action = processResponse(rawResponse, request.agent_name, request.action_spec);
  session.lastAction = action;

  const elapsed = Date.now() - start;
  metrics.actLatencyMs.push(elapsed);
  // Keep only last 100 latency samples
  if (metrics.actLatencyMs.length > 100) {
    metrics.actLatencyMs.shift();
  }

  config.logger.debug?.(
    `[concordia] /act ${request.agent_name} (${elapsed}ms): ${action.slice(0, 80)}`,
  );

  const response: ActResponse = { action };
  sendJson(res, 200, response);
}

async function handleObserve(
  request: ObserveRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<void> {
  metrics.observeRequests++;

  const identity = requireSimulationIdentity(request);

  const session = config.sessionManager.getOrCreate({
    agentId: request.agent_id,
    agentName: request.agent_name,
    worldId: request.world_id,
    workspaceId: request.workspace_id,
    simulationId: identity.simulationId!,
    lineageId: identity.lineageId,
    parentSimulationId: identity.parentSimulationId,
  });

  // Buffer observation for context
  session.observations.push(request.observation);
  // Keep only last 20 observations in buffer
  if (session.observations.length > 20) {
    session.observations.shift();
  }

  // Route to the onObserve callback for memory ingestion
  await config.onObserve(request.agent_id, session.sessionId, request.observation);

  config.logger.debug?.(
    `[concordia] /observe ${request.agent_name}: ${request.observation.slice(0, 80)}`,
  );

  sendJson(res, 200, { status: "ok" });
}

async function handleSetup(
  request: SetupRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<void> {
  metrics.setupRequests++;

  const identity = requireSimulationIdentity(request);

  const sessions = await config.onSetup(request);

  config.logger.info?.(
    `[concordia] /setup world=${request.world_id} simulation=${request.simulation_id} agents=${request.agents.length}`,
  );

  sendJson(res, 200, withSimulationIdentity({
    status: "ok",
    sessions,
  }, identity));
}

async function handleEvent(
  event: EventNotification,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<void> {
  metrics.eventNotifications++;

  requireSimulationIdentity(event);
  requireStringField(event.workspace_id, "workspace_id");

  await config.onEvent(event);

  config.logger.debug?.(
    `[concordia] /event simulation=${event.simulation_id} step=${event.step} type=${event.type}: ${event.content.slice(0, 80)}`,
  );

  sendJson(res, 200, { status: "ok" });
}

async function handleLaunch(
  request: LaunchRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<void> {
  if (!config.onLaunch) {
    sendJson(res, 404, { error: "Launch not supported" });
    return;
  }

  const result = await config.onLaunch(request);
  sendJson(res, 200, { status: "ok", ...result });
}

async function handleCheckpoint(
  request: CheckpointRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<void> {
  if (!config.onCheckpoint) {
    sendJson(res, 404, { error: "Checkpoint not supported" });
    return;
  }

  requireSimulationIdentity(request);

  const result = await config.onCheckpoint(request);
  sendJson(res, 200, { status: "ok", ...result });
}

async function handleResume(
  request: ResumeRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<void> {
  if (!config.onResume) {
    sendJson(res, 404, { error: "Resume not supported" });
    return;
  }

  const result = await config.onResume(request);
  sendJson(res, 200, { status: "ok", ...result });
}

async function handleGenerateAgents(
  request: GenerateAgentsRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<void> {
  if (!config.onGenerateAgents) {
    sendJson(res, 404, { error: "Agent generation not supported" });
    return;
  }

  const requestId = randomUUID();
  const result = await config.onGenerateAgents(request, requestId);
  sendJson(res, 200, result);
}

// ============================================================================
// Helpers
// ============================================================================

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendEmpty(res: ServerResponse, status: number): void {
  setCorsHeaders(res);
  res.writeHead(status);
  res.end();
}

function requireSimulationIdentity(value: { simulation_id?: unknown; lineage_id?: unknown; parent_simulation_id?: unknown; }) {
  return createSimulationIdentity({
    simulationId: requireStringField(value.simulation_id, "simulation_id"),
    lineageId: typeof value.lineage_id === "string" ? value.lineage_id : null,
    parentSimulationId:
      typeof value.parent_simulation_id === "string"
        ? value.parent_simulation_id
        : null,
  });
}

function requireStringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required field: ${field}`);
  }
  return value;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  setCorsHeaders(res);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err}`));
      }
    });
    req.on("error", reject);
  });
}
