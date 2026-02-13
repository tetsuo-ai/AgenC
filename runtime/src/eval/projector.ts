/**
 * Deterministic projection from parsed on-chain events to replay trajectory records.
 *
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import { bytesToHex } from '../utils/encoding.js';
import type {
  AgentDeregisteredEvent,
  AgentRegisteredEvent,
  AgentSuspendedEvent,
  AgentUnsuspendedEvent,
  AgentUpdatedEvent,
} from '../agent/types.js';
import type {
  ArbiterVotesCleanedUpEvent,
  BondDepositedEvent,
  BondLockedEvent,
  BondReleasedEvent,
  BondSlashedEvent,
  DependentTaskCreatedEvent,
  DisputeCancelledEvent,
  DisputeExpiredEvent,
  DisputeInitiatedEvent,
  DisputeResolvedEvent,
  DisputeVoteCastEvent,
  MigrationCompletedEvent,
  ProtocolFeeUpdatedEvent,
  ProtocolInitializedEvent,
  ProtocolVersionUpdatedEvent,
  RateLimitHitEvent,
  RateLimitsUpdatedEvent,
  ReputationChangedEvent,
  RewardDistributedEvent,
  SpeculativeCommitmentCreatedEvent,
  StateUpdatedEvent,
  TaskCancelledEvent,
  TaskClaimedEvent,
  TaskCompletedEvent,
  TaskCreatedEvent,
} from '../events/types.js';
import {
  stableStringifyJson,
  type JsonObject,
  type JsonValue,
  type TrajectoryEvent,
  type TrajectoryTrace,
  EVAL_TRACE_SCHEMA_VERSION,
} from './types.js';

export interface OnChainProjectionInput {
  eventName: string;
  event: unknown;
  slot: number;
  signature: string;
  timestampMs?: number;
}

export interface ProjectedTimelineEvent extends TrajectoryEvent {
  slot: number;
  signature: string;
  sourceEventName: string;
  sourceEventSequence: number;
}

export interface ProjectionTelemetry {
  totalInputs: number;
  projectedEvents: number;
  duplicatesDropped: number;
  unknownEvents: string[];
  transitionConflicts: string[];
  malformedInputs: string[];
}

export interface ProjectionResult {
  trace: TrajectoryTrace;
  events: ProjectedTimelineEvent[];
  telemetry: ProjectionTelemetry;
}

export interface ProjectionOptions {
  traceId?: string;
  seed?: number;
}

type TaskLifecycleState = 'discovered' | 'claimed' | 'completed' | 'failed';
type DisputeLifecycleState = 'dispute:initiated' | 'dispute:vote_cast' | 'dispute:resolved' | 'dispute:cancelled' | 'dispute:expired';
type SpeculationLifecycleState = 'speculation_started' | 'speculation_confirmed' | 'speculation_aborted';

interface OnChainEventMap {
  taskCreated: TaskCreatedEvent;
  taskClaimed: TaskClaimedEvent;
  taskCompleted: TaskCompletedEvent;
  taskCancelled: TaskCancelledEvent;
  dependentTaskCreated: DependentTaskCreatedEvent;
  disputeInitiated: DisputeInitiatedEvent;
  disputeVoteCast: DisputeVoteCastEvent;
  disputeResolved: DisputeResolvedEvent;
  disputeExpired: DisputeExpiredEvent;
  disputeCancelled: DisputeCancelledEvent;
  arbiterVotesCleanedUp: ArbiterVotesCleanedUpEvent;
  stateUpdated: StateUpdatedEvent;
  protocolInitialized: ProtocolInitializedEvent;
  rewardDistributed: RewardDistributedEvent;
  rateLimitHit: RateLimitHitEvent;
  migrationCompleted: MigrationCompletedEvent;
  protocolVersionUpdated: ProtocolVersionUpdatedEvent;
  rateLimitsUpdated: RateLimitsUpdatedEvent;
  protocolFeeUpdated: ProtocolFeeUpdatedEvent;
  reputationChanged: ReputationChangedEvent;
  bondDeposited: BondDepositedEvent;
  bondLocked: BondLockedEvent;
  bondReleased: BondReleasedEvent;
  bondSlashed: BondSlashedEvent;
  speculativeCommitmentCreated: SpeculativeCommitmentCreatedEvent;
  agentRegistered: AgentRegisteredEvent;
  agentUpdated: AgentUpdatedEvent;
  agentDeregistered: AgentDeregisteredEvent;
  agentSuspended: AgentSuspendedEvent;
  agentUnsuspended: AgentUnsuspendedEvent;
}

const KNOWN_EVENT_NAMES = new Map<string, keyof OnChainEventMap>([
  ['taskCreated', 'taskCreated'],
  ['taskClaimed', 'taskClaimed'],
  ['taskCompleted', 'taskCompleted'],
  ['taskCancelled', 'taskCancelled'],
  ['dependentTaskCreated', 'dependentTaskCreated'],
  ['disputeInitiated', 'disputeInitiated'],
  ['disputeVoteCast', 'disputeVoteCast'],
  ['disputeResolved', 'disputeResolved'],
  ['disputeExpired', 'disputeExpired'],
  ['disputeCancelled', 'disputeCancelled'],
  ['arbiterVotesCleanedUp', 'arbiterVotesCleanedUp'],
  ['stateUpdated', 'stateUpdated'],
  ['protocolInitialized', 'protocolInitialized'],
  ['rewardDistributed', 'rewardDistributed'],
  ['rateLimitHit', 'rateLimitHit'],
  ['migrationCompleted', 'migrationCompleted'],
  ['protocolVersionUpdated', 'protocolVersionUpdated'],
  ['rateLimitsUpdated', 'rateLimitsUpdated'],
  ['protocolFeeUpdated', 'protocolFeeUpdated'],
  ['reputationChanged', 'reputationChanged'],
  ['bondDeposited', 'bondDeposited'],
  ['bondLocked', 'bondLocked'],
  ['bondReleased', 'bondReleased'],
  ['bondSlashed', 'bondSlashed'],
  ['speculativeCommitmentCreated', 'speculativeCommitmentCreated'],
  ['agentRegistered', 'agentRegistered'],
  ['agentUpdated', 'agentUpdated'],
  ['agentDeregistered', 'agentDeregistered'],
  ['agentSuspended', 'agentSuspended'],
  ['agentUnsuspended', 'agentUnsuspended'],
]);

const TRAJECTORY_EVENT_BY_SOURCE: Record<keyof OnChainEventMap, string> = {
  taskCreated: 'discovered',
  taskClaimed: 'claimed',
  taskCompleted: 'completed',
  taskCancelled: 'failed',
  dependentTaskCreated: 'discovered',
  disputeInitiated: 'dispute:initiated',
  disputeVoteCast: 'dispute:vote_cast',
  disputeResolved: 'dispute:resolved',
  disputeExpired: 'dispute:expired',
  disputeCancelled: 'dispute:cancelled',
  arbiterVotesCleanedUp: 'dispute:arbiter_votes_cleaned_up',
  stateUpdated: 'protocol:state_updated',
  protocolInitialized: 'protocol:protocol_initialized',
  rewardDistributed: 'protocol:reward_distributed',
  rateLimitHit: 'protocol:rate_limit_hit',
  migrationCompleted: 'protocol:migration_completed',
  protocolVersionUpdated: 'protocol:protocol_version_updated',
  rateLimitsUpdated: 'protocol:rate_limits_updated',
  protocolFeeUpdated: 'protocol:protocol_fee_updated',
  reputationChanged: 'protocol:reputation_changed',
  bondDeposited: 'bond:deposited',
  bondLocked: 'bond:locked',
  bondReleased: 'speculation_confirmed',
  bondSlashed: 'speculation_aborted',
  speculativeCommitmentCreated: 'speculation_started',
  agentRegistered: 'agent:registered',
  agentUpdated: 'agent:updated',
  agentDeregistered: 'agent:deregistered',
  agentSuspended: 'agent:suspended',
  agentUnsuspended: 'agent:unsuspended',
};

const TASK_TRANSITIONS: Record<Extract<TaskLifecycleState, string>, Set<string>> = {
  discovered: new Set(['claimed', 'failed']),
  claimed: new Set(['completed', 'failed']),
  completed: new Set(),
  failed: new Set(),
};

const DISPUTE_TRANSITIONS: Record<DisputeLifecycleState, Set<string>> = {
  'dispute:initiated': new Set([
    'dispute:vote_cast',
    'dispute:resolved',
    'dispute:cancelled',
    'dispute:expired',
  ]),
  'dispute:vote_cast': new Set([
    'dispute:resolved',
    'dispute:cancelled',
    'dispute:expired',
  ]),
  'dispute:resolved': new Set(),
  'dispute:cancelled': new Set(),
  'dispute:expired': new Set(),
};

const SPECULATION_TRANSITIONS: Record<SpeculationLifecycleState, Set<string>> = {
  speculation_started: new Set([
    'speculation_confirmed',
    'speculation_aborted',
  ]),
  speculation_confirmed: new Set(),
  speculation_aborted: new Set(),
};

const TASK_EVENT_TYPES = new Set<string>([
  'discovered',
  'claimed',
  'completed',
  'failed',
]);
const DISPUTE_LIFECYCLE_EVENT_TYPES = new Set<string>([
  'dispute:initiated',
  'dispute:vote_cast',
  'dispute:resolved',
  'dispute:cancelled',
  'dispute:expired',
]);
const SPECULATION_EVENT_TYPES = new Set<string>([
  'speculation_started',
  'speculation_confirmed',
  'speculation_aborted',
]);

const EVENT_SORT_ORDER: Readonly<Record<string, number>> = {
  discovered: 10,
  claimed: 20,
  completed: 30,
  failed: 40,
  'speculation_started': 50,
  'speculation_confirmed': 60,
  'speculation_aborted': 70,
  'dispute:initiated': 80,
  'dispute:vote_cast': 90,
  'dispute:resolved': 100,
  'dispute:cancelled': 110,
  'dispute:expired': 120,
  'dispute:arbiter_votes_cleaned_up': 130,
  'agent:registered': 140,
  'agent:updated': 150,
  'agent:deregistered': 160,
  'agent:suspended': 170,
  'agent:unsuspended': 180,
  'protocol:state_updated': 190,
  'protocol:protocol_initialized': 200,
  'protocol:reward_distributed': 210,
  'protocol:rate_limit_hit': 220,
  'protocol:migration_completed': 230,
  'protocol:protocol_version_updated': 240,
  'protocol:rate_limits_updated': 250,
  'protocol:protocol_fee_updated': 260,
  'protocol:reputation_changed': 270,
  'bond:deposited': 280,
  'bond:locked': 290,
  'bond:released': 291,
  'bond:slashed': 292,
};

function sanitizeJson(value: unknown): JsonValue {
  if (value === null) return null;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return String(value);
    }
    return value;
  }

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (value instanceof PublicKey) return value.toBase58();

  if (Array.isArray(value)) return value.map((entry) => sanitizeJson(entry));
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const output: JsonObject = {};
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, entry] of entries) {
      output[key] = sanitizeJson(entry);
    }
    return output;
  }

  return String(value);
}

function sanitizePayload(payload: unknown): JsonObject {
  const value = sanitizeJson(payload);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { value };
  }
  return value as JsonObject;
}

function toPublicKeyString(value: unknown): string | undefined {
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return bytesToPublicKeyString(value);
  if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    return bytesToPublicKeyString(new Uint8Array(value));
  }
  return undefined;
}

function bytesToPublicKeyString(bytes: Uint8Array): string | undefined {
  if (bytes.length !== 32) return bytesToHex(bytes);
  try {
    return new PublicKey(bytes).toBase58();
  } catch {
    return bytesToHex(bytes);
  }
}

function getContext(eventName: keyof OnChainEventMap, event: Record<string, unknown>): {
  taskPda?: string;
  disputePda?: string;
  speculationPda?: string;
} {
  return {
    taskPda: toPublicKeyString(event.taskId ?? event.task),
    disputePda: toPublicKeyString(event.disputeId),
    speculationPda: eventName === 'speculativeCommitmentCreated'
      ? toPublicKeyString(event.task)
      : (eventName === 'bondReleased' || eventName === 'bondSlashed')
        ? toPublicKeyString(event.commitment)
        : undefined,
  };
}

function isTransitionAllowed(
  transitions: Record<string, ReadonlySet<string>>,
  previous: string | undefined,
  next: string,
): boolean {
  if (!previous) return false;
  return transitions[previous]?.has(next) ?? false;
}

function transitionConflictMessage(parts: string[], context: string, fromState: string, toState: string): string {
  return `${context}: ${fromState} -> ${toState} ${parts.join('/')}`;
}

function buildFingerprint(slot: number, signature: string, eventName: string, event: unknown): string {
  return stableStringifyJson({
    slot,
    signature,
    eventName,
    eventPayload: sanitizePayload(event),
  });
}

function eventSortRank(eventType: string): number {
  return EVENT_SORT_ORDER[eventType] ?? 1_000;
}

function resolveTimestamp(
  input: OnChainProjectionInput,
  event: unknown,
): number {
  if (typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs) && input.timestampMs >= 0) {
    return input.timestampMs;
  }

  if (typeof event === 'object' && event !== null && 'timestamp' in event) {
    const eventTimestamp = event.timestamp;
    if (typeof eventTimestamp === 'number' && Number.isFinite(eventTimestamp) && eventTimestamp >= 0) {
      return eventTimestamp;
    }
  }

  return 0;
}

/**
 * Project parsed on-chain events into deterministic, replayable trajectory records.
 */
export function projectOnChainEvents(
  events: ReadonlyArray<OnChainProjectionInput>,
  options: ProjectionOptions = {},
): ProjectionResult {
  const sortedInputs = [...events].map((input, sourceEventSequence) => {
    const normalizedEventName = typeof input.eventName === 'string'
      ? KNOWN_EVENT_NAMES.get(input.eventName) ?? input.eventName
      : input.eventName;
    const trajectoryType = normalizedEventName in TRAJECTORY_EVENT_BY_SOURCE
      ? TRAJECTORY_EVENT_BY_SOURCE[normalizedEventName as keyof OnChainEventMap]
      : input.eventName;

    return {
      input,
      sourceEventSequence,
      trajectorySortKey: eventSortRank(trajectoryType),
      fingerprint: buildFingerprint(input.slot, input.signature, input.eventName, input.event),
    };
  }).sort((left, right) => {
    if (left.input.slot !== right.input.slot) {
      return left.input.slot - right.input.slot;
    }
    if (left.input.signature !== right.input.signature) {
      return left.input.signature.localeCompare(right.input.signature);
    }
    if (left.trajectorySortKey !== right.trajectorySortKey) {
      return left.trajectorySortKey - right.trajectorySortKey;
    }
    if (left.input.eventName !== right.input.eventName) {
      return left.input.eventName.localeCompare(right.input.eventName);
    }
    if (left.fingerprint !== right.fingerprint) {
      return left.fingerprint.localeCompare(right.fingerprint);
    }
    return left.sourceEventSequence - right.sourceEventSequence;
  });

  const telemetry: ProjectionTelemetry = {
    totalInputs: events.length,
    projectedEvents: 0,
    duplicatesDropped: 0,
    unknownEvents: [],
    transitionConflicts: [],
    malformedInputs: [],
  };

  const eventIds = new Set<string>();
  const taskStates = new Map<string, TaskLifecycleState>();
  const disputeStates = new Map<string, DisputeLifecycleState>();
  const speculationStates = new Map<string, SpeculationLifecycleState>();
  const projected: ProjectedTimelineEvent[] = [];

  for (const [orderedSequence, item] of sortedInputs.entries()) {
    const { input } = item;

    if (input === undefined || input === null || typeof input !== 'object') {
      telemetry.malformedInputs.push('invalid_projection_input');
      continue;
    }

    if (typeof input.eventName !== 'string' || input.eventName.length === 0) {
      telemetry.malformedInputs.push('invalid_projection_input');
      continue;
    }
    if (!Number.isInteger(input.slot) || input.slot < 0) {
      telemetry.malformedInputs.push(`invalid_slot:${String(input.eventName)}`);
      continue;
    }
    if (typeof input.signature !== 'string' || input.signature.length === 0) {
      telemetry.malformedInputs.push(`invalid_signature:${input.eventName}`);
      continue;
    }

    const eventName = KNOWN_EVENT_NAMES.get(input.eventName);
    if (eventName === undefined) {
      telemetry.unknownEvents.push(input.eventName);
      continue;
    }

    const fingerprint = item.fingerprint;
    if (eventIds.has(fingerprint)) {
      telemetry.duplicatesDropped += 1;
      continue;
    }
    eventIds.add(fingerprint);

    const trajectoryType = TRAJECTORY_EVENT_BY_SOURCE[eventName];
    const payload = sanitizePayload(input.event);
    const eventRecord = typeof input.event === 'object' && input.event !== null ? (input.event as Record<string, unknown>) : {};
    const context = getContext(eventName, eventRecord);
    const timestampMs = resolveTimestamp(input, input.event);

    if (TASK_EVENT_TYPES.has(trajectoryType)) {
      if (!context.taskPda) {
        telemetry.transitionConflicts.push(`task:${input.eventName}@${input.signature}: missing_task_id`);
      } else {
        const previous = taskStates.get(context.taskPda);
        const allowed = previous === undefined ? trajectoryType === 'discovered' : isTransitionAllowed(TASK_TRANSITIONS, previous, trajectoryType);
        if (!allowed) {
          telemetry.transitionConflicts.push(transitionConflictMessage([`signature=${input.signature}`], context.taskPda, previous ?? 'none', trajectoryType));
        }
        taskStates.set(context.taskPda, trajectoryType as TaskLifecycleState);
      }
    }

    if (DISPUTE_LIFECYCLE_EVENT_TYPES.has(trajectoryType)) {
      if (!context.disputePda) {
        telemetry.transitionConflicts.push(`dispute:${input.eventName}@${input.signature}: missing_dispute_id`);
      } else {
        const previous = disputeStates.get(context.disputePda);
        const allowed = previous === undefined
          ? trajectoryType === 'dispute:initiated'
          : isTransitionAllowed(DISPUTE_TRANSITIONS, previous, trajectoryType);
        if (!allowed) {
          telemetry.transitionConflicts.push(transitionConflictMessage([`signature=${input.signature}`], `dispute:${context.disputePda}`, previous ?? 'none', trajectoryType));
        }
        disputeStates.set(context.disputePda, trajectoryType as DisputeLifecycleState);
      }
    }

    if (SPECULATION_EVENT_TYPES.has(trajectoryType)) {
      const speculationKey = context.speculationPda ?? context.taskPda;
      if (speculationKey) {
        const previous = speculationStates.get(speculationKey);
        const allowed = previous === undefined
          ? trajectoryType === 'speculation_started'
          : isTransitionAllowed(SPECULATION_TRANSITIONS, previous, trajectoryType);
        if (!allowed) {
          telemetry.transitionConflicts.push(transitionConflictMessage([`signature=${input.signature}`], `speculation:${speculationKey}`, previous ?? 'none', trajectoryType));
        }
        speculationStates.set(speculationKey, trajectoryType as SpeculationLifecycleState);
      }
    }

    const projectedEvent: ProjectedTimelineEvent = {
      seq: projected.length + 1,
      type: trajectoryType,
      taskPda: context.taskPda ?? (SPECULATION_EVENT_TYPES.has(trajectoryType) ? context.speculationPda : undefined),
      timestampMs,
        payload: {
          ...payload,
          onchain: {
            eventName: input.eventName,
            eventType: trajectoryType,
            signature: input.signature,
            slot: input.slot,
            sourceEventSequence: orderedSequence,
          },
        },
        slot: input.slot,
        signature: input.signature,
        sourceEventName: input.eventName,
        sourceEventSequence: orderedSequence,
      };

    projected.push(projectedEvent);
    telemetry.projectedEvents += 1;
  }

  const traceEvents: ProjectedTimelineEvent[] = projected.map((entry, index) => ({
    ...entry,
    seq: index + 1,
    payload: sanitizePayload(entry.payload),
  }));

  return {
    telemetry,
    events: projected,
    trace: {
      schemaVersion: EVAL_TRACE_SCHEMA_VERSION,
      traceId: options.traceId ?? 'onchain-projection',
      seed: options.seed ?? 0,
      createdAtMs: 0,
      metadata: {
        type: 'onchain_projection',
      },
      events: traceEvents.map((entry) => ({
        ...entry,
      })),
    },
  };
}
