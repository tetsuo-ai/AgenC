/**
 * Replay anomaly alerting utilities.
 *
 * Provides deterministic, schema-stable alert payloads and optional dispatch
 * to logger or webhook adapters.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import {
  stableStringifyJson,
  type JsonValue,
} from '../eval/types.js';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * Schema version for replay alert payloads.
 * Increment when adding required fields or changing field semantics.
 * Adding optional fields does NOT require a version bump.
 */
export const REPLAY_ALERT_SCHEMA_VERSION = 'replay.alert.v1' as const;

export type ReplayAlertSeverity = 'info' | 'warning' | 'error';

export type ReplayAlertKind =
  | 'transition_validation'
  | 'replay_hash_mismatch'
  | 'replay_anomaly_repeat'
  | 'replay_ingestion_lag';

export interface ReplayAlertContext {
  code: string;
  severity: ReplayAlertSeverity;
  kind: ReplayAlertKind;
  message: string;
  taskPda?: string;
  disputePda?: string;
  sourceEventName?: string;
  signature?: string;
  slot?: number;
  sourceEventSequence?: number;
  traceId?: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  occurredAtMs?: number;
  repeatCount?: number;
}

export interface ReplayAnomalyAlert extends ReplayAlertContext {
  id: string;
  emittedAtMs: number;
}

export interface ReplayAlertAdapter {
  emit(alert: ReplayAnomalyAlert): Promise<void> | void;
}

export interface ReplayLoggerAdapterConfig {
  enabled?: boolean;
}

export interface ReplayWebhookAdapterConfig {
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  enabled?: boolean;
}

interface ReplayAlertHistoryEntry {
  lastEmittedMs: number;
  occurrences: number;
}

export interface ReplayAlertingPolicy {
  enabled: boolean;
  dedupeWindowMs: number;
  dedupeScope: ReadonlyArray<'taskPda' | 'disputePda' | 'signature' | 'sourceEventName'>;
  adapters: ReadonlyArray<ReplayAlertAdapter>;
}

export interface ReplayAlertingPolicyOptions {
  enabled?: boolean;
  dedupeWindowMs?: number;
  dedupeScope?: ReadonlyArray<'taskPda' | 'disputePda' | 'signature' | 'sourceEventName'>;
  logger?: ReplayLoggerAdapterConfig | boolean;
  webhook?: ReplayWebhookAdapterConfig;
  nowMs?: () => number;
}

const DEFAULT_ALERTING_POLICY = {
  enabled: false,
  dedupeWindowMs: 60_000,
  dedupeScope: ['taskPda', 'disputePda', 'sourceEventName', 'signature'] as const,
};

function stableValue(value: unknown): string {
  return stableStringifyJson(value as JsonValue);
}

function hashHex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nowOrDefault(nowFn: () => number): number {
  return nowFn();
}

function makeDedupeKey(
  alert: Omit<ReplayAnomalyAlert, 'id' | 'emittedAtMs'>,
  scope: ReadonlyArray<string>,
): string {
  const components = {
    code: alert.code,
    kind: alert.kind,
    taskPda: scope.includes('taskPda') ? alert.taskPda : undefined,
    disputePda: scope.includes('disputePda') ? alert.disputePda : undefined,
    sourceEventName: scope.includes('sourceEventName') ? alert.sourceEventName : undefined,
    signature: scope.includes('signature') ? alert.signature : undefined,
    slot: alert.slot,
  };

  return hashHex(stableValue(components));
}

function makeAlertId(
  alert: Omit<ReplayAnomalyAlert, 'id' | 'emittedAtMs'>,
): string {
  const { repeatCount: _repeatCount, ...identifierPayload } = alert;
  return hashHex(stableValue(identifierPayload));
}

function buildAlertPayload(
  context: ReplayAlertContext,
): Omit<ReplayAnomalyAlert, 'id' | 'emittedAtMs'> {
  return {
    code: context.code,
    severity: context.severity,
    kind: context.kind,
    message: context.message,
    taskPda: context.taskPda,
    disputePda: context.disputePda,
    sourceEventName: context.sourceEventName,
    signature: context.signature,
    slot: context.slot,
    sourceEventSequence: context.sourceEventSequence,
    traceId: context.traceId,
    metadata: context.metadata,
    occurredAtMs: context.occurredAtMs,
    repeatCount: context.repeatCount,
  };
}

export class ReplayAlertDispatcher {
  private readonly policy: ReplayAlertingPolicy;
  private readonly history = new Map<string, ReplayAlertHistoryEntry>();
  private readonly nowMs: () => number;

  constructor(options?: ReplayAlertingPolicyOptions, logger?: Logger) {
    const loggerEnabled = options?.logger === undefined
      ? false
      : typeof options.logger === 'boolean'
        ? options.logger
        : options.logger.enabled;

    const webhook = options?.webhook;
    const adapters: ReplayAlertAdapter[] = [];
    if (loggerEnabled && logger) {
      adapters.push(new ReplayLoggerAdapter(logger));
    }
    if (webhook?.enabled !== false && webhook?.url) {
      adapters.push(new ReplayWebhookAdapter(webhook));
    }

    this.policy = {
      enabled: options?.enabled ?? DEFAULT_ALERTING_POLICY.enabled,
      dedupeWindowMs: options?.dedupeWindowMs ?? DEFAULT_ALERTING_POLICY.dedupeWindowMs,
      dedupeScope: options?.dedupeScope ?? DEFAULT_ALERTING_POLICY.dedupeScope,
      adapters,
    };

    this.nowMs = options?.nowMs ?? (() => Date.now());
  }

  async emit(context: ReplayAlertContext): Promise<ReplayAnomalyAlert | null> {
    const emittedAtMs = nowOrDefault(this.nowMs);
    const base = buildAlertPayload(context);

    if (!this.policy.enabled || this.policy.adapters.length === 0) {
      return null;
    }

    const key = makeDedupeKey(base, this.policy.dedupeScope);
    const previous = this.history.get(key);
    const occurrences = (previous?.occurrences ?? 0) + 1;

    if (previous !== undefined && emittedAtMs - previous.lastEmittedMs < this.policy.dedupeWindowMs) {
      this.history.set(key, {
        lastEmittedMs: previous.lastEmittedMs,
        occurrences,
      });
      return null;
    }

    this.history.set(key, {
      lastEmittedMs: emittedAtMs,
      occurrences,
    });

    const alert: ReplayAnomalyAlert = {
      ...base,
      repeatCount: occurrences,
      id: makeAlertId(base),
      emittedAtMs,
    };

    for (const adapter of this.policy.adapters) {
      await Promise.resolve(adapter.emit(alert));
    }

    return alert;
  }
}

class ReplayLoggerAdapter implements ReplayAlertAdapter {
  constructor(private readonly logger: Logger) {
  }

  emit(alert: ReplayAnomalyAlert): void {
    const payload = {
      id: alert.id,
      kind: alert.kind,
      code: alert.code,
      severity: alert.severity,
      message: alert.message,
      taskPda: alert.taskPda,
      disputePda: alert.disputePda,
      sourceEventName: alert.sourceEventName,
      signature: alert.signature,
      sourceEventSequence: alert.sourceEventSequence,
      slot: alert.slot,
      traceId: alert.traceId,
      repeatCount: alert.repeatCount,
      emittedAtMs: alert.emittedAtMs,
    };

    if (alert.severity === 'error') {
      this.logger.error('replay_alert', payload);
      return;
    }

    if (alert.severity === 'warning') {
      this.logger.warn('replay_alert', payload);
      return;
    }

    this.logger.info('replay_alert', payload);
  }
}

class ReplayWebhookAdapter implements ReplayAlertAdapter {
  private readonly timeoutMs: number;

  constructor(private readonly options: Omit<ReplayWebhookAdapterConfig, 'enabled'>) {
    this.timeoutMs = this.options.timeoutMs ?? 5_000;
  }

  private toPayload(alert: ReplayAnomalyAlert): Record<string, JsonValue> {
    return {
      id: alert.id,
      kind: alert.kind,
      code: alert.code,
      severity: alert.severity,
      message: alert.message,
      taskPda: alert.taskPda ?? null,
      disputePda: alert.disputePda ?? null,
      sourceEventName: alert.sourceEventName ?? null,
      signature: alert.signature ?? null,
      slot: alert.slot ?? null,
      sourceEventSequence: alert.sourceEventSequence ?? null,
      traceId: alert.traceId ?? null,
      metadata: this.normalizeMetadata(alert.metadata),
      occurredAtMs: alert.occurredAtMs ?? null,
      repeatCount: alert.repeatCount ?? null,
      emittedAtMs: alert.emittedAtMs,
    };
  }

  private normalizeMetadata(
    metadata?: Record<string, string | number | boolean | null | undefined>,
  ): Record<string, JsonValue> | null {
    if (!metadata) {
      return null;
    }

    const payload: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(metadata)) {
      payload[key] = value === undefined ? null : value;
    }

    return payload;
  }

  async emit(alert: ReplayAnomalyAlert): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.headers ?? {}),
        },
        body: stableStringifyJson(this.toPayload(alert)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ---------------------------------------------------------------------------
// Schema V1 type definition
// ---------------------------------------------------------------------------

/**
 * The canonical replay alert schema v1.
 * All fields are documented here as the contract for consumers.
 *
 * Required fields: id, code, severity, kind, message, emittedAtMs
 * Optional fields: taskPda, disputePda, sourceEventName, signature, slot,
 *   sourceEventSequence, traceId, metadata, occurredAtMs, repeatCount
 */
export interface ReplayAlertSchemaV1 {
  readonly schemaVersion: typeof REPLAY_ALERT_SCHEMA_VERSION;
  readonly id: string;
  readonly code: string;
  readonly severity: ReplayAlertSeverity;
  readonly kind: ReplayAlertKind;
  readonly message: string;
  readonly emittedAtMs: number;
  readonly taskPda?: string;
  readonly disputePda?: string;
  readonly sourceEventName?: string;
  readonly signature?: string;
  readonly slot?: number;
  readonly sourceEventSequence?: number;
  readonly traceId?: string;
  readonly metadata?: Record<string, string | number | boolean | null | undefined>;
  readonly occurredAtMs?: number;
  readonly repeatCount?: number;
}

// ---------------------------------------------------------------------------
// Schema compatibility check
// ---------------------------------------------------------------------------

export const REPLAY_ALERT_V1_REQUIRED_FIELDS = [
  'id', 'code', 'severity', 'kind', 'message', 'emittedAtMs',
] as const;

export const REPLAY_ALERT_V1_VALID_SEVERITIES: ReadonlySet<string> = new Set([
  'info', 'warning', 'error',
]);

export const REPLAY_ALERT_V1_VALID_KINDS: ReadonlySet<string> = new Set([
  'transition_validation',
  'replay_hash_mismatch',
  'replay_anomaly_repeat',
  'replay_ingestion_lag',
]);

export interface SchemaCompatibilityResult {
  compatible: boolean;
  schemaVersion: string;
  missingFields: string[];
  invalidFields: string[];
}

/**
 * Check if a given object conforms to the replay.alert.v1 schema.
 * Returns a structured result with compatibility status and error details.
 */
export function validateAlertSchema(payload: unknown): SchemaCompatibilityResult {
  const result: SchemaCompatibilityResult = {
    compatible: true,
    schemaVersion: REPLAY_ALERT_SCHEMA_VERSION,
    missingFields: [],
    invalidFields: [],
  };

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ...result, compatible: false, missingFields: [...REPLAY_ALERT_V1_REQUIRED_FIELDS] };
  }

  const record = payload as Record<string, unknown>;

  for (const field of REPLAY_ALERT_V1_REQUIRED_FIELDS) {
    if (!(field in record) || record[field] === undefined) {
      result.missingFields.push(field);
      result.compatible = false;
    }
  }

  if (typeof record.id !== 'string' || record.id.length === 0) {
    result.invalidFields.push('id: must be non-empty string');
    result.compatible = false;
  }
  if (typeof record.code !== 'string' || record.code.length === 0) {
    result.invalidFields.push('code: must be non-empty string');
    result.compatible = false;
  }
  if (!REPLAY_ALERT_V1_VALID_SEVERITIES.has(record.severity as string)) {
    result.invalidFields.push(`severity: must be one of ${[...REPLAY_ALERT_V1_VALID_SEVERITIES].join(', ')}`);
    result.compatible = false;
  }
  if (!REPLAY_ALERT_V1_VALID_KINDS.has(record.kind as string)) {
    result.invalidFields.push(`kind: must be one of ${[...REPLAY_ALERT_V1_VALID_KINDS].join(', ')}`);
    result.compatible = false;
  }
  if (typeof record.message !== 'string') {
    result.invalidFields.push('message: must be string');
    result.compatible = false;
  }
  if (typeof record.emittedAtMs !== 'number' || !Number.isFinite(record.emittedAtMs)) {
    result.invalidFields.push('emittedAtMs: must be finite number');
    result.compatible = false;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Anomaly set hash
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash of an anomaly set for incident evidence.
 *
 * The hash is computed over the sorted list of alert IDs, producing a
 * single SHA-256 hex string that uniquely identifies the set of anomalies.
 * Two incident windows with the same anomalies produce the same hash.
 */
export function computeAnomalySetHash(alerts: ReadonlyArray<ReplayAnomalyAlert>): string {
  const sortedIds = alerts
    .map((alert) => alert.id)
    .sort();
  const payload = stableStringifyJson(sortedIds as JsonValue);
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Compute anomaly set hash from raw alert contexts (before ID assignment).
 * Useful when alerts have not yet been dispatched.
 */
export function computeAnomalySetHashFromContexts(contexts: ReadonlyArray<ReplayAlertContext>): string {
  const ids = contexts.map((ctx) => {
    const base = buildAlertPayload(ctx);
    return makeAlertId(base);
  }).sort();
  return createHash('sha256').update(stableStringifyJson(ids as JsonValue)).digest('hex');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReplayAlertDispatcher(
  policy: ReplayAlertingPolicyOptions | undefined,
  logger?: Logger,
): ReplayAlertDispatcher {
  return new ReplayAlertDispatcher(policy, logger);
}
