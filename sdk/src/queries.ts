/**
 * Query Helpers for AgenC
 *
 * Efficient on-chain queries using Solana's memcmp filters
 */

import { Connection, PublicKey, GetProgramAccountsFilter } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import { PROGRAM_ID, DISCRIMINATOR_SIZE } from './constants';
import { getAccount } from './anchor-utils';

// ============================================================================
// Task Account Field Offsets
// ============================================================================

/**
 * Byte offsets for all fields in the Task account.
 *
 * Task account layout (from programs/agenc-coordination/src/state.rs):
 *   discriminator:          8 bytes  (offset 0)
 *   task_id:               32 bytes  (offset 8)
 *   creator:               32 bytes  (offset 40)
 *   required_capabilities:  8 bytes  (offset 72)
 *   description:           64 bytes  (offset 80)
 *   constraint_hash:       32 bytes  (offset 144)
 *   reward_amount:          8 bytes  (offset 176)
 *   max_workers:            1 byte   (offset 184)
 *   current_workers:        1 byte   (offset 185)
 *   status:                 1 byte   (offset 186)
 *   task_type:              1 byte   (offset 187)
 *   created_at:             8 bytes  (offset 188)
 *   deadline:               8 bytes  (offset 196)
 *   completed_at:           8 bytes  (offset 204)
 *   escrow:                32 bytes  (offset 212)
 *   result:                64 bytes  (offset 244)
 *   completions:            1 byte   (offset 308)
 *   required_completions:   1 byte   (offset 309)
 *   bump:                   1 byte   (offset 310)
 *   protocol_fee_bps:       2 bytes  (offset 311)
 *   depends_on:            33 bytes  (offset 313) - Option<Pubkey>: 1 byte discriminator + 32 bytes
 *   dependency_type:        1 byte   (offset 346)
 *   min_reputation:         2 bytes  (offset 347)
 *   reward_mint:           33 bytes  (offset 349) - Option<Pubkey>: 1 byte discriminator + 32 bytes
 *
 * For Option<Pubkey>:
 *   - Byte 0: discriminator (0 = None, 1 = Some)
 *   - Bytes 1-32: Pubkey data (when Some)
 */
export const TASK_FIELD_OFFSETS = {
  /** Anchor account discriminator (8 bytes) */
  DISCRIMINATOR: 0,
  /** Unique task identifier (32 bytes) */
  TASK_ID: 8,
  /** Task creator pubkey (32 bytes) */
  CREATOR: 40,
  /** Required capability bitmask (8 bytes) */
  REQUIRED_CAPABILITIES: 72,
  /** Task description or instruction hash (64 bytes) */
  DESCRIPTION: 80,
  /** Constraint hash for private task verification (32 bytes) */
  CONSTRAINT_HASH: 144,
  /** Reward amount in lamports or token units (8 bytes) */
  REWARD_AMOUNT: 176,
  /** Maximum workers allowed (1 byte) */
  MAX_WORKERS: 184,
  /** Current worker count (1 byte) */
  CURRENT_WORKERS: 185,
  /** Task status enum (1 byte) */
  STATUS: 186,
  /** Task type enum (1 byte) */
  TASK_TYPE: 187,
  /** Creation timestamp (8 bytes) */
  CREATED_AT: 188,
  /** Deadline timestamp (8 bytes) */
  DEADLINE: 196,
  /** Completion timestamp (8 bytes) */
  COMPLETED_AT: 204,
  /** Escrow account pubkey (32 bytes) */
  ESCROW: 212,
  /** Result data or pointer (64 bytes) */
  RESULT: 244,
  /** Number of completions (1 byte) */
  COMPLETIONS: 308,
  /** Required completions (1 byte) */
  REQUIRED_COMPLETIONS: 309,
  /** PDA bump seed (1 byte) */
  BUMP: 310,
  /** Protocol fee in basis points, locked at task creation (2 bytes) */
  PROTOCOL_FEE_BPS: 311,
  /** Optional parent task dependency - Option<Pubkey> (1 + 32 bytes) */
  DEPENDS_ON: 313,
  /** The actual Pubkey bytes within depends_on (after Option discriminator) */
  DEPENDS_ON_PUBKEY: 314,
  /** Type of dependency relationship (1 byte) */
  DEPENDENCY_TYPE: 346,
  /** Minimum reputation score required (2 bytes) */
  MIN_REPUTATION: 347,
  /** Optional SPL token mint - Option<Pubkey> (1 + 32 bytes) */
  REWARD_MINT: 349,
  /** The actual Pubkey bytes within reward_mint (after Option discriminator) */
  REWARD_MINT_PUBKEY: 350,
} as const;

// ============================================================================
// Result Types
// ============================================================================

/**
 * Parsed task data returned from dependency queries.
 */
export interface DependentTask {
  /** Task account public key */
  publicKey: PublicKey;
  /** Task ID bytes */
  taskId: Uint8Array;
  /** Task creator */
  creator: PublicKey;
  /** Required capability bitmask */
  requiredCapabilities: bigint;
  /** Task description/instruction hash */
  description: Uint8Array;
  /** Constraint hash for private verification */
  constraintHash: Uint8Array;
  /** Reward amount in lamports */
  rewardAmount: bigint;
  /** Maximum workers allowed */
  maxWorkers: number;
  /** Current worker count */
  currentWorkers: number;
  /** Task status */
  status: number;
  /** Task type */
  taskType: number;
  /** Creation timestamp (unix seconds) */
  createdAt: number;
  /** Deadline timestamp (unix seconds, 0 = no deadline) */
  deadline: number;
  /** Completion timestamp (unix seconds, 0 = not completed) */
  completedAt: number;
  /** Escrow account pubkey */
  escrow: PublicKey;
  /** Result data or pointer */
  result: Uint8Array;
  /** Number of completions */
  completions: number;
  /** Required completions */
  requiredCompletions: number;
  /** PDA bump seed */
  bump: number;
  /** Protocol fee in basis points, locked at task creation */
  protocolFeeBps: number;
  /** Parent task this depends on (null if no dependency) */
  dependsOn: PublicKey | null;
  /** Type of dependency relationship */
  dependencyType: number;
  /** Minimum reputation score required (0 = no gate) */
  minReputation: number;
  /** SPL token mint for reward denomination (null = SOL) */
  rewardMint: PublicKey | null;
}

// ============================================================================
// Dependency Query Functions
// ============================================================================

/**
 * Get all tasks that depend on a given parent task.
 *
 * Uses memcmp filters on the `depends_on` field for efficient on-chain filtering.
 * Only fetches tasks where depends_on is Some(parentTaskPda).
 *
 * @param connection - Solana RPC connection
 * @param programId - AgenC program ID (defaults to PROGRAM_ID)
 * @param parentTaskPda - The parent task PDA to query dependents for
 * @returns Array of parsed task data that depend on the parent
 *
 * @example
 * ```typescript
 * const parentTask = deriveTaskPda(parentTaskId);
 * const dependents = await getTasksByDependency(connection, PROGRAM_ID, parentTask);
 * console.log(`Found ${dependents.length} dependent tasks`);
 * for (const task of dependents) {
 *   console.log(`Task ${task.publicKey.toBase58()} depends on parent`);
 * }
 * ```
 */
export async function getTasksByDependency(
  connection: Connection,
  programId: PublicKey,
  parentTaskPda: PublicKey
): Promise<DependentTask[]> {
  // Build the memcmp bytes: Option discriminator (1 = Some) + Pubkey bytes
  const filterBytes = Buffer.alloc(33);
  filterBytes[0] = 1; // Some discriminator
  parentTaskPda.toBuffer().copy(filterBytes, 1);

  const filters: GetProgramAccountsFilter[] = [
    {
      memcmp: {
        offset: TASK_FIELD_OFFSETS.DEPENDS_ON,
        bytes: filterBytes.toString('base64'),
        encoding: 'base64',
      },
    },
  ];

  const accounts = await connection.getProgramAccounts(programId, {
    filters,
  });

  return accounts.map(({ pubkey, account }) =>
    deserializeTaskAccount(pubkey, account.data as Buffer)
  );
}

/**
 * Get the count of tasks that depend on a given parent task.
 *
 * Uses dataSlice to minimize bandwidth - only fetches account keys, not full data.
 * This is more efficient than getTasksByDependency when you only need the count.
 *
 * @param connection - Solana RPC connection
 * @param programId - AgenC program ID (defaults to PROGRAM_ID)
 * @param parentTaskPda - The parent task PDA to count dependents for
 * @returns Number of tasks that depend on the parent
 *
 * @example
 * ```typescript
 * const parentTask = deriveTaskPda(parentTaskId);
 * const count = await getDependentTaskCount(connection, PROGRAM_ID, parentTask);
 * if (count > 0) {
 *   console.log(`Cannot delete task: ${count} tasks depend on it`);
 * }
 * ```
 */
export async function getDependentTaskCount(
  connection: Connection,
  programId: PublicKey,
  parentTaskPda: PublicKey
): Promise<number> {
  // Build the memcmp bytes: Option discriminator (1 = Some) + Pubkey bytes
  const filterBytes = Buffer.alloc(33);
  filterBytes[0] = 1; // Some discriminator
  parentTaskPda.toBuffer().copy(filterBytes, 1);

  const filters: GetProgramAccountsFilter[] = [
    {
      memcmp: {
        offset: TASK_FIELD_OFFSETS.DEPENDS_ON,
        bytes: filterBytes.toString('base64'),
        encoding: 'base64',
      },
    },
  ];

  // Use dataSlice to fetch only 0 bytes of data - we just need the count
  const accounts = await connection.getProgramAccounts(programId, {
    filters,
    dataSlice: { offset: 0, length: 0 },
  });

  return accounts.length;
}

/**
 * Check if a task has any dependents (child tasks).
 *
 * This is a convenience wrapper around getDependentTaskCount.
 *
 * @param connection - Solana RPC connection
 * @param programId - AgenC program ID
 * @param taskPda - The task PDA to check
 * @returns True if the task has at least one dependent
 *
 * @example
 * ```typescript
 * if (await hasDependents(connection, PROGRAM_ID, taskPda)) {
 *   console.log('Task has dependent tasks');
 * }
 * ```
 */
export async function hasDependents(
  connection: Connection,
  programId: PublicKey,
  taskPda: PublicKey
): Promise<boolean> {
  const count = await getDependentTaskCount(connection, programId, taskPda);
  return count > 0;
}

/**
 * Get all tasks that depend on a parent, using an Anchor program instance.
 *
 * This is a convenience wrapper that uses Anchor's account fetching
 * which provides automatic deserialization.
 *
 * @param program - Anchor program instance
 * @param parentTaskPda - The parent task PDA to query dependents for
 * @returns Array of deserialized task accounts
 */
export async function getTasksByDependencyWithProgram(
  program: Program,
  parentTaskPda: PublicKey
): Promise<Array<{ publicKey: PublicKey; account: unknown }>> {
  // Build the memcmp bytes: Option discriminator (1 = Some) + Pubkey bytes
  const filterBytes = Buffer.alloc(33);
  filterBytes[0] = 1; // Some discriminator
  parentTaskPda.toBuffer().copy(filterBytes, 1);

  const tasks = await getAccount(program, 'task').all([
    {
      memcmp: {
        offset: TASK_FIELD_OFFSETS.DEPENDS_ON,
        bytes: filterBytes.toString('base64'),
      },
    },
  ]);

  return tasks.map((t) => ({
    publicKey: t.publicKey,
    account: t.account,
  }));
}

/**
 * Get all root tasks (tasks with no dependencies).
 *
 * Uses memcmp filter to find tasks where depends_on is None.
 *
 * @param connection - Solana RPC connection
 * @param programId - AgenC program ID
 * @returns Array of root task data
 */
export async function getRootTasks(
  connection: Connection,
  programId: PublicKey
): Promise<DependentTask[]> {
  // For None, the Option discriminator byte is 0
  const filterBytes = Buffer.alloc(1);
  filterBytes[0] = 0; // None discriminator

  const filters: GetProgramAccountsFilter[] = [
    {
      memcmp: {
        offset: TASK_FIELD_OFFSETS.DEPENDS_ON,
        bytes: filterBytes.toString('base64'),
        encoding: 'base64',
      },
    },
  ];

  const accounts = await connection.getProgramAccounts(programId, {
    filters,
  });

  return accounts.map(({ pubkey, account }) =>
    deserializeTaskAccount(pubkey, account.data as Buffer)
  );
}

// ============================================================================
// Task Deserialization
// ============================================================================

/**
 * Deserialize raw Task account data into a DependentTask object.
 */
function deserializeTaskAccount(publicKey: PublicKey, data: Buffer): DependentTask {
  const taskId = data.subarray(
    TASK_FIELD_OFFSETS.TASK_ID,
    TASK_FIELD_OFFSETS.TASK_ID + 32
  );

  const creator = new PublicKey(
    data.subarray(TASK_FIELD_OFFSETS.CREATOR, TASK_FIELD_OFFSETS.CREATOR + 32)
  );

  const requiredCapabilities = data.readBigUInt64LE(
    TASK_FIELD_OFFSETS.REQUIRED_CAPABILITIES
  );

  const description = data.subarray(
    TASK_FIELD_OFFSETS.DESCRIPTION,
    TASK_FIELD_OFFSETS.DESCRIPTION + 64
  );

  const constraintHash = data.subarray(
    TASK_FIELD_OFFSETS.CONSTRAINT_HASH,
    TASK_FIELD_OFFSETS.CONSTRAINT_HASH + 32
  );

  const rewardAmount = data.readBigUInt64LE(TASK_FIELD_OFFSETS.REWARD_AMOUNT);

  const maxWorkers = data.readUInt8(TASK_FIELD_OFFSETS.MAX_WORKERS);
  const currentWorkers = data.readUInt8(TASK_FIELD_OFFSETS.CURRENT_WORKERS);
  const status = data.readUInt8(TASK_FIELD_OFFSETS.STATUS);
  const taskType = data.readUInt8(TASK_FIELD_OFFSETS.TASK_TYPE);

  const createdAt = Number(data.readBigInt64LE(TASK_FIELD_OFFSETS.CREATED_AT));
  const deadline = Number(data.readBigInt64LE(TASK_FIELD_OFFSETS.DEADLINE));
  const completedAt = Number(data.readBigInt64LE(TASK_FIELD_OFFSETS.COMPLETED_AT));

  const escrow = new PublicKey(
    data.subarray(TASK_FIELD_OFFSETS.ESCROW, TASK_FIELD_OFFSETS.ESCROW + 32)
  );

  const result = data.subarray(
    TASK_FIELD_OFFSETS.RESULT,
    TASK_FIELD_OFFSETS.RESULT + 64
  );

  const completions = data.readUInt8(TASK_FIELD_OFFSETS.COMPLETIONS);
  const requiredCompletions = data.readUInt8(TASK_FIELD_OFFSETS.REQUIRED_COMPLETIONS);
  const bump = data.readUInt8(TASK_FIELD_OFFSETS.BUMP);

  const protocolFeeBps = data.readUInt16LE(TASK_FIELD_OFFSETS.PROTOCOL_FEE_BPS);

  // Parse Option<Pubkey> for depends_on
  const dependsOnDiscriminator = data.readUInt8(TASK_FIELD_OFFSETS.DEPENDS_ON);
  let dependsOn: PublicKey | null = null;
  if (dependsOnDiscriminator === 1) {
    dependsOn = new PublicKey(
      data.subarray(
        TASK_FIELD_OFFSETS.DEPENDS_ON_PUBKEY,
        TASK_FIELD_OFFSETS.DEPENDS_ON_PUBKEY + 32
      )
    );
  }

  const dependencyType = data.readUInt8(TASK_FIELD_OFFSETS.DEPENDENCY_TYPE);

  const minReputation = data.readUInt16LE(TASK_FIELD_OFFSETS.MIN_REPUTATION);

  // Parse Option<Pubkey> for reward_mint
  const rewardMintDiscriminator = data.readUInt8(TASK_FIELD_OFFSETS.REWARD_MINT);
  let rewardMint: PublicKey | null = null;
  if (rewardMintDiscriminator === 1) {
    rewardMint = new PublicKey(
      data.subarray(
        TASK_FIELD_OFFSETS.REWARD_MINT_PUBKEY,
        TASK_FIELD_OFFSETS.REWARD_MINT_PUBKEY + 32
      )
    );
  }

  return {
    publicKey,
    taskId,
    creator,
    requiredCapabilities,
    description,
    constraintHash,
    rewardAmount,
    maxWorkers,
    currentWorkers,
    status,
    taskType,
    createdAt,
    deadline,
    completedAt,
    escrow,
    result,
    completions,
    requiredCompletions,
    bump,
    protocolFeeBps,
    dependsOn,
    dependencyType,
    minReputation,
    rewardMint,
  };
}
