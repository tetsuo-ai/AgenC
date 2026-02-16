/**
 * Minimal test server for the WebChat UI.
 *
 * Starts a Gateway with WebChatChannel wired in so the frontend
 * can connect and exercise all features.
 *
 * Usage:
 *   node web/test-server.mjs
 *
 * Then in another terminal:
 *   cd web && npm run dev
 *
 * Open http://localhost:5173 — the connection indicator should go green.
 */

import { WebSocketServer } from 'ws';

const PORT = 9100;
const HOST = '127.0.0.1';

// Track clients
let clientCounter = 0;
const clients = new Map();

// Simple session history for resume
const sessionHistory = new Map();

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

        // Echo back as agent after a short delay (simulating processing)
        setTimeout(() => {
          // Send typing indicator
          ws.send(JSON.stringify({ type: 'chat.typing', payload: { active: true } }));

          // Simulate tool call for messages containing "tool"
          if (content.toLowerCase().includes('tool')) {
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'tools.executing',
                payload: {
                  toolName: 'agenc.listTasks',
                  args: { status: 'open' },
                },
              }));

              setTimeout(() => {
                ws.send(JSON.stringify({
                  type: 'tools.result',
                  payload: {
                    toolName: 'agenc.listTasks',
                    result: JSON.stringify([{ id: 'task_1', status: 'Open' }]),
                    durationMs: 42,
                    isError: false,
                  },
                }));
              }, 800);
            }, 300);
          }

          // Send agent response
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'chat.typing', payload: { active: false } }));

            const responses = [
              `You said: "${content}"\n\nI'm a test agent running on the AgenC Gateway. Try sending a message with the word "tool" to see tool execution cards.`,
              `Here's some **markdown** rendering:\n\n- Item one\n- Item two\n\n\`\`\`typescript\nconst x = 42;\nconsole.log("hello");\n\`\`\``,
              `Got your message! The WebChat UI is working correctly. Here's what I can show:\n\n1. Chat with markdown\n2. Tool call cards (say "tool")\n3. Status dashboard\n4. Skills/Tasks/Memory views`,
            ];

            const response = responses[Math.floor(Math.random() * responses.length)];

            ws.send(JSON.stringify({
              type: 'chat.message',
              payload: {
                content: response,
                sender: 'agent',
                timestamp: Date.now(),
              },
            }));
          }, content.toLowerCase().includes('tool') ? 1500 : 500);
        }, 200);
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
          payload: [
            { name: 'jupiter-dex', description: 'Jupiter DEX swap integration', enabled: true },
            { name: 'web-search', description: 'Search the web for information', enabled: true },
            { name: 'code-exec', description: 'Execute code in sandbox', enabled: false },
          ],
          id,
        }));
        break;

      case 'skills.toggle':
        console.log(`  Toggle skill: ${payload.skillName} → ${payload.enabled}`);
        ws.send(JSON.stringify({ type: 'skills.list', payload: [], id }));
        break;

      case 'tasks.list':
        ws.send(JSON.stringify({
          type: 'tasks.list',
          payload: [
            { id: 'task_abc123', status: 'Open', reward: '1000000', creator: 'Abc1234...', worker: null },
            { id: 'task_def456', status: 'InProgress', reward: '5000000', creator: 'Xyz9876...', worker: 'Worker1...' },
          ],
          id,
        }));
        break;

      case 'tasks.create':
        console.log('  Create task:', payload.params);
        ws.send(JSON.stringify({ type: 'tasks.list', payload: [], id }));
        break;

      case 'tasks.cancel':
        console.log('  Cancel task:', payload.taskId);
        ws.send(JSON.stringify({ type: 'tasks.list', payload: [], id }));
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

      case 'events.subscribe':
        console.log('  Events subscribed');
        // Send a sample event after a delay
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
        console.log('  Events unsubscribed');
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', error: `Unknown type: ${msg.type}`, id }));
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[-] ${clientId} disconnected`);
  });
});

const startTime = Date.now();

// Send a sample approval request after 10 seconds to any connected client
setTimeout(() => {
  for (const ws of clients.values()) {
    ws.send(JSON.stringify({
      type: 'approval.request',
      payload: {
        requestId: 'approval_001',
        action: 'jupiter.swap',
        details: { fromToken: 'SOL', toToken: 'USDC', amount: '1.5' },
      },
    }));
    console.log('[!] Sent sample approval request');
    break;
  }
}, 10000);
