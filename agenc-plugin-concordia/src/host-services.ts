import type { ChannelAdapterContext } from "@tetsuo-ai/plugin-kit";
import type { ConcordiaChannelConfig } from "./types.js";
import type {
  DailyLogManagerLike,
  IdentityManagerLike,
  MemoryBackendLike,
  MemoryGraphLike,
  MemoryWiringContext,
  ProceduralMemoryLike,
  SharedMemoryLike,
  SocialMemoryLike,
  TraceLoggerLike,
} from "./memory-wiring.js";

interface ConcordiaMemoryHostServices {
  readonly memoryBackend: MemoryBackendLike;
  readonly identityManager: IdentityManagerLike;
  readonly socialMemory: SocialMemoryLike;
  readonly proceduralMemory?: ProceduralMemoryLike;
  readonly graph?: MemoryGraphLike;
  readonly sharedMemory?: SharedMemoryLike;
  readonly traceLogger?: TraceLoggerLike;
  readonly dailyLogManager?: DailyLogManagerLike;
}

interface ConcordiaRuntimeHostServices {
  readonly llm?: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly model?: string;
    readonly baseUrl?: string;
  };
}

function isConcordiaMemoryHostServices(
  value: unknown,
): value is ConcordiaMemoryHostServices {
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

function isConcordiaRuntimeHostServices(
  value: unknown,
): value is ConcordiaRuntimeHostServices {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!("llm" in candidate)) {
    return false;
  }
  if (candidate.llm === undefined) {
    return true;
  }
  return typeof candidate.llm === "object" && candidate.llm !== null;
}

export function resolveConcordiaMemoryContext(
  context: ChannelAdapterContext<ConcordiaChannelConfig>,
  worldId: string,
  workspaceId: string,
): MemoryWiringContext | null {
  const services = context.host_services?.concordia_memory;
  if (!isConcordiaMemoryHostServices(services)) {
    context.logger.debug?.(
      "[concordia] Host concordia_memory services unavailable — memory wiring disabled",
    );
    return null;
  }

  return {
    worldId,
    workspaceId,
    memoryBackend: services.memoryBackend,
    identityManager: services.identityManager,
    socialMemory: services.socialMemory,
    proceduralMemory: services.proceduralMemory,
    graph: services.graph,
    sharedMemory: services.sharedMemory,
    traceLogger: services.traceLogger,
    dailyLogManager: services.dailyLogManager,
    encryptionKey: context.config.encryption_key,
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
  if (!isConcordiaRuntimeHostServices(services) || !services.llm) {
    return {};
  }

  return {
    gm_provider: services.llm.provider,
    gm_model: services.llm.model,
    gm_api_key: services.llm.apiKey,
    gm_base_url: services.llm.baseUrl,
  };
}
