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
    endpoint: 'ws://localhost:3100',
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

let nextToolCallId = 1;
let nextSandboxId = 1;

// Track clients
let clientCounter = 0;
const clients = new Map();

const wss = new WebSocketServer({ port: PORT, host: HOST });

console.log(`WebChat test server listening on ws://${HOST}:${PORT}`);
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

    console.log(`[${clientId}] ${msg.type}`, payload.content ? `"${payload.content}"` : '');

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
          },
          id,
        }));
        break;

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
