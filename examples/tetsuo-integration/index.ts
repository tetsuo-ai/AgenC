/**
 * Tetsuo AI Agent Integration with AgenC
 *
 * This example demonstrates how Tetsuo AI agents use AgenC for:
 * 1. Discovering and claiming tasks
 * 2. Completing work with AI capabilities
 * 3. Generating ZK proofs of completion
 * 4. Receiving private payments via Privacy Cash
 *
 * Tetsuo is an AI agent framework that can:
 * - Process natural language instructions
 * - Execute multi-step workflows
 * - Generate verifiable outputs
 * - Operate autonomously with budget constraints
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import chalk from 'chalk';

// AgenC SDK imports (from @agenc/sdk)
// import { PrivacyClient, generateProof, generateSalt, VERIFIER_PROGRAM_ID } from '@agenc/sdk';

// Simulated imports for demo
const VERIFIER_PROGRAM_ID = new PublicKey('8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ');
const AGENC_PROGRAM_ID = new PublicKey('EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ');

// ============================================================================
// Tetsuo Agent Configuration
// ============================================================================

interface TetsuoAgentConfig {
  /** Agent's wallet keypair */
  wallet: Keypair;
  /** Capabilities the agent can perform */
  capabilities: AgentCapability[];
  /** Maximum task value agent will accept */
  maxTaskValue: number;
  /** Minimum reputation to accept tasks from */
  minCreatorReputation: number;
  /** AI model to use for task execution */
  aiModel: 'tetsuo-7b' | 'tetsuo-70b' | 'tetsuo-405b';
  /** RPC endpoint */
  rpcUrl: string;
}

type AgentCapability =
  | 'text-generation'
  | 'code-generation'
  | 'data-analysis'
  | 'image-analysis'
  | 'document-summarization'
  | 'translation'
  | 'research';

interface Task {
  id: number;
  creator: PublicKey;
  description: string;
  requiredCapabilities: AgentCapability[];
  rewardLamports: number;
  deadline: number;
  constraintHash: Buffer;
  isPrivate: boolean;
}

interface TaskResult {
  output: bigint[];
  metadata: {
    tokensUsed: number;
    executionTimeMs: number;
    confidence: number;
  };
}

// ============================================================================
// Tetsuo Agent Class
// ============================================================================

class TetsuoAgent {
  private config: TetsuoAgentConfig;
  private connection: Connection;
  private activeTasks: Map<number, Task> = new Map();

  constructor(config: TetsuoAgentConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
  }

  /**
   * Initialize the agent and register with AgenC
   */
  async initialize(): Promise<void> {
    console.log(chalk.bold('\nTetsuo Agent Initializing...'));
    console.log(chalk.gray('  Wallet:'), this.config.wallet.publicKey.toBase58());
    console.log(chalk.gray('  Model:'), this.config.aiModel);
    console.log(chalk.gray('  Capabilities:'), this.config.capabilities.join(', '));

    // Register agent with AgenC protocol
    await this.registerWithAgenc();

    console.log(chalk.green('  Agent registered successfully!'));
  }

  /**
   * Register agent with AgenC protocol
   */
  private async registerWithAgenc(): Promise<void> {
    // In production:
    // const program = new Program(IDL, AGENC_PROGRAM_ID, provider);
    // await program.methods.registerAgent({
    //   capabilities: this.encodeCapabilities(),
    //   endpoint: 'https://api.tetsuo.ai/agent',
    //   metadataUri: 'ipfs://...',
    // }).accounts({...}).rpc();

    console.log(chalk.gray('  Registering with AgenC program...'));
  }

  /**
   * Discover available tasks matching agent capabilities
   */
  async discoverTasks(): Promise<Task[]> {
    console.log(chalk.cyan('\nDiscovering tasks...'));

    // In production, fetch from chain:
    // const tasks = await program.account.task.all([
    //   { memcmp: { offset: 8, bytes: TaskStatus.Open } }
    // ]);

    // Simulated tasks for demo
    const tasks: Task[] = [
      {
        id: 1,
        creator: Keypair.generate().publicKey,
        description: 'Summarize the attached research paper on quantum computing',
        requiredCapabilities: ['document-summarization', 'research'],
        rewardLamports: 0.5 * LAMPORTS_PER_SOL,
        deadline: Date.now() / 1000 + 3600,
        constraintHash: Buffer.alloc(32), // DEMO ONLY: Real tasks require valid constraint hashes
        isPrivate: true,
      },
      {
        id: 2,
        creator: Keypair.generate().publicKey,
        description: 'Generate TypeScript code for a REST API client',
        requiredCapabilities: ['code-generation'],
        rewardLamports: 0.3 * LAMPORTS_PER_SOL,
        deadline: Date.now() / 1000 + 7200,
        constraintHash: Buffer.alloc(32), // DEMO ONLY: Real tasks require valid constraint hashes
        isPrivate: true,
      },
      {
        id: 3,
        creator: Keypair.generate().publicKey,
        description: 'Translate technical documentation from English to Japanese',
        requiredCapabilities: ['translation'],
        rewardLamports: 0.2 * LAMPORTS_PER_SOL,
        deadline: Date.now() / 1000 + 1800,
        constraintHash: Buffer.alloc(32), // DEMO ONLY: Real tasks require valid constraint hashes
        isPrivate: false,
      },
    ];

    // Filter tasks by agent capabilities
    const matchingTasks = tasks.filter((task) =>
      task.requiredCapabilities.every((cap) =>
        this.config.capabilities.includes(cap)
      )
    );

    console.log(chalk.gray(`  Found ${matchingTasks.length} matching tasks`));
    return matchingTasks;
  }

  /**
   * Claim a task for execution
   */
  async claimTask(task: Task): Promise<boolean> {
    console.log(chalk.cyan(`\nClaiming task #${task.id}...`));
    console.log(chalk.gray('  Description:'), task.description.slice(0, 50) + '...');
    console.log(chalk.gray('  Reward:'), (task.rewardLamports / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
    console.log(chalk.gray('  Private:'), task.isPrivate ? 'Yes (ZK proof required)' : 'No');

    // Validate task constraints
    if (task.rewardLamports > this.config.maxTaskValue * LAMPORTS_PER_SOL) {
      console.log(chalk.yellow('  Skipping: Reward exceeds agent limit'));
      return false;
    }

    // In production:
    // await program.methods.claimTask(task.id).accounts({...}).rpc();

    this.activeTasks.set(task.id, task);
    console.log(chalk.green('  Task claimed successfully!'));
    return true;
  }

  /**
   * Execute task using Tetsuo AI capabilities
   */
  async executeTask(taskId: number): Promise<TaskResult> {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found in active tasks`);
    }

    console.log(chalk.cyan(`\nExecuting task #${taskId}...`));
    console.log(chalk.gray('  Using model:'), this.config.aiModel);

    const startTime = Date.now();

    // Simulate AI task execution
    // In production, this would call the Tetsuo AI API
    const result = await this.simulateAIExecution(task);

    const executionTime = Date.now() - startTime;
    console.log(chalk.gray('  Execution time:'), executionTime, 'ms');
    console.log(chalk.gray('  Tokens used:'), result.metadata.tokensUsed);
    console.log(chalk.gray('  Confidence:'), (result.metadata.confidence * 100).toFixed(1) + '%');

    return result;
  }

  /**
   * Simulate AI task execution
   */
  private async simulateAIExecution(task: Task): Promise<TaskResult> {
    // Simulate processing time
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Generate deterministic output based on task
    // In production, this would be the actual AI output hash
    const outputHash = this.hashTaskOutput(task.description);

    return {
      output: [
        BigInt('0x' + outputHash.slice(0, 16)),
        BigInt('0x' + outputHash.slice(16, 32)),
        BigInt('0x' + outputHash.slice(32, 48)),
        BigInt('0x' + outputHash.slice(48, 64)),
      ],
      metadata: {
        tokensUsed: Math.floor(Math.random() * 5000) + 1000,
        executionTimeMs: Math.floor(Math.random() * 3000) + 500,
        confidence: 0.85 + Math.random() * 0.14,
      },
    };
  }

  /**
   * Generate ZK proof of task completion
   */
  async generateCompletionProof(
    taskId: number,
    result: TaskResult
  ): Promise<{ proof: Buffer; publicWitness: Buffer }> {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    console.log(chalk.cyan(`\nGenerating ZK proof for task #${taskId}...`));

    // Generate random salt for commitment
    const salt = this.generateSalt();

    // In production:
    // const { proof, publicWitness } = await generateProof({
    //   taskId,
    //   agentPubkey: this.config.wallet.publicKey,
    //   constraintHash: task.constraintHash,
    //   outputCommitment: this.computeCommitment(result.output, salt),
    //   output: result.output,
    //   salt,
    // });

    // WARNING: Simulated proof for demo only - these are zero-filled buffers!
    // In production, use: const { proof, publicWitness } = await generateProof({...});
    const proof = Buffer.alloc(388); // Groth16 proof size (DEMO: zeros)
    const publicWitness = Buffer.alloc(35 * 32); // 35 public inputs (DEMO: zeros)

    console.log(chalk.gray('  Proof size:'), proof.length, 'bytes');
    console.log(chalk.gray('  Public inputs:'), 35);
    console.log(chalk.green('  Proof generated successfully!'));

    return { proof, publicWitness };
  }

  /**
   * Submit proof and receive private payment
   */
  async submitProofAndGetPaid(
    taskId: number,
    proof: Buffer,
    publicWitness: Buffer
  ): Promise<{ txSignature: string; paymentReceived: boolean }> {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    console.log(chalk.cyan(`\nSubmitting proof for task #${taskId}...`));

    // In production:
    // 1. Submit proof to on-chain verifier
    // const verifyTx = await program.methods.completeTaskPrivate(taskId, {
    //   zkProof: Array.from(proof),
    //   publicWitness: Array.from(publicWitness),
    // }).accounts({
    //   worker: this.config.wallet.publicKey,
    //   zkVerifier: VERIFIER_PROGRAM_ID,
    //   ...
    // }).rpc();

    // 2. Receive private payment via Privacy Cash
    // const withdrawTx = await privacyCash.withdraw({
    //   lamports: task.rewardLamports,
    //   recipientAddress: this.getPrivateRecipientWallet(),
    // });

    const txSignature = 'simulated_tx_' + Date.now();

    console.log(chalk.gray('  Proof verified on-chain'));
    console.log(chalk.gray('  Payment received via Privacy Cash'));
    console.log(chalk.gray('  Amount:'), (task.rewardLamports / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
    console.log(chalk.green('  Transaction:'), txSignature.slice(0, 20) + '...');

    // Remove from active tasks
    this.activeTasks.delete(taskId);

    return { txSignature, paymentReceived: true };
  }

  /**
   * Run the agent's main loop
   */
  async run(): Promise<void> {
    console.log(chalk.bold.cyan('\n=== Tetsuo Agent Main Loop ===\n'));

    // 1. Discover tasks
    const tasks = await this.discoverTasks();

    if (tasks.length === 0) {
      console.log(chalk.yellow('No matching tasks found. Waiting...'));
      return;
    }

    // 2. Select best task (highest reward that we can complete)
    const selectedTask = tasks.sort((a, b) => b.rewardLamports - a.rewardLamports)[0];

    // 3. Claim task
    const claimed = await this.claimTask(selectedTask);
    if (!claimed) return;

    // 4. Execute task with AI
    const result = await this.executeTask(selectedTask.id);

    // 5. Generate ZK proof (for private tasks)
    if (selectedTask.isPrivate) {
      const { proof, publicWitness } = await this.generateCompletionProof(
        selectedTask.id,
        result
      );

      // 6. Submit proof and receive private payment
      await this.submitProofAndGetPaid(selectedTask.id, proof, publicWitness);
    } else {
      // Standard (non-private) completion
      console.log(chalk.cyan('\nSubmitting standard completion...'));
      // await program.methods.completeTask({...}).rpc();
    }

    console.log(chalk.bold.green('\n=== Task Completed Successfully! ===\n'));
  }

  // Helper methods
  private hashTaskOutput(input: string): string {
    // WARNING: This is a demo-only hash. In production, use a cryptographic hash:
    // import { createHash } from 'crypto';
    // return createHash('sha256').update(input).digest('hex');
    let hash = '';
    for (let i = 0; i < 64; i++) {
      hash += ((input.charCodeAt(i % input.length) + i) % 16).toString(16);
    }
    return hash;
  }

  private generateSalt(): bigint {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let salt = BigInt(0);
    for (const byte of bytes) {
      salt = (salt << 8n) | BigInt(byte);
    }
    return salt % (2n ** 254n);
  }
}

// ============================================================================
// Demo Execution
// ============================================================================

async function main() {
  console.log(chalk.bold.white('\n========================================'));
  console.log(chalk.bold.white('   Tetsuo AI + AgenC Integration Demo'));
  console.log(chalk.bold.white('========================================'));
  console.log(chalk.gray('Privacy-preserving AI agent task execution'));
  console.log();

  // Create agent configuration
  const agentConfig: TetsuoAgentConfig = {
    wallet: Keypair.generate(), // DEMO ONLY: Load from secure storage in production
    capabilities: [
      'text-generation',
      'code-generation',
      'document-summarization',
      'research',
    ],
    maxTaskValue: 1.0, // Max 1 SOL per task
    minCreatorReputation: 50,
    aiModel: 'tetsuo-70b',
    rpcUrl: 'https://api.devnet.solana.com',
  };

  // Initialize agent
  const agent = new TetsuoAgent(agentConfig);
  await agent.initialize();

  // Run agent loop
  await agent.run();

  // Summary
  console.log(chalk.bold('\nPrivacy Summary:'));
  console.log(chalk.gray('  - Task output hidden via ZK proof'));
  console.log(chalk.gray('  - Payment received via Privacy Cash'));
  console.log(chalk.gray('  - No link between task creator and payment recipient'));
  console.log();
  console.log(chalk.gray('Contracts:'));
  console.log(chalk.gray('  AgenC:'), AGENC_PROGRAM_ID.toBase58());
  console.log(chalk.gray('  Verifier:'), VERIFIER_PROGRAM_ID.toBase58());
  console.log();
}

// Run demo
main().catch(console.error);
