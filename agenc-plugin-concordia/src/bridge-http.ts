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
  SimulationCommand,
  ObserveRequest,
  SetupRequest,
  LaunchRequest,
  GenerateAgentsRequest,
  CheckpointRequest,
  ResumeRequest,
  EventNotification,
  AgentStateResponse,
  BridgeMetrics,
  ConcordiaOperationalMetrics,
  SimulationEventsResponse,
  SimulationRecord,
  SimulationReplayEvent,
  SimulationStatusResponse,
  SimulationSummary,
  SimulationWorldStateResponse,
  WorldProjection,
} from "./types.js";
import { createEmptyMetrics } from "./types.js";
import { ConcordiaAdmissionError } from "./operations.js";
import { buildActPrompt } from "./prompt-builder.js";
import { processStructuredResponse } from "./response-processor.js";
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
  readonly onActResult?: (result: {
    readonly request: ActRequest;
    readonly sessionId: string;
    readonly action: string;
    readonly narration: string | null;
    readonly intent: ActResponse["intent"];
  }) => Promise<void> | void;
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
  readonly getWorldProjection?: (simulationId: string, agentId: string) => Promise<WorldProjection | null>;
  readonly getSimulationWorldState?: (simulationId: string) => Promise<SimulationWorldStateResponse | null>;
  readonly getCurrentSimulationId?: () => Promise<string | null> | string | null;
  readonly listSimulations?: () => Promise<readonly SimulationSummary[]>;
  readonly getSimulation?: (simulationId: string) => Promise<SimulationRecord | null>;
  readonly getSimulationStatus?: (simulationId: string) => Promise<SimulationStatusResponse | null>;
  readonly controlSimulation?: (
    simulationId: string,
    command: SimulationCommand,
  ) => Promise<SimulationStatusResponse | null>;
  readonly listSimulationEvents?: (
    simulationId: string,
    cursor?: string | null,
  ) => Promise<SimulationEventsResponse | null>;
  readonly getOperationalMetrics?: (
    metrics: BridgeMetrics,
  ) => Promise<ConcordiaOperationalMetrics> | ConcordiaOperationalMetrics;
  readonly openSimulationEventStream?: (
    simulationId: string,
    cursor: string | null,
    subscriber: (event: SimulationReplayEvent) => void,
  ) => Promise<{
    history: readonly SimulationReplayEvent[];
    unsubscribe: () => void;
  } | null>;
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
        sendEmpty(res, HTTP_NO_CONTENT);
      } else if (req.method === "GET") {
        await handleGet(req, res, config, metrics);
      } else if (req.method === "POST") {
        await handlePost(req, res, config, metrics);
      } else {
        sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: "Method not allowed" });
      }
    } catch (err) {
      metrics.errors++;
      logger.error?.("Bridge HTTP error:", err);
      sendJson(res, HTTP_INTERNAL_SERVER_ERROR, { error: String(err) });
    }
  });

  return server;
}

// ============================================================================
// GET handlers
// ============================================================================

const ACTIVE_SIMULATION_HEALTH_STATUSES = new Set([
  "launching",
  "running",
  "paused",
  "stopping",
]);

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MAX_ACT_LATENCY_SAMPLES = 100;
const MAX_OBSERVATION_BUFFER = 20;
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (await handleOperationalGet(path, res, config, metrics)) {
    return;
  }

  if (await handleSimulationResourceGet(req, res, config, url, path)) {
    return;
  }

  if (await handleLegacyGet(url, path, res, config)) {
    return;
  }

  sendJson(res, HTTP_NOT_FOUND, { error: "Not found" });
}

async function handleOperationalGet(
  path: string,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<boolean> {
  if (path === "/health") {
    sendJson(res, HTTP_OK, await buildHealthPayload(config, metrics));
    return true;
  }

  if (path === "/metrics") {
    sendJson(res, HTTP_OK, await buildMetricsPayload(config, metrics));
    return true;
  }

  if (path === "/simulations" && config.listSimulations) {
    const simulations = await config.listSimulations();
    sendJson(res, HTTP_OK, { simulations });
    return true;
  }

  return false;
}

async function buildHealthPayload(
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<Record<string, unknown>> {
  const simulations = config.listSimulations
    ? await config.listSimulations()
    : [];

  const operational = config.getOperationalMetrics
    ? await config.getOperationalMetrics(metrics)
    : null;
  const activeSimulations = simulations.filter((simulation) =>
    ACTIVE_SIMULATION_HEALTH_STATUSES.has(simulation.status),
  ).length;
  const degraded = operational
    ? operational.stuck_simulations > 0 ||
      operational.active_simulations >= operational.max_concurrent_simulations
    : false;

  return {
    status: degraded ? "degraded" : "ok",
    active_sessions: config.sessionManager.size,
    active_simulations: activeSimulations,
    uptime_ms: Date.now() - metrics.startedAt,
    ...(operational ? { operations: operational } : {}),
  };
}

async function buildMetricsPayload(
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<Record<string, unknown>> {
  const avgLatency =
    metrics.actLatencyMs.length > 0
      ? Math.round(
          metrics.actLatencyMs.reduce((a, b) => a + b, 0) /
            metrics.actLatencyMs.length,
        )
      : 0;

  const operational = config.getOperationalMetrics
    ? await config.getOperationalMetrics(metrics)
    : null;

  return {
    act_requests: metrics.actRequests,
    observe_requests: metrics.observeRequests,
    setup_requests: metrics.setupRequests,
    launch_requests: metrics.launchRequests,
    rejected_launches: metrics.rejectedLaunches,
    event_notifications: metrics.eventNotifications,
    errors: metrics.errors,
    avg_act_latency_ms: avgLatency,
    active_sessions: config.sessionManager.size,
    uptime_ms: Date.now() - metrics.startedAt,
    ...(operational ? { operations: operational } : {}),
  };
}

async function handleSimulationResourceGet(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeServerConfig,
  url: URL,
  path: string,
): Promise<boolean> {
  const cursor = getReplayCursor(url, req);

  return (
    (await handleSimulationEventStreamGet(req, res, config, path, cursor)) ||
    (await handleSimulationEventsGet(res, config, path, cursor)) ||
    (await handleSimulationWorldStateGet(res, config, path)) ||
    (await handleSimulationStatusGet(res, config, path)) ||
    (await handleScopedAgentStateGet(res, config, path)) ||
    (await handleSimulationRecordGet(res, config, path))
  );
}

async function handleSimulationEventStreamGet(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeServerConfig,
  path: string,
  cursor: string | null,
): Promise<boolean> {
  const match = path.match(/^\/simulations\/([^/]+)\/events\/stream$/);
  if (!match || !config.openSimulationEventStream) {
    return false;
  }

  await handleSimulationEventStream(req, res, config, decodeURIComponent(match[1]), cursor);
  return true;
}

async function handleSimulationEventsGet(
  res: ServerResponse,
  config: BridgeServerConfig,
  path: string,
  cursor: string | null,
): Promise<boolean> {
  const match = path.match(/^\/simulations\/([^/]+)\/events$/);
  if (!match || !config.listSimulationEvents) {
    return false;
  }

  const simulationId = decodeURIComponent(match[1]);
  const events = await config.listSimulationEvents(simulationId, cursor);
  return sendSimulationLookup(res, simulationId, events);
}

async function handleSimulationWorldStateGet(
  res: ServerResponse,
  config: BridgeServerConfig,
  path: string,
): Promise<boolean> {
  const match = path.match(/^\/simulations\/([^/]+)\/world-state$/);
  if (!match || !config.getSimulationWorldState) {
    return false;
  }

  const simulationId = decodeURIComponent(match[1]);
  const worldState = await config.getSimulationWorldState(simulationId);
  return sendSimulationLookup(res, simulationId, worldState);
}

async function handleSimulationStatusGet(
  res: ServerResponse,
  config: BridgeServerConfig,
  path: string,
): Promise<boolean> {
  const match = path.match(/^\/simulations\/([^/]+)\/status$/);
  if (!match || !config.getSimulationStatus) {
    return false;
  }

  const simulationId = decodeURIComponent(match[1]);
  const status = await config.getSimulationStatus(simulationId);
  return sendSimulationLookup(res, simulationId, status);
}

async function handleScopedAgentStateGet(
  res: ServerResponse,
  config: BridgeServerConfig,
  path: string,
): Promise<boolean> {
  const match = path.match(/^\/simulations\/([^/]+)\/agents\/([^/]+)\/state$/);
  if (!match || !config.getAgentState) {
    return false;
  }

  const simulationId = decodeURIComponent(match[1]);
  const agentId = decodeURIComponent(match[2]);
  const state = await config.getAgentState(agentId, simulationId);
  if (!state) {
    sendJson(res, HTTP_NOT_FOUND, { error: `Agent ${agentId} not found in simulation ${simulationId}` });
    return true;
  }

  sendJson(res, HTTP_OK, state);
  return true;
}

async function handleSimulationRecordGet(
  res: ServerResponse,
  config: BridgeServerConfig,
  path: string,
): Promise<boolean> {
  const match = path.match(/^\/simulations\/([^/]+)$/);
  if (!match || !config.getSimulation) {
    return false;
  }

  const simulationId = decodeURIComponent(match[1]);
  const simulation = await config.getSimulation(simulationId);
  return sendSimulationLookup(res, simulationId, simulation);
}

async function handleLegacyGet(
  url: URL,
  path: string,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<boolean> {
  return (
    (await handleLegacySimulationStatusGet(res, config, path)) ||
    (await handleLegacyAgentStateGet(url, res, config, path))
  );
}

async function handleLegacySimulationStatusGet(
  res: ServerResponse,
  config: BridgeServerConfig,
  path: string,
): Promise<boolean> {
  if (path !== "/simulation/status" || !config.getSimulationStatus) {
    return false;
  }

  const simulationId = await resolveCurrentSimulationId(config);
  if (!simulationId) {
    sendJson(res, HTTP_NOT_FOUND, { error: "No active simulation" });
    return true;
  }

  const status = await config.getSimulationStatus(simulationId);
  return sendSimulationLookup(res, simulationId, status);
}

async function handleLegacyAgentStateGet(
  url: URL,
  res: ServerResponse,
  config: BridgeServerConfig,
  path: string,
): Promise<boolean> {
  const match = path.match(/^\/agent\/([^/]+)\/state$/);
  if (!match || !config.getAgentState) {
    return false;
  }

  const agentId = decodeURIComponent(match[1]);
  const simulationId =
    url.searchParams.get("simulation_id") ??
    (await resolveCurrentSimulationId(config));
  const state = await config.getAgentState(agentId, simulationId);
  if (!state) {
    sendJson(res, HTTP_NOT_FOUND, { error: `Agent ${agentId} not found` });
    return true;
  }

  sendJson(res, HTTP_OK, state);
  return true;
}

function sendSimulationLookup(
  res: ServerResponse,
  simulationId: string,
  value: unknown,
): boolean {
  if (!value) {
    sendJson(res, HTTP_NOT_FOUND, { error: `Simulation ${simulationId} not found` });
    return true;
  }

  sendJson(res, HTTP_OK, value);
  return true;
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
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const body = await readJsonBody(req);

  if (await handleSimulationControlPost(path, res, config)) {
    return;
  }

  if (await handleLegacySimulationControlPost(path, res, config)) {
    return;
  }

  await dispatchPostRequest(path, body, res, config, metrics);
}

async function handleSimulationControlPost(
  path: string,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<boolean> {
  const match = path.match(/^\/simulations\/([^/]+)\/(play|pause|step|stop)$/);
  if (!match || !config.controlSimulation) {
    return false;
  }

  const simulationId = decodeURIComponent(match[1]);
  const command = match[2] as SimulationCommand;
  const status = await config.controlSimulation(simulationId, command);
  sendSimulationControlResponse(res, simulationId, status);
  return true;
}

async function handleLegacySimulationControlPost(
  path: string,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<boolean> {
  const match = path.match(/^\/simulation\/(play|pause|step|stop)$/);
  if (!match || !config.controlSimulation) {
    return false;
  }

  const simulationId = await resolveCurrentSimulationId(config);
  if (!simulationId) {
    sendJson(res, HTTP_NOT_FOUND, { error: "No active simulation" });
    return true;
  }

  const command = match[1] as SimulationCommand;
  const status = await config.controlSimulation(simulationId, command);
  sendSimulationControlResponse(res, simulationId, status);
  return true;
}

function sendSimulationControlResponse(
  res: ServerResponse,
  simulationId: string,
  status: SimulationStatusResponse | null,
): void {
  if (!status) {
    sendJson(res, HTTP_NOT_FOUND, { error: `Simulation ${simulationId} not found` });
    return;
  }

  sendJson(res, HTTP_OK, { status: "ok", simulation: status });
}

async function dispatchPostRequest(
  path: string,
  body: unknown,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<void> {
  switch (path) {
    case "/act":
      await handleAct(body as ActRequest, res, config, metrics);
      return;
    case "/observe":
      await handleObserve(body as ObserveRequest, res, config, metrics);
      return;
    case "/setup":
      await handleSetup(body as SetupRequest, res, config, metrics);
      return;
    case "/simulations":
    case "/launch":
      await handleLaunch(body as LaunchRequest, res, config, metrics);
      return;
    case "/checkpoint":
      await handleCheckpoint(body as CheckpointRequest, res, config);
      return;
    case "/resume":
      await handleResume(body as ResumeRequest, res, config);
      return;
    case "/generate-agents":
      await handleGenerateAgents(body as GenerateAgentsRequest, res, config);
      return;
    case "/event":
      await handleEvent(body as EventNotification, res, config, metrics);
      return;
    case "/reset":
      await handleReset(res, config);
      return;
    default:
      sendJson(res, HTTP_NOT_FOUND, { error: "Not found" });
  }
}

async function handleReset(
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<void> {
  if (config.onReset) {
    await config.onReset();
  } else {
    config.sessionManager.clear();
  }

  sendJson(res, HTTP_OK, { status: "ok" });
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
  const session = getOrCreateSimulationSession(config, request, identity);
  const worldProjection = await resolveActWorldProjection(request, identity.simulationId, config);
  const response = await executeActRequest(request, session.sessionId, worldProjection, config);

  session.lastAction = response.action;
  recordActLatency(metrics, start);
  logActResponse(config, request.agent_name, response.action, start);

  sendJson(res, HTTP_OK, response);
}

function getOrCreateSimulationSession(
  config: BridgeServerConfig,
  request: ActRequest | ObserveRequest,
  identity: ReturnType<typeof requireSimulationIdentity>,
) {
  return config.sessionManager.getOrCreate({
    agentId: request.agent_id,
    agentName: request.agent_name,
    worldId: request.world_id,
    workspaceId: request.workspace_id,
    simulationId: identity.simulationId!,
    lineageId: identity.lineageId,
    parentSimulationId: identity.parentSimulationId,
  });
}

async function resolveActWorldProjection(
  request: ActRequest,
  simulationId: string | null,
  config: BridgeServerConfig,
): Promise<WorldProjection | null> {
  if (request.world_projection) {
    return request.world_projection;
  }
  if (!simulationId || !config.getWorldProjection) {
    return null;
  }
  return await config.getWorldProjection(simulationId, request.agent_id);
}

async function executeActRequest(
  request: ActRequest,
  sessionId: string,
  worldProjection: WorldProjection | null,
  config: BridgeServerConfig,
): Promise<ActResponse> {
  const message = buildActPrompt(request.action_spec, request.agent_name, worldProjection);
  const requestId = randomUUID();
  const rawResponse = await config.onAct(
    request.agent_id,
    sessionId,
    message,
    requestId,
  );
  const processed = processStructuredResponse(rawResponse, request.agent_name, request.action_spec);
  const response: ActResponse = {
    action: processed.action,
    narration: processed.narration ?? null,
    intent: processed.intent ?? null,
  };

  if (config.onActResult) {
    await config.onActResult({
      request: {
        ...request,
        world_projection: worldProjection ?? request.world_projection ?? null,
      },
      sessionId,
      action: response.action,
      narration: response.narration ?? null,
      intent: response.intent ?? null,
    });
  }

  return response;
}

function recordActLatency(metrics: BridgeMetrics, start: number): void {
  const elapsed = Date.now() - start;
  metrics.actLatencyMs.push(elapsed);
  if (metrics.actLatencyMs.length > MAX_ACT_LATENCY_SAMPLES) {
    metrics.actLatencyMs.shift();
  }
}

function logActResponse(
  config: BridgeServerConfig,
  agentName: string,
  action: string,
  start: number,
): void {
  const elapsed = Date.now() - start;
  config.logger.debug?.(
    `[concordia] /act ${agentName} (${elapsed}ms): ${action.slice(0, 80)}`,
  );
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
  if (session.observations.length > MAX_OBSERVATION_BUFFER) {
    session.observations.shift();
  }

  // Route to the onObserve callback for memory ingestion
  await config.onObserve(request.agent_id, session.sessionId, request.observation);

  config.logger.debug?.(
    `[concordia] /observe ${request.agent_name}: ${request.observation.slice(0, 80)}`,
  );

  sendJson(res, HTTP_OK, { status: "ok" });
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

  sendJson(res, HTTP_OK, withSimulationIdentity({
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
    `[concordia] /event simulation=${event.simulation_id} step=${event.step} type=${event.type}: ${(event.resolved_event ?? event.content ?? "").slice(0, 80)}`,
  );

  sendJson(res, HTTP_OK, { status: "ok" });
}

async function handleLaunch(
  request: LaunchRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
  metrics: BridgeMetrics,
): Promise<void> {
  if (!config.onLaunch) {
    sendJson(res, HTTP_NOT_FOUND, { error: "Launch not supported" });
    return;
  }

  metrics.launchRequests += 1;

  try {
    const result = await config.onLaunch(request);
    sendJson(res, HTTP_OK, { status: "ok", ...result });
  } catch (error) {
    if (error instanceof ConcordiaAdmissionError) {
      metrics.rejectedLaunches += 1;
      sendJson(res, HTTP_SERVICE_UNAVAILABLE, {
        error: error.message,
        code: error.code,
        active: error.active,
        limit: error.limit,
      });
      return;
    }
    throw error;
  }
}

async function handleCheckpoint(
  request: CheckpointRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<void> {
  if (!config.onCheckpoint) {
    sendJson(res, HTTP_NOT_FOUND, { error: "Checkpoint not supported" });
    return;
  }

  requireSimulationIdentity(request);

  const result = await config.onCheckpoint(request);
  sendJson(res, HTTP_OK, { status: "ok", ...result });
}

async function handleResume(
  request: ResumeRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<void> {
  if (!config.onResume) {
    sendJson(res, HTTP_NOT_FOUND, { error: "Resume not supported" });
    return;
  }

  const result = await config.onResume(request);
  sendJson(res, HTTP_OK, { status: "ok", ...result });
}

async function handleGenerateAgents(
  request: GenerateAgentsRequest,
  res: ServerResponse,
  config: BridgeServerConfig,
): Promise<void> {
  if (!config.onGenerateAgents) {
    sendJson(res, HTTP_NOT_FOUND, { error: "Agent generation not supported" });
    return;
  }

  const requestId = randomUUID();
  const result = await config.onGenerateAgents(request, requestId);
  sendJson(res, HTTP_OK, result);
}

type SimulationEventStream = {
  history: readonly SimulationReplayEvent[];
  unsubscribe: () => void;
};

async function handleSimulationEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeServerConfig,
  simulationId: string,
  cursor: string | null,
): Promise<void> {
  const stream = await openSimulationEventStream(config, simulationId, cursor, res);
  if (!stream) {
    return;
  }

  initializeSimulationSseResponse(res, simulationId, stream.history);
  attachSimulationSseLifecycle(req, res, stream);
}

async function openSimulationEventStream(
  config: BridgeServerConfig,
  simulationId: string,
  cursor: string | null,
  res: ServerResponse,
): Promise<SimulationEventStream | null> {
  if (!config.openSimulationEventStream) {
    sendJson(res, HTTP_NOT_FOUND, { error: "Simulation event streaming not supported" });
    return null;
  }

  const stream = await config.openSimulationEventStream(
    simulationId,
    cursor,
    (event) => {
      if (!res.writableEnded) {
        writeSseEvent(res, event);
      }
    },
  );
  if (!stream) {
    sendJson(res, HTTP_NOT_FOUND, { error: `Simulation ${simulationId} not found` });
    return null;
  }

  return stream;
}

function initializeSimulationSseResponse(
  res: ServerResponse,
  simulationId: string,
  history: readonly SimulationReplayEvent[],
): void {
  setCorsHeaders(res);
  res.writeHead(HTTP_OK, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  for (const event of history) {
    writeSseEvent(res, event);
  }
  res.write(`: ready ${simulationId}\n\n`);
}

function attachSimulationSseLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  stream: SimulationEventStream,
): void {
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    stream.unsubscribe();
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
}

// ============================================================================
// Helpers
// ============================================================================

function writeSseEvent(
  res: ServerResponse,
  event: SimulationReplayEvent,
): void {
  const payload = JSON.stringify(event);
  res.write(`id: ${event.event_id}\ndata: ${payload}\n\n`);
}

function getReplayCursor(
  url: URL,
  req: IncomingMessage,
): string | null {
  const fromQuery = url.searchParams.get("cursor");
  if (fromQuery) {
    return fromQuery;
  }
  const fromHeader = req.headers["last-event-id"];
  if (Array.isArray(fromHeader)) {
    return fromHeader[0] ?? null;
  }
  return typeof fromHeader === "string" && fromHeader.length > 0
    ? fromHeader
    : null;
}

async function resolveCurrentSimulationId(
  config: BridgeServerConfig,
): Promise<string | null> {
  if (!config.getCurrentSimulationId) {
    return null;
  }
  return await config.getCurrentSimulationId();
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Last-Event-ID");
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
