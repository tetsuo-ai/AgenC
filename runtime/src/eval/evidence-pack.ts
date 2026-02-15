/**
 * Reproducible Evidence Pack Export - Self-contained evidence bundles.
 *
 * Implements #991 P2-502: Reproducible evidence-pack export
 *
 * @module
 */

import { createHash } from 'crypto';
import type { IncidentCase } from './incident-case.js';
import { serializeIncidentCase } from './incident-case.js';
import type { ProjectedTimelineEvent } from './projector.js';
import type { NormalizedQuery } from './query-dsl.js';
import type { JsonObject } from './types.js';

export const EVIDENCE_PACK_SCHEMA_VERSION = 1 as const;

/**
 * Redaction policy configuration.
 */
export interface RedactionPolicy {
  /** Fields to completely remove */
  removeFields?: string[];
  /** Fields to mask (replace with placeholder) */
  maskFields?: string[];
  /** Truncate actor keys to first N characters */
  truncateActorKeys?: number;
  /** Replace signatures with hash */
  hashSignatures?: boolean;
}

/**
 * Default redaction policy for sealed exports.
 */
export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  removeFields: ['privateKey', 'secretKey', 'seed', 'mnemonic'],
  maskFields: ['signature'],
  truncateActorKeys: 8,
  hashSignatures: true,
};

/**
 * Evidence pack manifest with deterministic metadata.
 */
export interface EvidencePackManifest {
  /** Schema version */
  schemaVersion: typeof EVIDENCE_PACK_SCHEMA_VERSION;
  /** Random seed for reproducibility */
  seed: number;
  /** SHA-256 hash of the query */
  queryHash: string;
  /** Slot cursor range */
  slotCursor: {
    start: number;
    end: number;
  };
  /** Runtime version string */
  runtimeVersion: string;
  /** SHA-256 hash of the schema */
  schemaHash: string;
  /** Tool fingerprint hash */
  toolFingerprint: string;
  /** Whether this is a sealed (redacted) export */
  sealed: boolean;
  /** Creation timestamp (ISO 8601) */
  timestamp: string;
  /** SHA-256 hash of case data */
  caseHash: string;
  /** SHA-256 hash of events data */
  eventsHash: string;
}

/**
 * Complete evidence pack bundle.
 */
export interface EvidencePack {
  /** Pack manifest */
  manifest: EvidencePackManifest;
  /** Incident case data */
  caseData: IncidentCase;
  /** Raw event records */
  events: ProjectedTimelineEvent[];
}

/**
 * Serialized evidence pack (three-file JSONL format).
 */
export interface SerializedEvidencePack {
  /** Manifest JSON */
  manifestJson: string;
  /** Case data JSON */
  caseJson: string;
  /** Events JSONL (one event per line) */
  eventsJsonl: string;
}

/**
 * Input for building an evidence pack.
 */
export interface BuildEvidencePackInput {
  /** Incident case */
  caseData: IncidentCase;
  /** Timeline events */
  events: ProjectedTimelineEvent[];
  /** Normalized query used to generate this pack */
  query: NormalizedQuery;
  /** Whether to create a sealed (redacted) export */
  sealed?: boolean;
  /** Custom redaction policy (defaults to DEFAULT_REDACTION_POLICY) */
  redactionPolicy?: RedactionPolicy;
  /** Runtime version string */
  runtimeVersion?: string;
  /** Random seed for reproducibility */
  seed?: number;
  /** Manifest timestamp override for deterministic output */
  timestamp?: string;
}

/**
 * Compute SHA-256 hash of a string.
 */
function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute tool fingerprint from runtime environment.
 */
export function computeToolFingerprint(runtimeVersion: string): string {
  const fingerprint = {
    tool: 'agenc-runtime',
    runtime: runtimeVersion,
  };
  return sha256(JSON.stringify(fingerprint));
}

/**
 * Apply redaction to a payload object.
 * Recursively handles nested objects and arrays.
 */
export function applyEvidenceRedaction(
  payload: JsonObject,
  policy: RedactionPolicy,
): JsonObject {
  const result: JsonObject = {};

  for (const [key, value] of Object.entries(payload)) {
    // Skip removed fields
    if (policy.removeFields?.includes(key)) {
      continue;
    }

    // Mask specified fields
    if (policy.maskFields?.includes(key)) {
      if (policy.hashSignatures && key === 'signature' && typeof value === 'string') {
        result[key] = `[REDACTED:${sha256(value).substring(0, 16)}]`;
      } else {
        result[key] = '[REDACTED]';
      }
      continue;
    }

    // Truncate actor keys
    if (policy.truncateActorKeys && typeof value === 'string') {
      const actorFields = ['creator', 'worker', 'agent', 'claimant', 'arbiter', 'voter', 'authority', 'owner'];
      if (actorFields.includes(key) && value.length > policy.truncateActorKeys) {
        result[key] = value.substring(0, policy.truncateActorKeys) + '...';
        continue;
      }
    }

    // Recurse into arrays
    if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          return applyEvidenceRedaction(item as JsonObject, policy);
        }
        return item;
      });
      continue;
    }

    // Recurse into nested objects
    if (typeof value === 'object' && value !== null) {
      result[key] = applyEvidenceRedaction(value as JsonObject, policy);
      continue;
    }

    // Pass through other values
    result[key] = value;
  }

  return result;
}

/**
 * Apply redaction to events.
 */
function redactEvents(
  events: ProjectedTimelineEvent[],
  policy: RedactionPolicy,
): ProjectedTimelineEvent[] {
  return events.map((event) => ({
    ...event,
    payload: applyEvidenceRedaction(event.payload, policy),
    signature: policy.hashSignatures
      ? `[REDACTED:${sha256(event.signature).substring(0, 16)}]`
      : event.signature,
  }));
}

/**
 * Apply redaction to incident case data.
 */
function redactCaseData(
  caseData: IncidentCase,
  policy: RedactionPolicy,
): IncidentCase {
  // Redact actor map
  const redactedActorMap = new Map<string, IncidentCase['actorMap'] extends Map<string, infer V> ? V : never>();
  for (const [key, actor] of caseData.actorMap) {
    const redactedPubkey = policy.truncateActorKeys && actor.pubkey.length > policy.truncateActorKeys
      ? actor.pubkey.substring(0, policy.truncateActorKeys) + '...'
      : actor.pubkey;
    redactedActorMap.set(key, { ...actor, pubkey: redactedPubkey });
  }

  // Redact transitions
  const redactedTransitions = caseData.transitions.map((transition) => ({
    ...transition,
    signature: policy.hashSignatures
      ? `[REDACTED:${sha256(transition.signature).substring(0, 16)}]`
      : transition.signature,
    actor: transition.actor && policy.truncateActorKeys && transition.actor.length > policy.truncateActorKeys
      ? transition.actor.substring(0, policy.truncateActorKeys) + '...'
      : transition.actor,
    metadata: transition.metadata ? applyEvidenceRedaction(transition.metadata, policy) : undefined,
  }));

  return {
    ...caseData,
    actorMap: redactedActorMap,
    transitions: redactedTransitions,
  };
}

/**
 * Build an evidence pack from case data and events.
 */
export function buildEvidencePack(input: BuildEvidencePackInput): EvidencePack {
  const {
    caseData,
    events,
    query,
    sealed = false,
    redactionPolicy = DEFAULT_REDACTION_POLICY,
    runtimeVersion = '1.0.0',
    seed = Math.floor(Math.random() * 2147483647),
    timestamp,
  } = input;

  // Apply redaction if sealed
  const finalEvents = sealed ? redactEvents(events, redactionPolicy) : events;
  const finalCaseData = sealed ? redactCaseData(caseData, redactionPolicy) : caseData;

  // Compute hashes from redacted data when sealed
  const caseJson = JSON.stringify(serializeIncidentCase(finalCaseData));
  const caseHash = sha256(caseJson);

  const eventsJson = finalEvents.map((e) => JSON.stringify(e)).join('\n');
  const eventsHash = sha256(eventsJson);

  // Compute slot cursor from events
  const slots = finalEvents.map((e) => e.slot).filter((s) => s > 0);
  const slotCursor = {
    start: slots.length > 0 ? Math.min(...slots) : 0,
    end: slots.length > 0 ? Math.max(...slots) : 0,
  };

  // Build manifest
  const manifest: EvidencePackManifest = {
    schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
    seed,
    queryHash: query.hash,
    slotCursor,
    runtimeVersion,
    schemaHash: sha256(`evidence-pack-v${EVIDENCE_PACK_SCHEMA_VERSION}`),
    toolFingerprint: computeToolFingerprint(runtimeVersion),
    sealed,
    timestamp: timestamp ?? new Date().toISOString(),
    caseHash,
    eventsHash,
  };

  return {
    manifest,
    caseData: finalCaseData,
    events: finalEvents,
  };
}

/**
 * Serialize evidence pack to three-file JSONL format.
 */
export function serializeEvidencePack(pack: EvidencePack): SerializedEvidencePack {
  const manifestJson = JSON.stringify(pack.manifest, null, 2);
  const caseJson = JSON.stringify(serializeIncidentCase(pack.caseData), null, 2);
  const eventsJsonl = pack.events.map((event) => JSON.stringify(event)).join('\n');

  return {
    manifestJson,
    caseJson,
    eventsJsonl,
  };
}

/**
 * Verify evidence pack integrity by recomputing hashes.
 */
export function verifyEvidencePackIntegrity(pack: EvidencePack): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Verify case hash
  const caseJson = JSON.stringify(serializeIncidentCase(pack.caseData));
  const computedCaseHash = sha256(caseJson);
  if (computedCaseHash !== pack.manifest.caseHash) {
    errors.push(`Case hash mismatch: expected ${pack.manifest.caseHash}, got ${computedCaseHash}`);
  }

  // Verify events hash
  const eventsJson = pack.events.map((e) => JSON.stringify(e)).join('\n');
  const computedEventsHash = sha256(eventsJson);
  if (computedEventsHash !== pack.manifest.eventsHash) {
    errors.push(`Events hash mismatch: expected ${pack.manifest.eventsHash}, got ${computedEventsHash}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Parse evidence pack from serialized format.
 */
export function parseEvidencePack(serialized: SerializedEvidencePack): EvidencePack {
  const manifest = JSON.parse(serialized.manifestJson) as EvidencePackManifest;
  const caseObj = JSON.parse(serialized.caseJson) as JsonObject;

  // Deserialize case data
  const caseData: IncidentCase = {
    schemaVersion: caseObj.schemaVersion as 1,
    caseId: caseObj.caseId as string,
    traceWindow: caseObj.traceWindow as IncidentCase['traceWindow'],
    transitions: caseObj.transitions as IncidentCase['transitions'],
    anomalyRefs: caseObj.anomalyRefs as IncidentCase['anomalyRefs'],
    actorMap: new Map(Object.entries(caseObj.actorMap as Record<string, unknown>)) as IncidentCase['actorMap'],
    evidenceHashes: new Map(Object.entries(caseObj.evidenceHashes as Record<string, string>)),
    caseStatus: caseObj.caseStatus as IncidentCase['caseStatus'],
    taskPda: caseObj.taskPda as string | undefined,
    disputePda: caseObj.disputePda as string | undefined,
    createdAtMs: caseObj.createdAtMs as number,
    updatedAtMs: caseObj.updatedAtMs as number,
  };

  // Parse events
  const events = serialized.eventsJsonl
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ProjectedTimelineEvent);

  return {
    manifest,
    caseData,
    events,
  };
}
