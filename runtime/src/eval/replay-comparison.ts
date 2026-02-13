/**
 * Deterministic replay comparison between on-chain projection timelines and local traces.
 *
 * @module
 */

import {
  EVAL_TRACE_SCHEMA_VERSION,
  canonicalizeTrajectoryTrace,
  type TrajectoryEvent,
  type TrajectoryTrace,
} from './types.js';
import {
  computeProjectionHash,
  type ReplayTimelineQuery,
  type ReplayTimelineRecord,
  type ReplayTimelineStore,
} from '../replay/types.js';
import {
  TrajectoryReplayEngine,
  type ReplaySummary,
  type TrajectoryReplayResult,
} from './replay.js';

export type ReplayComparisonStrictness = 'strict' | 'lenient';

export interface ReplayComparisonMetrics {
  counter(name: string, value?: number, labels?: Record<string, string>): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
}

export interface ReplayComparisonContext {
  taskPda?: string;
  disputePda?: string;
  sourceEventName?: string;
  sourceEventSequence?: number;
  signature?: string;
  seq?: number;
  eventType?: string;
  traceId?: string;
  traceSpanId?: string;
  traceParentSpanId?: string;
  traceSampled?: boolean;
}

export type ReplayAnomalyCode =
  | 'hash_mismatch'
  | 'missing_event'
  | 'unexpected_event'
  | 'type_mismatch'
  | 'task_id_mismatch'
  | 'duplicate_sequence'
  | 'transition_invalid';

export interface ReplayAnomaly {
  code: ReplayAnomalyCode;
  severity: 'error' | 'warning';
  message: string;
  context: ReplayComparisonContext;
  expected?: ReplayComparisonContext;
  observed?: ReplayComparisonContext;
}

export interface ReplayComparisonResult {
  strictness: ReplayComparisonStrictness;
  status: 'clean' | 'mismatched';
  durationMs: number;
  localEventCount: number;
  projectedEventCount: number;
  mismatchCount: number;
  matchRate: number;
  anomalies: ReplayAnomaly[];
  taskIds: string[];
  disputeIds: string[];
  localReplay: {
    deterministicHash: string;
    errors: string[];
    warnings: string[];
    summary: ReplaySummary;
  };
  projectedReplay: {
    deterministicHash: string;
    errors: string[];
    warnings: string[];
    summary: ReplaySummary;
  };
}

export interface ReplayComparisonOptions {
  strictness?: ReplayComparisonStrictness;
  taskPda?: string;
  disputePda?: string;
  traceId?: string;
  metrics?: ReplayComparisonMetrics;
}

export interface ReplayCompareInput {
  projected: readonly ReplayTimelineRecord[] | ReplayTimelineStore;
  localTrace: TrajectoryTrace;
  options?: ReplayComparisonOptions;
}

export class ReplayComparisonError extends Error {
  constructor(
    message: string,
    public readonly report: ReplayComparisonResult,
  ) {
    super(message);
    this.name = 'ReplayComparisonError';
  }
}

const DEFAULT_COMPARE_OPTIONS: Required<Pick<ReplayComparisonOptions, 'strictness'>> = {
  strictness: 'lenient',
};

const METRIC_NAMES = {
  TOTAL_COMPARISONS: 'agenc.replay.comparison.total',
  MISMATCH_COUNT: 'agenc.replay.comparison.mismatches',
  CLEAN_COUNT: 'agenc.replay.comparison.clean',
  MISMATCH_RATE: 'agenc.replay.comparison.mismatch_rate',
  RESOLUTION_LATENCY_MS: 'agenc.replay.comparison.resolution_latency_ms',
  HASH_MISMATCH: 'agenc.replay.comparison.anomaly.hash_mismatch',
  EVENT_MISMATCH: 'agenc.replay.comparison.anomaly.event_mismatch',
  TRANSITION_MISMATCH: 'agenc.replay.comparison.anomaly.transition_invalid',
} as const;

function replayReplayContextFromProjected(event: ReplayTimelineRecord): ReplayComparisonContext {
  const disputeId = event.disputePda ?? extractDisputeIdFromPayload(event.payload);

  return {
    seq: event.seq,
    taskPda: event.taskPda,
    disputePda: disputeId,
    sourceEventName: event.sourceEventName,
    sourceEventSequence: event.sourceEventSequence,
    signature: event.signature,
    eventType: event.type,
    traceId: event.traceId,
    traceSpanId: event.traceSpanId,
    traceParentSpanId: event.traceParentSpanId,
    traceSampled: event.traceSampled,
  };
}

function replayContextFromLocal(event: TrajectoryEvent): ReplayComparisonContext {
  const onchainTrace = event.payload.onchain as Record<string, unknown> | undefined;
  const trace = onchainTrace && typeof onchainTrace === 'object' ? (onchainTrace.trace as Record<string, unknown> | undefined) : undefined;

  return {
    seq: event.seq,
    taskPda: event.taskPda,
    disputePda: extractDisputeIdFromPayload(event.payload),
    eventType: event.type,
    signature: extractSignatureFromPayload(event.payload),
    traceId: typeof trace?.traceId === 'string' ? trace.traceId : undefined,
    traceSpanId: typeof trace?.spanId === 'string' ? trace.spanId : undefined,
    traceParentSpanId: typeof trace?.parentSpanId === 'string' ? trace.parentSpanId : undefined,
    traceSampled: trace?.sampled === true,
  };
}

function metricNameForAnomaly(code: ReplayAnomalyCode): string {
  if (code === 'hash_mismatch') {
    return METRIC_NAMES.HASH_MISMATCH;
  }
  if (code === 'transition_invalid') {
    return METRIC_NAMES.TRANSITION_MISMATCH;
  }
  return METRIC_NAMES.EVENT_MISMATCH;
}

function extractDisputeIdFromPayload(payload: Readonly<Record<string, unknown>>): string | undefined {
  const onchain = payload.onchain;
  if (typeof onchain === 'object' && onchain !== null) {
    const raw = (onchain as Record<string, unknown>).disputeId;
    if (typeof raw === 'string' && raw.length > 0) {
      return raw;
    }
  }

  const direct = payload.disputeId;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  return undefined;
}

function extractSignatureFromPayload(payload: Readonly<Record<string, unknown>>): string | undefined {
  const onchain = payload.onchain;
  if (typeof onchain === 'object' && onchain !== null) {
    const raw = (onchain as Record<string, unknown>).signature;
    if (typeof raw === 'string' && raw.length > 0) {
      return raw;
    }
  }

  return undefined;
}

function mergeAnomaly(
  anomalies: ReplayAnomaly[],
  anomaly: ReplayAnomaly,
): void {
  anomalies.push(anomaly);
}

export function makeReplayTraceFromRecords(
  records: readonly ReplayTimelineRecord[],
  seed: number,
  traceId = 'replay-comparison',
): TrajectoryTrace {
  const events: TrajectoryEvent[] = records.map((record) => ({
    seq: record.seq,
    type: record.type,
    taskPda: record.taskPda,
    timestampMs: record.timestampMs,
    payload: record.payload,
  }));

  return canonicalizeTrajectoryTrace({
    schemaVersion: EVAL_TRACE_SCHEMA_VERSION,
    traceId,
    seed,
    createdAtMs: 0,
    metadata: { source: 'projected_timeline' },
    events,
  });
}

export class ReplayComparisonService {
  async compare(input: ReplayCompareInput): Promise<ReplayComparisonResult> {
    const options: ReplayComparisonOptions = {
      ...DEFAULT_COMPARE_OPTIONS,
      ...input.options,
    };
    const strictness = options.strictness ?? 'lenient';
    const start = Date.now();

    const projectedEvents = await this.loadProjectedEvents(input.projected, options);
    const localEvents = this.filterLocalEvents(input.localTrace.events, options);

    const localTrace = canonicalizeTrajectoryTrace({
      ...input.localTrace,
      events: localEvents,
    });

    const projectedTrace = makeReplayTraceFromRecords(
      projectedEvents,
      localTrace.seed,
      options.traceId ?? localTrace.traceId,
    );

    const projectedReplay = new TrajectoryReplayEngine().replay(projectedTrace);
    const localReplay = new TrajectoryReplayEngine().replay(localTrace);

    const anomalies: ReplayAnomaly[] = [];

    this.compareEventSequences(projectedEvents, localEvents, anomalies);
    this.compareReplayTransitions(projectedReplay, localReplay, anomalies);
    this.compareReplayHashes(projectedReplay, localReplay, anomalies);
    this.compareRecordHashes(projectedEvents, anomalies);

    const sortedAnomalies = anomalies.sort((left, right) => {
      const leftSeq = left.context.seq ?? Number.MAX_SAFE_INTEGER;
      const rightSeq = right.context.seq ?? Number.MAX_SAFE_INTEGER;
      if (leftSeq !== rightSeq) {
        return leftSeq - rightSeq;
      }
      return left.code.localeCompare(right.code);
    });

    const localEventsCount = localEvents.length;
    const projectedEventsCount = projectedEvents.length;
    const divisor = Math.max(localEventsCount, projectedEventsCount, 1);
    const matchRate = Math.max(0, 1 - sortedAnomalies.length / divisor);
    const ids = this.collectIds(projectedEvents, localEvents);

    const result: ReplayComparisonResult = {
      strictness,
      status: sortedAnomalies.length === 0 ? 'clean' : 'mismatched',
      durationMs: Date.now() - start,
      localEventCount: localEventsCount,
      projectedEventCount: projectedEventsCount,
      mismatchCount: sortedAnomalies.length,
      matchRate,
      anomalies: sortedAnomalies,
      taskIds: ids.taskIds,
      disputeIds: ids.disputeIds,
      localReplay: {
        deterministicHash: localReplay.deterministicHash,
        errors: localReplay.errors,
        warnings: localReplay.warnings,
        summary: localReplay.summary,
      },
      projectedReplay: {
        deterministicHash: projectedReplay.deterministicHash,
        errors: projectedReplay.errors,
        warnings: projectedReplay.warnings,
        summary: projectedReplay.summary,
      },
    };

    if (options.metrics) {
      const labels = { strictness };
      options.metrics.counter(METRIC_NAMES.TOTAL_COMPARISONS, 1, labels);
      options.metrics.histogram(METRIC_NAMES.RESOLUTION_LATENCY_MS, result.durationMs, labels);

      if (result.status === 'mismatched') {
        options.metrics.counter(METRIC_NAMES.MISMATCH_COUNT, 1, labels);
        options.metrics.counter(METRIC_NAMES.MISMATCH_RATE, 1, {
          strictness,
          outcome: 'mismatch',
        });
      } else {
        options.metrics.counter(METRIC_NAMES.CLEAN_COUNT, 1, labels);
      }

      for (const anomaly of result.anomalies) {
        options.metrics.counter(metricNameForAnomaly(anomaly.code), 1, {
          strictness,
          code: anomaly.code,
        });
      }
    }

    if (strictness === 'strict' && result.status === 'mismatched') {
      const detail = sortedAnomalies
        .map((anomaly) => `${anomaly.code}:${anomaly.message}`)
        .join('; ');
      throw new ReplayComparisonError(`replay comparison failed: ${detail}`, result);
    }

    return result;
  }

  private async loadProjectedEvents(
    source: readonly ReplayTimelineRecord[] | ReplayTimelineStore,
    options: ReplayComparisonOptions,
  ): Promise<ReplayTimelineRecord[]> {
    const query: ReplayTimelineQuery = {
      taskPda: options.taskPda,
      disputePda: options.disputePda,
    };

    const records: readonly ReplayTimelineRecord[] = Array.isArray(source)
      ? [...source]
      : await (source as ReplayTimelineStore).query(query);

    return [...records]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => {
        if (left.seq !== right.seq) {
          return left.seq - right.seq;
        }
        if (left.slot !== right.slot) {
          return left.slot - right.slot;
        }
        if (left.signature !== right.signature) {
          return left.signature.localeCompare(right.signature);
        }
        return left.sourceEventType.localeCompare(right.sourceEventType);
      });
  }

  private filterLocalEvents(
    events: readonly TrajectoryEvent[],
    options: ReplayComparisonOptions,
  ): TrajectoryEvent[] {
    if (!options.taskPda && !options.disputePda) {
      return [...events];
    }

    return events.filter((event) => {
      const taskMatch = !options.taskPda || event.taskPda === options.taskPda;
      const disputeMatch = !options.disputePda
        || extractDisputeIdFromPayload(event.payload) === options.disputePda;

      return taskMatch && disputeMatch;
    });
  }

  private compareEventSequences(
    projectedEvents: readonly ReplayTimelineRecord[],
    localEvents: readonly TrajectoryEvent[],
    anomalies: ReplayAnomaly[],
  ): void {
    const projectedBySeq = new Map<number, ReplayTimelineRecord[]>();
    for (const event of projectedEvents) {
      const bucket = projectedBySeq.get(event.seq) ?? [];
      bucket.push(event);
      projectedBySeq.set(event.seq, bucket);
    }

    const localBySeq = new Map<number, TrajectoryEvent[]>();
    for (const event of localEvents) {
      const bucket = localBySeq.get(event.seq) ?? [];
      bucket.push(event);
      localBySeq.set(event.seq, bucket);
    }

    for (const bucket of projectedBySeq.values()) {
      if (bucket.length > 1) {
        for (const duplicate of bucket.slice(1)) {
          mergeAnomaly(anomalies, {
            code: 'duplicate_sequence',
            severity: 'warning',
            message: `duplicate projected event sequence ${duplicate.seq}`,
            context: replayReplayContextFromProjected(duplicate),
          });
        }
      }
    }

    for (const bucket of localBySeq.values()) {
      if (bucket.length > 1) {
        for (const duplicate of bucket.slice(1)) {
          mergeAnomaly(anomalies, {
            code: 'duplicate_sequence',
            severity: 'warning',
            message: `duplicate local event sequence ${duplicate.seq}`,
            context: replayContextFromLocal(duplicate),
          });
        }
      }
    }

    const allSeq = new Set<number>([
      ...projectedBySeq.keys(),
      ...localBySeq.keys(),
    ]);

    for (const seq of [...allSeq].sort((left, right) => left - right)) {
      const projected = projectedBySeq.get(seq)?.[0];
      const local = localBySeq.get(seq)?.[0];

      if (!projected && local) {
        mergeAnomaly(anomalies, {
          code: 'unexpected_event',
          severity: 'warning',
          message: `unexpected local event at seq=${seq}`,
          context: replayContextFromLocal(local),
          expected: { seq },
        });
        continue;
      }

      if (!local && projected) {
        mergeAnomaly(anomalies, {
          code: 'missing_event',
          severity: 'error',
          message: `missing local event at seq=${seq}`,
          context: replayReplayContextFromProjected(projected),
          observed: { seq },
        });
        continue;
      }

      if (!projected || !local) {
        continue;
      }

      if (projected.type !== local.type) {
        mergeAnomaly(anomalies, {
          code: 'type_mismatch',
          severity: 'error',
          message: `event type mismatch at seq=${seq}`,
          context: replayReplayContextFromProjected(projected),
          expected: { eventType: projected.type },
          observed: { eventType: local.type },
        });
      }

      if ((projected.taskPda ?? undefined) !== (local.taskPda ?? undefined)) {
        mergeAnomaly(anomalies, {
          code: 'task_id_mismatch',
          severity: 'error',
          message: `task identifier mismatch at seq=${seq}`,
          context: replayReplayContextFromProjected(projected),
          expected: { taskPda: projected.taskPda },
          observed: { taskPda: local.taskPda },
        });
      }

      if ((projected.signature ?? '') !== (extractSignatureFromPayload(local.payload) ?? '')) {
        mergeAnomaly(anomalies, {
          code: 'task_id_mismatch',
          severity: 'warning',
          message: `signature mismatch at seq=${seq}`,
          context: replayReplayContextFromProjected(projected),
          expected: { signature: projected.signature },
          observed: { signature: extractSignatureFromPayload(local.payload) },
        });
      }
    }
  }

  private compareReplayTransitions(
    projectedReplay: TrajectoryReplayResult,
    localReplay: TrajectoryReplayResult,
    anomalies: ReplayAnomaly[],
  ): void {
    this.pushReplayMessages('local', localReplay.errors, 'error', anomalies);
    this.pushReplayMessages('projected', projectedReplay.errors, 'error', anomalies);
    this.pushReplayMessages('local', localReplay.warnings, 'warning', anomalies);
    this.pushReplayMessages('projected', projectedReplay.warnings, 'warning', anomalies);
  }

  private pushReplayMessages(
    source: string,
    messages: string[],
    severity: ReplayAnomaly['severity'],
    anomalies: ReplayAnomaly[],
  ): void {
    for (const message of messages) {
      mergeAnomaly(anomalies, {
        code: 'transition_invalid',
        severity,
        message: `[${source}] ${message}`,
        context: {},
      });
    }
  }

  private compareReplayHashes(
    projectedReplay: TrajectoryReplayResult,
    localReplay: TrajectoryReplayResult,
    anomalies: ReplayAnomaly[],
  ): void {
    if (projectedReplay.deterministicHash === localReplay.deterministicHash) {
      return;
    }

    mergeAnomaly(anomalies, {
      code: 'hash_mismatch',
      severity: 'error',
      message: 'deterministic replay hash mismatch',
      context: {
        eventType: 'replay_hash',
      },
      expected: { signature: localReplay.deterministicHash },
      observed: { signature: projectedReplay.deterministicHash },
    });
  }

  private compareRecordHashes(
    projectedEvents: readonly ReplayTimelineRecord[],
    anomalies: ReplayAnomaly[],
  ): void {
    for (const event of projectedEvents) {
      const expected = computeProjectionHash(event);
      if (event.projectionHash !== expected) {
        mergeAnomaly(anomalies, {
          code: 'hash_mismatch',
          severity: 'error',
          message: 'projected event hash mismatch',
          context: replayReplayContextFromProjected(event),
          expected: { signature: expected },
          observed: { signature: event.projectionHash },
        });
      }
    }
  }

  private collectIds(
    projected: readonly ReplayTimelineRecord[],
    local: readonly TrajectoryEvent[],
  ): { taskIds: string[]; disputeIds: string[] } {
    const taskIds = new Set<string>();
    const disputeIds = new Set<string>();

    for (const event of projected) {
      if (event.taskPda) {
        taskIds.add(event.taskPda);
      }
      const disputeId = extractDisputeIdFromPayload(event.payload);
      if (disputeId) {
        disputeIds.add(disputeId);
      }
    }

    for (const event of local) {
      if (event.taskPda) {
        taskIds.add(event.taskPda);
      }
      const disputeId = extractDisputeIdFromPayload(event.payload);
      if (disputeId) {
        disputeIds.add(disputeId);
      }
    }

    return {
      taskIds: [...taskIds].sort(),
      disputeIds: [...disputeIds].sort(),
    };
  }
}
