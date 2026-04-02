import type {
  ConcordiaChannelConfig,
  ResumeRequest,
  SetupRequest,
} from "./types.js";
import type { ConcordiaCheckpointManifest } from "./checkpoint-manifest.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface PendingSendTargetShape<Handle, Pending> {
  readonly handle: Handle;
  readonly requestId: string;
  readonly pending: Pending;
  readonly usedSessionFallback: boolean;
}

export interface ResumeHandleParamsInput {
  readonly worldId: string;
  readonly workspaceId: string;
  readonly simulationId: string;
  readonly lineageId: string;
  readonly parentSimulationId: string | null;
  readonly userId?: string;
  readonly agents: SetupRequest["agents"];
  readonly premise: string;
  readonly config: Record<string, unknown>;
}

export interface ResumeHandleStateInput {
  readonly worldId: string;
  readonly workspaceId: string;
  readonly simulationId: string;
  readonly lineageId: string;
  readonly parentSimulationId: string | null;
  readonly request: ResumeRequest;
  readonly checkpoint: ConcordiaCheckpointManifest;
  readonly config: Record<string, unknown>;
  readonly agents: SetupRequest["agents"];
  readonly premise: string;
}

export function buildRequestIdLogMessage(
  prefix: string,
  payload: Record<string, unknown>,
): string {
  return `[concordia] send() ${prefix} ${JSON.stringify(payload)}`;
}

export function buildMissingRequestIdLogMessage(
  sessionId: string,
  pendingMatches: number,
  simulationId: string,
): string {
  return buildRequestIdLogMessage("missing request_id", {
    session_id: sessionId,
    pending_matches: pendingMatches,
    simulation_id: simulationId,
  });
}

export function buildIgnoredRequestIdLogMessage(sessionId: string): string {
  return buildRequestIdLogMessage(
    "ignored outbound message without request_id",
    { session_id: sessionId },
  );
}

export function buildUnknownRequestIdLogMessage(
  requestId: string,
  sessionId: string,
): string {
  return buildRequestIdLogMessage("for unknown request_id", {
    request_id: requestId,
    session_id: sessionId,
  });
}

export function buildPendingSendTarget<Handle, Pending>(
  handle: Handle,
  requestId: string,
  pending: Pending,
  usedSessionFallback: boolean,
): PendingSendTargetShape<Handle, Pending> {
  return {
    handle,
    requestId,
    pending,
    usedSessionFallback,
  };
}

export function buildPeriodicTaskIntervals(
  config: Pick<
    ConcordiaChannelConfig,
    "reflection_interval" | "consolidation_interval"
  >,
): {
  reflectionInterval: ConcordiaChannelConfig["reflection_interval"];
  consolidationInterval: ConcordiaChannelConfig["consolidation_interval"];
} {
  return {
    reflectionInterval: config.reflection_interval,
    consolidationInterval: config.consolidation_interval,
  };
}

export function buildResumeHandleParamsFromState(
  params: ResumeHandleStateInput,
): ResumeHandleParamsInput {
  return {
    worldId: params.worldId,
    workspaceId: params.workspaceId,
    simulationId: params.simulationId,
    lineageId: params.lineageId,
    parentSimulationId: params.parentSimulationId,
    userId:
      params.request.user_id ??
      asString(params.checkpoint.user_id) ??
      asString(params.config.user_id),
    agents: params.agents,
    premise: params.premise,
    config: params.config,
  };
}
