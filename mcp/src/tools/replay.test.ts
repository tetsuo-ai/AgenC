import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
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
} from "./replay.js";
import {
  type FakeBackfillFetcher,
  createInMemoryReplayStore,
  createReplayRuntime,
  buildReplayPolicy,
  runWithTempTrace,
} from "./replay-test-utils.js";

function neverResolve<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const neverResolveBackfillFetcher: FakeBackfillFetcher = {
  async fetchPage() {
    return neverResolve();
  },
};

const deniedReplayExtra = {
  authInfo: { clientId: "policy-denied-actor" },
  requestId: "policy-deny-test",
};

const allowlistedReplayExtra = {
  authInfo: { clientId: "policy-allowed-actor" },
  requestId: "policy-allow-test",
};

const sessionReplayExtra = {
  sessionId: "policy-session-001",
  requestId: "policy-session-test",
};

const storeRecord = {
  seq: 1,
  type: "discovered",
  sourceEventName: "discovered",
  sourceEventType: "discovered",
  taskPda: "AGENTtask",
  disputePda: undefined,
  signature: "sig-001",
  slot: 10,
  timestampMs: 1_000,
  payload: {
    onchain: {
      signature: "sig-001",
      slot: 10,
      trace: {
        traceId: "incident-trace",
        spanId: "span-001",
        sampled: true,
      },
    },
  },
  projectionHash: "hash-001",
};

test("replay backfill returns schema-stable success and policy-trimmed payload", async () => {
  const store = createInMemoryReplayStore();
  const runtime = createReplayRuntime({
    store,
    fetcher: {
      async fetchPage() {
        return {
          events: [
            {
              eventName: "discovered",
              event: { test: true },
              slot: 10,
              signature: "sig-001",
              sourceEventSequence: 0,
            },
          ],
          nextCursor: {
            slot: 10,
            signature: "sig-001",
            eventName: "discovered",
          },
          done: true,
        };
      },
    },
  });

  const args: ReplayBackfillInput = {
    rpc: "http://localhost:8899",
    to_slot: 100,
    store_type: "memory",
  };

  const output = await runReplayBackfillTool(
    args,
    runtime,
    buildReplayPolicy(),
  );
  assert.equal(output.structuredContent.status, "ok");
  assert.equal(output.content.length, 1);
  const success = ReplayBackfillOutputSchema.parse(output.structuredContent);
  assert.equal(success.result.processed >= 0, true);
  assert.equal(success.result.cursor?.signature, "[REDACTED]");
  assert.equal(success.redactions.includes("signature"), true);
  assert.equal(success.sections.includes("result"), true);
});

test("replay backfill validates malformed input to failure schema", async () => {
  const output = await runReplayBackfillTool(
    { rpc: "", to_slot: -1, store_type: "memory" },
    createReplayRuntime({ store: createInMemoryReplayStore() }),
    buildReplayPolicy(),
  );
  assert.equal(output.structuredContent.status, "error");
  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.code, "replay.invalid_input");
  assert.equal(failure.schema, "replay.backfill.output.v1");
});

test("replay compare returns schema-stable output", async () => {
  const trace = {
    schemaVersion: 1,
    traceId: "trace-compare",
    seed: 0,
    createdAtMs: 1,
    events: [
      {
        seq: 1,
        type: "discovered",
        taskPda: "AGENTtask",
        timestampMs: 1_000,
        payload: {
          onchain: {
            signature: "sig-001",
            slot: 10,
            trace: {
              traceId: "trace-compare",
              spanId: "span-001",
            },
          },
        },
      },
    ],
  };

  await runWithTempTrace(trace, async (tracePath) => {
    const store = createInMemoryReplayStore();
    await store.save([storeRecord]);

    const runtime = createReplayRuntime({
      store,
      trace: tracePath,
      fetcher: {
        async fetchPage() {
          return { events: [], nextCursor: null, done: true };
        },
      },
    });

    const args: ReplayCompareInput = {
      local_trace_path: tracePath,
      store_type: "memory",
      strict_mode: false,
      max_payload_bytes: 1,
    };

    const output = await runReplayCompareTool(
      args,
      runtime,
      buildReplayPolicy(),
    );
    if (output.isError) {
      const failure = ReplayToolErrorSchema.parse(output.structuredContent);
      assert.equal(failure.command, "agenc_replay_compare");
      assert.equal(failure.schema, "replay.compare.output.v1");
      assert.equal(failure.code, "replay.compare_failed");
      return;
    }

    const success = ReplayCompareOutputSchema.parse(output.structuredContent);
    assert.equal(success.command, "agenc_replay_compare");
    assert.equal(success.status, "ok");
    assert.equal(success.truncated, true);
  });

  test("replay compare emits stable error schema on malformed input", async () => {
    const output = await runReplayCompareTool(
      {} as ReplayCompareInput,
      createReplayRuntime({
        store: createInMemoryReplayStore(),
        trace: "",
      }),
      buildReplayPolicy(),
    );
    const failure = ReplayToolErrorSchema.parse(output.structuredContent);
    assert.equal(failure.status, "error");
    assert.equal(failure.command, "agenc_replay_compare");
    assert.equal(failure.schema, "replay.compare.output.v1");
    assert.equal(failure.code, "replay.invalid_input");
    assert.equal(failure.retriable, false);
  });
});

test("replay incident returns schema-stable reconstruction summary", async () => {
  const store = createInMemoryReplayStore();
  await store.save([
    storeRecord,
    {
      ...storeRecord,
      seq: 2,
      sourceEventName: "claimed",
      sourceEventType: "claimed",
      type: "claimed",
      slot: 11,
      signature: "sig-002",
      timestampMs: 1_100,
      payload: {
        ...storeRecord.payload,
        onchain: {
          ...storeRecord.payload.onchain,
          signature: "sig-002",
          slot: 11,
        },
      },
      projectionHash: "hash-002",
    },
  ]);

  const output = await runReplayIncidentTool(
    {
      task_pda: "AGENTtask",
      store_type: "memory",
      strict_mode: false,
      max_payload_bytes: 120_000,
    } as ReplayIncidentInput,
    createReplayRuntime({ store }),
    buildReplayPolicy(),
  );

  const success = ReplayIncidentOutputSchema.parse(output.structuredContent);
  assert.equal(success.command, "agenc_replay_incident");
  assert.equal(success.status, "ok");
  assert.equal(success.summary?.total_events, 2);
  assert.equal(success.validation?.event_validation.replay_task_count, 1);
});

test("replay incident emits stable error schema on malformed input", async () => {
  const output = await runReplayIncidentTool(
    {} as ReplayIncidentInput,
    createReplayRuntime({ store: createInMemoryReplayStore() }),
    buildReplayPolicy(),
  );
  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.command, "agenc_replay_incident");
  assert.equal(failure.schema, "replay.incident.output.v1");
  assert.equal(failure.code, "replay.missing_filter");
});

test("replay status returns schema-stable store snapshot", async () => {
  const store = createInMemoryReplayStore();
  await store.save([storeRecord]);

  const output = await runReplayStatusTool(
    {
      store_type: "memory",
      max_payload_bytes: 120_000,
    } as ReplayStatusInput,
    createReplayRuntime({ store }),
    buildReplayPolicy(),
  );

  const success = ReplayStatusOutputSchema.parse(output.structuredContent);
  assert.equal(success.command, "agenc_replay_status");
  assert.equal(success.status, "ok");
  assert.equal(success.event_count, 1);
  assert.equal(success.unique_task_count, 1);
});

test("replay status emits stable error schema on malformed input", async () => {
  const output = await runReplayStatusTool(
    {} as ReplayStatusInput,
    createReplayRuntime({ store: createInMemoryReplayStore() }),
    buildReplayPolicy(),
  );
  const success = ReplayStatusOutputSchema.parse(output.structuredContent);
  assert.equal(success.status, "ok");
  assert.equal(success.command, "agenc_replay_status");
  assert.equal(success.schema, "replay.status.output.v1");
});

test("replay incident rejects missing filters with deterministic error", async () => {
  const output = await runReplayIncidentTool(
    {
      store_type: "memory",
      strict_mode: false,
    } as ReplayIncidentInput,
    createReplayRuntime({ store: createInMemoryReplayStore() }),
    buildReplayPolicy(),
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "replay.missing_filter");
});

test("replay compare rejects invalid slot window order", async () => {
  const trace = {
    schemaVersion: 1,
    traceId: "window-policy-invalid-order",
    seed: 0,
    createdAtMs: 1,
    events: [],
  };

  const output = await runWithTempTrace(trace, async (tracePath) => {
    return runReplayCompareTool(
      {
        local_trace_path: tracePath,
        store_type: "memory",
        strict_mode: false,
        from_slot: 10,
        to_slot: 5,
      },
      createReplayRuntime({
        store: createInMemoryReplayStore(),
        trace: tracePath,
      }),
      {
        ...buildReplayPolicy(),
        maxSlotWindow: 1,
      },
    );
  });

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "replay.slot_window_exceeded");
});

test("replay policy blocks denylisted actors", async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: "http://localhost:8899",
      to_slot: 100,
      store_type: "memory",
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
    }),
    {
      ...buildReplayPolicy(),
      denylist: new Set(["policy-denied-actor"]),
    },
    deniedReplayExtra,
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "replay.access_denied");
});

test("replay policy enforces allowlist", async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: "http://localhost:8899",
      to_slot: 100,
      store_type: "memory",
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
    }),
    {
      ...buildReplayPolicy(),
      allowlist: new Set(["approved-actor"]),
    },
    allowlistedReplayExtra,
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "replay.access_denied");
});

test("replay policy denies anonymous actor when allowlist is enabled", async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: "http://localhost:8899",
      to_slot: 100,
      store_type: "memory",
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
    }),
    {
      ...buildReplayPolicy(),
      allowlist: new Set(["known-actor"]),
    },
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "replay.access_denied");
  assert.equal(failure.retriable, false);
});

test("replay policy allows matching session actor via sessionId", async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: "http://localhost:8899",
      to_slot: 100,
      store_type: "memory",
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
      fetcher: {
        async fetchPage() {
          return {
            events: [],
            nextCursor: null,
            done: true,
          };
        },
      },
    }),
    {
      ...buildReplayPolicy(),
      allowlist: new Set(["session:policy-session-001"]),
    },
    sessionReplayExtra,
  );

  const success = ReplayBackfillOutputSchema.parse(output.structuredContent);
  assert.equal(success.status, "ok");
});

test("replay policy honors denylist precedence over allowlist", async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: "http://localhost:8899",
      to_slot: 100,
      store_type: "memory",
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
    }),
    {
      ...buildReplayPolicy(),
      allowlist: new Set(["policy-override-actor"]),
      denylist: new Set(["policy-override-actor"]),
    },
    {
      ...allowlistedReplayExtra,
      authInfo: { clientId: "policy-override-actor" },
      requestId: "policy-deny-overrides-allow",
    },
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "replay.access_denied");
});

test("replay compare rejects slot windows exceeding policy", async () => {
  const trace = {
    schemaVersion: 1,
    traceId: "window-policy",
    seed: 0,
    createdAtMs: 1,
    events: [],
  };

  const output = await runWithTempTrace(trace, async (tracePath) => {
    return runReplayCompareTool(
      {
        local_trace_path: tracePath,
        store_type: "memory",
        strict_mode: false,
        from_slot: 1,
        to_slot: 1_000_001,
      },
      createReplayRuntime({
        store: createInMemoryReplayStore(),
        trace: tracePath,
      }),
      {
        ...buildReplayPolicy(),
        maxSlotWindow: 10,
      },
    );
  });

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "replay.slot_window_exceeded");
});

test("replay backfill enforces execution timeout policy", async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: "http://localhost:8899",
      to_slot: 100,
      store_type: "memory",
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
      fetcher: neverResolveBackfillFetcher,
    }),
    {
      ...buildReplayPolicy(),
      maxToolRuntimeMs: 25,
    },
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "replay.timeout");
});

test("replay backfill supports abort signal cancellation", async () => {
  const abortController = new AbortController();
  const outputPromise = runReplayBackfillTool(
    {
      rpc: "http://localhost:8899",
      to_slot: 100,
      store_type: "memory",
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
      fetcher: neverResolveBackfillFetcher,
    }),
    {
      ...buildReplayPolicy(),
      maxToolRuntimeMs: 10_000,
    },
    { ...allowlistedReplayExtra, signal: abortController.signal },
  );

  await setTimeout(10);
  abortController.abort();
  const output = await outputPromise;
  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "replay.cancelled");
});

test("replay backfill enforces concurrency controls", async () => {
  const store = createInMemoryReplayStore();
  const policy = {
    ...buildReplayPolicy(),
    maxConcurrentJobs: 1,
    maxToolRuntimeMs: 200,
  };
  const runtime = createReplayRuntime({
    store,
    fetcher: neverResolveBackfillFetcher,
  });
  const args: ReplayBackfillInput = {
    rpc: "http://localhost:8899",
    to_slot: 100,
    store_type: "memory",
  };

  const slowFirst = runReplayBackfillTool(args, runtime, policy);
  await setTimeout(10);
  const second = runReplayBackfillTool(args, runtime, policy);
  const secondFailure = ReplayToolErrorSchema.parse(
    (await second).structuredContent,
  );
  assert.equal(secondFailure.code, "replay.concurrency_limit");
  const firstResult = await slowFirst;
  const firstFailure = ReplayToolErrorSchema.parse(
    firstResult.structuredContent,
  );
  assert.equal(firstFailure.code, "replay.timeout");
});
