import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  projectOnChainEvents,
  extractCanonicalTuple,
  canonicalizeEvent,
  type OnChainProjectionInput,
} from "./projector.js";
import { stableStringifyJson } from "./types.js";
import { computeProjectionHash } from "../replay/types.js";
import { deriveTraceId } from "../replay/trace.js";
import { TrajectoryReplayEngine } from "./replay.js";
import { REPLAY_QUALITY_FIXTURE_V1 } from "../../tests/fixtures/replay-quality-fixture.v1.ts";

function pubkey(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return new PublicKey(bytes);
}

function bytes(seed = 0, length = 32): Uint8Array {
  const output = new Uint8Array(length);
  output.fill(seed);
  return output;
}

describe("on-chain event projection", () => {
  it("orders events by slot, signature, and sequence deterministically", () => {
    const events = [
      {
        eventName: "taskCompleted",
        slot: 100,
        signature: "ZZZ",
        timestampMs: 2_000,
        event: {
          taskId: bytes(9),
          worker: pubkey(2),
          proofHash: bytes(1, 32),
          resultData: bytes(2, 64),
          rewardPaid: 123n,
          timestamp: 2_000,
        },
      },
      {
        eventName: "taskCreated",
        slot: 10,
        signature: "AAA",
        timestampMs: 1_000,
        event: {
          taskId: bytes(1),
          creator: pubkey(1),
          requiredCapabilities: 100n,
          rewardAmount: 50_000n,
          taskType: 0,
          deadline: 5_000,
          minReputation: 1,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
      {
        eventName: "taskClaimed",
        slot: 10,
        signature: "AAA",
        timestampMs: 1_100,
        event: {
          taskId: bytes(1),
          worker: pubkey(4),
          currentWorkers: 1,
          maxWorkers: 5,
          timestamp: 1_100,
        },
      },
    ];

    const forward = projectOnChainEvents(events, { traceId: "trace-1" });
    const backward = projectOnChainEvents([...events].reverse(), {
      traceId: "trace-1",
    });

    expect(stableForward(forward)).toEqual(stableForward(backward));
    expect(forward.trace.events.map((entry) => entry.type)).toEqual([
      "discovered",
      "claimed",
      "completed",
    ]);
  });

  it("deduplicates repeated signature/name/payload tuples", () => {
    const event = {
      eventName: "taskCreated",
      slot: 11,
      signature: "SIG_DUP",
      timestampMs: 3_000,
      event: {
        taskId: bytes(3),
        creator: pubkey(9),
        requiredCapabilities: 1n,
        rewardAmount: 50n,
        taskType: 0,
        deadline: 20,
        minReputation: 0,
        rewardMint: null,
        timestamp: 3_000,
      },
    };

    const result = projectOnChainEvents([event, { ...event }, event], {
      traceId: "dup-test",
    });

    expect(result.trace.events).toHaveLength(1);
    expect(result.telemetry.projectedEvents).toBe(1);
    expect(result.telemetry.duplicatesDropped).toBe(2);
  });

  it("captures unknown event names in telemetry and keeps processing", () => {
    const result = projectOnChainEvents([
      {
        eventName: "unknownEventFromProgram",
        slot: 12,
        signature: "SIG_UNKNOWN",
        timestampMs: 100,
        event: { value: 1 },
      },
    ]);

    expect(result.telemetry.unknownEvents).toEqual(["unknownEventFromProgram"]);
    expect(result.telemetry.projectedEvents).toBe(0);
    expect(result.trace.events).toHaveLength(0);
  });

  it("records transition conflicts while still emitting trajectory events", () => {
    const result = projectOnChainEvents([
      {
        eventName: "taskCompleted",
        slot: 15,
        signature: "SIG_TASK",
        timestampMs: 300,
        event: {
          taskId: bytes(7),
          worker: pubkey(1),
          proofHash: bytes(1, 32),
          resultData: bytes(2, 64),
          rewardPaid: 42n,
          timestamp: 300,
        },
      },
    ]);

    expect(result.trace.events).toHaveLength(1);
    expect(result.telemetry.transitionConflicts).toHaveLength(1);
    expect(result.telemetry.transitionConflicts[0]).toContain(
      "none -> completed",
    );
  });

  it("tracks dispute lifecycle transition conflicts", () => {
    const result = projectOnChainEvents([
      {
        eventName: "disputeVoteCast",
        slot: 20,
        signature: "SIG_DISPUTE_VOTE",
        timestampMs: 11,
        event: {
          disputeId: bytes(4),
          voter: pubkey(3),
          approved: true,
          votesFor: 5n,
          votesAgainst: 2n,
          timestamp: 11,
        },
      },
    ]);

    expect(result.telemetry.transitionConflicts).toHaveLength(1);
    expect(result.telemetry.transitionConflicts[0]).toContain(
      "dispute:vote_cast",
    );
  });

  it("produces replay-compatible lifecycle traces for valid task paths", () => {
    const result = projectOnChainEvents([
      {
        eventName: "taskCreated",
        slot: 10,
        signature: "SIG_REPLAY_1",
        event: {
          taskId: bytes(5),
          creator: pubkey(9),
          requiredCapabilities: 1n,
          rewardAmount: 1n,
          taskType: 0,
          deadline: 12,
          minReputation: 0,
          rewardMint: null,
          timestamp: 100,
        },
      },
      {
        eventName: "taskClaimed",
        slot: 11,
        signature: "SIG_REPLAY_2",
        event: {
          taskId: bytes(5),
          worker: pubkey(2),
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 101,
        },
      },
      {
        eventName: "taskCompleted",
        slot: 12,
        signature: "SIG_REPLAY_3",
        event: {
          taskId: bytes(5),
          worker: pubkey(2),
          proofHash: bytes(1, 32),
          resultData: bytes(2, 64),
          rewardPaid: 5n,
          timestamp: 102,
        },
      },
    ]);

    const replay = new TrajectoryReplayEngine({ strictMode: true }).replay(
      result.trace,
    );

    expect(result.telemetry.transitionConflicts).toHaveLength(0);
    expect(replay.errors).toHaveLength(0);
    expect(result.trace.events).toHaveLength(3);
    expect(
      replay.tasks[result.trace.events[0]?.taskPda ?? "missing"],
    ).toBeDefined();
  });

  it("retains non-task context in source metadata", () => {
    const key = pubkey(8);
    const result = projectOnChainEvents([
      {
        eventName: "rewardDistributed",
        slot: 20,
        signature: "SIG_CTX",
        event: {
          taskId: bytes(6),
          recipient: key,
          amount: 100n,
          protocolFee: 1n,
          timestamp: 11,
        },
      },
    ]);

    expect(result.trace.events[0]?.payload).toMatchObject({
      onchain: {
        eventName: "rewardDistributed",
        signature: "SIG_CTX",
      },
    });
  });
});

function stableForward(
  result: ReturnType<typeof projectOnChainEvents>,
): string {
  return JSON.stringify(result.trace.events);
}

it("projects a full-quality fixture deterministically with full event-surface coverage", () => {
  const fixtureInputs = REPLAY_QUALITY_FIXTURE_V1.onChainEvents;
  const resultA = projectOnChainEvents(fixtureInputs, {
    traceId: REPLAY_QUALITY_FIXTURE_V1.traceId,
    seed: REPLAY_QUALITY_FIXTURE_V1.seed,
  });
  const resultB = projectOnChainEvents([...fixtureInputs].reverse(), {
    traceId: REPLAY_QUALITY_FIXTURE_V1.traceId,
    seed: REPLAY_QUALITY_FIXTURE_V1.seed,
  });

  const observedSourceNames = [
    ...new Set(resultA.events.map((entry) => entry.sourceEventName)),
  ].sort();
  const expectedSourceNames = [
    ...new Set(fixtureInputs.map((entry) => entry.eventName)),
  ].sort();
  const observedTypes = [
    ...new Set(resultA.events.map((entry) => entry.type)),
  ].sort();
  const expectedTypes = [
    "agent:registered",
    "agent:updated",
    "agent:deregistered",
    "agent:suspended",
    "agent:unsuspended",
    "protocol:protocol_initialized",
    "protocol:reward_distributed",
    "protocol:rate_limit_hit",
    "protocol:migration_completed",
    "protocol:state_updated",
    "protocol:protocol_version_updated",
    "protocol:rate_limits_updated",
    "protocol:protocol_fee_updated",
    "protocol:reputation_changed",
    "dispute:initiated",
    "dispute:vote_cast",
    "dispute:resolved",
    "dispute:cancelled",
    "dispute:expired",
    "dispute:arbiter_votes_cleaned_up",
    "discovered",
    "claimed",
    "completed",
    "failed",
    "bond:deposited",
    "bond:locked",
    "speculation_started",
    "speculation_confirmed",
    "speculation_aborted",
  ].sort();

  expect(resultA.telemetry.unknownEvents).toHaveLength(0);
  expect(resultA.telemetry.malformedInputs).toHaveLength(0);
  expect(resultA.telemetry.transitionConflicts).toHaveLength(0);
  expect(resultA.trace.events).toHaveLength(fixtureInputs.length);
  expect(resultA.telemetry.projectedEvents).toBe(fixtureInputs.length);
  expect(stableForward(resultA)).toBe(stableForward(resultB));
  expect(observedSourceNames).toEqual(expectedSourceNames);
  expect(observedTypes).toEqual(expectedTypes);
  expect(resultA.events).toHaveLength(fixtureInputs.length);
  expect(resultA.events.every((event, index) => event.seq === index + 1)).toBe(
    true,
  );
});

it("deduplicates repeated fixture snapshots while preserving deterministic ordering", () => {
  const events = REPLAY_QUALITY_FIXTURE_V1.onChainEvents.slice(0, 8);
  const noisy = [
    events[2],
    events[5],
    events[2],
    events[7],
    events[1],
    events[5],
  ];

  const shuffled = [...noisy].sort((left, right) => {
    if (left.slot !== right.slot) {
      return right.slot - left.slot;
    }
    return right.signature.localeCompare(left.signature);
  });

  const result = projectOnChainEvents(noisy, {
    traceId: "replay-quality-v1-noise",
  });
  const replayed = projectOnChainEvents(shuffled, {
    traceId: "replay-quality-v1-noise",
  });

  expect(result.telemetry.duplicatesDropped).toBe(2);
  expect(result.trace.events).toHaveLength(4);
  expect(stableForward(result)).toBe(stableForward(replayed));
  expect(result.events.map((entry) => entry.sourceEventName)).toEqual(
    replayed.events.map((entry) => entry.sourceEventName),
  );
});

describe("Dispute replay determinism (#960)", () => {
  const disputeId = bytes(40);
  const taskId = bytes(41);

  it("reproduces identical dispute state from same event sequence", () => {
    const events = [
      {
        eventName: "taskCreated",
        slot: 1,
        signature: "SIG_DR_TASK",
        event: {
          taskId,
          creator: pubkey(10),
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
        signature: "SIG_DR_CLAIM",
        event: {
          taskId,
          worker: pubkey(11),
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 11,
        },
      },
      {
        eventName: "disputeInitiated",
        slot: 3,
        signature: "SIG_DR_INIT",
        event: {
          disputeId,
          taskId,
          initiator: pubkey(20),
          defendant: pubkey(21),
          resolutionType: 0,
          votingDeadline: 100,
          timestamp: 12,
        },
      },
      {
        eventName: "disputeVoteCast",
        slot: 4,
        signature: "SIG_DR_VOTE1",
        event: {
          disputeId,
          voter: pubkey(22),
          approved: true,
          votesFor: 5n,
          votesAgainst: 0n,
          timestamp: 13,
        },
      },
      {
        eventName: "disputeVoteCast",
        slot: 5,
        signature: "SIG_DR_VOTE2",
        event: {
          disputeId,
          voter: pubkey(23),
          approved: false,
          votesFor: 5n,
          votesAgainst: 3n,
          timestamp: 14,
        },
      },
      {
        eventName: "disputeResolved",
        slot: 6,
        signature: "SIG_DR_RESOLVE",
        event: {
          disputeId,
          taskId,
          resolutionType: 0,
          outcome: 1,
          votesFor: 5n,
          votesAgainst: 3n,
          timestamp: 15,
        },
      },
    ];

    const result1 = projectOnChainEvents(events, { traceId: "run-1" });
    const result2 = projectOnChainEvents(events, { traceId: "run-2" });

    const disputeKey = [...result1.disputes.keys()][0]!;
    const d1 = result1.disputes.get(disputeKey)!;
    const d2 = result2.disputes.get(disputeKey)!;

    expect(d1.votesFor).toBe(d2.votesFor);
    expect(d1.votesAgainst).toBe(d2.votesAgainst);
    expect(d1.totalVoters).toBe(d2.totalVoters);
    expect(d1.resolutionOutcome).toBe(d2.resolutionOutcome);
    expect(d1.status).toBe(d2.status);

    expect(d1.votesFor).toBe(5n);
    expect(d1.votesAgainst).toBe(3n);
    expect(d1.totalVoters).toBe(2);
    expect(d1.resolutionOutcome).toBe(1);
    expect(d1.status).toBe("dispute:resolved");
    expect(d1.voterSignatures).toEqual(["SIG_DR_VOTE1", "SIG_DR_VOTE2"]);
    expect(d1.resolvedAtSlot).toBe(6);
  });

  it("detects stale vote replay (vote after resolution)", () => {
    const staleDisputeId = bytes(42);
    const events = [
      {
        eventName: "taskCreated",
        slot: 1,
        signature: "SIG_SV_TASK",
        event: {
          taskId,
          creator: pubkey(10),
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
        signature: "SIG_SV_CLAIM",
        event: {
          taskId,
          worker: pubkey(11),
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 11,
        },
      },
      {
        eventName: "disputeInitiated",
        slot: 3,
        signature: "SIG_SV_INIT",
        event: {
          disputeId: staleDisputeId,
          taskId,
          initiator: pubkey(20),
          defendant: pubkey(21),
          resolutionType: 0,
          votingDeadline: 100,
          timestamp: 12,
        },
      },
      {
        eventName: "disputeResolved",
        slot: 4,
        signature: "SIG_SV_RESOLVE",
        event: {
          disputeId: staleDisputeId,
          taskId,
          resolutionType: 0,
          outcome: 2,
          votesFor: 0n,
          votesAgainst: 0n,
          timestamp: 13,
        },
      },
      {
        eventName: "disputeVoteCast",
        slot: 5,
        signature: "SIG_SV_STALE",
        event: {
          disputeId: staleDisputeId,
          voter: pubkey(22),
          approved: true,
          votesFor: 1n,
          votesAgainst: 0n,
          timestamp: 14,
        },
      },
    ];

    const result = projectOnChainEvents(events, { traceId: "stale-vote" });
    expect(result.telemetry.transitionViolations).toHaveLength(1);
    expect(result.telemetry.transitionViolations[0]?.fromState).toBe(
      "dispute:resolved",
    );
    expect(result.telemetry.transitionViolations[0]?.toState).toBe(
      "dispute:vote_cast",
    );
  });

  it("tracks cancelled and expired dispute states", () => {
    const cancelledId = bytes(43);
    const expiredId = bytes(44);
    const taskId2 = bytes(45);

    const events = [
      {
        eventName: "taskCreated",
        slot: 1,
        signature: "SIG_CE_TASK1",
        event: {
          taskId,
          creator: pubkey(10),
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
        signature: "SIG_CE_CLAIM1",
        event: {
          taskId,
          worker: pubkey(11),
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 11,
        },
      },
      {
        eventName: "disputeInitiated",
        slot: 3,
        signature: "SIG_CE_INIT1",
        event: {
          disputeId: cancelledId,
          taskId,
          initiator: pubkey(20),
          defendant: pubkey(21),
          resolutionType: 0,
          votingDeadline: 100,
          timestamp: 12,
        },
      },
      {
        eventName: "disputeCancelled",
        slot: 4,
        signature: "SIG_CE_CANCEL",
        event: {
          disputeId: cancelledId,
          task: pubkey(1),
          initiator: pubkey(20),
          cancelledAt: 13,
        },
      },
      {
        eventName: "taskCreated",
        slot: 5,
        signature: "SIG_CE_TASK2",
        event: {
          taskId: taskId2,
          creator: pubkey(12),
          requiredCapabilities: 1n,
          rewardAmount: 1n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 14,
        },
      },
      {
        eventName: "taskClaimed",
        slot: 6,
        signature: "SIG_CE_CLAIM2",
        event: {
          taskId: taskId2,
          worker: pubkey(13),
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 15,
        },
      },
      {
        eventName: "disputeInitiated",
        slot: 7,
        signature: "SIG_CE_INIT2",
        event: {
          disputeId: expiredId,
          taskId: taskId2,
          initiator: pubkey(25),
          defendant: pubkey(26),
          resolutionType: 1,
          votingDeadline: 200,
          timestamp: 16,
        },
      },
      {
        eventName: "disputeExpired",
        slot: 8,
        signature: "SIG_CE_EXPIRE",
        event: {
          disputeId: expiredId,
          taskId: taskId2,
          refundAmount: 100n,
          creatorAmount: 50n,
          workerAmount: 50n,
          timestamp: 17,
        },
      },
    ];

    const result = projectOnChainEvents(events, { traceId: "cancel-expire" });

    expect(result.telemetry.transitionViolations).toHaveLength(0);
    expect(result.disputes.size).toBe(2);

    const keys = [...result.disputes.keys()];
    const cancelled = result.disputes.get(keys[0]!)!;
    const expired = result.disputes.get(keys[1]!)!;

    expect(cancelled.status).toBe("dispute:cancelled");
    expect(expired.status).toBe("dispute:expired");
  });
});

describe("Canonical event normalization (#964)", () => {
  it("produces identical projection regardless of input order", () => {
    const eventsA = [
      {
        eventName: "taskCreated",
        slot: 1,
        signature: "SIG_A",
        event: {
          taskId: bytes(1),
          creator: pubkey(1),
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
        signature: "SIG_B",
        event: {
          taskId: bytes(1),
          worker: pubkey(2),
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 11,
        },
      },
    ];
    const eventsB = [eventsA[1], eventsA[0]];

    const resultA = projectOnChainEvents(eventsA, { traceId: "test" });
    const resultB = projectOnChainEvents(eventsB, { traceId: "test" });

    expect(resultA.events.map((e) => e.sourceEventName)).toEqual(
      resultB.events.map((e) => e.sourceEventName),
    );
    expect(resultA.events.map((e) => computeProjectionHash(e))).toEqual(
      resultB.events.map((e) => computeProjectionHash(e)),
    );
  });

  it("fills missing fields with stable defaults", () => {
    const tuple = extractCanonicalTuple(
      {
        eventName: "",
        slot: -1,
        signature: "",
        event: {},
      } as OnChainProjectionInput,
      42,
    );
    expect(tuple).toEqual({
      slot: 0,
      signature: "",
      sourceEventSequence: 42,
      sourceEventName: "",
    });
  });

  it("uses provided sourceEventSequence over fallback", () => {
    const tuple = extractCanonicalTuple(
      {
        eventName: "taskCreated",
        slot: 5,
        signature: "SIG",
        event: {},
        sourceEventSequence: 7,
      } as OnChainProjectionInput,
      99,
    );
    expect(tuple).toEqual({
      slot: 5,
      signature: "SIG",
      sourceEventSequence: 7,
      sourceEventName: "taskCreated",
    });
  });

  it("canonicalizeEvent produces sorted keys", () => {
    const a = canonicalizeEvent({ z: 1, a: 2, m: { b: 3, a: 4 } });
    const b = canonicalizeEvent({ m: { a: 4, b: 3 }, a: 2, z: 1 });
    expect(stableStringifyJson(a)).toBe(stableStringifyJson(b));
  });

  it("canonicalizeEvent converts non-JSON-safe values", () => {
    const result = canonicalizeEvent({
      amount: 100n,
      key: new PublicKey(new Uint8Array(32).fill(1)),
      data: new Uint8Array([0xab, 0xcd]),
    });
    expect(typeof result.amount).toBe("string");
    expect(typeof result.key).toBe("string");
    expect(typeof result.data).toBe("string");
  });

  it("deriveTraceId produces same ID for same inputs", () => {
    const id1 = deriveTraceId(undefined, 100, "SIG_X", "taskCreated", 0);
    const id2 = deriveTraceId(undefined, 100, "SIG_X", "taskCreated", 0);
    expect(id1).toBe(id2);
    expect(id1.length).toBe(32);
  });

  it("deriveTraceId returns base when provided", () => {
    const id = deriveTraceId("my-trace", 100, "SIG_X", "taskCreated", 0);
    expect(id).toBe("my-trace");
  });

  it("computeProjectionHash produces identical hash for identical events", () => {
    const event = {
      seq: 1,
      type: "discovered",
      taskPda: "TASK_1",
      timestampMs: 1000,
      payload: {
        onchain: { eventName: "taskCreated", signature: "SIG_1", slot: 1 },
      },
      slot: 1,
      signature: "SIG_1",
      sourceEventName: "taskCreated",
      sourceEventSequence: 0,
    };
    const hash1 = computeProjectionHash(event);
    const hash2 = computeProjectionHash({ ...event });
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex
  });
});
