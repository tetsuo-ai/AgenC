/**
 * Simple AgenC SDK Usage Example
 *
 * Shows the minimal code needed to:
 * 1. Generate a salt
 * 2. Compute hashes for proof inputs
 * 3. Generate and verify a proof
 */

import { Keypair } from '@solana/web3.js';
import {
  generateSalt,
  computeHashes,
  generateProof,
  verifyProofLocally,
  checkToolsAvailable,
} from '@agenc/sdk';

async function main() {
  // Check prerequisites
  const tools = checkToolsAvailable();
  if (!tools.snarkjs) {
    console.error('Missing snarkjs. Install with: npm install snarkjs');
    process.exit(1);
  }

  // Your task and agent identities
  const taskPda = Keypair.generate().publicKey;
  const agentPubkey = Keypair.generate().publicKey;

  // The private output you want to prove (without revealing)
  const output = [1n, 2n, 3n, 4n];

  // Generate a secure random salt (NEVER reuse salts!)
  const salt = generateSalt();

  // Compute the hashes that will be public inputs
  // Uses poseidon-lite for circomlib-compatible hashing
  console.log('Computing hashes...');
  const hashes = computeHashes(taskPda, agentPubkey, output, salt);

  console.log('Constraint hash:', hashes.constraintHash.toString(16).slice(0, 16) + '...');
  console.log('Output commitment:', hashes.outputCommitment.toString(16).slice(0, 16) + '...');

  // Generate the proof
  console.log('\nGenerating proof (this takes ~30-60s)...');
  const result = await generateProof({
    taskPda,
    agentPubkey,
    output,
    salt,
    circuitPath: './circuits-circom/task_completion',
  });

  console.log('Proof size:', result.proofSize, 'bytes');
  console.log('Generation time:', result.generationTime, 'ms');

  // Verify locally
  console.log('\nVerifying proof...');
  const publicSignals = [
    hashes.constraintHash,
    hashes.outputCommitment,
    hashes.expectedBinding,
  ];
  const valid = await verifyProofLocally(
    result.proof,
    publicSignals,
    './circuits-circom/task_completion'
  );

  console.log('Valid:', valid);

  // The proof bytes can now be submitted on-chain
  console.log('\nProof ready for on-chain submission!');
  console.log('Use completeTaskPrivate() to submit.');
}

main().catch(console.error);
