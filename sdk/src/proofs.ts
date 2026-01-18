/**
 * Proof Generation Helpers for AgenC
 *
 * Utilities for generating and verifying ZK proofs using Noir/Sunspot
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PublicKey } from '@solana/web3.js';

/** Allowlist of valid circuit names */
const VALID_CIRCUIT_NAMES = ['task_completion', 'payment_proof', 'identity_proof'] as const;

/**
 * Sanitize and validate circuit path to prevent command injection
 * @throws Error if path is invalid or contains dangerous characters
 */
function sanitizeCircuitPath(circuitPath: string): string {
  // Normalize the path
  const normalized = path.normalize(circuitPath);

  // Check for path traversal attempts
  if (normalized.includes('..')) {
    throw new Error('Invalid circuit path: path traversal not allowed');
  }

  // Check for dangerous shell characters
  const dangerousChars = /[;&|`$(){}[\]<>\\'"!#*?~\n\r]/;
  if (dangerousChars.test(normalized)) {
    throw new Error('Invalid circuit path: contains disallowed characters');
  }

  // Extract circuit name from path and validate against allowlist
  const circuitName = path.basename(normalized);
  if (!VALID_CIRCUIT_NAMES.includes(circuitName as typeof VALID_CIRCUIT_NAMES[number])) {
    throw new Error(`Invalid circuit name: ${circuitName}. Allowed: ${VALID_CIRCUIT_NAMES.join(', ')}`);
  }

  // Verify the path exists and is a directory
  if (!fs.existsSync(normalized)) {
    throw new Error(`Circuit path does not exist: ${normalized}`);
  }

  const stats = fs.statSync(normalized);
  if (!stats.isDirectory()) {
    throw new Error(`Circuit path is not a directory: ${normalized}`);
  }

  return normalized;
}

export interface ProofGenerationParams {
  /** Task ID */
  taskId: number;
  /** Agent's public key */
  agentPubkey: PublicKey;
  /** Hash of expected output (public) */
  constraintHash: Buffer;
  /** Commitment to actual output (public) */
  outputCommitment: bigint;
  /** Actual task output (private, 4 fields) */
  output: bigint[];
  /** Random salt for commitment (private) */
  salt: bigint;
  /** Path to circuit directory */
  circuitPath?: string;
}

export interface ProofResult {
  /** Raw ZK proof bytes */
  proof: Buffer;
  /** Public witness data */
  publicWitness: Buffer;
  /** Proof size in bytes */
  proofSize: number;
  /** Generation time in ms */
  generationTime: number;
}

/**
 * Generate a ZK proof for task completion
 *
 * Requires nargo and sunspot CLI tools to be installed
 */
export async function generateProof(params: ProofGenerationParams): Promise<ProofResult> {
  // Sanitize circuit path to prevent command injection
  const circuitPath = sanitizeCircuitPath(params.circuitPath || './circuits/task_completion');
  const startTime = Date.now();

  // Generate Prover.toml content
  const proverToml = generateProverToml(params);
  const proverPath = path.join(circuitPath, 'Prover.toml');

  // Write prover file
  fs.writeFileSync(proverPath, proverToml);

  try {
    // Execute Noir circuit to generate witness
    // Using cwd option instead of string interpolation for safety
    execSync('nargo execute', {
      cwd: circuitPath,
      stdio: 'pipe',
    });

    // Generate proof using Sunspot
    // Command uses only static strings; circuitPath is validated and only used as cwd
    execSync(
      'sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof',
      {
        cwd: circuitPath,
        stdio: 'pipe',
      }
    );

    // Read proof and public witness
    const proof = fs.readFileSync(path.join(circuitPath, 'target/task_completion.proof'));
    const publicWitness = fs.readFileSync(path.join(circuitPath, 'target/task_completion.pw'));

    const generationTime = Date.now() - startTime;

    return {
      proof,
      publicWitness,
      proofSize: proof.length,
      generationTime,
    };
  } catch (error: any) {
    throw new Error(`Proof generation failed: ${error.message}`);
  }
}

/**
 * Verify a proof locally (without on-chain submission)
 *
 * Useful for testing before submitting to chain
 */
export async function verifyProofLocally(
  proof: Buffer,
  publicWitness: Buffer,
  circuitPath: string = './circuits/task_completion'
): Promise<boolean> {
  // Sanitize circuit path to prevent command injection
  const sanitizedPath = sanitizeCircuitPath(circuitPath);
  const proofPath = path.join(sanitizedPath, 'target/verify_test.proof');
  const witnessPath = path.join(sanitizedPath, 'target/verify_test.pw');

  // Write proof and witness to temp files
  fs.writeFileSync(proofPath, proof);
  fs.writeFileSync(witnessPath, publicWitness);

  try {
    // Use static command with cwd; proof/witness paths are constructed from sanitized base
    execSync(
      'sunspot verify target/task_completion.ccs target/task_completion.vk target/verify_test.proof target/verify_test.pw',
      {
        cwd: sanitizedPath,
        stdio: 'pipe',
      }
    );
    return true;
  } catch {
    return false;
  } finally {
    // Cleanup
    try {
      fs.unlinkSync(proofPath);
      fs.unlinkSync(witnessPath);
    } catch {}
  }
}

/**
 * Generate Prover.toml content for the circuit
 */
function generateProverToml(params: ProofGenerationParams): string {
  const agentBytes = Array.from(params.agentPubkey.toBytes());

  return `# Auto-generated Prover.toml for AgenC task completion proof
task_id = "${params.taskId}"
agent_pubkey = [${agentBytes.join(', ')}]
constraint_hash = "0x${params.constraintHash.toString('hex')}"
output_commitment = "0x${params.outputCommitment.toString(16)}"
output = [${params.output.map((o) => `"${o.toString()}"`).join(', ')}]
salt = "${params.salt.toString()}"
`;
}

/**
 * Compute constraint hash from expected output
 *
 * Uses Poseidon2 hash matching the Noir circuit
 * Note: This is a placeholder - use a proper Poseidon2 implementation
 */
export function computeConstraintHashFromOutput(output: bigint[]): Buffer {
  if (output.length !== 4) {
    throw new Error('Output must be exactly 4 field elements');
  }

  // TODO: Implement actual Poseidon2 hash matching Noir's poseidon2_permutation
  // For now, return placeholder
  console.warn('computeConstraintHashFromOutput: Requires Poseidon2 implementation');

  const hash = Buffer.alloc(32);
  // Simple placeholder hash for development
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.from(output[i].toString(16).padStart(16, '0'), 'hex');
    for (let j = 0; j < bytes.length && i * 8 + j < 32; j++) {
      hash[i * 8 + j] = bytes[j];
    }
  }
  return hash;
}

/**
 * Compute output commitment from constraint hash and salt
 *
 * commitment = poseidon2([constraint_hash, salt, 0, 0])[0]
 */
export function computeCommitment(constraintHash: bigint, salt: bigint): bigint {
  // TODO: Implement actual Poseidon2 hash
  console.warn('computeCommitment: Requires Poseidon2 implementation');

  // Placeholder
  return constraintHash ^ salt;
}

/**
 * Generate a random salt for commitment
 */
export function generateSalt(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let salt = BigInt(0);
  for (const byte of bytes) {
    salt = (salt << 8n) | BigInt(byte);
  }
  // Ensure it fits in a field element (roughly)
  return salt % (2n ** 254n);
}

/**
 * Check if required CLI tools are available
 */
export function checkToolsAvailable(): { nargo: boolean; sunspot: boolean } {
  let nargo = false;
  let sunspot = false;

  try {
    execSync('nargo --version', { stdio: 'pipe' });
    nargo = true;
  } catch {}

  try {
    execSync('sunspot --version', { stdio: 'pipe' });
    sunspot = true;
  } catch {}

  return { nargo, sunspot };
}
