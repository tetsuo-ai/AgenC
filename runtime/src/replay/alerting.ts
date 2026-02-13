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

export function createReplayAlertDispatcher(
  policy: ReplayAlertingPolicyOptions | undefined,
  logger?: Logger,
): ReplayAlertDispatcher {
  return new ReplayAlertDispatcher(policy, logger);
}
