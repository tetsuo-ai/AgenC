/**
 * RISC Zero private-proof payload helpers for AgenC SDK.
 *
 * Proof generation now emits the router payload shape:
 * - seal_bytes (260 bytes borsh envelope for trusted selector + Groth16 proof)
 * - journal (192 bytes fixed schema)
 * - image_id (32 bytes)
 * - binding_seed / nullifier_seed (32 bytes each)
 */

import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
  HASH_SIZE,
  OUTPUT_FIELD_COUNT,
  PROOF_SIZE_BYTES,
  RISC0_GROTH16_SEAL_LEN,
  RISC0_IMAGE_ID_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_SEAL_BORSH_LEN,
  RISC0_SELECTOR_LEN,
  TRUSTED_RISC0_IMAGE_ID,
  TRUSTED_RISC0_SELECTOR,
} from './constants';

/** BN254 scalar field modulus */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Bits per byte for bit shifting */
const BITS_PER_BYTE = 8n;

const PROOF_XOR_MULTIPLIER = 13;
const JOURNAL_FIELDS = 6;
const SIGNAL_BYTES = 32 + 32;
const SIGNAL_SCALARS = 4;
const EXPECTED_PUBLIC_SIGNALS_LEN = SIGNAL_BYTES + SIGNAL_SCALARS;
const NULLIFIER_DOMAIN_TAG = Buffer.from('AGENC_V2_NULLIFIER', 'utf8');
const CONSTRAINT_HASH_DOMAIN_TAG = Buffer.from('AGENC_V2_CONSTRAINT_HASH', 'utf8');
const OUTPUT_COMMITMENT_DOMAIN_TAG = Buffer.from('AGENC_V2_OUTPUT_COMMITMENT', 'utf8');
const BINDING_BASE_DOMAIN_TAG = Buffer.from('AGENC_V2_BINDING_BASE', 'utf8');
const BINDING_DOMAIN_TAG = Buffer.from('AGENC_V2_BINDING', 'utf8');
const MAX_U256 = (1n << 256n) - 1n;

/**
 * Result from computing hashes
 */
export interface HashResult {
  constraintHash: bigint;
  outputCommitment: bigint;
  expectedBinding: bigint;
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
   * Optional private witness for nullifier derivation.
   * If omitted, SDK uses `pubkeyToField(agentPubkey)` as a compatibility fallback.
   */
  agentSecret?: bigint;
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
  expectedBinding: Buffer;
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
    throw new Error(`Output must be exactly ${OUTPUT_FIELD_COUNT} field elements`);
  }
  const reduced = output.map(normalizeFieldElement);
  return hashFieldElements(CONSTRAINT_HASH_DOMAIN_TAG, reduced);
}

function normalizeFieldElement(value: bigint): bigint {
  return ((value % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS;
}

function normalizeOutput(output: bigint[]): bigint[] {
  if (output.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(`Output must be exactly ${OUTPUT_FIELD_COUNT} field elements`);
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
export function computeCommitmentFromOutput(output: bigint[], salt: bigint): bigint {
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
export function computeExpectedBinding(
  taskPda: PublicKey,
  agentPubkey: PublicKey,
  outputCommitment: bigint
): bigint {
  const taskField = pubkeyToField(taskPda);
  const agentField = pubkeyToField(agentPubkey);
  const bindingBase = hashFieldElements(BINDING_BASE_DOMAIN_TAG, [taskField, agentField]);
  const commitment = normalizeFieldElement(outputCommitment);
  return hashFieldElements(BINDING_DOMAIN_TAG, [bindingBase, commitment]);
}

export function computeNullifierFromAgentSecret(
  constraintHash: bigint,
  outputCommitment: bigint,
  agentSecret: bigint
): bigint {
  const ch = normalizeFieldElement(constraintHash);
  const oc = normalizeFieldElement(outputCommitment);
  const secret = normalizeFieldElement(agentSecret);

  const digest = createHash('sha256')
    .update(NULLIFIER_DOMAIN_TAG)
    .update(bigintToBytes32(ch))
    .update(bigintToBytes32(oc))
    .update(bigintToBytes32(secret))
    .digest();

  return BigInt(`0x${digest.toString('hex')}`);
}

/**
 * Compute all hashes needed for proof generation.
 */
export function computeHashes(
  taskPda: PublicKey,
  agentPubkey: PublicKey,
  output: bigint[],
  salt: bigint,
  agentSecret?: bigint
): HashResult {
  const constraintHash = computeConstraintHash(output);
  const outputCommitment = computeCommitmentFromOutput(output, salt);
  const expectedBinding = computeExpectedBinding(taskPda, agentPubkey, outputCommitment);
  if (agentSecret === undefined) {
    console.warn(
      'SECURITY WARNING: agentSecret not provided to computeHashes(). Falling back to ' +
      'pubkeyToField(agentPubkey), which makes the nullifier predictable by anyone. ' +
      'Pass an explicit agentSecret for production use.'
    );
  }
  const effectiveAgentSecret = agentSecret ?? pubkeyToField(agentPubkey);
  const nullifier = computeNullifierFromAgentSecret(
    constraintHash,
    outputCommitment,
    effectiveAgentSecret
  );

  return {
    constraintHash,
    outputCommitment,
    expectedBinding,
    nullifier,
  };
}

function bigintToBytes32(value: bigint): Buffer {
  if (value < 0n || value > MAX_U256) {
    throw new Error('value must be in [0, 2^256 - 1]');
  }
  const hex = value.toString(16).padStart(HASH_SIZE * 2, '0');
  return Buffer.from(hex, 'hex');
}

function hashFieldElements(domainTag: Buffer, values: bigint[]): bigint {
  const hasher = createHash('sha256');
  hasher.update(domainTag);
  for (const value of values) {
    hasher.update(bigintToBytes32(normalizeFieldElement(value)));
  }
  const digest = hasher.digest();
  return BigInt(`0x${digest.toString('hex')}`) % FIELD_MODULUS;
}

function assertByteLength(value: Uint8Array | Buffer, expected: number, label: string): void {
  if (value.length !== expected) {
    throw new Error(`${label} must be ${expected} bytes, got ${value.length}`);
  }
}

function copyFixedBytes(value: Uint8Array | Buffer, expected: number, label: string): Buffer {
  const out = Buffer.from(value);
  assertByteLength(out, expected, label);
  return out;
}

function validateSelector(selector: Buffer): Buffer {
  if (!selector.equals(Buffer.from(TRUSTED_RISC0_SELECTOR))) {
    throw new Error('sealSelector must match TRUSTED_RISC0_SELECTOR');
  }
  return selector;
}

function buildJournalBytes(fields: {
  taskPda: Uint8Array | Buffer;
  agentAuthority: Uint8Array | Buffer;
  constraintHash: Uint8Array | Buffer;
  outputCommitment: Uint8Array | Buffer;
  bindingSeed: Uint8Array | Buffer;
  nullifierSeed: Uint8Array | Buffer;
}): Buffer {
  const pieces = [
    copyFixedBytes(fields.taskPda, HASH_SIZE, 'taskPda'),
    copyFixedBytes(fields.agentAuthority, HASH_SIZE, 'agentAuthority'),
    copyFixedBytes(fields.constraintHash, HASH_SIZE, 'constraintHash'),
    copyFixedBytes(fields.outputCommitment, HASH_SIZE, 'outputCommitment'),
    copyFixedBytes(fields.bindingSeed, HASH_SIZE, 'bindingSeed'),
    copyFixedBytes(fields.nullifierSeed, HASH_SIZE, 'nullifierSeed'),
  ];
  const journal = Buffer.concat(pieces);
  const expectedLength = HASH_SIZE * JOURNAL_FIELDS;
  if (journal.length !== expectedLength || journal.length !== RISC0_JOURNAL_LEN) {
    throw new Error(`journal must be exactly ${RISC0_JOURNAL_LEN} bytes`);
  }
  return journal;
}

function simulateSealProofBytes(journal: Buffer, imageId: Buffer): Buffer {
  assertByteLength(journal, RISC0_JOURNAL_LEN, 'journal');
  assertByteLength(imageId, RISC0_IMAGE_ID_LEN, 'imageId');

  const proof = Buffer.alloc(RISC0_GROTH16_SEAL_LEN);
  for (let i = 0; i < proof.length; i++) {
    proof[i] = journal[i % journal.length] ^ imageId[i % imageId.length] ^ ((i * PROOF_XOR_MULTIPLIER) & 0xff);
  }
  return proof;
}

/**
 * Generate a deterministic local RISC0-shaped payload.
 *
 * Emits the router payload shape for downstream submission.
 */
export async function generateProof(params: ProofGenerationParams): Promise<ProofResult> {
  const startTime = Date.now();

  if (params.agentSecret === undefined) {
    console.warn(
      'SECURITY WARNING: agentSecret not provided to generateProof(). Falling back to ' +
      'pubkeyToField(agentPubkey), which makes the nullifier predictable by anyone. ' +
      'Pass an explicit agentSecret for production use.'
    );
  }
  const agentSecret = params.agentSecret ?? pubkeyToField(params.agentPubkey);
  const hashes = computeHashes(
    params.taskPda,
    params.agentPubkey,
    params.output,
    params.salt,
    agentSecret
  );

  const constraintHash = bigintToBytes32(hashes.constraintHash);
  const outputCommitment = bigintToBytes32(hashes.outputCommitment);
  const bindingSeed = bigintToBytes32(hashes.expectedBinding);
  const nullifierSeed = bigintToBytes32(hashes.nullifier);

  const journal = buildJournalBytes({
    taskPda: params.taskPda.toBytes(),
    agentAuthority: params.agentPubkey.toBytes(),
    constraintHash,
    outputCommitment,
    bindingSeed,
    nullifierSeed,
  });

  const imageId = copyFixedBytes(
    params.imageId ?? TRUSTED_RISC0_IMAGE_ID,
    RISC0_IMAGE_ID_LEN,
    'imageId'
  );
  const selector = validateSelector(
    copyFixedBytes(
      params.sealSelector ?? TRUSTED_RISC0_SELECTOR,
      RISC0_SELECTOR_LEN,
      'sealSelector'
    )
  );

  const proof = simulateSealProofBytes(journal, imageId);
  assertByteLength(proof, PROOF_SIZE_BYTES, 'proof');
  const sealBytes = Buffer.concat([selector, proof]);
  assertByteLength(sealBytes, RISC0_SEAL_BORSH_LEN, 'sealBytes');

  return {
    sealBytes,
    journal,
    imageId,
    bindingSeed,
    nullifierSeed,
    proof,
    constraintHash,
    outputCommitment,
    expectedBinding: Buffer.from(bindingSeed),
    nullifier: Buffer.from(nullifierSeed),
    proofSize: proof.length,
    generationTime: Date.now() - startTime,
  };
}

function byteFromSignal(value: bigint, label: string): number {
  if (value < 0n || value > 255n) {
    throw new Error(`${label} must be an 8-bit value`);
  }
  return Number(value);
}

function signalToFieldBytes(value: bigint): Buffer {
  return bigintToBytes32(value);
}

function buildJournalFromPublicSignals(publicSignals: bigint[]): Buffer {
  if (publicSignals.length !== EXPECTED_PUBLIC_SIGNALS_LEN) {
    throw new Error(
      `publicSignals must contain exactly ${EXPECTED_PUBLIC_SIGNALS_LEN} elements`
    );
  }

  const taskPda = Buffer.alloc(HASH_SIZE);
  const agentAuthority = Buffer.alloc(HASH_SIZE);
  for (let i = 0; i < HASH_SIZE; i++) {
    taskPda[i] = byteFromSignal(publicSignals[i], `publicSignals[${i}]`);
    agentAuthority[i] = byteFromSignal(publicSignals[i + HASH_SIZE], `publicSignals[${i + HASH_SIZE}]`);
  }

  const constraintHash = signalToFieldBytes(publicSignals[64]);
  const outputCommitment = signalToFieldBytes(publicSignals[65]);
  const bindingSeed = signalToFieldBytes(publicSignals[66]);
  const nullifierSeed = signalToFieldBytes(publicSignals[67]);

  return buildJournalBytes({
    taskPda,
    agentAuthority,
    constraintHash,
    outputCommitment,
    bindingSeed,
    nullifierSeed,
  });
}

/**
 * Verify locally that seal bytes match the deterministic SDK proving transform.
 *
 * For compatibility with existing callers, this accepts either:
 * - 256-byte `proof` (legacy alias, selector assumed trusted), or
 * - 260-byte `sealBytes` (selector + proof).
 */
export async function verifyProofLocally(
  proof: Buffer,
  publicSignals: bigint[]
): Promise<boolean> {
  try {
    const raw = Buffer.from(proof);
    let selector: Buffer;
    let proofBody: Buffer;

    if (raw.length === RISC0_SEAL_BORSH_LEN) {
      selector = raw.subarray(0, RISC0_SELECTOR_LEN);
      proofBody = raw.subarray(RISC0_SELECTOR_LEN);
    } else if (raw.length === RISC0_GROTH16_SEAL_LEN) {
      selector = Buffer.from(TRUSTED_RISC0_SELECTOR);
      proofBody = raw;
    } else {
      return false;
    }

    validateSelector(selector);
    assertByteLength(proofBody, RISC0_GROTH16_SEAL_LEN, 'proof');
    const journal = buildJournalFromPublicSignals(publicSignals);
    const expected = simulateSealProofBytes(journal, Buffer.from(TRUSTED_RISC0_IMAGE_ID));
    return proofBody.equals(expected);
  } catch {
    return false;
  }
}
