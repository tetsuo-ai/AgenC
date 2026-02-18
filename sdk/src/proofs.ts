/**
 * ZK Proof Generation for AgenC
 *
 * Uses snarkjs with Circom circuits for Groth16 proof generation.
 * Hash computation uses poseidon-lite for exact circomlib compatibility.
 *
 * ## Security Notes
 *
 * ### Salt Security
 * - Each proof MUST use a unique, cryptographically random salt
 * - NEVER reuse a salt across different proofs - this can leak private output data
 * - Use `generateSalt()` to create secure random salts
 * - Store salts securely if you need to verify commitments later
 *
 * ### Hash Computation
 * - All hashes are computed via poseidon-lite (circomlib compatible)
 * - This guarantees exact compatibility with the task_completion circuit
 */

import * as fs from 'fs';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import { poseidon2, poseidon4, poseidon5 } from 'poseidon-lite';
import { HASH_SIZE, OUTPUT_FIELD_COUNT, PROOF_SIZE_BYTES } from './constants';
import { validateCircuitPath } from './validation';

type SnarkjsModule = {
  groth16: {
    fullProve: (
      input: Record<string, string | string[]>,
      wasmFile: string,
      zkeyFile: string
    ) => Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] } }>;
    verify: (vkey: unknown, publicSignals: string[], proof: unknown) => Promise<boolean>;
  };
};

let snarkjsLoader: Promise<SnarkjsModule> | null = null;

async function loadSnarkjs(): Promise<SnarkjsModule> {
  if (snarkjsLoader) {
    return snarkjsLoader;
  }

  // @ts-expect-error snarkjs is an optional dependency and has no bundled typings
  snarkjsLoader = import('snarkjs')
    .then((module) => {
      const candidate = ((module as { default?: unknown }).default ?? module) as unknown;
      if (
        typeof candidate !== 'object'
        || candidate === null
        || !('groth16' in candidate)
        || typeof (candidate as { groth16?: unknown }).groth16 !== 'object'
      ) {
        throw new Error('snarkjs module loaded but groth16 API not found');
      }
      return candidate as SnarkjsModule;
    })
    .catch((error) => {
      snarkjsLoader = null;
      throw error;
    });

  return snarkjsLoader;
}

/** BN254 scalar field modulus */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const DEFAULT_CIRCUIT_PATH = './circuits-circom/task_completion';

/** Bits per byte for bit shifting */
const BITS_PER_BYTE = 8n;

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
 * Parameters for proof generation
 */
export interface ProofGenerationParams {
  taskPda: PublicKey;
  agentPubkey: PublicKey;
  output: bigint[];
  salt: bigint;
  /**
   * Optional private witness for circuit `agent_secret`.
   * If omitted, SDK uses `pubkeyToField(agentPubkey)` as a compatibility fallback.
   */
  agentSecret?: bigint;
  circuitPath?: string;
}

export interface ProofResult {
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
 * Uses Poseidon hash matching the circomlib implementation.
 *
 * @param output - Task output (4 field elements)
 * @returns The constraint hash
 */
export function computeConstraintHash(output: bigint[]): bigint {
  if (output.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(`Output must be exactly ${OUTPUT_FIELD_COUNT} field elements`);
  }
  // Reduce each element modulo field to handle overflow
  const reduced = output.map((x) => ((x % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS);
  return poseidon4(reduced);
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
 * Matches circuit.circom: Poseidon(output_values[0..3], salt)
 *
 * @param output - Task output (4 field elements)
 * @param salt - Random salt
 * @returns The output commitment
 */
export function computeCommitmentFromOutput(output: bigint[], salt: bigint): bigint {
  const normalizedOutput = normalizeOutput(output);
  const s = normalizeFieldElement(salt);
  return poseidon5([
    normalizedOutput[0],
    normalizedOutput[1],
    normalizedOutput[2],
    normalizedOutput[3],
    s,
  ]);
}

/**
 * Legacy commitment helper.
 *
 * NOTE: This helper is retained for API compatibility with older callers.
 * New proof generation uses `computeCommitmentFromOutput` to match circuit semantics.
 */
export function computeCommitment(constraintHash: bigint, salt: bigint): bigint {
  const ch = normalizeFieldElement(constraintHash);
  const s = normalizeFieldElement(salt);
  return poseidon2([ch, s]);
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
  const binding = poseidon2([taskField, agentField]);
  const commitment = ((outputCommitment % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS;
  return poseidon2([binding, commitment]);
}

/**
 * Compute the nullifier to prevent proof/knowledge reuse across tasks.
 *
 * Compatibility helper: derives `agent_secret` from agent public key field.
 * New proof generation should pass `agentSecret` explicitly where possible.
 *
 * @param constraintHash - The constraint hash
 * @param agentPubkey - Agent's public key
 * @returns The nullifier value
 */
export function computeNullifier(constraintHash: bigint, agentPubkey: PublicKey): bigint {
  const ch = normalizeFieldElement(constraintHash);
  const agentField = pubkeyToField(agentPubkey);
  return poseidon2([ch, agentField]);
}

export function computeNullifierFromAgentSecret(constraintHash: bigint, agentSecret: bigint): bigint {
  const ch = normalizeFieldElement(constraintHash);
  const secret = normalizeFieldElement(agentSecret);
  return poseidon2([ch, secret]);
}

/**
 * Compute all hashes needed for proof generation.
 *
 * @param taskPda - Task PDA (used as task_id)
 * @param agentPubkey - Agent's public key
 * @param output - Task output (4 field elements)
 * @param salt - Random salt for commitment
 * @returns Computed hashes (constraintHash, outputCommitment, expectedBinding)
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
  const effectiveAgentSecret = agentSecret ?? pubkeyToField(agentPubkey);
  const nullifier = computeNullifierFromAgentSecret(constraintHash, effectiveAgentSecret);

  return {
    constraintHash,
    outputCommitment,
    expectedBinding,
    nullifier,
  };
}

function bigintToBytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(HASH_SIZE * 2, '0');
  return Buffer.from(hex, 'hex');
}

/**
 * Build witness input for the Circom circuit.
 */
function buildWitnessInput(
  taskPda: PublicKey,
  agentPubkey: PublicKey,
  output: bigint[],
  salt: bigint,
  agentSecret: bigint,
  hashes: HashResult
): Record<string, string | string[]> {
  const taskBytes = Array.from(taskPda.toBytes()).map((b) => b.toString());
  const agentBytes = Array.from(agentPubkey.toBytes()).map((b) => b.toString());
  const outputValues = normalizeOutput(output).map((o) => o.toString());
  const normalizedSalt = normalizeFieldElement(salt);
  const normalizedAgentSecret = normalizeFieldElement(agentSecret);

  return {
    task_id: taskBytes,
    agent_pubkey: agentBytes,
    constraint_hash: hashes.constraintHash.toString(),
    output_commitment: hashes.outputCommitment.toString(),
    expected_binding: hashes.expectedBinding.toString(),
    output_values: outputValues,
    output: outputValues, // Legacy alias for older circuit artifacts.
    salt: normalizedSalt.toString(),
    agent_secret: normalizedAgentSecret.toString(),
  };
}

/**
 * Convert snarkjs proof to groth16-solana format (256 bytes).
 *
 * groth16-solana expects: proof_a (64 bytes G1) + proof_b (128 bytes G2) + proof_c (64 bytes G1)
 * snarkjs outputs proof points as decimal strings that need to be converted.
 */
function convertProofToSolanaFormat(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): Buffer {
  // Helper to convert a decimal string to 32-byte big-endian buffer
  const toBe32 = (val: string): Buffer => {
    const bi = BigInt(val);
    const hex = bi.toString(16).padStart(64, '0');
    return Buffer.from(hex, 'hex');
  };

  // proof_a: G1 point (2 coordinates, 32 bytes each = 64 bytes)
  const proofA = Buffer.concat([toBe32(proof.pi_a[0]), toBe32(proof.pi_a[1])]);

  // proof_b: G2 point (2x2 coordinates, 32 bytes each = 128 bytes)
  // Note: G2 point in snarkjs is [[x0, x1], [y0, y1]] but groth16-solana expects
  // different ordering. The standard is: x1, x0, y1, y0 (reversed within pairs)
  const proofB = Buffer.concat([
    toBe32(proof.pi_b[0][1]),
    toBe32(proof.pi_b[0][0]),
    toBe32(proof.pi_b[1][1]),
    toBe32(proof.pi_b[1][0]),
  ]);

  // proof_c: G1 point (2 coordinates, 32 bytes each = 64 bytes)
  const proofC = Buffer.concat([toBe32(proof.pi_c[0]), toBe32(proof.pi_c[1])]);

  return Buffer.concat([proofA, proofB, proofC]);
}

/**
 * Generate a ZK proof for private task completion.
 *
 * This function:
 * 1. Computes all necessary hashes using poseidon-lite (circomlib compatible)
 * 2. Generates the witness for the task_completion circuit
 * 3. Creates the Groth16 proof via snarkjs
 *
 * @param params - Proof generation parameters
 * @returns Proof result including proof bytes and public inputs
 */
export async function generateProof(params: ProofGenerationParams): Promise<ProofResult> {
  const circuitPath = params.circuitPath || DEFAULT_CIRCUIT_PATH;
  validateCircuitPath(circuitPath);

  const startTime = Date.now();

  const agentSecret = params.agentSecret ?? pubkeyToField(params.agentPubkey);

  // Step 1: Compute hashes using poseidon-lite
  const hashes = computeHashes(
    params.taskPda,
    params.agentPubkey,
    params.output,
    params.salt,
    agentSecret
  );

  // Step 2: Build witness input
  const witnessInput = buildWitnessInput(
    params.taskPda,
    params.agentPubkey,
    params.output,
    params.salt,
    agentSecret,
    hashes
  );

  // Step 3: Locate circuit files
  const wasmPath = path.join(circuitPath, 'target/circuit_js/circuit.wasm');
  const zkeyPath = path.join(circuitPath, 'target/circuit.zkey');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Circuit WASM not found at ${wasmPath}. Run 'npm run build' in circuits-circom/task_completion first.`);
  }
  if (!fs.existsSync(zkeyPath)) {
    throw new Error(`Circuit zkey not found at ${zkeyPath}. Run 'npm run build' in circuits-circom/task_completion first.`);
  }

  const snarkjs = await loadSnarkjs();

  // Step 4: Generate proof using snarkjs
  const { proof } = await snarkjs.groth16.fullProve(witnessInput, wasmPath, zkeyPath);

  // Step 5: Convert proof to groth16-solana format
  const proofBuffer = convertProofToSolanaFormat(proof);

  if (proofBuffer.length !== PROOF_SIZE_BYTES) {
    throw new Error(`Proof size mismatch: expected ${PROOF_SIZE_BYTES}, got ${proofBuffer.length}`);
  }

  return {
    proof: proofBuffer,
    constraintHash: bigintToBytes32(hashes.constraintHash),
    outputCommitment: bigintToBytes32(hashes.outputCommitment),
    expectedBinding: bigintToBytes32(hashes.expectedBinding),
    nullifier: bigintToBytes32(hashes.nullifier),
    proofSize: proofBuffer.length,
    generationTime: Date.now() - startTime,
  };
}

/**
 * Verify a proof locally using snarkjs.
 *
 * @param proof - The proof buffer (256 bytes in groth16-solana format)
 * @param publicSignals - Array of public signals
 * @param circuitPath - Path to circuit directory
 * @returns True if proof is valid
 */
export async function verifyProofLocally(
  proof: Buffer,
  publicSignals: bigint[],
  circuitPath: string = DEFAULT_CIRCUIT_PATH
): Promise<boolean> {
  validateCircuitPath(circuitPath);

  const vkeyPath = path.join(circuitPath, 'target/verification_key.json');

  if (!fs.existsSync(vkeyPath)) {
    throw new Error(`Verification key not found at ${vkeyPath}. Run trusted setup first.`);
  }

  const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf-8'));

  // Convert proof buffer back to snarkjs format
  // This is the reverse of convertProofToSolanaFormat
  const readBe32 = (buf: Buffer, offset: number): string => {
    const slice = buf.slice(offset, offset + 32);
    return BigInt('0x' + slice.toString('hex')).toString();
  };

  const snarkjsProof = {
    pi_a: [readBe32(proof, 0), readBe32(proof, 32), '1'],
    pi_b: [
      [readBe32(proof, 96), readBe32(proof, 64)],
      [readBe32(proof, 160), readBe32(proof, 128)],
      ['1', '0'],
    ],
    pi_c: [readBe32(proof, 192), readBe32(proof, 224), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };

  const signals = publicSignals.map((s) => s.toString());
  const snarkjs = await loadSnarkjs();

  try {
    return await snarkjs.groth16.verify(vkey, signals, snarkjsProof);
  } catch {
    return false;
  }
}

export interface ToolsStatus {
  snarkjs: boolean;
  snarkjsVersion?: string;
}

/**
 * Check if required tools (snarkjs) are available.
 * Note: circom is only needed for circuit compilation, not proof generation.
 * @returns Status of snarkjs including version if available
 */
export function checkToolsAvailable(): ToolsStatus {
  const result: ToolsStatus = { snarkjs: false };

  // snarkjs is a node module, check if it's importable
  try {
    const requireFactory = Function('return typeof require !== "undefined" ? require : null') as () => ((id: string) => unknown) | null;
    const localRequire = requireFactory();
    if (localRequire) {
      const snarkjsPkg = localRequire('snarkjs/package.json') as { version?: string };
      result.snarkjs = true;
      if (typeof snarkjsPkg.version === 'string') {
        result.snarkjsVersion = snarkjsPkg.version;
      }
    }
  } catch {
    // snarkjs not available
  }

  return result;
}

/**
 * Throws an error with installation instructions if required tools are missing.
 */
export function requireTools(): void {
  const tools = checkToolsAvailable();

  if (!tools.snarkjs) {
    throw new Error(
      'snarkjs not found. Install with:\n' +
        '  npm install snarkjs\n\n' +
        'See: https://github.com/iden3/snarkjs'
    );
  }
}
