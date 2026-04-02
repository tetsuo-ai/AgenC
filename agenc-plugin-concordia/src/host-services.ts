import type { ChannelAdapterContext } from "@tetsuo-ai/plugin-kit";
import type { ConcordiaChannelConfig } from "./types.js";
import {
  buildConcordiaMemoryNamespaces,
  type ConcordiaCarryOverPolicy,
  type ConcordiaCheckpointMetadata,
  type ConcordiaMemoryContinuityMode,
} from "./memory-namespaces.js";
import type {
  DailyLogManagerLike,
  IdentityManagerLike,
  MemoryBackendLike,
  MemoryGraphLike,
  MemoryIngestionEngineLike,
  MemoryLifecycleLike,
  MemoryRetrieverLike,
  MemoryWiringContext,
  ProceduralMemoryLike,
  SharedMemoryLike,
  SocialMemoryLike,
  TraceLoggerLike,
} from "./memory-wiring.js";

interface ConcordiaMemoryWorldServices {
  readonly memoryBackend: MemoryBackendLike;
  readonly identityManager: IdentityManagerLike;
  readonly socialMemory: SocialMemoryLike;
  readonly proceduralMemory?: ProceduralMemoryLike;
  readonly graph?: MemoryGraphLike;
  readonly sharedMemory?: SharedMemoryLike;
  readonly traceLogger?: TraceLoggerLike;
  readonly dailyLogManager?: DailyLogManagerLike;
  readonly ingestionEngine?: MemoryIngestionEngineLike;
  readonly retriever?: MemoryRetrieverLike;
  readonly lifecycle?: MemoryLifecycleLike;
  readonly vectorDbPath?: string;
}

interface ConcordiaMemoryResolverHostServices {
  readonly resolveWorldContext: (input: {
    worldId: string;
    workspaceId: string;
    simulationId?: string;
    lineageId?: string | null;
    parentSimulationId?: string | null;
    effectiveStorageKey?: string;
    logStorageKey?: string;
    scopedWorkspaceId?: string;
    continuityMode?: ConcordiaMemoryContinuityMode;
    checkpointMetadata?: ConcordiaCheckpointMetadata | null;
  }) => Promise<ConcordiaMemoryWorldServices>;
}

interface ConcordiaRuntimeHostServices {
  readonly llm?: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly model?: string;
    readonly baseUrl?: string;
  };
  readonly defaults?: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly model?: string;
    readonly baseUrl?: string;
  };
}

function buildMemoryWiringContext(
  context: ChannelAdapterContext<ConcordiaChannelConfig>,
  resolved: ConcordiaMemoryWorldServices,
  base: {
    worldId: string;
    workspaceId: string;
    simulationId?: string;
    lineageId?: string | null;
    parentSimulationId?: string | null;
    effectiveStorageKey: string;
    continuityMode: ConcordiaMemoryContinuityMode;
    carryOverPolicy: ConcordiaCarryOverPolicy;
    namespaces: ReturnType<typeof buildConcordiaMemoryNamespaces>["namespaces"];
    checkpointMetadata?: ConcordiaCheckpointMetadata | null;
  },
): MemoryWiringContext {
  return {
    worldId: base.worldId,
    workspaceId: base.workspaceId,
    simulationId: base.simulationId,
    lineageId: base.lineageId ?? null,
    parentSimulationId: base.parentSimulationId ?? null,
    effectiveStorageKey: base.effectiveStorageKey,
    continuityMode: base.continuityMode,
    carryOverPolicy: base.carryOverPolicy,
    namespaces: base.namespaces,
    checkpointMetadata: base.checkpointMetadata ?? null,
    memoryBackend: resolved.memoryBackend,
    identityManager: resolved.identityManager,
    socialMemory: resolved.socialMemory,
    proceduralMemory: resolved.proceduralMemory,
    graph: resolved.graph,
    sharedMemory: resolved.sharedMemory,
    traceLogger: resolved.traceLogger,
    dailyLogManager: resolved.dailyLogManager,
    ingestionEngine: resolved.ingestionEngine,
    retriever: resolved.retriever,
    lifecycle: resolved.lifecycle,
    encryptionKey: context.config.encryption_key,
    vectorDbPath: resolved.vectorDbPath,
  };
}

function isConcordiaMemoryWorldServices(
  value: unknown,
): value is ConcordiaMemoryWorldServices {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.memoryBackend === "object" &&
    candidate.memoryBackend !== null &&
    typeof candidate.identityManager === "object" &&
    candidate.identityManager !== null &&
    typeof candidate.socialMemory === "object" &&
    candidate.socialMemory !== null
  );
}

function isConcordiaMemoryResolverHostServices(
  value: unknown,
): value is ConcordiaMemoryResolverHostServices {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.resolveWorldContext === "function";
}

function isConcordiaRuntimeHostServices(
  value: unknown,
): value is ConcordiaRuntimeHostServices {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!("llm" in candidate) && !("defaults" in candidate)) {
    return false;
  }
  for (const key of ["llm", "defaults"] as const) {
    const section = candidate[key];
    if (section !== undefined && (typeof section !== "object" || section === null)) {
      return false;
    }
  }
  return true;
}

export async function resolveConcordiaMemoryContext(
  context: ChannelAdapterContext<ConcordiaChannelConfig>,
  worldId: string,
  workspaceId: string,
  identity: {
    simulationId?: string;
    lineageId?: string | null;
    parentSimulationId?: string | null;
  } = {},
  options: {
    continuityMode?: ConcordiaMemoryContinuityMode;
    checkpointMetadata?: ConcordiaCheckpointMetadata | null;
  } = {},
): Promise<MemoryWiringContext | null> {
  const services = context.host_services?.concordia_memory;
  const namespaceResolution = buildConcordiaMemoryNamespaces({
    worldId,
    workspaceId,
    simulationId: identity.simulationId,
    lineageId: identity.lineageId ?? null,
    parentSimulationId: identity.parentSimulationId ?? null,
    continuityMode: options.continuityMode,
    checkpointMetadata: options.checkpointMetadata ?? null,
  });
  const { continuityMode, carryOverPolicy, namespaces } = namespaceResolution;
  const wiringBase = {
    worldId,
    workspaceId,
    simulationId: identity.simulationId,
    lineageId: identity.lineageId ?? null,
    parentSimulationId: identity.parentSimulationId ?? null,
    effectiveStorageKey: namespaces.effectiveStorageKey,
    continuityMode,
    carryOverPolicy,
    namespaces,
    checkpointMetadata: options.checkpointMetadata ?? null,
  };
  if (isConcordiaMemoryResolverHostServices(services)) {
    const resolved = await services.resolveWorldContext({
      worldId,
      workspaceId,
      simulationId: identity.simulationId,
      lineageId: identity.lineageId,
      parentSimulationId: identity.parentSimulationId,
      effectiveStorageKey: namespaces.effectiveStorageKey,
      logStorageKey: namespaces.logStorageKey,
      scopedWorkspaceId: namespaces.memoryWorkspaceId,
      continuityMode,
      checkpointMetadata: options.checkpointMetadata ?? null,
    });
    return buildMemoryWiringContext(context, resolved, wiringBase);
  }

  if (!isConcordiaMemoryWorldServices(services)) {
    context.logger.debug?.(
      "[concordia] Host concordia_memory services unavailable — memory wiring disabled",
    );
    return null;
  }

  return buildMemoryWiringContext(context, services, wiringBase);
}

export function resolveConcordiaLaunchDefaults(
  context: ChannelAdapterContext<ConcordiaChannelConfig>,
): {
  readonly gm_provider?: string;
  readonly gm_model?: string;
  readonly gm_api_key?: string;
  readonly gm_base_url?: string;
} {
  const services = context.host_services?.concordia_runtime;
  if (!isConcordiaRuntimeHostServices(services)) {
    return {};
  }
  const launchDefaults = services.defaults ?? services.llm;
  if (!launchDefaults) {
    return {};
  }

  return {
    gm_provider: launchDefaults.provider,
    gm_model: launchDefaults.model,
    gm_api_key: launchDefaults.apiKey,
    gm_base_url: launchDefaults.baseUrl,
  };
}
