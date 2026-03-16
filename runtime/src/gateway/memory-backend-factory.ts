/**
 * Factory for creating memory backends from gateway config.
 *
 * Extracts memory backend creation (SQLite/Redis/InMemory selection)
 * from daemon.ts into a standalone factory function.
 *
 * Gate 3 — prerequisite reduction for planner/pipeline cross-cut.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import type { MemoryBackend } from "../memory/types.js";
import type { GatewayConfig } from "./types.js";
import type { UnifiedTelemetryCollector } from "../telemetry/collector.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateMemoryBackendParams {
  config: GatewayConfig;
  metrics?: UnifiedTelemetryCollector;
  logger: { info: (...args: any[]) => void };
}

/**
 * Create a memory backend based on gateway config.
 * Defaults to SqliteBackend for persistence across restarts.
 * Use backend='memory' to explicitly opt into InMemoryBackend.
 */
export async function createMemoryBackend(
  params: CreateMemoryBackendParams,
): Promise<MemoryBackend> {
  const { config, metrics, logger } = params;
  const memConfig = config.memory;
  const backend = memConfig?.backend ?? "sqlite";
  const encryption = memConfig?.encryptionKey
    ? { key: memConfig.encryptionKey }
    : undefined;

  switch (backend) {
    case "sqlite": {
      const { SqliteBackend } = await import("../memory/sqlite/backend.js");
      return new SqliteBackend({
        dbPath: memConfig?.dbPath ?? join(homedir(), ".agenc", "memory.db"),
        logger,
        metrics,
        encryption,
      });
    }
    case "redis": {
      const { RedisBackend } = await import("../memory/redis/backend.js");
      return new RedisBackend({
        url: memConfig?.url,
        host: memConfig?.host,
        port: memConfig?.port,
        password: memConfig?.password,
        logger,
        metrics,
      });
    }
    case "memory":
      return new InMemoryBackend({ logger, metrics });
    default:
      return new InMemoryBackend({ logger, metrics });
  }
}
