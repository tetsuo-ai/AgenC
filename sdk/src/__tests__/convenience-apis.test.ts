import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getTaskLifecycleSummary, TaskState } from '../tasks';
import { getDisputesByActor, getReplayHealthCheck } from '../queries';
import { PROGRAM_ID } from '../constants';

function bnLike(value: number) {
  return {
    toNumber: () => value,
    toString: () => String(value),
  };
}

function createTaskRaw(overrides: Partial<Record<string, unknown>> = {}) {
  const creator = overrides.creator as PublicKey ?? Keypair.generate().publicKey;
  return {
    taskId: new Uint8Array(32).fill(1),
    status: overrides.status ?? { open: {} },
    creator,
    rewardAmount: overrides.rewardAmount ?? { toString: () => '1000' },
    deadline: overrides.deadline ?? bnLike(0),
    constraintHash: overrides.constraintHash ?? null,
    currentWorkers: overrides.currentWorkers ?? 0,
    maxWorkers: overrides.maxWorkers ?? 1,
    completedAt: overrides.completedAt ?? null,
    rewardMint: overrides.rewardMint ?? null,
    createdAt: overrides.createdAt ?? bnLike(1000),
    dependsOn: overrides.dependsOn ?? null,
  };
}

function buildLifecycleProgram(params: {
  taskRaw: Record<string, unknown>;
  claims?: Array<{ publicKey: PublicKey; account: Record<string, unknown> }>;
  disputes?: Array<{ publicKey: PublicKey; account: Record<string, unknown> }>;
  dependentCount?: number;
  missingTask?: boolean;
}) {
  const fetchTask = params.missingTask
    ? vi.fn().mockRejectedValue(new Error('Account does not exist'))
    : vi.fn().mockResolvedValue(params.taskRaw);

  const taskClaimAll = vi.fn().mockResolvedValue(params.claims ?? []);
  const disputeAll = vi.fn().mockResolvedValue(params.disputes ?? []);

  const getProgramAccounts = vi.fn().mockResolvedValue(
    Array.from({ length: params.dependentCount ?? 0 }, () => ({ account: {}, pubkey: Keypair.generate().publicKey })),
  );

  return {
    programId: PROGRAM_ID,
    provider: {
      connection: {
        getProgramAccounts,
      },
    },
    account: {
      task: {
        fetch: fetchTask,
      },
      taskClaim: {
        all: taskClaimAll,
      },
      dispute: {
        all: disputeAll,
      },
    },
  };
}

function createDisputeBuffer(args: {
  disputeIdByte: number;
  taskPda: PublicKey;
  initiator: PublicKey;
  defendant: PublicKey;
  status: number;
  resolutionType: number;
  initiatedAt: number;
  votingDeadline: number;
  votesFor: number;
  votesAgainst: number;
}) {
  const data = Buffer.alloc(263, 0);

  Buffer.alloc(32, args.disputeIdByte).copy(data, 8);
  args.taskPda.toBuffer().copy(data, 40);
  args.initiator.toBuffer().copy(data, 72);
  data.writeUInt8(args.resolutionType, 168);
  data.writeUInt8(args.status, 169);
  data.writeBigInt64LE(BigInt(args.initiatedAt), 170);
  data.writeBigUInt64LE(BigInt(args.votesFor), 186);
  data.writeBigUInt64LE(BigInt(args.votesAgainst), 194);
  data.writeBigInt64LE(BigInt(args.votingDeadline), 203);
  args.defendant.toBuffer().copy(data, 231);

  return data;
}

describe('convenience APIs (#975)', () => {
  describe('getTaskLifecycleSummary', () => {
    it('returns completed task timeline in order', async () => {
      const taskPda = Keypair.generate().publicKey;
      const worker = Keypair.generate().publicKey;

      const program = buildLifecycleProgram({
        taskRaw: createTaskRaw({
          status: { completed: {} },
          currentWorkers: 1,
          maxWorkers: 2,
          deadline: bnLike(5000),
          completedAt: bnLike(1300),
          createdAt: bnLike(1000),
        }),
        claims: [
          {
            publicKey: Keypair.generate().publicKey,
            account: {
              worker,
              claimedAt: bnLike(1100),
              completedAt: bnLike(1300),
            },
          },
        ],
        dependentCount: 2,
      });

      const summary = await getTaskLifecycleSummary(program as any, taskPda);

      expect(summary).not.toBeNull();
      expect(summary?.currentState).toBe(TaskState.Completed);
      expect(summary?.dependentCount).toBe(2);
      expect(summary?.durationSeconds).toBe(300);
      expect(summary?.timeline.map((e) => e.eventName)).toEqual([
        'taskCreated',
        'taskClaimed',
        'taskClaimCompleted',
        'taskCompleted',
      ]);
    });

    it('returns cancelled timeline with cancellation event', async () => {
      const taskPda = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;

      const program = buildLifecycleProgram({
        taskRaw: createTaskRaw({
          creator,
          status: { cancelled: {} },
          createdAt: bnLike(1000),
        }),
      });

      const summary = await getTaskLifecycleSummary(program as any, taskPda);
      expect(summary?.timeline.some((e) => e.eventName === 'taskCancelled')).toBe(true);
    });

    it('marks non-terminal overdue task as expired', async () => {
      const taskPda = Keypair.generate().publicKey;
      const now = Math.floor(Date.now() / 1000);

      const program = buildLifecycleProgram({
        taskRaw: createTaskRaw({
          status: { inProgress: {} },
          deadline: bnLike(now - 30),
          completedAt: null,
        }),
      });

      const summary = await getTaskLifecycleSummary(program as any, taskPda);
      expect(summary?.isExpired).toBe(true);
    });

    it('returns null for missing task account', async () => {
      const program = buildLifecycleProgram({
        taskRaw: {},
        missingTask: true,
      });

      const summary = await getTaskLifecycleSummary(program as any, Keypair.generate().publicKey);
      expect(summary).toBeNull();
    });

    it('flags active dispute state and preserves dependent count', async () => {
      const taskPda = Keypair.generate().publicKey;
      const initiator = Keypair.generate().publicKey;

      const program = buildLifecycleProgram({
        taskRaw: createTaskRaw({
          status: { disputed: {} },
        }),
        disputes: [
          {
            publicKey: Keypair.generate().publicKey,
            account: {
              initiator,
              status: { active: {} },
              createdAt: bnLike(1200),
              resolvedAt: bnLike(0),
            },
          },
        ],
        dependentCount: 3,
      });

      const summary = await getTaskLifecycleSummary(program as any, taskPda);
      expect(summary?.hasActiveDispute).toBe(true);
      expect(summary?.dependentCount).toBe(3);
    });
  });

  describe('getDisputesByActor', () => {
    it('finds disputes where actor is initiator', async () => {
      const actor = Keypair.generate().publicKey;
      const disputePda = Keypair.generate().publicKey;
      const taskPda = Keypair.generate().publicKey;

      const connection = {
        getProgramAccounts: vi
          .fn()
          .mockResolvedValueOnce([
            {
              pubkey: disputePda,
              account: {
                data: createDisputeBuffer({
                  disputeIdByte: 1,
                  taskPda,
                  initiator: actor,
                  defendant: Keypair.generate().publicKey,
                  status: 0,
                  resolutionType: 1,
                  initiatedAt: 100,
                  votingDeadline: 200,
                  votesFor: 2,
                  votesAgainst: 1,
                }),
              },
            },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        getAccountInfo: vi.fn(),
      };

      const results = await getDisputesByActor(connection as any, actor, PROGRAM_ID);
      expect(results).toHaveLength(1);
      expect(results[0].actorRole).toBe('initiator');
    });

    it('finds disputes where actor is defendant', async () => {
      const actor = Keypair.generate().publicKey;
      const disputePda = Keypair.generate().publicKey;
      const taskPda = Keypair.generate().publicKey;

      const connection = {
        getProgramAccounts: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              pubkey: disputePda,
              account: {
                data: createDisputeBuffer({
                  disputeIdByte: 2,
                  taskPda,
                  initiator: Keypair.generate().publicKey,
                  defendant: actor,
                  status: 1,
                  resolutionType: 0,
                  initiatedAt: 120,
                  votingDeadline: 240,
                  votesFor: 3,
                  votesAgainst: 0,
                }),
              },
            },
          ])
          .mockResolvedValueOnce([]),
        getAccountInfo: vi.fn(),
      };

      const results = await getDisputesByActor(connection as any, actor, PROGRAM_ID);
      expect(results).toHaveLength(1);
      expect(results[0].actorRole).toBe('defendant');
    });

    it('returns empty when actor has no disputes', async () => {
      const actor = Keypair.generate().publicKey;

      const connection = {
        getProgramAccounts: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        getAccountInfo: vi.fn(),
      };

      const results = await getDisputesByActor(connection as any, actor, PROGRAM_ID);
      expect(results).toEqual([]);
    });

    it('deduplicates disputes returned by multiple role scans', async () => {
      const actor = Keypair.generate().publicKey;
      const disputePda = Keypair.generate().publicKey;
      const taskPda = Keypair.generate().publicKey;
      const duplicateData = createDisputeBuffer({
        disputeIdByte: 9,
        taskPda,
        initiator: actor,
        defendant: actor,
        status: 0,
        resolutionType: 2,
        initiatedAt: 100,
        votingDeadline: 200,
        votesFor: 1,
        votesAgainst: 1,
      });

      const connection = {
        getProgramAccounts: vi
          .fn()
          .mockResolvedValueOnce([{ pubkey: disputePda, account: { data: duplicateData } }])
          .mockResolvedValueOnce([{ pubkey: disputePda, account: { data: duplicateData } }])
          .mockResolvedValueOnce([]),
        getAccountInfo: vi.fn(),
      };

      const results = await getDisputesByActor(connection as any, actor, PROGRAM_ID);
      expect(results).toHaveLength(1);
    });
  });

  describe('getReplayHealthCheck', () => {
    it('returns healthy for recent events', async () => {
      const now = Date.now();
      const store = {
        query: vi.fn().mockResolvedValue([
          { taskPda: 'task-1', disputePda: 'dispute-1', timestampMs: now - 1_000 },
          { taskPda: 'task-2', timestampMs: now - 2_000 },
        ]),
        getCursor: vi.fn().mockResolvedValue({ slot: 1, signature: 'sig-1' }),
      };

      const health = await getReplayHealthCheck(store);
      expect(health.status).toBe('healthy');
      expect(health.eventCount).toBe(2);
      expect(health.uniqueTaskCount).toBe(2);
    });

    it('returns empty for no records', async () => {
      const store = {
        query: vi.fn().mockResolvedValue([]),
        getCursor: vi.fn().mockResolvedValue(null),
      };

      const health = await getReplayHealthCheck(store);
      expect(health.status).toBe('empty');
      expect(health.latestEventTimestampMs).toBeNull();
    });

    it('returns stale for old records', async () => {
      const store = {
        query: vi.fn().mockResolvedValue([
          { taskPda: 'task-1', timestampMs: Date.now() - 7_200_000 },
        ]),
        getCursor: vi.fn().mockResolvedValue(null),
      };

      const health = await getReplayHealthCheck(store, 3_600_000);
      expect(health.status).toBe('stale');
      expect(health.hasRecentEvents).toBe(false);
    });

    it('returns unreachable when store query throws', async () => {
      const store = {
        query: vi.fn().mockRejectedValue(new Error('offline')),
        getCursor: vi.fn(),
      };

      const health = await getReplayHealthCheck(store);
      expect(health.status).toBe('unreachable');
      expect(health.storeReachable).toBe(false);
    });
  });
});
