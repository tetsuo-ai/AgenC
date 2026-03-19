/**
 * Register a real agent on devnet using @tetsuo-ai/sdk + @tetsuo-ai/protocol
 * Usage: npx tsx register-agent.ts
 */

import { Connection, Keypair } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import {
  registerAgent,
  getAgent,
  deriveAgentPda,
  PROGRAM_ID,
  DEVNET_RPC,
} from '@tetsuo-ai/sdk';
import { AGENC_COORDINATION_IDL } from '@tetsuo-ai/protocol';

// Load real wallet
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(
    readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf-8')
  ))
);

const connection = new Connection(DEVNET_RPC, 'confirmed');
const provider = new AnchorProvider(connection, new Wallet(keypair), {
  commitment: 'confirmed',
});
const program = new Program(AGENC_COORDINATION_IDL as any, provider);

// Derive a deterministic 32-byte agentId from the wallet pubkey
const agentId = keypair.publicKey.toBytes();
const agentPda = deriveAgentPda(agentId, PROGRAM_ID);

async function main() {
  console.log('=== AgenC Agent Registration ===');
  console.log('Wallet:   ', keypair.publicKey.toBase58());
  console.log('Program:  ', PROGRAM_ID.toBase58());
  console.log('Agent PDA:', agentPda.toBase58());

  // Check if already registered
  console.log('\nChecking if agent already registered...');
  const existing = await getAgent(program, agentPda);
  if (existing) {
    console.log('Agent already registered!');
    console.log('  Status:     ', existing.status);
    console.log('  Stake:      ', existing.stakeAmount.toString(), 'lamports');
    console.log('  Endpoint:   ', existing.endpoint);
    console.log('  Reputation: ', existing.reputation);
    return;
  }

  console.log('Not registered. Registering now...');
  const { agentPda: pda, txSignature } = await registerAgent(
    connection,
    program,
    keypair,
    {
      agentId,
      capabilities: 0b1111n,  // text-gen + code-gen + doc-summary + research
      endpoint: 'https://letterj.agenc.dev/agent',
      metadataUri: null,
      stakeAmount: 100_000_000n  // 0.1 SOL minimum,  // 0.001 SOL minimum stake
    }
  );

  console.log('\n✅ Agent registered!');
  console.log('  TX:        ', txSignature);
  console.log('  Agent PDA: ', pda.toBase58());

  // Read back on-chain state
  const agent = await getAgent(program, pda);
  if (agent) {
    console.log('\nOn-chain state:');
    console.log('  Status:     ', agent.status);
    console.log('  Stake:      ', agent.stakeAmount.toString(), 'lamports');
    console.log('  Endpoint:   ', agent.endpoint);
    console.log('  Reputation: ', agent.reputation);
  }
}

main().catch(console.error);
