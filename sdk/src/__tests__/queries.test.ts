/**
 * Unit tests for dependency query helpers.
 *
 * These tests verify:
 * 1. TASK_FIELD_OFFSETS match the on-chain Task struct layout
 * 2. Query functions build correct memcmp filters
 * 3. Data parsing handles account data correctly
 *
 * @see https://github.com/tetsuo-ai/AgenC/issues/262
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Connection, Keypair } from '@solana/web3.js';
import * as queries from '../queries';
import { PROGRAM_ID } from '../constants';
import { TaskState } from '../tasks';

const {
  TASK_FIELD_OFFSETS,
  getTasksByDependency,
  getDependentTaskCount,
  hasDependents,
} = queries;

// Generate valid test pubkeys
const makeTestPubkey = (seed: number): PublicKey => {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return new PublicKey(bytes);
};

describe('TASK_FIELD_OFFSETS', () => {
  describe('offset values match on-chain Task struct', () => {
    // Values MUST match programs/agenc-coordination/src/state.rs:Task
    it('DISCRIMINATOR offset is 0', () => {
      expect(TASK_FIELD_OFFSETS.DISCRIMINATOR).toBe(0);
    });

    it('TASK_ID offset is 8 (after 8-byte discriminator)', () => {
      expect(TASK_FIELD_OFFSETS.TASK_ID).toBe(8);
    });

    it('CREATOR offset is 40 (after task_id)', () => {
      // discriminator(8) + task_id(32) = 40
      expect(TASK_FIELD_OFFSETS.CREATOR).toBe(40);
    });

    it('DEPENDS_ON offset is 311', () => {
      // This is the critical offset for memcmp filtering
      // Calculated from the Task struct layout:
      // discriminator(8) + task_id(32) + creator(32) + required_capabilities(8) +
      // description(64) + constraint_hash(32) + reward_amount(8) + max_workers(1) +
      // current_workers(1) + status(1) + task_type(1) + created_at(8) + deadline(8) +
      // completed_at(8) + escrow(32) + result(64) + completions(1) +
      // required_completions(1) + bump(1) = 311
      expect(TASK_FIELD_OFFSETS.DEPENDS_ON).toBe(311);
    });

    it('DEPENDS_ON_PUBKEY offset is 312 (after Option discriminator)', () => {
      // The Pubkey value is 1 byte after the Option discriminator
      expect(TASK_FIELD_OFFSETS.DEPENDS_ON_PUBKEY).toBe(312);
    });

    it('DEPENDENCY_TYPE offset is 344 (after depends_on)', () => {
      // DEPENDS_ON(311) + Option<Pubkey>(33) = 344
      expect(TASK_FIELD_OFFSETS.DEPENDENCY_TYPE).toBe(344);
    });
  });

  describe('offset calculation verification', () => {
    it('offsets are in ascending order', () => {
      const offsets = [
        TASK_FIELD_OFFSETS.DISCRIMINATOR,
        TASK_FIELD_OFFSETS.TASK_ID,
        TASK_FIELD_OFFSETS.CREATOR,
        TASK_FIELD_OFFSETS.REQUIRED_CAPABILITIES,
        TASK_FIELD_OFFSETS.DESCRIPTION,
        TASK_FIELD_OFFSETS.CONSTRAINT_HASH,
        TASK_FIELD_OFFSETS.REWARD_AMOUNT,
        TASK_FIELD_OFFSETS.MAX_WORKERS,
        TASK_FIELD_OFFSETS.CURRENT_WORKERS,
        TASK_FIELD_OFFSETS.STATUS,
        TASK_FIELD_OFFSETS.TASK_TYPE,
        TASK_FIELD_OFFSETS.CREATED_AT,
        TASK_FIELD_OFFSETS.DEADLINE,
        TASK_FIELD_OFFSETS.COMPLETED_AT,
        TASK_FIELD_OFFSETS.ESCROW,
        TASK_FIELD_OFFSETS.RESULT,
        TASK_FIELD_OFFSETS.COMPLETIONS,
        TASK_FIELD_OFFSETS.REQUIRED_COMPLETIONS,
        TASK_FIELD_OFFSETS.BUMP,
        TASK_FIELD_OFFSETS.DEPENDS_ON,
        TASK_FIELD_OFFSETS.DEPENDENCY_TYPE,
      ];

      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
      }
    });

    it('field sizes are correct', () => {
      // Verify key field size calculations
      expect(TASK_FIELD_OFFSETS.TASK_ID - TASK_FIELD_OFFSETS.DISCRIMINATOR).toBe(8); // discriminator size
      expect(TASK_FIELD_OFFSETS.CREATOR - TASK_FIELD_OFFSETS.TASK_ID).toBe(32); // task_id size
      expect(TASK_FIELD_OFFSETS.REQUIRED_CAPABILITIES - TASK_FIELD_OFFSETS.CREATOR).toBe(32); // creator (pubkey) size
      expect(TASK_FIELD_OFFSETS.DEPENDS_ON_PUBKEY - TASK_FIELD_OFFSETS.DEPENDS_ON).toBe(1); // Option discriminator size
    });
  });
});

describe('getTasksByDependency', () => {
  let mockConnection: Connection;
  let parentTaskPda: PublicKey;

  beforeEach(() => {
    parentTaskPda = makeTestPubkey(1);
    mockConnection = {
      getProgramAccounts: vi.fn(),
    } as unknown as Connection;
  });

  it('calls getProgramAccounts with correct memcmp filter', async () => {
    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([]);

    await getTasksByDependency(mockConnection, PROGRAM_ID, parentTaskPda);

    expect(mockConnection.getProgramAccounts).toHaveBeenCalledWith(
      PROGRAM_ID,
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({
            memcmp: expect.objectContaining({
              offset: TASK_FIELD_OFFSETS.DEPENDS_ON,
            }),
          }),
        ]),
      })
    );
  });

  it('builds correct filter bytes for Some(Pubkey)', async () => {
    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([]);

    await getTasksByDependency(mockConnection, PROGRAM_ID, parentTaskPda);

    const call = vi.mocked(mockConnection.getProgramAccounts).mock.calls[0];
    const filter = (call[1] as { filters: Array<{ memcmp: { bytes: string } }> }).filters[0];
    const bytes = Buffer.from(filter.memcmp.bytes, 'base64');

    // First byte should be 1 (Some discriminator)
    expect(bytes[0]).toBe(1);
    // Remaining 32 bytes should be the pubkey
    expect(bytes.subarray(1).toString('hex')).toBe(parentTaskPda.toBuffer().toString('hex'));
  });

  it('returns empty array when no tasks found', async () => {
    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([]);

    const result = await getTasksByDependency(mockConnection, PROGRAM_ID, parentTaskPda);

    expect(result).toEqual([]);
  });

  it('parses task data correctly', async () => {
    // Create mock task account data
    const taskPda = makeTestPubkey(2);
    const creator = makeTestPubkey(3);
    const taskData = createMockTaskData({
      taskId: Buffer.alloc(32, 0x01),
      creator,
      dependsOn: parentTaskPda,
      status: TaskState.InProgress,
      rewardAmount: BigInt(1000000),
      createdAt: BigInt(1700000000),
      deadline: BigInt(1700100000),
    });

    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([
      { pubkey: taskPda, account: { data: taskData, executable: false, lamports: 0, owner: PROGRAM_ID } },
    ]);

    const result = await getTasksByDependency(mockConnection, PROGRAM_ID, parentTaskPda);

    expect(result).toHaveLength(1);
    expect(result[0].publicKey.equals(taskPda)).toBe(true);
    expect(result[0].creator.equals(creator)).toBe(true);
    expect(result[0].dependsOn.equals(parentTaskPda)).toBe(true);
    expect(result[0].status).toBe(TaskState.InProgress);
    expect(result[0].rewardAmount).toBe(BigInt(1000000));
    expect(result[0].createdAt).toBe(1700000000);
    expect(result[0].deadline).toBe(1700100000);
  });

  it('handles multiple dependent tasks', async () => {
    const taskPda1 = makeTestPubkey(2);
    const taskPda2 = makeTestPubkey(4);
    const creator = makeTestPubkey(3);

    const taskData1 = createMockTaskData({ creator, dependsOn: parentTaskPda });
    const taskData2 = createMockTaskData({ creator, dependsOn: parentTaskPda });

    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([
      { pubkey: taskPda1, account: { data: taskData1, executable: false, lamports: 0, owner: PROGRAM_ID } },
      { pubkey: taskPda2, account: { data: taskData2, executable: false, lamports: 0, owner: PROGRAM_ID } },
    ]);

    const result = await getTasksByDependency(mockConnection, PROGRAM_ID, parentTaskPda);

    expect(result).toHaveLength(2);
  });
});

describe('getDependentTaskCount', () => {
  let mockConnection: Connection;
  let parentTaskPda: PublicKey;

  beforeEach(() => {
    parentTaskPda = makeTestPubkey(1);
    mockConnection = {
      getProgramAccounts: vi.fn(),
    } as unknown as Connection;
  });

  it('calls getProgramAccounts with dataSlice for efficiency', async () => {
    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([]);

    await getDependentTaskCount(mockConnection, PROGRAM_ID, parentTaskPda);

    expect(mockConnection.getProgramAccounts).toHaveBeenCalledWith(
      PROGRAM_ID,
      expect.objectContaining({
        dataSlice: { offset: 0, length: 0 },
      })
    );
  });

  it('returns 0 when no tasks found', async () => {
    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([]);

    const count = await getDependentTaskCount(mockConnection, PROGRAM_ID, parentTaskPda);

    expect(count).toBe(0);
  });

  it('returns correct count for multiple tasks', async () => {
    // Mock returns accounts with empty data (due to dataSlice)
    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([
      { pubkey: makeTestPubkey(1), account: { data: Buffer.alloc(0), executable: false, lamports: 0, owner: PROGRAM_ID } },
      { pubkey: makeTestPubkey(2), account: { data: Buffer.alloc(0), executable: false, lamports: 0, owner: PROGRAM_ID } },
      { pubkey: makeTestPubkey(3), account: { data: Buffer.alloc(0), executable: false, lamports: 0, owner: PROGRAM_ID } },
    ]);

    const count = await getDependentTaskCount(mockConnection, PROGRAM_ID, parentTaskPda);

    expect(count).toBe(3);
  });
});

describe('hasDependents', () => {
  let mockConnection: Connection;
  let taskPda: PublicKey;

  beforeEach(() => {
    taskPda = makeTestPubkey(1);
    mockConnection = {
      getProgramAccounts: vi.fn(),
    } as unknown as Connection;
  });

  it('returns false when task has no dependents', async () => {
    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([]);

    const result = await hasDependents(mockConnection, PROGRAM_ID, taskPda);

    expect(result).toBe(false);
  });

  it('returns true when task has at least one dependent', async () => {
    vi.mocked(mockConnection.getProgramAccounts).mockResolvedValue([
      { pubkey: makeTestPubkey(2), account: { data: Buffer.alloc(0), executable: false, lamports: 0, owner: PROGRAM_ID } },
    ]);

    const result = await hasDependents(mockConnection, PROGRAM_ID, taskPda);

    expect(result).toBe(true);
  });
});

/**
 * Helper to create mock Task account data for testing.
 */
function createMockTaskData(params: {
  taskId?: Buffer;
  creator?: PublicKey;
  dependsOn?: PublicKey;
  status?: TaskState;
  rewardAmount?: bigint;
  createdAt?: bigint;
  deadline?: bigint;
}): Buffer {
  const data = Buffer.alloc(400); // Large enough for Task account

  // Write discriminator (8 bytes) - use placeholder
  data.fill(0xaa, 0, 8);

  // Write task_id (32 bytes at offset 8)
  if (params.taskId) {
    params.taskId.copy(data, TASK_FIELD_OFFSETS.TASK_ID);
  }

  // Write creator (32 bytes at offset 40)
  if (params.creator) {
    params.creator.toBuffer().copy(data, TASK_FIELD_OFFSETS.CREATOR);
  }

  // Write reward_amount (8 bytes at offset 176)
  if (params.rewardAmount !== undefined) {
    data.writeBigUInt64LE(params.rewardAmount, TASK_FIELD_OFFSETS.REWARD_AMOUNT);
  }

  // Write status (1 byte at offset 186)
  if (params.status !== undefined) {
    data.writeUInt8(params.status, TASK_FIELD_OFFSETS.STATUS);
  }

  // Write created_at (8 bytes at offset 188)
  if (params.createdAt !== undefined) {
    data.writeBigInt64LE(params.createdAt, TASK_FIELD_OFFSETS.CREATED_AT);
  }

  // Write deadline (8 bytes at offset 196)
  if (params.deadline !== undefined) {
    data.writeBigInt64LE(params.deadline, TASK_FIELD_OFFSETS.DEADLINE);
  }

  // Write depends_on (Option<Pubkey> at offset 311)
  if (params.dependsOn) {
    data.writeUInt8(1, TASK_FIELD_OFFSETS.DEPENDS_ON); // Some discriminator
    params.dependsOn.toBuffer().copy(data, TASK_FIELD_OFFSETS.DEPENDS_ON_PUBKEY);
  } else {
    data.writeUInt8(0, TASK_FIELD_OFFSETS.DEPENDS_ON); // None discriminator
  }

  return data;
}
