import { createLogger, silentLogger, type Logger, type LogLevel } from '../utils/logger.js';
import { EventMonitor } from '../events/index.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type {
  BackfillFetcher,
  BackfillResult,
  ReplayEventCursor,
  ReplayTimelineQuery,
  ReplayTimelineRecord,
  ReplayTimelineStore,
} from './types.js';
import {
  FileReplayTimelineStore,
  InMemoryReplayTimelineStore,
  ReplayBackfillService,
} from './index.js';
import { computeProjectionHash } from './types.js';
import type { OnChainProjectionInput } from '../eval/projector.js';
import { projectOnChainEvents, type ProjectedTimelineEvent } from '../eval/projector.js';

export type ReplayBridgeStoreType = 'memory' | 'sqlite';

export interface ReplayBridgeStoreConfig {
  type: ReplayBridgeStoreType;
  sqlitePath?: string;
}

export interface ReplayBridgeConfig {
  enabled?: boolean;
  traceId?: string;
  projectionSeed?: number;
  store?: ReplayBridgeStoreConfig;
  strictProjection?: boolean;
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
    return new FileReplayTimelineStore(storeConfig.sqlitePath);
  }

  if (storeConfig.type === 'sqlite') {
    fallbackLogger.debug('ReplayBridge sqlite store requested without path, using memory fallback');
  }
  return new InMemoryReplayTimelineStore();
}

function toReplayStoreRecord(event: ProjectedTimelineEvent): ReplayTimelineRecord {
  const base = event.type;
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
  private running = false;

  private constructor(program: Program<AgencCoordination>, store: ReplayTimelineStore, options: ReplayBridgeConfig) {
    this.monitor = new EventMonitor({ program, logger: createReplayLogger(options) });
    this.logger = createReplayLogger(options);
    this.store = store;
    this.traceId = options.traceId ?? 'runtime-replay-bridge';
    this.projectionSeed = options.projectionSeed ?? 0;
    this.strictProjection = options.strictProjection ?? false;
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
      void this.ingest({
        eventName,
        event,
        slot,
        signature,
      }).catch((error) => {
        this.logger.warn(`Replay projection failed for ${eventName} event in slot ${slot}: ${error}`);
      });
    };
  }

  private async ingest(input: OnChainProjectionInput): Promise<void> {
    const projection = projectOnChainEvents([input], { traceId: this.traceId, seed: this.projectionSeed });
    const issues = strictTelemetryErrors(projection.telemetry);
    if (this.strictProjection && issues.length > 0) {
      this.logger.error(`Replay projection strict mode blocked event projection (${input.eventName})`);
      throw new Error(`Replay projection strict mode failed: ${issues.join('; ')}`);
    }

    const records = projection.events.map((entry) => toReplayStoreRecord(entry));
    if (records.length === 0) {
      return;
    }

    await this.store.save(records);
  }
}
