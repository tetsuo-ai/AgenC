/**
 * Memory-Enhanced Agent
 *
 * Demonstrates an autonomous agent that uses a memory backend to persist
 * context across task executions. The MemoryExecutor wraps any inner executor,
 * storing task descriptions, results, and timing in memory threads.
 *
 * Features:
 *   - Per-task session threads for execution history
 *   - Global "agent-context" session for cross-task knowledge
 *   - KV store for task metadata (durations, result counts)
 *   - Memory query for retrieving past results
 *   - LLM interop via entryToMessage() for feeding context to providers
 *
 * Usage:
 *   npx tsx examples/memory-agent/index.ts
 *
 * Environment:
 *   SOLANA_RPC_URL - RPC endpoint (default: devnet)
 *   KEYPAIR_PATH   - Path to keypair file (default: ~/.config/solana/id.json)
 *
 * Backends:
 *   This example uses InMemoryBackend (zero deps). For persistence, swap to:
 *     - SqliteBackend:  npm install better-sqlite3
 *     - RedisBackend:   npm install ioredis
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  AutonomousAgent,
  AgentCapabilities,
  loadDefaultKeypair,
  createLogger,
  // Memory
  InMemoryBackend,
  entryToMessage,
  // Types
  type MemoryBackend,
  type Task,
  type AutonomousTaskExecutor as TaskExecutor,
} from '@agenc/runtime';
// For alternative backends:
// import { SqliteBackend } from '@agenc/runtime';
// import { RedisBackend } from '@agenc/runtime';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const AGENT_CONTEXT_SESSION = 'agent-context';
const logger = createLogger('info', '[Memory-Agent]');

/**
 * TaskExecutor that wraps an inner executor with memory operations.
 *
 * Before execution: loads recent context from memory.
 * After execution: stores the task description, result, and timing.
 */
class MemoryExecutor implements TaskExecutor {
  constructor(
    private readonly memory: MemoryBackend,
    private readonly inner: TaskExecutor,
  ) {}

  async execute(task: Task): Promise<bigint[]> {
    const taskPda = task.pda.toBase58();
    const sessionId = `task-${taskPda.slice(0, 16)}`;
    const startTime = Date.now();

    // Load recent context from the global agent session
    const recentContext = await this.memory.getThread(AGENT_CONTEXT_SESSION, 5);
    if (recentContext.length > 0) {
      const messages = recentContext.map(entryToMessage);
      logger.info(`Loaded ${messages.length} context entries from previous tasks`);
    }

    // Store the task description in this task's session
    const description = Buffer.from(task.description).toString('utf-8').replace(/\0/g, '').trim();
    await this.memory.addEntry({
      sessionId,
      role: 'user',
      content: `Task: ${description}`,
      taskPda,
      metadata: { reward: task.reward.toString() },
    });

    // Execute the inner executor
    const result = await this.inner.execute(task);

    const durationMs = Date.now() - startTime;

    // Store the result in this task's session
    await this.memory.addEntry({
      sessionId,
      role: 'assistant',
      content: `Result: [${result.join(', ')}]`,
      taskPda,
      metadata: { durationMs },
    });

    // Store a summary in the global agent context (with TTL for cleanup)
    await this.memory.addEntry({
      sessionId: AGENT_CONTEXT_SESSION,
      role: 'assistant',
      content: `Completed task ${taskPda.slice(0, 8)}... in ${durationMs}ms (reward: ${Number(task.reward) / LAMPORTS_PER_SOL} SOL)`,
      ttlMs: 3600_000, // 1 hour TTL
    });

    // Store timing in KV for aggregate stats
    const taskCount = (await this.memory.get<number>('stats:taskCount')) ?? 0;
    const totalDuration = (await this.memory.get<number>('stats:totalDurationMs')) ?? 0;
    await this.memory.set('stats:taskCount', taskCount + 1);
    await this.memory.set('stats:totalDurationMs', totalDuration + durationMs);

    logger.info(`Task ${taskPda.slice(0, 8)}... completed in ${durationMs}ms — stored in memory`);
    return result;
  }

  canExecute(task: Task): boolean {
    return this.inner.canExecute?.(task) ?? true;
  }
}

/**
 * Simple deterministic executor (same as EchoExecutor in autonomous-agent example)
 */
class SimpleExecutor implements TaskExecutor {
  async execute(task: Task): Promise<bigint[]> {
    const output: bigint[] = [];
    for (let i = 0; i < 4; i++) {
      let value = 0n;
      for (let j = 0; j < 8; j++) {
        const idx = (i * 8 + j) % task.taskId.length;
        value |= BigInt(task.taskId[idx]) << BigInt(j * 8);
      }
      output.push(value);
    }
    return output;
  }

  canExecute(): boolean {
    return true;
  }
}

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  AgenC Memory-Enhanced Agent');
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

  // Check balance
  const balance = await connection.getBalance(keypair.publicKey);
  logger.info(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.1 * LAMPORTS_PER_SOL) {
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

  // Create memory backend
  // Zero-dependency in-memory backend — swap for SqliteBackend or RedisBackend for persistence:
  //   const memory = new SqliteBackend({ dbPath: './agent-memory.db', walMode: true, logger });
  //   const memory = new RedisBackend({ host: 'localhost', keyPrefix: 'agenc:memory:', logger });
  const memory = new InMemoryBackend({
    maxEntriesPerSession: 500,
    maxTotalEntries: 10_000,
    logger,
  });

  const healthy = await memory.healthCheck();
  logger.info(`Memory backend: ${memory.name} (healthy: ${healthy})`);

  // Wrap the simple executor with memory
  const executor = new MemoryExecutor(memory, new SimpleExecutor());

  // Create autonomous agent
  const agent = new AutonomousAgent({
    connection,
    wallet: keypair,
    capabilities: BigInt(AgentCapabilities.COMPUTE | AgentCapabilities.STORAGE),
    initialStake: BigInt(0.5 * LAMPORTS_PER_SOL),
    logLevel: 'info',
    executor,
    taskFilter: {
      capabilities: BigInt(AgentCapabilities.COMPUTE),
    },
    scanIntervalMs: 10000,
    maxConcurrentTasks: 1,
    onTaskCompleted: async () => {
      // Print memory stats after each completion
      const taskCount = (await memory.get<number>('stats:taskCount')) ?? 0;
      const totalDuration = (await memory.get<number>('stats:totalDurationMs')) ?? 0;
      const avgMs = taskCount > 0 ? Math.round(totalDuration / taskCount) : 0;
      const sessions = await memory.listSessions();
      logger.info(`Memory stats: ${taskCount} tasks, avg ${avgMs}ms, ${sessions.length} sessions`);
    },
    onTaskFailed: (task: Task, error: Error) => {
      logger.error(`Task ${task.pda.toBase58().slice(0, 8)}... failed: ${error.message}`);
    },
  });

  agent.registerShutdownHandlers();

  try {
    await agent.start();
    logger.info('Agent running with memory-enhanced execution');
    logger.info('Press Ctrl+C to stop.');
    console.log('');

    // Print detailed memory stats every 60s
    const statsInterval = setInterval(async () => {
      const sessions = await memory.listSessions();
      const taskCount = (await memory.get<number>('stats:taskCount')) ?? 0;
      const totalDuration = (await memory.get<number>('stats:totalDurationMs')) ?? 0;
      const contextThread = await memory.getThread(AGENT_CONTEXT_SESSION, 100);

      console.log('');
      console.log('--- Memory Stats ---');
      console.log(`  Sessions: ${sessions.length}`);
      console.log(`  Tasks completed: ${taskCount}`);
      console.log(`  Avg duration: ${taskCount > 0 ? Math.round(totalDuration / taskCount) : 0}ms`);
      console.log(`  Context entries: ${contextThread.length}`);
      console.log('--------------------');
      console.log('');
    }, 60000);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('');
      logger.info('Shutting down...');
      clearInterval(statsInterval);

      // Query all task results before closing
      const results = await memory.query({ role: 'assistant', limit: 100 });
      logger.info(`Total stored results: ${results.length}`);

      await memory.close();
      await agent.stop();
      process.exit(0);
    });

    await new Promise(() => {});
  } catch (error) {
    logger.error(`Agent error: ${error}`);
    await memory.close();
    process.exit(1);
  }
}

main().catch(console.error);
