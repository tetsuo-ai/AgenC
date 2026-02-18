import { Connection, PublicKey } from '@solana/web3.js';
import { type Program } from '@coral-xyz/anchor';
import { PROOF_SIZE_BYTES, SEEDS } from './constants';
import { getTask, deriveClaimPda, TaskState, type PrivateCompletionProof } from './tasks';
import { getAccount } from './anchor-utils';

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
  proof: Pick<
    PrivateCompletionProof,
    'constraintHash' | 'outputCommitment' | 'expectedBinding' | 'nullifier' | 'proofData'
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
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}

export async function runProofSubmissionPreflight(
  connection: Connection,
  program: Program,
  params: ProofSubmissionPreflightParams,
): Promise<ProofSubmissionPreflightResult> {
  const failures: ProofSubmissionPreflightFailure[] = [];
  const warnings: ProofSubmissionPreflightWarning[] = [];

  const proofData = toBytes(params.proof.proofData);
  const expectedBinding = toBytes(params.proof.expectedBinding);
  const outputCommitment = toBytes(params.proof.outputCommitment);
  const nullifier = toBytes(params.proof.nullifier);
  const constraintHash = toBytes(params.proof.constraintHash);

  if (proofData.length !== PROOF_SIZE_BYTES) {
    failures.push({
      check: 'proof_size',
      message: `Proof data must be ${PROOF_SIZE_BYTES} bytes, got ${proofData.length}`,
      retriable: false,
    });
  }

  if (isAllZeros(expectedBinding)) {
    failures.push({
      check: 'binding_nonzero',
      message: 'expectedBinding cannot be all zeros',
      retriable: false,
    });
  }

  if (isAllZeros(outputCommitment)) {
    failures.push({
      check: 'commitment_nonzero',
      message: 'outputCommitment cannot be all zeros',
      retriable: false,
    });
  }

  if (isAllZeros(nullifier)) {
    failures.push({
      check: 'nullifier_nonzero',
      message: 'nullifier cannot be all zeros',
      retriable: false,
    });
  }

  if (params.proofGeneratedAtMs !== undefined) {
    const maxAge = params.maxProofAgeMs ?? DEFAULT_MAX_PROOF_AGE_MS;
    const age = Date.now() - params.proofGeneratedAtMs;

    if (age > maxAge) {
      failures.push({
        check: 'proof_freshness',
        message: `Proof is ${Math.floor(age / 1000)}s old, max allowed is ${Math.floor(maxAge / 1000)}s`,
        retriable: false,
      });
    } else if (age > maxAge * 0.8) {
      warnings.push({
        check: 'proof_freshness',
        message: `Proof is ${Math.floor(age / 1000)}s old, approaching expiry at ${Math.floor(maxAge / 1000)}s`,
      });
    }
  }

  const task = await getTask(program, params.taskPda);
  if (!task) {
    failures.push({
      check: 'task_exists',
      message: 'Task account not found',
      retriable: false,
    });

    return { valid: false, failures, warnings };
  }

  if (task.state !== TaskState.InProgress) {
    failures.push({
      check: 'task_in_progress',
      message: `Task is in state ${task.state}, expected InProgress (1)`,
      retriable: false,
    });
  }

  if (!task.constraintHash || isAllZeros(task.constraintHash)) {
    failures.push({
      check: 'task_is_private',
      message: 'Task has no constraint hash and is not private',
      retriable: false,
    });
  } else if (!bytesEqual(task.constraintHash, constraintHash)) {
    failures.push({
      check: 'constraint_hash_match',
      message: 'Proof constraint hash does not match task constraint hash',
      retriable: false,
    });
  }

  if (task.deadline > 0) {
    const now = Math.floor(Date.now() / 1000);

    if (now > task.deadline) {
      failures.push({
        check: 'task_deadline',
        message: `Task deadline passed (${task.deadline}), current time is ${now}`,
        retriable: false,
      });
    } else if (task.deadline - now < 60) {
      warnings.push({
        check: 'task_deadline',
        message: `Task deadline is in ${task.deadline - now}s and may expire before confirmation`,
      });
    }
  }

  const rawTask = await getAccount(program, 'task').fetch(params.taskPda) as {
    taskType?: number;
    task_type?: number;
    completions?: number;
  };

  const taskType = toNumber(rawTask.taskType ?? rawTask.task_type);
  const completions = toNumber(rawTask.completions);
  if (taskType === 2 && completions > 0) {
    failures.push({
      check: 'competitive_not_won',
      message: 'Competitive task already completed by another worker',
      retriable: false,
    });
  }

  const claimPda = deriveClaimPda(params.taskPda, params.workerAgentPda, program.programId);
  try {
    const claim = await getAccount(program, 'taskClaim').fetch(claimPda) as {
      completed?: boolean;
      isCompleted?: boolean;
      is_completed?: boolean;
      expiresAt?: { toNumber: () => number };
      expires_at?: { toNumber: () => number };
    };

    const isCompleted = Boolean(claim.completed ?? claim.isCompleted ?? claim.is_completed ?? false);
    if (isCompleted) {
      failures.push({
        check: 'claim_not_completed',
        message: 'Claim is already completed',
        retriable: false,
      });
    }

    const expiresAt = toNumber(claim.expiresAt ?? claim.expires_at);
    if (expiresAt > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (now > expiresAt) {
        failures.push({
          check: 'claim_not_expired',
          message: `Claim expired at ${expiresAt}, current time is ${now}`,
          retriable: false,
        });
      }
    }
  } catch {
    failures.push({
      check: 'claim_exists',
      message: 'Claim account not found for worker/task pair',
      retriable: false,
    });
  }

  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [SEEDS.NULLIFIER, nullifier],
    program.programId,
  );
  const nullifierInfo = await connection.getAccountInfo(nullifierPda);
  if (nullifierInfo !== null) {
    failures.push({
      check: 'nullifier_not_spent',
      message: 'Nullifier has already been spent',
      retriable: false,
    });
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
