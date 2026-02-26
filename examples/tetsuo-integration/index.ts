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
 *
 * Usage:
 *   npx tsx examples/tetsuo-integration/index.ts
 *
 * Environment:
 *   NODE_ENV (optional) - Set to production to disable demo-mode placeholders
 *
 * ============================================================================
 * SECURITY WARNING - DEMO CODE ONLY
 * ============================================================================
 * This file contains simulated/placeholder implementations that are NOT
 * suitable for production use:
 *
 * 1. Keypairs are generated ephemerally - use secure storage in production
 * 2. ZK proofs are zero-filled buffers - use actual proof generation
 * 3. Constraint hashes are empty - use real cryptographic hashes
 * 4. Hash functions are non-cryptographic - use proper crypto libraries
 *
 * DO NOT use this code in production without replacing these placeholders.
 * ============================================================================
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import chalk from 'chalk';
import crypto from 'crypto';

// ============================================================================
// PRODUCTION GUARD - Fail fast if demo code is used in production
// ============================================================================
const IS_DEMO_MODE = process.env.NODE_ENV !== 'production';

if (!IS_DEMO_MODE) {
  console.error(chalk.red('\n============================================================================'));
  console.error(chalk.red('FATAL ERROR: This demo file cannot be used in production!'));
  console.error(chalk.red('============================================================================'));
  console.error(chalk.yellow('This file contains simulated implementations that provide NO security:'));
  console.error(chalk.yellow('  - Ephemeral keypairs (keys lost on restart)'));
  console.error(chalk.yellow('  - Zero-filled ZK proofs (will fail verification)'));
  console.error(chalk.yellow('  - Non-cryptographic hash functions (trivially reversible)'));
  console.error(chalk.yellow('\nTo use AgenC in production, implement:'));
  console.error(chalk.yellow('  1. Secure keypair storage (hardware wallet, KMS, etc.)'));
  console.error(chalk.yellow('  2. Real ZK proof generation via @agenc/sdk'));
  console.error(chalk.yellow('  3. SHA-256 for cryptographic hashing'));
  console.error(chalk.red('============================================================================\n'));
  process.exit(1);
}

// AgenC SDK imports (from @agenc/sdk)
// In production, uncomment and use:
// import { PrivacyClient, generateProof, generateSalt } from '@agenc/sdk';

// Simulated imports for demo
const AGENC_PROGRAM_ID = new PublicKey('5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7');
const ROUTER_PROGRAM_ID = new PublicKey('6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7');
const VERIFIER_PROGRAM_ID = new PublicKey('THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge');
const TRUSTED_SELECTOR = Buffer.from('525a5631', 'hex');
const TRUSTED_IMAGE_ID = Buffer.from('11'.repeat(32), 'hex');
const ROUTER_SEED = Buffer.from('router');
const VERIFIER_SEED = Buffer.from('verifier');
const BINDING_SPEND_SEED = Buffer.from('binding_spend');
const NULLIFIER_SPEND_SEED = Buffer.from('nullifier_spend');

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

interface PrivatePayload {
  sealBytes: Buffer;
  journal: Buffer;
  imageId: Buffer;
  bindingSeed: Buffer;
  nullifierSeed: Buffer;
}

interface PrivateSubmissionAccounts {
  routerProgram: PublicKey;
  router: PublicKey;
  verifierEntry: PublicKey;
  verifierProgram: PublicKey;
  bindingSpend: PublicKey;
  nullifierSpend: PublicKey;
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
   * Generate private payload + account model for complete_task_private
   */
  async generateCompletionProof(
    taskId: number,
    result: TaskResult
  ): Promise<{ payload: PrivatePayload; accounts: PrivateSubmissionAccounts }> {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    console.log(chalk.cyan(`\nGenerating private payload for task #${taskId}...`));

    // Generate random salt for commitment simulation
    const salt = this.generateSalt().toString(16).padStart(64, '0');
    const outputCommitment = Buffer.from(this.hashTaskOutput(`${result.output.join(',')}:${salt}`), 'hex');
    const constraintHash = task.constraintHash.length === 32
      ? Buffer.from(task.constraintHash)
      : Buffer.alloc(32);

    const bindingSeed = this.sha256(
      Buffer.from('AGENC_V2_BINDING'),
      Buffer.from([taskId & 0xff]),
      this.config.wallet.publicKey.toBuffer(),
      outputCommitment,
    );
    const nullifierSeed = this.sha256(
      Buffer.from('AGENC_V2_NULLIFIER'),
      constraintHash,
      outputCommitment,
      this.config.wallet.publicKey.toBuffer(),
    );
    const journal = Buffer.concat([
      task.creator.toBuffer(),
      this.config.wallet.publicKey.toBuffer(),
      constraintHash,
      outputCommitment,
      bindingSeed,
      nullifierSeed,
      Buffer.alloc(32), // model_commitment (zero = no model binding)
      Buffer.alloc(32), // input_commitment (zero = no input binding)
    ]);
    if (journal.length !== 256) {
      throw new Error(`Invalid journal length: ${journal.length}`);
    }

    // In production:
    // const generated = await generateProof({
    //   taskId,
    //   taskPda,
    //   agentPubkey: this.config.wallet.publicKey,
    //   output: result.output,
    //   salt,
    // });

    // SECURITY WARNING: Simulated payload for demo only.
    // In production, you MUST use actual payload generation from @agenc/sdk.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Demo payload generation cannot be used in production. Implement real RISC0 payload generation.');
    }
    const sealProof = this.expandBytes(
      this.sha256(Buffer.from('seal'), journal, TRUSTED_IMAGE_ID),
      256,
    );
    const sealBytes = Buffer.concat([TRUSTED_SELECTOR, sealProof]);
    const imageId = Buffer.from(TRUSTED_IMAGE_ID);

    const [bindingSpend] = PublicKey.findProgramAddressSync(
      [BINDING_SPEND_SEED, bindingSeed],
      AGENC_PROGRAM_ID,
    );
    const [nullifierSpend] = PublicKey.findProgramAddressSync(
      [NULLIFIER_SPEND_SEED, nullifierSeed],
      AGENC_PROGRAM_ID,
    );
    const [router] = PublicKey.findProgramAddressSync(
      [ROUTER_SEED],
      ROUTER_PROGRAM_ID,
    );
    const [verifierEntry] = PublicKey.findProgramAddressSync(
      [VERIFIER_SEED, TRUSTED_SELECTOR],
      ROUTER_PROGRAM_ID,
    );

    console.log(chalk.gray('  sealBytes:'), sealBytes.length, 'bytes');
    console.log(chalk.gray('  journal:'), journal.length, 'bytes');
    console.log(chalk.green('  Payload generated successfully!'));

    return {
      payload: {
        sealBytes,
        journal,
        imageId,
        bindingSeed,
        nullifierSeed,
      },
      accounts: {
        routerProgram: ROUTER_PROGRAM_ID,
        router,
        verifierEntry,
        verifierProgram: VERIFIER_PROGRAM_ID,
        bindingSpend,
        nullifierSpend,
      },
    };
  }

  /**
   * Submit payload and receive private payment
   */
  async submitProofAndGetPaid(
    taskId: number,
    payload: PrivatePayload,
    accounts: PrivateSubmissionAccounts,
  ): Promise<{ txSignature: string; paymentReceived: boolean }> {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // SECURITY: Validate payload parameters before submission
    // These validations ensure the parameters are properly formed
    if (payload.sealBytes.length !== 260) {
      throw new Error(`Invalid sealBytes size: expected 260 bytes, got ${payload.sealBytes.length}`);
    }
    if (payload.journal.length !== 256) {
      throw new Error(`Invalid journal size: expected 256 bytes, got ${payload.journal.length}`);
    }
    if (payload.imageId.length !== 32 || payload.bindingSeed.length !== 32 || payload.nullifierSeed.length !== 32) {
      throw new Error('Invalid private payload field lengths');
    }

    console.log(chalk.cyan(`\nSubmitting private payload for task #${taskId}...`));
    console.log(chalk.gray('  sealBytes:'), payload.sealBytes.length, 'bytes');
    console.log(chalk.gray('  journal:'), payload.journal.length, 'bytes');
    console.log(chalk.gray('  router:'), accounts.router.toBase58());
    console.log(chalk.gray('  verifierEntry:'), accounts.verifierEntry.toBase58());

    // In production:
    // 1. Submit private completion payload
    // const verifyTx = await program.methods.completeTaskPrivate(taskId, {
    //   sealBytes: Array.from(payload.sealBytes),
    //   journal: Array.from(payload.journal),
    //   imageId: Array.from(payload.imageId),
    //   bindingSeed: Array.from(payload.bindingSeed),
    //   nullifierSeed: Array.from(payload.nullifierSeed),
    // }).accounts({
    //   routerProgram: accounts.routerProgram,
    //   router: accounts.router,
    //   verifierEntry: accounts.verifierEntry,
    //   verifierProgram: accounts.verifierProgram,
    //   bindingSpend: accounts.bindingSpend,
    //   nullifierSpend: accounts.nullifierSpend,
    //   ...
    // }).rpc();

    // 2. Receive private payment via Privacy Cash
    // const withdrawTx = await privacyCash.withdraw({
    //   lamports: task.rewardLamports,
    //   recipientAddress: this.getPrivateRecipientWallet(),
    // });

    const txSignature = 'simulated_tx_' + Date.now();

    console.log(chalk.gray('  Payload verified on-chain'));
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

    // 5. Generate private payload (for private tasks)
    if (selectedTask.isPrivate) {
      const { payload, accounts } = await this.generateCompletionProof(
        selectedTask.id,
        result
      );

      // 6. Submit private payload and receive private payment
      await this.submitProofAndGetPaid(selectedTask.id, payload, accounts);
    } else {
      // Standard (non-private) completion
      console.log(chalk.cyan('\nSubmitting standard completion...'));
      // await program.methods.completeTask({...}).rpc();
    }

    console.log(chalk.bold.green('\n=== Task Completed Successfully! ===\n'));
  }

  // Helper methods
  private sha256(...chunks: Buffer[]): Buffer {
    const hasher = crypto.createHash('sha256');
    for (const chunk of chunks) {
      hasher.update(chunk);
    }
    return hasher.digest();
  }

  private expandBytes(seed: Buffer, length: number): Buffer {
    const out = Buffer.alloc(length);
    let offset = 0;
    let cursor = seed;
    while (offset < length) {
      cursor = this.sha256(cursor);
      const remaining = length - offset;
      const chunkSize = Math.min(cursor.length, remaining);
      cursor.copy(out, offset, 0, chunkSize);
      offset += chunkSize;
    }
    return out;
  }

  private hashTaskOutput(input: string): string {
    // SECURITY WARNING: This is a NON-CRYPTOGRAPHIC demo hash!
    // It provides NO security guarantees and is trivially reversible.
    //
    // In production, you MUST use a cryptographic hash:
    //   import { createHash } from 'crypto';
    //   return createHash('sha256').update(input).digest('hex');
    //
    // Or for ZK-friendly hashing, uses SHA-256 via Solana hashv.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Demo hash function cannot be used in production. Implement cryptographic hashing.');
    }
    let hash = '';
    for (let i = 0; i < 64; i++) {
      hash += ((input.charCodeAt(i % input.length) + i) % 16).toString(16);
    }
    return hash;
  }

  /**
   * Generate cryptographically secure random salt for ZK commitment
   * Uses Web Crypto API which provides CSPRNG
   */
  private generateSalt(): bigint {
    const bytes = new Uint8Array(32);
    // SECURITY: crypto.getRandomValues uses CSPRNG - this is production-safe
    crypto.getRandomValues(bytes);
    let salt = BigInt(0);
    for (const byte of bytes) {
      salt = (salt << 8n) | BigInt(byte);
    }
    // Reduce modulo 2^254 to fit within field element bounds
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
  // SECURITY WARNING: Ephemeral keypair for demo only!
  // In production, load keypair from secure storage:
  //   - Hardware wallet
  //   - Encrypted keystore file
  //   - AWS KMS / HashiCorp Vault
  //   - Environment variable with encrypted key
  // Never commit real keypairs to source control!
  const agentConfig: TetsuoAgentConfig = {
    wallet: Keypair.generate(), // DEMO ONLY: Load from secure storage in production!
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
  console.log(chalk.gray('  Router Program:'), ROUTER_PROGRAM_ID.toBase58());
  console.log(chalk.gray('  Verifier Program:'), VERIFIER_PROGRAM_ID.toBase58());
  console.log();
}

// Run demo
main().catch(console.error);
