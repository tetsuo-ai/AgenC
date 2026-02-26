/**
 * RISC Zero private-proof payload helpers for AgenC SDK.
 *
 * Proof generation now emits the router payload shape:
 * - seal_bytes (260 bytes borsh envelope for trusted selector + RISC Zero Groth16 proof)
 * - journal (256 bytes fixed schema)
 * - image_id (32 bytes)
 * - binding_seed / nullifier_seed (32 bytes each)
 */

import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import type { ProverConfig } from "./prover.js";
import {
  HASH_SIZE,
  OUTPUT_FIELD_COUNT,
  RISC0_IMAGE_ID_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_SEAL_BORSH_LEN,
  RISC0_SELECTOR_LEN,
  TRUSTED_RISC0_IMAGE_ID,
  TRUSTED_RISC0_SELECTOR,
} from "./constants";

/** BN254 scalar field modulus */
export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Bits per byte for bit shifting */
const BITS_PER_BYTE = 8n;

const JOURNAL_FIELDS = 8;
const NULLIFIER_DOMAIN_TAG = Buffer.from("AGENC_V2_NULLIFIER", "utf8");
const CONSTRAINT_HASH_DOMAIN_TAG = Buffer.from(
  "AGENC_V2_CONSTRAINT_HASH",
  "utf8",
);
const OUTPUT_COMMITMENT_DOMAIN_TAG = Buffer.from(
  "AGENC_V2_OUTPUT_COMMITMENT",
  "utf8",
);
const BINDING_BASE_DOMAIN_TAG = Buffer.from("AGENC_V2_BINDING_BASE", "utf8");
const BINDING_DOMAIN_TAG = Buffer.from("AGENC_V2_BINDING", "utf8");
const MAX_U256 = (1n << 256n) - 1n;

/**
 * Result from computing hashes
 */
export interface HashResult {
  constraintHash: bigint;
  outputCommitment: bigint;
  binding: bigint;
  nullifier: bigint;
}

/**
 * Parameters for proof generation.
 */
export interface ProofGenerationParams {
  taskPda: PublicKey;
  agentPubkey: PublicKey;
  output: bigint[];
  salt: bigint;
  /**
   * Private witness for nullifier derivation.
   * SECURITY: Must be a secret known only to the agent. Using a predictable
   * value (e.g., derived from the public key) allows anyone to predict the
   * nullifier and front-run proof submissions.
   */
  agentSecret: bigint;
  /**
   * Optional image ID override. Must be exactly 32 bytes.
   * If omitted, uses the pinned trusted SDK value.
   */
  imageId?: Uint8Array | Buffer;
  /**
   * Optional selector override for local deterministic proving.
   * Must match the pinned trusted selector.
   */
  sealSelector?: Uint8Array | Buffer;
}

export interface ProofResult {
  /**
   * RISC0 payload (canonical target for submission).
   */
  sealBytes: Buffer;
  journal: Buffer;
  imageId: Buffer;
  bindingSeed: Buffer;
  nullifierSeed: Buffer;

  /**
   * Transitional aliases retained for existing callers.
   * These will be removed in a later migration step.
   */
  proof: Buffer;
  constraintHash: Buffer;
  outputCommitment: Buffer;
  binding: Buffer;
  nullifier: Buffer;
  proofSize: number;
  generationTime: number;
}

/**
 * Generate a cryptographically secure random salt for proof commitments.
 *
 * SECURITY: Each proof MUST use a fresh salt. Reusing salts across different
 * proofs with different outputs can leak information about the private outputs.
 *
 * @returns A random bigint in the BN254 scalar field [0, FIELD_MODULUS)
 */
export function generateSalt(): bigint {
  const bytes = new Uint8Array(HASH_SIZE);
  crypto.getRandomValues(bytes);
  let salt = 0n;
  for (const byte of bytes) {
    salt = (salt << BITS_PER_BYTE) | BigInt(byte);
  }
  return salt % FIELD_MODULUS;
}

/**
 * Convert a PublicKey to a field element.
 *
 * Interprets the 32-byte public key as a big-endian integer and reduces
 * it modulo the BN254 scalar field.
 *
 * @param pubkey - The public key to convert
 * @returns The field element representation
 */
export function pubkeyToField(pubkey: PublicKey): bigint {
  const bytes = pubkey.toBytes();
  let field = 0n;
  const BYTE_BASE = 256n;
  for (const byte of bytes) {
    field = (field * BYTE_BASE + BigInt(byte)) % FIELD_MODULUS;
  }
  return field;
}

/**
 * Compute the constraint hash from output values.
 *
 * @param output - Task output (4 field elements)
 * @returns The constraint hash
 */
export function computeConstraintHash(output: bigint[]): bigint {
  if (output.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(
      `Output must be exactly ${OUTPUT_FIELD_COUNT} field elements`,
    );
  }
  const reduced = output.map(normalizeFieldElement);
  return hashFieldElements(CONSTRAINT_HASH_DOMAIN_TAG, reduced);
}

function normalizeFieldElement(value: bigint): bigint {
  return ((value % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS;
}

function normalizeOutput(output: bigint[]): bigint[] {
  if (output.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(
      `Output must be exactly ${OUTPUT_FIELD_COUNT} field elements`,
    );
  }
  return output.map(normalizeFieldElement);
}

/**
 * Compute the output commitment from raw output values and salt.
 *
 * @param output - Task output (4 field elements)
 * @param salt - Random salt
 * @returns The output commitment
 */
export function computeCommitmentFromOutput(
  output: bigint[],
  salt: bigint,
): bigint {
  const normalizedOutput = normalizeOutput(output);
  const s = normalizeFieldElement(salt);
  return hashFieldElements(OUTPUT_COMMITMENT_DOMAIN_TAG, [
    normalizedOutput[0],
    normalizedOutput[1],
    normalizedOutput[2],
    normalizedOutput[3],
    s,
  ]);
}

/**
 * Compute the expected binding for proof verification.
 * Binding = hash(hash(task_id, agent_pubkey), output_commitment)
 *
 * @param taskPda - Task PDA
 * @param agentPubkey - Agent's public key
 * @param outputCommitment - The output commitment
 * @returns The expected binding
 */
export function computeBinding(
  taskPda: PublicKey,
  agentPubkey: PublicKey,
  outputCommitment: bigint,
): bigint {
  const taskField = pubkeyToField(taskPda);
  const agentField = pubkeyToField(agentPubkey);
  const bindingBase = hashFieldElements(BINDING_BASE_DOMAIN_TAG, [
    taskField,
    agentField,
  ]);
  const commitment = normalizeFieldElement(outputCommitment);
  return hashFieldElements(BINDING_DOMAIN_TAG, [bindingBase, commitment]);
}

export function computeNullifierFromAgentSecret(
  constraintHash: bigint,
  outputCommitment: bigint,
  agentSecret: bigint,
): bigint {
  const ch = normalizeFieldElement(constraintHash);
  const oc = normalizeFieldElement(outputCommitment);
  const secret = normalizeFieldElement(agentSecret);

  const digest = createHash("sha256")
    .update(NULLIFIER_DOMAIN_TAG)
    .update(bigintToBytes32(ch))
    .update(bigintToBytes32(oc))
    .update(bigintToBytes32(secret))
    .digest();

  return BigInt(`0x${digest.toString("hex")}`);
}

/**
 * Compute all hashes needed for proof generation.
 */
export function computeHashes(
  taskPda: PublicKey,
  agentPubkey: PublicKey,
  output: bigint[],
  salt: bigint,
  agentSecret: bigint,
): HashResult {
  const constraintHash = computeConstraintHash(output);
  const outputCommitment = computeCommitmentFromOutput(output, salt);
  const binding = computeBinding(taskPda, agentPubkey, outputCommitment);
  const nullifier = computeNullifierFromAgentSecret(
    constraintHash,
    outputCommitment,
    agentSecret,
  );

  return {
    constraintHash,
    outputCommitment,
    binding,
    nullifier,
  };
}

export function bigintToBytes32(value: bigint): Buffer {
  if (value < 0n || value > MAX_U256) {
    throw new Error("value must be in [0, 2^256 - 1]");
  }
  const hex = value.toString(16).padStart(HASH_SIZE * 2, "0");
  return Buffer.from(hex, "hex");
}

function hashFieldElements(domainTag: Buffer, values: bigint[]): bigint {
  const hasher = createHash("sha256");
  hasher.update(domainTag);
  for (const value of values) {
    hasher.update(bigintToBytes32(normalizeFieldElement(value)));
  }
  const digest = hasher.digest();
  return BigInt(`0x${digest.toString("hex")}`) % FIELD_MODULUS;
}

function assertByteLength(
  value: Uint8Array | Buffer,
  expected: number,
  label: string,
): void {
  if (value.length !== expected) {
    throw new Error(`${label} must be ${expected} bytes, got ${value.length}`);
  }
}

function copyFixedBytes(
  value: Uint8Array | Buffer,
  expected: number,
  label: string,
): Buffer {
  const out = Buffer.from(value);
  assertByteLength(out, expected, label);
  return out;
}

function validateSelector(selector: Buffer): Buffer {
  if (!selector.equals(Buffer.from(TRUSTED_RISC0_SELECTOR))) {
    throw new Error("sealSelector must match TRUSTED_RISC0_SELECTOR");
  }
  return selector;
}

export function buildJournalBytes(fields: {
  taskPda: Uint8Array | Buffer;
  agentAuthority: Uint8Array | Buffer;
  constraintHash: Uint8Array | Buffer;
  outputCommitment: Uint8Array | Buffer;
  bindingSeed: Uint8Array | Buffer;
  nullifierSeed: Uint8Array | Buffer;
  modelCommitment?: Uint8Array | Buffer;
  inputCommitment?: Uint8Array | Buffer;
}): Buffer {
  const pieces = [
    copyFixedBytes(fields.taskPda, HASH_SIZE, "taskPda"),
    copyFixedBytes(fields.agentAuthority, HASH_SIZE, "agentAuthority"),
    copyFixedBytes(fields.constraintHash, HASH_SIZE, "constraintHash"),
    copyFixedBytes(fields.outputCommitment, HASH_SIZE, "outputCommitment"),
    copyFixedBytes(fields.bindingSeed, HASH_SIZE, "bindingSeed"),
    copyFixedBytes(fields.nullifierSeed, HASH_SIZE, "nullifierSeed"),
    copyFixedBytes(fields.modelCommitment ?? Buffer.alloc(HASH_SIZE), HASH_SIZE, "modelCommitment"),
    copyFixedBytes(fields.inputCommitment ?? Buffer.alloc(HASH_SIZE), HASH_SIZE, "inputCommitment"),
  ];
  const journal = Buffer.concat(pieces);
  const expectedLength = HASH_SIZE * JOURNAL_FIELDS;
  if (
    journal.length !== expectedLength ||
    journal.length !== RISC0_JOURNAL_LEN
  ) {
    throw new Error(`journal must be exactly ${RISC0_JOURNAL_LEN} bytes`);
  }
  return journal;
}

/**
 * Generate a RISC Zero Groth16 proof via an external prover backend.
 *
 * This function computes all hashes locally (same as the simulated path), then
 * delegates proof generation to a local binary or remote prover. The returned
 * journal is validated against locally computed fields to ensure integrity.
 *
 * `params.imageId` and `params.sealSelector` are ignored — the real image ID
 * comes from the prover's compiled guest ELF.
 *
 * @param params - Same proof generation parameters as `generateProof()`
 * @param proverConfig - Backend configuration (local-binary or remote)
 */
export async function generateProof(
  params: ProofGenerationParams,
  proverConfig: ProverConfig,
): Promise<ProofResult> {
  const startTime = Date.now();

  if (params.salt === 0n) {
    throw new Error(
      "salt must be non-zero for privacy preservation",
    );
  }

  const hashes = computeHashes(
    params.taskPda,
    params.agentPubkey,
    params.output,
    params.salt,
    params.agentSecret,
  );

  const constraintHashBuf = bigintToBytes32(hashes.constraintHash);
  const outputCommitmentBuf = bigintToBytes32(hashes.outputCommitment);
  const bindingSeedBuf = bigintToBytes32(hashes.binding);
  const nullifierSeedBuf = bigintToBytes32(hashes.nullifier);

  const proverInput = {
    taskPda: new Uint8Array(params.taskPda.toBytes()),
    agentAuthority: new Uint8Array(params.agentPubkey.toBytes()),
    constraintHash: new Uint8Array(constraintHashBuf),
    outputCommitment: new Uint8Array(outputCommitmentBuf),
    binding: new Uint8Array(bindingSeedBuf),
    nullifier: new Uint8Array(nullifierSeedBuf),
    modelCommitment: new Uint8Array(HASH_SIZE),
    inputCommitment: new Uint8Array(HASH_SIZE),
  };

  const { prove } = await import("./prover.js");
  const { sealBytes, journal, imageId } = await prove(
    proverInput,
    proverConfig,
  );

  // Validate returned journal matches locally computed fields
  const expectedJournal = buildJournalBytes({
    taskPda: params.taskPda.toBytes(),
    agentAuthority: params.agentPubkey.toBytes(),
    constraintHash: constraintHashBuf,
    outputCommitment: outputCommitmentBuf,
    bindingSeed: bindingSeedBuf,
    nullifierSeed: nullifierSeedBuf,
  });
  if (!expectedJournal.equals(journal)) {
    throw new Error(
      "Prover returned journal that does not match computed fields",
    );
  }

  const proof = Buffer.from(sealBytes.subarray(RISC0_SELECTOR_LEN));

  return {
    sealBytes,
    journal,
    imageId,
    bindingSeed: bindingSeedBuf,
    nullifierSeed: nullifierSeedBuf,
    proof,
    constraintHash: constraintHashBuf,
    outputCommitment: outputCommitmentBuf,
    binding: Buffer.from(bindingSeedBuf),
    nullifier: Buffer.from(nullifierSeedBuf),
    proofSize: proof.length,
    generationTime: Date.now() - startTime,
  };
}
