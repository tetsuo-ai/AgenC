/**
 * Evidence-pack builder for reproducible incident exports.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import runtimePackage from '../../package.json';
import { stableStringifyJson, type JsonValue, EVAL_TRACE_SCHEMA_VERSION } from './types.js';
import { computeEvidenceHash, INCIDENT_CASE_SCHEMA_VERSION, type IncidentCase, type IncidentEvidenceHash } from './incident-case.js';
import type { ProjectedTimelineEvent } from './projector.js';

/** Schema version for evidence-pack manifest format. */
export const EVIDENCE_PACK_SCHEMA_VERSION = 1 as const;

/** Manifest included in every evidence bundle. */
export interface EvidencePackManifest {
  schemaVersion: typeof EVIDENCE_PACK_SCHEMA_VERSION;
  seed: number;
  queryHash: string;
  cursorRange: {
    fromSlot: number;
    toSlot: number;
    fromSignature?: string;
    toSignature?: string;
  };
  runtimeVersion: string;
  schemaHash: string;
  toolFingerprint: string;
  sealed: boolean;
  createdAtMs: number;
  evidenceHashes: IncidentEvidenceHash[];
}

/** Redaction policy for sealed mode exports. */
export interface RedactionPolicy {
  stripFields?: string[];
  redactPatterns?: RegExp[];
  redactActors?: boolean;
}

/** The complete evidence bundle (in-memory representation). */
export interface EvidencePack {
  manifest: EvidencePackManifest;
  incidentCase: IncidentCase;
  events: ProjectedTimelineEvent[];
}

export interface BuildEvidencePackInput {
  incidentCase: IncidentCase;
  events: readonly ProjectedTimelineEvent[];
  seed: number;
  queryHash: string;
  sealed?: boolean;
  redactionPolicy?: RedactionPolicy;
  runtimeVersion?: string;
}

const DEFAULT_RUNTIME_VERSION = typeof (runtimePackage as { version?: unknown }).version === 'string'
  ? (runtimePackage as { version: string }).version
  : 'unknown';

const REDACTED_MARKER = '[REDACTED]';

export function buildEvidencePack(input: BuildEvidencePackInput): EvidencePack {
  const sealed = input.sealed === true;
  const runtimeVersion = typeof input.runtimeVersion === 'string' && input.runtimeVersion.length > 0
    ? input.runtimeVersion
    : DEFAULT_RUNTIME_VERSION;

  let events = [...input.events];
  let incidentCase: IncidentCase = {
    ...input.incidentCase,
    // Bundle content should be stable for identical event inputs.
    createdAtMs: input.incidentCase.traceWindow.toTimestampMs,
  };

  if (sealed && input.redactionPolicy) {
    events = events.map((event) => applyRedaction(event, input.redactionPolicy!));

    if (input.redactionPolicy.redactActors) {
      incidentCase = {
        ...incidentCase,
        actorMap: incidentCase.actorMap.map((actor) => ({
          ...actor,
          pubkey: truncateHash(actor.pubkey),
        })),
      };
    }
  }

  const eventsHash = computeEvidenceHash('events', events as unknown as JsonValue);
  const incidentCaseWithRefs: IncidentCase = {
    ...incidentCase,
    evidenceHashes: [...incidentCase.evidenceHashes, eventsHash],
  };
  const caseHash = computeEvidenceHash('incident-case', incidentCaseWithRefs as unknown as JsonValue);

  const cursorRange = {
    fromSlot: incidentCaseWithRefs.traceWindow.fromSlot,
    toSlot: incidentCaseWithRefs.traceWindow.toSlot,
    fromSignature: events[0]?.signature,
    toSignature: events[events.length - 1]?.signature,
  };

  const toolFingerprint = computeToolFingerprint();
  const schemaHash = computeSchemaHash();

  const manifest: EvidencePackManifest = {
    schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
    seed: input.seed,
    queryHash: input.queryHash,
    cursorRange,
    runtimeVersion,
    schemaHash,
    toolFingerprint,
    sealed,
    createdAtMs: Date.now(),
    evidenceHashes: [caseHash, eventsHash],
  };

  return {
    manifest,
    incidentCase: incidentCaseWithRefs,
    events,
  };
}

/** Serialize bundle to the three-file format. */
export function serializeEvidencePack(pack: EvidencePack): {
  'manifest.json': string;
  'incident-case.jsonl': string;
  'events.jsonl': string;
} {
  return {
    'manifest.json': JSON.stringify(pack.manifest, null, 2),
    'incident-case.jsonl': stableStringifyJson(pack.incidentCase as unknown as JsonValue),
    'events.jsonl': pack.events
      .map((event) => stableStringifyJson(event as unknown as JsonValue))
      .join('\n'),
  };
}

function applyRedaction(
  event: ProjectedTimelineEvent,
  policy: RedactionPolicy,
): ProjectedTimelineEvent {
  let payload: unknown = event.payload;

  for (const rawPath of policy.stripFields ?? []) {
    payload = deepDeleteField(payload, rawPath);
  }

  if (policy.redactPatterns && policy.redactPatterns.length > 0) {
    payload = deepRedactPattern(payload, policy.redactPatterns);
  }

  return {
    ...event,
    payload: payload as ProjectedTimelineEvent['payload'],
  };
}

function deepDeleteField(value: unknown, path: string): unknown {
  const normalized = path.startsWith('payload.') ? path.slice('payload.'.length) : path;
  const segments = normalized.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return value;
  }
  return deepDeleteSegment(value, segments, 0);
}

function deepDeleteSegment(value: unknown, segments: readonly string[], index: number): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    // Dot-path deletion is defined primarily for object payloads; leave arrays intact.
    return value.map((entry) => deepDeleteSegment(entry, segments, index));
  }

  const key = segments[index];
  if (!key) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (!(key in record)) {
    return value;
  }

  if (index === segments.length - 1) {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (k !== key) {
        output[k] = v;
      }
    }
    return output;
  }

  const child = record[key];
  const updatedChild = deepDeleteSegment(child, segments, index + 1);
  if (updatedChild === child) {
    return value;
  }

  return {
    ...record,
    [key]: updatedChild,
  };
}

function deepRedactPattern(value: unknown, patterns: readonly RegExp[]): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    for (const pattern of patterns) {
      // Avoid stateful regexp surprises.
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        return REDACTED_MARKER;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => deepRedactPattern(entry, patterns));
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      output[key] = deepRedactPattern(entry, patterns);
    }
    return output;
  }

  return value;
}

function truncateHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function computeSchemaHash(): string {
  const schemaLayout = {
    IncidentCase: [
      'schemaVersion',
      'caseId',
      'createdAtMs',
      'traceWindow',
      'transitions',
      'anomalyIds',
      'anomalies',
      'actorMap',
      'evidenceHashes',
      'caseStatus',
      'taskIds',
      'disputeIds',
      'metadata',
    ],
    IncidentTraceWindow: [
      'fromSlot',
      'toSlot',
      'fromTimestampMs',
      'toTimestampMs',
    ],
    IncidentTransition: [
      'seq',
      'fromState',
      'toState',
      'slot',
      'signature',
      'sourceEventName',
      'timestampMs',
      'taskPda',
      'disputePda',
    ],
    IncidentActor: [
      'pubkey',
      'role',
      'firstSeenSeq',
    ],
    IncidentAnomalyRef: [
      'anomalyId',
      'code',
      'severity',
      'message',
      'seq',
    ],
    IncidentEvidenceHash: [
      'label',
      'sha256',
    ],
    versions: {
      evalTrace: EVAL_TRACE_SCHEMA_VERSION,
      incidentCase: INCIDENT_CASE_SCHEMA_VERSION,
      evidencePack: EVIDENCE_PACK_SCHEMA_VERSION,
    },
  };

  return createHash('sha256')
    .update(stableStringifyJson(schemaLayout as unknown as JsonValue))
    .digest('hex');
}

function computeToolFingerprint(): string {
  const seed = stableStringifyJson({
    evalTraceSchemaVersion: EVAL_TRACE_SCHEMA_VERSION,
    incidentCaseSchemaVersion: INCIDENT_CASE_SCHEMA_VERSION,
    evidencePackSchemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
  } as unknown as JsonValue);
  return createHash('sha256').update(seed).digest('hex');
}

