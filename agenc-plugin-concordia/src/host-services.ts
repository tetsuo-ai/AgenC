import type { ChannelAdapterContext } from "@tetsuo-ai/plugin-kit";
import type { ConcordiaChannelConfig } from "./types.js";
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
): Promise<MemoryWiringContext | null> {
  const services = context.host_services?.concordia_memory;
  if (isConcordiaMemoryResolverHostServices(services)) {
    const resolved = await services.resolveWorldContext({
      worldId,
      workspaceId,
      simulationId: identity.simulationId,
      lineageId: identity.lineageId,
      parentSimulationId: identity.parentSimulationId,
    });
    return {
      worldId,
      workspaceId,
      simulationId: identity.simulationId,
      lineageId: identity.lineageId ?? null,
      parentSimulationId: identity.parentSimulationId ?? null,
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

  if (!isConcordiaMemoryWorldServices(services)) {
    context.logger.debug?.(
      "[concordia] Host concordia_memory services unavailable — memory wiring disabled",
    );
    return null;
  }

  return {
    worldId,
    workspaceId,
    simulationId: identity.simulationId,
    lineageId: identity.lineageId ?? null,
    parentSimulationId: identity.parentSimulationId ?? null,
    memoryBackend: services.memoryBackend,
    identityManager: services.identityManager,
    socialMemory: services.socialMemory,
    proceduralMemory: services.proceduralMemory,
    graph: services.graph,
    sharedMemory: services.sharedMemory,
    traceLogger: services.traceLogger,
    dailyLogManager: services.dailyLogManager,
    ingestionEngine: services.ingestionEngine,
    retriever: services.retriever,
    lifecycle: services.lifecycle,
    encryptionKey: context.config.encryption_key,
    vectorDbPath: services.vectorDbPath,
  };
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
