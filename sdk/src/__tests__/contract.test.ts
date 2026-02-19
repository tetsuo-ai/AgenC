import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  createTask,
  claimTask,
  completeTask,
  completeTaskPrivate,
  getTask,
  generateProof,
  deriveTokenEscrowAddress,
} from '../index.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TaskState, PROGRAM_ID } from '../constants.js';
import { getAccount } from '../anchor-utils.js';

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

  it('returns stable contract for completeTaskPrivate with router accounts', async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(['completeTaskPrivate'], 'tx-complete-task-private') as never;
    const worker = makeKeypair(13);
    const taskPda = createPublicKeySeeded(14);
    const workerId = new Uint8Array(32);
    workerId.fill(13);

    const taskId = new Uint8Array(32);
    taskId.fill(42);
    mockGetAccount({
      creator: createPublicKeySeeded(15),
      taskId,
      rewardMint: null,
    } as never);
    mockGetAccount({
      treasury: createPublicKeySeeded(16),
    } as never);

    const generated = await generateProof({
      taskPda,
      agentPubkey: worker.publicKey,
      output: [1n, 2n, 3n, 4n],
      salt: 17n,
    });

    const result = await completeTaskPrivate(
      connection,
      program as never,
      worker,
      workerId,
      taskPda,
      {
        sealBytes: generated.sealBytes,
        journal: generated.journal,
        imageId: generated.imageId,
        bindingValue: generated.bindingValue,
        nullifierSeed: generated.nullifierSeed,
      },
    );

    expect(result).toEqual({ txSignature: 'tx-complete-task-private' });

    const completeTaskPrivateMock = (program as any).methods.completeTaskPrivate as ReturnType<typeof vi.fn>;
    expect(completeTaskPrivateMock).toHaveBeenCalledTimes(1);
    const proofArg = completeTaskPrivateMock.mock.calls[0][1];
    expect(proofArg).toMatchObject({
      sealBytes: expect.any(Array),
      journal: expect.any(Array),
      imageId: expect.any(Array),
      bindingValue: expect.any(Array),
      nullifierSeed: expect.any(Array),
    });
    expect(proofArg.sealBytes).toHaveLength(260);
    expect(proofArg.journal).toHaveLength(192);
    expect(proofArg.imageId).toHaveLength(32);
    expect(proofArg.bindingValue).toHaveLength(32);
    expect(proofArg.nullifierSeed).toHaveLength(32);

    const builder = completeTaskPrivateMock.mock.results[0].value;
    expect(builder.accountsPartial).toHaveBeenCalledWith(expect.objectContaining({
      bindingSpend: expect.any(PublicKey),
      nullifierSpend: expect.any(PublicKey),
      routerProgram: expect.any(PublicKey),
      router: expect.any(PublicKey),
      verifierEntry: expect.any(PublicKey),
      verifierProgram: expect.any(PublicKey),
    }));
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
    const result = await generateProof({
      taskPda: createPublicKeySeeded(9),
      agentPubkey: createPublicKeySeeded(10),
      output: [1n, 2n, 3n, 4n],
      salt: 7n,
    });

    expect(result).toMatchObject({
      sealBytes: expect.any(Buffer),
      journal: expect.any(Buffer),
      imageId: expect.any(Buffer),
      bindingValue: expect.any(Buffer),
      nullifierSeed: expect.any(Buffer),
      generationTime: expect.any(Number),
    });
    expect(result.sealBytes.length).toBe(260);
    expect(result.journal.length).toBe(192);
    expect(result.imageId.length).toBe(32);
    expect(result.bindingValue.length).toBe(32);
    expect(result.nullifierSeed.length).toBe(32);
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
