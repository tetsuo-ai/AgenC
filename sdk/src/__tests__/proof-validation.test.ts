import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import {
  validateProofPreconditions,
  DEFAULT_MAX_PROOF_AGE_MS,
} from '../proof-validation';
import { NullifierCache } from '../nullifier-cache';
import {
  completeTaskPrivateSafe,
  type PrivateCompletionProof,
  ProofPreconditionError,
} from '../tasks';
import { PROGRAM_ID } from '../constants';

function bnLike(value: number) {
  return {
    toNumber: () => value,
    toString: () => String(value),
  };
}

function makeBytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function makeProof(overrides: Partial<PrivateCompletionProof> = {}): PrivateCompletionProof {
  return {
    proofData: makeBytes(256, 7),
    constraintHash: makeBytes(32, 1),
    outputCommitment: makeBytes(32, 2),
    expectedBinding: makeBytes(32, 3),
    nullifier: makeBytes(32, 4),
    ...overrides,
  };
}

function makeValidationHarness(options?: {
  taskMissing?: boolean;
  taskState?: unknown;
  privateTask?: boolean;
  constraintHash?: Uint8Array;
  deadline?: number;
  taskType?: number;
  completions?: number;
  claimMissing?: boolean;
  claimCompleted?: boolean;
  claimExpiresAt?: number;
  nullifierSpent?: boolean;
}) {
  const now = Math.floor(Date.now() / 1000);
  const creator = Keypair.generate().publicKey;

  const taskFetch = options?.taskMissing
    ? vi.fn().mockRejectedValue(new Error('Account does not exist'))
    : vi.fn().mockResolvedValue({
        taskId: makeBytes(32, 9),
        status: options?.taskState ?? { inProgress: {} },
        creator,
        rewardAmount: { toString: () => '1000' },
        deadline: bnLike(options?.deadline ?? now + 600),
        constraintHash: options?.privateTask === false
          ? makeBytes(32, 0)
          : (options?.constraintHash ?? makeBytes(32, 1)),
        currentWorkers: 1,
        maxWorkers: 1,
        completedAt: null,
        rewardMint: null,
        createdAt: bnLike(now - 120),
        taskType: options?.taskType ?? 1,
        completions: options?.completions ?? 0,
      });

  const claimFetch = options?.claimMissing
    ? vi.fn().mockRejectedValue(new Error('claim missing'))
    : vi.fn().mockResolvedValue({
        isCompleted: options?.claimCompleted ?? false,
        expiresAt: bnLike(options?.claimExpiresAt ?? now + 120),
      });

  const program = {
    programId: PROGRAM_ID,
    account: {
      task: { fetch: taskFetch },
      taskClaim: { fetch: claimFetch },
      protocolConfig: {
        fetch: vi.fn().mockResolvedValue({
          treasury: Keypair.generate().publicKey,
        }),
      },
    },
    methods: {
      completeTaskPrivate: vi.fn().mockReturnValue({
        accountsPartial: vi.fn().mockReturnValue({
          signers: vi.fn().mockReturnValue({
            rpc: vi.fn().mockResolvedValue('tx-sig'),
          }),
        }),
      }),
    },
  } as unknown as Program;

  const connection = {
    getAccountInfo: vi.fn().mockResolvedValue(options?.nullifierSpent ? { data: Buffer.alloc(0) } : null),
    confirmTransaction: vi.fn().mockResolvedValue(undefined),
  };

  return {
    program,
    connection,
    taskPda: Keypair.generate().publicKey,
    workerAgentPda: Keypair.generate().publicKey,
  };
}

describe('validateProofPreconditions', () => {
  it('passes all checks for valid proof/task/claim/nullifier state', async () => {
    const harness = makeValidationHarness();
    const proof = makeProof();

    const result = await validateProofPreconditions(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
        proofGeneratedAtMs: Date.now() - 30_000,
      },
    );

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('fails proof_size when proofData length is invalid', async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({ proofData: makeBytes(10, 1) });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof,
    });
    expect(result.failures.some((f) => f.check === 'proof_size')).toBe(true);
  });

  it('fails binding_nonzero when expectedBinding is all zeros', async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({ expectedBinding: makeBytes(32, 0) });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof,
    });
    expect(result.failures.some((f) => f.check === 'binding_nonzero')).toBe(true);
  });

  it('fails commitment_nonzero when outputCommitment is all zeros', async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({ outputCommitment: makeBytes(32, 0) });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof,
    });
    expect(result.failures.some((f) => f.check === 'commitment_nonzero')).toBe(true);
  });

  it('fails nullifier_nonzero when nullifier is all zeros', async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({ nullifier: makeBytes(32, 0) });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof,
    });
    expect(result.failures.some((f) => f.check === 'nullifier_nonzero')).toBe(true);
  });

  it('fails proof_freshness when proof is stale', async () => {
    const harness = makeValidationHarness();
    const proof = makeProof();
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof,
      proofGeneratedAtMs: Date.now() - DEFAULT_MAX_PROOF_AGE_MS - 1000,
      maxProofAgeMs: DEFAULT_MAX_PROOF_AGE_MS,
    });
    expect(result.failures.some((f) => f.check === 'proof_freshness')).toBe(true);
  });

  it('emits proof_freshness warning when nearing expiry', async () => {
    const harness = makeValidationHarness();
    const proof = makeProof();
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof,
      proofGeneratedAtMs: Date.now() - Math.floor(DEFAULT_MAX_PROOF_AGE_MS * 0.81),
      maxProofAgeMs: DEFAULT_MAX_PROOF_AGE_MS,
    });
    expect(result.warnings.some((w) => w.check === 'proof_freshness')).toBe(true);
  });

  it('fails task_exists and returns early when task is missing', async () => {
    const harness = makeValidationHarness({ taskMissing: true });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof(),
    });
    expect(result.failures.some((f) => f.check === 'task_exists')).toBe(true);
  });

  it('fails task_in_progress when task is not in progress', async () => {
    const harness = makeValidationHarness({ taskState: { open: {} } });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof(),
    });
    expect(result.failures.some((f) => f.check === 'task_in_progress')).toBe(true);
  });

  it('fails task_is_private when task has no private constraint hash', async () => {
    const harness = makeValidationHarness({ privateTask: false });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof(),
    });
    expect(result.failures.some((f) => f.check === 'task_is_private')).toBe(true);
  });

  it('fails constraint_hash_match when proof hash differs from task hash', async () => {
    const harness = makeValidationHarness({ constraintHash: makeBytes(32, 9) });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof({ constraintHash: makeBytes(32, 1) }),
    });
    expect(result.failures.some((f) => f.check === 'constraint_hash_match')).toBe(true);
  });

  it('fails task_deadline when deadline has passed', async () => {
    const harness = makeValidationHarness({ deadline: Math.floor(Date.now() / 1000) - 1 });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof(),
    });
    expect(result.failures.some((f) => f.check === 'task_deadline')).toBe(true);
  });

  it('fails competitive_not_won when competitive task already has completion', async () => {
    const harness = makeValidationHarness({ taskType: 2, completions: 1 });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof(),
    });
    expect(result.failures.some((f) => f.check === 'competitive_not_won')).toBe(true);
  });

  it('fails claim_exists when claim account is missing', async () => {
    const harness = makeValidationHarness({ claimMissing: true });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof(),
    });
    expect(result.failures.some((f) => f.check === 'claim_exists')).toBe(true);
  });

  it('fails claim_not_expired when claim is expired', async () => {
    const harness = makeValidationHarness({ claimExpiresAt: Math.floor(Date.now() / 1000) - 10 });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof(),
    });
    expect(result.failures.some((f) => f.check === 'claim_not_expired')).toBe(true);
  });

  it('fails nullifier_not_spent when nullifier account exists', async () => {
    const harness = makeValidationHarness({ nullifierSpent: true });
    const result = await validateProofPreconditions(harness.connection as any, harness.program, {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof(),
    });
    expect(result.failures.some((f) => f.check === 'nullifier_not_spent')).toBe(true);
  });
});

describe('NullifierCache', () => {
  it('isUsed returns false for unseen nullifier', () => {
    const cache = new NullifierCache();
    expect(cache.isUsed(makeBytes(32, 1))).toBe(false);
  });

  it('markUsed then isUsed returns true', () => {
    const cache = new NullifierCache();
    const n = makeBytes(32, 2);
    cache.markUsed(n);
    expect(cache.isUsed(n)).toBe(true);
  });

  it('evicts least recently used entry at maxSize', () => {
    const cache = new NullifierCache(2);
    const a = makeBytes(32, 1);
    const b = makeBytes(32, 2);
    const c = makeBytes(32, 3);

    cache.markUsed(a);
    cache.markUsed(b);
    expect(cache.isUsed(a)).toBe(true); // touch a, b becomes LRU

    cache.markUsed(c); // evict b

    expect(cache.isUsed(a)).toBe(true);
    expect(cache.isUsed(b)).toBe(false);
    expect(cache.isUsed(c)).toBe(true);
  });

  it('clear removes all entries', () => {
    const cache = new NullifierCache();
    cache.markUsed(makeBytes(32, 8));
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('completeTaskPrivateSafe', () => {
  it('rejects when nullifier was already submitted in local cache', async () => {
    const cache = new NullifierCache();
    const proof = makeProof();
    cache.markUsed(proof.nullifier);

    await expect(
      completeTaskPrivateSafe(
        { confirmTransaction: vi.fn(), getAccountInfo: vi.fn() } as any,
        {} as Program,
        Keypair.generate(),
        makeBytes(32, 5),
        Keypair.generate().publicKey,
        proof,
        { nullifierCache: cache, validatePreconditions: false },
      ),
    ).rejects.toThrow('Nullifier already submitted in this session');
  });

  it('throws ProofPreconditionError when validation fails', async () => {
    const harness = makeValidationHarness({ taskMissing: true });

    await expect(
      completeTaskPrivateSafe(
        harness.connection as any,
        harness.program,
        Keypair.generate(),
        makeBytes(32, 5),
        harness.taskPda,
        makeProof(),
      ),
    ).rejects.toBeInstanceOf(ProofPreconditionError);
  });

  it('submits successfully with validatePreconditions=false and marks cache', async () => {
    const harness = makeValidationHarness();
    const cache = new NullifierCache();
    const proof = makeProof();

    const result = await completeTaskPrivateSafe(
      harness.connection as any,
      harness.program,
      Keypair.generate(),
      makeBytes(32, 5),
      harness.taskPda,
      proof,
      {
        validatePreconditions: false,
        nullifierCache: cache,
      },
    );

    expect(result.txSignature).toBe('tx-sig');
    expect(cache.isUsed(proof.nullifier)).toBe(true);
  });
});
