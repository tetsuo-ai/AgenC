/**
 * Agent - Core runtime class for AI agents on AgenC
 *
 * Manages agent lifecycle, task execution, and on-chain interactions.
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import {
  AgentConfig,
  AgentState,
  RuntimeOptions,
  OnChainTask,
  TaskHandler,
  TaskResult,
  RuntimeEvent,
  EventListener,
  TaskStatus,
  TaskType,
} from './types';

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;

/**
 * Agent runtime for automated task execution on AgenC protocol.
 *
 * @example
 * ```typescript
 * import { Agent, Capabilities } from '@agenc/runtime';
 *
 * const agent = new Agent({
 *   connection,
 *   wallet,
 *   program,
 *   capabilities: Capabilities.COMPUTE | Capabilities.INFERENCE,
 *   agentId: Buffer.from('my-agent-id'.padEnd(32, '\0')),
 * });
 *
 * // Define task handler
 * agent.onTask(async (task) => {
 *   const output = await processTask(task);
 *   return { output: [1n, 2n, 3n, 4n] };
 * });
 *
 * // Start the agent
 * await agent.start();
 * ```
 */
export class Agent {
  private config: AgentConfig;
  private options: RuntimeOptions;
  private state: AgentState;
  private taskHandler: TaskHandler | null = null;
  private listeners: EventListener[] = [];
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private protocolPda: PublicKey;

  constructor(config: AgentConfig, options: RuntimeOptions = {}) {
    this.config = config;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxConcurrentTasks: options.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT,
      autoClaim: options.autoClaim ?? false,
      taskFilter: options.taskFilter,
      retryAttempts: options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    };

    // Derive PDAs
    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), config.agentId],
      config.program.programId
    );

    const [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('protocol')],
      config.program.programId
    );

    this.protocolPda = protocolPda;

    this.state = {
      pda: agentPda,
      registered: false,
      running: false,
      activeTasks: new Map(),
      completedCount: 0,
      failedCount: 0,
    };
  }

  /**
   * Get agent's PDA address
   */
  get pda(): PublicKey {
    return this.state.pda;
  }

  /**
   * Check if agent is running
   */
  get isRunning(): boolean {
    return this.state.running;
  }

  /**
   * Get current agent state
   */
  getState(): Readonly<AgentState> {
    return { ...this.state };
  }

  /**
   * Register task handler
   */
  onTask(handler: TaskHandler): void {
    this.taskHandler = handler;
  }

  /**
   * Register event listener
   */
  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Event listener error:', e);
      }
    }
  }

  /**
   * Register agent on-chain (if not already registered)
   */
  async register(): Promise<void> {
    // Check if already registered
    try {
      const accounts = this.config.program.account as Record<string, { fetch: (key: PublicKey) => Promise<unknown> }>;
      await accounts['agentRegistration'].fetch(this.state.pda);
      this.state.registered = true;
      return;
    } catch {
      // Not registered, continue
    }

    const stake = this.config.stake ?? 0;

    await this.config.program.methods
      .registerAgent(
        Array.from(this.config.agentId),
        new BN(this.config.capabilities),
        this.config.endpoint ?? '',
        null, // delegatedSigner
        new BN(stake)
      )
      .accountsPartial({
        agent: this.state.pda,
        protocolConfig: this.protocolPda,
        authority: this.config.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.config.wallet])
      .rpc();

    this.state.registered = true;
  }

  /**
   * Start the agent runtime
   */
  async start(): Promise<void> {
    if (this.state.running) {
      throw new Error('Agent is already running');
    }

    if (!this.taskHandler) {
      throw new Error('No task handler registered. Call onTask() first.');
    }

    // Ensure agent is registered
    await this.register();

    this.state.running = true;
    this.emit({ type: 'started', agentId: this.config.agentId });

    // Start polling for tasks
    const pollInterval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollInterval = setInterval(
      () => this.pollTasks().catch(this.handleError.bind(this)),
      pollInterval
    );

    // Initial poll
    await this.pollTasks().catch(this.handleError.bind(this));
  }

  /**
   * Stop the agent runtime
   */
  async stop(): Promise<void> {
    if (!this.state.running) {
      return;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.state.running = false;
    this.emit({ type: 'stopped', agentId: this.config.agentId });
  }

  /**
   * Poll for available tasks
   */
  private async pollTasks(): Promise<void> {
    if (!this.state.running) return;

    // Check if we can take more tasks
    const maxConcurrent = this.options.maxConcurrentTasks ?? 1;
    if (this.state.activeTasks.size >= maxConcurrent) {
      return;
    }

    // Fetch open tasks
    const tasks = await this.fetchOpenTasks();

    for (const task of tasks) {
      // Apply custom filter if provided
      if (this.options.taskFilter && !this.options.taskFilter(task)) {
        continue;
      }

      // Check capabilities match
      if ((task.requiredCapabilities & this.config.capabilities) !== task.requiredCapabilities) {
        continue;
      }

      // Check if we already have this task
      if (this.state.activeTasks.has(task.address.toBase58())) {
        continue;
      }

      this.emit({ type: 'taskFound', task });

      // Auto-claim if enabled
      if (this.options.autoClaim) {
        try {
          await this.claimAndExecute(task);
        } catch (e) {
          this.handleError(e as Error);
        }

        // Check concurrent limit again
        if (this.state.activeTasks.size >= (this.options.maxConcurrentTasks ?? 1)) {
          break;
        }
      }
    }
  }

  /**
   * Fetch open tasks from on-chain
   */
  private async fetchOpenTasks(): Promise<OnChainTask[]> {
    type AccountWithKey = { publicKey: PublicKey; account: unknown };
    const accounts = this.config.program.account as Record<string, {
      all: (filters?: Array<{ memcmp: { offset: number; bytes: string } }>) => Promise<AccountWithKey[]>;
    }>;

    const taskAccounts = await accounts['task'].all([
      {
        memcmp: {
          offset: 8 + 32, // discriminator + creator
          bytes: Buffer.from([TaskStatus.Open]).toString('base64'),
        },
      },
    ]);

    return taskAccounts.map((t: AccountWithKey) => this.parseTask(t.publicKey, t.account));
  }

  /**
   * Parse on-chain task account to OnChainTask
   */
  private parseTask(address: PublicKey, account: any): OnChainTask {
    return {
      address,
      taskId: Buffer.from(account.taskId),
      creator: account.creator,
      requiredCapabilities: account.requiredCapabilities.toNumber(),
      description: Buffer.from(account.description).toString('utf8').replace(/\0/g, ''),
      rewardLamports: account.rewardAmount.toNumber(),
      maxWorkers: account.maxWorkers,
      currentWorkers: account.currentWorkers,
      deadline: account.deadline.toNumber(),
      taskType: this.parseTaskType(account.taskType),
      constraintHash: account.constraintHash && !Buffer.alloc(32).equals(Buffer.from(account.constraintHash))
        ? Buffer.from(account.constraintHash)
        : null,
      status: this.parseTaskStatus(account.status),
    };
  }

  private parseTaskType(taskType: any): TaskType {
    if ('exclusive' in taskType) return TaskType.Exclusive;
    if ('collaborative' in taskType) return TaskType.Collaborative;
    if ('competitive' in taskType) return TaskType.Competitive;
    return TaskType.Exclusive;
  }

  private parseTaskStatus(status: any): TaskStatus {
    if ('open' in status) return TaskStatus.Open;
    if ('inProgress' in status) return TaskStatus.InProgress;
    if ('completed' in status) return TaskStatus.Completed;
    if ('cancelled' in status) return TaskStatus.Cancelled;
    if ('disputed' in status) return TaskStatus.Disputed;
    return TaskStatus.Open;
  }

  /**
   * Claim a task and execute
   */
  async claimAndExecute(task: OnChainTask): Promise<void> {
    if (!this.taskHandler) {
      throw new Error('No task handler registered');
    }

    // Derive claim PDA
    const [claimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('claim'), task.address.toBuffer(), this.state.pda.toBuffer()],
      this.config.program.programId
    );

    // Claim the task
    await this.config.program.methods
      .claimTask()
      .accountsPartial({
        task: task.address,
        claim: claimPda,
        worker: this.state.pda,
        protocolConfig: this.protocolPda,
        authority: this.config.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.config.wallet])
      .rpc();

    this.state.activeTasks.set(task.address.toBase58(), task);
    this.emit({ type: 'taskClaimed', task, claimPda });

    // Execute task
    try {
      const result = await this.executeWithRetry(task);
      await this.completeTask(task, result);
    } catch (e) {
      this.state.failedCount++;
      this.state.activeTasks.delete(task.address.toBase58());
      this.emit({ type: 'taskFailed', task, error: e as Error });
      throw e;
    }
  }

  /**
   * Execute task handler with retry logic
   */
  private async executeWithRetry(task: OnChainTask): Promise<TaskResult> {
    let lastError: Error | null = null;
    const attempts = this.options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    const baseDelay = this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.taskHandler!(task);
      } catch (e) {
        lastError = e as Error;
        if (attempt < attempts - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Complete a task with result
   */
  private async completeTask(task: OnChainTask, result: TaskResult): Promise<void> {
    const [claimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('claim'), task.address.toBuffer(), this.state.pda.toBuffer()],
      this.config.program.programId
    );

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), task.address.toBuffer()],
      this.config.program.programId
    );

    // Get treasury from protocol config
    const accounts = this.config.program.account as Record<string, { fetch: (key: PublicKey) => Promise<unknown> }>;
    const protocolConfig = await accounts['protocolConfig'].fetch(this.protocolPda) as { treasury: PublicKey };
    const treasury = protocolConfig.treasury;

    // Determine if this is a private task
    const isPrivateTask = task.constraintHash !== null;

    let txSignature: string;

    if (isPrivateTask) {
      // Generate ZK proof and complete privately
      // This requires the SDK proof generation functionality
      throw new Error(
        'Private task completion requires ZK proof generation. ' +
        'Use generateProof() from @agenc/sdk and submit via completeTaskPrivate().'
      );
    } else {
      // Complete public task
      const resultHash = result.resultData ?? Buffer.alloc(32);
      const resultData = result.resultData ?? Buffer.alloc(128);

      txSignature = await this.config.program.methods
        .completeTask(Array.from(resultHash), Array.from(resultData))
        .accountsPartial({
          task: task.address,
          claim: claimPda,
          escrow: escrowPda,
          worker: this.state.pda,
          protocolConfig: this.protocolPda,
          treasury,
          authority: this.config.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.config.wallet])
        .rpc();
    }

    this.state.completedCount++;
    this.state.activeTasks.delete(task.address.toBase58());
    this.emit({ type: 'taskCompleted', task, txSignature });
  }

  private handleError(error: Error): void {
    this.emit({ type: 'error', error });
    console.error('[Agent Error]', error.message);
  }
}
