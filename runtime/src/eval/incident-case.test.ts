import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { projectOnChainEvents, type OnChainProjectionInput } from './projector.js';
import { stableStringifyJson } from './types.js';
import {
  INCIDENT_CASE_SCHEMA_VERSION,
  buildIncidentCase,
  computeEvidenceHash,
} from './incident-case.js';
import type { ReplayAnomaly } from './replay-comparison.js';

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

describe('incident case model', () => {
  it('builds a deterministic case from fixture events', () => {
    const taskId = bytes(1);
    const creator = pubkey(8);
    const worker = pubkey(9);

    const inputs: OnChainProjectionInput[] = [
      {
        eventName: 'taskCreated',
        slot: 10,
        signature: 'AAA',
        timestampMs: 1_000,
        event: {
          taskId,
          creator,
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
        eventName: 'taskClaimed',
        slot: 10,
        signature: 'AAA',
        timestampMs: 1_100,
        event: {
          taskId,
          worker,
          currentWorkers: 1,
          maxWorkers: 5,
          timestamp: 1_100,
        },
      },
      {
        eventName: 'taskCompleted',
        slot: 100,
        signature: 'ZZZ',
        timestampMs: 2_000,
        event: {
          taskId,
          worker,
          proofHash: bytes(1, 32),
          resultData: bytes(2, 64),
          rewardPaid: 123n,
          timestamp: 2_000,
        },
      },
    ];

    const projected = projectOnChainEvents(inputs, { traceId: 'trace-1' }).events;
    const incident = buildIncidentCase({ events: projected });

    expect(incident.schemaVersion).toBe(INCIDENT_CASE_SCHEMA_VERSION);
    expect(incident.traceWindow).toEqual({
      fromSlot: 10,
      toSlot: 100,
      fromTimestampMs: 1_000,
      toTimestampMs: 2_000,
    });

    expect(incident.transitions.map((entry) => entry.toState)).toEqual([
      'discovered',
      'claimed',
      'completed',
    ]);

    expect(incident.actorMap).toEqual([
      { pubkey: creator.toBase58(), role: 'creator', firstSeenSeq: 1 },
      { pubkey: worker.toBase58(), role: 'worker', firstSeenSeq: 2 },
    ]);

    expect(incident.taskIds).toEqual([new PublicKey(taskId).toBase58()]);
    expect(incident.disputeIds).toEqual([]);
    expect(incident.anomalies).toEqual([]);
    expect(incident.anomalyIds).toEqual([]);
    expect(incident.evidenceHashes).toEqual([]);
    expect(incident.caseStatus).toBe('open');
  });

  it('handles empty event lists', () => {
    const incident = buildIncidentCase({ events: [] });

    expect(incident.traceWindow).toEqual({
      fromSlot: 0,
      toSlot: 0,
      fromTimestampMs: 0,
      toTimestampMs: 0,
    });
    expect(incident.transitions).toEqual([]);
    expect(incident.taskIds).toEqual([]);
    expect(incident.disputeIds).toEqual([]);
    expect(incident.actorMap).toEqual([]);
    expect(incident.anomalies).toEqual([]);
    expect(incident.anomalyIds).toEqual([]);
  });

  it('supports trace window override', () => {
    const taskId = bytes(3);
    const worker = pubkey(4);

    const inputs: OnChainProjectionInput[] = [
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'A',
        timestampMs: 1_000,
        event: {
          taskId,
          creator: pubkey(1),
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
      {
        eventName: 'taskClaimed',
        slot: 10,
        signature: 'B',
        timestampMs: 1_100,
        event: {
          taskId,
          worker,
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 1_100,
        },
      },
      {
        eventName: 'taskCompleted',
        slot: 20,
        signature: 'C',
        timestampMs: 1_200,
        event: {
          taskId,
          worker,
          proofHash: bytes(1, 32),
          resultData: bytes(2, 64),
          rewardPaid: 0n,
          timestamp: 1_200,
        },
      },
    ];

    const projected = projectOnChainEvents(inputs).events;
    const incident = buildIncidentCase({ events: projected, window: { fromSlot: 5, toSlot: 15 } });

    expect(incident.traceWindow.fromSlot).toBe(5);
    expect(incident.traceWindow.toSlot).toBe(15);
    expect(incident.transitions).toHaveLength(1);
    expect(incident.transitions[0]?.slot).toBe(10);
    expect(incident.transitions[0]?.toState).toBe('claimed');
  });

  it('deduplicates actors and keeps earliest firstSeenSeq', () => {
    const taskId = bytes(5);
    const worker = pubkey(7);

    const inputs: OnChainProjectionInput[] = [
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'A',
        timestampMs: 1_000,
        event: {
          taskId,
          creator: pubkey(2),
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
      {
        eventName: 'taskClaimed',
        slot: 2,
        signature: 'B',
        timestampMs: 1_100,
        event: {
          taskId,
          worker,
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 1_100,
        },
      },
      {
        eventName: 'taskCompleted',
        slot: 3,
        signature: 'C',
        timestampMs: 1_200,
        event: {
          taskId,
          worker,
          proofHash: bytes(1, 32),
          resultData: bytes(2, 64),
          rewardPaid: 0n,
          timestamp: 1_200,
        },
      },
    ];

    const projected = projectOnChainEvents(inputs).events;
    const incident = buildIncidentCase({ events: projected });
    const workerEntry = incident.actorMap.find((entry) => entry.pubkey === worker.toBase58());

    expect(incident.actorMap.filter((entry) => entry.pubkey === worker.toBase58())).toHaveLength(1);
    expect(workerEntry?.firstSeenSeq).toBe(2);
    expect(workerEntry?.role).toBe('worker');
  });

  it('tracks dispute lifecycle transitions', () => {
    const disputeId = bytes(6);
    const taskId = bytes(7);
    const initiator = pubkey(1);
    const defendant = pubkey(2);
    const voter = pubkey(3);

    const inputs: OnChainProjectionInput[] = [
      {
        eventName: 'disputeInitiated',
        slot: 30,
        signature: 'S1',
        timestampMs: 3_000,
        event: {
          disputeId,
          taskId,
          initiator,
          defendant,
          resolutionType: 0,
          votingDeadline: 10_000,
          timestamp: 3_000,
        },
      },
      {
        eventName: 'disputeVoteCast',
        slot: 40,
        signature: 'S2',
        timestampMs: 3_500,
        event: {
          disputeId,
          voter,
          approved: true,
          votesFor: 1n,
          votesAgainst: 0n,
          timestamp: 3_500,
        },
      },
      {
        eventName: 'disputeResolved',
        slot: 50,
        signature: 'S3',
        timestampMs: 4_000,
        event: {
          disputeId,
          resolutionType: 0,
          outcome: 1,
          votesFor: 1n,
          votesAgainst: 0n,
          timestamp: 4_000,
        },
      },
    ];

    const projected = projectOnChainEvents(inputs).events;
    const incident = buildIncidentCase({ events: projected });
    const disputePda = new PublicKey(disputeId).toBase58();

    expect(incident.disputeIds).toEqual([disputePda]);

    const disputeTransitions = incident.transitions.filter((entry) => entry.disputePda === disputePda);
    expect(disputeTransitions.map((entry) => entry.toState)).toEqual([
      'dispute:initiated',
      'dispute:vote_cast',
      'dispute:resolved',
    ]);

    expect(incident.actorMap).toEqual([
      { pubkey: initiator.toBase58(), role: 'creator', firstSeenSeq: 1 },
      { pubkey: defendant.toBase58(), role: 'worker', firstSeenSeq: 1 },
      { pubkey: voter.toBase58(), role: 'arbiter', firstSeenSeq: 2 },
    ]);
  });

  it('maps replay anomalies deterministically', () => {
    const taskId = bytes(9);

    const projected = projectOnChainEvents([
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'A',
        timestampMs: 1_000,
        event: {
          taskId,
          creator: pubkey(1),
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
    ]).events;

    const anomalies: ReplayAnomaly[] = [
      {
        code: 'hash_mismatch',
        severity: 'error',
        message: 'hash differs',
        context: {
          seq: 1,
          taskPda: new PublicKey(taskId).toBase58(),
          signature: 'A',
          sourceEventName: 'taskCreated',
          sourceEventSequence: 0,
        },
      },
      {
        code: 'missing_event',
        severity: 'warning',
        message: 'missing event',
        context: {
          seq: 2,
          signature: 'B',
        },
      },
    ];

    const first = buildIncidentCase({ events: projected, anomalies });
    const second = buildIncidentCase({ events: projected, anomalies });

    expect(first.anomalyIds).toEqual(first.anomalies.map((entry) => entry.anomalyId));
    expect(first.anomalies.map((entry) => entry.code)).toEqual(['hash_mismatch', 'missing_event']);
    expect(first.anomalyIds).toEqual(second.anomalyIds);
  });

  it('computes evidence hashes using stable JSON canonicalization', () => {
    const content = { b: 2, a: 1 };
    const evidence = computeEvidenceHash('example', content);

    const expected = createHash('sha256')
      .update(stableStringifyJson(content))
      .digest('hex');

    expect(evidence).toEqual({ label: 'example', sha256: expected });
  });

  it('produces deterministic case IDs for identical inputs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const taskId = bytes(11);
    const worker = pubkey(12);

    const projected = projectOnChainEvents([
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'A',
        timestampMs: 1_000,
        event: {
          taskId,
          creator: pubkey(1),
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
      {
        eventName: 'taskClaimed',
        slot: 2,
        signature: 'B',
        timestampMs: 1_100,
        event: {
          taskId,
          worker,
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 1_100,
        },
      },
    ]).events;

    const first = buildIncidentCase({ events: projected });
    const second = buildIncidentCase({ events: projected });
    expect(first.caseId).toBe(second.caseId);

    const narrowed = buildIncidentCase({ events: projected, window: { fromSlot: 1, toSlot: 1 } });
    expect(narrowed.caseId).not.toBe(first.caseId);

    const otherTaskId = bytes(12);
    const differentTasks = buildIncidentCase({
      events: projectOnChainEvents([
        {
          eventName: 'taskCreated',
          slot: 1,
          signature: 'A',
          timestampMs: 1_000,
          event: {
            taskId,
            creator: pubkey(1),
            requiredCapabilities: 0n,
            rewardAmount: 0n,
            taskType: 0,
            deadline: 0,
            minReputation: 0,
            rewardMint: null,
            timestamp: 1_000,
          },
        },
        {
          eventName: 'taskClaimed',
          slot: 2,
          signature: 'B',
          timestampMs: 1_100,
          event: {
            taskId,
            worker,
            currentWorkers: 1,
            maxWorkers: 1,
            timestamp: 1_100,
          },
        },
        {
          eventName: 'taskCreated',
          slot: 3,
          signature: 'C',
          timestampMs: 1_200,
          event: {
            taskId: otherTaskId,
            creator: pubkey(2),
            requiredCapabilities: 0n,
            rewardAmount: 0n,
            taskType: 0,
            deadline: 0,
            minReputation: 0,
            rewardMint: null,
            timestamp: 1_200,
          },
        },
      ]).events,
    });
    expect(differentTasks.caseId).not.toBe(first.caseId);

    vi.useRealTimers();
  });

  it('round-trips through JSON serialization without loss', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const projected = projectOnChainEvents([
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'A',
        timestampMs: 1_000,
        event: {
          taskId: bytes(13),
          creator: pubkey(1),
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
    ]).events;

    const incident = buildIncidentCase({ events: projected });
    const roundTrip = JSON.parse(JSON.stringify(incident));
    expect(roundTrip).toEqual(incident);

    vi.useRealTimers();
  });
});
