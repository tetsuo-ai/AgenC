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

export const DEFAULT_TRACE_SAMPLE_RATE = 1;

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
