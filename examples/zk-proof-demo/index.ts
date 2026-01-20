/**
 * AgenC ZK Proof Generation Demo
 *
 * This example demonstrates the full ZK proof flow using the AgenC SDK:
 * 1. Compute hashes via the hash_helper circuit (nargo)
 * 2. Generate a Groth16 proof via sunspot
 * 3. Verify the proof locally
 *
 * Prerequisites:
 * - nargo installed (noirup)
 * - sunspot installed (see circuits/README.md)
 * - Circuits compiled with proving keys generated
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import {
  generateProof,
  verifyProofLocally,
  generateSalt,
  computeHashesViaNargo,
  checkToolsAvailable,
  ProofGenerationParams,
} from '@agenc/sdk';
import chalk from 'chalk';

const CIRCUITS_PATH = '../../circuits/task_completion';
const HASH_HELPER_PATH = '../../circuits/hash_helper';

async function main() {
  console.log(chalk.bold.white('\n========================================'));
  console.log(chalk.bold.white('   AgenC ZK Proof Generation Demo'));
  console.log(chalk.bold.white('========================================\n'));

  // Check tools are available
  console.log(chalk.cyan('Checking prerequisites...'));
  const tools = checkToolsAvailable();

  if (!tools.nargo) {
    console.log(chalk.red('nargo not found. Install with: noirup'));
    process.exit(1);
  }
  console.log(chalk.green('  nargo: installed'));

  if (!tools.sunspot) {
    console.log(chalk.red('sunspot not found. See circuits/README.md for installation.'));
    process.exit(1);
  }
  console.log(chalk.green('  sunspot: installed'));

  // Generate test data
  console.log(chalk.cyan('\nGenerating test data...'));

  // Simulate a task PDA (in real usage this comes from on-chain)
  const taskPda = Keypair.generate().publicKey;
  console.log(chalk.gray('  Task PDA:'), taskPda.toBase58().slice(0, 20) + '...');

  // Agent's public key
  const agentKeypair = Keypair.generate();
  console.log(chalk.gray('  Agent:'), agentKeypair.publicKey.toBase58().slice(0, 20) + '...');

  // Task output (what the agent computed privately)
  const output: bigint[] = [1n, 2n, 3n, 4n];
  console.log(chalk.gray('  Output:'), `[${output.join(', ')}]`);

  // Generate cryptographically secure salt
  const salt = generateSalt();
  console.log(chalk.gray('  Salt:'), salt.toString().slice(0, 20) + '...');

  // Step 1: Compute hashes using the hash_helper circuit
  console.log(chalk.cyan('\nStep 1: Computing hashes via nargo...'));
  const startHash = Date.now();

  try {
    const hashes = await computeHashesViaNargo(
      taskPda,
      agentKeypair.publicKey,
      output,
      salt,
      HASH_HELPER_PATH
    );

    console.log(chalk.green('  Hashes computed successfully!'));
    console.log(chalk.gray('  Constraint hash:'), '0x' + hashes.constraintHash.toString(16).slice(0, 16) + '...');
    console.log(chalk.gray('  Output commitment:'), '0x' + hashes.outputCommitment.toString(16).slice(0, 16) + '...');
    console.log(chalk.gray('  Expected binding:'), '0x' + hashes.expectedBinding.toString(16).slice(0, 16) + '...');
    console.log(chalk.gray('  Time:'), Date.now() - startHash, 'ms');
  } catch (error) {
    console.log(chalk.red('  Hash computation failed:'), error);
    console.log(chalk.yellow('\n  Make sure circuits are compiled:'));
    console.log(chalk.yellow('    cd circuits/hash_helper && nargo compile'));
    process.exit(1);
  }

  // Step 2: Generate proof
  console.log(chalk.cyan('\nStep 2: Generating ZK proof...'));
  console.log(chalk.gray('  This may take 30-60 seconds...'));

  const params: ProofGenerationParams = {
    taskPda,
    agentPubkey: agentKeypair.publicKey,
    output,
    salt,
    circuitPath: CIRCUITS_PATH,
    hashHelperPath: HASH_HELPER_PATH,
  };

  let proofResult;
  try {
    proofResult = await generateProof(params);
    console.log(chalk.green('  Proof generated successfully!'));
    console.log(chalk.gray('  Proof size:'), proofResult.proofSize, 'bytes');
    console.log(chalk.gray('  Generation time:'), proofResult.generationTime, 'ms');
    console.log(chalk.gray('  Constraint hash:'), proofResult.constraintHash.toString('hex').slice(0, 16) + '...');
    console.log(chalk.gray('  Output commitment:'), proofResult.outputCommitment.toString('hex').slice(0, 16) + '...');
  } catch (error) {
    console.log(chalk.red('  Proof generation failed:'), error);
    console.log(chalk.yellow('\n  Make sure proving keys exist:'));
    console.log(chalk.yellow('    cd circuits/task_completion'));
    console.log(chalk.yellow('    nargo compile && sunspot setup target/task_completion.ccs'));
    process.exit(1);
  }

  // Step 3: Verify proof locally
  console.log(chalk.cyan('\nStep 3: Verifying proof locally...'));

  try {
    const valid = await verifyProofLocally(
      proofResult.proof,
      proofResult.publicWitness,
      CIRCUITS_PATH
    );

    if (valid) {
      console.log(chalk.green('  Proof verified successfully!'));
    } else {
      console.log(chalk.red('  Proof verification failed!'));
      process.exit(1);
    }
  } catch (error) {
    console.log(chalk.red('  Verification error:'), error);
    process.exit(1);
  }

  // Summary
  console.log(chalk.bold.green('\n========================================'));
  console.log(chalk.bold.green('   Demo Complete!'));
  console.log(chalk.bold.green('========================================\n'));

  console.log(chalk.white('The proof demonstrates that the agent:'));
  console.log(chalk.gray('  1. Knows an output that satisfies the task constraint'));
  console.log(chalk.gray('  2. Committed to that output with a random salt'));
  console.log(chalk.gray('  3. Is bound to this specific task and agent identity'));
  console.log();
  console.log(chalk.white('The proof does NOT reveal:'));
  console.log(chalk.gray('  - The actual output values [1, 2, 3, 4]'));
  console.log(chalk.gray('  - The salt used for the commitment'));
  console.log();
  console.log(chalk.white('On-chain verification:'));
  console.log(chalk.gray('  The 388-byte proof can be submitted to the Sunspot'));
  console.log(chalk.gray('  verifier program on Solana for on-chain verification.'));
  console.log(chalk.gray('  Verifier Program ID: 8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ'));
  console.log();
}

main().catch((error) => {
  console.error(chalk.red('Error:'), error);
  process.exit(1);
});
