import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import {
  runProofSubmissionPreflight,
  validateProofPreconditions,
  DEFAULT_MAX_PROOF_AGE_MS,
} from "../proof-validation";
import { NullifierCache } from "../nullifier-cache";
import {
  completeTaskPrivateWithPreflight,
  completeTaskPrivateSafe,
  type PrivateCompletionPayload,
  ProofSubmissionPreflightError,
  ProofPreconditionError,
} from "../tasks";
import {
  PROGRAM_ID,
  RISC0_IMAGE_ID_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_SEAL_BORSH_LEN,
  TRUSTED_RISC0_IMAGE_ID,
  TRUSTED_RISC0_SELECTOR,
} from "../constants";

function bnLike(value: number) {
  return {
    toNumber: () => value,
    toString: () => String(value),
  };
}

function makeBytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** Build a Uint8Array with high byte diversity (sequential bytes offset by base). */
function makeDiverseBytes(length: number, base: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (base + i) & 0xff;
  }
  return out;
}

function makeJournal(fields: {
  taskPda: Uint8Array;
  authority: Uint8Array;
  constraintHash: Uint8Array;
  outputCommitment: Uint8Array;
  binding: Uint8Array;
  nullifier: Uint8Array;
  modelCommitment?: Uint8Array;
  inputCommitment?: Uint8Array;
}): Uint8Array {
  const out = new Uint8Array(RISC0_JOURNAL_LEN);
  out.set(fields.taskPda, 0);
  out.set(fields.authority, 32);
  out.set(fields.constraintHash, 64);
  out.set(fields.outputCommitment, 96);
  out.set(fields.binding, 128);
  out.set(fields.nullifier, 160);
  if (fields.modelCommitment) out.set(fields.modelCommitment, 192);
  if (fields.inputCommitment) out.set(fields.inputCommitment, 224);
  return out;
}

function makeProof(
  overrides: Partial<PrivateCompletionPayload> & {
    taskPda?: PublicKey;
    authorityPubkey?: PublicKey;
    constraintHash?: Uint8Array;
    outputCommitment?: Uint8Array;
    bindingFromJournal?: Uint8Array;
    nullifierFromJournal?: Uint8Array;
    sealSelector?: Uint8Array;
    sealBytesLen?: number;
    journalLen?: number;
    imageIdBytes?: Uint8Array;
  } = {},
): PrivateCompletionPayload {
  const taskPda = overrides.taskPda ?? Keypair.generate().publicKey;
  const authorityPubkey =
    overrides.authorityPubkey ?? Keypair.generate().publicKey;
  const constraintHash = overrides.constraintHash ?? makeBytes(32, 1);
  const outputCommitment = overrides.outputCommitment ?? makeBytes(32, 2);
  const bindingSeed = overrides.bindingSeed ?? makeDiverseBytes(32, 170);
  const nullifierSeed = overrides.nullifierSeed ?? makeDiverseBytes(32, 210);
  const bindingFromJournal =
    overrides.bindingFromJournal ?? Uint8Array.from(bindingSeed);
  const nullifierFromJournal =
    overrides.nullifierFromJournal ?? Uint8Array.from(nullifierSeed);

  const sealSelector = overrides.sealSelector ?? TRUSTED_RISC0_SELECTOR;
  const sealBytesLen = overrides.sealBytesLen ?? RISC0_SEAL_BORSH_LEN;
  const sealBytes = makeBytes(sealBytesLen, 7);
  if (sealBytes.length >= TRUSTED_RISC0_SELECTOR.length) {
    sealBytes.set(sealSelector, 0);
  }

  const journalLen = overrides.journalLen ?? RISC0_JOURNAL_LEN;
  const journal = makeBytes(journalLen, 9);
  if (journal.length === RISC0_JOURNAL_LEN) {
    journal.set(
      makeJournal({
        taskPda: taskPda.toBytes(),
        authority: authorityPubkey.toBytes(),
        constraintHash,
        outputCommitment,
        binding: bindingFromJournal,
        nullifier: nullifierFromJournal,
      }),
      0,
    );
  }

  return {
    sealBytes,
    journal,
    imageId: overrides.imageIdBytes ?? TRUSTED_RISC0_IMAGE_ID,
    bindingSeed,
    nullifierSeed,
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
  bindingSpent?: boolean;
  nullifierSpent?: boolean;
}) {
  const now = Math.floor(Date.now() / 1000);
  const creator = Keypair.generate().publicKey;
  const authorityPubkey = Keypair.generate().publicKey;

  const taskFetch = options?.taskMissing
    ? vi.fn().mockRejectedValue(new Error("Account does not exist"))
    : vi.fn().mockResolvedValue({
        taskId: makeBytes(32, 9),
        status: options?.taskState ?? { inProgress: {} },
        creator,
        rewardAmount: { toString: () => "1000" },
        deadline: bnLike(options?.deadline ?? now + 600),
        constraintHash:
          options?.privateTask === false
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
    ? vi.fn().mockRejectedValue(new Error("claim missing"))
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
          preInstructions: vi.fn().mockReturnValue({
            signers: vi.fn().mockReturnValue({
              rpc: vi.fn().mockResolvedValue("tx-sig"),
            }),
          }),
        }),
      }),
    },
  } as unknown as Program;

  let callIndex = 0;
  const connection = {
    getAccountInfo: vi.fn().mockImplementation(async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return options?.bindingSpent ? { data: Buffer.alloc(0) } : null;
      }
      if (callIndex === 2) {
        return options?.nullifierSpent ? { data: Buffer.alloc(0) } : null;
      }
      return null;
    }),
    confirmTransaction: vi.fn().mockResolvedValue(undefined),
  };

  return {
    program,
    connection,
    taskPda: Keypair.generate().publicKey,
    workerAgentPda: Keypair.generate().publicKey,
    authorityPubkey,
  };
}

describe("runProofSubmissionPreflight", () => {
  it("passes all checks for valid proof/task/claim/spend state", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: harness.taskPda,
      authorityPubkey: harness.authorityPubkey,
    });

    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        authorityPubkey: harness.authorityPubkey,
        proof,
        proofGeneratedAtMs: Date.now() - 30_000,
      },
    );

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("fails seal_length when sealBytes length is invalid", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({ sealBytesLen: 10, taskPda: harness.taskPda });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "seal_length")).toBe(true);
  });

  it("fails trusted_selector when selector is not trusted", async () => {
    const harness = makeValidationHarness();
    const badSelector = Uint8Array.from(TRUSTED_RISC0_SELECTOR);
    badSelector[0] ^= 1;
    const proof = makeProof({
      taskPda: harness.taskPda,
      sealSelector: badSelector,
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "trusted_selector")).toBe(
      true,
    );
  });

  it("fails journal_length when journal size is invalid", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({ journalLen: 10, taskPda: harness.taskPda });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "journal_length")).toBe(
      true,
    );
  });

  it("fails image_id_length when imageId length is invalid", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: harness.taskPda,
      imageIdBytes: makeBytes(10, 1),
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "image_id_length")).toBe(
      true,
    );
  });

  it("fails trusted_image_id when imageId differs from trusted ID", async () => {
    const harness = makeValidationHarness();
    const imageId = Uint8Array.from(TRUSTED_RISC0_IMAGE_ID);
    imageId[0] ^= 1;
    const proof = makeProof({
      taskPda: harness.taskPda,
      imageIdBytes: imageId,
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "trusted_image_id")).toBe(
      true,
    );
  });

  it("fails binding_nonzero when journal binding is all zeros", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: harness.taskPda,
      bindingFromJournal: makeBytes(32, 0),
      bindingSeed: makeBytes(32, 0),
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "binding_nonzero")).toBe(
      true,
    );
  });

  it("fails commitment_nonzero when journal output commitment is all zeros", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: harness.taskPda,
      outputCommitment: makeBytes(32, 0),
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "commitment_nonzero")).toBe(
      true,
    );
  });

  it("fails nullifier_nonzero when journal nullifier is all zeros", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: harness.taskPda,
      nullifierFromJournal: makeBytes(32, 0),
      nullifierSeed: makeBytes(32, 0),
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "nullifier_nonzero")).toBe(
      true,
    );
  });

  it("fails binding_entropy when journal binding has low byte diversity", async () => {
    const harness = makeValidationHarness();
    const lowEntropy = makeBytes(32, 0xaa); // constant fill = 1 distinct byte
    const proof = makeProof({
      taskPda: harness.taskPda,
      bindingFromJournal: lowEntropy,
      bindingSeed: lowEntropy,
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "binding_entropy")).toBe(
      true,
    );
  });

  it("fails nullifier_entropy when journal nullifier has low byte diversity", async () => {
    const harness = makeValidationHarness();
    const lowEntropy = makeBytes(32, 0xbb); // constant fill
    const proof = makeProof({
      taskPda: harness.taskPda,
      nullifierFromJournal: lowEntropy,
      nullifierSeed: lowEntropy,
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "nullifier_entropy")).toBe(
      true,
    );
  });

  it("passes entropy check for diverse binding/nullifier", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: harness.taskPda,
      bindingSeed: makeDiverseBytes(32, 100),
      bindingFromJournal: makeDiverseBytes(32, 100),
      nullifierSeed: makeDiverseBytes(32, 200),
      nullifierFromJournal: makeDiverseBytes(32, 200),
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "binding_entropy")).toBe(
      false,
    );
    expect(result.failures.some((f) => f.check === "nullifier_entropy")).toBe(
      false,
    );
  });

  it("fails binding_seed_match when journal binding differs from bindingSeed", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: harness.taskPda,
      bindingFromJournal: makeDiverseBytes(32, 80),
      bindingSeed: makeDiverseBytes(32, 170),
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "binding_seed_match")).toBe(
      true,
    );
  });

  it("fails nullifier_seed_match when journal nullifier differs from nullifierSeed", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: harness.taskPda,
      nullifierFromJournal: makeBytes(32, 8),
      nullifierSeed: makeBytes(32, 4),
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(
      result.failures.some((f) => f.check === "nullifier_seed_match"),
    ).toBe(true);
  });

  it("fails journal_task_match when journal task PDA differs from supplied task", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: Keypair.generate().publicKey,
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
      },
    );
    expect(result.failures.some((f) => f.check === "journal_task_match")).toBe(
      true,
    );
  });

  it("fails journal_authority_match when journal authority differs from signer authority", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({
      taskPda: harness.taskPda,
      authorityPubkey: Keypair.generate().publicKey,
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        authorityPubkey: harness.authorityPubkey,
        proof,
      },
    );
    expect(
      result.failures.some((f) => f.check === "journal_authority_match"),
    ).toBe(true);
  });

  it("fails proof_freshness when proof is stale", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({ taskPda: harness.taskPda });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
        proofGeneratedAtMs: Date.now() - DEFAULT_MAX_PROOF_AGE_MS - 1000,
        maxProofAgeMs: DEFAULT_MAX_PROOF_AGE_MS,
      },
    );
    expect(result.failures.some((f) => f.check === "proof_freshness")).toBe(
      true,
    );
  });

  it("emits proof_freshness warning when nearing expiry", async () => {
    const harness = makeValidationHarness();
    const proof = makeProof({ taskPda: harness.taskPda });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof,
        proofGeneratedAtMs:
          Date.now() - Math.floor(DEFAULT_MAX_PROOF_AGE_MS * 0.81),
        maxProofAgeMs: DEFAULT_MAX_PROOF_AGE_MS,
      },
    );
    expect(result.warnings.some((w) => w.check === "proof_freshness")).toBe(
      true,
    );
  });

  it("fails task_exists and returns early when task is missing", async () => {
    const harness = makeValidationHarness({ taskMissing: true });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({ taskPda: harness.taskPda }),
      },
    );
    expect(result.failures.some((f) => f.check === "task_exists")).toBe(true);
  });

  it("fails task_in_progress when task is not in progress", async () => {
    const harness = makeValidationHarness({ taskState: { open: {} } });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({ taskPda: harness.taskPda }),
      },
    );
    expect(result.failures.some((f) => f.check === "task_in_progress")).toBe(
      true,
    );
  });

  it("fails task_is_private when task has no private constraint hash", async () => {
    const harness = makeValidationHarness({ privateTask: false });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({ taskPda: harness.taskPda }),
      },
    );
    expect(result.failures.some((f) => f.check === "task_is_private")).toBe(
      true,
    );
  });

  it("fails constraint_hash_match when journal hash differs from task hash", async () => {
    const harness = makeValidationHarness({ constraintHash: makeBytes(32, 9) });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({
          taskPda: harness.taskPda,
          constraintHash: makeBytes(32, 1),
        }),
      },
    );
    expect(
      result.failures.some((f) => f.check === "constraint_hash_match"),
    ).toBe(true);
  });

  it("fails task_deadline when deadline has passed", async () => {
    const harness = makeValidationHarness({
      deadline: Math.floor(Date.now() / 1000) - 1,
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({ taskPda: harness.taskPda }),
      },
    );
    expect(result.failures.some((f) => f.check === "task_deadline")).toBe(true);
  });

  it("fails competitive_not_won when competitive task already has completion", async () => {
    const harness = makeValidationHarness({ taskType: 2, completions: 1 });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({ taskPda: harness.taskPda }),
      },
    );
    expect(result.failures.some((f) => f.check === "competitive_not_won")).toBe(
      true,
    );
  });

  it("fails claim_exists when claim account is missing", async () => {
    const harness = makeValidationHarness({ claimMissing: true });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({ taskPda: harness.taskPda }),
      },
    );
    expect(result.failures.some((f) => f.check === "claim_exists")).toBe(true);
  });

  it("fails claim_not_expired when claim is expired", async () => {
    const harness = makeValidationHarness({
      claimExpiresAt: Math.floor(Date.now() / 1000) - 10,
    });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({ taskPda: harness.taskPda }),
      },
    );
    expect(result.failures.some((f) => f.check === "claim_not_expired")).toBe(
      true,
    );
  });

  it("fails binding_not_spent when binding spend account already exists", async () => {
    const harness = makeValidationHarness({ bindingSpent: true });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({ taskPda: harness.taskPda }),
      },
    );
    expect(result.failures.some((f) => f.check === "binding_not_spent")).toBe(
      true,
    );
  });

  it("fails nullifier_not_spent when nullifier spend account already exists", async () => {
    const harness = makeValidationHarness({ nullifierSpent: true });
    const result = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      {
        taskPda: harness.taskPda,
        workerAgentPda: harness.workerAgentPda,
        proof: makeProof({ taskPda: harness.taskPda }),
      },
    );
    expect(result.failures.some((f) => f.check === "nullifier_not_spent")).toBe(
      true,
    );
  });

  it("keeps deprecated validateProofPreconditions wrapper behavior", async () => {
    const harness = makeValidationHarness({ taskMissing: true });
    const params = {
      taskPda: harness.taskPda,
      workerAgentPda: harness.workerAgentPda,
      proof: makeProof({ taskPda: harness.taskPda }),
    };

    const preflight = await runProofSubmissionPreflight(
      harness.connection as any,
      harness.program,
      params,
    );
    const deprecated = await validateProofPreconditions(
      harness.connection as any,
      harness.program,
      params,
    );

    expect(deprecated).toEqual(preflight);
  });
});

describe("NullifierCache", () => {
  it("isUsed returns false for unseen nullifier", () => {
    const cache = new NullifierCache();
    expect(cache.isUsed(makeBytes(32, 1))).toBe(false);
  });

  it("markUsed then isUsed returns true", () => {
    const cache = new NullifierCache();
    const n = makeBytes(32, 2);
    cache.markUsed(n);
    expect(cache.isUsed(n)).toBe(true);
  });

  it("evicts least recently used entry at maxSize", () => {
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

  it("clear removes all entries", () => {
    const cache = new NullifierCache();
    cache.markUsed(makeBytes(32, 8));
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("completeTaskPrivateWithPreflight", () => {
  it("rejects when nullifier was already submitted in local cache", async () => {
    const cache = new NullifierCache();
    const proof = makeProof();
    cache.markUsed(proof.nullifierSeed);

    await expect(
      completeTaskPrivateWithPreflight(
        { confirmTransaction: vi.fn(), getAccountInfo: vi.fn() } as any,
        {} as Program,
        Keypair.generate(),
        makeBytes(32, 5),
        Keypair.generate().publicKey,
        proof,
        { nullifierCache: cache, runProofSubmissionPreflight: false },
      ),
    ).rejects.toThrow("Nullifier already submitted in this session");
  });

  it("throws ProofSubmissionPreflightError when preflight fails", async () => {
    const harness = makeValidationHarness({ taskMissing: true });

    await expect(
      completeTaskPrivateWithPreflight(
        harness.connection as any,
        harness.program,
        Keypair.generate(),
        makeBytes(32, 5),
        harness.taskPda,
        makeProof({ taskPda: harness.taskPda }),
      ),
    ).rejects.toBeInstanceOf(ProofSubmissionPreflightError);
  });

  it("submits successfully with runProofSubmissionPreflight=false and marks cache", async () => {
    const harness = makeValidationHarness();
    const cache = new NullifierCache();
    const proof = makeProof({ taskPda: harness.taskPda });

    const result = await completeTaskPrivateWithPreflight(
      harness.connection as any,
      harness.program,
      Keypair.generate(),
      makeBytes(32, 5),
      harness.taskPda,
      proof,
      {
        runProofSubmissionPreflight: false,
        nullifierCache: cache,
      },
    );

    expect(result.txSignature).toBe("tx-sig");
    expect(result.preflightResult).toBeUndefined();
    expect(cache.isUsed(proof.nullifierSeed)).toBe(true);
  });
});

describe("completeTaskPrivateSafe (deprecated wrapper)", () => {
  it("throws ProofPreconditionError when validation fails", async () => {
    const harness = makeValidationHarness({ taskMissing: true });

    await expect(
      completeTaskPrivateSafe(
        harness.connection as any,
        harness.program,
        Keypair.generate(),
        makeBytes(32, 5),
        harness.taskPda,
        makeProof({ taskPda: harness.taskPda }),
      ),
    ).rejects.toBeInstanceOf(ProofPreconditionError);
  });

  it("supports validatePreconditions=false and preserves validationResult output", async () => {
    const harness = makeValidationHarness();
    const cache = new NullifierCache();
    const proof = makeProof({ taskPda: harness.taskPda });

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

    expect(result.txSignature).toBe("tx-sig");
    expect(result.validationResult).toBeUndefined();
    expect(cache.isUsed(proof.nullifierSeed)).toBe(true);
  });
});
