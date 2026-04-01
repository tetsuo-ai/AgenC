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
