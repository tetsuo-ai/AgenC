import { describe, expect, it } from "vitest";
import {
  computeProjectionHash,
  type ReplayTimelineRecord,
} from "../replay/types.js";
import {
  ReplayComparisonError,
  ReplayComparisonService,
  type ReplayComparisonMetrics,
  type ReplayComparisonOptions,
} from "./replay-comparison.js";
import { projectOnChainEvents } from "./projector.js";
import { buildReplayTraceContext } from "../replay/index.js";
import type {
  ReplayAnomalyAlert,
  ReplayAlertDispatcher,
} from "../replay/alerting.js";
import { REPLAY_QUALITY_FIXTURE_V1 } from "../../tests/fixtures/replay-quality-fixture.v1.ts";

function bytes(value: number, length = 32): Uint8Array {
  return Uint8Array.from({ length }, () => value);
}

function makeRecordsWithHash(
  events: ReturnType<typeof projectOnChainEvents>["events"],
): ReplayTimelineRecord[] {
  return events.map((event) => {
    const onchain = event.payload.onchain;
    const trace =
      onchain !== null && typeof onchain === "object"
        ? (
            onchain as {
              trace?: {
                traceId?: string;
                spanId?: string;
                parentSpanId?: string;
                sampled?: boolean;
              };
            }
          ).trace
        : undefined;

    const record: ReplayTimelineRecord = {
      ...event,
      traceId: trace?.traceId,
      traceSpanId: trace?.spanId,
      traceParentSpanId: trace?.parentSpanId,
      traceSampled: trace?.sampled === true,
      projectionHash: computeProjectionHash(event),
    };

    return record;
  });
}

function extractDisputeIdFromRecord(
  record: ReplayTimelineRecord,
): string | undefined {
  const payload = record.payload as {
    disputeId?: string;
    onchain?: { disputeId?: string };
  };
  return payload.disputeId ?? payload.onchain?.disputeId;
}

function taskCreatedEvents() {
  const taskId = bytes(1);
  return [
    {
      eventName: "taskCreated",
      slot: 1,
      signature: "SIG_TASK_1",
      event: {
        taskId,
        creator: bytes(2),
        requiredCapabilities: 1n,
        rewardAmount: 1n,
        taskType: 0,
        deadline: 0,
        minReputation: 0,
        rewardMint: null,
        timestamp: 10,
      },
    },
    {
      eventName: "taskClaimed",
      slot: 2,
      signature: "SIG_TASK_2",
      event: {
        taskId,
        worker: bytes(3),
        currentWorkers: 1,
        maxWorkers: 2,
        timestamp: 11,
      },
    },
    {
      eventName: "taskCompleted",
      slot: 3,
      signature: "SIG_TASK_3",
      event: {
        taskId,
        worker: bytes(3),
        proofHash: bytes(4, 32),
        resultData: bytes(5, 64),
        rewardPaid: 7n,
        timestamp: 12,
      },
    },
  ] as const;
}

function makeCollectingDispatcher(): {
  alerts: ReplayAnomalyAlert[];
  dispatcher: ReplayAlertDispatcher;
} {
  const alerts: ReplayAnomalyAlert[] = [];

  return {
    alerts,
    dispatcher: {
      async emit(context) {
        const alert: ReplayAnomalyAlert = {
          ...context,
          id: `fixed-${context.code}`,
          emittedAtMs: alerts.length + 1,
          repeatCount: 1,
        };

        alerts.push(alert);
        return alert;
      },
    } as unknown as ReplayAlertDispatcher,
  };
}

describe("ReplayComparisonService", () => {
  it("produces a clean report for matching projected and local traces", async () => {
    const onChain = taskCreatedEvents();
    const projection = projectOnChainEvents(onChain, { traceId: "cmp-good" });
    const records = makeRecordsWithHash(projection.events);

    const report = await new ReplayComparisonService().compare({
      projected: records,
      localTrace: projection.trace,
      options: {
        strictness: "strict",
      },
    });

    expect(report.status).toBe("clean");
    expect(report.anomalies).toHaveLength(0);
    expect(report.taskIds).toEqual([records[0]?.taskPda]);
    expect(report.localReplay.deterministicHash).toBe(
      report.projectedReplay.deterministicHash,
    );
  });

  it("returns deterministic mismatch anomalies when projected trace is perturbed", async () => {
    const onChain = taskCreatedEvents();
    const projection = projectOnChainEvents(onChain, { traceId: "cmp-bad" });
    const records = makeRecordsWithHash(projection.events);

    const perturbed = records.map((record, index) =>
      index === 1 ? { ...record, type: "failed" as const } : record,
    );

    const report = await new ReplayComparisonService().compare({
      projected: perturbed,
      localTrace: projection.trace,
      options: {
        strictness: "lenient",
      },
    });

    expect(report.status).toBe("mismatched");
    expect(report.mismatchCount).toBeGreaterThan(0);
    expect(report.anomalies.map((entry) => entry.code)).toContain(
      "type_mismatch",
    );
    expect(report.anomalies.map((entry) => entry.code)).toContain(
      "hash_mismatch",
    );
    expect(report.anomalies.some((entry) => entry.context.taskPda)).toBe(true);
  });

  it("preserves trace identifiers in mismatch context", async () => {
    const onChain = taskCreatedEvents();
    const projection = projectOnChainEvents(
      onChain.map((event, index) => ({
        ...event,
        traceContext: buildReplayTraceContext({
          traceId: "cmp-trace",
          eventName: event.eventName,
          slot: event.slot,
          signature: event.signature,
          eventSequence: index,
          sampleRate: 1,
        }),
      })),
      { traceId: "cmp-trace" },
    );
    const records = makeRecordsWithHash(projection.events);

    const localWithoutDispute = {
      ...projection.trace,
      events: projection.trace.events.filter((entry) => entry.seq !== 2),
    };

    const report = await new ReplayComparisonService().compare({
      projected: records,
      localTrace: localWithoutDispute,
      options: {
        strictness: "lenient",
      },
    });

    const missingTrace = report.anomalies.find(
      (entry) => entry.code === "missing_event",
    );
    expect(missingTrace?.context.traceId).toBe("cmp-trace");
  });

  it("throws in strict mode and exposes machine-readable report", async () => {
    const onChain = taskCreatedEvents();
    const projection = projectOnChainEvents(onChain, { traceId: "cmp-strict" });
    const records = makeRecordsWithHash(projection.events);

    const perturbed = records.map((record, index) =>
      index === 1
        ? {
            ...record,
            taskPda: "bad-task",
            projectionHash: record.projectionHash,
          }
        : record,
    );

    await expect(
      new ReplayComparisonService().compare({
        projected: perturbed,
        localTrace: projection.trace,
        options: {
          strictness: "strict",
        },
      }),
    ).rejects.toThrow(ReplayComparisonError);
  });

  it("includes dispute IDs in diagnostics when matching on dispute timelines", async () => {
    const taskId = bytes(1);
    const disputeId = bytes(2);

    const projection = projectOnChainEvents(
      [
        {
          eventName: "taskCreated",
          slot: 4,
          signature: "SIG_TASK",
          event: {
            taskId,
            creator: bytes(3),
            requiredCapabilities: 1n,
            rewardAmount: 1n,
            taskType: 0,
            deadline: 0,
            minReputation: 0,
            rewardMint: null,
            timestamp: 20,
          },
        },
        {
          eventName: "disputeInitiated",
          slot: 5,
          signature: "SIG_DISPUTE",
          event: {
            disputeId,
            taskId,
            initiator: bytes(4),
            defendant: bytes(5),
            resolutionType: 0,
            votingDeadline: 100,
            timestamp: 21,
          },
        },
      ],
      { traceId: "cmp-dispute" },
    );

    const records = makeRecordsWithHash(projection.events);
    const disputeRecord = records.find((entry) => {
      const disputeId = (entry.payload as { disputeId?: string })?.disputeId;
      return disputeId !== undefined && disputeId.length > 0;
    });
    expect(disputeRecord).toBeDefined();

    const localWithoutDispute = {
      ...projection.trace,
      events: projection.trace.events.filter(
        (entry) => entry.type !== "dispute:initiated",
      ),
    };

    const report = await new ReplayComparisonService().compare({
      projected: records,
      localTrace: localWithoutDispute,
      options: {
        strictness: "lenient",
      },
    });

    expect(report.status).toBe("mismatched");
    const missing = report.anomalies.find(
      (entry) => entry.code === "missing_event",
    );
    const recordDisputeId = extractDisputeIdFromRecord(disputeRecord!);
    expect(missing?.context.disputePda).toBe(recordDisputeId);
    expect(report.disputeIds).toContain(recordDisputeId);
  });

  it("remains deterministic for a quality fixture trace across repeated comparisons", async () => {
    const projection = projectOnChainEvents(
      REPLAY_QUALITY_FIXTURE_V1.onChainEvents,
      {
        traceId: REPLAY_QUALITY_FIXTURE_V1.traceId,
        seed: REPLAY_QUALITY_FIXTURE_V1.seed,
      },
    );
    const records = makeRecordsWithHash(projection.events);

    const first = await new ReplayComparisonService().compare({
      projected: records,
      localTrace: projection.trace,
      options: {
        strictness: "lenient",
      },
    });
    const second = await new ReplayComparisonService().compare({
      projected: records,
      localTrace: projection.trace,
      options: {
        strictness: "lenient",
      },
    });

    expect(first.status).toBe("mismatched");
    expect(second.status).toBe("mismatched");
    expect(first.localReplay.deterministicHash).toBe(
      second.localReplay.deterministicHash,
    );
    expect(first.projectedReplay.deterministicHash).toBe(
      second.projectedReplay.deterministicHash,
    );
    expect(first.anomalies.length).toBe(second.anomalies.length);
  });

  it("produces stable mismatch summaries for perturbations against fixture traces", async () => {
    const projection = projectOnChainEvents(
      REPLAY_QUALITY_FIXTURE_V1.onChainEvents,
      {
        traceId: REPLAY_QUALITY_FIXTURE_V1.traceId,
        seed: REPLAY_QUALITY_FIXTURE_V1.seed,
      },
    );
    const records = makeRecordsWithHash(projection.events);

    const perturbed = records.map((record, index) =>
      index === 12 ? { ...record, type: "failed" as const } : record,
    );

    const report = await new ReplayComparisonService().compare({
      projected: perturbed,
      localTrace: projection.trace,
      options: {
        strictness: "lenient",
      },
    });

    expect(report.status).toBe("mismatched");
    expect(report.anomalies.map((entry) => entry.code)).toContain(
      "type_mismatch",
    );
    expect(report.anomalies.map((entry) => entry.code)).toContain(
      "hash_mismatch",
    );
    expect(report.mismatchCount).toBe(report.anomalies.length);
    expect(report.anomalies.map((entry) => entry.code)).toContain(
      "transition_invalid",
    );
  });

  it("emits comparison alerts through configured dispatcher for mismatch paths", async () => {
    const onChain = taskCreatedEvents();
    const projection = projectOnChainEvents(onChain, { traceId: "cmp-alerts" });
    const records = makeRecordsWithHash(projection.events);
    const perturbed = records.map((record, index) =>
      index === 1
        ? {
            ...record,
            taskPda: "bad-task",
            projectionHash: record.projectionHash,
          }
        : record,
    );

    const service = new ReplayComparisonService();
    const { alerts, dispatcher } = makeCollectingDispatcher();
    const options: ReplayComparisonOptions = {
      strictness: "lenient",
      alertDispatcher: dispatcher,
    };

    const report = await service.compare({
      projected: perturbed,
      localTrace: projection.trace,
      options,
    });

    expect(report.status).toBe("mismatched");
    expect(alerts).toHaveLength(report.anomalies.length);
    expect(alerts.map((entry) => entry.code)).toContain(
      "replay.compare.task_id_mismatch",
    );
    expect(alerts.some((entry) => entry.kind === "replay_hash_mismatch")).toBe(
      true,
    );
    expect(alerts.every((entry) => typeof entry.id === "string")).toBe(true);
  });

  it("emits comparison metrics with mismatch and latency labels", async () => {
    const onChain = taskCreatedEvents();
    const projection = projectOnChainEvents(onChain, {
      traceId: "cmp-metrics",
    });
    const records = makeRecordsWithHash(projection.events);
    const perturbed = records.map((entry, index) =>
      index === 0 ? { ...entry, type: "completed" as const } : entry,
    );

    const metrics: {
      calls: Array<{
        name: string;
        value?: number;
        labels?: Record<string, string>;
      }>;
    } = {
      calls: [],
    };

    const recorder: ReplayComparisonMetrics = {
      counter(name, value = 1, labels) {
        metrics.calls.push({ name, value, labels });
      },
      histogram(name, value, labels) {
        metrics.calls.push({ name, value, labels });
      },
    };

    await new ReplayComparisonService().compare({
      projected: perturbed,
      localTrace: projection.trace,
      options: {
        strictness: "lenient",
        metrics: recorder,
      },
    });

    const counterNames = metrics.calls.map((entry) => entry.name);
    expect(counterNames).toContain("agenc.replay.comparison.total");
    expect(counterNames).toContain("agenc.replay.comparison.mismatches");
    expect(counterNames).toContain(
      "agenc.replay.comparison.anomaly.hash_mismatch",
    );
    expect(counterNames).toContain(
      "agenc.replay.comparison.anomaly.event_mismatch",
    );
    expect(counterNames).toContain(
      "agenc.replay.comparison.resolution_latency_ms",
    );
  });
});
