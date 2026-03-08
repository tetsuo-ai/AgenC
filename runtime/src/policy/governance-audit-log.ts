/**
 * Signed governance audit logging with durable retention controls.
 *
 * @module
 */

import { createHash, createHmac } from "node:crypto";
import type { MemoryBackend } from "../memory/types.js";
import { stableStringifyJson, type JsonValue } from "../eval/types.js";
import { KeyedAsyncQueue } from "../utils/keyed-async-queue.js";
import type {
  GovernanceAuditConfig,
  GovernanceAuditRedactionConfig,
  GovernanceAuditRetentionMode,
  PolicyEvaluationScope,
} from "./types.js";

const REDACTED_MARKER = "[REDACTED]";
const GOVERNANCE_AUDIT_LOCK_KEY = "__governance-audit__";
const GOVERNANCE_AUDIT_STORAGE_PREFIX = "governance-audit";
const GOVERNANCE_AUDIT_MANIFEST_SUFFIX = "manifest";
const GOVERNANCE_AUDIT_RECORD_SUFFIX = "record";
const GOVERNANCE_AUDIT_SCHEMA_VERSION = 1;

export type GovernanceAuditEventType =
  | "policy.denied"
  | "policy.shadow_denied"
  | "approval.requested"
  | "approval.escalated"
  | "approval.resolved"
  | "credential.issued"
  | "credential.revoked";

export interface GovernanceAuditEvent {
  type: GovernanceAuditEventType;
  actor?: string;
  subject?: string;
  scope?: PolicyEvaluationScope;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

export interface GovernanceAuditRecord {
  seq: number;
  timestamp: string;
  type: GovernanceAuditEventType;
  actor?: string;
  subject?: string;
  scope?: PolicyEvaluationScope;
  payload: JsonValue;
  payloadHash: string;
  prevRecordHash: string;
  recordHash: string;
  signature: string;
  expiresAtMs?: number;
}

export interface GovernanceAuditVerification {
  valid: boolean;
  entries: number;
  archivedEntries?: number;
  brokenAt?: number;
  message?: string;
  anchorPrevRecordHash?: string;
}

export interface GovernanceAuditRecordListOptions {
  readonly includeArchived?: boolean;
}

export interface GovernanceAuditExport {
  readonly exportedAt: string;
  readonly retentionMode: GovernanceAuditRetentionMode;
  readonly legalHold: boolean;
  readonly activeRecords: readonly GovernanceAuditRecord[];
  readonly archivedRecords: readonly GovernanceAuditRecord[];
}

export interface GovernanceAuditLog {
  append(event: GovernanceAuditEvent): Promise<GovernanceAuditRecord>;
  getAll(
    options?: GovernanceAuditRecordListOptions,
  ): Promise<ReadonlyArray<GovernanceAuditRecord>>;
  prune(): Promise<number>;
  verify(): Promise<GovernanceAuditVerification>;
  clear(): Promise<void>;
  exportRecords(options?: GovernanceAuditRecordListOptions): Promise<GovernanceAuditExport>;
}

export interface GovernanceAuditLogConfig extends GovernanceAuditConfig {
  now?: () => number;
}

export interface DurableGovernanceAuditLogConfig extends GovernanceAuditLogConfig {
  readonly memoryBackend: MemoryBackend;
  readonly storagePrefix?: string;
}

interface GovernanceAuditManifest {
  readonly version: typeof GOVERNANCE_AUDIT_SCHEMA_VERSION;
  readonly updatedAt: number;
  readonly nextSeq: number;
  readonly activeSeqs: readonly number[];
  readonly archivedSeqs: readonly number[];
  readonly activeAnchorPrevRecordHash: string;
  readonly lastRecordHash: string;
  readonly retentionMode: GovernanceAuditRetentionMode;
  readonly legalHold: boolean;
}

type CompiledRedactionPolicy = {
  redactActors: boolean;
  stripFields: readonly string[];
  redactPatterns: readonly RegExp[];
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function manifestKey(storagePrefix: string): string {
  return `${storagePrefix}:${GOVERNANCE_AUDIT_MANIFEST_SUFFIX}`;
}

function recordKey(storagePrefix: string, seq: number): string {
  return `${storagePrefix}:${GOVERNANCE_AUDIT_RECORD_SUFFIX}:${seq}`;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry));
  }
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonValue(entry);
    }
    return out;
  }
  return String(value);
}

function computeHash(value: JsonValue): string {
  return createHash("sha256").update(stableStringifyJson(value)).digest("hex");
}

function compileRedactionPolicy(
  policy: GovernanceAuditRedactionConfig | undefined,
): CompiledRedactionPolicy {
  const redactPatterns = (policy?.redactPatterns ?? []).map(
    (pattern) => new RegExp(pattern, "g"),
  );
  return {
    redactActors: policy?.redactActors === true,
    stripFields: policy?.stripFields ?? [],
    redactPatterns,
  };
}

function stripFieldPath(value: unknown, path: string): unknown {
  const normalized = path.startsWith("payload.")
    ? path.slice("payload.".length)
    : path;
  const segments = normalized.split(".").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return value;
  }
  return stripFieldPathSegments(value, segments, 0);
}

function stripFieldPathSegments(
  value: unknown,
  segments: readonly string[],
  index: number,
): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripFieldPathSegments(entry, segments, index));
  }

  const record = value as Record<string, unknown>;
  const key = segments[index];
  if (!key || !(key in record)) {
    return value;
  }
  if (index === segments.length - 1) {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(record)) {
      if (entryKey !== key) {
        output[entryKey] = entryValue;
      }
    }
    return output;
  }

  const child = record[key];
  const updatedChild = stripFieldPathSegments(child, segments, index + 1);
  if (updatedChild === child) {
    return value;
  }
  return {
    ...record,
    [key]: updatedChild,
  };
}

function redactPatterns(value: unknown, patterns: readonly RegExp[]): unknown {
  if (patterns.length === 0) {
    return value;
  }
  if (typeof value === "string") {
    return patterns.reduce(
      (current, pattern) => current.replace(pattern, REDACTED_MARKER),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactPatterns(entry, patterns));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactPatterns(entry, patterns);
    }
    return output;
  }
  return value;
}

function redactPayload(
  payload: Record<string, unknown> | undefined,
  policy: CompiledRedactionPolicy,
): JsonValue {
  let current: unknown = payload ?? {};
  for (const fieldPath of policy.stripFields) {
    current = stripFieldPath(current, fieldPath);
  }
  current = redactPatterns(current, policy.redactPatterns);
  return toJsonValue(current);
}

function canonicalizeRecord(
  record: Omit<GovernanceAuditRecord, "recordHash" | "signature">,
): JsonValue {
  return {
    seq: record.seq,
    timestamp: record.timestamp,
    type: record.type,
    ...(record.actor ? { actor: record.actor } : {}),
    ...(record.subject ? { subject: record.subject } : {}),
    ...(record.scope ? { scope: toJsonValue(record.scope) } : {}),
    payload: record.payload,
    payloadHash: record.payloadHash,
    prevRecordHash: record.prevRecordHash,
    ...(record.expiresAtMs !== undefined
      ? { expiresAtMs: record.expiresAtMs }
      : {}),
  };
}

function signRecord(signingKey: string, recordHash: string): string {
  return createHmac("sha256", signingKey).update(recordHash).digest("hex");
}

function buildDefaultManifest(
  now: number,
  retentionMode: GovernanceAuditRetentionMode,
  legalHold: boolean,
): GovernanceAuditManifest {
  return {
    version: GOVERNANCE_AUDIT_SCHEMA_VERSION,
    updatedAt: now,
    nextSeq: 1,
    activeSeqs: [],
    archivedSeqs: [],
    activeAnchorPrevRecordHash: "",
    lastRecordHash: "",
    retentionMode,
    legalHold,
  };
}

function coerceManifest(value: unknown): GovernanceAuditManifest | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== GOVERNANCE_AUDIT_SCHEMA_VERSION ||
    typeof raw.updatedAt !== "number" ||
    typeof raw.nextSeq !== "number" ||
    !Array.isArray(raw.activeSeqs) ||
    !Array.isArray(raw.archivedSeqs) ||
    typeof raw.activeAnchorPrevRecordHash !== "string" ||
    typeof raw.lastRecordHash !== "string" ||
    (raw.retentionMode !== "delete" && raw.retentionMode !== "archive") ||
    typeof raw.legalHold !== "boolean"
  ) {
    return undefined;
  }
  const activeSeqs = raw.activeSeqs.filter(
    (entry): entry is number => typeof entry === "number" && Number.isInteger(entry),
  );
  const archivedSeqs = raw.archivedSeqs.filter(
    (entry): entry is number => typeof entry === "number" && Number.isInteger(entry),
  );
  return {
    version: GOVERNANCE_AUDIT_SCHEMA_VERSION,
    updatedAt: raw.updatedAt,
    nextSeq: raw.nextSeq,
    activeSeqs,
    archivedSeqs,
    activeAnchorPrevRecordHash: raw.activeAnchorPrevRecordHash,
    lastRecordHash: raw.lastRecordHash,
    retentionMode: raw.retentionMode,
    legalHold: raw.legalHold,
  };
}

function coerceGovernanceAuditRecord(
  value: unknown,
): GovernanceAuditRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.seq !== "number" ||
    typeof raw.timestamp !== "string" ||
    typeof raw.type !== "string" ||
    typeof raw.payloadHash !== "string" ||
    typeof raw.prevRecordHash !== "string" ||
    typeof raw.recordHash !== "string" ||
    typeof raw.signature !== "string"
  ) {
    return undefined;
  }
  return {
    seq: raw.seq,
    timestamp: raw.timestamp,
    type: raw.type as GovernanceAuditEventType,
    actor: typeof raw.actor === "string" ? raw.actor : undefined,
    subject: typeof raw.subject === "string" ? raw.subject : undefined,
    scope:
      raw.scope && typeof raw.scope === "object"
        ? cloneJson(raw.scope as PolicyEvaluationScope)
        : undefined,
    payload: toJsonValue(raw.payload),
    payloadHash: raw.payloadHash,
    prevRecordHash: raw.prevRecordHash,
    recordHash: raw.recordHash,
    signature: raw.signature,
    expiresAtMs: typeof raw.expiresAtMs === "number" ? raw.expiresAtMs : undefined,
  };
}

function buildRecord(params: {
  event: GovernanceAuditEvent;
  seq: number;
  now: number;
  signingKey: string;
  redaction: CompiledRedactionPolicy;
  prevRecordHash: string;
  retentionMs?: number;
}): GovernanceAuditRecord {
  const timestamp = params.event.timestamp ?? new Date(params.now).toISOString();
  const payload = redactPayload(params.event.payload, params.redaction);
  const expiresAtMs =
    params.retentionMs !== undefined ? params.now + params.retentionMs : undefined;
  const actor = params.redaction.redactActors
    ? REDACTED_MARKER
    : params.event.actor;
  const baseRecord: Omit<GovernanceAuditRecord, "recordHash" | "signature"> = {
    seq: params.seq,
    timestamp,
    type: params.event.type,
    ...(actor ? { actor } : {}),
    ...(params.event.subject ? { subject: params.event.subject } : {}),
    ...(params.event.scope ? { scope: params.event.scope } : {}),
    payload,
    payloadHash: computeHash(payload),
    prevRecordHash: params.prevRecordHash,
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
  };
  const recordHash = computeHash(canonicalizeRecord(baseRecord));
  const signature = signRecord(params.signingKey, recordHash);
  return {
    ...baseRecord,
    recordHash,
    signature,
  };
}

function verifyRecordChain(params: {
  records: readonly GovernanceAuditRecord[];
  signingKey: string;
  initialPrevRecordHash: string;
}): GovernanceAuditVerification {
  let previousHash = params.initialPrevRecordHash;
  for (const record of params.records) {
    const expectedRecordHash = computeHash(
      canonicalizeRecord({
        seq: record.seq,
        timestamp: record.timestamp,
        type: record.type,
        ...(record.actor ? { actor: record.actor } : {}),
        ...(record.subject ? { subject: record.subject } : {}),
        ...(record.scope ? { scope: record.scope } : {}),
        payload: record.payload,
        payloadHash: record.payloadHash,
        prevRecordHash: record.prevRecordHash,
        ...(record.expiresAtMs !== undefined
          ? { expiresAtMs: record.expiresAtMs }
          : {}),
      }),
    );
    if (record.recordHash !== expectedRecordHash) {
      return {
        valid: false,
        entries: params.records.length,
        brokenAt: record.seq,
        message: "record hash mismatch",
      };
    }
    const expectedSignature = signRecord(params.signingKey, record.recordHash);
    if (record.signature !== expectedSignature) {
      return {
        valid: false,
        entries: params.records.length,
        brokenAt: record.seq,
        message: "record signature mismatch",
      };
    }
    if (record.prevRecordHash !== previousHash) {
      return {
        valid: false,
        entries: params.records.length,
        brokenAt: record.seq,
        message: "record chain link broken",
      };
    }
    previousHash = record.recordHash;
  }

  return {
    valid: true,
    entries: params.records.length,
  };
}

function normalizeRetentionMode(
  mode: GovernanceAuditRetentionMode | undefined,
): GovernanceAuditRetentionMode {
  return mode ?? "delete";
}

export class InMemoryGovernanceAuditLog implements GovernanceAuditLog {
  private readonly signingKey: string;
  private readonly redaction: CompiledRedactionPolicy;
  private readonly retentionMs?: number;
  private readonly maxEntries?: number;
  private readonly retentionMode: GovernanceAuditRetentionMode;
  private readonly legalHold: boolean;
  private readonly now: () => number;
  private activeRecords: GovernanceAuditRecord[] = [];
  private archivedRecords: GovernanceAuditRecord[] = [];
  private activeAnchorPrevRecordHash = "";
  private lastRecordHash = "";

  constructor(config: GovernanceAuditLogConfig) {
    if (
      typeof config.signingKey !== "string" ||
      config.signingKey.trim().length === 0
    ) {
      throw new Error("Governance audit log requires a non-empty signingKey");
    }
    this.signingKey = config.signingKey;
    this.redaction = compileRedactionPolicy(config.redaction);
    this.retentionMs = config.retentionMs;
    this.maxEntries = config.maxEntries;
    this.retentionMode = normalizeRetentionMode(config.retentionMode);
    this.legalHold = config.legalHold === true;
    this.now = config.now ?? Date.now;
  }

  async append(event: GovernanceAuditEvent): Promise<GovernanceAuditRecord> {
    const record = buildRecord({
      event,
      seq:
        (this.activeRecords[this.activeRecords.length - 1]?.seq ??
          this.archivedRecords[this.archivedRecords.length - 1]?.seq ??
          0) + 1,
      now: this.now(),
      signingKey: this.signingKey,
      redaction: this.redaction,
      prevRecordHash: this.lastRecordHash,
      retentionMs: this.retentionMs,
    });
    this.activeRecords.push(record);
    this.lastRecordHash = record.recordHash;
    if (this.activeRecords.length === 1) {
      this.activeAnchorPrevRecordHash = record.prevRecordHash;
    }
    await this.prune();
    return record;
  }

  async getAll(
    options: GovernanceAuditRecordListOptions = {},
  ): Promise<ReadonlyArray<GovernanceAuditRecord>> {
    if (options.includeArchived) {
      return [...this.archivedRecords, ...this.activeRecords];
    }
    return [...this.activeRecords];
  }

  async prune(): Promise<number> {
    const now = this.now();
    const removable = new Set<number>();
    for (const record of this.activeRecords) {
      if (record.expiresAtMs !== undefined && record.expiresAtMs <= now) {
        removable.add(record.seq);
      }
    }
    const retainedAfterExpiry = this.activeRecords.filter(
      (record) => !removable.has(record.seq),
    );
    if (
      this.maxEntries !== undefined &&
      this.maxEntries >= 0 &&
      retainedAfterExpiry.length > this.maxEntries
    ) {
      const overflowCount = retainedAfterExpiry.length - this.maxEntries;
      for (const record of retainedAfterExpiry.slice(0, overflowCount)) {
        removable.add(record.seq);
      }
    }
    if (removable.size === 0) {
      return 0;
    }

    const removed = this.activeRecords.filter((record) => removable.has(record.seq));
    this.activeRecords = this.activeRecords.filter(
      (record) => !removable.has(record.seq),
    );
    if (this.legalHold || this.retentionMode === "archive") {
      this.archivedRecords.push(...removed);
    }
    this.activeAnchorPrevRecordHash =
      this.activeRecords[0]?.prevRecordHash ?? this.lastRecordHash;
    return removed.length;
  }

  async verify(): Promise<GovernanceAuditVerification> {
    const archivedResult = verifyRecordChain({
      records: this.archivedRecords,
      signingKey: this.signingKey,
      initialPrevRecordHash: "",
    });
    if (!archivedResult.valid) {
      return {
        ...archivedResult,
        archivedEntries: this.archivedRecords.length,
      };
    }
    if (
      this.archivedRecords.length > 0 &&
      this.activeRecords.length > 0 &&
      this.activeAnchorPrevRecordHash !==
        this.archivedRecords[this.archivedRecords.length - 1]!.recordHash
    ) {
      return {
        valid: false,
        entries: this.activeRecords.length,
        archivedEntries: this.archivedRecords.length,
        brokenAt: this.activeRecords[0]!.seq,
        message: "active chain anchor mismatch",
      };
    }

    const activeResult = verifyRecordChain({
      records: this.activeRecords,
      signingKey: this.signingKey,
      initialPrevRecordHash: this.activeAnchorPrevRecordHash,
    });
    if (!activeResult.valid) {
      return {
        ...activeResult,
        archivedEntries: this.archivedRecords.length,
        anchorPrevRecordHash: this.activeAnchorPrevRecordHash || undefined,
      };
    }
    return {
      valid: true,
      entries: this.activeRecords.length,
      archivedEntries: this.archivedRecords.length,
      anchorPrevRecordHash: this.activeAnchorPrevRecordHash || undefined,
    };
  }

  async clear(): Promise<void> {
    this.activeRecords = [];
    this.archivedRecords = [];
    this.activeAnchorPrevRecordHash = "";
    this.lastRecordHash = "";
  }

  async exportRecords(
    options: GovernanceAuditRecordListOptions = {},
  ): Promise<GovernanceAuditExport> {
    return {
      exportedAt: new Date(this.now()).toISOString(),
      retentionMode: this.retentionMode,
      legalHold: this.legalHold,
      activeRecords: [...this.activeRecords],
      archivedRecords: options.includeArchived === false ? [] : [...this.archivedRecords],
    };
  }
}

export class MemoryBackedGovernanceAuditLog implements GovernanceAuditLog {
  private readonly signingKey: string;
  private readonly redaction: CompiledRedactionPolicy;
  private readonly retentionMs?: number;
  private readonly maxEntries?: number;
  private readonly retentionMode: GovernanceAuditRetentionMode;
  private readonly legalHold: boolean;
  private readonly now: () => number;
  private readonly memoryBackend: MemoryBackend;
  private readonly storagePrefix: string;
  private readonly queue: KeyedAsyncQueue;

  static async create(
    config: DurableGovernanceAuditLogConfig,
  ): Promise<MemoryBackedGovernanceAuditLog> {
    const log = new MemoryBackedGovernanceAuditLog(config);
    await log.initialize();
    return log;
  }

  private constructor(config: DurableGovernanceAuditLogConfig) {
    if (
      typeof config.signingKey !== "string" ||
      config.signingKey.trim().length === 0
    ) {
      throw new Error("Governance audit log requires a non-empty signingKey");
    }
    this.signingKey = config.signingKey;
    this.redaction = compileRedactionPolicy(config.redaction);
    this.retentionMs = config.retentionMs;
    this.maxEntries = config.maxEntries;
    this.retentionMode = normalizeRetentionMode(config.retentionMode);
    this.legalHold = config.legalHold === true;
    this.now = config.now ?? Date.now;
    this.memoryBackend = config.memoryBackend;
    this.storagePrefix = config.storagePrefix ?? GOVERNANCE_AUDIT_STORAGE_PREFIX;
    this.queue = new KeyedAsyncQueue({
      label: "governance audit log",
    });
  }

  private async initialize(): Promise<void> {
    await this.queue.run(GOVERNANCE_AUDIT_LOCK_KEY, async () => {
      const manifest = await this.loadManifest();
      const persistedManifest = await this.applyRetentionPolicy(manifest);
      const verification = await this.verifyInternal(persistedManifest);
      if (!verification.valid) {
        throw new Error(
          `Governance audit log verification failed: ${verification.message ?? "unknown error"}`,
        );
      }
    });
  }

  private async loadManifest(): Promise<GovernanceAuditManifest> {
    const raw = await this.memoryBackend.get(manifestKey(this.storagePrefix));
    const manifest = coerceManifest(raw);
    if (raw === undefined) {
      return buildDefaultManifest(
        this.now(),
        this.retentionMode,
        this.legalHold,
      );
    }
    if (!manifest) {
      throw new Error("Governance audit manifest is invalid");
    }
    return manifest;
  }

  private async saveManifest(manifest: GovernanceAuditManifest): Promise<void> {
    await this.memoryBackend.set(
      manifestKey(this.storagePrefix),
      cloneJson(manifest),
    );
  }

  private async loadRecord(
    seq: number,
  ): Promise<GovernanceAuditRecord | undefined> {
    const raw = await this.memoryBackend.get(recordKey(this.storagePrefix, seq));
    return coerceGovernanceAuditRecord(raw);
  }

  private async loadRecords(
    seqs: readonly number[],
    strict = false,
  ): Promise<GovernanceAuditRecord[]> {
    const records: GovernanceAuditRecord[] = [];
    for (const seq of seqs) {
      const record = await this.loadRecord(seq);
      if (!record) {
        if (strict) {
          throw new Error(`Governance audit record ${seq} is missing or invalid`);
        }
        continue;
      }
      records.push(record);
    }
    return records;
  }

  private async applyRetentionPolicy(
    manifest: GovernanceAuditManifest,
  ): Promise<GovernanceAuditManifest> {
    if (manifest.legalHold && !this.legalHold) {
      throw new Error(
        "Governance audit legal hold is immutable once enabled for a log store",
      );
    }
    if (manifest.retentionMode === "archive" && this.retentionMode === "delete") {
      throw new Error(
        "Governance audit retentionMode cannot be downgraded from archive to delete",
      );
    }
    if (
      manifest.retentionMode === this.retentionMode &&
      manifest.legalHold === this.legalHold
    ) {
      return manifest;
    }
    const nextManifest: GovernanceAuditManifest = {
      ...manifest,
      updatedAt: this.now(),
      retentionMode:
        manifest.retentionMode === "archive" ? "archive" : this.retentionMode,
      legalHold: manifest.legalHold || this.legalHold,
    };
    await this.saveManifest(nextManifest);
    return nextManifest;
  }

  private async pruneInternal(
    manifest: GovernanceAuditManifest,
  ): Promise<{ removed: number; manifest: GovernanceAuditManifest }> {
    const now = this.now();
    const activeRecords = await this.loadRecords(manifest.activeSeqs, true);
    const removable = new Set<number>();

    for (const record of activeRecords) {
      if (record.expiresAtMs !== undefined && record.expiresAtMs <= now) {
        removable.add(record.seq);
      }
    }

    const retainedAfterExpiry = activeRecords.filter(
      (record) => !removable.has(record.seq),
    );
    if (
      this.maxEntries !== undefined &&
      this.maxEntries >= 0 &&
      retainedAfterExpiry.length > this.maxEntries
    ) {
      const overflowCount = retainedAfterExpiry.length - this.maxEntries;
      for (const record of retainedAfterExpiry.slice(0, overflowCount)) {
        removable.add(record.seq);
      }
    }

    if (removable.size === 0) {
      return { removed: 0, manifest };
    }

    const removedRecords = activeRecords.filter((record) => removable.has(record.seq));
    const nextActiveSeqs = manifest.activeSeqs.filter((seq) => !removable.has(seq));
    const nextArchivedSeqs =
      this.legalHold || this.retentionMode === "archive"
        ? [...manifest.archivedSeqs, ...removedRecords.map((record) => record.seq)]
        : [...manifest.archivedSeqs];

    if (!this.legalHold && this.retentionMode === "delete") {
      for (const record of removedRecords) {
        await this.memoryBackend.delete(recordKey(this.storagePrefix, record.seq));
      }
    }

    const nextManifest: GovernanceAuditManifest = {
      ...manifest,
      updatedAt: now,
      activeSeqs: nextActiveSeqs,
      archivedSeqs: nextArchivedSeqs,
      activeAnchorPrevRecordHash:
        nextActiveSeqs.length > 0
          ? activeRecords.find((record) => record.seq === nextActiveSeqs[0])?.prevRecordHash ??
            manifest.activeAnchorPrevRecordHash
          : manifest.lastRecordHash,
    };
    await this.saveManifest(nextManifest);
    return {
      removed: removedRecords.length,
      manifest: nextManifest,
    };
  }

  private async verifyInternal(
    manifest: GovernanceAuditManifest,
  ): Promise<GovernanceAuditVerification> {
    const archivedRecords = await this.loadRecords(manifest.archivedSeqs, true);
    const activeRecords = await this.loadRecords(manifest.activeSeqs, true);

    const archivedResult = verifyRecordChain({
      records: archivedRecords,
      signingKey: this.signingKey,
      initialPrevRecordHash: "",
    });
    if (!archivedResult.valid) {
      return {
        ...archivedResult,
        archivedEntries: archivedRecords.length,
      };
    }

    if (
      archivedRecords.length > 0 &&
      activeRecords.length > 0 &&
      manifest.activeAnchorPrevRecordHash !==
        archivedRecords[archivedRecords.length - 1]!.recordHash
    ) {
      return {
        valid: false,
        entries: activeRecords.length,
        archivedEntries: archivedRecords.length,
        brokenAt: activeRecords[0]!.seq,
        message: "active chain anchor mismatch",
      };
    }

    const activeResult = verifyRecordChain({
      records: activeRecords,
      signingKey: this.signingKey,
      initialPrevRecordHash: manifest.activeAnchorPrevRecordHash,
    });
    if (!activeResult.valid) {
      return {
        ...activeResult,
        archivedEntries: archivedRecords.length,
        anchorPrevRecordHash:
          manifest.activeAnchorPrevRecordHash || undefined,
      };
    }

    return {
      valid: true,
      entries: activeRecords.length,
      archivedEntries: archivedRecords.length,
      anchorPrevRecordHash: manifest.activeAnchorPrevRecordHash || undefined,
    };
  }

  async append(event: GovernanceAuditEvent): Promise<GovernanceAuditRecord> {
    return this.queue.run(GOVERNANCE_AUDIT_LOCK_KEY, async () => {
      const manifest = await this.applyRetentionPolicy(await this.loadManifest());
      const record = buildRecord({
        event,
        seq: manifest.nextSeq,
        now: this.now(),
        signingKey: this.signingKey,
        redaction: this.redaction,
        prevRecordHash: manifest.lastRecordHash,
        retentionMs: this.retentionMs,
      });
      await this.memoryBackend.set(
        recordKey(this.storagePrefix, record.seq),
        cloneJson(record),
      );
      const nextManifest: GovernanceAuditManifest = {
        ...manifest,
        updatedAt: this.now(),
        nextSeq: record.seq + 1,
        activeSeqs: [...manifest.activeSeqs, record.seq],
        activeAnchorPrevRecordHash:
          manifest.activeSeqs.length === 0
            ? record.prevRecordHash
            : manifest.activeAnchorPrevRecordHash,
        lastRecordHash: record.recordHash,
      };
      await this.saveManifest(nextManifest);
      await this.pruneInternal(nextManifest);
      return record;
    });
  }

  async getAll(
    options: GovernanceAuditRecordListOptions = {},
  ): Promise<ReadonlyArray<GovernanceAuditRecord>> {
    return this.queue.run(GOVERNANCE_AUDIT_LOCK_KEY, async () => {
      const manifest = await this.loadManifest();
      const archivedRecords = options.includeArchived
        ? await this.loadRecords(manifest.archivedSeqs)
        : [];
      const activeRecords = await this.loadRecords(manifest.activeSeqs);
      return [...archivedRecords, ...activeRecords];
    });
  }

  async prune(): Promise<number> {
    return this.queue.run(GOVERNANCE_AUDIT_LOCK_KEY, async () => {
      const manifest = await this.applyRetentionPolicy(await this.loadManifest());
      const result = await this.pruneInternal(manifest);
      return result.removed;
    });
  }

  async verify(): Promise<GovernanceAuditVerification> {
    return this.queue.run(GOVERNANCE_AUDIT_LOCK_KEY, async () => {
      const manifest = await this.loadManifest();
      return this.verifyInternal(manifest);
    });
  }

  async clear(): Promise<void> {
    await this.queue.run(GOVERNANCE_AUDIT_LOCK_KEY, async () => {
      const manifest = await this.loadManifest();
      const seqs = [...manifest.archivedSeqs, ...manifest.activeSeqs];
      for (const seq of seqs) {
        await this.memoryBackend.delete(recordKey(this.storagePrefix, seq));
      }
      await this.memoryBackend.delete(manifestKey(this.storagePrefix));
    });
  }

  async exportRecords(
    options: GovernanceAuditRecordListOptions = {},
  ): Promise<GovernanceAuditExport> {
    return this.queue.run(GOVERNANCE_AUDIT_LOCK_KEY, async () => {
      const manifest = await this.loadManifest();
      const archivedRecords =
        options.includeArchived === false
          ? []
          : await this.loadRecords(manifest.archivedSeqs, true);
      const activeRecords = await this.loadRecords(manifest.activeSeqs, true);
      return {
        exportedAt: new Date(this.now()).toISOString(),
        retentionMode: manifest.retentionMode,
        legalHold: manifest.legalHold,
        activeRecords,
        archivedRecords,
      };
    });
  }
}
