/**
 * Simple AgenC SDK usage with the RISC0 private payload model.
 *
 * Usage:
 *   npx tsx examples/simple-usage/index.ts
 */

import { PublicKey } from '@solana/web3.js';
import {
  PROGRAM_ID,
  TRUSTED_RISC0_SELECTOR,
  generateSalt,
  computeHashes,
  bigintToBytes32,
} from '@agenc/sdk';

const ROUTER_PROGRAM_ID = new PublicKey('6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7');
const VERIFIER_PROGRAM_ID = new PublicKey('THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge');
const ROUTER_SEED = Buffer.from('router');
const VERIFIER_SEED = Buffer.from('verifier');
const BINDING_SPEND_SEED = Buffer.from('binding_spend');
const NULLIFIER_SPEND_SEED = Buffer.from('nullifier_spend');

function deriveSubmissionAccounts(bindingSeed: Buffer, nullifierSeed: Buffer) {
  const [bindingSpend] = PublicKey.findProgramAddressSync(
    [BINDING_SPEND_SEED, bindingSeed],
    PROGRAM_ID,
  );
  const [nullifierSpend] = PublicKey.findProgramAddressSync(
    [NULLIFIER_SPEND_SEED, nullifierSeed],
    PROGRAM_ID,
  );
  const [router] = PublicKey.findProgramAddressSync(
    [ROUTER_SEED],
    ROUTER_PROGRAM_ID,
  );
  const [verifierEntry] = PublicKey.findProgramAddressSync(
    [VERIFIER_SEED, Buffer.from(TRUSTED_RISC0_SELECTOR)],
    ROUTER_PROGRAM_ID,
  );

  return {
    routerProgram: ROUTER_PROGRAM_ID,
    router,
    verifierEntry,
    verifierProgram: VERIFIER_PROGRAM_ID,
    bindingSpend,
    nullifierSpend,
  };
}

async function main() {
  const taskPda = new PublicKey('5oW3w7vxaX4jA5de7AaShARQnTPN9JMWVqoB2RQ5x7h7');
  const agentPubkey = new PublicKey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  const output = [1n, 2n, 3n, 4n];
  const salt = generateSalt();

  console.log('Computing private payload hashes...');
  // Actual seal generation requires: generateProof(params, proverConfig)
  // with a local-binary or remote prover backend.
  const hashes = computeHashes(taskPda, agentPubkey, output, salt);

  const bindingSeed = bigintToBytes32(hashes.binding);
  const nullifierSeed = bigintToBytes32(hashes.nullifier);
  const accounts = deriveSubmissionAccounts(bindingSeed, nullifierSeed);

  console.log('Hash values:');
  console.log('  constraintHash:', hashes.constraintHash.toString(16).substring(0, 16) + '...');
  console.log('  outputCommitment:', hashes.outputCommitment.toString(16).substring(0, 16) + '...');
  console.log('  binding:', hashes.binding.toString(16).substring(0, 16) + '...');
  console.log('  nullifier:', hashes.nullifier.toString(16).substring(0, 16) + '...');

  console.log('\nSubmission accounts:');
  console.log('  routerProgram:', accounts.routerProgram.toBase58());
  console.log('  router:', accounts.router.toBase58());
  console.log('  verifierEntry:', accounts.verifierEntry.toBase58());
  console.log('  verifierProgram:', accounts.verifierProgram.toBase58());
  console.log('  bindingSpend:', accounts.bindingSpend.toBase58());
  console.log('  nullifierSpend:', accounts.nullifierSpend.toBase58());
}

main().catch(console.error);
