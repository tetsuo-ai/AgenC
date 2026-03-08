/**
 * Minimal test server for the WebChat UI.
 *
 * Starts a Gateway with WebChatChannel behavior wired in so the frontend
 * can connect and exercise every major view during local and CI e2e tests.
 *
 * Usage:
 *   node web/test-server.mjs
 *
 * Then in another terminal:
 *   cd web && npm run dev
 *
 * Open http://localhost:5173 — the connection indicator should go green.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ws = require('ws');
const WebSocketServer = ws.WebSocketServer || ws.Server;

const PORT = Number(process.env.WEBCHAT_WS_PORT ?? process.env.WS_PORT ?? 3100);
const HOST = '127.0.0.1';
const CHAT_SESSION_ID = 'session_local_1';

const PORTFACING_SKILLS = [
  { name: 'jupiter-dex', description: 'Jupiter DEX swap integration', enabled: true },
  { name: 'web-search', description: 'Search the web for information', enabled: true },
  { name: 'code-exec', description: 'Execute code in sandbox', enabled: false },
];

const TEST_TASKS = [
  { id: 'task_abc123', status: 'Open', reward: '1000000', creator: 'Abc1234...', worker: null },
  { id: 'task_def456', status: 'InProgress', reward: '5000000', creator: 'Xyz9876...', worker: 'Worker1...' },
];

const TEST_AGENTS = [
  {
    pda: 'agent_mock_mainnet_001',
    agentId: 'agent-main-001',
    authority: 'Auth11111111111111111111111111111111111111',
    capabilities: ['chat', 'webchat', 'voice'],
    status: 'Active',
    reputation: 98,
    tasksCompleted: 12,
    stake: '12.5',
    endpoint: 'wss://localhost:3100',
    metadataUri: 'https://example.com/metadata/main.json',
    registeredAt: 1_700_000_000,
    lastActive: 1_700_000_000,
    totalEarned: '45',
    activeTasks: 1,
  },
];

const DEFAULT_CONFIG = {
  llm: {
    provider: 'grok',
    apiKey: '****demo',
    model: 'grok-4-fast-reasoning',
    baseUrl: 'https://api.x.ai/v1',
  },
  voice: {
    enabled: true,
    mode: 'vad',
    voice: 'Ara',
    apiKey: '',
  },
  memory: {
    backend: 'memory',
  },
  connection: {
    rpcUrl: 'https://api.devnet.solana.com',
  },
  logging: {
    level: 'info',
  },
};

const OLLAMA_MODELS = ['llama3', 'qwen2.5'];

function createContract(overrides = {}) {
  return {
    domain: 'generic',
    kind: 'finite',
    successCriteria: ['Observe the managed process reach a terminal state.'],
    completionCriteria: ['Verify runtime evidence before completing the run.'],
    blockedCriteria: ['Pause if operator approval becomes required.'],
    nextCheckMs: 4000,
    heartbeatMs: 12000,
    requiresUserStop: false,
    managedProcessPolicy: { mode: 'none' },
    ...overrides,
  };
}

function createRunDetail(overrides = {}) {
  return {
    runId: 'run_demo_1',
    sessionId: 'session_run_demo_1',
    objective: 'Watch the demo process until it exits cleanly.',
    state: 'working',
    currentPhase: 'active',
    explanation: 'Run is active and waiting for the next verification cycle. Next verification in ~4s.',
    unsafeToContinue: false,
    createdAt: Date.now() - 90_000,
    updatedAt: Date.now() - 2_000,
    lastVerifiedAt: Date.now() - 5_000,
    nextCheckAt: Date.now() + 4_000,
    nextHeartbeatAt: Date.now() + 12_000,
    cycleCount: 4,
    contractKind: 'finite',
    contractDomain: 'generic',
    requiresUserStop: false,
    pendingSignals: 1,
    watchCount: 1,
    fenceToken: 3,
    lastUserUpdate: 'Operator asked the runtime to keep watching until completion.',
    lastToolEvidence: 'system.processStatus -> running (pid=12345)',
    lastWakeReason: 'tool_result',
    carryForwardSummary: 'Process is stable and the verifier is waiting for the next check.',
    blockerSummary: undefined,
    approvalRequired: false,
    approvalState: 'none',
    checkpointAvailable: true,
    preferredWorkerId: 'worker-local-1',
    workerAffinityKey: 'session_run_demo_1',
    policyScope: {
      tenantId: 'tenant-demo',
      projectId: 'project-demo',
      runId: 'run_demo_1',
    },
    contract: createContract(),
    blocker: undefined,
    approval: {
      status: 'none',
      requestId: undefined,
      summary: undefined,
      since: undefined,
    },
    budget: {
      runtimeStartedAt: Date.now() - 90_000,
      lastActivityAt: Date.now() - 2_000,
      lastProgressAt: Date.now() - 5_000,
      totalTokens: 240,
      lastCycleTokens: 38,
      managedProcessCount: 1,
      maxRuntimeMs: 600_000,
      maxCycles: 64,
      maxIdleMs: 60_000,
      nextCheckIntervalMs: 4_000,
      heartbeatIntervalMs: 12_000,
      firstAcknowledgedAt: Date.now() - 88_000,
      firstVerifiedUpdateAt: Date.now() - 85_000,
      stopRequestedAt: undefined,
    },
    compaction: {
      lastCompactedAt: undefined,
      lastCompactedCycle: 0,
      refreshCount: 0,
      lastHistoryLength: 6,
      lastMilestoneAt: Date.now() - 6_000,
      lastCompactionReason: undefined,
      repairCount: 0,
      lastProviderAnchorAt: undefined,
    },
    artifacts: [
      {
        kind: 'process_handle',
        locator: 'proc_demo_1',
        label: 'Managed process handle',
      },
    ],
    observedTargets: [],
    watchRegistrations: [
      {
        watchId: 'watch_demo_1',
        kind: 'managed_process',
        target: 'proc_demo_1',
        createdAt: Date.now() - 60_000,
      },
    ],
    recentEvents: [
      {
        summary: 'Run accepted a tool_result wake for the managed process.',
        timestamp: Date.now() - 7_000,
        eventType: 'signal_received',
        data: { reason: 'tool_result' },
      },
      {
        summary: 'Verifier observed the process still running.',
        timestamp: Date.now() - 5_000,
        eventType: 'run_verified',
        data: { state: 'running' },
      },
    ],
    ...overrides,
  };
}

let testRunDetail = createRunDetail();

function summarizeRun(detail) {
  return {
    runId: detail.runId,
    sessionId: detail.sessionId,
    objective: detail.objective,
    state: detail.state,
    currentPhase: detail.currentPhase,
    explanation: detail.explanation,
    unsafeToContinue: detail.unsafeToContinue,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    lastVerifiedAt: detail.lastVerifiedAt,
    nextCheckAt: detail.nextCheckAt,
    nextHeartbeatAt: detail.nextHeartbeatAt,
    cycleCount: detail.cycleCount,
    contractKind: detail.contractKind,
    contractDomain: detail.contractDomain,
    requiresUserStop: detail.requiresUserStop,
    pendingSignals: detail.pendingSignals,
    watchCount: detail.watchCount,
    fenceToken: detail.fenceToken,
    lastUserUpdate: detail.lastUserUpdate,
    lastToolEvidence: detail.lastToolEvidence,
    lastWakeReason: detail.lastWakeReason,
    carryForwardSummary: detail.carryForwardSummary,
    blockerSummary: detail.blocker?.summary,
    approvalRequired: detail.approvalRequired,
    approvalState: detail.approvalState,
    preferredWorkerId: detail.preferredWorkerId,
    workerAffinityKey: detail.workerAffinityKey,
    checkpointAvailable: detail.checkpointAvailable,
  };
}

function updateRunDetail(mutator) {
  testRunDetail = {
    ...mutator(testRunDetail),
    updatedAt: Date.now(),
  };
}

function appendRunEvent(eventType, summary, data = {}) {
  updateRunDetail((detail) => ({
    ...detail,
    recentEvents: [
      {
        summary,
        timestamp: Date.now(),
        eventType,
        data,
      },
      ...detail.recentEvents,
    ].slice(0, 16),
  }));
}

let nextToolCallId = 1;
let nextSandboxId = 1;

// Track clients
let clientCounter = 0;
const clients = new Map();

const wss = new WebSocketServer({ port: PORT, host: HOST });

console.log(`WebChat test server listening on ${HOST}:${PORT} (ws)`);
console.log('Run "cd web && npm run dev" and open http://localhost:5173\n');

wss.on('connection', (ws) => {
  const clientId = `client_${++clientCounter}`;
  clients.set(clientId, ws);
  console.log(`[+] ${clientId} connected`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    const id = typeof msg.id === 'string' ? msg.id : undefined;
    const payload = msg.payload ?? {};

    console.log('%s %s', `[${clientId}] ${msg.type}`, payload.content ? `"${payload.content}"` : '');

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', id }));
        break;

      case 'chat.message': {
        const content = payload.content ?? '';

        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'chat.typing', payload: { active: true } }));
          ws.send(JSON.stringify({ type: 'chat.session', payload: { sessionId: CHAT_SESSION_ID } }));

          if (content.toLowerCase().includes('tool')) {
            const toolCallId = `tool-${nextToolCallId++}`;
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'tools.executing',
                payload: {
                  toolName: 'agenc.listTasks',
                  toolCallId,
                  args: { status: 'open' },
                },
              }));

              setTimeout(() => {
                ws.send(JSON.stringify({
                  type: 'tools.result',
                  payload: {
                    toolName: 'agenc.listTasks',
                    toolCallId,
                    result: JSON.stringify([{ id: 'task_1', status: 'Open' }]),
                    durationMs: 42,
                    isError: false,
                  },
                }));
              }, 400);
            }, 150);
          }

          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'chat.typing', payload: { active: false } }));
            ws.send(JSON.stringify({
              type: 'chat.message',
              payload: {
                content: `You said: "${content}"`,
                sender: 'agent',
                timestamp: Date.now(),
              },
            }));
          }, 650);
        }, 50);
        break;
      }

      case 'chat.typing':
        // Acknowledged silently
        break;

      case 'chat.history':
        ws.send(JSON.stringify({ type: 'chat.history', payload: [], id }));
        break;

      case 'chat.resume':
        ws.send(JSON.stringify({
          type: 'error',
          error: `Session "${payload.sessionId}" not found in test server`,
          id,
        }));
        break;

      case 'status.get':
        ws.send(JSON.stringify({
          type: 'status.update',
          payload: {
            state: 'running',
            uptimeMs: Date.now() - startTime,
            channels: ['webchat'],
            activeSessions: clients.size,
            controlPlanePort: PORT,
            agentName: 'test-agent',
            backgroundRuns: {
              activeTotal: 1,
              queuedSignalsTotal: testRunDetail.pendingSignals,
              stateCounts: {
                pending: 0,
                running: testRunDetail.state === 'running' ? 1 : 0,
                working: testRunDetail.state === 'working' ? 1 : 0,
                blocked: testRunDetail.state === 'blocked' ? 1 : 0,
                paused: testRunDetail.state === 'paused' ? 1 : 0,
                completed: testRunDetail.state === 'completed' ? 1 : 0,
                failed: testRunDetail.state === 'failed' ? 1 : 0,
                cancelled: testRunDetail.state === 'cancelled' ? 1 : 0,
                suspended: testRunDetail.state === 'suspended' ? 1 : 0,
              },
              recentAlerts: [],
              metrics: {
                startedTotal: 1,
                completedTotal: 0,
                failedTotal: 0,
                blockedTotal: 0,
                recoveredTotal: 0,
                meanLatencyMs: 120,
                meanTimeToFirstAckMs: 300,
                meanTimeToFirstVerifiedUpdateMs: 2500,
                falseCompletionRate: 0,
                blockedWithoutNoticeRate: 0,
                meanStopLatencyMs: 900,
                recoverySuccessRate: 1,
                verifierAccuracyRate: 1,
              },
            },
          },
          id,
        }));
        break;

      case 'runs.list':
        ws.send(JSON.stringify({
          type: 'runs.list',
          payload: [summarizeRun(testRunDetail)],
          id,
        }));
        break;

      case 'run.inspect':
        ws.send(JSON.stringify({
          type: 'run.inspect',
          payload: testRunDetail,
          id,
        }));
        break;

      case 'run.control': {
        const action = payload.action;
        if (action === 'pause') {
          updateRunDetail((detail) => ({
            ...detail,
            state: 'paused',
            currentPhase: 'paused',
            explanation: 'Run is paused by an operator and will not make progress until resumed.',
            lastUserUpdate: 'Background run paused from the run dashboard.',
            lastWakeReason: 'user_input',
          }));
          appendRunEvent('run_paused', 'Operator paused the run from the dashboard.', { action });
        } else if (action === 'resume') {
          updateRunDetail((detail) => ({
            ...detail,
            state: 'working',
            currentPhase: 'active',
            explanation: 'Run is active and waiting for the next verification cycle. Next verification in ~4s.',
            lastUserUpdate: 'Background run resumed from the run dashboard.',
            lastWakeReason: 'user_input',
          }));
          appendRunEvent('run_resumed', 'Operator resumed the run from the dashboard.', { action });
        } else if (action === 'cancel') {
          updateRunDetail((detail) => ({
            ...detail,
            state: 'cancelled',
            currentPhase: 'cancelled',
            explanation: 'Run was cancelled and is no longer executing.',
            lastUserUpdate: payload.reason ?? 'Stopped from the run dashboard.',
            lastWakeReason: 'user_input',
          }));
          appendRunEvent('run_cancelled', 'Operator stopped the run from the dashboard.', { action });
        } else if (action === 'edit_objective' && typeof payload.objective === 'string') {
          updateRunDetail((detail) => ({
            ...detail,
            objective: payload.objective,
            lastUserUpdate: `Objective updated to: ${payload.objective}`,
            lastWakeReason: 'user_input',
          }));
          appendRunEvent('run_objective_updated', `Objective changed to "${payload.objective}".`, { action });
        } else if (action === 'amend_constraints' && payload.constraints) {
          updateRunDetail((detail) => ({
            ...detail,
            contract: {
              ...detail.contract,
              ...payload.constraints,
            },
            lastUserUpdate: 'Operator amended the run constraints.',
            lastWakeReason: 'user_input',
          }));
          appendRunEvent('run_contract_amended', 'Operator amended the run constraints.', { action });
        } else if (action === 'adjust_budget' && payload.budget) {
          updateRunDetail((detail) => ({
            ...detail,
            budget: {
              ...detail.budget,
              ...payload.budget,
            },
            lastUserUpdate: 'Operator adjusted the run budget.',
            lastWakeReason: 'user_input',
          }));
          appendRunEvent('run_budget_adjusted', 'Operator adjusted the run budget.', { action });
        } else if (action === 'force_compact') {
          updateRunDetail((detail) => ({
            ...detail,
            compaction: {
              ...detail.compaction,
              lastCompactedAt: Date.now(),
              lastCompactedCycle: detail.cycleCount,
              refreshCount: detail.compaction.refreshCount + 1,
              lastCompactionReason: 'operator_forced',
            },
            carryForwardSummary: 'Carry-forward state was refreshed by an operator override.',
            lastUserUpdate: 'Operator forced compaction for this run.',
            lastWakeReason: 'user_input',
          }));
          appendRunEvent('run_compaction_forced', 'Operator forced carry-forward compaction.', { action });
        } else if (action === 'reassign_worker' && payload.worker) {
          updateRunDetail((detail) => ({
            ...detail,
            preferredWorkerId: payload.worker.preferredWorkerId,
            workerAffinityKey: payload.worker.workerAffinityKey,
            lastUserUpdate: 'Operator reassigned the preferred worker.',
            lastWakeReason: 'user_input',
          }));
          appendRunEvent('run_worker_reassigned', 'Operator reassigned the preferred worker.', { action });
        } else if (action === 'retry_from_checkpoint') {
          updateRunDetail((detail) => ({
            ...detail,
            state: 'working',
            currentPhase: 'active',
            explanation: 'Run resumed from the latest checkpoint and is active again.',
            checkpointAvailable: true,
            lastUserUpdate: 'Operator retried the run from its latest checkpoint.',
            lastWakeReason: 'recovery',
          }));
          appendRunEvent('run_retried', 'Operator retried the run from its checkpoint.', { action });
        } else if (action === 'verification_override' && payload.override) {
          const mode = payload.override.mode;
          updateRunDetail((detail) => ({
            ...detail,
            state: mode === 'fail' ? 'failed' : mode === 'complete' ? 'completed' : 'working',
            currentPhase: mode === 'fail' ? 'failed' : mode === 'complete' ? 'completed' : 'active',
            explanation:
              mode === 'fail'
                ? 'Run failed and needs operator review before it is retried.'
                : mode === 'complete'
                  ? 'Run completed and the runtime recorded a terminal result.'
                  : 'Run is active and waiting for the next verification cycle. Next verification in ~4s.',
            lastUserUpdate: payload.override.reason,
            lastWakeReason: 'user_input',
          }));
          appendRunEvent(
            'run_verification_overridden',
            `Operator verification override recorded: ${payload.override.reason}`,
            { action, mode },
          );
        }

        ws.send(JSON.stringify({
          type: 'run.updated',
          payload: testRunDetail,
          id,
        }));
        break;
      }

      case 'skills.list':
        ws.send(JSON.stringify({
          type: 'skills.list',
          payload: PORTFACING_SKILLS,
          id,
        }));
        break;

      case 'skills.toggle':
        ws.send(JSON.stringify({ type: 'skills.list', payload: PORTFACING_SKILLS, id }));
        break;

      case 'tasks.list':
        ws.send(JSON.stringify({
          type: 'tasks.list',
          payload: TEST_TASKS,
          id,
        }));
        break;

      case 'tasks.create':
        ws.send(JSON.stringify({
          type: 'tasks.list',
          payload: [...TEST_TASKS, { id: 'task_new', status: 'Open', reward: '250000', creator: 'local-user', worker: null }],
          id,
        }));
        break;

      case 'tasks.cancel':
        ws.send(JSON.stringify({ type: 'tasks.list', payload: TEST_TASKS, id }));
        break;

      case 'memory.search':
        ws.send(JSON.stringify({
          type: 'memory.results',
          payload: [
            { content: `Search result for "${payload.query}"`, timestamp: Date.now() - 60000, role: 'assistant' },
          ],
          id,
        }));
        break;

      case 'memory.sessions':
        ws.send(JSON.stringify({
          type: 'memory.sessions',
          payload: [
            { id: 'session:abc123', messageCount: 12, lastActiveAt: Date.now() - 300000 },
            { id: 'session:def456', messageCount: 5, lastActiveAt: Date.now() - 3600000 },
          ],
          id,
        }));
        break;

      case 'approval.respond':
        console.log(`  Approval: ${payload.requestId} → ${payload.approved ? 'approved' : 'denied'}`);
        break;

      case 'config.get':
        ws.send(JSON.stringify({
          type: 'config.get',
          payload: DEFAULT_CONFIG,
          id,
        }));
        break;

      case 'config.set':
        ws.send(JSON.stringify({
          type: 'config.set',
          payload: { config: payload },
          id,
        }));
        break;

      case 'ollama.models':
        ws.send(JSON.stringify({
          type: 'ollama.models',
          payload: { models: OLLAMA_MODELS },
          id,
        }));
        break;

      case 'agents.list':
        ws.send(JSON.stringify({
          type: 'agents.list',
          payload: TEST_AGENTS,
          id,
        }));
        break;

      case 'wallet.info':
        ws.send(JSON.stringify({
          type: 'wallet.info',
          payload: {
            address: '8uM6m....DemoWallet',
            lamports: 12_500_000_000,
            sol: 12.5,
            network: 'devnet',
            rpcUrl: 'https://api.devnet.solana.com',
            explorerUrl: 'https://explorer.solana.com/address/8uM6m....DemoWallet',
          },
          id,
        }));
        break;

      case 'wallet.airdrop':
        ws.send(JSON.stringify({
          type: 'wallet.airdrop',
          payload: {
            requestId: payload.requestId,
            newLamports: 12_800_000_000,
            newBalance: 12.8,
          },
          id,
        }));
        break;

      case 'events.subscribe':
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'events.event',
            payload: {
              eventType: 'taskCreated',
              data: { taskId: 'task_new', creator: 'Agent1', reward: 1000000 },
              timestamp: Date.now(),
            },
          }));
        }, 3000);
        break;

      case 'events.unsubscribe':
        break;

      case 'desktop.list':
        ws.send(JSON.stringify({
          type: 'desktop.list',
          payload: [],
          id,
        }));
        break;

      case 'desktop.create':
        ws.send(JSON.stringify({
          type: 'desktop.created',
          payload: {
            containerId: `desktop_${nextSandboxId++}`,
            sessionId: payload.sessionId ?? CHAT_SESSION_ID,
            status: 'ready',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            vncUrl: `https://example.invalid/${nextSandboxId - 1}`,
            uptimeMs: 1200,
          },
          id,
        }));
        break;

      case 'desktop.destroy':
        ws.send(JSON.stringify({
          type: 'desktop.destroyed',
          payload: { containerId: payload.containerId ?? 'unknown' },
          id,
        }));
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', error: `Unknown type: ${msg.type}`, id }));
    }
  });

  // Emit an approval request per connected client after a short delay so
  // each page gets its own banner in end-to-end tests.
  setTimeout(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'approval.request',
        payload: {
          requestId: `approval_${Math.random().toString(36).slice(2, 10)}`,
          action: 'jupiter.swap',
          details: { fromToken: 'SOL', toToken: 'USDC', amount: '1.5' },
        },
      }));
      console.log(`[!] Sent sample approval request to ${clientId}`);
    }
  }, 10_000);

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[-] ${clientId} disconnected`);
  });
});

const startTime = Date.now();
