import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  DEVNET_RPC,
  TaskOperations,
  DisputeOperations,
  EventMonitor,
  createLogger,
  createReadOnlyProgram,
  parseAgentState,
  getCapabilityNames,
  agentStatusToString,
  bytesToHex,
  lamportsToSol,
} from '../../runtime/dist/index.mjs';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '3337', 10);
const RPC_URL = process.env.SOLANA_RPC_URL ?? DEVNET_RPC;
const SNAPSHOT_INTERVAL_MS = Number.parseInt(
  process.env.SNAPSHOT_INTERVAL_MS ?? '45000',
  10,
);
const EVENT_HISTORY_LIMIT = Number.parseInt(
  process.env.EVENT_HISTORY_LIMIT ?? '80',
  10,
);

const logger = createLogger('info', '[Public Explorer]');
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(__dirname, 'public');
const readOnlyAgentId = new Uint8Array(32).fill(7);
const deployKeypairPath = fileURLToPath(
  new URL('../../target/deploy/agenc_coordination-keypair.json', import.meta.url),
);

async function resolveProgramId(): Promise<PublicKey | undefined> {
  const envProgramId = process.env.AGENC_PROGRAM_ID ?? process.env.SOLANA_PROGRAM_ID;
  if (envProgramId) {
    return new PublicKey(envProgramId);
  }

  try {
    const secret = JSON.parse(await readFile(deployKeypairPath, 'utf8')) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey;
  } catch {
    return undefined;
  }
}

type ExplorerTask = {
  id: string;
  shortId: string;
  pda: string;
  status: string;
  taskType: string;
  description: string;
  reward: string;
  rewardRaw: string;
  rewardMint: string | null;
  creator: string;
  currentWorkers: number;
  maxWorkers: number;
  createdAt: number;
  createdAtIso: string;
  deadline: number | null;
  deadlineIso: string | null;
  privateTask: boolean;
};

type ExplorerDispute = {
  id: string;
  shortId: string;
  pda: string;
  status: string;
  resolutionType: string;
  initiator: string;
  defendant: string;
  votesFor: string;
  votesAgainst: string;
  totalVoters: number;
  createdAt: number;
  createdAtIso: string;
  votingDeadline: number;
  votingDeadlineIso: string;
  rewardMint: string | null;
};

type ExplorerAgent = {
  pda: string;
  shortPda: string;
  authority: string;
  status: string;
  reputation: number;
  reputationPercent: string;
  tasksCompleted: string;
  activeTasks: number;
  stake: string;
  totalEarned: string;
  endpoint: string;
  capabilities: string[];
  registeredAt: number;
  registeredAtIso: string;
  lastActive: number;
  lastActiveIso: string;
};

type ExplorerEvent = {
  id: string;
  kind: string;
  accent: 'teal' | 'orange' | 'rose' | 'ink';
  title: string;
  detail: string;
  timestamp: number;
  timestampIso: string;
};

type ExplorerSnapshot = {
  meta: {
    rpcUrl: string;
    programId: string;
    slot: number;
    updatedAt: number;
    updatedAtIso: string;
  };
  stats: {
    taskCount: number;
    openTaskCount: number;
    privateTaskCount: number;
    disputeCount: number;
    activeDisputeCount: number;
    agentCount: number;
    activeAgentCount: number;
    totalSolRewards: string;
    totalEventsObserved: number;
  };
  tasks: ExplorerTask[];
  disputes: ExplorerDispute[];
  agents: ExplorerAgent[];
  events: ExplorerEvent[];
};

type SsePayload =
  | { type: 'snapshot'; payload: ExplorerSnapshot }
  | { type: 'event'; payload: ExplorerEvent }
  | { type: 'health'; payload: { ok: boolean; message: string } };

const connection = new Connection(RPC_URL, 'confirmed');
const resolvedProgramId = await resolveProgramId();
const program = resolvedProgramId
  ? createReadOnlyProgram(connection, resolvedProgramId)
  : createReadOnlyProgram(connection);
const PROGRAM_ADDRESS = program.programId.toBase58();
const taskOps = new TaskOperations({
  program,
  agentId: readOnlyAgentId,
  logger,
});
const disputeOps = new DisputeOperations({
  program,
  agentId: readOnlyAgentId,
  logger,
});
const monitor = new EventMonitor({ program, logger });

let assetCache: Record<string, string> | null = null;
let lastSnapshot: ExplorerSnapshot | null = null;
let snapshotInFlight: Promise<ExplorerSnapshot> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let lastError: string | null = null;
const clients = new Set<ServerResponse<IncomingMessage>>();
const recentEvents: ExplorerEvent[] = [
  createEvent({
    kind: 'explorer.started',
    accent: 'ink',
    title: 'Explorer ready',
    detail: `Watching ${PROGRAM_ADDRESS} on ${RPC_URL}`,
    timestamp: Date.now(),
  }),
];

function nowIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function formatAddress(value: string): string {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function formatLamports(value: bigint): string {
  const sol = Number(lamportsToSol(value));
  return `${sol.toLocaleString(undefined, {
    minimumFractionDigits: sol < 1 ? 3 : 2,
    maximumFractionDigits: sol < 1 ? 6 : 3,
  })} SOL`;
}

function formatReward(amount: bigint, mint: string | null): string {
  if (!mint) {
    return formatLamports(amount);
  }
  return `${amount.toString()} @ ${formatAddress(mint)}`;
}

function trimNulls(value: string): string {
  return value.replace(/\0+/g, '').trim();
}

function decodeDescription(bytes: Uint8Array): string {
  const decoded = trimNulls(new TextDecoder().decode(bytes));
  if (decoded && /[\p{L}\p{N}]/u.test(decoded)) {
    return decoded;
  }
  return `0x${bytesToHex(bytes).slice(0, 24)}...`;
}

function isPrivateConstraint(bytes: Uint8Array): boolean {
  return bytes.some((value) => value !== 0);
}

function taskStatusLabel(status: number): string {
  switch (status) {
    case 0:
      return 'Open';
    case 1:
      return 'In Progress';
    case 2:
      return 'Pending Validation';
    case 3:
      return 'Completed';
    case 4:
      return 'Cancelled';
    case 5:
      return 'Disputed';
    default:
      return `Unknown (${status})`;
  }
}

function taskTypeLabel(taskType: number): string {
  switch (taskType) {
    case 0:
      return 'Exclusive';
    case 1:
      return 'Collaborative';
    case 2:
      return 'Competitive';
    case 3:
      return 'Bid Exclusive';
    default:
      return `Unknown (${taskType})`;
  }
}

function disputeStatusLabel(status: number): string {
  switch (status) {
    case 0:
      return 'Active';
    case 1:
      return 'Resolved';
    case 2:
      return 'Expired';
    case 3:
      return 'Cancelled';
    default:
      return `Unknown (${status})`;
  }
}

function resolutionTypeLabel(resolutionType: number): string {
  switch (resolutionType) {
    case 0:
      return 'Refund';
    case 1:
      return 'Complete';
    case 2:
      return 'Split';
    default:
      return `Unknown (${resolutionType})`;
  }
}

function createEvent(input: Omit<ExplorerEvent, 'id' | 'timestampIso'>): ExplorerEvent {
  return {
    ...input,
    id: `${input.kind}:${input.timestamp}:${Math.random().toString(16).slice(2, 8)}`,
    timestampIso: nowIso(input.timestamp),
  };
}

function rememberEvent(event: ExplorerEvent): void {
  recentEvents.unshift(event);
  if (recentEvents.length > EVENT_HISTORY_LIMIT) {
    recentEvents.length = EVENT_HISTORY_LIMIT;
  }
  broadcast({ type: 'event', payload: event });
}

function serializeTask(taskPda: string, task: any): ExplorerTask {
  const id = bytesToHex(task.taskId);
  return {
    id,
    shortId: id.slice(0, 12),
    pda: taskPda,
    status: taskStatusLabel(task.status),
    taskType: taskTypeLabel(task.taskType),
    description: decodeDescription(task.description),
    reward: formatReward(task.rewardAmount, task.rewardMint?.toBase58?.() ?? null),
    rewardRaw: task.rewardAmount.toString(),
    rewardMint: task.rewardMint?.toBase58?.() ?? null,
    creator: task.creator.toBase58(),
    currentWorkers: task.currentWorkers,
    maxWorkers: task.maxWorkers,
    createdAt: task.createdAt,
    createdAtIso: new Date(task.createdAt * 1000).toISOString(),
    deadline: task.deadline > 0 ? task.deadline : null,
    deadlineIso: task.deadline > 0 ? new Date(task.deadline * 1000).toISOString() : null,
    privateTask: isPrivateConstraint(task.constraintHash),
  };
}

function serializeDispute(disputePda: string, dispute: any): ExplorerDispute {
  const id = bytesToHex(dispute.disputeId);
  return {
    id,
    shortId: id.slice(0, 12),
    pda: disputePda,
    status: disputeStatusLabel(dispute.status),
    resolutionType: resolutionTypeLabel(dispute.resolutionType),
    initiator: dispute.initiator.toBase58(),
    defendant: dispute.defendant.toBase58(),
    votesFor: dispute.votesFor.toString(),
    votesAgainst: dispute.votesAgainst.toString(),
    totalVoters: dispute.totalVoters,
    createdAt: dispute.createdAt,
    createdAtIso: new Date(dispute.createdAt * 1000).toISOString(),
    votingDeadline: dispute.votingDeadline,
    votingDeadlineIso: new Date(dispute.votingDeadline * 1000).toISOString(),
    rewardMint: dispute.rewardMint?.toBase58?.() ?? null,
  };
}

function serializeAgent(agentPda: string, agent: any): ExplorerAgent {
  return {
    pda: agentPda,
    shortPda: formatAddress(agentPda),
    authority: agent.authority.toBase58(),
    status: agentStatusToString(agent.status),
    reputation: agent.reputation,
    reputationPercent: `${(agent.reputation / 100).toFixed(2)}%`,
    tasksCompleted: agent.tasksCompleted.toString(),
    activeTasks: agent.activeTasks,
    stake: formatLamports(agent.stake),
    totalEarned: formatLamports(agent.totalEarned),
    endpoint: agent.endpoint,
    capabilities: getCapabilityNames(agent.capabilities),
    registeredAt: agent.registeredAt,
    registeredAtIso: new Date(agent.registeredAt * 1000).toISOString(),
    lastActive: agent.lastActive,
    lastActiveIso: new Date(agent.lastActive * 1000).toISOString(),
  };
}

async function buildSnapshot(): Promise<ExplorerSnapshot> {
  const [taskAccounts, disputeAccounts, agentAccounts, slot] = await Promise.all([
    taskOps.fetchAllTasks(),
    disputeOps.fetchAllDisputes(),
    program.account.agentRegistration.all(),
    connection.getSlot('confirmed'),
  ]);

  const tasks = taskAccounts
    .map(({ task, taskPda }) => serializeTask(taskPda.toBase58(), task))
    .sort((left, right) => right.createdAt - left.createdAt);

  const disputes = disputeAccounts
    .map(({ dispute, disputePda }) => serializeDispute(disputePda.toBase58(), dispute))
    .sort((left, right) => right.createdAt - left.createdAt);

  const agents = agentAccounts
    .map((account) => serializeAgent(account.publicKey.toBase58(), parseAgentState(account.account)))
    .sort((left, right) => {
      if (left.reputation !== right.reputation) {
        return right.reputation - left.reputation;
      }
      return Number(right.tasksCompleted) - Number(left.tasksCompleted);
    });

  const totalSolRewardsLamports = tasks.reduce((total, task) => {
    if (task.rewardMint) {
      return total;
    }
    return total + BigInt(task.rewardRaw);
  }, 0n);

  const activeAgentCount = agents.filter((agent) => agent.status === 'Active').length;
  const activeDisputeCount = disputes.filter((dispute) => dispute.status === 'Active').length;
  const openTaskCount = tasks.filter((task) => task.status === 'Open').length;
  const privateTaskCount = tasks.filter((task) => task.privateTask).length;
  const metrics = monitor.getMetrics();
  const updatedAt = Date.now();

  return {
    meta: {
      rpcUrl: RPC_URL,
      programId: PROGRAM_ADDRESS,
      slot,
      updatedAt,
      updatedAtIso: nowIso(updatedAt),
    },
    stats: {
      taskCount: tasks.length,
      openTaskCount,
      privateTaskCount,
      disputeCount: disputes.length,
      activeDisputeCount,
      agentCount: agents.length,
      activeAgentCount,
      totalSolRewards: formatLamports(totalSolRewardsLamports),
      totalEventsObserved: metrics.totalEventsReceived,
    },
    tasks: tasks.slice(0, 18),
    disputes: disputes.slice(0, 12),
    agents: agents.slice(0, 18),
    events: [...recentEvents],
  };
}

async function refreshSnapshot(reason: string): Promise<ExplorerSnapshot> {
  if (snapshotInFlight) {
    return snapshotInFlight;
  }

  snapshotInFlight = buildSnapshot()
    .then((snapshot) => {
      lastSnapshot = snapshot;
      lastError = null;
      logger.info(`Snapshot refreshed (${reason})`);
      broadcast({ type: 'snapshot', payload: snapshot });
      return snapshot;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      logger.error(`Snapshot refresh failed (${reason}): ${message}`);
      broadcast({
        type: 'health',
        payload: {
          ok: false,
          message,
        },
      });
      if (lastSnapshot) {
        return lastSnapshot;
      }
      throw error;
    })
    .finally(() => {
      snapshotInFlight = null;
    });

  return snapshotInFlight;
}

function queueRefresh(reason: string): void {
  if (refreshTimer) {
    return;
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSnapshot(reason);
  }, 500);
}

function writeSse(res: ServerResponse<IncomingMessage>, payload: SsePayload): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(payload: SsePayload): void {
  for (const client of clients) {
    writeSse(client, payload);
  }
}

async function getAssets(): Promise<Record<string, string>> {
  if (assetCache) {
    return assetCache;
  }

  const [html, js, css] = await Promise.all([
    readFile(join(publicDir, 'index.html'), 'utf8'),
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'styles.css'), 'utf8'),
  ]);

  assetCache = {
    '/': html,
    '/index.html': html,
    '/app.js': js,
    '/styles.css': css,
  };

  return assetCache;
}

function sendJson(
  res: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function serveStatic(
  pathname: string,
  res: ServerResponse<IncomingMessage>,
): Promise<boolean> {
  const assets = await getAssets();
  const asset = assets[pathname];
  if (!asset) {
    return false;
  }

  const extension = extname(pathname || '/index.html');
  const contentType =
    extension === '.js'
      ? 'text/javascript; charset=utf-8'
      : extension === '.css'
        ? 'text/css; charset=utf-8'
        : 'text/html; charset=utf-8';

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.end(asset);
  return true;
}

function trackProtocolEvent(event: ExplorerEvent): void {
  rememberEvent(event);
  queueRefresh(event.kind);
}

function registerEventSubscriptions(): void {
  monitor.subscribeToTaskEvents({
    onTaskCreated: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'task.created',
          accent: 'teal',
          title: 'Task created',
          detail: `${bytesToHex(event.taskId).slice(0, 12)} opened for ${Number(
            lamportsToSol(BigInt(event.rewardAmount.toString())),
          ).toFixed(3)} SOL`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
    onTaskClaimed: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'task.claimed',
          accent: 'ink',
          title: 'Task claimed',
          detail: `${bytesToHex(event.taskId).slice(0, 12)} now has ${event.currentWorkers}/${event.maxWorkers} workers`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
    onTaskCompleted: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'task.completed',
          accent: 'teal',
          title: 'Task completed',
          detail: `${bytesToHex(event.taskId).slice(0, 12)} paid ${Number(
            lamportsToSol(BigInt(event.rewardPaid.toString())),
          ).toFixed(3)} SOL`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
    onTaskCancelled: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'task.cancelled',
          accent: 'rose',
          title: 'Task cancelled',
          detail: `${bytesToHex(event.taskId).slice(0, 12)} returned ${Number(
            lamportsToSol(BigInt(event.refundAmount.toString())),
          ).toFixed(3)} SOL`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
  });

  monitor.subscribeToDisputeEvents({
    onDisputeInitiated: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'dispute.initiated',
          accent: 'orange',
          title: 'Dispute initiated',
          detail: `${bytesToHex(event.disputeId).slice(0, 12)} entered voting`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
    onDisputeVoteCast: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'dispute.vote_cast',
          accent: 'orange',
          title: 'Dispute vote cast',
          detail: `${bytesToHex(event.disputeId).slice(0, 12)} is now ${event.votesFor.toString()} / ${event.votesAgainst.toString()}`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
    onDisputeResolved: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'dispute.resolved',
          accent: 'teal',
          title: 'Dispute resolved',
          detail: `${bytesToHex(event.disputeId).slice(0, 12)} closed with ${event.votesFor.toString()} / ${event.votesAgainst.toString()}`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
    onDisputeExpired: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'dispute.expired',
          accent: 'rose',
          title: 'Dispute expired',
          detail: `${bytesToHex(event.disputeId).slice(0, 12)} expired back to settlement`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
  });

  monitor.subscribeToProtocolEvents({
    onRewardDistributed: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'protocol.reward_distributed',
          accent: 'teal',
          title: 'Reward distributed',
          detail: `${bytesToHex(event.taskId).slice(0, 12)} paid ${Number(
            lamportsToSol(BigInt(event.amount.toString())),
          ).toFixed(3)} SOL`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
    onRateLimitHit: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'protocol.rate_limit_hit',
          accent: 'rose',
          title: 'Rate limit hit',
          detail: `${bytesToHex(event.agentId).slice(0, 12)} reached ${event.currentCount}/${event.maxCount}`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
  });

  monitor.subscribeToAgentEvents({
    onRegistered: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'agent.registered',
          accent: 'ink',
          title: 'Agent registered',
          detail: `${bytesToHex(event.agentId).slice(0, 12)} joined the network`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
    onUpdated: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'agent.updated',
          accent: 'ink',
          title: 'Agent updated',
          detail: `${bytesToHex(event.agentId).slice(0, 12)} status changed to ${event.status}`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
    onDeregistered: (event) => {
      trackProtocolEvent(
        createEvent({
          kind: 'agent.deregistered',
          accent: 'rose',
          title: 'Agent deregistered',
          detail: `${bytesToHex(event.agentId).slice(0, 12)} left the registry`,
          timestamp: event.timestamp * 1000,
        }),
      );
    },
  });

  monitor.start();
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/api/bootstrap') {
    try {
      const snapshot = lastSnapshot ?? (await refreshSnapshot('bootstrap'));
      sendJson(res, 200, {
        ok: true,
        snapshot,
        lastError,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('\n');

    clients.add(res);

    const snapshot = lastSnapshot ?? (await refreshSnapshot('sse-connect'));
    writeSse(res, { type: 'snapshot', payload: snapshot });
    writeSse(res, {
      type: 'health',
      payload: {
        ok: !lastError,
        message: lastError ?? `Connected to ${RPC_URL}`,
      },
    });

    req.on('close', () => {
      clients.delete(res);
      res.end();
    });
    return;
  }

  if (url.pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      rpcUrl: RPC_URL,
      lastError,
      clients: clients.size,
      programId: PROGRAM_ADDRESS,
    });
    return;
  }

  const served = await serveStatic(url.pathname, res);
  if (served) {
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
}

async function main(): Promise<void> {
  logger.info(`Connecting to ${RPC_URL}`);
  registerEventSubscriptions();
  await refreshSnapshot('startup');

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      logger.error(`Unhandled request error: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.listen(PORT, HOST, () => {
    logger.info(`Public explorer listening on http://${HOST}:${PORT}`);
  });

  setInterval(() => {
    void refreshSnapshot('poll');
  }, SNAPSHOT_INTERVAL_MS);

  const shutdown = async () => {
    logger.info('Shutting down explorer');
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    for (const client of clients) {
      client.end();
    }
    clients.clear();
    await monitor.stop();
    server.close();
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
}

void main().catch((error) => {
  logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
