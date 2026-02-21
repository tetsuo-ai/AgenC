import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  ReplayBackfillOutputSchema,
  ReplayCompareOutputSchema,
  ReplayIncidentOutputSchema,
  ReplayStatusOutputSchema,
  ReplayToolErrorSchema,
  type ReplayBackfillInput,
  type ReplayCompareInput,
  type ReplayIncidentInput,
  type ReplayStatusInput,
} from "./replay-types.js";
import {
  runReplayBackfillTool,
  runReplayCompareTool,
  runReplayIncidentTool,
  runReplayStatusTool,
  type ReplayToolRuntime,
  type ReplayPolicy,
} from "./replay.js";

interface ContractSnapshot<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
> {
  id: string;
  version: number;
  command: string;
  input: TInput;
  output: {
    schema: string;
    shape: TOutput;
  };
  metadata: {
    generatedAt: string;
    generatedBy: string;
  };
}

function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefined(entry)) as T;
  }

  if (typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .map(([key, entryValue]) => [key, stripUndefined(entryValue)] as const);

  return Object.fromEntries(entries) as T;
}

interface ReplayRecord {
  seq: number;
  type: string;
  sourceEventName: string;
  sourceEventType: string;
  taskPda?: string;
  disputePda?: string;
  signature: string;
  slot: number;
  timestampMs: number;
  payload: Record<string, unknown>;
  projectionHash?: string;
}

interface FakeReplayStore {
  save: (
    records: readonly ReplayRecord[],
  ) => Promise<{ inserted: number; duplicates: number }>;
  query: (filter?: Record<string, unknown>) => Promise<readonly ReplayRecord[]>;
  getCursor: () => Promise<Record<string, unknown> | null>;
  saveCursor: (cursor: Record<string, unknown> | null) => Promise<void>;
}

interface ContractRunnerCase<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
> {
  id: string;
  command: string;
  fixturePath: URL;
  input: TInput;
  schema: z.ZodType<TOutput>;
  schemaName: string;
  requiredTopLevelKeys: ReadonlyArray<string>;
  optionalTopLevelKeys?: ReadonlyArray<string>;
  assertOutput?: (output: TOutput) => void;
  execute: (input: TInput) => Promise<unknown>;
}

const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === "1";
const SNAPSHOT_VERSION = 1;
const FIXTURE_DIR = new URL("../../tests/fixtures/golden/", import.meta.url);

const REPLAY_COMPARE_SCHEMA = "replay.compare.output.v1";
const REPLAY_BACKFILL_SCHEMA = "replay.backfill.output.v1";
const REPLAY_INCIDENT_SCHEMA = "replay.incident.output.v1";
const REPLAY_STATUS_SCHEMA = "replay.status.output.v1";

const COMPARE_TRACE_PATH = join(
  process.cwd(),
  "tmp",
  "mcp-replay-compare-success.trace.json",
);
const COMPARE_TRACE_RELATIVE = "tmp/mcp-replay-compare-success.trace.json";

function normalizeKeys(payload: unknown): string[] {
  return Object.keys(payload as Record<string, unknown>).sort();
}

function makeStore(records: ReplayRecord[] = []): FakeReplayStore {
  const saved = [...records];
  let cursor: Record<string, unknown> | null = null;

  return {
    async save(incoming) {
      let inserted = 0;
      let duplicates = 0;
      for (const record of incoming) {
        const key = `${record.slot}|${record.signature}|${record.sourceEventType}`;
        if (
          saved.some(
            (existing) =>
              existing.signature === record.signature &&
              existing.slot === record.slot,
          )
        ) {
          duplicates += 1;
          continue;
        }
        saved.push(record);
        inserted += 1;
      }
      return { inserted, duplicates };
    },
    async query(filter = {}) {
      return saved.filter((entry) => {
        if (filter.taskPda !== undefined && entry.taskPda !== filter.taskPda) {
          return false;
        }
        if (
          filter.disputePda !== undefined &&
          entry.disputePda !== filter.disputePda
        ) {
          return false;
        }
        if (
          filter.fromSlot !== undefined &&
          entry.slot < Number(filter.fromSlot)
        ) {
          return false;
        }
        if (filter.toSlot !== undefined && entry.slot > Number(filter.toSlot)) {
          return false;
        }
        return true;
      });
    },
    async getCursor() {
      return cursor;
    },
    async saveCursor(nextCursor) {
      cursor = nextCursor;
    },
  };
}

function makeReplayRuntime(
  overrides: {
    store?: FakeReplayStore;
    fetchEvents?: ReplayRecord[];
    trace?: string;
    currentSlot?: number;
  } = {},
): ReplayToolRuntime {
  const store = overrides.store ?? makeStore();

  return {
    createStore: () => store,
    createBackfillFetcher: () => ({
      async fetchPage() {
        return {
          events: overrides.fetchEvents ?? [],
          nextCursor: null,
          done: true,
        };
      },
    }),
    readLocalTrace(path) {
      const tracePath = overrides.trace ?? path;
      if (tracePath !== path && tracePath !== overrides.trace) {
        throw new Error(`trace not found: ${path}`);
      }
      return JSON.parse(readFileSync(tracePath, "utf8"));
    },
    async getCurrentSlot() {
      return overrides.currentSlot ?? 1_000_000;
    },
  };
}

function buildPolicy(overrides: Partial<ReplayPolicy> = {}): ReplayPolicy {
  return {
    maxSlotWindow: 2_000_000,
    maxEventCount: 100,
    maxConcurrentJobs: 2,
    maxToolRuntimeMs: 60_000,
    allowlist: new Set<string>(),
    denylist: new Set<string>(),
    defaultRedactions: ["signature"],
    auditEnabled: false,
    ...overrides,
  };
}

function buildReplayRecord(seed: string, index: number): ReplayRecord {
  return {
    seq: index,
    type: "discovered",
    sourceEventName: "task.discovered",
    sourceEventType: "discovered",
    taskPda: `Task_${seed}`,
    disputePda: index % 2 === 0 ? `Dispute_${seed}` : undefined,
    signature: `${seed}-${index}`,
    slot: 100 + index,
    timestampMs: 1_000 + index,
    payload: {
      index,
      task: `Task_${seed}`,
      event: "discover",
    },
    projectionHash: `hash-${seed}-${index}`,
  };
}

function assertTopLevelKeys(
  payload: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = normalizeKeys(payload);

  for (const requiredKey of required) {
    assert.equal(
      keys.includes(requiredKey),
      true,
      `${requiredKey} missing from contract output`,
    );
  }

  for (const key of keys) {
    assert.equal(allowed.has(key), true, `unexpected top-level key: ${key}`);
  }
}

function writeFixture(path: URL, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeCompareTrace(seed: string, recordCount: number): void {
  const traceDir = join(process.cwd(), "tmp");
  mkdirSync(traceDir, { recursive: true });

  const trace = {
    schemaVersion: 1,
    traceId: `trace-${seed}`,
    seed: 10,
    createdAtMs: 1,
    events: Array.from({ length: recordCount }, (_, index) => ({
      seq: index + 1,
      type: "discovered",
      taskPda: `Task_${seed}`,
      timestampMs: 1_000 + index,
      payload: {
        task: `Task_${seed}`,
        event: "discover",
        index,
      },
    })),
  };

  writeFileSync(COMPARE_TRACE_PATH, JSON.stringify(trace), "utf8");
}

function cleanupCompareTrace(): void {
  rmSync(join(process.cwd(), "tmp"), { recursive: true, force: true });
}

async function runContractCase<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
>(args: ContractRunnerCase<TInput, TOutput>): Promise<void> {
  const output = await args.execute(args.input);
  const parsed = args.schema.safeParse(output);
  assert.equal(
    parsed.success,
    true,
    parsed.success ? "" : parsed.error.message,
  );

  if (args.assertOutput) {
    args.assertOutput(parsed.data as TOutput);
  }

  assertTopLevelKeys(
    output as Record<string, unknown>,
    args.requiredTopLevelKeys,
    args.optionalTopLevelKeys ?? [],
  );

  const shape = stripUndefined(parsed.data as TOutput);
  const snapshot: ContractSnapshot<TInput, TOutput> = {
    id: args.id,
    version: SNAPSHOT_VERSION,
    command: args.command,
    input: args.input,
    output: {
      schema: args.schemaName,
      shape,
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      generatedBy: "contract-validator",
    },
  };

  if (UPDATE_GOLDENS) {
    mkdirSync(dirname(args.fixturePath.pathname), { recursive: true });
    writeFixture(args.fixturePath, snapshot);
    return;
  }

  const expected = JSON.parse(
    readFileSync(args.fixturePath, "utf8"),
  ) as ContractSnapshot<TInput, TOutput>;
  assert.equal(expected.id, args.id);
  assert.equal(expected.version, SNAPSHOT_VERSION);
  assert.equal(expected.output.schema, args.schemaName);
  assert.deepStrictEqual(expected.output.shape, shape);
}

const baseRecords = [
  buildReplayRecord("A", 1),
  buildReplayRecord("A", 2),
  buildReplayRecord("A", 3),
];

const truncatedRecords = Array.from({ length: 80 }, (_, index) =>
  buildReplayRecord("B", index + 1),
);

await test("replay MCP backfill and error contract cases", async () => {
  await runContractCase({
    id: "mcp.replay.backfill.success",
    command: "agenc_replay_backfill",
    fixturePath: new URL("mcp-replay-backfill-success.json", FIXTURE_DIR),
    input: {
      rpc: "http://localhost:8899",
      to_slot: 10,
      store_type: "memory",
    } as ReplayBackfillInput,
    schema: ReplayBackfillOutputSchema,
    schemaName: REPLAY_BACKFILL_SCHEMA,
    requiredTopLevelKeys: [
      "status",
      "command",
      "schema",
      "mode",
      "to_slot",
      "store_type",
      "result",
      "command_params",
      "sections",
      "redactions",
      "truncated",
    ],
    optionalTopLevelKeys: ["page_size", "schema_hash", "truncation_reason"],
    async execute(input) {
      const store = makeStore();
      const runtime = makeReplayRuntime({
        store,
        fetchEvents: [
          {
            seq: 1,
            type: "discovered",
            sourceEventName: "task.discovered",
            sourceEventType: "discovered",
            taskPda: "Task_A",
            signature: "sig-A",
            slot: 1,
            timestampMs: 1,
            payload: {},
          },
        ],
        currentSlot: 100,
      });
      return (await runReplayBackfillTool(input, runtime, buildPolicy()))
        .structuredContent;
    },
  });

  await runContractCase({
    id: "mcp.replay.backfill.error.slot_window",
    command: "agenc_replay_backfill",
    fixturePath: new URL(
      "mcp-replay-backfill-error-slot-window.json",
      FIXTURE_DIR,
    ),
    input: {
      rpc: "http://localhost:8899",
      to_slot: 1,
      store_type: "memory",
    } as ReplayBackfillInput,
    schema: ReplayToolErrorSchema,
    schemaName: REPLAY_BACKFILL_SCHEMA,
    requiredTopLevelKeys: [
      "status",
      "command",
      "schema",
      "code",
      "message",
      "retriable",
    ],
    optionalTopLevelKeys: ["schema_hash", "details"],
    async execute(input) {
      const runtime = makeReplayRuntime({ currentSlot: 1000 });
      return (
        await runReplayBackfillTool(
          input,
          runtime,
          buildPolicy({ maxSlotWindow: 10 }),
        )
      ).structuredContent;
    },
  });
});

await test("replay MCP compare contract cases", async () => {
  writeCompareTrace("A", baseRecords.length);

  try {
    await runContractCase({
      id: "mcp.replay.compare.success",
      command: "agenc_replay_compare",
      fixturePath: new URL("mcp-replay-compare-success.json", FIXTURE_DIR),
      input: {
        local_trace_path: COMPARE_TRACE_RELATIVE,
        store_type: "memory",
        strict_mode: false,
        task_pda: "Task_A",
      } as ReplayCompareInput,
      schema: ReplayCompareOutputSchema,
      schemaName: REPLAY_COMPARE_SCHEMA,
      requiredTopLevelKeys: [
        "status",
        "command",
        "schema",
        "strictness",
        "local_trace_path",
        "result",
        "command_params",
        "sections",
        "redactions",
        "truncated",
      ],
      optionalTopLevelKeys: [
        "task_pda",
        "dispute_pda",
        "schema_hash",
        "truncation_reason",
      ],
      async execute(input) {
        const store = makeStore([...baseRecords]);
        const runtime = makeReplayRuntime({
          store,
          trace: COMPARE_TRACE_PATH,
        });
        await store.save(baseRecords);
        return (await runReplayCompareTool(input, runtime, buildPolicy()))
          .structuredContent;
      },
    });

    await runContractCase({
      id: "mcp.replay.compare.failure.invalid_trace",
      command: "agenc_replay_compare",
      fixturePath: new URL(
        "mcp-replay-compare-failure-invalid-trace.json",
        FIXTURE_DIR,
      ),
      input: {
        local_trace_path: "/tmp/does-not-exist.json",
        store_type: "memory",
      } as ReplayCompareInput,
      schema: ReplayToolErrorSchema,
      schemaName: REPLAY_COMPARE_SCHEMA,
      requiredTopLevelKeys: [
        "status",
        "command",
        "schema",
        "code",
        "message",
        "retriable",
      ],
      optionalTopLevelKeys: ["schema_hash", "details"],
      async execute(input) {
        const runtime = makeReplayRuntime({
          store: makeStore(),
          trace: "/tmp/trace-not-found.json",
        });
        return (await runReplayCompareTool(input, runtime, buildPolicy()))
          .structuredContent;
      },
    });

    await runContractCase({
      id: "mcp.replay.compare.empty_store",
      command: "agenc_replay_compare",
      fixturePath: new URL("mcp-replay-compare-empty-store.json", FIXTURE_DIR),
      input: {
        local_trace_path: COMPARE_TRACE_RELATIVE,
        store_type: "memory",
      } as ReplayCompareInput,
      schema: ReplayCompareOutputSchema,
      schemaName: REPLAY_COMPARE_SCHEMA,
      requiredTopLevelKeys: [
        "status",
        "command",
        "schema",
        "strictness",
        "local_trace_path",
        "result",
        "command_params",
        "sections",
        "redactions",
        "truncated",
      ],
      optionalTopLevelKeys: [
        "task_pda",
        "dispute_pda",
        "schema_hash",
        "truncation_reason",
      ],
      async execute(input) {
        writeCompareTrace("EMPTY", 0);
        const runtime = makeReplayRuntime({
          store: makeStore(),
          trace: COMPARE_TRACE_PATH,
        });
        return (await runReplayCompareTool(input, runtime, buildPolicy()))
          .structuredContent;
      },
      assertOutput(output) {
        const parsed = output as {
          truncated: boolean;
          truncation_reason?: string | null;
        };

        assert.equal(parsed.truncated, false);
        assert.ok(
          parsed.truncation_reason === undefined ||
            parsed.truncation_reason === null,
        );
      },
    });
  } finally {
    cleanupCompareTrace();
  }
});

await test("replay MCP incident and status contract cases", async () => {
  const store = makeStore([...truncatedRecords]);
  await store.save(truncatedRecords);

  await runContractCase({
    id: "mcp.replay.incident.success",
    command: "agenc_replay_incident",
    fixturePath: new URL("mcp-replay-incident-success.json", FIXTURE_DIR),
    input: {
      task_pda: "Task_A",
      store_type: "memory",
    } as ReplayIncidentInput,
    schema: ReplayIncidentOutputSchema,
    schemaName: REPLAY_INCIDENT_SCHEMA,
    requiredTopLevelKeys: [
      "status",
      "command",
      "schema",
      "command_params",
      "sections",
      "redactions",
      "summary",
      "validation",
      "narrative",
      "truncated",
    ],
    optionalTopLevelKeys: ["schema_hash", "truncation_reason"],
    async execute(input) {
      const runtime = makeReplayRuntime({
        store,
      });
      return (await runReplayIncidentTool(input, runtime, buildPolicy()))
        .structuredContent;
    },
  });

  await runContractCase({
    id: "mcp.replay.incident.truncated",
    command: "agenc_replay_incident",
    fixturePath: new URL("mcp-replay-incident-truncated.json", FIXTURE_DIR),
    input: {
      task_pda: "Task_A",
      store_type: "memory",
      max_payload_bytes: 200,
    } as ReplayIncidentInput,
    schema: ReplayIncidentOutputSchema,
    schemaName: REPLAY_INCIDENT_SCHEMA,
    requiredTopLevelKeys: [
      "status",
      "command",
      "schema",
      "command_params",
      "sections",
      "redactions",
      "summary",
      "validation",
      "narrative",
      "truncated",
    ],
    optionalTopLevelKeys: ["schema_hash", "truncation_reason"],
    async execute(input) {
      const runtime = makeReplayRuntime({
        store,
      });
      return (await runReplayIncidentTool(input, runtime, buildPolicy()))
        .structuredContent;
    },
    assertOutput(output) {
      const parsed = output as {
        truncated: boolean;
        truncation_reason?: string;
      };

      assert.equal(parsed.truncated, true);
      assert.equal(typeof parsed.truncation_reason, "string");
      assert.ok((parsed.truncation_reason?.length ?? 0) > 0);
    },
  });

  await runContractCase({
    id: "mcp.replay.status.success",
    command: "agenc_replay_status",
    fixturePath: new URL("mcp-replay-status-success.json", FIXTURE_DIR),
    input: {
      store_type: "memory",
    } as ReplayStatusInput,
    schema: ReplayStatusOutputSchema,
    schemaName: REPLAY_STATUS_SCHEMA,
    requiredTopLevelKeys: [
      "status",
      "command",
      "schema",
      "store_type",
      "event_count",
      "unique_task_count",
      "unique_dispute_count",
      "active_cursor",
      "sections",
      "redactions",
    ],
    optionalTopLevelKeys: ["schema_hash"],
    async execute(input) {
      const statusStore = makeStore([...baseRecords]);
      await statusStore.save(baseRecords);
      const runtime = makeReplayRuntime({
        store: statusStore,
      });
      return (await runReplayStatusTool(input, runtime, buildPolicy()))
        .structuredContent;
    },
  });
});
