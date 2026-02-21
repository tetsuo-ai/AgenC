/**
 * In-memory trajectory recorder for deterministic agent replay.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import {
  EVAL_TRACE_SCHEMA_VERSION,
  canonicalizeTrajectoryTrace,
  type JsonObject,
  type JsonValue,
  type TrajectoryEvent,
  type TrajectoryRecordInput,
  type TrajectoryTrace,
} from "./types.js";

const DEFAULT_MAX_EVENTS = 10_000;

export interface TrajectoryRecorderConfig {
  traceId?: string;
  seed?: number;
  metadata?: JsonObject;
  now?: () => number;
  maxEvents?: number;
  enabled?: boolean;
}

function sanitizeValue(value: unknown): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (typeof value === "object" && value !== null) {
    if (
      "toBase58" in value &&
      typeof (value as { toBase58?: unknown }).toBase58 === "function"
    ) {
      return (value as { toBase58: () => string }).toBase58();
    }

    const output: JsonObject = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entry] of entries) {
      output[key] = sanitizeValue(entry);
    }
    return output;
  }

  return String(value);
}

function sanitizePayload(
  payload: Record<string, unknown> | undefined,
): JsonObject {
  if (!payload) {
    return {};
  }

  const sanitized = sanitizeValue(payload);
  if (
    typeof sanitized === "object" &&
    sanitized !== null &&
    !Array.isArray(sanitized)
  ) {
    return sanitized as JsonObject;
  }

  return { value: sanitized };
}

/**
 * Records ordered trajectory events in-memory.
 */
export class TrajectoryRecorder {
  private readonly traceId: string;
  private readonly seed: number;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly enabled: boolean;
  private readonly createdAtMs: number;
  private readonly metadata?: JsonObject;

  private readonly events: TrajectoryEvent[] = [];

  constructor(config: TrajectoryRecorderConfig = {}) {
    this.traceId = config.traceId ?? randomUUID();
    this.seed = config.seed ?? 0;
    this.now = config.now ?? Date.now;
    this.maxEvents = config.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.enabled = config.enabled ?? true;
    this.metadata = config.metadata;
    this.createdAtMs = this.now();
  }

  record(input: TrajectoryRecordInput): TrajectoryEvent | null {
    if (!this.enabled) {
      return null;
    }

    if (this.events.length >= this.maxEvents) {
      throw new Error(`trajectory event limit reached (${this.maxEvents})`);
    }

    const event: TrajectoryEvent = {
      seq: this.events.length + 1,
      type: input.type,
      taskPda: input.taskPda,
      timestampMs: input.timestampMs ?? this.now(),
      payload: sanitizePayload(input.payload),
    };

    this.events.push(event);
    return {
      ...event,
      payload: { ...event.payload },
    };
  }

  size(): number {
    return this.events.length;
  }

  reset(): void {
    this.events.length = 0;
  }

  getEvents(): TrajectoryEvent[] {
    return this.events.map((event) => ({
      ...event,
      payload: { ...event.payload },
    }));
  }

  createTrace(): TrajectoryTrace {
    return canonicalizeTrajectoryTrace({
      schemaVersion: EVAL_TRACE_SCHEMA_VERSION,
      traceId: this.traceId,
      seed: this.seed,
      createdAtMs: this.createdAtMs,
      metadata: this.metadata ? { ...this.metadata } : undefined,
      events: this.getEvents(),
    });
  }
}
