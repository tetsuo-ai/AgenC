import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { EventParser } from "@coral-xyz/anchor";
import {
  type Finality,
  Connection,
  type ConfirmedSignatureInfo,
  type SignaturesForAddressOptions,
  PublicKey,
} from "@solana/web3.js";
import { PROGRAM_ID } from "@agenc/sdk";
import {
  parseTrajectoryTrace,
  stableStringifyJson,
  type JsonValue,
  type TrajectoryTrace,
} from "../eval/types.js";
import { createReadOnlyProgram } from "../idl.js";
import { extractDisputePdaFromPayload } from "../replay/pda-utils.js";
import {
  type ReplayEventCursor,
  type BackfillFetcher,
  type ProjectedTimelineInput,
  type ReplayTimelineRecord,
  type ReplayTimelineStore,
} from "../replay/types.js";
import {
  InMemoryReplayTimelineStore,
  SqliteReplayTimelineStore,
} from "../replay/index.js";

interface ParsedAnchorEvent {
  name: string;
  data: unknown;
}

export interface CliReplayStoreOptions {
  storeType: "memory" | "sqlite";
  sqlitePath?: string;
}

export interface CliReplayBackfillConfig {
  rpcUrl: string;
  programId?: string;
}

export interface CliReplayIncidentEvent {
  seq: number;
  slot: number;
  signature: string;
  sourceEventType: string;
  sourceEventName: string;
  taskPda?: string;
  disputePda?: string;
  timestampMs: number;
  traceId?: string;
  traceSpanId?: string;
}

export interface CliReplayIncidentSummary {
  totalEvents: number;
  taskPdaFilters: ReadonlyArray<string | undefined>;
  disputePdaFilters: ReadonlyArray<string | undefined>;
  fromSlot?: number;
  toSlot?: number;
  firstSlot?: number;
  lastSlot?: number;
  firstSeq?: number;
  lastSeq?: number;
  uniqueTaskIds: string[];
  uniqueDisputeIds: string[];
  sourceEventTypeCounts: Record<string, number>;
  sourceEventNameCounts: Record<string, number>;
  traceIdCounts: Record<string, number>;
  events: CliReplayIncidentEvent[];
  deterministicHash: string;
}

interface SignedEvent {
  signature: string;
  slot: number;
}

export const DEFAULT_SQLITE_REPLAY_PATH = ".agenc/replay-events.sqlite";
const MAX_SIGNATURES_PER_PAGE = 1_000;
const DEFAULT_FETCH_PAGE_SIZE = 100;

function compareProjectedInputs(
  left: ProjectedTimelineInput,
  right: ProjectedTimelineInput,
): number {
  if (left.slot !== right.slot) {
    return left.slot - right.slot;
  }

  if (left.signature !== right.signature) {
    return left.signature.localeCompare(right.signature);
  }

  const leftSequence = left.sourceEventSequence ?? 0;
  const rightSequence = right.sourceEventSequence ?? 0;
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  return left.eventName.localeCompare(right.eventName);
}

function clampPageSize(pageSize: number | undefined): number {
  const resolved = pageSize === undefined ? DEFAULT_FETCH_PAGE_SIZE : pageSize;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    return DEFAULT_FETCH_PAGE_SIZE;
  }

  return Math.min(Math.max(resolved, 1), MAX_SIGNATURES_PER_PAGE);
}

const RPC_FINALITY: Finality = "confirmed";

export async function parseLocalTrajectoryFile(
  path: string,
): Promise<TrajectoryTrace> {
  const absolutePath = resolvePath(path);
  let raw: string;

  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(
      `failed to read local trace path ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `failed to parse local trace JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return parseTrajectoryTrace(parsed);
  } catch (error) {
    throw new Error(
      `invalid local trajectory trace at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function createReplayStore(
  options: CliReplayStoreOptions,
): ReplayTimelineStore {
  if (options.storeType === "sqlite") {
    return new SqliteReplayTimelineStore(
      resolvePath(options.sqlitePath ?? DEFAULT_SQLITE_REPLAY_PATH),
    );
  }

  return new InMemoryReplayTimelineStore();
}

export function createOnChainReplayBackfillFetcher(
  config: CliReplayBackfillConfig,
): BackfillFetcher {
  const { rpcUrl } = config;
  const programIdValue = config.programId ?? PROGRAM_ID.toBase58();
  const programId = new PublicKey(programIdValue);
  const connection = new Connection(rpcUrl);
  const program = createReadOnlyProgram(connection, programId);
  const parser = new EventParser(program.programId, program.coder);

  const parseLogs = (logs: string[]): ParsedAnchorEvent[] => {
    const parsed = [] as ParsedAnchorEvent[];

    for (const event of parser.parseLogs(logs, false)) {
      if (
        typeof event !== "object" ||
        event === null ||
        typeof event.name !== "string"
      ) {
        continue;
      }

      parsed.push(event as ParsedAnchorEvent);
    }

    return parsed;
  };

  return {
    async fetchPage(
      cursor: ReplayEventCursor | null,
      toSlot: number,
      pageSize: number,
    ) {
      const limit = clampPageSize(pageSize);
      const options: SignaturesForAddressOptions = {
        before: cursor?.signature,
        limit,
      };
      const rawSignatures = (await connection.getSignaturesForAddress(
        programId,
        options,
      )) as ConfirmedSignatureInfo[];

      if (rawSignatures.length === 0) {
        return {
          events: [],
          nextCursor: null,
          done: true,
        };
      }

      const events: ProjectedTimelineInput[] = [];
      const includedSignatures = new Map<string, SignedEvent>();

      for (const signatureInfo of rawSignatures) {
        if (!Number.isInteger(signatureInfo.slot) || signatureInfo.slot < 0) {
          continue;
        }

        if (signatureInfo.slot > toSlot) {
          continue;
        }

        const tx = await connection.getTransaction(signatureInfo.signature, {
          commitment: RPC_FINALITY,
          maxSupportedTransactionVersion: 0,
        });
        if (tx === null) {
          continue;
        }

        const logs = tx?.meta?.logMessages;
        if (!Array.isArray(logs)) {
          continue;
        }

        const timestampMs =
          tx.blockTime && Number.isInteger(tx.blockTime)
            ? tx.blockTime * 1_000
            : undefined;
        let parsedEvents: ParsedAnchorEvent[];
        try {
          parsedEvents = parseLogs(logs);
        } catch {
          continue;
        }

        for (let index = 0; index < parsedEvents.length; index += 1) {
          const event = parsedEvents[index];

          events.push({
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

      const sorted = [...events].sort(compareProjectedInputs);

      const lastSignature = rawSignatures[rawSignatures.length - 1];
      const lastEvent = sorted[sorted.length - 1];
      const cursorSignature = lastSignature?.signature;

      const nextCursor =
        cursorSignature === undefined
          ? null
          : {
              slot:
                includedSignatures.get(cursorSignature)?.slot ??
                lastSignature.slot,
              signature: cursorSignature,
              eventName: lastEvent?.eventName,
            };

      return {
        events: sorted,
        nextCursor,
        done: rawSignatures.length < limit,
      };
    },
  };
}

function sortRecordByKey(
  record: Record<string, number>,
): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key]!;
  }
  return sorted;
}

/**
 * Derive a deterministic trace ID from incident query filters.
 * Same inputs always produce the same trace ID.
 */
export function deriveIncidentTraceId(filters: {
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
  return createHash("sha256")
    .update(`incident:${key}`)
    .digest("hex")
    .slice(0, 32);
}

export function summarizeReplayIncidentRecords(
  records: readonly ReplayTimelineRecord[],
  filters: {
    taskPda?: string;
    disputePda?: string;
    fromSlot?: number;
    toSlot?: number;
  },
): CliReplayIncidentSummary {
  const sourceEventTypeCounts: Record<string, number> = {};
  const sourceEventNameCounts: Record<string, number> = {};
  const traceIdCounts: Record<string, number> = {};
  const taskIds = new Set<string>();
  const disputeIds = new Set<string>();

  const sorted = [...records].sort((left, right) => {
    if (left.seq !== right.seq) {
      return left.seq - right.seq;
    }
    if (left.slot !== right.slot) {
      return left.slot - right.slot;
    }
    return left.signature.localeCompare(right.signature);
  });

  const events = sorted.map((record) => {
    const disputePda =
      record.disputePda ?? extractDisputePdaFromPayload(record.payload);

    sourceEventTypeCounts[record.sourceEventType] =
      (sourceEventTypeCounts[record.sourceEventType] ?? 0) + 1;
    sourceEventNameCounts[record.sourceEventName] =
      (sourceEventNameCounts[record.sourceEventName] ?? 0) + 1;
    if (record.traceId) {
      traceIdCounts[record.traceId] = (traceIdCounts[record.traceId] ?? 0) + 1;
    }

    if (record.taskPda) {
      taskIds.add(record.taskPda);
    }
    if (disputePda) {
      disputeIds.add(disputePda);
    }

    return {
      seq: record.seq,
      slot: record.slot,
      signature: record.signature,
      sourceEventType: record.sourceEventType,
      sourceEventName: record.sourceEventName,
      taskPda: record.taskPda,
      disputePda,
      timestampMs: record.timestampMs,
      traceId: record.traceId,
      traceSpanId: record.traceSpanId,
    };
  });

  const uniqueTaskIds = [...taskIds].sort();
  const uniqueDisputeIds = [...disputeIds].sort();
  const sortedEventTypeCounts = sortRecordByKey(sourceEventTypeCounts);
  const sortedEventNameCounts = sortRecordByKey(sourceEventNameCounts);
  const sortedTraceIdCounts = sortRecordByKey(traceIdCounts);

  const summary = {
    totalEvents: events.length,
    taskPdaFilters: [filters.taskPda],
    disputePdaFilters: [filters.disputePda],
    fromSlot: filters.fromSlot,
    toSlot: filters.toSlot,
    firstSlot: events[0]?.slot,
    lastSlot: events[events.length - 1]?.slot,
    firstSeq: events[0]?.seq,
    lastSeq: events[events.length - 1]?.seq,
    uniqueTaskIds,
    uniqueDisputeIds,
    sourceEventTypeCounts: sortedEventTypeCounts,
    sourceEventNameCounts: sortedEventNameCounts,
    traceIdCounts: sortedTraceIdCounts,
    events,
  };

  const deterministicHash = createHash("sha256")
    .update(stableStringifyJson(summary as unknown as JsonValue))
    .digest("hex");

  return {
    ...summary,
    deterministicHash,
  };
}
