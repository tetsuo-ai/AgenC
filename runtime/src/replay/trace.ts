/**
 * Replay trace helpers for deterministic trace context and optional sampling.
 *
 * This module provides trace IDs and span identifiers without hard-coding a
 * specific tracing backend. Callers can enable `emitOtel` when the optional
 * OpenTelemetry package is available.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

export interface ReplayTraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

export interface ReplayTracingPolicy {
  /** Optional override trace identifier for a run */
  traceId?: string;
  /** Deterministic sample rate in [0, 1]. Defaults to 1 (always sample). */
  sampleRate?: number;
  /** Emit OpenTelemetry shape/metadata when a backend is available */
  emitOtel?: boolean;
}

export interface ReplayTraceEnvelope {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

export interface ReplaySpanEvent {
  code: string;
  slot?: number;
  signature?: string;
  sourceEventSequence?: number;
  taskPda?: string;
  disputePda?: string;
}

export interface ReplaySpanContext {
  name: string;
  trace: ReplayTraceContext;
  attributes?: ReplaySpanEvent;
  emitOtel?: boolean;
}

interface ReplaySpanHandle {
  end: (error?: unknown) => void;
}

interface ReplayOtelSpan {
  setAttribute: (name: string, value: unknown) => void;
  recordException?: (error: unknown) => void;
  setStatus?: (status: { code: number; message?: string }) => void;
  end: () => void;
}

interface ReplayOtelModule {
  trace: {
    getTracer: (name: string, version?: string) => {
      startSpan: (
        name: string,
        options: {
          attributes?: Record<string, string | number | boolean>;
        }
      ) => ReplayOtelSpan;
    };
  };
}

type OtelLoadState = ReplayOtelModule | false;

export const DEFAULT_TRACE_SAMPLE_RATE = 1;

const otelRequire = createRequire(`${process.cwd()}/`);
const otelCache = new Map<string, OtelLoadState>();

function resolveOtelModule(cacheKey: string): ReplayOtelModule | null {
  const cached = otelCache.get(cacheKey);
  if (cached === false) {
    return null;
  }
  if (cached !== undefined) {
    return cached;
  }

  try {
    const module = otelRequire('@opentelemetry/api') as { trace?: unknown };
    const tracerApi = module?.trace as { getTracer?: unknown } | undefined;
    if (tracerApi?.getTracer !== undefined) {
      otelCache.set(cacheKey, {
        trace: {
          getTracer: tracerApi.getTracer as ReplayOtelModule['trace']['getTracer'],
        },
      });
      return {
        trace: {
          getTracer: tracerApi.getTracer as ReplayOtelModule['trace']['getTracer'],
        },
      };
    }
  } catch {
    // Optional dependency unavailable.
  }

  otelCache.set(cacheKey, false);
  return null;
}

function normalizeSampleRate(sampleRate: number | undefined): number {
  if (sampleRate === undefined || Number.isNaN(sampleRate)) {
    return DEFAULT_TRACE_SAMPLE_RATE;
  }
  if (sampleRate <= 0) return 0;
  if (sampleRate >= 1) return 1;
  return sampleRate;
}

function hashHex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicSample(key: string, sampleRate: number): boolean {
  if (sampleRate >= 1) {
    return true;
  }
  if (sampleRate <= 0) {
    return false;
  }
  const value = Number.parseInt(hashHex(key).slice(0, 8), 16);
  return (value / 0xFFFF_FFFF) < sampleRate;
}

function deriveTraceId(base: string | undefined, slot: number, signature: string, eventName: string, eventSequence?: number): string {
  if (base && base.length > 0) {
    return base;
  }
  return hashHex(`agenc-runtime:${slot}:${signature}:${eventName}:${eventSequence ?? 0}`).slice(0, 32);
}

function deriveSpanId(
  traceId: string,
  eventName: string,
  slot: number,
  signature: string,
  eventSequence: number,
): string {
  return hashHex(`${traceId}:${eventName}:${slot}:${signature}:${eventSequence}`).slice(0, 16);
}

/**
 * Build a deterministic trace context for a single event stream item.
 */
export function buildReplayTraceContext(
  args: {
    traceId?: string;
    eventName: string;
    slot: number;
    signature: string;
    eventSequence: number;
    parentSpanId?: string;
    sampleRate?: number;
  },
): ReplayTraceContext {
  const normalizedSampleRate = normalizeSampleRate(args.sampleRate);
  const traceId = deriveTraceId(args.traceId, args.slot, args.signature, args.eventName, args.eventSequence);
  const spanIdSeed = `${traceId}:${args.eventName}:${args.slot}:${args.signature}:${args.eventSequence}`;
  const spanId = deriveSpanId(traceId, args.eventName, args.slot, args.signature, args.eventSequence);
  const sampled = deterministicSample(spanIdSeed, normalizedSampleRate);

  return {
    traceId,
    spanId,
    parentSpanId: args.parentSpanId,
    sampled,
  };
}

export function toReplayTraceEnvelope(context: ReplayTraceContext | undefined): ReplayTraceEnvelope | undefined {
  if (!context) {
    return undefined;
  }
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sampled: context.sampled,
  };
}

export function buildReplaySpanEvent(
  code: string,
  details: {
    slot?: number;
    signature?: string;
    sourceEventSequence?: number;
    taskPda?: string;
    disputePda?: string;
  },
): ReplaySpanEvent {
  return {
    code,
    slot: details.slot,
    signature: details.signature,
    sourceEventSequence: details.sourceEventSequence,
    taskPda: details.taskPda,
    disputePda: details.disputePda,
  };
}

export function buildReplaySpanName(
  code: string,
  event: {
    slot?: number;
    signature?: string;
  },
): string {
  if (event.slot !== undefined && event.signature !== undefined) {
    return `${code}[slot=${event.slot},signature=${event.signature}]`;
  }
  return code;
}

export function startReplaySpan(context: ReplaySpanContext): ReplaySpanHandle {
  if (!context.emitOtel || !context.trace.sampled) {
    return { end: () => undefined };
  }

  const otel = resolveOtelModule('default');
  if (!otel) {
    return { end: () => undefined };
  }

  const attributes = {
    ...context.attributes,
    'agenc.replay.trace_id': context.trace.traceId,
    'agenc.replay.span_id': context.trace.spanId,
    'agenc.replay.sampled': context.trace.sampled,
  } as const;
  if (context.trace.parentSpanId !== undefined) {
    (attributes as { 'agenc.replay.parent_span_id'?: string })['agenc.replay.parent_span_id'] = context.trace.parentSpanId;
  }

  const span = otel.trace
    .getTracer('agenc-runtime-replay', '0.1.0')
    .startSpan(context.name, { attributes });

  return {
    end(error?: unknown): void {
      if (error !== undefined) {
        span.recordException?.(error);
        const message = error instanceof Error
          ? error.message
          : String(error);
        span.setStatus?.({ code: 2, message });
      }
      span.end();
    },
  };
}
