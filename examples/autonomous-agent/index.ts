/**
 * Autonomous Agent Example
 *
 * Demonstrates an agent that automatically discovers, claims, and completes tasks.
 *
 * Usage:
 *   npx ts-node examples/autonomous-agent/index.ts
 *
 * Environment:
 *   SOLANA_RPC_URL - RPC endpoint (default: devnet)
 *   KEYPAIR_PATH - Path to keypair file (default: ~/.config/solana/id.json)
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  AutonomousAgent,
  AgentCapabilities,
  loadDefaultKeypair,
  type Task,
} from '@agenc/runtime';
import { EchoExecutor } from './executors.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  AgenC Autonomous Agent Demo');
  console.log('='.repeat(60));
  console.log('');

  // Load keypair
  let keypair: Keypair;
  try {
    keypair = await loadDefaultKeypair();
    console.log(`Loaded keypair: ${keypair.publicKey.toBase58()}`);
  } catch {
    console.log('No keypair found, generating new one...');
    keypair = Keypair.generate();
    console.log(`Generated keypair: ${keypair.publicKey.toBase58()}`);
    console.log('(Note: You will need to airdrop SOL to this address)');
  }

  const connection = new Connection(RPC_URL, 'confirmed');

  // Check balance
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.1 * LAMPORTS_PER_SOL) {
    console.log('');
    console.log('Insufficient balance. Requesting airdrop...');
    try {
      const sig = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      console.log('Airdrop successful!');
    } catch (e) {
      console.error('Airdrop failed:', e);
      console.log('Please manually fund the wallet and try again.');
      process.exit(1);
    }
  }

  console.log('');
  console.log('Starting autonomous agent...');
  console.log('');

  // Track stats
  let totalEarnings = 0n;
  const txHistory: { time: Date; type: string; task: string; tx?: string }[] = [];

  // Create the autonomous agent
  const agent = new AutonomousAgent({
    connection,
    wallet: keypair,
    capabilities: BigInt(AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE),
    initialStake: BigInt(0.5 * LAMPORTS_PER_SOL),
    logLevel: 'info',

    // Use echo executor for demo
    executor: new EchoExecutor(),

    // Task filtering
    taskFilter: {
      capabilities: BigInt(AgentCapabilities.COMPUTE),
      minReward: BigInt(0.01 * LAMPORTS_PER_SOL), // At least 0.01 SOL
    },

    // Scan every 5 seconds
    scanIntervalMs: 5000,

    // Process one task at a time
    maxConcurrentTasks: 1,

    // Callbacks
    onTaskDiscovered: (task: Task) => {
      console.log(`[DISCOVERED] Task ${task.pda.toBase58().slice(0, 8)}... (${Number(task.reward) / LAMPORTS_PER_SOL} SOL)`);
      txHistory.push({ time: new Date(), type: 'DISCOVERED', task: task.pda.toBase58().slice(0, 8) });
    },

    onTaskClaimed: (task: Task, tx: string) => {
      console.log(`[CLAIMED] Task ${task.pda.toBase58().slice(0, 8)}... TX: ${tx.slice(0, 16)}...`);
      txHistory.push({ time: new Date(), type: 'CLAIMED', task: task.pda.toBase58().slice(0, 8), tx });
    },

    onTaskCompleted: (task: Task, tx: string) => {
      console.log(`[COMPLETED] Task ${task.pda.toBase58().slice(0, 8)}... TX: ${tx.slice(0, 16)}...`);
      txHistory.push({ time: new Date(), type: 'COMPLETED', task: task.pda.toBase58().slice(0, 8), tx });
    },

    onTaskFailed: (task: Task, error: Error) => {
      console.log(`[FAILED] Task ${task.pda.toBase58().slice(0, 8)}...: ${error.message}`);
      txHistory.push({ time: new Date(), type: 'FAILED', task: task.pda.toBase58().slice(0, 8) });
    },

    onEarnings: (amount: bigint, task: Task) => {
      totalEarnings += amount;
      console.log(`[EARNINGS] +${Number(amount) / LAMPORTS_PER_SOL} SOL (Total: ${Number(totalEarnings) / LAMPORTS_PER_SOL} SOL)`);
    },

    onProofGenerated: (task: Task, proofSize: number, durationMs: number) => {
      console.log(`[PROOF] Generated ${proofSize} bytes in ${durationMs}ms`);
    },
  });

  // Register shutdown handlers
  agent.registerShutdownHandlers();

  // Start the agent
  try {
    await agent.start();
    console.log('');
    console.log('Agent is now running autonomously!');
    console.log('Scanning for tasks every 5 seconds...');
    console.log('');
    console.log('Press Ctrl+C to stop.');
    console.log('');

    // Print stats periodically
    const statsInterval = setInterval(() => {
      const stats = agent.getStats();
      console.log('');
      console.log('--- Agent Stats ---');
      console.log(`  Uptime: ${Math.floor(stats.uptimeMs / 1000)}s`);
      console.log(`  Tasks Discovered: ${stats.tasksDiscovered}`);
      console.log(`  Tasks Claimed: ${stats.tasksClaimed}`);
      console.log(`  Tasks Completed: ${stats.tasksCompleted}`);
      console.log(`  Tasks Failed: ${stats.tasksFailed}`);
      console.log(`  Total Earnings: ${Number(stats.totalEarnings) / LAMPORTS_PER_SOL} SOL`);
      console.log(`  Active Tasks: ${stats.activeTasks}`);
      if (stats.avgCompletionTimeMs > 0) {
        console.log(`  Avg Completion: ${Math.round(stats.avgCompletionTimeMs)}ms`);
      }
      console.log('-------------------');
      console.log('');
    }, 30000); // Every 30 seconds

    // Keep running until Ctrl+C
    await new Promise(() => {});

    clearInterval(statsInterval);
  } catch (error) {
    console.error('Agent error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
