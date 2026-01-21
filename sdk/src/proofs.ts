/**
 * ZK Proof Generation for AgenC
 *
 * Uses nargo to compute Poseidon2 hashes, ensuring exact compatibility with
 * Noir's poseidon2_permutation. The hash_helper circuit computes all hashes
 * needed for proof generation.
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
 * - All hashes are computed via nargo using the hash_helper circuit
 * - This guarantees exact compatibility with the task_completion circuit
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PublicKey } from '@solana/web3.js';
import { HASH_SIZE, OUTPUT_FIELD_COUNT } from './constants';

/**
 * Validates a circuit path to prevent path traversal and command injection.
 * @param circuitPath - The circuit path to validate
 * @throws Error if the path is invalid
 */
function validateCircuitPath(circuitPath: string): void {
  if (path.isAbsolute(circuitPath)) {
    throw new Error('Security: Absolute circuit paths are not allowed');
  }
  const normalized = path.normalize(circuitPath);
  if (normalized.startsWith('..') || normalized.includes('../')) {
    throw new Error('Security: Path traversal in circuit path is not allowed');
  }
  const dangerousChars = /[;&|`$(){}[\]<>!]/;
  if (dangerousChars.test(circuitPath)) {
    throw new Error('Security: Circuit path contains disallowed characters');
  }
}

/** BN254 scalar field modulus */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const FIELD_HEX_LENGTH = HASH_SIZE * 2;
const DEFAULT_CIRCUIT_PATH = './circuits/task_completion';
const DEFAULT_HASH_HELPER_PATH = './circuits/hash_helper';

/** Bits per byte for bit shifting */
const BITS_PER_BYTE = 8n;

/**
 * Result from computing hashes via the hash_helper circuit
 */
export interface HashResult {
  constraintHash: bigint;
  outputCommitment: bigint;
  expectedBinding: bigint;
}

/**
 * Parameters for proof generation (simplified interface)
 */
export interface ProofGenerationParams {
  taskPda: PublicKey;
  agentPubkey: PublicKey;
  output: bigint[];
  salt: bigint;
  circuitPath?: string;
  hashHelperPath?: string;
}

export interface ProofResult {
  proof: Buffer;
  publicWitness: Buffer;
  constraintHash: Buffer;
  outputCommitment: Buffer;
  expectedBinding: Buffer;
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
 * Compute hashes using the hash_helper Noir circuit via nargo.
 * This ensures exact compatibility with the task_completion circuit.
 *
 * @param taskPda - Task PDA (used as task_id)
 * @param agentPubkey - Agent's public key
 * @param output - Task output (4 field elements)
 * @param salt - Random salt for commitment
 * @param hashHelperPath - Path to hash_helper circuit (default: ./circuits/hash_helper)
 * @returns Computed hashes (constraintHash, outputCommitment, expectedBinding)
 */
export async function computeHashesViaNargo(
  taskPda: PublicKey,
  agentPubkey: PublicKey,
  output: bigint[],
  salt: bigint,
  hashHelperPath: string = DEFAULT_HASH_HELPER_PATH
): Promise<HashResult> {
  validateCircuitPath(hashHelperPath);

  if (output.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(`Output must be exactly ${OUTPUT_FIELD_COUNT} field elements`);
  }

  const taskBytes = Array.from(taskPda.toBytes());
  const agentBytes = Array.from(agentPubkey.toBytes());

  const proverToml = `task_id = [${taskBytes.join(', ')}]
agent_pubkey = [${agentBytes.join(', ')}]
output = [${output.map((o) => `"${o.toString()}"`).join(', ')}]
salt = "${salt.toString()}"
`;

  const proverTomlPath = path.join(hashHelperPath, 'Prover.toml');
  fs.writeFileSync(proverTomlPath, proverToml);

  try {
    const result = execSync('nargo execute', {
      cwd: hashHelperPath,
      encoding: 'utf-8',
      timeout: 60000,
    });

    // Parse output: "Circuit output: (0x..., 0x..., 0x...)"
    const outputMatch = result.match(/Circuit output: \((0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+)\)/);
    if (!outputMatch) {
      throw new Error(`Failed to parse hash_helper output: ${result}`);
    }

    return {
      constraintHash: BigInt(outputMatch[1]),
      outputCommitment: BigInt(outputMatch[2]),
      expectedBinding: BigInt(outputMatch[3]),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Hash computation failed: ${message}`);
  }
}

function generateProverToml(
  taskPda: PublicKey,
  agentPubkey: PublicKey,
  output: bigint[],
  salt: bigint,
  hashes: HashResult
): string {
  const taskBytes = Array.from(taskPda.toBytes());
  const agentBytes = Array.from(agentPubkey.toBytes());

  return `task_id = [${taskBytes.join(', ')}]
agent_pubkey = [${agentBytes.join(', ')}]
constraint_hash = "0x${hashes.constraintHash.toString(16).padStart(FIELD_HEX_LENGTH, '0')}"
output_commitment = "0x${hashes.outputCommitment.toString(16).padStart(FIELD_HEX_LENGTH, '0')}"
expected_binding = "0x${hashes.expectedBinding.toString(16).padStart(FIELD_HEX_LENGTH, '0')}"
output = [${output.map((o) => `"${o.toString()}"`).join(', ')}]
salt = "${salt.toString()}"
`;
}

function bigintToBytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(FIELD_HEX_LENGTH, '0');
  return Buffer.from(hex, 'hex');
}

/**
 * Generate a ZK proof for private task completion.
 *
 * This function:
 * 1. Computes all necessary hashes via the hash_helper circuit (nargo)
 * 2. Generates the witness for the task_completion circuit
 * 3. Creates the Groth16 proof via sunspot
 *
 * @param params - Proof generation parameters
 * @returns Proof result including proof bytes and public inputs
 */
export async function generateProof(params: ProofGenerationParams): Promise<ProofResult> {
  const circuitPath = params.circuitPath || DEFAULT_CIRCUIT_PATH;
  const hashHelperPath = params.hashHelperPath || DEFAULT_HASH_HELPER_PATH;

  validateCircuitPath(circuitPath);
  validateCircuitPath(hashHelperPath);

  const startTime = Date.now();

  // Step 1: Compute hashes using the hash_helper circuit
  const hashes = await computeHashesViaNargo(
    params.taskPda,
    params.agentPubkey,
    params.output,
    params.salt,
    hashHelperPath
  );

  // Step 2: Write Prover.toml for task_completion circuit
  const proverTomlPath = path.join(circuitPath, 'Prover.toml');
  const targetDir = path.join(circuitPath, 'target');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(
    proverTomlPath,
    generateProverToml(params.taskPda, params.agentPubkey, params.output, params.salt, hashes)
  );

  // Step 3: Execute circuit and generate proof
  const proofOutputPath = path.join(circuitPath, 'target/task_completion.proof');
  const witnessPath = path.join(circuitPath, 'target/task_completion.gz');

  try {
    execSync('nargo execute', { cwd: circuitPath, stdio: 'pipe', timeout: 120000 });
    execSync(
      'sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof',
      { cwd: circuitPath, stdio: 'pipe', timeout: 300000 }
    );

    const proof = fs.readFileSync(proofOutputPath);
    const publicWitness = fs.readFileSync(witnessPath);

    return {
      proof,
      publicWitness,
      constraintHash: bigintToBytes32(hashes.constraintHash),
      outputCommitment: bigintToBytes32(hashes.outputCommitment),
      expectedBinding: bigintToBytes32(hashes.expectedBinding),
      proofSize: proof.length,
      generationTime: Date.now() - startTime,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Proof generation failed: ${message}`);
  }
}

export async function verifyProofLocally(
  proof: Buffer,
  publicWitness: Buffer,
  circuitPath: string = DEFAULT_CIRCUIT_PATH
): Promise<boolean> {
  validateCircuitPath(circuitPath);

  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  const proofPath = path.join(circuitPath, `target/verify_test_${uniqueSuffix}.proof`);
  const witnessPath = path.join(circuitPath, `target/verify_test_${uniqueSuffix}.pw`);
  const relativeProofPath = `target/verify_test_${uniqueSuffix}.proof`;
  const relativeWitnessPath = `target/verify_test_${uniqueSuffix}.pw`;

  fs.writeFileSync(proofPath, proof);
  fs.writeFileSync(witnessPath, publicWitness);

  try {
    execSync(
      `sunspot verify target/task_completion.ccs target/task_completion.vk ${relativeProofPath} ${relativeWitnessPath}`,
      { cwd: circuitPath, stdio: 'pipe', timeout: 60000 }
    );
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(proofPath); } catch { /* file may not exist */ }
    try { fs.unlinkSync(witnessPath); } catch { /* file may not exist */ }
  }
}

export interface ToolsStatus {
  nargo: boolean;
  sunspot: boolean;
  nargoVersion?: string;
  sunspotVersion?: string;
}

/**
 * Check if required tools (nargo, sunspot) are available.
 * @returns Status of each tool including version if available
 */
export function checkToolsAvailable(): ToolsStatus {
  const result: ToolsStatus = { nargo: false, sunspot: false };

  try {
    const nargoOutput = execSync('nargo --version', { stdio: 'pipe', encoding: 'utf-8' });
    result.nargo = true;
    result.nargoVersion = nargoOutput.trim();
  } catch {}

  try {
    const sunspotOutput = execSync('sunspot --version', { stdio: 'pipe', encoding: 'utf-8' });
    result.sunspot = true;
    result.sunspotVersion = sunspotOutput.trim();
  } catch {}

  return result;
}

/**
 * Throws an error with installation instructions if required tools are missing.
 * @param requireSunspot - Whether sunspot is required (default: true)
 */
export function requireTools(requireSunspot: boolean = true): void {
  const tools = checkToolsAvailable();

  if (!tools.nargo) {
    throw new Error(
      'nargo not found. Install with:\n' +
      '  curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash\n' +
      '  noirup\n\n' +
      'See: https://noir-lang.org/docs/getting_started/installation'
    );
  }

  if (requireSunspot && !tools.sunspot) {
    throw new Error(
      'sunspot not found. Install with:\n' +
      '  1. Install Go 1.21+\n' +
      '  2. git clone https://github.com/Sunspot-Network/sunspot\n' +
      '  3. cd sunspot/go && go build -o sunspot\n' +
      '  4. Add to PATH\n\n' +
      'See: circuits/README.md for detailed instructions'
    );
  }
}

// Legacy exports for backwards compatibility (these use JS hashes which may not match circuit)
// DEPRECATED: Use computeHashesViaNargo instead

import { poseidon2Hash } from '@zkpassport/poseidon2';

/** Base for byte-to-field conversion */
const BYTE_BASE = 256n;

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
  for (const byte of bytes) {
    field = (field * BYTE_BASE + BigInt(byte)) % FIELD_MODULUS;
  }
  return field;
}

/** @deprecated Use computeHashesViaNargo instead - JS hash may not match circuit */
export function computeConstraintHash(output: bigint[]): bigint {
  console.warn('DEPRECATED: computeConstraintHash uses JS Poseidon2 which may not match circuit. Use computeHashesViaNargo instead.');
  if (output.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(`Output must be exactly ${OUTPUT_FIELD_COUNT} field elements`);
  }
  return poseidon2Hash(output.map((x) => x % FIELD_MODULUS));
}

/** @deprecated Use computeHashesViaNargo instead - JS hash may not match circuit */
export function computeCommitment(constraintHash: bigint, salt: bigint): bigint {
  console.warn('DEPRECATED: computeCommitment uses JS Poseidon2 which may not match circuit. Use computeHashesViaNargo instead.');
  return poseidon2Hash([constraintHash % FIELD_MODULUS, salt % FIELD_MODULUS, 0n, 0n]);
}

/** @deprecated Use computeHashesViaNargo instead - JS hash may not match circuit */
export function computeExpectedBinding(
  taskPda: PublicKey,
  agentPubkey: PublicKey,
  outputCommitment: bigint
): bigint {
  console.warn('DEPRECATED: computeExpectedBinding uses JS Poseidon2 which may not match circuit. Use computeHashesViaNargo instead.');
  const taskField = pubkeyToField(taskPda);
  const agentField = pubkeyToField(agentPubkey);
  const binding = poseidon2Hash([taskField, agentField, 0n, 0n]);
  return poseidon2Hash([binding, outputCommitment % FIELD_MODULUS, 0n, 0n]);
}
