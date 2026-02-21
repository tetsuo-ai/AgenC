import { describe, it, expect } from "vitest";
import {
  EVAL_TRACE_SCHEMA_VERSION,
  canonicalizeTrajectoryTrace,
  migrateTrajectoryTrace,
  parseTrajectoryTrace,
  stableStringifyJson,
  type LegacyTrajectoryTraceV0,
  type TrajectoryTrace,
} from "./types.js";

describe("eval/types", () => {
  it("parses v1 traces", () => {
    const trace: TrajectoryTrace = {
      schemaVersion: EVAL_TRACE_SCHEMA_VERSION,
      traceId: "trace-v1",
      seed: 7,
      createdAtMs: 100,
      events: [
        {
          seq: 1,
          type: "discovered",
          taskPda: "task-1",
          timestampMs: 101,
          payload: { reward: "100" },
        },
      ],
    };

    const parsed = parseTrajectoryTrace(trace);
    expect(parsed).toEqual(trace);
  });

  it("migrates legacy v0 traces", () => {
    const legacy: LegacyTrajectoryTraceV0 = {
      traceId: "legacy",
      createdAtMs: 1,
      events: [
        {
          type: "claimed",
          taskPda: "task-1",
          timestampMs: 2,
        },
      ],
    };

    const migrated = migrateTrajectoryTrace(legacy);
    expect(migrated.schemaVersion).toBe(EVAL_TRACE_SCHEMA_VERSION);
    expect(migrated.seed).toBe(0);
    expect(migrated.events).toHaveLength(1);
    expect(migrated.events[0].seq).toBe(1);
    expect(migrated.events[0].payload).toEqual({});
  });

  it("rejects malformed events", () => {
    expect(() =>
      parseTrajectoryTrace({
        schemaVersion: EVAL_TRACE_SCHEMA_VERSION,
        traceId: "bad",
        seed: 1,
        createdAtMs: 10,
        events: [
          {
            seq: 0,
            type: "claimed",
            timestampMs: 11,
            payload: {},
          },
        ],
      }),
    ).toThrow("seq");
  });

  it("canonicalizes trace event ordering by sequence number", () => {
    const trace: TrajectoryTrace = {
      schemaVersion: EVAL_TRACE_SCHEMA_VERSION,
      traceId: "sort-check",
      seed: 9,
      createdAtMs: 1,
      events: [
        {
          seq: 2,
          type: "completed",
          taskPda: "task-1",
          timestampMs: 20,
          payload: { b: 1, a: 2 },
        },
        {
          seq: 1,
          type: "claimed",
          taskPda: "task-1",
          timestampMs: 10,
          payload: { z: 3, y: 4 },
        },
      ],
    };

    const canonical = canonicalizeTrajectoryTrace(trace);
    expect(canonical.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("stable-stringifies JSON with key-order independence", () => {
    const left = stableStringifyJson({
      b: 2,
      a: {
        d: 4,
        c: 3,
      },
    });

    const right = stableStringifyJson({
      a: {
        c: 3,
        d: 4,
      },
      b: 2,
    });

    expect(left).toBe(right);
  });
});
