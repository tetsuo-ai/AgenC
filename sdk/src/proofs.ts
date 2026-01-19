/**
 * ZK Proof Generation for AgenC
 *
 * Uses @zkpassport/poseidon2 which is compatible with Noir's poseidon2_permutation.
 * This ensures hash values match between the SDK and the ZK circuit.
 *
 * ## Security Notes
 *
 * ### Salt Security
 * - Each proof MUST use a unique, cryptographically random salt
 * - NEVER reuse a salt across different proofs - this can leak private output data
 * - Use `generateSalt()` to create secure random salts
 * - Store salts securely if you need to verify commitments later
 *
 * ### Poseidon2 Compatibility
 * - The hash implementation must match Noir's `poseidon2_permutation` exactly
 * - We use @zkpassport/poseidon2 which is BN254-compatible
 * - Field arithmetic is mod FIELD_MODULUS (BN254 scalar field)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PublicKey } from '@solana/web3.js';
import { poseidon2Hash } from '@zkpassport/poseidon2';
import { HASH_SIZE, OUTPUT_FIELD_COUNT } from './constants';

/**
 * Validates a circuit path to prevent path traversal and command injection.
 * @param circuitPath - The circuit path to validate
 * @throws Error if the path is invalid
 */
function validateCircuitPath(circuitPath: string): void {
  // Disallow absolute paths
  if (path.isAbsolute(circuitPath)) {
    throw new Error('Security: Absolute circuit paths are not allowed');
  }
  // Normalize and check for traversal attempts
  const normalized = path.normalize(circuitPath);
  if (normalized.startsWith('..') || normalized.includes('../')) {
    throw new Error('Security: Path traversal in circuit path is not allowed');
  }
  // Check for shell metacharacters that could enable command injection
  const dangerousChars = /[;&|`$(){}[\]<>!]/;
  if (dangerousChars.test(circuitPath)) {
    throw new Error('Security: Circuit path contains disallowed characters');
  }
}

/** BN254 scalar field modulus - must match Noir's field for Poseidon2 compatibility */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Bytes required for a 256-bit field element in hex (64 hex chars = 32 bytes) */
const FIELD_HEX_LENGTH = HASH_SIZE * 2;

/** Base for byte-to-field conversion (256 = 2^8) */
const BYTE_BASE = 256n;

const DEFAULT_CIRCUIT_PATH = './circuits/task_completion';

export interface ProofGenerationParams {
  taskPda: PublicKey;
  agentPubkey: PublicKey;
  constraintHash: Buffer;
  outputCommitment: bigint;
  output: bigint[];
  salt: bigint;
  circuitPath?: string;
}

export interface ProofResult {
  proof: Buffer;
  publicWitness: Buffer;
  expectedBinding: Buffer;
  proofSize: number;
  generationTime: number;
}

function poseidonHash2(a: bigint, b: bigint): bigint {
  return poseidon2Hash([a % FIELD_MODULUS, b % FIELD_MODULUS, 0n, 0n]);
}

function poseidonHash4(input: bigint[]): bigint {
  if (input.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(`Input must be exactly ${OUTPUT_FIELD_COUNT} elements`);
  }
  return poseidon2Hash(input.map((x) => x % FIELD_MODULUS));
}

export function pubkeyToField(pubkey: PublicKey): bigint {
  const bytes = pubkey.toBytes();
  let field = 0n;
  for (const byte of bytes) {
    field = (field * BYTE_BASE + BigInt(byte)) % FIELD_MODULUS;
  }
  return field;
}

export function computeExpectedBinding(
  taskPda: PublicKey,
  agentPubkey: PublicKey,
  outputCommitment: bigint
): bigint {
  const taskField = pubkeyToField(taskPda);
  const agentField = pubkeyToField(agentPubkey);
  const binding = poseidonHash2(taskField, agentField);
  return poseidonHash2(binding, outputCommitment % FIELD_MODULUS);
}

export function computeConstraintHash(output: bigint[]): bigint {
  if (output.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(`Output must be exactly ${OUTPUT_FIELD_COUNT} field elements`);
  }
  return poseidonHash4(output);
}

/**
 * Compute the output commitment from constraint hash and salt.
 *
 * The commitment hides the actual output while allowing verification.
 * commitment = poseidon2(constraintHash, salt)
 *
 * @param constraintHash - Hash of the task output (from computeConstraintHash)
 * @param salt - Random salt (MUST be unique per proof, use generateSalt())
 * @returns The commitment value to include in the proof
 */
export function computeCommitment(constraintHash: bigint, salt: bigint): bigint {
  return poseidonHash2(constraintHash, salt);
}

/** Bits per byte for bit shifting */
const BITS_PER_BYTE = 8n;

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

function generateProverToml(params: ProofGenerationParams): string {
  const taskBytes = Array.from(params.taskPda.toBytes());
  const agentBytes = Array.from(params.agentPubkey.toBytes());
  const expectedBinding = computeExpectedBinding(
    params.taskPda,
    params.agentPubkey,
    params.outputCommitment
  );

  return `task_id = [${taskBytes.join(', ')}]
agent_pubkey = [${agentBytes.join(', ')}]
constraint_hash = "0x${params.constraintHash.toString('hex')}"
output_commitment = "0x${params.outputCommitment.toString(16)}"
expected_binding = "0x${expectedBinding.toString(16)}"
output = [${params.output.map((o) => `"${o.toString()}"`).join(', ')}]
salt = "${params.salt.toString()}"
`;
}

export async function generateProof(params: ProofGenerationParams): Promise<ProofResult> {
  const circuitPath = params.circuitPath || DEFAULT_CIRCUIT_PATH;

  // Security: Validate circuit path to prevent command injection and path traversal
  validateCircuitPath(circuitPath);

  const startTime = Date.now();

  const expectedBindingBigint = computeExpectedBinding(
    params.taskPda,
    params.agentPubkey,
    params.outputCommitment
  );

  // Security: Use path.join to construct safe file paths
  const proverTomlPath = path.join(circuitPath, 'Prover.toml');
  const proofOutputPath = path.join(circuitPath, 'target/task_completion.proof');
  const witnessPath = path.join(circuitPath, 'target/task_completion.gz');

  // Security: Verify the target directory exists before writing
  const targetDir = path.join(circuitPath, 'target');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(proverTomlPath, generateProverToml(params));

  try {
    // Security: Use cwd option to confine command execution to circuit directory
    // Commands are hardcoded to prevent injection
    execSync('nargo execute', { cwd: circuitPath, stdio: 'pipe', timeout: 120000 });
    execSync(
      'sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof',
      { cwd: circuitPath, stdio: 'pipe', timeout: 300000 }
    );

    const proof = fs.readFileSync(proofOutputPath);
    const publicWitness = fs.readFileSync(witnessPath);
    const expectedBinding = bigintToBytes32(expectedBindingBigint);

    return {
      proof,
      publicWitness,
      expectedBinding,
      proofSize: proof.length,
      generationTime: Date.now() - startTime,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Proof generation failed: ${message}`);
  }
}

function bigintToBytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(FIELD_HEX_LENGTH, '0');
  return Buffer.from(hex, 'hex');
}

export async function verifyProofLocally(
  proof: Buffer,
  publicWitness: Buffer,
  circuitPath: string = DEFAULT_CIRCUIT_PATH
): Promise<boolean> {
  // Security: Validate circuit path to prevent command injection and path traversal
  validateCircuitPath(circuitPath);

  // Security: Use unique filenames to avoid race conditions with concurrent verifications
  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  const proofPath = path.join(circuitPath, `target/verify_test_${uniqueSuffix}.proof`);
  const witnessPath = path.join(circuitPath, `target/verify_test_${uniqueSuffix}.pw`);

  // Security: Derive relative paths for the command to avoid path injection
  const relativeProofPath = `target/verify_test_${uniqueSuffix}.proof`;
  const relativeWitnessPath = `target/verify_test_${uniqueSuffix}.pw`;

  fs.writeFileSync(proofPath, proof);
  fs.writeFileSync(witnessPath, publicWitness);

  try {
    // Security: Use hardcoded command structure with controlled relative paths
    execSync(
      `sunspot verify target/task_completion.ccs target/task_completion.vk ${relativeProofPath} ${relativeWitnessPath}`,
      { cwd: circuitPath, stdio: 'pipe', timeout: 60000 }
    );
    return true;
  } catch {
    return false;
  } finally {
    // Clean up temp files (best-effort, ignore errors if already deleted)
    try { fs.unlinkSync(proofPath); } catch { /* file may not exist */ }
    try { fs.unlinkSync(witnessPath); } catch { /* file may not exist */ }
  }
}

export function checkToolsAvailable(): { nargo: boolean; sunspot: boolean } {
  let nargo = false;
  let sunspot = false;

  try {
    execSync('nargo --version', { stdio: 'pipe' });
    nargo = true;
  } catch (error) {
    // Expected: command not found or not in PATH
    // Only log unexpected errors for debugging
    if (error instanceof Error && !error.message.includes('ENOENT') && !error.message.includes('not found')) {
      console.debug('nargo check failed with unexpected error:', error.message);
    }
  }

  try {
    execSync('sunspot --version', { stdio: 'pipe' });
    sunspot = true;
  } catch (error) {
    // Expected: command not found or not in PATH
    // Only log unexpected errors for debugging
    if (error instanceof Error && !error.message.includes('ENOENT') && !error.message.includes('not found')) {
      console.debug('sunspot check failed with unexpected error:', error.message);
    }
  }

  return { nargo, sunspot };
}
