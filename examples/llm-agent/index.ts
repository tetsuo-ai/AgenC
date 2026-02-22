/**
 * LLM-Powered Task Agent
 *
 * Demonstrates an autonomous agent that uses an LLM provider (Grok or Ollama)
 * to execute tasks, with tool calling for on-chain protocol queries.
 *
 * The critical wiring pattern for tools:
 *   1. registry.toLLMTools()        -> passed to the PROVIDER config as `tools`
 *   2. registry.createToolHandler() -> passed to LLMTaskExecutor as `toolHandler`
 *   Both are required — if either is missing, tool calls silently do nothing.
 *
 * Usage:
 *   npx tsx examples/llm-agent/index.ts
 *
 * Environment:
 *   SOLANA_RPC_URL    - RPC endpoint (default: devnet)
 *   KEYPAIR_PATH      - Path to keypair file (default: ~/.config/solana/id.json)
 *
 *   Provider selection (first match wins):
 *   XAI_API_KEY       - Use Grok (xAI) provider
 *   (not set)         - Fall back to Ollama (local, no API key needed)
 *
 *   Model override:
 *   GROK_MODEL        - Grok model (default: grok-3)
 *   OLLAMA_MODEL      - Ollama model (default: llama3)
 *
 * Prerequisites:
 *   Install the SDK for your chosen provider:
 *   - Grok:   npm install openai
 *   - Ollama: npm install ollama
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  AutonomousAgent,
  AgentCapabilities,
  loadDefaultKeypair,
  createReadOnlyProgram,
  createLogger,
  // LLM
  GrokProvider,
  OllamaProvider,
  LLMTaskExecutor,
  // Tools
  ToolRegistry,
  createAgencTools,
  // Types
  type LLMProvider,
  type Task,
} from '@agenc/runtime';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const logger = createLogger('info', '[LLM-Agent]');

/**
 * Select an LLM provider based on available environment variables.
 * Priority: XAI_API_KEY > Ollama (local).
 */
function createProvider(tools: ReturnType<ToolRegistry['toLLMTools']>): LLMProvider {
  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey) {
    const model = process.env.GROK_MODEL || 'grok-3';
    logger.info(`Using Grok provider (model: ${model})`);
    return new GrokProvider({
      apiKey: xaiKey,
      model,
      tools,
      temperature: 0.7,
      maxTokens: 2048,
    });
  }

  const model = process.env.OLLAMA_MODEL || 'llama3';
  logger.info(`Using Ollama provider (model: ${model}) — no API key found`);
  return new OllamaProvider({
    model,
    tools,
    temperature: 0.7,
    maxTokens: 2048,
  });
}

/**
 * Set up the tool registry with built-in AgenC protocol query tools.
 * Returns both the LLM tool definitions and the tool handler.
 */
function createTools(connection: Connection) {
  const registry = new ToolRegistry({ logger });

  // Register built-in protocol query tools:
  //   agenc.listTasks, agenc.getTask, agenc.getAgent, agenc.getProtocolConfig
  const readOnlyProgram = createReadOnlyProgram(connection);
  registry.registerAll(createAgencTools({ connection, program: readOnlyProgram, logger }));

  return {
    tools: registry.toLLMTools(),
    handler: registry.createToolHandler(),
  };
}

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  AgenC LLM-Powered Task Agent');
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
    logger.info('(You will need to airdrop SOL to this address)');
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

  // --- Tool wiring (critical two-site pattern) ---
  // 1. Create tools and get both LLM tool definitions AND the handler
  const { tools, handler } = createTools(connection);

  // 2. Pass tool definitions to the PROVIDER (so the LLM knows what tools exist)
  const provider = createProvider(tools);

  // 3. Create executor with BOTH the provider AND the handler
  //    The handler is called when the LLM makes tool calls during execution
  const executor = new LLMTaskExecutor({
    provider,
    toolHandler: handler,
    systemPrompt: [
      'You are an AI agent executing tasks on the AgenC protocol.',
      'You can query protocol state using the available tools.',
      'Analyze the task description and provide a thoughtful response.',
    ].join(' '),
    streaming: true,
    onStreamChunk: (chunk) => {
      if (chunk.content) process.stdout.write(chunk.content);
      if (chunk.done) console.log('');
    },
  });

  // Create the autonomous agent with the LLM executor
  const agent = new AutonomousAgent({
    connection,
    wallet: keypair,
    capabilities: BigInt(AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE),
    initialStake: BigInt(0.5 * LAMPORTS_PER_SOL),
    logLevel: 'info',
    executor,
    taskFilter: {
      capabilities: BigInt(AgentCapabilities.COMPUTE),
      minReward: BigInt(0.01 * LAMPORTS_PER_SOL),
    },
    scanIntervalMs: 10000,
    maxConcurrentTasks: 1,
    onTaskDiscovered: (task: Task) => {
      logger.info(`Discovered task ${task.pda.toBase58().slice(0, 8)}... (${Number(task.reward) / LAMPORTS_PER_SOL} SOL)`);
    },
    onTaskClaimed: (task: Task, tx: string) => {
      logger.info(`Claimed task ${task.pda.toBase58().slice(0, 8)}... TX: ${tx.slice(0, 16)}...`);
    },
    onTaskCompleted: (task: Task, tx: string) => {
      logger.info(`Completed task ${task.pda.toBase58().slice(0, 8)}... TX: ${tx.slice(0, 16)}...`);
    },
    onTaskFailed: (task: Task, error: Error) => {
      logger.error(`Task ${task.pda.toBase58().slice(0, 8)}... failed: ${error.message}`);
    },
    onEarnings: (amount: bigint) => {
      logger.info(`Earned ${Number(amount) / LAMPORTS_PER_SOL} SOL`);
    },
  });

  agent.registerShutdownHandlers();

  try {
    await agent.start();
    logger.info('Agent running — scanning for tasks...');
    logger.info('Press Ctrl+C to stop.');
    console.log('');

    // Print stats every 30s
    const statsInterval = setInterval(() => {
      const stats = agent.getStats();
      console.log('');
      console.log('--- Agent Stats ---');
      console.log(`  Uptime: ${Math.floor(stats.uptimeMs / 1000)}s`);
      console.log(`  Discovered: ${stats.tasksDiscovered} | Claimed: ${stats.tasksClaimed}`);
      console.log(`  Completed: ${stats.tasksCompleted} | Failed: ${stats.tasksFailed}`);
      console.log(`  Earnings: ${Number(stats.totalEarnings) / LAMPORTS_PER_SOL} SOL`);
      console.log('-------------------');
      console.log('');
    }, 30000);

    await new Promise(() => {});
    clearInterval(statsInterval);
  } catch (error) {
    logger.error(`Agent error: ${error}`);
    process.exit(1);
  }
}

main().catch(console.error);
