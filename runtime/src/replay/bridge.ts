import { createLogger, silentLogger, type Logger, type LogLevel } from '../utils/logger.js';
import { EventMonitor } from '../events/index.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type {
  BackfillFetcher,
  BackfillResult,
  ReplayEventCursor,
  ReplayTimelineCompactionPolicy,
  ReplayTimelineRetentionPolicy,
  ReplayTimelineQuery,
  ReplayTimelineRecord,
  ReplayTimelineStore,
} from './types.js';
import {
  InMemoryReplayTimelineStore,
  ReplayBackfillService,
  SqliteReplayTimelineStore,
} from './index.js';
import {
  createReplayAlertDispatcher,
  type ReplayAlertDispatcher,
  type ReplayAlertingPolicyOptions,
} from './alerting.js';
import { computeProjectionHash } from './types.js';
import {
  buildReplayTraceContext,
  DEFAULT_TRACE_SAMPLE_RATE,
  buildReplaySpanEvent,
  buildReplaySpanName,
  startReplaySpan,
  type ReplayTracingPolicy,
} from './trace.js';
import type { OnChainProjectionInput } from '../eval/projector.js';
import { projectOnChainEvents, type ProjectedTimelineEvent } from '../eval/projector.js';

export type ReplayBridgeStoreType = 'memory' | 'sqlite';

export interface ReplayBridgeStoreConfig {
  type: ReplayBridgeStoreType;
  sqlitePath?: string;
  retention?: ReplayTimelineRetentionPolicy;
  compaction?: ReplayTimelineCompactionPolicy;
}

export interface ReplayBridgeConfig {
  enabled?: boolean;
  traceId?: string;
  tracing?: ReplayTracingPolicy;
  projectionSeed?: number;
  store?: ReplayBridgeStoreConfig;
  strictProjection?: boolean;
  alerting?: ReplayAlertingPolicyOptions;
  logger?: Logger;
  traceLevel?: LogLevel;
}

export interface ReplayBridgeBackfillOptions {
  toSlot: number;
  fetcher: BackfillFetcher;
  pageSize?: number;
  traceId?: string;
}

export interface ReplayBridgeHandle {
  start(): Promise<void>;
  runBackfill(options: ReplayBridgeBackfillOptions): Promise<BackfillResult>;
  getStore(): ReplayTimelineStore;
  query(query?: ReplayTimelineQuery): Promise<ReadonlyArray<ReplayTimelineRecord>>;
  getCursor(): Promise<ReplayEventCursor | null>;
  clear(): Promise<void>;
  saveCursor(cursor: ReplayEventCursor | null): Promise<void>;
  stop(): Promise<void>;
}

const EVENT_MONITOR_EVENT_NAMES = [
  'taskCreated',
  'taskClaimed',
  'taskCompleted',
  'taskCancelled',
  'dependentTaskCreated',
  'disputeInitiated',
  'disputeVoteCast',
  'disputeResolved',
  'disputeExpired',
  'disputeCancelled',
  'arbiterVotesCleanedUp',
  'stateUpdated',
  'protocolInitialized',
  'rewardDistributed',
  'rateLimitHit',
  'migrationCompleted',
  'protocolVersionUpdated',
  'rateLimitsUpdated',
  'protocolFeeUpdated',
  'reputationChanged',
  'bondDeposited',
  'bondLocked',
  'bondReleased',
  'bondSlashed',
  'speculativeCommitmentCreated',
  'agentRegistered',
  'agentUpdated',
  'agentDeregistered',
  'agentSuspended',
  'agentUnsuspended',
] as const;

function createReplayLogger(
  options: ReplayBridgeConfig,
): Logger {
  if (options.logger) {
    return options.logger;
  }

  if (options.traceLevel) {
    return createLogger(options.traceLevel, '[ReplayEventBridge]');
  }

  return silentLogger;
}

function buildStore(
  options: ReplayBridgeConfig,
  fallbackLogger: Logger,
): ReplayTimelineStore {
  const storeConfig = options.store ?? { type: 'memory' as const };
  if (storeConfig.type === 'sqlite' && storeConfig.sqlitePath) {
    fallbackLogger.debug(`ReplayBridge using sqlite store at ${storeConfig.sqlitePath}`);
    return new SqliteReplayTimelineStore(storeConfig.sqlitePath, {
      retention: storeConfig.retention,
      compaction: storeConfig.compaction,
    });
  }

  if (storeConfig.type === 'sqlite') {
    fallbackLogger.debug('ReplayBridge sqlite store requested without path, using memory fallback');
  }
  return new InMemoryReplayTimelineStore();
}

function toReplayStoreRecord(event: ProjectedTimelineEvent): ReplayTimelineRecord {
  const base = event.type;
  const trace = (event.payload.onchain as Record<string, unknown> | undefined)?.trace as
    | undefined
    | { traceId?: string; spanId?: string; parentSpanId?: string; sampled?: boolean };
  const recordEvent: Omit<ReplayTimelineRecord, 'projectionHash'> = {
    seq: event.seq,
    type: event.type,
    taskPda: event.taskPda,
    timestampMs: event.timestampMs,
    payload: event.payload,
    slot: event.slot,
    signature: event.signature,
    sourceEventName: event.sourceEventName,
    sourceEventType: base,
    sourceEventSequence: event.sourceEventSequence,
    traceId: trace?.traceId,
    traceSpanId: trace?.spanId,
    traceParentSpanId: trace?.parentSpanId,
    traceSampled: trace?.sampled === true,
  };

  return {
    ...recordEvent,
    projectionHash: computeProjectionHash({
      ...recordEvent,
      sourceEventName: event.sourceEventName,
      sourceEventSequence: event.sourceEventSequence,
    } as unknown as Parameters<typeof computeProjectionHash>[0]),
  };
}

function strictTelemetryErrors(telemetry: ReturnType<typeof projectOnChainEvents>['telemetry']): string[] {
  return [
    ...telemetry.malformedInputs.map((issue) => `malformed:${issue}`),
    ...telemetry.unknownEvents.map((eventName) => `unknown:${eventName}`),
    ...telemetry.transitionConflicts.map((message) => `transition:${message}`),
  ];
}

export class ReplayEventBridge {
  private readonly monitor: EventMonitor;
  private readonly logger: Logger;
  private readonly store: ReplayTimelineStore;
  private readonly traceId: string;
  private readonly projectionSeed: number;
  private readonly strictProjection: boolean;
  private readonly tracing: ReplayTracingPolicy;
  private readonly traceSampleRate: number;
  private readonly alertDispatcher: ReplayAlertDispatcher;
  private readonly sourceEventLastSlot = new Map<string, number>();
  private intakeSequence = 0;
  private running = false;

  private constructor(program: Program<AgencCoordination>, store: ReplayTimelineStore, options: ReplayBridgeConfig) {
    this.monitor = new EventMonitor({ program, logger: createReplayLogger(options) });
    this.logger = createReplayLogger(options);
    this.store = store;
    this.traceId = options.traceId ?? 'runtime-replay-bridge';
    this.projectionSeed = options.projectionSeed ?? 0;
    this.strictProjection = options.strictProjection ?? false;
    this.tracing = options.tracing ?? {};
    this.traceSampleRate = this.tracing.sampleRate ?? DEFAULT_TRACE_SAMPLE_RATE;
    this.alertDispatcher = createReplayAlertDispatcher(options.alerting, this.logger);
  }

  static create(
    program: Program<AgencCoordination>,
    options: ReplayBridgeConfig = {},
  ): ReplayBridgeHandle {
    const logger = createReplayLogger(options);
    const store = buildStore(options, logger);
    const bridge = new ReplayEventBridge(program, store, options);

    return {
      start: bridge.start.bind(bridge),
      runBackfill: bridge.runBackfill.bind(bridge),
      getStore: bridge.getStore.bind(bridge),
      query: bridge.query.bind(bridge),
      getCursor: bridge.getCursor.bind(bridge),
      clear: bridge.clear.bind(bridge),
      saveCursor: bridge.saveCursor.bind(bridge),
      stop: bridge.stop.bind(bridge),
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.monitor.subscribeToTaskEvents({
      onTaskCreated: this.capture('taskCreated'),
      onTaskClaimed: this.capture('taskClaimed'),
      onTaskCompleted: this.capture('taskCompleted'),
      onTaskCancelled: this.capture('taskCancelled'),
      onDependentTaskCreated: this.capture('dependentTaskCreated'),
    });
    this.monitor.subscribeToDisputeEvents({
      onDisputeInitiated: this.capture('disputeInitiated'),
      onDisputeVoteCast: this.capture('disputeVoteCast'),
      onDisputeResolved: this.capture('disputeResolved'),
      onDisputeExpired: this.capture('disputeExpired'),
      onDisputeCancelled: this.capture('disputeCancelled'),
      onArbiterVotesCleanedUp: this.capture('arbiterVotesCleanedUp'),
    });
    this.monitor.subscribeToProtocolEvents({
      onStateUpdated: this.capture('stateUpdated'),
      onProtocolInitialized: this.capture('protocolInitialized'),
      onRewardDistributed: this.capture('rewardDistributed'),
      onRateLimitHit: this.capture('rateLimitHit'),
      onMigrationCompleted: this.capture('migrationCompleted'),
      onProtocolVersionUpdated: this.capture('protocolVersionUpdated'),
      onRateLimitsUpdated: this.capture('rateLimitsUpdated'),
      onProtocolFeeUpdated: this.capture('protocolFeeUpdated'),
      onReputationChanged: this.capture('reputationChanged'),
      onBondDeposited: this.capture('bondDeposited'),
      onBondLocked: this.capture('bondLocked'),
      onBondReleased: this.capture('bondReleased'),
      onBondSlashed: this.capture('bondSlashed'),
      onSpeculativeCommitmentCreated: this.capture('speculativeCommitmentCreated'),
    });
    this.monitor.subscribeToAgentEvents({
      onRegistered: this.capture('agentRegistered'),
      onUpdated: this.capture('agentUpdated'),
      onDeregistered: this.capture('agentDeregistered'),
      onSuspended: this.capture('agentSuspended'),
      onUnsuspended: this.capture('agentUnsuspended'),
    });

    this.monitor.start();
    this.running = true;
    this.logger.info('Replay bridge started');
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    await this.monitor.stop();
    this.running = false;
    this.logger.info('Replay bridge stopped');
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  async runBackfill(options: ReplayBridgeBackfillOptions): Promise<BackfillResult> {
    const service = new ReplayBackfillService(
      this.store,
      {
        toSlot: options.toSlot,
        fetcher: options.fetcher,
        pageSize: options.pageSize,
        alertDispatcher: this.alertDispatcher,
        tracePolicy: {
          traceId: options.traceId ?? this.tracing.traceId ?? this.traceId,
          sampleRate: this.traceSampleRate,
          emitOtel: this.tracing.emitOtel,
        },
      },
    );
    return service.runBackfill();
  }

  async query(query?: ReplayTimelineQuery): Promise<ReadonlyArray<ReplayTimelineRecord>> {
    return this.store.query(query);
  }

  async getCursor(): Promise<ReplayEventCursor | null> {
    return this.store.getCursor();
  }

  async clear(): Promise<void> {
    return this.store.clear();
  }

  async saveCursor(cursor: ReplayEventCursor | null): Promise<void> {
    return this.store.saveCursor(cursor);
  }

  getStore(): ReplayTimelineStore {
    return this.store;
  }

  private capture(eventName: (typeof EVENT_MONITOR_EVENT_NAMES)[number]) {
    return (event: unknown, slot: number, signature: string): void => {
      const sequence = this.intakeSequence++;
      const traceContext = buildReplayTraceContext({
        traceId: this.tracing.traceId ?? this.traceId,
        eventName,
        slot,
        signature,
        eventSequence: sequence,
        sampleRate: this.traceSampleRate,
      });

      void this.ingest({
        eventName,
        event,
        slot,
        signature,
        sourceEventSequence: sequence,
        traceContext,
      }).catch((error) => {
        this.logger.warn(`Replay projection failed for ${eventName} event in slot ${slot}: ${error}`);
      });
    };
  }

  private async ingest(input: OnChainProjectionInput): Promise<void> {
    const previousSlot = this.sourceEventLastSlot.get(input.eventName);
    if (typeof previousSlot === 'number' && input.slot < previousSlot) {
      await this.emitReplayAlert({
        code: 'replay.ingestion.lag',
        severity: 'warning',
        kind: 'replay_ingestion_lag',
        message: `event slot regression detected for ${input.eventName}`,
        taskPda: extractTaskFromEvent(input),
        disputePda: extractDisputeFromEvent(input),
        sourceEventName: input.eventName,
        signature: input.signature,
        slot: input.slot,
        sourceEventSequence: input.sourceEventSequence,
        traceId: input.traceContext?.traceId ?? this.traceId,
      });
    }
    this.sourceEventLastSlot.set(input.eventName, input.slot);

    const traceContext = input.traceContext
      ?? buildReplayTraceContext({
        traceId: this.tracing.traceId ?? this.traceId,
        eventName: input.eventName,
        slot: input.slot,
        signature: input.signature,
        eventSequence: input.sourceEventSequence ?? 0,
        sampleRate: this.traceSampleRate,
      });

    const eventForProjection = {
      ...input,
      traceContext,
      sourceEventSequence: input.sourceEventSequence,
    };

    const intakeSpan = startReplaySpan({
      name: buildReplaySpanName('replay.intake', {
        slot: input.slot,
        signature: input.signature,
      }),
      trace: traceContext,
      emitOtel: this.tracing.emitOtel,
      attributes: buildReplaySpanEvent('replay.intake', {
        slot: input.slot,
        signature: input.signature,
        sourceEventSequence: input.sourceEventSequence,
      }),
    });

    const projectionSpan = startReplaySpan({
      name: buildReplaySpanName('replay.projector', {
        slot: input.slot,
        signature: input.signature,
      }),
      trace: traceContext,
      emitOtel: this.tracing.emitOtel,
      attributes: buildReplaySpanEvent('replay.projector', {
        slot: input.slot,
        signature: input.signature,
        sourceEventSequence: input.sourceEventSequence,
      }),
    });

    const saveSpan = startReplaySpan({
      name: buildReplaySpanName('replay.store.save', {
        slot: input.slot,
        signature: input.signature,
      }),
      trace: traceContext,
      emitOtel: this.tracing.emitOtel,
      attributes: buildReplaySpanEvent('replay.store.save', {
        slot: input.slot,
        signature: input.signature,
        sourceEventSequence: input.sourceEventSequence,
      }),
    });

    let projection: ReturnType<typeof projectOnChainEvents>;
    try {
      projection = projectOnChainEvents([eventForProjection], {
        traceId: this.traceId,
        seed: this.projectionSeed,
      });
    } catch (error) {
      projectionSpan.end(error);
      saveSpan.end(error);
      intakeSpan.end(error);
      throw error;
    }

    projectionSpan.end();

    const records = projection.events.map((entry) => toReplayStoreRecord(entry));
    if (records.length === 0) {
      saveSpan.end();
      intakeSpan.end();
      return;
    }

    try {
      await this.store.save(records);
      saveSpan.end();
      await this.emitProjectionTelemetry({
        ...input,
        traceContext,
      }, projection);

      const issues = strictTelemetryErrors(projection.telemetry);
      if (this.strictProjection && issues.length > 0) {
        this.logger.error(`Replay projection strict mode blocked event projection (${input.eventName})`);
        throw new Error(`Replay projection strict mode failed: ${issues.join('; ')}`);
      }

      intakeSpan.end();
    } catch (error) {
      saveSpan.end(error);
      intakeSpan.end(error);
      throw error;
    }
  }

  private async emitProjectionTelemetry(
    input: OnChainProjectionInput,
    projection: ReturnType<typeof projectOnChainEvents>,
  ): Promise<void> {
    const malformedIssueCount = projection.telemetry.malformedInputs.length;
    const unknownIssueCount = projection.telemetry.unknownEvents.length;

    if (malformedIssueCount > 0) {
      await this.emitReplayAlert({
        code: 'replay.projection.malformed',
        severity: malformedIssueCount > 3 ? 'error' : 'warning',
        kind: 'transition_validation',
        message: `malformed projection input for ${input.eventName}`,
        taskPda: extractTaskFromEvent(input),
        disputePda: extractDisputeFromEvent(input),
        sourceEventName: input.eventName,
        signature: input.signature,
        slot: input.slot,
        sourceEventSequence: input.sourceEventSequence,
        traceId: input.traceContext?.traceId ?? this.traceId,
        metadata: {
          issueCount: malformedIssueCount,
          issues: projection.telemetry.malformedInputs.join('|'),
        },
      });
    }

    if (unknownIssueCount > 0) {
      await this.emitReplayAlert({
        code: 'replay.projection.unknown',
        severity: 'warning',
        kind: 'transition_validation',
        message: `unknown event variant for ${input.eventName}`,
        taskPda: extractTaskFromEvent(input),
        disputePda: extractDisputeFromEvent(input),
        sourceEventName: input.eventName,
        signature: input.signature,
        slot: input.slot,
        sourceEventSequence: input.sourceEventSequence,
        traceId: input.traceContext?.traceId ?? this.traceId,
        metadata: {
          unknownEventCount: unknownIssueCount,
          events: projection.telemetry.unknownEvents.join('|'),
        },
      });
    }

    for (const violation of projection.telemetry.transitionViolations) {
      await this.emitReplayAlert({
        code: 'replay.projection.transition_invalid',
        severity: violation.scope === 'dispute' || violation.scope === 'speculation' ? 'error' : 'warning',
        kind: 'transition_validation',
        message: `transition violation ${violation.scope}: ${violation.reason}`,
        taskPda: violation.scope === 'task' ? violation.entityId : extractTaskFromEvent(input),
        disputePda: violation.scope === 'dispute' ? violation.entityId : extractDisputeFromEvent(input),
        sourceEventName: violation.eventName,
        signature: violation.signature,
        slot: violation.slot,
        sourceEventSequence: violation.sourceEventSequence,
        traceId: input.traceContext?.traceId ?? this.traceId,
        metadata: {
          scope: violation.scope,
          fromState: violation.fromState,
          toState: violation.toState,
          reason: violation.reason,
        },
      });
    }
  }

  private async emitReplayAlert(context: {
    code: string;
    severity: 'info' | 'warning' | 'error';
    kind: 'transition_validation' | 'replay_hash_mismatch' | 'replay_anomaly_repeat' | 'replay_ingestion_lag';
    message: string;
    taskPda?: string;
    disputePda?: string;
    sourceEventName?: string;
    signature?: string;
    slot?: number;
    sourceEventSequence?: number;
    traceId?: string;
    metadata?: Record<string, string | number | boolean | null | undefined>;
  }): Promise<void> {
    try {
      await this.alertDispatcher.emit(context);
    } catch (error) {
      this.logger.warn('replay alert dispatch failed', error);
    }
  }
}

function extractTaskFromEvent(input: OnChainProjectionInput): string | undefined {
  if (typeof input.event !== 'object' || input.event === null) {
    return undefined;
  }

  const event = input.event as Record<string, unknown>;
  const candidate = event.taskId ?? event.task;
  return typeof candidate === 'string' ? candidate : undefined;
}

function extractDisputeFromEvent(input: OnChainProjectionInput): string | undefined {
  if (typeof input.event !== 'object' || input.event === null) {
    return undefined;
  }

  const event = input.event as Record<string, unknown>;
  const candidate = event.disputeId;
  return typeof candidate === 'string' ? candidate : undefined;
}
