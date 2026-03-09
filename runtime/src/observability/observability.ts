import { randomUUID } from "node:crypto";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { SqliteObservabilityStore } from "./sqlite-store.js";
import type {
  ObservabilityArtifactResponse,
  ObservabilityEventInput,
  ObservabilityEventRecord,
  ObservabilityLogResponse,
  ObservabilitySummary,
  ObservabilitySummaryQuery,
  ObservabilityTraceDetail,
  ObservabilityTraceQuery,
} from "./types.js";

function readString(
  payload: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(
  payload: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(
  payload: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = payload?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function deriveToolName(
  eventName: string,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  return (
    readString(payload, "toolName") ??
    readString(payload, "tool") ??
    (eventName.includes(".tool.") ? readString(payload, "name") : undefined)
  );
}

function deriveStopReason(payload: Record<string, unknown> | undefined): string | undefined {
  return readString(payload, "stopReason");
}

function deriveEventRecord(input: ObservabilityEventInput): ObservabilityEventRecord | null {
  if (!input.traceId) return null;
  const rawPayload = input.rawPayload;
  return {
    id: `${input.traceId}:${input.eventName}:${input.timestampMs ?? Date.now()}:${randomUUID()}`,
    eventName: input.eventName,
    level: input.level,
    traceId: input.traceId,
    ...(input.parentTraceId ? { parentTraceId: input.parentTraceId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    timestampMs: input.timestampMs ?? Date.now(),
    ...(input.callIndex !== undefined ? { callIndex: input.callIndex } : {}),
    ...(input.callPhase ? { callPhase: input.callPhase } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(deriveToolName(input.eventName, rawPayload)
      ? { toolName: deriveToolName(input.eventName, rawPayload) }
      : {}),
    ...(deriveStopReason(rawPayload)
      ? { stopReason: deriveStopReason(rawPayload) }
      : {}),
    ...(readNumber(rawPayload, "durationMs") !== undefined
      ? { durationMs: readNumber(rawPayload, "durationMs") }
      : {}),
    routingMiss: readBoolean(rawPayload, "routingMiss") === true,
    ...(readString(rawPayload, "decision")
      ? { completionGateDecision: readString(rawPayload, "decision") }
      : {}),
    payloadPreview: input.payloadPreview,
    ...(input.artifact ? { artifact: input.artifact } : {}),
  };
}

export interface ObservabilityServiceConfig {
  readonly logger?: Logger;
  readonly dbPath?: string;
  readonly daemonLogPath?: string;
}

export class ObservabilityService {
  private readonly logger: Logger;
  private readonly store: SqliteObservabilityStore;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(config: ObservabilityServiceConfig = {}) {
    this.logger = config.logger ?? silentLogger;
    this.store = new SqliteObservabilityStore({
      dbPath: config.dbPath,
      daemonLogPath: config.daemonLogPath,
    });
  }

  recordEvent(input: ObservabilityEventInput): void {
    const record = deriveEventRecord(input);
    if (!record) return;
    this.writeChain = this.writeChain
      .then(() => this.store.recordEvent(record))
      .catch((error) => {
        this.logger.warn?.(
          `Observability event persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  async listTraces(query?: ObservabilityTraceQuery) {
    await this.writeChain;
    return this.store.listTraces(query);
  }

  async getTrace(traceId: string): Promise<ObservabilityTraceDetail | null> {
    await this.writeChain;
    return this.store.getTrace(traceId);
  }

  async getSummary(
    query: ObservabilitySummaryQuery = {},
  ): Promise<ObservabilitySummary> {
    await this.writeChain;
    return this.store.getSummary(query);
  }

  async getArtifact(path: string): Promise<ObservabilityArtifactResponse> {
    await this.writeChain;
    return this.store.getArtifact(path);
  }

  async getLogTail(params: {
    readonly lines?: number;
    readonly traceId?: string;
  }): Promise<ObservabilityLogResponse> {
    await this.writeChain;
    return this.store.getLogTail(params);
  }

  async close(): Promise<void> {
    await this.writeChain;
    await this.store.close();
  }
}

let defaultObservabilityService: ObservabilityService | null = null;

export function setDefaultObservabilityService(
  service: ObservabilityService | null,
): void {
  defaultObservabilityService = service;
}

export function recordObservabilityTraceEvent(
  input: ObservabilityEventInput,
): void {
  defaultObservabilityService?.recordEvent(input);
}

export function getDefaultObservabilityService(): ObservabilityService | null {
  return defaultObservabilityService;
}
