import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as nodeSetTimeout } from 'node:timers/promises';
import { EventParser } from '@coral-xyz/anchor';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import {
  createReadOnlyProgram,
  FileReplayTimelineStore,
  InMemoryReplayTimelineStore,
  PROGRAM_ID,
  ReplayBackfillService,
  ReplayComparisonService,
  stableStringifyJson,
  type BackfillFetcher,
  type JsonValue,
  type ProjectedTimelineInput,
  type ReplayAnomaly,
  type ReplayComparisonStrictness,
  type ReplayTimelineQuery,
  type ReplayTimelineRecord,
  type ReplayTimelineStore,
  TrajectoryReplayEngine,
} from '@agenc/runtime';
import { type ConfirmedSignatureInfo, Connection, PublicKey } from '@solana/web3.js';
import {
  ReplayBackfillInputSchema,
  ReplayCompareInputSchema,
  ReplayIncidentInputSchema,
  ReplayStatusInputSchema,
  type ReplayBackfillInput,
  type ReplayCompareInput,
  type ReplayIncidentInput,
  type ReplayStatusInput,
  ReplayBackfillOutputSchema,
  ReplayCompareOutputSchema,
  ReplayIncidentOutputSchema,
  ReplayStatusOutputSchema,
  ReplayToolErrorSchema,
  ReplayIncidentValidationSchema,
  ReplayIncidentSummarySchema,
  ReplayIncidentNarrativeSchema,
  REPLAY_BACKFILL_OUTPUT_SCHEMA,
  REPLAY_COMPARE_OUTPUT_SCHEMA,
  REPLAY_INCIDENT_OUTPUT_SCHEMA,
  REPLAY_STATUS_OUTPUT_SCHEMA,
} from './replay-types.js';
import { truncateOutput } from '../utils/truncation.js';
import type { ReplayComparisonResult } from '@agenc/runtime';
import { parseTrajectoryTrace, type TrajectoryTrace } from '@agenc/runtime';

type JsonObject = Record<string, unknown>;
type ReplayToolOutput = {
  isError: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: JsonObject;
};

type ReplayAuditEvent = {
  timestamp: string;
  tool: string;
  actor: string;
  requestId: string;
  status: 'start' | 'success' | 'failure';
  durationMs: number;
  reason?: string;
};

type ParsedAnchorEvent = {
  name: string;
  data: unknown;
};

type ReplayToolResult = Promise<ReplayToolOutput>;
type ReplayToolRuntime = {
  createStore: (storeType: 'memory' | 'sqlite', sqlitePath?: string) => ReplayTimelineStore;
  createBackfillFetcher: (rpcUrl: string, programId?: string) => BackfillFetcher;
  readLocalTrace: (path: string) => TrajectoryTrace;
  getCurrentSlot?: (rpcUrl: string) => Promise<number>;
};

export type ReplayPolicy = {
  maxSlotWindow: number;
  maxEventCount: number;
  maxConcurrentJobs: number;
  maxToolRuntimeMs: number;
  allowlist: Set<string>;
  denylist: Set<string>;
  defaultRedactions: string[];
  auditEnabled: boolean;
};

type ReplayToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification> | undefined;

const DEFAULT_REPLAY_POLICY: ReplayPolicy = {
  maxSlotWindow: 2_000_000,
  maxEventCount: 250_000,
  maxConcurrentJobs: 2,
  maxToolRuntimeMs: 180_000,
  allowlist: new Set<string>(),
  denylist: new Set<string>(),
  defaultRedactions: ['signature'],
  auditEnabled: false,
};

const DEFAULT_REPLAY_RUNTIME: ReplayToolRuntime = {
  createStore(storeType, sqlitePath): ReplayTimelineStore {
    if (storeType === 'sqlite') {
      return new FileReplayTimelineStore(sqlitePath ?? '.agenc/replay-events.json');
    }
    return new InMemoryReplayTimelineStore();
  },
  createBackfillFetcher(rpcUrl, programId) {
    const programIdValue = programId ?? PROGRAM_ID.toBase58();
    const parsedProgramId = new PublicKey(programIdValue);
    const connection = new Connection(rpcUrl);
    const program = createReadOnlyProgram(connection, parsedProgramId);
    const parser = new EventParser(program.programId, program.coder);

    return {
      async fetchPage(cursor, toSlot, pageSize): Promise<{ events: ReadonlyArray<ProjectedTimelineInput>; nextCursor: { slot: number; signature: string; eventName?: string; traceId?: string; traceSpanId?: string; } | null; done: boolean; }> {
        const limit = clampPageSize(pageSize);
        const rawSignatures = await connection.getSignaturesForAddress(
          parsedProgramId,
          {
            before: cursor?.signature,
            limit,
          },
        ) as ConfirmedSignatureInfo[];

        if (rawSignatures.length === 0) {
          return { events: [], nextCursor: null, done: true };
        }

        const projected: ProjectedTimelineInput[] = [];
        const includedSignatures = new Map<string, { slot: number; signature: string }>();

        for (const signatureInfo of rawSignatures) {
          if (signatureInfo.slot > toSlot || signatureInfo.slot < 0 || !Number.isInteger(signatureInfo.slot)) {
            continue;
          }

          const tx = await connection.getTransaction(signatureInfo.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          if (tx === null || tx.meta === null || tx.meta === undefined) {
            continue;
          }

          const logs = tx.meta.logMessages;
          if (!Array.isArray(logs)) {
            continue;
          }

          const timestampMs = tx.blockTime !== null
            && tx.blockTime !== undefined
            && Number.isInteger(tx.blockTime)
            ? tx.blockTime * 1_000
            : undefined;
          const parsedEvents = parseAnchorLogs(parser, logs);

          for (let index = 0; index < parsedEvents.length; index += 1) {
            const event = parsedEvents[index];
            projected.push({
              eventName: event.name,
              event: event.data,
              slot: signatureInfo.slot,
              signature: signatureInfo.signature,
              timestampMs,
              sourceEventSequence: index,
            });
          }

          includedSignatures.set(signatureInfo.signature, {
            slot: signatureInfo.slot,
            signature: signatureInfo.signature,
          });
        }

        const sorted = [...projected].sort(compareProjectedInputs);
        const lastSignature = rawSignatures[rawSignatures.length - 1]?.signature;

        return {
          events: sorted,
          nextCursor: lastSignature === undefined ? null : {
            slot: includedSignatures.get(lastSignature)?.slot ?? signatureForFallback(rawSignatures),
            signature: lastSignature,
            eventName: sorted.at(-1)?.eventName,
          },
          done: rawSignatures.length < limit,
        };
      },
    };
  },
  readLocalTrace(path) {
    const raw = readFileSync(path, 'utf8');
    return parseTrajectoryTrace(JSON.parse(raw) as unknown);
  },
  async getCurrentSlot(rpcUrl) {
    return new Connection(rpcUrl).getSlot('confirmed');
  },
};

let activeReplayJobs = 0;

function stringFromPolicyEnv(value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
}

function booleanFromEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function intFromEnv(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(parsed, min);
}

function setFromEnv(value: string | undefined): Set<string> {
  if (!value) {
    return new Set<string>();
  }

  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function loadReplayPolicy(): ReplayPolicy {
  return {
    maxSlotWindow: intFromEnv(process.env.MCP_REPLAY_MAX_SLOT_WINDOW, DEFAULT_REPLAY_POLICY.maxSlotWindow, 0),
    maxEventCount: intFromEnv(process.env.MCP_REPLAY_MAX_EVENT_COUNT, DEFAULT_REPLAY_POLICY.maxEventCount, 0),
    maxConcurrentJobs: intFromEnv(process.env.MCP_REPLAY_MAX_CONCURRENT_JOBS, DEFAULT_REPLAY_POLICY.maxConcurrentJobs, 1),
    maxToolRuntimeMs: intFromEnv(process.env.MCP_REPLAY_TOOL_TIMEOUT_MS, DEFAULT_REPLAY_POLICY.maxToolRuntimeMs, 1_000),
    allowlist: setFromEnv(stringFromPolicyEnv(process.env.MCP_REPLAY_ALLOWLIST, '')),
    denylist: setFromEnv(stringFromPolicyEnv(process.env.MCP_REPLAY_DENYLIST, '')),
    defaultRedactions: [...new Set([
      ...DEFAULT_REPLAY_POLICY.defaultRedactions,
      ...Array.from(setFromEnv(process.env.MCP_REPLAY_DEFAULT_REDACTIONS)),
    ])],
    auditEnabled: booleanFromEnv(process.env.MCP_REPLAY_AUDIT_ENABLED, DEFAULT_REPLAY_POLICY.auditEnabled),
  };
}

function classifyControlError(error: unknown, toolName: string): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'replay.cancelled', message };
  }
  if (message.includes('was cancelled')) {
    return { code: 'replay.cancelled', message };
  }
  if (message.includes('timed out')) {
    return { code: 'replay.timeout', message };
  }
  return { code: 'replay.tool_error', message: `${toolName}: ${message}` };
}

function enforceQueryWindow(
  command: string,
  schema: string,
  fromSlot: number | undefined,
  toSlot: number | undefined,
  maxSlotWindow: number,
): ReplayToolOutput | null {
  if (maxSlotWindow <= 0 || fromSlot === undefined || toSlot === undefined) {
    return null;
  }
  if (toSlot < fromSlot) {
    return createToolError(
      command,
      schema,
      'replay.slot_window_exceeded',
      `to_slot (${toSlot}) must be greater than or equal to from_slot (${fromSlot})`,
      false,
      { fromSlot, toSlot, maxSlotWindow },
    );
  }
  const windowSlots = toSlot - fromSlot;
  if (windowSlots > maxSlotWindow) {
    return createToolError(
      command,
      schema,
      'replay.slot_window_exceeded',
      `slot window ${windowSlots} exceeds policy limit ${maxSlotWindow}`,
      false,
      { fromSlot, toSlot, maxSlotWindow },
    );
  }
  return null;
}

function getActor(extra: ReplayToolRequestExtra): string {
  const authInfo = extra?.authInfo;
  if (authInfo?.clientId) {
    return authInfo.clientId;
  }
  if (extra?.sessionId) {
    return `session:${extra.sessionId}`;
  }
  return 'anonymous';
}

function getRequestId(extra: ReplayToolRequestExtra): string {
  const id = extra?.requestId;
  if (id === undefined) {
    return 'unknown';
  }
  return String(id);
}

function emitReplayAudit(event: ReplayAuditEvent): void {
  if (!event.reason) {
    delete (event as { reason?: string }).reason;
  }
  console.info(`mcp.replay.audit ${JSON.stringify(event)}`);
}

function parseAnchorLogs(parser: EventParser, logs: string[]): ParsedAnchorEvent[] {
  const parsedEvents = [] as ParsedAnchorEvent[];
  for (const parsed of parser.parseLogs(logs, false)) {
    if (
      typeof parsed !== 'object'
      || parsed === null
      || typeof (parsed as { name?: unknown }).name !== 'string'
    ) {
      continue;
    }

    parsedEvents.push({
      name: (parsed as { name: string }).name,
      data: (parsed as { data?: unknown }).data,
    });
  }
  return parsedEvents;
}

function clampPageSize(value: number, min = 1, max = 1_000): number {
  if (!Number.isInteger(value)) {
    return 100;
  }
  return Math.min(Math.max(value, min), max);
}

function signatureForFallback(signatures: ReadonlyArray<ConfirmedSignatureInfo>): number {
  const last = signatures.at(-1);
  return last?.slot ?? 0;
}

function compareProjectedInputs(left: ProjectedTimelineInput, right: ProjectedTimelineInput): number {
  if (left.slot !== right.slot) {
    return left.slot - right.slot;
  }
  if (left.signature !== right.signature) {
    return left.signature.localeCompare(right.signature);
  }
  if ((left.sourceEventSequence ?? 0) !== (right.sourceEventSequence ?? 0)) {
    return (left.sourceEventSequence ?? 0) - (right.sourceEventSequence ?? 0);
  }
  return left.eventName.localeCompare(right.eventName);
}

function pickQuery(input: {
  task_pda?: string;
  dispute_pda?: string;
  from_slot?: number;
  to_slot?: number;
}): ReplayTimelineQuery {
  return {
    taskPda: input.task_pda,
    disputePda: input.dispute_pda,
    fromSlot: input.from_slot,
    toSlot: input.to_slot,
  };
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') {
      return `${item}n`;
    }
    return item;
  });
}

function clone<T>(value: T): T {
  return JSON.parse(safeStringify(value)) as T;
}

function asRecord(value: unknown): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function createToolError(
  command: string,
  schema: string,
  code: string,
  message: string,
  retriable = false,
  details?: JsonObject,
): ReplayToolOutput {
  const payload = ReplayToolErrorSchema.parse({
    status: 'error',
    command,
    schema,
    code,
    message,
    details,
    retriable,
  } as const);
  return {
    isError: true,
    content: [{ type: 'text', text: safeStringify(payload) }],
    structuredContent: payload,
  };
}

function createToolOutput<T extends z.ZodTypeAny>(
  schema: T,
  command: string,
  payload: unknown,
): ReplayToolOutput {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return createToolError(
      command,
      'schema-validation',
      'replay.output_validation_failed',
      `${command}: ${parsed.error.errors.map((error) => error.message).join('; ')}`,
      false,
    );
  }

  return {
    isError: false,
    content: [{ type: 'text', text: safeStringify(parsed.data) }],
    structuredContent: parsed.data as JsonObject,
  };
}

function parseSections(sections: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(sections) || sections.length === 0) {
    return [...allowed];
  }
  const values = new Set<string>();
  for (const section of sections) {
    if (typeof section === 'string' && allowed.includes(section)) {
      values.add(section);
    }
  }
  return values.size > 0 ? [...values] : [...allowed];
}

function applySectionSelection<T extends JsonObject>(payload: T, allowedSections: readonly string[], selectedSections: string[]): T {
  const selected = new Set(selectedSections);
  const output = clone(payload) as Record<string, unknown>;
  for (const section of allowedSections) {
    if (!selected.has(section)) {
      output[section] = null;
    }
  }
  return output as T;
}

function applyRedaction<T>(value: T, fields: readonly string[]): T {
  if (fields.length === 0) {
    return value;
  }
  const fieldSet = new Set(fields);

  const transform = (input: unknown): unknown => {
    if (input === null || input === undefined || typeof input !== 'object') {
      return input;
    }

    if (Array.isArray(input)) {
      return input.map((entry) => transform(entry));
    }

    const record = input as JsonObject;
    const output = {} as JsonObject;

    for (const [key, value] of Object.entries(record)) {
      if (fieldSet.has(key)) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = transform(value);
      }
    }

    return output;
  };

  return transform(value) as T;
}

function trimBackfillPayload(payload: JsonObject): JsonObject {
  const output = clone(payload);
  if (output.result && typeof output.result === 'object' && output.result !== null) {
    const result = output.result as JsonObject;
    result.cursor = null;
  }
  return output;
}

function trimComparePayload(payload: JsonObject): JsonObject {
  const output = clone(payload);
  if (output.result && typeof output.result === 'object' && output.result !== null) {
    const result = output.result as JsonObject;
    if (result.local_summary) {
      result.local_summary = {};
    }
    if (result.projected_summary) {
      result.projected_summary = {};
    }
    result.top_anomalies = [];
    result.anomaly_ids = [];
  }
  return output;
}

function trimIncidentPayload(payload: JsonObject): JsonObject {
  const output = clone(payload);
  if (output.summary && typeof output.summary === 'object' && output.summary !== null) {
    const summary = output.summary as JsonObject;
    if (Array.isArray(summary.events)) {
      summary.events = [];
    }
  }
  if (output.validation && typeof output.validation === 'object' && output.validation !== null) {
    const validation = output.validation as JsonObject;
    const eventValidation = validation.event_validation as JsonObject;
    if (eventValidation && typeof eventValidation === 'object') {
      eventValidation.errors = [];
      eventValidation.warnings = [];
    }
  }
  if (output.narrative && typeof output.narrative === 'object' && output.narrative !== null) {
    const narrative = output.narrative as JsonObject;
    narrative.lines = [];
    narrative.anomaly_ids = [];
  }
  return output;
}

function summarizeReplayComparison(comparison: ReplayComparisonResult): {
  status: 'clean' | 'mismatched';
  strictness: ReplayComparisonStrictness;
  local_event_count: number;
  projected_event_count: number;
  mismatch_count: number;
  match_rate: number;
  anomaly_ids: string[];
  top_anomalies: Array<{
    anomaly_id: string;
    code: string;
    severity: string;
    message: string;
    source_event_name?: string;
    signature?: string;
    seq?: number;
  }>;
  hashes: {
    local: string;
    projected: string;
  };
  local_summary: JsonObject;
  projected_summary: JsonObject;
} {
  const result = {
    status: comparison.status,
    strictness: comparison.strictness,
    local_event_count: comparison.localEventCount,
    projected_event_count: comparison.projectedEventCount,
    mismatch_count: comparison.mismatchCount,
    match_rate: comparison.matchRate,
    anomaly_ids: comparison.anomalies.map((entry, index) => buildReplayAnomalyId(entry, index)),
    top_anomalies: comparison.anomalies.slice(0, 50).map((entry) => ({
      anomaly_id: buildReplayAnomalyId(entry, entry.context.seq ?? 0),
      code: entry.code,
      severity: entry.severity,
      message: entry.message,
      source_event_name: entry.context.sourceEventName,
      signature: entry.context.signature,
      seq: entry.context.seq,
    })),
    hashes: {
      local: comparison.localReplay.deterministicHash,
      projected: comparison.projectedReplay.deterministicHash,
    },
    local_summary: asRecord(comparison.localReplay.summary) ?? {},
    projected_summary: asRecord(comparison.projectedReplay.summary) ?? {},
  };

  return result;
}

function buildReplayAnomalyId(anomaly: ReplayAnomaly, seed = 0): string {
  const context = anomaly.context;
  const key = [
    anomaly.code,
    context.taskPda ?? '',
    context.disputePda ?? '',
    context.sourceEventName ?? '',
    context.seq ?? seed,
    context.signature ?? '',
    anomaly.message,
  ].join('|');

  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function deriveIncidentTraceId(filters: {
  taskPda?: string;
  disputePda?: string;
  fromSlot?: number;
  toSlot?: number;
}): string {
  const key = stableStringifyJson({
    taskPda: filters.taskPda ?? null,
    disputePda: filters.disputePda ?? null,
    fromSlot: filters.fromSlot ?? null,
    toSlot: filters.toSlot ?? null,
  } as JsonValue);
  return createHash('sha256').update(`incident:${key}`).digest('hex').slice(0, 32);
}

function summarizeReplayIncident(
  records: readonly ReplayTimelineRecord[],
  filters: { taskPda?: string; disputePda?: string; fromSlot?: number; toSlot?: number },
): {
  total_events: number;
  task_pda_filters: Array<string | null>;
  dispute_pda_filters: Array<string | null>;
  from_slot?: number;
  to_slot?: number;
  unique_task_ids: string[];
  unique_dispute_ids: string[];
  source_event_type_counts: Record<string, number>;
  source_event_name_counts: Record<string, number>;
  trace_id_counts: Record<string, number>;
  events: Array<{
    seq: number;
    slot: number;
    signature: string;
    source_event_type: string;
    source_event_name: string;
    task_pda?: string;
    dispute_pda?: string;
    timestamp_ms: number;
    trace_id?: string;
    trace_span_id?: string;
  }>;
} {
  const sorted = [...records].sort((left, right) => {
    if (left.seq !== right.seq) {
      return left.seq - right.seq;
    }
    if (left.slot !== right.slot) {
      return left.slot - right.slot;
    }
    return left.signature.localeCompare(right.signature);
  });

  const taskIds = new Set<string>();
  const disputeIds = new Set<string>();
  const sourceEventTypeCounts: Record<string, number> = {};
  const sourceEventNameCounts: Record<string, number> = {};
  const traceIdCounts: Record<string, number> = {};

  const events = sorted.map((record) => {
    sourceEventTypeCounts[record.sourceEventType] = (sourceEventTypeCounts[record.sourceEventType] ?? 0) + 1;
    sourceEventNameCounts[record.sourceEventName] = (sourceEventNameCounts[record.sourceEventName] ?? 0) + 1;
    if (record.traceId) {
      traceIdCounts[record.traceId] = (traceIdCounts[record.traceId] ?? 0) + 1;
    }
    if (record.taskPda) {
      taskIds.add(record.taskPda);
    }
    if (record.disputePda) {
      disputeIds.add(record.disputePda);
    }

    return {
      seq: record.seq,
      slot: record.slot,
      signature: record.signature,
      source_event_type: record.sourceEventType,
      source_event_name: record.sourceEventName,
      task_pda: record.taskPda,
      dispute_pda: record.disputePda,
      timestamp_ms: record.timestampMs,
      trace_id: record.traceId,
      trace_span_id: record.traceSpanId,
    };
  });

  return {
    total_events: events.length,
    task_pda_filters: [filters.taskPda ?? null],
    dispute_pda_filters: [filters.disputePda ?? null],
    from_slot: filters.fromSlot,
    to_slot: filters.toSlot,
    unique_task_ids: [...taskIds].sort(),
    unique_dispute_ids: [...disputeIds].sort(),
    source_event_type_counts: sourceEventTypeCounts,
    source_event_name_counts: sourceEventNameCounts,
    trace_id_counts: traceIdCounts,
    events,
  };
}

function validateReplayIncident(
  records: readonly ReplayTimelineRecord[],
  strictMode: boolean,
  filters?: { taskPda?: string; disputePda?: string; fromSlot?: number; toSlot?: number },
): {
  strict_mode: boolean;
  event_validation: {
    errors: string[];
    warnings: string[];
    replay_task_count: number;
  };
  anomaly_ids: string[];
  deterministic_hash: string;
} {
  const traceId = filters
    ? `incident-${deriveIncidentTraceId(filters)}`
    : `incident-${records.length}`;

  const replay = new TrajectoryReplayEngine({ strictMode }).replay({
    schemaVersion: 1,
    traceId,
    seed: 0,
    createdAtMs: 0,
    events: records.map((record) => ({
      seq: record.seq,
      type: record.type,
      taskPda: record.taskPda,
      timestampMs: record.timestampMs,
      payload: record.payload,
    })),
  });

  const anomalyIds = [...replay.errors, ...replay.warnings].map((message) => {
    return createHash('sha1')
      .update(message)
      .digest('hex')
      .slice(0, 16);
  });

  const replayTaskCount = Object.keys(replay.tasks).length;

  const result = {
    strict_mode: strictMode,
    event_validation: {
      errors: [...replay.errors].sort(),
      warnings: [...replay.warnings].sort(),
      replay_task_count: replayTaskCount,
    },
    anomaly_ids: [...anomalyIds].sort(),
  };

  const deterministicHash = createHash('sha256')
    .update(stableStringifyJson(result as unknown as JsonValue))
    .digest('hex');

  return {
    ...result,
    deterministic_hash: deterministicHash,
  };
}

function buildIncidentNarrative(
  events: {
    seq: number;
    slot: number;
    signature: string;
    source_event_name: string;
    source_event_type: string;
    anomaly_id: string;
  }[],
  validation: { event_validation: { errors: string[]; warnings: string[] } },
): { lines: string[]; anomaly_ids: string[]; deterministic_hash: string } {
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);

  const anomalyLines = sortedEvents.slice(0, 100).map((event) => {
    const marker = event.anomaly_id.length > 0 ? ` | anomaly:${event.anomaly_id}` : '';
    return `${event.seq}/${event.slot}/${event.signature}: ${event.source_event_name} (${event.source_event_type})${marker}`;
  });

  const validationLines = [
    ...validation.event_validation.errors.sort(),
    ...validation.event_validation.warnings.sort(),
  ].map((line) => `validation:${line}`);

  const lines = [...anomalyLines, ...validationLines];
  const anomaly_ids = sortedEvents
    .map((entry) => entry.anomaly_id)
    .filter((entry) => entry.length > 0)
    .sort();

  const deterministicHash = createHash('sha256')
    .update(stableStringifyJson(lines as unknown as JsonValue))
    .digest('hex');

  return { lines, anomaly_ids, deterministic_hash: deterministicHash };
}

function mergeRedactions(...sections: string[][]): string[] {
  const merged = new Set<string>();
  for (const section of sections) {
    for (const entry of section) {
      merged.add(entry);
    }
  }
  return [...merged];
}

async function withReplayPolicyControl(
  toolName: string,
  outputSchema: string,
  extra: ReplayToolRequestExtra,
  policy: ReplayPolicy,
  callback: () => ReplayToolResult,
): ReplayToolResult {
  const actor = getActor(extra);
  const requestId = getRequestId(extra);
  const start = Date.now();

  const audit: ReplayAuditEvent = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    actor,
    requestId,
    status: 'start',
    durationMs: 0,
  };

  if (policy.auditEnabled) {
    emitReplayAudit(audit);
  }

  if (policy.denylist.size > 0 && policy.denylist.has(actor)) {
    return createToolError(
      toolName,
      outputSchema,
      'replay.access_denied',
      `actor ${actor} is denylisted for replay tools`,
      false,
      { actor, requestId, tool: toolName, command: toolName },
    );
  }
  if (policy.allowlist.size > 0 && !policy.allowlist.has(actor)) {
    return createToolError(
      toolName,
      outputSchema,
      'replay.access_denied',
      `actor ${actor} is not allowlisted for replay tools`,
      false,
      { actor, requestId, tool: toolName, command: toolName },
    );
  }

  if (activeReplayJobs >= policy.maxConcurrentJobs) {
    return createToolError(
      toolName,
      outputSchema,
      'replay.concurrency_limit',
      `max concurrent replay jobs reached (${policy.maxConcurrentJobs})`,
      true,
      { actor, tool: toolName },
    );
  }

  activeReplayJobs += 1;
  const timeout = policy.maxToolRuntimeMs > 0 ? policy.maxToolRuntimeMs : null;
  const timeoutPromise = timeout === null
    ? Promise.resolve<ReplayToolOutput | never>(undefined as never)
    : nodeSetTimeout(timeout).then(() => {
      throw new Error(`replay tool ${toolName} timed out after ${timeout}ms`);
    });
  let removeAbortListener = () => {};
  const abortPromise = new Promise<ReplayToolOutput | never>((_, reject) => {
    const signal = extra?.signal;
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      reject(new Error(`replay tool ${toolName} was cancelled`));
      return;
    }
    const handler = () => reject(new Error(`replay tool ${toolName} was cancelled`));
    signal.addEventListener('abort', handler, { once: true });
    const cleanup = () => {
      signal.removeEventListener('abort', handler);
    };
    removeAbortListener = cleanup;
  });

  try {
    const outcome = await Promise.race([callback(), timeoutPromise, abortPromise]);
    const parsed = outcome ?? {
      isError: true,
      content: [{ type: 'text', text: safeStringify({ message: 'tool returned no output' }) }],
      structuredContent: { status: 'error' },
    } as ReplayToolOutput;
    audit.status = parsed.isError ? 'failure' : 'success';
    return parsed;
  } catch (error) {
    const classified = classifyControlError(error, toolName);
    return createToolError(
      toolName,
      outputSchema,
      classified.code,
      classified.message,
      true,
      { actor, tool: toolName, requestId },
    );
  } finally {
    activeReplayJobs = Math.max(0, activeReplayJobs - 1);
    removeAbortListener();
    if (audit.status === 'start') {
      audit.status = 'failure';
    }
    audit.durationMs = Date.now() - start;
    if (policy.auditEnabled) {
      emitReplayAudit(audit);
    }
  }
}

function enforcePolicyWindow(
  command: string,
  parsed: ReplayBackfillInput,
  currentSlot: number | null,
  maxSlotWindow: number,
): ReplayToolOutput | null {
  if (currentSlot === null || maxSlotWindow <= 0) {
    return null;
  }

  const windowSlots = currentSlot - parsed.to_slot;
  if (windowSlots > maxSlotWindow) {
    return createToolError(
      command,
      REPLAY_BACKFILL_OUTPUT_SCHEMA,
      'replay.slot_window_exceeded',
      `to_slot is more than ${maxSlotWindow} slots behind current slot`,
      false,
      { currentSlot, toSlot: parsed.to_slot, maxSlotWindow },
    );
  }
  return null;
}

function enforceEventCap(
  command: string,
  actualCount: number,
  cap: number,
  schema: string,
  fields?: JsonObject,
): ReplayToolOutput | null {
  if (cap <= 0 || actualCount <= cap) {
    return null;
  }
  return createToolError(
    command,
    schema,
    'replay.event_cap_exceeded',
    `result count ${actualCount} exceeds policy cap ${cap}`,
    false,
    fields ?? {},
  );
}

export function registerReplayTools(server: McpServer): void {
  server.tool(
    'agenc_replay_backfill',
    'Backfill replay timeline records from on-chain events.',
    ReplayBackfillInputSchema.shape,
    (args, extra) => runReplayBackfillTool(args, DEFAULT_REPLAY_RUNTIME, loadReplayPolicy(), extra),
  );
  server.tool(
    'agenc_replay_compare',
    'Compare replay projection timeline against a local trajectory trace.',
    ReplayCompareInputSchema.shape,
    (args, extra) => runReplayCompareTool(args, DEFAULT_REPLAY_RUNTIME, loadReplayPolicy(), extra),
  );
  server.tool(
    'agenc_replay_incident',
    'Reconstruct replay incident timeline and validation narrative.',
    ReplayIncidentInputSchema.shape,
    (args, extra) => runReplayIncidentTool(args, DEFAULT_REPLAY_RUNTIME, loadReplayPolicy(), extra),
  );
  server.tool(
    'agenc_replay_status',
    'Inspect replay store status summary.',
    ReplayStatusInputSchema.shape,
    (args, extra) => runReplayStatusTool(args, DEFAULT_REPLAY_RUNTIME, loadReplayPolicy(), extra),
  );
}

export async function runReplayBackfillTool(
  args: unknown,
  runtime: ReplayToolRuntime = DEFAULT_REPLAY_RUNTIME,
  policy: ReplayPolicy = loadReplayPolicy(),
  extra?: ReplayToolRequestExtra,
): ReplayToolResult {
  let parsed: ReplayBackfillInput;
  try {
    parsed = ReplayBackfillInputSchema.parse(args);
  } catch (error) {
    return createToolError(
      'agenc_replay_backfill',
      REPLAY_BACKFILL_OUTPUT_SCHEMA,
      'replay.invalid_input',
      error instanceof Error ? error.message : String(error),
      false,
    );
  }

  return withReplayPolicyControl(
    'agenc_replay_backfill',
    REPLAY_BACKFILL_OUTPUT_SCHEMA,
    extra,
    policy,
    async () => {
      try {
        const currentSlot = parsed.rpc === '' ? null : await runtime.getCurrentSlot?.(parsed.rpc) ?? null;
        const windowError = enforcePolicyWindow('agenc_replay_backfill', parsed, currentSlot, policy.maxSlotWindow);
        if (windowError) {
          return windowError;
        }

        const store = runtime.createStore(parsed.store_type, parsed.sqlite_path);
        const fetcher = runtime.createBackfillFetcher(parsed.rpc, parsed.program_id);
        const redactions = mergeRedactions(policy.defaultRedactions, parsed.redact_fields);
        const sections = parseSections(parsed.sections, ['result']);
        const backfill = new ReplayBackfillService(store, {
          toSlot: parsed.to_slot,
          pageSize: parsed.page_size,
          fetcher,
          tracePolicy: {
            traceId: parsed.trace_id,
            emitOtel: false,
            sampleRate: parsed.strict_mode ? 1 : 0.1,
          },
        });

        const result = await backfill.runBackfill();
        const capError = enforceEventCap(
          'agenc_replay_backfill',
          result.processed,
          policy.maxEventCount,
          REPLAY_BACKFILL_OUTPUT_SCHEMA,
          { processed: result.processed, maxEventCount: policy.maxEventCount },
        );
        if (capError) {
          return capError;
        }

        const rawPayload = {
          status: 'ok',
          command: 'agenc_replay_backfill',
          schema: REPLAY_BACKFILL_OUTPUT_SCHEMA,
          mode: 'backfill',
          to_slot: parsed.to_slot,
          store_type: parsed.store_type,
          page_size: parsed.page_size,
          result: {
            processed: result.processed,
            duplicates: result.duplicates,
            cursor: result.cursor === null ? null : {
              slot: result.cursor.slot,
              signature: result.cursor.signature,
              event_name: result.cursor.eventName,
              trace_id: result.cursor.traceId,
              trace_span_id: result.cursor.traceSpanId,
            },
          },
          command_params: {
            rpc: parsed.rpc,
            strict_mode: parsed.strict_mode,
            page_size: parsed.page_size,
            trace_id: parsed.trace_id,
            sqlite_path: parsed.sqlite_path,
            max_slot_window: policy.maxSlotWindow,
          },
          sections,
          redactions,
          truncated: false,
          truncation_reason: null as string | null,
        };

        const processedSections = applySectionSelection(rawPayload, ['result'], sections);
        const redacted = applyRedaction(processedSections, redactions);
        const truncated = truncateOutput(redacted, parsed.max_payload_bytes, trimBackfillPayload);

        return createToolOutput(
          ReplayBackfillOutputSchema,
          'agenc_replay_backfill',
          {
            ...truncated.payload,
            truncated: truncated.truncated,
            truncation_reason: truncated.reason,
          },
        );
      } catch (error) {
        return createToolError(
          'agenc_replay_backfill',
          REPLAY_BACKFILL_OUTPUT_SCHEMA,
          'replay.backfill_failed',
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  );
}

export async function runReplayCompareTool(
  args: unknown,
  runtime: ReplayToolRuntime = DEFAULT_REPLAY_RUNTIME,
  policy: ReplayPolicy = loadReplayPolicy(),
  extra?: ReplayToolRequestExtra,
): ReplayToolResult {
  let parsed: ReplayCompareInput;
  try {
    parsed = ReplayCompareInputSchema.parse(args);
  } catch (error) {
    return createToolError(
      'agenc_replay_compare',
      REPLAY_COMPARE_OUTPUT_SCHEMA,
      'replay.invalid_input',
      error instanceof Error ? error.message : String(error),
      false,
    );
  }

  return withReplayPolicyControl(
    'agenc_replay_compare',
    REPLAY_COMPARE_OUTPUT_SCHEMA,
    extra,
    policy,
    async () => {
      try {
        const store = runtime.createStore(parsed.store_type, parsed.sqlite_path);
        const localTrace = runtime.readLocalTrace(parsed.local_trace_path);
        const windowError = enforceQueryWindow(
          'agenc_replay_compare',
          REPLAY_COMPARE_OUTPUT_SCHEMA,
          parsed.from_slot,
          parsed.to_slot,
          policy.maxSlotWindow,
        );
        if (windowError) {
          return windowError;
        }
        const records = await store.query(pickQuery(parsed));
        const capError = enforceEventCap(
          'agenc_replay_compare',
          records.length,
          policy.maxEventCount,
          REPLAY_COMPARE_OUTPUT_SCHEMA,
          { maxEventCount: policy.maxEventCount },
        );
        if (capError) {
          return capError;
        }

        const strictness: ReplayComparisonStrictness = parsed.strict_mode ? 'strict' : 'lenient';
        const comparison = await new ReplayComparisonService().compare({
          projected: records,
          localTrace,
          options: {
            strictness,
            taskPda: parsed.task_pda,
            disputePda: parsed.dispute_pda,
          },
        });
        const sections = parseSections(parsed.sections, ['result']);
        const redactions = mergeRedactions(policy.defaultRedactions, parsed.redact_fields);
        const rawPayload = {
          status: 'ok',
          command: 'agenc_replay_compare',
          schema: REPLAY_COMPARE_OUTPUT_SCHEMA,
          strictness,
          local_trace_path: parsed.local_trace_path,
          result: summarizeReplayComparison(comparison),
          task_pda: parsed.task_pda ?? null,
          dispute_pda: parsed.dispute_pda ?? null,
          sections,
          redactions,
          command_params: {
            task_pda: parsed.task_pda,
            dispute_pda: parsed.dispute_pda,
            strict_mode: parsed.strict_mode,
            store_type: parsed.store_type,
            trace_id: parsed.trace_id,
          },
          truncated: false,
          truncation_reason: null as string | null,
        };

        const output = applySectionSelection(rawPayload, ['result'], sections);
        const redacted = applyRedaction(output, redactions);
        const truncated = truncateOutput(redacted, parsed.max_payload_bytes, trimComparePayload);

        return createToolOutput(
          ReplayCompareOutputSchema,
          'agenc_replay_compare',
          {
            ...truncated.payload,
            truncated: truncated.truncated,
            truncation_reason: truncated.reason,
          },
        );
      } catch (error) {
        return createToolError(
          'agenc_replay_compare',
          REPLAY_COMPARE_OUTPUT_SCHEMA,
          'replay.compare_failed',
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  );
}

export async function runReplayIncidentTool(
  args: unknown,
  runtime: ReplayToolRuntime = DEFAULT_REPLAY_RUNTIME,
  policy: ReplayPolicy = loadReplayPolicy(),
  extra?: ReplayToolRequestExtra,
): ReplayToolResult {
  let parsed: ReplayIncidentInput;
  try {
    parsed = ReplayIncidentInputSchema.parse(args);
  } catch (error) {
    return createToolError(
      'agenc_replay_incident',
      REPLAY_INCIDENT_OUTPUT_SCHEMA,
      'replay.invalid_input',
      error instanceof Error ? error.message : String(error),
      false,
    );
  }

  if (parsed.task_pda === undefined && parsed.dispute_pda === undefined) {
    return createToolError(
      'agenc_replay_incident',
      REPLAY_INCIDENT_OUTPUT_SCHEMA,
      'replay.missing_filter',
      'incident requires task_pda or dispute_pda',
      false,
    );
  }

  return withReplayPolicyControl(
    'agenc_replay_incident',
    REPLAY_INCIDENT_OUTPUT_SCHEMA,
    extra,
    policy,
    async () => {
      try {
        const store = runtime.createStore(parsed.store_type, parsed.sqlite_path);
        const windowError = enforceQueryWindow(
          'agenc_replay_incident',
          REPLAY_INCIDENT_OUTPUT_SCHEMA,
          parsed.from_slot,
          parsed.to_slot,
          policy.maxSlotWindow,
        );
        if (windowError) {
          return windowError;
        }
        const records = await store.query(pickQuery(parsed));
        const capError = enforceEventCap(
          'agenc_replay_incident',
          records.length,
          policy.maxEventCount,
          REPLAY_INCIDENT_OUTPUT_SCHEMA,
          { maxEventCount: policy.maxEventCount },
        );
        if (capError) {
          return capError;
        }

        const sections = parseSections(parsed.sections, ['summary', 'validation', 'narrative']);
        const redactions = mergeRedactions(policy.defaultRedactions, parsed.redact_fields);
        const summary = summarizeReplayIncident(records, {
          taskPda: parsed.task_pda,
          disputePda: parsed.dispute_pda,
          fromSlot: parsed.from_slot,
          toSlot: parsed.to_slot,
        });
        const validation = validateReplayIncident(records, parsed.strict_mode, {
          taskPda: parsed.task_pda,
          disputePda: parsed.dispute_pda,
          fromSlot: parsed.from_slot,
          toSlot: parsed.to_slot,
        });
        const narrative = buildIncidentNarrative(summary.events.map((entry, index) => ({
          seq: entry.seq,
          slot: entry.slot,
          signature: entry.signature,
          source_event_name: entry.source_event_name,
          source_event_type: entry.source_event_type,
          anomaly_id: validation.anomaly_ids[index] ?? '',
        })), validation);

        const summaryValidation = ReplayIncidentValidationSchema.parse({
          strict_mode: validation.strict_mode,
          event_validation: validation.event_validation,
          anomaly_ids: validation.anomaly_ids,
          deterministic_hash: validation.deterministic_hash,
        }) as z.infer<typeof ReplayIncidentValidationSchema>;

        const summaryPayload = ReplayIncidentSummarySchema.parse(summary) as z.infer<typeof ReplayIncidentSummarySchema>;
        const narrativePayload = ReplayIncidentNarrativeSchema.parse({
          lines: narrative.lines,
          anomaly_ids: narrative.anomaly_ids,
          deterministic_hash: narrative.deterministic_hash,
        }) as z.infer<typeof ReplayIncidentNarrativeSchema>;

        const rawPayload = {
          status: 'ok',
          command: 'agenc_replay_incident',
          schema: REPLAY_INCIDENT_OUTPUT_SCHEMA,
          command_params: {
            task_pda: parsed.task_pda,
            dispute_pda: parsed.dispute_pda,
            from_slot: parsed.from_slot,
            to_slot: parsed.to_slot,
            strict_mode: parsed.strict_mode,
            store_type: parsed.store_type,
            sqlite_path: parsed.sqlite_path,
          },
          sections,
          redactions,
          summary: summaryPayload,
          validation: summaryValidation,
          narrative: narrativePayload,
          truncated: false,
          truncation_reason: null as string | null,
        };

        const filtered = applySectionSelection(rawPayload, ['summary', 'validation', 'narrative'], sections);
        const redacted = applyRedaction(filtered, redactions);
        const truncated = truncateOutput(redacted, parsed.max_payload_bytes, trimIncidentPayload);

        return createToolOutput(
          ReplayIncidentOutputSchema,
          'agenc_replay_incident',
          {
            ...truncated.payload,
            truncated: truncated.truncated,
            truncation_reason: truncated.reason,
          },
        );
      } catch (error) {
        return createToolError(
          'agenc_replay_incident',
          REPLAY_INCIDENT_OUTPUT_SCHEMA,
          'replay.incident_failed',
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  );
}

export async function runReplayStatusTool(
  args: unknown,
  runtime: ReplayToolRuntime = DEFAULT_REPLAY_RUNTIME,
  policy: ReplayPolicy = loadReplayPolicy(),
  extra?: ReplayToolRequestExtra,
): ReplayToolResult {
  let parsed: ReplayStatusInput;
  try {
    parsed = ReplayStatusInputSchema.parse(args);
  } catch (error) {
    return createToolError(
      'agenc_replay_status',
      REPLAY_STATUS_OUTPUT_SCHEMA,
      'replay.invalid_input',
      error instanceof Error ? error.message : String(error),
      false,
    );
  }

  return withReplayPolicyControl(
    'agenc_replay_status',
    REPLAY_STATUS_OUTPUT_SCHEMA,
    extra,
    policy,
    async () => {
      try {
        const sections = parseSections(parsed.sections, ['status']);
        const redactions = mergeRedactions(policy.defaultRedactions, parsed.redact_fields);
        const store = runtime.createStore(parsed.store_type, parsed.sqlite_path);
        const records = await store.query(pickQuery(parsed));
        const capError = enforceEventCap(
          'agenc_replay_status',
          records.length,
          policy.maxEventCount,
          REPLAY_STATUS_OUTPUT_SCHEMA,
          { maxEventCount: policy.maxEventCount },
        );
        if (capError) {
          return capError;
        }

        const taskIds = new Set<string>();
        const disputeIds = new Set<string>();
        for (const record of records) {
          if (record.taskPda) {
            taskIds.add(record.taskPda);
          }
          if (record.disputePda) {
            disputeIds.add(record.disputePda);
          }
        }

        const activeCursor = await store.getCursor();
        const rawPayload = {
          status: 'ok',
          command: 'agenc_replay_status',
          schema: REPLAY_STATUS_OUTPUT_SCHEMA,
          store_type: parsed.store_type,
          event_count: records.length,
          unique_task_count: taskIds.size,
          unique_dispute_count: disputeIds.size,
          active_cursor: activeCursor,
          sections,
          redactions,
          truncated: false,
        };

        const filtered = applySectionSelection(rawPayload, ['status'], sections);
        const redacted = applyRedaction(filtered, redactions);

        return createToolOutput(
          ReplayStatusOutputSchema,
          'agenc_replay_status',
          redacted,
        );
      } catch (error) {
        return createToolError(
          'agenc_replay_status',
          REPLAY_STATUS_OUTPUT_SCHEMA,
          'replay.status_failed',
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  );
}
