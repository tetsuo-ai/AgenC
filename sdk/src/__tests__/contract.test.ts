import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  createTask,
  claimTask,
  completeTask,
  getTask,
  generateProof,
  deriveTokenEscrowAddress,
} from '../index.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TaskState, PROGRAM_ID } from '../constants.js';
import { getAccount } from '../anchor-utils.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

const mockFullProve = vi.fn();

vi.mock('snarkjs', () => ({
  default: {
    groth16: {
      fullProve: mockFullProve,
    },
  },
  groth16: {
    fullProve: mockFullProve,
  },
}));

vi.mock('../anchor-utils.js', () => ({
  getAccount: vi.fn(),
}));

function makeKeypair(seed: number): Keypair {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return Keypair.fromSeed(bytes);
}

function makeProgram(methodNames: string[], rpcValue: string): unknown {
  const builder = {
    accountsPartial: vi.fn().mockReturnThis(),
    signers: vi.fn().mockReturnThis(),
    rpc: vi.fn().mockResolvedValue(rpcValue),
  };

  const methods: Record<string, (..._args: unknown[]) => unknown> = {};
  for (const methodName of methodNames) {
    methods[methodName] = vi.fn().mockReturnValue(builder);
  }

  return {
    methods,
    programId: PROGRAM_ID,
  };
}

function mockGetAccount(data: unknown): void {
  vi.mocked(getAccount).mockReturnValueOnce({
    fetch: vi.fn().mockResolvedValue(data),
  } as never);
}

const createPublicKeySeeded = (seed: number): PublicKey => {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return new PublicKey(bytes);
};

describe('SDK contract tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it('returns stable contract for createTask', async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(['createTask'], 'tx-create-task') as never;
    const creator = makeKeypair(1);
    const creatorId = new Uint8Array(32);
    creatorId.fill(1);

    const result = await createTask(
      connection,
      program as never,
      creator,
      creatorId,
      {
        taskId: new Uint8Array(32),
        requiredCapabilities: 1,
        description: new Uint8Array(64),
        rewardAmount: 1,
        maxWorkers: 1,
        deadline: 1,
        taskType: 0,
        constraintHash: undefined,
        minReputation: 0,
      },
    );

    expect(result).toHaveProperty('taskPda');
    expect(result.taskPda).toBeInstanceOf(PublicKey);
    expect(result).toHaveProperty('txSignature', 'tx-create-task');
    expect(typeof result.txSignature).toBe('string');
    expect(result.txSignature).toBe('tx-create-task');
  });

  it('returns stable contract for claimTask', async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(['claimTask'], 'tx-claim-task') as never;
    const worker = makeKeypair(2);
    const taskPda = createPublicKeySeeded(3);
    const workerId = new Uint8Array(32);
    workerId.fill(2);

    const result = await claimTask(
      connection,
      program as never,
      worker,
      workerId,
      taskPda,
    );

    expect(result).toEqual({ txSignature: 'tx-claim-task' });
    expect(result.txSignature).toMatch(/\S+/);
  });

  it('returns stable contract for completeTask', async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(['completeTask'], 'tx-complete-task') as never;
    const worker = makeKeypair(3);
    const taskPda = createPublicKeySeeded(4);
    const workerId = new Uint8Array(32);
    workerId.fill(3);

    mockGetAccount({
      creator: createPublicKeySeeded(5),
      rewardMint: null,
    } as never);
    mockGetAccount({
      treasury: createPublicKeySeeded(6),
    } as never);

    const result = await completeTask(
      connection,
      program as never,
      worker,
      workerId,
      taskPda,
      new Uint8Array(32),
    );

    expect(result).toEqual({ txSignature: 'tx-complete-task' });
    expect(result.txSignature).toMatch(/\S+/);
  });

  it('returns stable TaskStatus contract for getTask', async () => {
    const taskPda = createPublicKeySeeded(7);
    const creator = createPublicKeySeeded(8);
    const constraintHash = new Uint8Array([9, 8, 7, 6]);

    mockGetAccount({
      taskId: new Uint8Array(32),
      status: { open: {} },
      creator,
      rewardAmount: { toString: () => '42' },
      deadline: { toNumber: () => 1_234_567 },
      constraintHash,
      currentWorkers: 1,
      maxWorkers: 2,
      completedAt: null,
      rewardMint: null,
    } as never);

    const status = await getTask(
      { rpc: () => Promise.resolve('ok') } as never,
      taskPda,
    );

    expect(status).not.toBeNull();
    expect(status).toMatchObject({
      taskId: new Uint8Array(32),
      state: TaskState.Open,
      creator,
      rewardAmount: 42n,
      deadline: 1_234_567,
      currentWorkers: 1,
      maxWorkers: 2,
      completedAt: null,
      rewardMint: null,
      constraintHash,
    });
  });

  it('returns stable ProofResult contract for generateProof', async () => {
    mockFullProve.mockResolvedValue({
      proof: {
        pi_a: ['1', '2'],
        pi_b: [['3', '4'], ['5', '6']],
        pi_c: ['7', '8'],
      },
    } as never);

    const result = await generateProof({
      taskPda: createPublicKeySeeded(9),
      agentPubkey: createPublicKeySeeded(10),
      output: [1n, 2n, 3n, 4n],
      salt: 7n,
      circuitPath: 'circuits-circom/task_completion',
    });

    expect(result).toMatchObject({
      proof: expect.any(Buffer),
      constraintHash: expect.any(Buffer),
      outputCommitment: expect.any(Buffer),
      expectedBinding: expect.any(Buffer),
      proofSize: 256,
      generationTime: expect.any(Number),
    });
    expect(result.generationTime).toBeGreaterThanOrEqual(0);
  });

  it('returns stable contract for deriveTokenEscrowAddress', () => {
    const mint = createPublicKeySeeded(11);
    const escrow = createPublicKeySeeded(12);
    const expected = getAssociatedTokenAddressSync(mint, escrow, true);

    const result = deriveTokenEscrowAddress(mint, escrow);

    expect(result).toBeInstanceOf(PublicKey);
    expect(result.toBase58()).toBe(expected.toBase58());
  });
});
