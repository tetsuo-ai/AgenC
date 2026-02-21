/**
 * Incident case model for deterministic timeline reconstruction and evidence export.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "../utils/encoding.js";
import { stableStringifyJson, type JsonValue } from "./types.js";
import type { ProjectedTimelineEvent } from "./projector.js";
import type { ReplayAnomaly, ReplayAnomalyCode } from "./replay-comparison.js";

/** Schema version for case export format — bump on breaking layout changes. */
export const INCIDENT_CASE_SCHEMA_VERSION = 1 as const;

/** Deterministic slot+timestamp window bounding the incident. */
export interface IncidentTraceWindow {
  fromSlot: number;
  toSlot: number;
  fromTimestampMs: number;
  toTimestampMs: number;
}

/** Actor role in the incident context. */
export type IncidentActorRole =
  | "creator"
  | "worker"
  | "arbiter"
  | "authority"
  | "unknown";

/** Resolved actor entry. */
export interface IncidentActor {
  pubkey: string;
  role: IncidentActorRole;
  firstSeenSeq: number;
}

/** Lifecycle transition recorded in the case timeline. */
export interface IncidentTransition {
  seq: number;
  fromState: string | null;
  toState: string;
  slot: number;
  signature: string;
  sourceEventName: string;
  timestampMs: number;
  taskPda?: string;
  disputePda?: string;
}

/** Reference to an anomaly detected during comparison/replay. */
export interface IncidentAnomalyRef {
  anomalyId: string;
  code: ReplayAnomalyCode;
  severity: "error" | "warning";
  message: string;
  seq?: number;
}

/** SHA-256 hash of an attached evidence artifact. */
export interface IncidentEvidenceHash {
  label: string;
  sha256: string;
}

export type IncidentCaseStatus =
  | "open"
  | "investigating"
  | "resolved"
  | "archived";

/** Top-level incident case payload. */
export interface IncidentCase {
  schemaVersion: typeof INCIDENT_CASE_SCHEMA_VERSION;
  caseId: string;
  createdAtMs: number;
  traceWindow: IncidentTraceWindow;
  transitions: IncidentTransition[];
  anomalyIds: string[];
  anomalies: IncidentAnomalyRef[];
  actorMap: IncidentActor[];
  evidenceHashes: IncidentEvidenceHash[];
  caseStatus: IncidentCaseStatus;
  taskIds: string[];
  disputeIds: string[];
  metadata?: Record<string, unknown>;
}

export interface BuildIncidentCaseInput {
  events: readonly ProjectedTimelineEvent[];
  anomalies?: readonly ReplayAnomaly[];
  window?: { fromSlot?: number; toSlot?: number };
  metadata?: Record<string, unknown>;
}

const TASK_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  discovered: new Set(["claimed", "failed"]),
  claimed: new Set(["completed", "failed", "disputed"]),
  disputed: new Set(["completed", "failed"]),
  completed: new Set(),
  failed: new Set(),
};

const TASK_EVENT_TYPES = new Set<string>([
  "discovered",
  "claimed",
  "completed",
  "failed",
  "disputed",
]);

const DISPUTE_EVENT_TYPES = new Set<string>([
  "dispute:initiated",
  "dispute:vote_cast",
  "dispute:resolved",
  "dispute:cancelled",
  "dispute:expired",
]);

const SPECULATION_EVENT_TYPES = new Set<string>([
  "speculation_started",
  "speculation_confirmed",
  "speculation_aborted",
]);

export function buildIncidentCase(input: BuildIncidentCaseInput): IncidentCase {
  const sorted = [...input.events].sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq;
    if (left.slot !== right.slot) return left.slot - right.slot;
    if (left.timestampMs !== right.timestampMs)
      return left.timestampMs - right.timestampMs;
    if (left.signature !== right.signature)
      return left.signature.localeCompare(right.signature);
    if (left.sourceEventName !== right.sourceEventName)
      return left.sourceEventName.localeCompare(right.sourceEventName);
    if (left.type !== right.type) return left.type.localeCompare(right.type);
    return (left.taskPda ?? "").localeCompare(right.taskPda ?? "");
  });

  const traceWindow = computeTraceWindow(sorted, input.window);

  const windowedEvents = sorted.filter(
    (event) =>
      event.slot >= traceWindow.fromSlot && event.slot <= traceWindow.toSlot,
  );

  const transitions = buildTransitions(windowedEvents);
  const actorMap = resolveActors(windowedEvents);

  const anomalyRefs = (input.anomalies ?? []).map((anomaly, index) => ({
    anomalyId: computeAnomalyId(anomaly, index),
    code: anomaly.code,
    severity: anomaly.severity,
    message: anomaly.message,
    ...(typeof anomaly.context.seq === "number"
      ? { seq: anomaly.context.seq }
      : {}),
  }));

  const taskIds = [
    ...new Set(
      windowedEvents
        .map((event) => event.taskPda)
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
        ),
    ),
  ].sort();

  const disputeIds = collectDisputeIds(windowedEvents);
  const caseId = computeCaseId(traceWindow, taskIds, disputeIds);

  return {
    schemaVersion: INCIDENT_CASE_SCHEMA_VERSION,
    caseId,
    createdAtMs: Date.now(),
    traceWindow,
    transitions,
    anomalyIds: anomalyRefs.map((entry) => entry.anomalyId),
    anomalies: anomalyRefs,
    actorMap,
    evidenceHashes: [],
    caseStatus: "open",
    taskIds,
    disputeIds,
    metadata: input.metadata,
  };
}

export function computeEvidenceHash(
  label: string,
  content: JsonValue,
): IncidentEvidenceHash {
  const sha256 = createHash("sha256")
    .update(stableStringifyJson(content))
    .digest("hex");
  return { label, sha256 };
}

function computeTraceWindow(
  events: readonly ProjectedTimelineEvent[],
  override?: { fromSlot?: number; toSlot?: number },
): IncidentTraceWindow {
  if (events.length === 0) {
    return { fromSlot: 0, toSlot: 0, fromTimestampMs: 0, toTimestampMs: 0 };
  }

  const overrideFrom = override?.fromSlot;
  const overrideTo = override?.toSlot;

  const resolvedFromSlot =
    Number.isInteger(overrideFrom) && (overrideFrom as number) >= 0
      ? (overrideFrom as number)
      : events[0].slot;
  const resolvedToSlot =
    Number.isInteger(overrideTo) && (overrideTo as number) >= 0
      ? (overrideTo as number)
      : events[events.length - 1].slot;

  const fromSlot = Math.min(resolvedFromSlot, resolvedToSlot);
  const toSlot = Math.max(resolvedFromSlot, resolvedToSlot);

  const fromTimestampMs =
    events.find((event) => event.slot >= fromSlot)?.timestampMs ?? 0;
  const toTimestampMs =
    [...events].reverse().find((event) => event.slot <= toSlot)?.timestampMs ??
    0;

  return { fromSlot, toSlot, fromTimestampMs, toTimestampMs };
}

function resolveActors(
  events: readonly ProjectedTimelineEvent[],
): IncidentActor[] {
  const actors = new Map<string, IncidentActor>();

  for (const event of events) {
    const payload = event.payload as unknown as Record<string, unknown>;
    const candidates: Array<{ pubkey: string; role: IncidentActorRole }> = [];

    const creator = payload.creator;
    if (typeof creator === "string" && creator.length > 0)
      candidates.push({ pubkey: creator, role: "creator" });

    const worker = payload.worker;
    if (typeof worker === "string" && worker.length > 0)
      candidates.push({ pubkey: worker, role: "worker" });

    const authority = payload.authority;
    if (typeof authority === "string" && authority.length > 0)
      candidates.push({ pubkey: authority, role: "authority" });

    const voter = payload.voter;
    if (typeof voter === "string" && voter.length > 0)
      candidates.push({ pubkey: voter, role: "arbiter" });

    const initiator = payload.initiator;
    if (typeof initiator === "string" && initiator.length > 0)
      candidates.push({ pubkey: initiator, role: "creator" });

    const defendant = payload.defendant;
    if (typeof defendant === "string" && defendant.length > 0)
      candidates.push({ pubkey: defendant, role: "worker" });

    const recipient = payload.recipient;
    if (typeof recipient === "string" && recipient.length > 0)
      candidates.push({ pubkey: recipient, role: "worker" });

    const updater = payload.updater;
    if (typeof updater === "string" && updater.length > 0)
      candidates.push({ pubkey: updater, role: "authority" });

    const updatedBy = payload.updatedBy;
    if (typeof updatedBy === "string" && updatedBy.length > 0)
      candidates.push({ pubkey: updatedBy, role: "authority" });

    const agent = payload.agent;
    if (
      typeof agent === "string" &&
      agent.length > 0 &&
      !candidates.some((entry) => entry.pubkey === agent)
    ) {
      candidates.push({ pubkey: agent, role: "unknown" });
    }

    for (const { pubkey, role } of candidates) {
      const existing = actors.get(pubkey);
      if (!existing) {
        actors.set(pubkey, { pubkey, role, firstSeenSeq: event.seq });
        continue;
      }

      if (existing.role === "unknown" && role !== "unknown") {
        existing.role = role;
      }
    }
  }

  return [...actors.values()].sort((left, right) => {
    if (left.firstSeenSeq !== right.firstSeenSeq)
      return left.firstSeenSeq - right.firstSeenSeq;
    return left.pubkey.localeCompare(right.pubkey);
  });
}

function buildTransitions(
  events: readonly ProjectedTimelineEvent[],
): IncidentTransition[] {
  const transitions: IncidentTransition[] = [];

  const taskStates = new Map<string, string>();
  const disputeStates = new Map<string, string>();
  const speculationStates = new Map<string, string>();

  for (const event of events) {
    const {
      seq,
      type,
      slot,
      signature,
      sourceEventName,
      timestampMs,
      taskPda,
    } = event;

    if (TASK_EVENT_TYPES.has(type) && taskPda) {
      const previous = taskStates.get(taskPda) ?? null;
      transitions.push({
        seq,
        fromState: previous,
        toState: type,
        slot,
        signature,
        sourceEventName,
        timestampMs,
        taskPda,
      });
      taskStates.set(taskPda, type);
    }

    if (sourceEventName === "disputeInitiated" && taskPda) {
      const previous = taskStates.get(taskPda);
      if (
        previous !== undefined &&
        TASK_TRANSITIONS[previous]?.has("disputed")
      ) {
        transitions.push({
          seq,
          fromState: previous,
          toState: "disputed",
          slot,
          signature,
          sourceEventName,
          timestampMs,
          taskPda,
        });
        taskStates.set(taskPda, "disputed");
      }
    }

    if (DISPUTE_EVENT_TYPES.has(type)) {
      const disputePda = extractDisputePda(event);
      if (disputePda) {
        const previous = disputeStates.get(disputePda) ?? null;
        transitions.push({
          seq,
          fromState: previous,
          toState: type,
          slot,
          signature,
          sourceEventName,
          timestampMs,
          taskPda,
          disputePda,
        });
        disputeStates.set(disputePda, type);
      }
    }

    if (SPECULATION_EVENT_TYPES.has(type) && taskPda) {
      const previous = speculationStates.get(taskPda) ?? null;
      transitions.push({
        seq,
        fromState: previous,
        toState: type,
        slot,
        signature,
        sourceEventName,
        timestampMs,
        taskPda,
      });
      speculationStates.set(taskPda, type);
    }
  }

  return transitions;
}

function collectDisputeIds(
  events: readonly ProjectedTimelineEvent[],
): string[] {
  const disputeIds = new Set<string>();
  for (const event of events) {
    const disputePda = extractDisputePda(event);
    if (disputePda) disputeIds.add(disputePda);
  }
  return [...disputeIds].sort();
}

function extractDisputePda(event: ProjectedTimelineEvent): string | undefined {
  const payload = event.payload as unknown as Record<string, unknown>;
  const onchain = payload.onchain;

  if (typeof onchain === "object" && onchain !== null) {
    const raw = (onchain as Record<string, unknown>).disputeId;
    const normalized = normalizePdaValue(raw);
    if (normalized) return normalized;
  }

  const direct = payload.disputeId;
  const normalized = normalizePdaValue(direct);
  if (normalized) return normalized;

  return undefined;
}

function normalizePdaValue(value: unknown): string | undefined {
  if (value instanceof PublicKey) return value.toBase58();

  if (value instanceof Uint8Array) {
    return bytesToPdaString(value);
  }

  if (
    Array.isArray(value) &&
    value.every(
      (entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255,
    )
  ) {
    return bytesToPdaString(new Uint8Array(value));
  }

  if (typeof value === "string" && value.length > 0) {
    const clean = value.startsWith("0x") ? value.slice(2) : value;
    if (clean.length === 64 && /^[0-9a-fA-F]+$/.test(clean)) {
      try {
        return bytesToPdaString(hexToBytes(clean));
      } catch {
        return value;
      }
    }
    return value;
  }

  return undefined;
}

function bytesToPdaString(bytes: Uint8Array): string {
  if (bytes.length !== 32) return bytesToHex(bytes);
  try {
    return new PublicKey(bytes).toBase58();
  } catch {
    return bytesToHex(bytes);
  }
}

function computeCaseId(
  window: IncidentTraceWindow,
  taskIds: string[],
  disputeIds: string[],
): string {
  const seed = stableStringifyJson({
    fromSlot: window.fromSlot,
    toSlot: window.toSlot,
    taskIds,
    disputeIds,
  } as unknown as JsonValue);

  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function computeAnomalyId(
  anomaly: ReplayAnomaly,
  fallbackIndex: number,
): string {
  const context = anomaly.context;
  const seed = stableStringifyJson({
    code: anomaly.code,
    severity: anomaly.severity,
    taskPda: context.taskPda,
    disputePda: context.disputePda,
    sourceEventName: context.sourceEventName,
    sourceEventSequence: context.sourceEventSequence,
    signature: context.signature,
    eventType: context.eventType,
    seq: context.seq ?? fallbackIndex,
    traceId: context.traceId,
    traceSpanId: context.traceSpanId,
    traceParentSpanId: context.traceParentSpanId,
    traceSampled: context.traceSampled,
  } as unknown as JsonValue);

  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
