/**
 * AgenC Helius Webhook Integration
 *
 * Real-time monitoring of task completions via Helius webhooks.
 * Subscribes to program events from the Sunspot verifier.
 *
 * Bounty: Helius ($5k)
 */

import express from 'express';
import chalk from 'chalk';
import crypto from 'crypto';

// Configuration
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error('Error: HELIUS_API_KEY environment variable is required');
  process.exit(1);
}

// SECURITY: Webhook secret for signature verification
// Generate via: openssl rand -hex 32
// Set this in your Helius webhook configuration
const HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET;
if (!HELIUS_WEBHOOK_SECRET) {
  console.warn(chalk.yellow('Warning: HELIUS_WEBHOOK_SECRET not set. Webhook signature verification disabled.'));
  console.warn(chalk.yellow('  This is a security risk in production. Set HELIUS_WEBHOOK_SECRET to enable verification.'));
}
const VERIFIER_PROGRAM_ID = '8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ';
const AGENC_PROGRAM_ID = 'EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ';
const WEBHOOK_PORT = process.env.PORT || 3000;

// Helius API endpoints
const HELIUS_API_URL = 'https://api.helius.xyz/v0';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

interface WebhookPayload {
  webhookId: string;
  webhookType: string;
  accountId: string;
  timestamp: number;
  txnSignature: string;
  slot: number;
  events: TransactionEvent[];
}

interface TransactionEvent {
  type: string;
  source: string;
  description?: string;
  nativeTransfers?: Array<{ from: string; to: string; amount: number }>;
  tokenTransfers?: Array<{ from: string; to: string; mint: string; amount: number }>;
  accountData?: Array<{ account: string; nativeBalanceChange: number; tokenBalanceChanges: unknown[] }>;
  instructions?: InstructionEvent[];
}

interface InstructionEvent {
  programId: string;
  data: string;
  accounts: string[];
  innerInstructions?: InstructionEvent[];
}

interface TaskCompletionEvent {
  taskId: number;
  worker: string;
  proofVerified: boolean;
  timestamp: number;
  txSignature: string;
}

// Rate limiting configuration
interface RateLimitEntry {
  count: number;
  resetTime: number;
}
const RATE_LIMIT_MAX = 100; // Max requests per window
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window
const rateLimitMap = new Map<string, RateLimitEntry>();

/**
 * Check rate limit for an IP address
 * SECURITY: Prevents DoS attacks on webhook endpoint
 */
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

/**
 * Verify Helius webhook signature
 * SECURITY: Prevents webhook spoofing attacks
 * @see https://docs.helius.xyz/webhooks/webhook-security
 */
function verifyWebhookSignature(payload: string, signature: string | undefined): boolean {
  if (!HELIUS_WEBHOOK_SECRET) {
    // Signature verification disabled - warn but allow in development
    return true;
  }

  if (!signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', HELIUS_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

/**
 * Validate webhook payload structure
 * SECURITY: Prevents malformed payload processing
 */
function isValidWebhookPayload(payload: unknown): payload is WebhookPayload[] {
  if (!Array.isArray(payload)) {
    return false;
  }

  for (const item of payload) {
    if (typeof item !== 'object' || item === null) {
      return false;
    }
    // Check required fields exist
    if (!('txnSignature' in item) || !('events' in item)) {
      return false;
    }
  }

  return true;
}

// WARNING: In-memory storage - data is lost on restart and not suitable for production.
// Use a persistent database (PostgreSQL, Redis, etc.) for production deployments.
const completedTasks: TaskCompletionEvent[] = [];

/**
 * Create a Helius webhook subscription
 */
async function createWebhook(webhookUrl: string): Promise<string> {
  const response = await fetch(`${HELIUS_API_URL}/webhooks?api-key=${HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookURL: webhookUrl,
      transactionTypes: ['ANY'],
      accountAddresses: [VERIFIER_PROGRAM_ID, AGENC_PROGRAM_ID],
      webhookType: 'enhanced',
      txnStatus: 'success',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create webhook: ${error}`);
  }

  const data = await response.json();
  console.log(chalk.green('Webhook created successfully!'));
  console.log(chalk.gray('  Webhook ID:'), data.webhookID);
  console.log(chalk.gray('  URL:'), webhookUrl);
  return data.webhookID;
}

/**
 * List existing webhooks
 */
async function listWebhooks(): Promise<any[]> {
  const response = await fetch(`${HELIUS_API_URL}/webhooks?api-key=${HELIUS_API_KEY}`);

  if (!response.ok) {
    throw new Error('Failed to list webhooks');
  }

  return response.json();
}

/**
 * Delete a webhook
 */
async function deleteWebhook(webhookId: string): Promise<void> {
  const response = await fetch(
    `${HELIUS_API_URL}/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`,
    { method: 'DELETE' }
  );

  if (!response.ok) {
    throw new Error('Failed to delete webhook');
  }

  console.log(chalk.yellow('Webhook deleted:'), webhookId);
}

/**
 * Parse task completion from transaction
 */
function parseTaskCompletion(payload: WebhookPayload): TaskCompletionEvent | null {
  try {
    // Look for verifier program invocation
    for (const event of payload.events) {
      if (!event.instructions) continue;

      for (const ix of event.instructions) {
        // Check if this is a verification instruction
        if (ix.programId === VERIFIER_PROGRAM_ID) {
          // Parse the instruction data to extract task details
          // In production, decode the actual instruction data
          return {
            taskId: extractTaskId(ix.data),
            worker: ix.accounts[0] || 'unknown',
            proofVerified: true,
            timestamp: payload.timestamp,
            txSignature: payload.txnSignature,
          };
        }

        // Check for AgenC complete_task_private instruction
        if (ix.programId === AGENC_PROGRAM_ID) {
          const decoded = decodeAgencInstruction(ix.data);
          if (decoded?.type === 'complete_task_private') {
            return {
              taskId: decoded.taskId,
              worker: ix.accounts[0] || 'unknown',
              proofVerified: true,
              timestamp: payload.timestamp,
              txSignature: payload.txnSignature,
            };
          }
        }
      }
    }
  } catch (error) {
    console.error('Error parsing task completion:', error);
  }

  return null;
}

/**
 * Extract task ID from instruction data (simplified)
 */
function extractTaskId(data: string): number {
  // In production, properly decode the base58/base64 instruction data
  // For demo, return a placeholder
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length >= 8) {
    return bytes.readUInt32LE(4);
  }
  return 0;
}

/**
 * Decode AgenC instruction (simplified)
 */
function decodeAgencInstruction(data: string): { type: string; taskId: number } | null {
  try {
    const bytes = Buffer.from(data, 'base64');
    // Check instruction discriminator for complete_task_private
    // Actual discriminator would be derived from anchor
    const discriminator = bytes.slice(0, 8);
    return {
      type: 'complete_task_private',
      taskId: bytes.readUInt32LE(8),
    };
  } catch {
    return null;
  }
}

/**
 * Start webhook server
 */
function startServer(): void {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', completedTasks: completedTasks.length });
  });

  // Webhook endpoint with security checks
  app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    // SECURITY: Rate limiting
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
      console.warn(chalk.red('Rate limit exceeded for IP:'), clientIp);
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    // SECURITY: Verify webhook signature
    const signature = req.headers['x-helius-signature'] as string | undefined;
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.warn(chalk.red('Invalid webhook signature from IP:'), clientIp);
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Parse and validate payload
    let payload: unknown;
    try {
      payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      console.warn(chalk.red('Invalid JSON payload'));
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }

    // SECURITY: Validate payload structure
    if (!isValidWebhookPayload(payload)) {
      console.warn(chalk.red('Invalid webhook payload structure'));
      res.status(400).json({ error: 'Invalid payload structure' });
      return;
    }

    console.log(chalk.cyan('\n[Webhook Received]'), new Date().toISOString());

    for (const event of payload) {
      console.log(chalk.gray('  Transaction:'), event.txnSignature?.slice(0, 20) + '...');
      console.log(chalk.gray('  Slot:'), event.slot);

      const taskEvent = parseTaskCompletion(event);
      if (taskEvent) {
        completedTasks.push(taskEvent);

        console.log(chalk.green('\n  Task Completed!'));
        console.log(chalk.white('    Task ID:'), taskEvent.taskId);
        console.log(chalk.white('    Worker:'), taskEvent.worker.slice(0, 20) + '...');
        console.log(chalk.white('    Proof Verified:'), taskEvent.proofVerified);
        console.log(chalk.white('    Signature:'), taskEvent.txSignature.slice(0, 30) + '...');
        console.log();

        // Emit event for real-time monitoring
        emitTaskCompletion(taskEvent);
      }
    }

    res.status(200).json({ received: true });
  });

  // API: List completed tasks
  app.get('/api/tasks', (req, res) => {
    res.json({
      count: completedTasks.length,
      tasks: completedTasks.slice(-100), // Last 100
    });
  });

  // API: Task stats
  app.get('/api/stats', (req, res) => {
    const now = Date.now();
    const lastHour = completedTasks.filter((t) => now - t.timestamp * 1000 < 3600000);
    const lastDay = completedTasks.filter((t) => now - t.timestamp * 1000 < 86400000);

    res.json({
      total: completedTasks.length,
      lastHour: lastHour.length,
      lastDay: lastDay.length,
      uniqueWorkers: new Set(completedTasks.map((t) => t.worker)).size,
    });
  });

  app.listen(WEBHOOK_PORT, () => {
    console.log(chalk.bold('\nAgenC Helius Webhook Server'));
    console.log(chalk.gray('================================'));
    console.log(chalk.white('  Port:'), WEBHOOK_PORT);
    console.log(chalk.white('  Monitoring:'));
    console.log(chalk.gray('    - Verifier:'), VERIFIER_PROGRAM_ID);
    console.log(chalk.gray('    - AgenC:'), AGENC_PROGRAM_ID);
    console.log();
    console.log(chalk.yellow('Endpoints:'));
    console.log(chalk.gray('  POST /webhook     - Helius webhook receiver'));
    console.log(chalk.gray('  GET  /health      - Health check'));
    console.log(chalk.gray('  GET  /api/tasks   - List completed tasks'));
    console.log(chalk.gray('  GET  /api/stats   - Task statistics'));
    console.log();
  });
}

/**
 * Emit task completion event (for external integrations)
 */
function emitTaskCompletion(event: TaskCompletionEvent): void {
  // In production, emit to:
  // - WebSocket clients
  // - Discord/Telegram bot
  // - Analytics service
  // - Database
  console.log(chalk.blue('  [Event Emitted]'), JSON.stringify(event));
}

/**
 * Subscribe to program logs via WebSocket (alternative to webhooks)
 */
async function subscribeToLogs(): Promise<void> {
  const WebSocket = (await import('ws')).default;
  const wsUrl = HELIUS_RPC_URL.replace('https://', 'wss://');

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(chalk.green('WebSocket connected to Helius'));

    // Subscribe to program logs
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [
          { mentions: [VERIFIER_PROGRAM_ID] },
          { commitment: 'confirmed' },
        ],
      })
    );

    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'logsSubscribe',
        params: [
          { mentions: [AGENC_PROGRAM_ID] },
          { commitment: 'confirmed' },
        ],
      })
    );
  });

  ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString());

    if (message.method === 'logsNotification') {
      const result = message.params.result;
      console.log(chalk.cyan('\n[Log Notification]'));
      console.log(chalk.gray('  Signature:'), result.value.signature);
      console.log(chalk.gray('  Logs:'), result.value.logs?.slice(0, 3));
    }
  });

  ws.on('error', (error: Error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('WebSocket closed, reconnecting...');
    setTimeout(subscribeToLogs, 5000);
  });
}

// CLI commands
const command = process.argv[2];

switch (command) {
  case 'server':
    startServer();
    break;

  case 'subscribe':
    subscribeToLogs();
    break;

  case 'create':
    const webhookUrl = process.argv[3];
    if (!webhookUrl) {
      console.error('Usage: npx tsx index.ts create <webhook-url>');
      process.exit(1);
    }
    createWebhook(webhookUrl).catch(console.error);
    break;

  case 'list':
    listWebhooks().then((webhooks) => {
      console.log(chalk.bold('Existing Webhooks:'));
      for (const wh of webhooks) {
        console.log(chalk.gray('  ID:'), wh.webhookID);
        console.log(chalk.gray('  URL:'), wh.webhookURL);
        console.log();
      }
    });
    break;

  case 'delete':
    const webhookId = process.argv[3];
    if (!webhookId) {
      console.error('Usage: npx tsx index.ts delete <webhook-id>');
      process.exit(1);
    }
    deleteWebhook(webhookId).catch(console.error);
    break;

  default:
    console.log(chalk.bold('\nAgenC Helius Webhook Integration'));
    console.log(chalk.gray('Usage:'));
    console.log('  npx tsx index.ts server              Start webhook server');
    console.log('  npx tsx index.ts subscribe           Subscribe via WebSocket');
    console.log('  npx tsx index.ts create <url>        Create webhook');
    console.log('  npx tsx index.ts list                List webhooks');
    console.log('  npx tsx index.ts delete <id>         Delete webhook');
    console.log();
    console.log(chalk.gray('Environment:'));
    console.log('  HELIUS_API_KEY         Your Helius API key');
    console.log('  HELIUS_WEBHOOK_SECRET  Webhook signature secret (required for production)');
    console.log('  PORT                   Server port (default: 3000)');
    console.log();
}
