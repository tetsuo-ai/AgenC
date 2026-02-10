/**
 * Real-Time Protocol Dashboard
 *
 * Demonstrates real-time monitoring of all AgenC protocol events using
 * the EventMonitor class. Runs in read-only mode — no wallet required.
 *
 * Event categories monitored:
 *   - Task events:     created, claimed, completed, cancelled
 *   - Dispute events:  initiated, vote cast, resolved, expired
 *   - Protocol events: initialized, reward distributed, rate limit hit,
 *                      migration completed, version updated, state updated
 *   - Agent events:    registered, updated, deregistered
 *
 * Usage:
 *   npx ts-node examples/event-dashboard/index.ts
 *
 * Environment:
 *   SOLANA_RPC_URL - RPC endpoint (default: devnet)
 *   STATS_INTERVAL - Stats print interval in ms (default: 30000)
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  EventMonitor,
  createReadOnlyProgram,
  createLogger,
  bytesToHex,
  lamportsToSol,
  // Event types for callbacks
  type TaskCreatedEvent,
  type TaskClaimedEvent,
  type TaskCompletedEvent,
  type TaskCancelledEvent,
  type DisputeInitiatedEvent,
  type DisputeVoteCastEvent,
  type DisputeResolvedEvent,
  type DisputeExpiredEvent,
  type ProtocolInitializedEvent,
  type RewardDistributedEvent,
  type RateLimitHitEvent,
  type AgentRegisteredEvent,
  type AgentUpdatedEvent,
  type AgentDeregisteredEvent,
} from '@agenc/runtime';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const STATS_INTERVAL = parseInt(process.env.STATS_INTERVAL || '30000', 10);
const logger = createLogger('info', '[Dashboard]');

/** Format a hex ID for display */
function shortId(id: Uint8Array | number[]): string {
  return bytesToHex(id instanceof Uint8Array ? id : new Uint8Array(id)).slice(0, 12);
}

/** Format a timestamp */
function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString();
}

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  AgenC Real-Time Protocol Dashboard');
  console.log('='.repeat(60));
  console.log('');

  const connection = new Connection(RPC_URL, 'confirmed');

  // Read-only program — no wallet needed.
  // Anchor event subscriptions work through Connection WebSocket (onLogs).
  const program = createReadOnlyProgram(connection);

  const monitor = new EventMonitor({ program, logger });

  // --- Task Events ---
  monitor.subscribeToTaskEvents({
    onTaskCreated: (event: TaskCreatedEvent) => {
      console.log(
        `  [TASK:CREATED]    ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.taskId)}... | ` +
        `Reward: ${lamportsToSol(event.rewardAmount)} SOL | ` +
        `Creator: ${event.creator.toBase58().slice(0, 8)}...`
      );
    },
    onTaskClaimed: (event: TaskClaimedEvent) => {
      console.log(
        `  [TASK:CLAIMED]    ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.taskId)}... | ` +
        `Worker: ${event.worker.toBase58().slice(0, 8)}... | ` +
        `Workers: ${event.currentWorkers}/${event.maxWorkers}`
      );
    },
    onTaskCompleted: (event: TaskCompletedEvent) => {
      console.log(
        `  [TASK:COMPLETED]  ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.taskId)}... | ` +
        `Reward: ${lamportsToSol(event.rewardPaid)} SOL`
      );
    },
    onTaskCancelled: (event: TaskCancelledEvent) => {
      console.log(
        `  [TASK:CANCELLED]  ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.taskId)}... | ` +
        `Refund: ${lamportsToSol(event.refundAmount)} SOL`
      );
    },
  });

  // --- Dispute Events ---
  monitor.subscribeToDisputeEvents({
    onDisputeInitiated: (event: DisputeInitiatedEvent) => {
      console.log(
        `  [DISPUTE:NEW]     ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.disputeId)}... | ` +
        `Initiator: ${event.initiator.toBase58().slice(0, 8)}...`
      );
    },
    onDisputeVoteCast: (event: DisputeVoteCastEvent) => {
      console.log(
        `  [DISPUTE:VOTE]    ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.disputeId)}... | ` +
        `${event.approved ? 'APPROVE' : 'REJECT'} (${event.votesFor}/${event.votesAgainst})`
      );
    },
    onDisputeResolved: (event: DisputeResolvedEvent) => {
      console.log(
        `  [DISPUTE:RESOLVED] ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.disputeId)}... | ` +
        `Votes: ${event.votesFor} for, ${event.votesAgainst} against`
      );
    },
    onDisputeExpired: (event: DisputeExpiredEvent) => {
      console.log(
        `  [DISPUTE:EXPIRED] ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.disputeId)}... | ` +
        `Refund: ${lamportsToSol(event.refundAmount)} SOL`
      );
    },
  });

  // --- Protocol Events ---
  monitor.subscribeToProtocolEvents({
    onProtocolInitialized: (event: ProtocolInitializedEvent) => {
      console.log(
        `  [PROTO:INIT]      ${formatTime(event.timestamp)} | ` +
        `Authority: ${event.authority.toBase58().slice(0, 8)}... | ` +
        `Fee: ${event.protocolFeeBps} bps`
      );
    },
    onRewardDistributed: (event: RewardDistributedEvent) => {
      console.log(
        `  [PROTO:REWARD]    ${formatTime(event.timestamp)} | ` +
        `Amount: ${lamportsToSol(event.amount)} SOL | ` +
        `Fee: ${lamportsToSol(event.protocolFee)} SOL`
      );
    },
    onRateLimitHit: (event: RateLimitHitEvent) => {
      console.log(
        `  [PROTO:RATELIMIT] ${formatTime(event.timestamp)} | ` +
        `Agent: ${shortId(event.agentId)}... | ` +
        `${event.currentCount}/${event.maxCount}`
      );
    },
  });

  // --- Agent Events ---
  monitor.subscribeToAgentEvents({
    onRegistered: (event: AgentRegisteredEvent) => {
      console.log(
        `  [AGENT:REGISTER]  ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.agentId)}... | ` +
        `Caps: 0x${event.capabilities.toString(16)}`
      );
    },
    onUpdated: (event: AgentUpdatedEvent) => {
      console.log(
        `  [AGENT:UPDATE]    ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.agentId)}... | ` +
        `Status: ${event.status}`
      );
    },
    onDeregistered: (event: AgentDeregisteredEvent) => {
      console.log(
        `  [AGENT:DEREGISTER] ${formatTime(event.timestamp)} | ` +
        `ID: ${shortId(event.agentId)}...`
      );
    },
  });

  // Start the monitor (sets lifecycle flags, records start time)
  monitor.start();

  logger.info(`Connected to ${RPC_URL}`);
  logger.info(`Monitoring all protocol events...`);
  logger.info(`Stats interval: ${STATS_INTERVAL / 1000}s`);
  logger.info('Press Ctrl+C to stop.');
  console.log('');

  // Print metrics periodically
  const statsInterval = setInterval(() => {
    const metrics = monitor.getMetrics();
    const uptimeSec = Math.floor(metrics.uptimeMs / 1000);
    const eventsPerMin = uptimeSec > 0
      ? ((metrics.totalEventsReceived / uptimeSec) * 60).toFixed(1)
      : '0';

    console.log('');
    console.log('--- Dashboard Metrics ---');
    console.log(`  Uptime: ${uptimeSec}s`);
    console.log(`  Total events: ${metrics.totalEventsReceived}`);
    console.log(`  Events/min: ${eventsPerMin}`);

    const counts = Object.entries(metrics.eventCounts);
    if (counts.length > 0) {
      console.log('  Breakdown:');
      for (const [name, count] of counts.sort((a, b) => b[1] - a[1])) {
        console.log(`    ${name}: ${count}`);
      }
    }
    console.log('-------------------------');
    console.log('');
  }, STATS_INTERVAL);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('');
    clearInterval(statsInterval);
    const metrics = monitor.getMetrics();
    logger.info(`Stopping... (${metrics.totalEventsReceived} events received)`);
    await monitor.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    clearInterval(statsInterval);
    await monitor.stop();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(console.error);
