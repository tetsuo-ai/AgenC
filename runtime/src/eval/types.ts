/**
 * Eval trajectory trace schema, parsing, and canonicalization helpers.
 *
 * @module
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const EVAL_TRACE_SCHEMA_VERSION = 1 as const;

export type KnownTrajectoryEventType =
  | 'discovered'
  | 'claimed'
  | 'executed'
  | 'executed_speculative'
  | 'completed'
  | 'completed_speculative'
  | 'failed'
  | 'escalated'
  | 'proof_failed'
  | 'proof_generated'
  | 'verifier_verdict'
  | 'policy_violation'
  | 'sequential_enforcement_bypass'
  | 'speculation_started'
  | 'speculation_confirmed'
  | 'speculation_aborted';

export type TrajectoryEventType = KnownTrajectoryEventType | (string & {});

export interface TrajectoryRecordInput {
  type: TrajectoryEventType;
  payload?: Record<string, unknown>;
  taskPda?: string;
  timestampMs?: number;
}

export interface TrajectoryRecorderSink {
  record(input: TrajectoryRecordInput): TrajectoryEvent | null;
}

export interface TrajectoryEvent {
  seq: number;
  type: TrajectoryEventType;
  taskPda?: string;
  timestampMs: number;
  payload: JsonObject;
}

export interface TrajectoryTrace {
  schemaVersion: typeof EVAL_TRACE_SCHEMA_VERSION;
  traceId: string;
  seed: number;
  createdAtMs: number;
  metadata?: JsonObject;
  events: TrajectoryEvent[];
}

export interface LegacyTrajectoryEventV0 {
  type: string;
  taskPda?: string;
  timestampMs: number;
  payload?: JsonObject;
}

export interface LegacyTrajectoryTraceV0 {
  traceId: string;
  seed?: number;
  createdAtMs: number;
  metadata?: JsonObject;
  events: LegacyTrajectoryEventV0[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') return true;

  if (valueType === 'number') {
    return Number.isFinite(value as number);
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (isPlainObject(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry));
  }

  return false;
}

function parseJsonObject(value: unknown, path: string): JsonObject {
  assert(isPlainObject(value), `${path} must be a plain object`);
  assert(isJsonValue(value), `${path} contains non-JSON values`);
  return value;
}

function parseTrajectoryEvent(value: unknown, index: number): TrajectoryEvent {
  const path = `events[${index}]`;
  assert(isPlainObject(value), `${path} must be an object`);

  const seq = value.seq;
  const type = value.type;
  const taskPda = value.taskPda;
  const timestampMs = value.timestampMs;
  const payload = value.payload;

  assert(Number.isInteger(seq) && (seq as number) > 0, `${path}.seq must be a positive integer`);
  assert(typeof type === 'string' && type.length > 0, `${path}.type must be a non-empty string`);
  if (taskPda !== undefined) {
    assert(typeof taskPda === 'string' && taskPda.length > 0, `${path}.taskPda must be a non-empty string`);
  }
  assert(Number.isInteger(timestampMs) && (timestampMs as number) >= 0, `${path}.timestampMs must be a non-negative integer`);

  return {
    seq: seq as number,
    type,
    taskPda: taskPda as string | undefined,
    timestampMs: timestampMs as number,
    payload: parseJsonObject(payload ?? {}, `${path}.payload`),
  };
}

function parseV1Trace(value: unknown): TrajectoryTrace {
  assert(isPlainObject(value), 'trace must be an object');

  const schemaVersion = value.schemaVersion;
  const traceId = value.traceId;
  const seed = value.seed;
  const createdAtMs = value.createdAtMs;
  const metadata = value.metadata;
  const events = value.events;

  assert(schemaVersion === EVAL_TRACE_SCHEMA_VERSION, `unsupported schemaVersion: ${String(schemaVersion)}`);
  assert(typeof traceId === 'string' && traceId.length > 0, 'traceId must be a non-empty string');
  assert(Number.isInteger(seed), 'seed must be an integer');
  assert(Number.isInteger(createdAtMs) && (createdAtMs as number) >= 0, 'createdAtMs must be a non-negative integer');
  assert(Array.isArray(events), 'events must be an array');

  const parsedEvents = events.map((event, idx) => parseTrajectoryEvent(event, idx));
  const parsedMetadata = metadata !== undefined
    ? parseJsonObject(metadata, 'metadata')
    : undefined;

  return {
    schemaVersion: EVAL_TRACE_SCHEMA_VERSION,
    traceId,
    seed: seed as number,
    createdAtMs: createdAtMs as number,
    metadata: parsedMetadata,
    events: parsedEvents,
  };
}

function parseLegacyV0Trace(value: unknown): TrajectoryTrace {
  assert(isPlainObject(value), 'legacy trace must be an object');

  const traceId = value.traceId;
  const seed = value.seed;
  const createdAtMs = value.createdAtMs;
  const metadata = value.metadata;
  const events = value.events;

  assert(typeof traceId === 'string' && traceId.length > 0, 'legacy traceId must be a non-empty string');
  assert(seed === undefined || Number.isInteger(seed), 'legacy seed must be an integer when provided');
  assert(Number.isInteger(createdAtMs) && (createdAtMs as number) >= 0, 'legacy createdAtMs must be a non-negative integer');
  assert(Array.isArray(events), 'legacy events must be an array');

  const migratedEvents = events.map((event, idx) => {
    const path = `legacy.events[${idx}]`;
    assert(isPlainObject(event), `${path} must be an object`);

    const type = event.type;
    const taskPda = event.taskPda;
    const timestampMs = event.timestampMs;
    const payload = event.payload;

    assert(typeof type === 'string' && type.length > 0, `${path}.type must be a non-empty string`);
    if (taskPda !== undefined) {
      assert(typeof taskPda === 'string' && taskPda.length > 0, `${path}.taskPda must be a non-empty string`);
    }
    assert(Number.isInteger(timestampMs) && (timestampMs as number) >= 0, `${path}.timestampMs must be a non-negative integer`);

    return {
      seq: idx + 1,
      type,
      taskPda: taskPda as string | undefined,
      timestampMs: timestampMs as number,
      payload: parseJsonObject(payload ?? {}, `${path}.payload`),
    } satisfies TrajectoryEvent;
  });

  return {
    schemaVersion: EVAL_TRACE_SCHEMA_VERSION,
    traceId,
    seed: (seed as number | undefined) ?? 0,
    createdAtMs: createdAtMs as number,
    metadata: metadata !== undefined ? parseJsonObject(metadata, 'legacy.metadata') : undefined,
    events: migratedEvents,
  };
}

/**
 * Parse a trajectory trace, including migration from legacy v0 format.
 */
export function parseTrajectoryTrace(value: unknown): TrajectoryTrace {
  if (isPlainObject(value) && value.schemaVersion === EVAL_TRACE_SCHEMA_VERSION) {
    return parseV1Trace(value);
  }

  return parseLegacyV0Trace(value);
}

/**
 * Explicit migration helper for callers that already distinguish source versions.
 */
export function migrateTrajectoryTrace(
  trace: TrajectoryTrace | LegacyTrajectoryTraceV0,
): TrajectoryTrace {
  return parseTrajectoryTrace(trace);
}

function canonicalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }

  if (isPlainObject(value)) {
    const output: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalizeJson(value[key] as JsonValue);
    }
    return output;
  }

  return value;
}

/**
 * Canonicalize trace for deterministic hashing/serialization.
 * Event order is normalized by `seq` ascending.
 */
export function canonicalizeTrajectoryTrace(trace: TrajectoryTrace): TrajectoryTrace {
  const events = [...trace.events]
    .sort((a, b) => a.seq - b.seq)
    .map((event) => ({
      ...event,
      payload: canonicalizeJson(event.payload) as JsonObject,
    }));

  return {
    ...trace,
    metadata: trace.metadata
      ? (canonicalizeJson(trace.metadata) as JsonObject)
      : undefined,
    events,
  };
}

/**
 * Stable stringify for JSON-compatible values using canonical key ordering.
 */
export function stableStringifyJson(value: JsonValue): string {
  return JSON.stringify(canonicalizeJson(value));
}
