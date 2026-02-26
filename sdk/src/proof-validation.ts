import { Connection, PublicKey } from "@solana/web3.js";
import { type Program } from "@coral-xyz/anchor";
import {
  HASH_SIZE,
  RISC0_IMAGE_ID_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_SEAL_BORSH_LEN,
  RISC0_SELECTOR_LEN,
  TRUSTED_RISC0_IMAGE_ID,
  TRUSTED_RISC0_SELECTOR,
} from "./constants";
import {
  getTask,
  deriveClaimPda,
  TaskState,
  type PrivateCompletionPayload,
} from "./tasks";
import { getAccount } from "./anchor-utils";

const BINDING_SPEND_SEED = Buffer.from("binding_spend");
const NULLIFIER_SPEND_SEED = Buffer.from("nullifier_spend");
const JOURNAL_TASK_OFFSET = 0;
const JOURNAL_AUTHORITY_OFFSET = 32;
const JOURNAL_CONSTRAINT_OFFSET = 64;
const JOURNAL_COMMITMENT_OFFSET = 96;
const JOURNAL_BINDING_OFFSET = 128;
const JOURNAL_NULLIFIER_OFFSET = 160;
const JOURNAL_MODEL_COMMITMENT_OFFSET = 192;
const JOURNAL_INPUT_COMMITMENT_OFFSET = 224;

interface ParsedPrivateJournal {
  taskPda: Uint8Array;
  agentAuthority: Uint8Array;
  constraintHash: Uint8Array;
  outputCommitment: Uint8Array;
  binding: Uint8Array;
  nullifier: Uint8Array;
  modelCommitment: Uint8Array;
  inputCommitment: Uint8Array;
}

/**
 * Result of best-effort client-side checks before submitting `completeTaskPrivate`.
 * These checks reduce avoidable RPC failures but do not verify ZK proof validity.
 */
export interface ProofSubmissionPreflightResult {
  valid: boolean;
  failures: ProofSubmissionPreflightFailure[];
  warnings: ProofSubmissionPreflightWarning[];
}

export interface ProofSubmissionPreflightFailure {
  check: string;
  message: string;
  retriable: boolean;
}

export interface ProofSubmissionPreflightWarning {
  check: string;
  message: string;
}

/**
 * Input parameters for proof submission preflight.
 */
export interface ProofSubmissionPreflightParams {
  taskPda: PublicKey;
  workerAgentPda: PublicKey;
  authorityPubkey?: PublicKey;
  proof: Pick<
    PrivateCompletionPayload,
    "sealBytes" | "journal" | "imageId" | "bindingSeed" | "nullifierSeed"
  >;
  proofGeneratedAtMs?: number;
  maxProofAgeMs?: number;
}

/**
 * @deprecated Since v1.6.0. Use {@link ProofSubmissionPreflightResult} instead.
 */
export type ProofPreconditionResult = ProofSubmissionPreflightResult;

/**
 * @deprecated Since v1.6.0. Use {@link ProofSubmissionPreflightFailure} instead.
 */
export type ProofPreconditionFailure = ProofSubmissionPreflightFailure;

/**
 * @deprecated Since v1.6.0. Use {@link ProofSubmissionPreflightWarning} instead.
 */
export type ProofPreconditionWarning = ProofSubmissionPreflightWarning;

/**
 * @deprecated Since v1.6.0. Use {@link ProofSubmissionPreflightParams} instead.
 */
export type ValidateProofParams = ProofSubmissionPreflightParams;

export const DEFAULT_MAX_PROOF_AGE_MS = 5 * 60 * 1_000;

function toBytes(value: Uint8Array | Buffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function isAllZeros(value: Uint8Array | Buffer): boolean {
  return toBytes(value).every((b) => b === 0);
}

/**
 * Minimum distinct byte values required in a 32-byte seed.
 * SHA-256 outputs average ~28 distinct values; 8 is a conservative floor
 * that rejects constant-fill, short-period, and arithmetic-sequence patterns.
 * Must match MIN_DISTINCT_BYTES in complete_task_private.rs.
 */
const MIN_DISTINCT_BYTES = 8;

function hasSufficientByteDiversity(value: Uint8Array | Buffer): boolean {
  const bytes = toBytes(value);
  const seen = new Set<number>();
  for (const b of bytes) {
    seen.add(b);
    if (seen.size >= MIN_DISTINCT_BYTES) return true;
  }
  return false;
}

function bytesEqual(a: Uint8Array | Buffer, b: Uint8Array | Buffer): boolean {
  const ab = toBytes(a);
  const bb = toBytes(b);
  if (ab.length !== bb.length) return false;
  for (let i = 0; i < ab.length; i++) {
    if (ab[i] !== bb[i]) return false;
  }
  return true;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}

function readJournalField(journal: Uint8Array, offset: number): Uint8Array {
  return journal.slice(offset, offset + HASH_SIZE);
}

function parsePrivateJournal(journal: Uint8Array): ParsedPrivateJournal {
  return {
    taskPda: readJournalField(journal, JOURNAL_TASK_OFFSET),
    agentAuthority: readJournalField(journal, JOURNAL_AUTHORITY_OFFSET),
    constraintHash: readJournalField(journal, JOURNAL_CONSTRAINT_OFFSET),
    outputCommitment: readJournalField(journal, JOURNAL_COMMITMENT_OFFSET),
    binding: readJournalField(journal, JOURNAL_BINDING_OFFSET),
    nullifier: readJournalField(journal, JOURNAL_NULLIFIER_OFFSET),
    modelCommitment: readJournalField(journal, JOURNAL_MODEL_COMMITMENT_OFFSET),
    inputCommitment: readJournalField(journal, JOURNAL_INPUT_COMMITMENT_OFFSET),
  };
}

export async function runProofSubmissionPreflight(
  connection: Connection,
  program: Program,
  params: ProofSubmissionPreflightParams,
): Promise<ProofSubmissionPreflightResult> {
  const failures: ProofSubmissionPreflightFailure[] = [];
  const warnings: ProofSubmissionPreflightWarning[] = [];

  const sealBytes = toBytes(params.proof.sealBytes);
  const journalBytes = toBytes(params.proof.journal);
  const imageId = toBytes(params.proof.imageId);
  const bindingSeed = toBytes(params.proof.bindingSeed);
  const nullifierSeed = toBytes(params.proof.nullifierSeed);

  if (sealBytes.length !== RISC0_SEAL_BORSH_LEN) {
    failures.push({
      check: "seal_length",
      message: `sealBytes must be ${RISC0_SEAL_BORSH_LEN} bytes, got ${sealBytes.length}`,
      retriable: false,
    });
  } else {
    const selector = sealBytes.subarray(0, RISC0_SELECTOR_LEN);
    if (!bytesEqual(selector, TRUSTED_RISC0_SELECTOR)) {
      failures.push({
        check: "trusted_selector",
        message: "sealBytes selector does not match trusted selector",
        retriable: false,
      });
    }
  }

  if (journalBytes.length !== RISC0_JOURNAL_LEN) {
    failures.push({
      check: "journal_length",
      message: `journal must be ${RISC0_JOURNAL_LEN} bytes, got ${journalBytes.length}`,
      retriable: false,
    });
  }

  if (imageId.length !== RISC0_IMAGE_ID_LEN) {
    failures.push({
      check: "image_id_length",
      message: `imageId must be ${RISC0_IMAGE_ID_LEN} bytes, got ${imageId.length}`,
      retriable: false,
    });
  } else if (!bytesEqual(imageId, TRUSTED_RISC0_IMAGE_ID)) {
    failures.push({
      check: "trusted_image_id",
      message: "imageId does not match trusted image ID",
      retriable: false,
    });
  }

  if (bindingSeed.length !== HASH_SIZE) {
    failures.push({
      check: "binding_seed_length",
      message: `bindingSeed must be ${HASH_SIZE} bytes, got ${bindingSeed.length}`,
      retriable: false,
    });
  }

  if (nullifierSeed.length !== HASH_SIZE) {
    failures.push({
      check: "nullifier_seed_length",
      message: `nullifierSeed must be ${HASH_SIZE} bytes, got ${nullifierSeed.length}`,
      retriable: false,
    });
  }

  let journal: ParsedPrivateJournal | null = null;
  if (journalBytes.length === RISC0_JOURNAL_LEN) {
    journal = parsePrivateJournal(journalBytes);

    if (isAllZeros(journal.outputCommitment)) {
      failures.push({
        check: "commitment_nonzero",
        message: "journal output commitment cannot be all zeros",
        retriable: false,
      });
    }

    if (isAllZeros(journal.binding)) {
      failures.push({
        check: "binding_nonzero",
        message: "journal binding cannot be all zeros",
        retriable: false,
      });
    }

    if (isAllZeros(journal.nullifier)) {
      failures.push({
        check: "nullifier_nonzero",
        message: "journal nullifier cannot be all zeros",
        retriable: false,
      });
    }

    if (
      !isAllZeros(journal.binding) &&
      !hasSufficientByteDiversity(journal.binding)
    ) {
      failures.push({
        check: "binding_entropy",
        message: `journal binding has insufficient byte diversity (min ${MIN_DISTINCT_BYTES} distinct byte values required)`,
        retriable: false,
      });
    }

    if (
      !isAllZeros(journal.nullifier) &&
      !hasSufficientByteDiversity(journal.nullifier)
    ) {
      failures.push({
        check: "nullifier_entropy",
        message: `journal nullifier has insufficient byte diversity (min ${MIN_DISTINCT_BYTES} distinct byte values required)`,
        retriable: false,
      });
    }

    if (!bytesEqual(journal.taskPda, params.taskPda.toBytes())) {
      failures.push({
        check: "journal_task_match",
        message: "journal task PDA does not match provided task PDA",
        retriable: false,
      });
    }

    if (
      params.authorityPubkey &&
      !bytesEqual(journal.agentAuthority, params.authorityPubkey.toBytes())
    ) {
      failures.push({
        check: "journal_authority_match",
        message: "journal authority does not match submitting authority",
        retriable: false,
      });
    }

    if (
      bindingSeed.length === HASH_SIZE &&
      !bytesEqual(journal.binding, bindingSeed)
    ) {
      failures.push({
        check: "binding_seed_match",
        message: "journal binding does not match bindingSeed",
        retriable: false,
      });
    }

    if (
      nullifierSeed.length === HASH_SIZE &&
      !bytesEqual(journal.nullifier, nullifierSeed)
    ) {
      failures.push({
        check: "nullifier_seed_match",
        message: "journal nullifier does not match nullifierSeed",
        retriable: false,
      });
    }
  }

  if (params.proofGeneratedAtMs !== undefined) {
    const maxAge = params.maxProofAgeMs ?? DEFAULT_MAX_PROOF_AGE_MS;
    const age = Date.now() - params.proofGeneratedAtMs;

    if (age > maxAge) {
      failures.push({
        check: "proof_freshness",
        message: `Proof is ${Math.floor(age / 1000)}s old, max allowed is ${Math.floor(maxAge / 1000)}s`,
        retriable: false,
      });
    } else if (age > maxAge * 0.8) {
      warnings.push({
        check: "proof_freshness",
        message: `Proof is ${Math.floor(age / 1000)}s old, approaching expiry at ${Math.floor(maxAge / 1000)}s`,
      });
    }
  }

  const task = await getTask(program, params.taskPda);
  if (!task) {
    failures.push({
      check: "task_exists",
      message: "Task account not found",
      retriable: false,
    });

    return { valid: false, failures, warnings };
  }

  if (task.state !== TaskState.InProgress) {
    failures.push({
      check: "task_in_progress",
      message: `Task is in state ${task.state}, expected InProgress (1)`,
      retriable: false,
    });
  }

  if (!task.constraintHash || isAllZeros(task.constraintHash)) {
    failures.push({
      check: "task_is_private",
      message: "Task has no constraint hash and is not private",
      retriable: false,
    });
  } else if (
    journal &&
    !bytesEqual(task.constraintHash, journal.constraintHash)
  ) {
    failures.push({
      check: "constraint_hash_match",
      message: "Journal constraint hash does not match task constraint hash",
      retriable: false,
    });
  }

  if (task.deadline > 0) {
    const now = Math.floor(Date.now() / 1000);

    if (now > task.deadline) {
      failures.push({
        check: "task_deadline",
        message: `Task deadline passed (${task.deadline}), current time is ${now}`,
        retriable: false,
      });
    } else if (task.deadline - now < 60) {
      warnings.push({
        check: "task_deadline",
        message: `Task deadline is in ${task.deadline - now}s and may expire before confirmation`,
      });
    }
  }

  const rawTask = (await getAccount(program, "task").fetch(params.taskPda)) as {
    taskType?: number;
    task_type?: number;
    completions?: number;
  };

  const taskType = toNumber(rawTask.taskType ?? rawTask.task_type);
  const completions = toNumber(rawTask.completions);
  if (taskType === 2 && completions > 0) {
    failures.push({
      check: "competitive_not_won",
      message: "Competitive task already completed by another worker",
      retriable: false,
    });
  }

  const claimPda = deriveClaimPda(
    params.taskPda,
    params.workerAgentPda,
    program.programId,
  );
  try {
    const claim = (await getAccount(program, "taskClaim").fetch(claimPda)) as {
      completed?: boolean;
      isCompleted?: boolean;
      is_completed?: boolean;
      expiresAt?: { toNumber: () => number };
      expires_at?: { toNumber: () => number };
    };

    const isCompleted = Boolean(
      claim.completed ?? claim.isCompleted ?? claim.is_completed ?? false,
    );
    if (isCompleted) {
      failures.push({
        check: "claim_not_completed",
        message: "Claim is already completed",
        retriable: false,
      });
    }

    const expiresAt = toNumber(claim.expiresAt ?? claim.expires_at);
    if (expiresAt > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (now > expiresAt) {
        failures.push({
          check: "claim_not_expired",
          message: `Claim expired at ${expiresAt}, current time is ${now}`,
          retriable: false,
        });
      }
    }
  } catch {
    failures.push({
      check: "claim_exists",
      message: "Claim account not found for worker/task pair",
      retriable: false,
    });
  }

  if (bindingSeed.length === HASH_SIZE) {
    const [bindingSpendPda] = PublicKey.findProgramAddressSync(
      [BINDING_SPEND_SEED, bindingSeed],
      program.programId,
    );
    const bindingSpendInfo = await connection.getAccountInfo(bindingSpendPda);
    if (bindingSpendInfo !== null) {
      failures.push({
        check: "binding_not_spent",
        message: "Binding has already been spent",
        retriable: false,
      });
    }
  }

  if (nullifierSeed.length === HASH_SIZE) {
    const [nullifierSpendPda] = PublicKey.findProgramAddressSync(
      [NULLIFIER_SPEND_SEED, nullifierSeed],
      program.programId,
    );
    const nullifierSpendInfo =
      await connection.getAccountInfo(nullifierSpendPda);
    if (nullifierSpendInfo !== null) {
      failures.push({
        check: "nullifier_not_spent",
        message: "Nullifier has already been spent",
        retriable: false,
      });
    }
  }

  return {
    valid: failures.length === 0,
    failures,
    warnings,
  };
}

/**
 * @deprecated Since v1.6.0. Use {@link runProofSubmissionPreflight} instead.
 */
export async function validateProofPreconditions(
  connection: Connection,
  program: Program,
  params: ValidateProofParams,
): Promise<ProofPreconditionResult> {
  return runProofSubmissionPreflight(connection, program, params);
}
