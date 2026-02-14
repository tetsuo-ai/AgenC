/**
 * Incident Case Object Model - Foundation for incident reconstruction and evidence management.
 *
 * Implements #990 P2-501: Case object model and timeline evidence
 *
 * @module
 */

import { createHash } from 'crypto';
import type { TrajectoryEvent, JsonObject } from './types.js';
import type { ProjectedTimelineEvent } from './projector.js';

export const INCIDENT_CASE_SCHEMA_VERSION = 1 as const;

/**
 * Bounds incident by slot and timestamp ranges.
 */
export interface IncidentTraceWindow {
  /** Starting slot (inclusive) */
  startSlot: number;
  /** Ending slot (inclusive) */
  endSlot: number;
  /** Starting timestamp in milliseconds */
  startTimestampMs: number;
  /** Ending timestamp in milliseconds */
  endTimestampMs: number;
}

/**
 * Actor role categorization for incident participants.
 */
export type IncidentActorRole = 'creator' | 'worker' | 'arbiter' | 'authority' | 'unknown';

/**
 * Maps participants with roles in an incident.
 */
export interface IncidentActor {
  /** Public key of the actor (base58 encoded) */
  pubkey: string;
  /** Role of the actor in the incident */
  role: IncidentActorRole;
  /** First seen slot */
  firstSeenSlot: number;
  /** Last seen slot */
  lastSeenSlot: number;
}

/**
 * Records state machine transitions in the case timeline.
 */
export interface IncidentTransition {
  /** Sequence number within the incident */
  seq: number;
  /** Previous state (null for initial) */
  fromState: string | null;
  /** New state */
  toState: string;
  /** Slot where transition occurred */
  slot: number;
  /** Timestamp in milliseconds */
  timestampMs: number;
  /** Transaction signature triggering the transition */
  signature: string;
  /** Actor who triggered the transition */
  actor?: string;
  /** Additional transition metadata */
  metadata?: JsonObject;
}

/**
 * Severity levels for anomalies.
 */
export type AnomalySeverity = 'error' | 'warning' | 'info';

/**
 * References detected anomalies with severity metadata.
 */
export interface IncidentAnomalyRef {
  /** Anomaly code identifier */
  code: string;
  /** Severity level */
  severity: AnomalySeverity;
  /** Human-readable description */
  description: string;
  /** Slot where anomaly was detected */
  slot: number;
  /** Related entity (task PDA, dispute PDA, etc.) */
  entityPda?: string;
}

/**
 * Case status for lifecycle tracking.
 */
export type CaseStatus = 'open' | 'investigating' | 'resolved' | 'archived';

/**
 * Top-level incident case payload.
 */
export interface IncidentCase {
  /** Schema version for forward compatibility */
  schemaVersion: typeof INCIDENT_CASE_SCHEMA_VERSION;
  /** Deterministic case identifier (SHA-256 hex) */
  caseId: string;
  /** Trace window bounding the incident */
  traceWindow: IncidentTraceWindow;
  /** State machine transitions */
  transitions: IncidentTransition[];
  /** Referenced anomaly IDs */
  anomalyRefs: IncidentAnomalyRef[];
  /** Map of actors involved (pubkey -> actor info) */
  actorMap: Map<string, IncidentActor>;
  /** Evidence attachment hashes (artifact name -> SHA-256 hex) */
  evidenceHashes: Map<string, string>;
  /** Current case status */
  caseStatus: CaseStatus;
  /** Task PDA if case relates to a specific task */
  taskPda?: string;
  /** Dispute PDA if case relates to a dispute */
  disputePda?: string;
  /** Creation timestamp */
  createdAtMs: number;
  /** Last update timestamp */
  updatedAtMs: number;
}

/**
 * Input for building an incident case.
 */
export interface BuildIncidentCaseInput {
  /** Projected timeline events to analyze */
  events: ProjectedTimelineEvent[];
  /** Optional manual trace window override */
  traceWindow?: Partial<IncidentTraceWindow>;
  /** Optional task PDA filter */
  taskPda?: string;
  /** Optional dispute PDA filter */
  disputePda?: string;
  /** Detected anomalies to include */
  anomalies?: IncidentAnomalyRef[];
  /** Initial case status */
  initialStatus?: CaseStatus;
}

/**
 * Compute trace window from events or use manual override.
 */
export function computeTraceWindow(
  events: ProjectedTimelineEvent[],
  override?: Partial<IncidentTraceWindow>,
): IncidentTraceWindow {
  if (events.length === 0) {
    return {
      startSlot: override?.startSlot ?? 0,
      endSlot: override?.endSlot ?? 0,
      startTimestampMs: override?.startTimestampMs ?? Date.now(),
      endTimestampMs: override?.endTimestampMs ?? Date.now(),
    };
  }

  const sorted = [...events].sort((a, b) => a.slot - b.slot);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  return {
    startSlot: override?.startSlot ?? first.slot,
    endSlot: override?.endSlot ?? last.slot,
    startTimestampMs: override?.startTimestampMs ?? first.timestampMs,
    endTimestampMs: override?.endTimestampMs ?? last.timestampMs,
  };
}

/**
 * Resolve actor role from event payload fields.
 */
function resolveActorRole(sourceEventName: string, fieldName: string): IncidentActorRole {
  // Creator role
  if (fieldName === 'creator' || fieldName === 'owner' || fieldName === 'initiator') {
    return 'creator';
  }
  // Worker role
  if (fieldName === 'worker' || fieldName === 'agent' || fieldName === 'claimant') {
    return 'worker';
  }
  // Arbiter role
  if (fieldName === 'arbiter' || fieldName === 'voter' || sourceEventName.includes('Dispute')) {
    return 'arbiter';
  }
  // Authority role
  if (fieldName === 'authority' || fieldName === 'admin' || fieldName === 'multisig') {
    return 'authority';
  }
  return 'unknown';
}

/**
 * Extract and categorize participants from events.
 */
export function resolveActors(events: ProjectedTimelineEvent[]): Map<string, IncidentActor> {
  const actors = new Map<string, IncidentActor>();

  for (const event of events) {
    const payload = event.payload as JsonObject;

    // Extract known actor fields
    const actorFields = ['creator', 'worker', 'agent', 'claimant', 'arbiter', 'voter', 'authority', 'owner', 'initiator'];

    for (const field of actorFields) {
      const value = payload[field];
      if (typeof value === 'string' && value.length > 0) {
        const existing = actors.get(value);
        const role = resolveActorRole(event.sourceEventName, field);

        if (existing) {
          existing.lastSeenSlot = Math.max(existing.lastSeenSlot, event.slot);
          // Upgrade role if more specific
          if (existing.role === 'unknown' && role !== 'unknown') {
            existing.role = role;
          }
        } else {
          actors.set(value, {
            pubkey: value,
            role,
            firstSeenSlot: event.slot,
            lastSeenSlot: event.slot,
          });
        }
      }
    }
  }

  return actors;
}

/**
 * Build state machine transitions from events.
 */
function buildTransitions(events: ProjectedTimelineEvent[]): IncidentTransition[] {
  const transitions: IncidentTransition[] = [];
  const stateByEntity = new Map<string, string>();
  let seq = 1;

  const sorted = [...events].sort((a, b) => a.slot - b.slot || a.seq - b.seq);

  for (const event of sorted) {
    const payload = event.payload as JsonObject;
    const entityPda = event.taskPda || (payload.disputePda as string) || '';

    // Determine state from event type
    let newState: string | null = null;

    if (event.sourceEventName.includes('Created')) {
      newState = 'created';
    } else if (event.sourceEventName.includes('Claimed')) {
      newState = 'claimed';
    } else if (event.sourceEventName.includes('Completed')) {
      newState = 'completed';
    } else if (event.sourceEventName.includes('Cancelled')) {
      newState = 'cancelled';
    } else if (event.sourceEventName.includes('Disputed') || event.sourceEventName.includes('DisputeInitiated')) {
      newState = 'disputed';
    } else if (event.sourceEventName.includes('Resolved')) {
      newState = 'resolved';
    } else if (event.sourceEventName.includes('Expired')) {
      newState = 'expired';
    }

    if (newState && entityPda) {
      const fromState = stateByEntity.get(entityPda) || null;
      stateByEntity.set(entityPda, newState);

      transitions.push({
        seq: seq++,
        fromState,
        toState: newState,
        slot: event.slot,
        timestampMs: event.timestampMs,
        signature: event.signature,
        actor: (payload.creator || payload.worker || payload.authority) as string | undefined,
        metadata: { sourceEventName: event.sourceEventName, entityPda },
      });
    }
  }

  return transitions;
}

/**
 * Generate SHA-256 hash for evidence artifacts.
 */
export function computeEvidenceHash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute deterministic case ID from trace window and entity IDs.
 */
export function computeCaseId(
  traceWindow: IncidentTraceWindow,
  taskPda?: string,
  disputePda?: string,
): string {
  const input = JSON.stringify({
    startSlot: traceWindow.startSlot,
    endSlot: traceWindow.endSlot,
    taskPda: taskPda || '',
    disputePda: disputePda || '',
  });
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Build an incident case from projected timeline events.
 * Produces deterministic output for identical inputs.
 */
export function buildIncidentCase(input: BuildIncidentCaseInput): IncidentCase {
  const { events, traceWindow: windowOverride, taskPda, disputePda, anomalies, initialStatus } = input;

  // Sort events deterministically by sequence number
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);

  // Filter events within window boundaries if taskPda or disputePda specified
  const filteredEvents = sortedEvents.filter((event) => {
    if (taskPda && event.taskPda !== taskPda) {
      return false;
    }
    const payload = event.payload as JsonObject;
    if (disputePda && payload.disputePda !== disputePda) {
      return false;
    }
    return true;
  });

  // Compute trace window
  const traceWindow = computeTraceWindow(filteredEvents, windowOverride);

  // Build state machine transitions
  const transitions = buildTransitions(filteredEvents);

  // Resolve actor map
  const actorMap = resolveActors(filteredEvents);

  // Compute case ID
  const caseId = computeCaseId(traceWindow, taskPda, disputePda);

  // Initialize evidence hashes (empty - populated when evidence is attached)
  const evidenceHashes = new Map<string, string>();

  const now = Date.now();

  return {
    schemaVersion: INCIDENT_CASE_SCHEMA_VERSION,
    caseId,
    traceWindow,
    transitions,
    anomalyRefs: anomalies || [],
    actorMap,
    evidenceHashes,
    caseStatus: initialStatus || 'open',
    taskPda,
    disputePda,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

/**
 * Serialize incident case to JSON-compatible object.
 */
export function serializeIncidentCase(caseData: IncidentCase): JsonObject {
  return {
    schemaVersion: caseData.schemaVersion,
    caseId: caseData.caseId,
    traceWindow: caseData.traceWindow,
    transitions: caseData.transitions,
    anomalyRefs: caseData.anomalyRefs,
    actorMap: Object.fromEntries(caseData.actorMap),
    evidenceHashes: Object.fromEntries(caseData.evidenceHashes),
    caseStatus: caseData.caseStatus,
    taskPda: caseData.taskPda,
    disputePda: caseData.disputePda,
    createdAtMs: caseData.createdAtMs,
    updatedAtMs: caseData.updatedAtMs,
  };
}

/**
 * Deserialize incident case from JSON object.
 */
export function deserializeIncidentCase(obj: JsonObject): IncidentCase {
  return {
    schemaVersion: obj.schemaVersion as typeof INCIDENT_CASE_SCHEMA_VERSION,
    caseId: obj.caseId as string,
    traceWindow: obj.traceWindow as IncidentTraceWindow,
    transitions: obj.transitions as IncidentTransition[],
    anomalyRefs: obj.anomalyRefs as IncidentAnomalyRef[],
    actorMap: new Map(Object.entries(obj.actorMap as Record<string, IncidentActor>)),
    evidenceHashes: new Map(Object.entries(obj.evidenceHashes as Record<string, string>)),
    caseStatus: obj.caseStatus as CaseStatus,
    taskPda: obj.taskPda as string | undefined,
    disputePda: obj.disputePda as string | undefined,
    createdAtMs: obj.createdAtMs as number,
    updatedAtMs: obj.updatedAtMs as number,
  };
}
