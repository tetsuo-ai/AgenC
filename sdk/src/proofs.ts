/**
 * Proof Generation Helpers for AgenC
 *
 * Utilities for generating and verifying ZK proofs using Noir/Sunspot
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PublicKey } from '@solana/web3.js';

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
 * Validate circuit path to prevent path traversal attacks
 * @param circuitPath - The path to validate
 * @returns The normalized, validated path
 * @throws Error if path is invalid or attempts traversal
 */
function validateCircuitPath(circuitPath: string): string {
  // Normalize the path
  const normalizedPath = path.normalize(circuitPath);

  // Check for path traversal attempts
  if (normalizedPath.includes('..')) {
    throw new Error('SECURITY: Path traversal detected in circuit path. ".." is not allowed.');
  }

  // Ensure path doesn't escape to root or absolute paths outside expected locations
  if (path.isAbsolute(normalizedPath) && !normalizedPath.startsWith(process.cwd())) {
    throw new Error('SECURITY: Circuit path must be relative or within the current working directory.');
  }

  return normalizedPath;
}

/**
 * Generate a ZK proof for task completion
 *
 * Requires nargo and sunspot CLI tools to be installed
 *
 * @security The circuitPath parameter is validated to prevent path traversal attacks.
 */
export async function generateProof(params: ProofGenerationParams): Promise<ProofResult> {
  // Validate and normalize circuit path to prevent path traversal
  const circuitPath = validateCircuitPath(params.circuitPath || './circuits/task_completion');
  const startTime = Date.now();

  // Generate Prover.toml content
  const proverToml = generateProverToml(params);
  const proverPath = path.join(circuitPath, 'Prover.toml');

  // Write prover file
  fs.writeFileSync(proverPath, proverToml);

  try {
    // Execute Noir circuit to generate witness
    execSync('nargo execute', {
      cwd: circuitPath,
      stdio: 'pipe',
    });

    // Generate proof using Sunspot
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
 *
 * @security The circuitPath parameter is validated to prevent path traversal attacks.
 */
export async function verifyProofLocally(
  proof: Buffer,
  publicWitness: Buffer,
  circuitPath: string = './circuits/task_completion'
): Promise<boolean> {
  // Validate circuit path to prevent path traversal
  const validatedPath = validateCircuitPath(circuitPath);
  const proofPath = path.join(validatedPath, 'target/verify_test.proof');
  const witnessPath = path.join(validatedPath, 'target/verify_test.pw');

  // Write proof and witness to temp files
  fs.writeFileSync(proofPath, proof);
  fs.writeFileSync(witnessPath, publicWitness);

  try {
    execSync(
      `sunspot verify target/task_completion.ccs target/task_completion.vk ${proofPath} ${witnessPath}`,
      {
        cwd: validatedPath,
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
 *
 * SECURITY WARNING: This function currently uses a placeholder implementation.
 * For production use, you MUST integrate a proper Poseidon2 library that matches
 * the Noir circuit's poseidon2_permutation function.
 *
 * Recommended libraries:
 * - circomlibjs (npm install circomlibjs)
 * - @iden3/js-crypto (for BN254 curve compatibility)
 *
 * @throws Error if used in production without proper implementation
 */
export function computeConstraintHashFromOutput(output: bigint[]): Buffer {
  if (output.length !== 4) {
    throw new Error('Output must be exactly 4 field elements');
  }

  // CRITICAL: Check if we're in production mode
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    throw new Error(
      'SECURITY: computeConstraintHashFromOutput requires a proper Poseidon2 implementation for production. ' +
      'The placeholder hash is NOT cryptographically secure. ' +
      'Please integrate circomlibjs or @iden3/js-crypto with BN254 curve support.'
    );
  }

  // Development-only placeholder - logs warning on every call
  console.warn(
    '[SECURITY WARNING] computeConstraintHashFromOutput: Using insecure placeholder hash. ' +
    'Do NOT use in production!'
  );

  // Deterministic but insecure placeholder for development/testing only
  const hash = Buffer.alloc(32);
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
 *
 * SECURITY WARNING: This function currently uses a placeholder implementation.
 * XOR is NOT a secure commitment scheme. For production, implement Poseidon2
 * to match the Noir circuit.
 *
 * @throws Error if used in production without proper implementation
 */
export function computeCommitment(constraintHash: bigint, salt: bigint): bigint {
  // CRITICAL: Check if we're in production mode
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    throw new Error(
      'SECURITY: computeCommitment requires a proper Poseidon2 implementation for production. ' +
      'XOR is NOT a cryptographically secure commitment scheme. ' +
      'Please integrate circomlibjs or @iden3/js-crypto with BN254 curve support.'
    );
  }

  // Development-only placeholder - logs warning on every call
  console.warn(
    '[SECURITY WARNING] computeCommitment: Using insecure XOR placeholder. ' +
    'Do NOT use in production!'
  );

  // Insecure placeholder for development/testing only
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
