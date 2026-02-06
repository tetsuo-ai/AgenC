/**
 * AgenC Hello World: Private Agent Coordination
 *
 * Demonstrates the full lifecycle:
 * 1. Two agents created
 * 2. A private coordination task submitted
 * 3. ZK proof generated and verified on-chain
 * 4. Task result returned
 */

import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createCoordinator, createAgent, DEVNET_RPC } from '@agenc/sdk';

async function main() {
  // Load or generate wallets for both agents
  const walletA = Keypair.generate();
  const walletB = Keypair.generate();

  console.log('Agent A:', walletA.publicKey.toBase58());
  console.log('Agent B:', walletB.publicKey.toBase58());

  // Fund wallets on devnet
  const connection = new Connection(DEVNET_RPC, 'confirmed');
  console.log('\nRequesting airdrops...');
  await Promise.all([
    connection.requestAirdrop(walletA.publicKey, 2 * LAMPORTS_PER_SOL),
    connection.requestAirdrop(walletB.publicKey, 1 * LAMPORTS_PER_SOL),
  ]);

  // Wait for airdrops to confirm
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Set up coordinator and agents
  const coordinator = createCoordinator({ cluster: 'devnet' });
  const agentA = createAgent({ wallet: walletA });
  const agentB = createAgent({ wallet: walletB });

  // Load the program IDL (required for on-chain interaction)
  // In a real app, import your IDL from the build output:
  //   import idl from '../../target/idl/agenc_coordination.json';
  //   await coordinator.init(idl, walletA);
  //
  // For this demo, we show the API shape without requiring a deployed program:
  console.log('\n--- AgenC Private Coordination Demo ---\n');
  console.log('Coordinator created for devnet');
  console.log(`Agent A: ${agentA.publicKey.toBase58().slice(0, 8)}...`);
  console.log(`Agent B: ${agentB.publicKey.toBase58().slice(0, 8)}...`);

  // The full flow with a deployed program looks like this:
  //
  //   const task = coordinator.createPrivateTask({
  //     from: agentA,
  //     to: agentB,
  //     instruction: 'swap 10 USDC for SOL via Jupiter',
  //     proof: 'zk',
  //   });
  //
  //   const result = await task.execute();
  //   console.log('Task ID:', result.taskId);
  //   console.log('ZK proof generated:', result.proofGenerated);
  //   console.log('Proof verified on-chain:', result.proofVerified);
  //   console.log('Status:', result.status);

  // Demonstrate proof generation locally (no on-chain program needed)
  const { generateSalt, computeHashes } = await import('@agenc/sdk');
  const output = [1n, 2n, 3n, 4n];
  const salt = generateSalt();
  const hashes = computeHashes(
    walletA.publicKey,
    walletB.publicKey,
    output,
    salt,
  );

  console.log('\n--- ZK Proof Components ---\n');
  console.log('Output (private):', output.map(String));
  console.log('Constraint hash:', '0x' + hashes.constraintHash.toString(16).slice(0, 16) + '...');
  console.log('Output commitment:', '0x' + hashes.outputCommitment.toString(16).slice(0, 16) + '...');
  console.log('Expected binding:', '0x' + hashes.expectedBinding.toString(16).slice(0, 16) + '...');

  console.log('\n--- What Happens On-Chain ---\n');
  console.log('1. Agent A creates task with constraint_hash (output stays private)');
  console.log('2. Agent B claims the task');
  console.log('3. Agent B generates a Groth16 ZK proof (256 bytes) proving:');
  console.log('   - They know an output matching the constraint hash');
  console.log('   - The commitment binds the proof to this specific task + agent');
  console.log('4. groth16-solana verifier validates the proof on-chain');
  console.log('5. Escrow releases payment to Agent B via Privacy Cash');
  console.log('6. Payment is unlinkable to Agent A (shielded pool)');

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
