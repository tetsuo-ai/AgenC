import { describe, expect, it } from "vitest";
import type { ReplayTimelineRecord } from "../replay/types.js";
import {
  deriveIncidentTraceId,
  summarizeReplayIncidentRecords,
} from "./replay.js";

function createRecord(
  seq: number,
  slot: number,
  signature: string,
  sourceEventName: string,
  taskPda = "TASK_1",
): ReplayTimelineRecord {
  return {
    seq,
    slot,
    signature,
    type: "discovered",
    sourceEventType: "discovered",
    sourceEventName,
    sourceEventSequence: seq - 1,
    timestampMs: 1000 * seq,
    projectionHash: `hash-${seq}`,
    taskPda,
    payload: { onchain: { eventName: sourceEventName } },
  };
}

describe("summarizeReplayIncidentRecords determinism (#968)", () => {
  it("same records produce identical deterministicHash", () => {
    const records = [
      createRecord(1, 10, "SIG_1", "taskCreated"),
      createRecord(2, 11, "SIG_2", "taskClaimed"),
    ];

    const summary1 = summarizeReplayIncidentRecords(records, {
      taskPda: "TASK_1",
    });
    const summary2 = summarizeReplayIncidentRecords(records, {
      taskPda: "TASK_1",
    });

    expect(summary1.deterministicHash).toBe(summary2.deterministicHash);
    expect(summary1.deterministicHash.length).toBe(64);
  });

  it("records in different insertion order produce same output", () => {
    const r1 = createRecord(1, 10, "SIG_1", "taskCreated");
    const r2 = createRecord(2, 11, "SIG_2", "taskClaimed");

    const summary1 = summarizeReplayIncidentRecords([r1, r2], {
      taskPda: "TASK_1",
    });
    const summary2 = summarizeReplayIncidentRecords([r2, r1], {
      taskPda: "TASK_1",
    });

    expect(summary1.deterministicHash).toBe(summary2.deterministicHash);
  });

  it("fixture-driven regression test with pinned output", () => {
    const records = [
      createRecord(1, 10, "SIG_1", "taskCreated"),
      createRecord(2, 11, "SIG_2", "taskClaimed"),
    ];

    const summary = summarizeReplayIncidentRecords(records, {
      taskPda: "TASK_1",
    });

    expect(summary.totalEvents).toBe(2);
    expect(summary.uniqueTaskIds).toEqual(["TASK_1"]);
    expect(summary.sourceEventNameCounts).toEqual({
      taskClaimed: 1,
      taskCreated: 1,
    });
    expect(typeof summary.deterministicHash).toBe("string");
    expect(summary.deterministicHash.length).toBe(64);
  });

  it("different filters produce different hash", () => {
    const records = [createRecord(1, 10, "SIG_1", "taskCreated")];

    const summary1 = summarizeReplayIncidentRecords(records, {
      taskPda: "TASK_1",
    });
    const summary2 = summarizeReplayIncidentRecords(records, {
      taskPda: "TASK_2",
    });

    expect(summary1.deterministicHash).not.toBe(summary2.deterministicHash);
  });

  it("count maps are sorted by key", () => {
    const records = [
      createRecord(1, 10, "SIG_1", "taskCreated"),
      createRecord(2, 11, "SIG_2", "taskClaimed"),
      createRecord(3, 12, "SIG_3", "taskCompleted"),
    ];

    const summary = summarizeReplayIncidentRecords(records, {
      taskPda: "TASK_1",
    });

    const keys = Object.keys(summary.sourceEventNameCounts);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("deriveIncidentTraceId (#968)", () => {
  it("is deterministic for same inputs", () => {
    const filters = { taskPda: "T1", fromSlot: 10, toSlot: 20 };
    const id1 = deriveIncidentTraceId(filters);
    const id2 = deriveIncidentTraceId(filters);
    expect(id1).toBe(id2);
    expect(id1.length).toBe(32);
  });

  it("differs for different inputs", () => {
    const id1 = deriveIncidentTraceId({ taskPda: "T1" });
    const id2 = deriveIncidentTraceId({ taskPda: "T2" });
    expect(id1).not.toBe(id2);
  });

  it("handles missing fields consistently", () => {
    const id1 = deriveIncidentTraceId({});
    const id2 = deriveIncidentTraceId({});
    expect(id1).toBe(id2);
  });

  it("treats missing and undefined fields identically", () => {
    const id1 = deriveIncidentTraceId({});
    const id2 = deriveIncidentTraceId({
      taskPda: undefined,
      disputePda: undefined,
    });
    expect(id1).toBe(id2);
  });
});
