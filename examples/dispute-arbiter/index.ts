/**
 * Dispute Arbiter Agent
 *
 * Demonstrates an agent that monitors the AgenC protocol for disputes,
 * evaluates evidence, and votes on outcomes using DisputeOperations.
 *
 * The agent:
 *   1. Registers with ARBITER capability and sufficient stake
 *   2. Subscribes to real-time dispute events via WebSocket
 *   3. Periodically polls for active disputes it hasn't voted on
 *   4. Evaluates dispute evidence and casts votes
 *
 * Usage:
 *   npx tsx examples/dispute-arbiter/index.ts
 *
 * Environment:
 *   SOLANA_RPC_URL - RPC endpoint (default: devnet)
 *   KEYPAIR_PATH   - Path to keypair file (default: ~/.config/solana/id.json)
 *   MIN_STAKE      - Arbiter stake in SOL (default: 1.0)
 *   POLL_INTERVAL  - Dispute poll interval in ms (default: 15000)
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import {
  AgentRuntime,
  AgentCapabilities,
  DisputeOperations,
  OnChainDisputeStatus,
  subscribeToAllDisputeEvents,
  createProgram,
  keypairToWallet,
  createLogger,
  generateAgentId,
  bytesToHex,
  loadDefaultKeypair,
  type OnChainDispute,
  type DisputeVoteError,
} from '@agenc/runtime';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const MIN_STAKE = parseFloat(process.env.MIN_STAKE || '1.0');
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '15000', 10);
const logger = createLogger('info', '[Arbiter]');

/** Set of dispute PDAs we've already voted on this session */
const votedDisputes = new Set<string>();

/**
 * Simple dispute evaluation logic.
 * In production, this would involve more sophisticated analysis —
 * checking on-chain evidence, comparing task outputs, etc.
 */
function evaluateDispute(dispute: OnChainDispute): boolean {
  // Approve if evidence is substantial (> 100 chars indicates detailed report)
  if (dispute.evidence.length > 100) {
    logger.info(`  Evidence is substantial (${dispute.evidence.length} chars) — approving`);
    return true;
  }

  // Reject disputes with minimal evidence
  logger.info(`  Evidence is minimal (${dispute.evidence.length} chars) — rejecting`);
  return false;
}

/**
 * Fetch active disputes and vote on any we haven't handled yet.
 */
async function processActiveDisputes(ops: DisputeOperations): Promise<void> {
  const disputes = await ops.fetchActiveDisputes();
  const pending = disputes.filter(d => !votedDisputes.has(d.pda.toBase58()));

  if (pending.length === 0) return;

  logger.info(`Found ${pending.length} dispute(s) to evaluate`);

  for (const dispute of pending) {
    const pdaShort = dispute.pda.toBase58().slice(0, 8);

    // Skip if voting deadline has passed
    const now = Math.floor(Date.now() / 1000);
    if (dispute.votingDeadline > 0 && now > dispute.votingDeadline) {
      logger.info(`Dispute ${pdaShort}... — voting ended, skipping`);
      votedDisputes.add(dispute.pda.toBase58());
      continue;
    }

    logger.info(`Evaluating dispute ${pdaShort}...`);
    logger.info(`  Task: ${dispute.taskPda.toBase58().slice(0, 8)}...`);
    logger.info(`  Votes: ${dispute.votesFor} for, ${dispute.votesAgainst} against`);

    const approve = evaluateDispute(dispute);

    try {
      const result = await ops.voteOnDispute({
        disputePda: dispute.pda,
        taskPda: dispute.taskPda,
        approve,
      });
      votedDisputes.add(dispute.pda.toBase58());
      logger.info(`  Voted ${approve ? 'APPROVE' : 'REJECT'} — TX: ${result.signature.slice(0, 16)}...`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Common: already voted, not an arbiter, voting ended
      logger.warn(`  Vote failed: ${message}`);
      votedDisputes.add(dispute.pda.toBase58());
    }
  }
}

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  AgenC Dispute Arbiter Agent');
  console.log('='.repeat(60));
  console.log('');

  // Load keypair
  let keypair: Keypair;
  try {
    keypair = await loadDefaultKeypair();
    logger.info(`Loaded keypair: ${keypair.publicKey.toBase58()}`);
  } catch {
    keypair = Keypair.generate();
    logger.info(`Generated keypair: ${keypair.publicKey.toBase58()}`);
  }

  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = keypairToWallet(keypair);

  // Check balance
  const balance = await connection.getBalance(keypair.publicKey);
  logger.info(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < (MIN_STAKE + 0.1) * LAMPORTS_PER_SOL) {
    logger.info('Requesting airdrop...');
    try {
      const sig = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      logger.info('Airdrop successful!');
    } catch (e) {
      logger.error(`Airdrop failed: ${e}`);
      process.exit(1);
    }
  }

  // Start agent runtime with ARBITER capability
  const runtime = new AgentRuntime({
    connection,
    wallet: keypair,
    capabilities: BigInt(AgentCapabilities.ARBITER | AgentCapabilities.COMPUTE),
    initialStake: BigInt(MIN_STAKE * LAMPORTS_PER_SOL),
    logLevel: 'info',
  });

  runtime.registerShutdownHandlers();
  await runtime.start();

  const agentId = runtime.getAgentId()!;
  logger.info(`Agent registered: ${bytesToHex(agentId).slice(0, 16)}...`);

  // Create program and dispute operations
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const program = createProgram(provider);
  const ops = new DisputeOperations({
    program,
    agentId,
    logger,
  });

  // Subscribe to real-time dispute events
  logger.info('Subscribing to dispute events...');
  const sub = subscribeToAllDisputeEvents(program, {
    onDisputeInitiated: (event) => {
      logger.info(`[EVENT] New dispute initiated — ID: ${bytesToHex(event.disputeId).slice(0, 16)}...`);
    },
    onDisputeVoteCast: (event) => {
      logger.info(`[EVENT] Vote cast on dispute — ${event.approved ? 'APPROVE' : 'REJECT'} (${event.votesFor}/${event.votesAgainst})`);
    },
    onDisputeResolved: (event) => {
      logger.info(`[EVENT] Dispute resolved — ${event.votesFor} for, ${event.votesAgainst} against`);
    },
    onDisputeExpired: (event) => {
      logger.info(`[EVENT] Dispute expired — refund: ${Number(event.refundAmount) / LAMPORTS_PER_SOL} SOL`);
    },
  });

  // Poll for active disputes periodically
  logger.info(`Polling for disputes every ${POLL_INTERVAL / 1000}s...`);
  logger.info('Press Ctrl+C to stop.');
  console.log('');

  const pollInterval = setInterval(async () => {
    try {
      await processActiveDisputes(ops);
    } catch (err) {
      logger.error(`Poll error: ${err instanceof Error ? err.message : err}`);
    }
  }, POLL_INTERVAL);

  // Run initial poll immediately
  await processActiveDisputes(ops).catch((err) => {
    logger.error(`Initial poll error: ${err instanceof Error ? err.message : err}`);
  });

  // Keep running until Ctrl+C
  process.on('SIGINT', async () => {
    console.log('');
    logger.info('Shutting down...');
    clearInterval(pollInterval);
    await sub.unsubscribe();
    await runtime.stop();
    logger.info(`Session summary: voted on ${votedDisputes.size} dispute(s)`);
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(console.error);
