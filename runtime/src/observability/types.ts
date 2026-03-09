import type { TracePayloadArtifactRef } from "../utils/trace-payload-store.js";

export type ObservabilityEventLevel = "info" | "error";
export type ObservabilityTraceStatus = "open" | "completed" | "error";

export interface ObservabilityEventInput {
  readonly eventName: string;
  readonly level: ObservabilityEventLevel;
  readonly traceId?: string;
  readonly parentTraceId?: string;
  readonly sessionId?: string;
  readonly channel?: string;
  readonly timestampMs?: number;
  readonly callIndex?: number;
  readonly callPhase?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly payloadPreview: unknown;
  readonly rawPayload?: Record<string, unknown>;
  readonly artifact?: TracePayloadArtifactRef;
}

export interface ObservabilityEventRecord {
  readonly id: string;
  readonly eventName: string;
  readonly level: ObservabilityEventLevel;
  readonly traceId: string;
  readonly parentTraceId?: string;
  readonly sessionId?: string;
  readonly channel?: string;
  readonly timestampMs: number;
  readonly callIndex?: number;
  readonly callPhase?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly toolName?: string;
  readonly stopReason?: string;
  readonly durationMs?: number;
  readonly routingMiss: boolean;
  readonly completionGateDecision?: string;
  readonly payloadPreview: unknown;
  readonly artifact?: TracePayloadArtifactRef;
}

export interface ObservabilityTraceSummary {
  readonly traceId: string;
  readonly sessionId?: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly eventCount: number;
  readonly errorCount: number;
  readonly status: ObservabilityTraceStatus;
  readonly lastEventName: string;
  readonly stopReason?: string;
}

export interface ObservabilityTraceCompleteness {
  readonly complete: boolean;
  readonly issues: readonly string[];
}

export interface ObservabilityTraceDetail {
  readonly summary: ObservabilityTraceSummary;
  readonly completeness: ObservabilityTraceCompleteness;
  readonly events: readonly ObservabilityEventRecord[];
}

export interface ObservabilitySummaryMetric {
  readonly label: string;
  readonly value: number;
}

export interface ObservabilityNamedCount {
  readonly name: string;
  readonly count: number;
}

export interface ObservabilitySummary {
  readonly windowMs: number;
  readonly traces: {
    readonly total: number;
    readonly completed: number;
    readonly errors: number;
    readonly open: number;
    readonly completenessRate: number;
  };
  readonly events: {
    readonly providerErrors: number;
    readonly toolRejections: number;
    readonly routeMisses: number;
    readonly completionGateFailures: number;
  };
  readonly topTools: readonly ObservabilityNamedCount[];
  readonly topStopReasons: readonly ObservabilityNamedCount[];
}

export interface ObservabilitySummaryQuery {
  readonly windowMs?: number;
  readonly sessionId?: string;
  readonly sessionIds?: readonly string[];
}

export interface ObservabilityTraceQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly search?: string;
  readonly status?: ObservabilityTraceStatus | "all";
  readonly sessionId?: string;
  readonly sessionIds?: readonly string[];
}

export interface ObservabilityArtifactResponse {
  readonly path: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly body: unknown;
}

export interface ObservabilityLogResponse {
  readonly path: string;
  readonly lines: readonly string[];
}
