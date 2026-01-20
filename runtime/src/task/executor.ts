/**
 * TaskExecutor - Orchestrates complete task lifecycle
 *
 * State machine: IDLE → DISCOVERING → EVALUATING → CLAIMING → EXECUTING → PROVING → SUBMITTING → IDLE
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import type { Connection, Keypair } from '@solana/web3.js';
import type { AgentManager } from '../agent/manager';
import { AgentStatus } from '../types/config';
import type { Logger, AgentState, TaskStatus as ConfigTaskStatus, TaskType as ConfigTaskType } from '../types/config';
import {
  OnChainTask,
  TaskClaim,
  TaskResult,
  TaskHandler,
  TaskExecutionContext,
  TaskEvaluator,
  EvaluationContext,
  ExecutorState,
  TaskFilter,
  TaskHistoryEntry,
  Evaluators,
} from '../types/task';
import type { RuntimeEvent, RuntimeEventListener } from '../types/events';

/**
 * TaskExecutor constructor configuration
 */
export interface TaskExecutorConfig {
  /** Solana connection */
  connection: Connection;
  /** Program instance */
  program: Program;
  /** Agent's keypair */
  wallet: Keypair;
  /** Agent PDA */
  agentPda: PublicKey;
  /** Agent manager (optional, for rate limiting) */
  agentManager?: AgentManager;
  /** Task evaluator for selection */
  evaluator?: TaskEvaluator;
  /** Task filter */
  filter?: TaskFilter;
  /** Maximum concurrent tasks */
  maxConcurrentTasks?: number;
  /** Polling interval in ms */
  pollInterval?: number;
  /** Task execution timeout in ms */
  taskTimeout?: number;
  /** Retry attempts for failed operations */
  retryAttempts?: number;
  /** Base delay for exponential backoff */
  retryBaseDelayMs?: number;
  /** Auto-claim matching tasks */
  autoClaim?: boolean;
  /** Optional logger */
  logger?: Logger;
}

interface ExecutorOptions {
  evaluator: TaskEvaluator;
  filter: TaskFilter;
  maxConcurrentTasks: number;
  pollInterval: number;
  taskTimeout: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  autoClaim: boolean;
}

const DEFAULT_OPTIONS: ExecutorOptions = {
  evaluator: Evaluators.balanced,
  filter: {},
  maxConcurrentTasks: 1,
  pollInterval: 5000,
  taskTimeout: 300000, // 5 minutes
  retryAttempts: 3,
  retryBaseDelayMs: 1000,
  autoClaim: false,
};

/**
 * TaskExecutor handles task discovery, claiming, execution, and submission
 */
export class TaskExecutor {
  private connection: Connection;
  private wallet: Keypair;
  private program: Program;
  private agentPda: PublicKey;
  private agentManager: AgentManager | null;
  private logger: Logger;
  private options: ExecutorOptions;

  private state: ExecutorState = ExecutorState.Idle;
  private activeTasks: Map<string, { task: OnChainTask; claim: TaskClaim; abortController: AbortController }> = new Map();
  private taskHandler: TaskHandler | null = null;
  private _pollInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private listeners: RuntimeEventListener[] = [];
  private protocolPda: PublicKey;

  // Stats
  private completedCount = 0;
  private failedCount = 0;
  private pendingCount = 0;

  constructor(config: TaskExecutorConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.program = config.program;
    this.agentPda = config.agentPda;
    this.agentManager = config.agentManager ?? null;
    this.logger = config.logger ?? console;
    this.options = {
      evaluator: config.evaluator ?? DEFAULT_OPTIONS.evaluator,
      filter: config.filter ?? DEFAULT_OPTIONS.filter,
      maxConcurrentTasks: config.maxConcurrentTasks ?? DEFAULT_OPTIONS.maxConcurrentTasks,
      pollInterval: config.pollInterval ?? DEFAULT_OPTIONS.pollInterval,
      taskTimeout: config.taskTimeout ?? DEFAULT_OPTIONS.taskTimeout,
      retryAttempts: config.retryAttempts ?? DEFAULT_OPTIONS.retryAttempts,
      retryBaseDelayMs: config.retryBaseDelayMs ?? DEFAULT_OPTIONS.retryBaseDelayMs,
      autoClaim: config.autoClaim ?? DEFAULT_OPTIONS.autoClaim,
    };

    // Derive protocol PDA
    const [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('protocol')],
      config.program.programId
    );
    this.protocolPda = protocolPda;
  }

  /**
   * Set the task evaluator
   */
  setEvaluator(evaluator: TaskEvaluator): void {
    this.options.evaluator = evaluator;
  }

  /**
   * Get executor statistics
   */
  getStats(): { pending: number; executing: number; completed: number; failed: number } {
    return {
      pending: this.pendingCount,
      executing: this.activeTasks.size,
      completed: this.completedCount,
      failed: this.failedCount,
    };
  }

  /**
   * Create a default agent state when agentManager is not available
   */
  private createDefaultAgentState(): AgentState {
    return {
      pda: this.agentPda,
      agentId: Buffer.alloc(32),
      authority: this.wallet.publicKey,
      capabilities: 0n,
      status: AgentStatus.Active,
      endpoint: '',
      metadataUri: '',
      stake: 0n,
      activeTasks: 0,
      tasksCompleted: 0,
      totalEarned: 0n,
      reputation: 0,
      registered: true,
      registeredAt: Date.now(),
      lastActive: Date.now(),
      lastTaskCreated: 0,
      lastDisputeInitiated: 0,
      taskCount24h: 0,
      disputeCount24h: 0,
      rateLimitWindowStart: 0,
    };
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
  on(listener: RuntimeEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Start the executor
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('TaskExecutor already running');
    }

    if (!this.taskHandler) {
      throw new Error('No task handler registered. Call onTask() first.');
    }

    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState?.registered) {
      throw new Error('Agent not registered');
    }

    this.isRunning = true;
    this.emit({
      type: 'started',
      agentId: agentState.agentId,
      mode: 'autonomous',
      timestamp: Date.now(),
    });

    this.logger.info('TaskExecutor started', { pollIntervalMs: this.options.pollInterval });

    // Start polling
    this._pollInterval = setInterval(
      () => this.poll().catch((e) => this.handleError(e)),
      this.options.pollInterval
    );

    // Initial poll
    await this.poll().catch((e) => this.handleError(e));
  }

  /**
   * Stop the executor
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping TaskExecutor');

    // Stop polling
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }

    // Abort active tasks
    for (const [taskId, { abortController }] of this.activeTasks) {
      this.logger.warn('Aborting active task', { taskId });
      abortController.abort();
    }

    this.isRunning = false;
    this.state = ExecutorState.Idle;

    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    this.emit({
      type: 'stopped',
      agentId: agentState?.agentId ?? Buffer.alloc(32),
      completedCount: 0, // TODO: track this
      failedCount: 0,
      timestamp: Date.now(),
    });
  }

  /**
   * Get current executor state
   */
  getState(): ExecutorState {
    return this.state;
  }

  /**
   * Get active task count
   */
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  /**
   * Poll for available tasks
   */
  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    // Check capacity
    if (this.activeTasks.size >= this.options.maxConcurrentTasks) {
      return;
    }

    // Check rate limits
    if (this.agentManager?.isRateLimited() ?? false) {
      this.logger.debug('Rate limited, skipping poll');
      return;
    }

    this.state = ExecutorState.Discovering;

    try {
      // Discover tasks
      const tasks = await this.discoverTasks();
      if (tasks.length === 0) {
        this.state = ExecutorState.Idle;
        return;
      }

      this.state = ExecutorState.Evaluating;

      // Evaluate and select best task
      const selected = await this.selectBestTask(tasks);
      if (!selected) {
        this.state = ExecutorState.Idle;
        return;
      }

      this.emit({
        type: 'taskFound',
        taskId: selected.taskId,
        rewardAmount: selected.rewardAmount,
        deadline: selected.deadline,
      });

      // Auto-claim if enabled
      if (this.options.autoClaim) {
        await this.claimAndExecute(selected);
      }
    } catch (error) {
      this.state = ExecutorState.Error;
      throw error;
    }
  }

  /**
   * Discover available tasks
   */
  async discoverTasks(): Promise<OnChainTask[]> {
    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState) {
      return [];
    }

    // Fetch open tasks
    const accounts = this.program.account as Record<string, {
      all: (filters?: Array<{ memcmp: { offset: number; bytes: string } }>) => Promise<Array<{ publicKey: PublicKey; account: unknown }>>;
    }>;

    // Filter by status = Open (0)
    const taskAccounts = await accounts['task'].all([
      {
        memcmp: {
          offset: 8 + 32 + 32 + 8 + 64 + 32 + 8 + 1 + 1, // offset to status field
          bytes: Buffer.from([0]).toString('base64'), // TaskStatus::Open = 0
        },
      },
    ]);

    const tasks: OnChainTask[] = [];

    for (const { publicKey, account } of taskAccounts) {
      const task = this.parseTask(publicKey, account);

      // Apply capability filter
      if ((task.requiredCapabilities & agentState.capabilities) !== task.requiredCapabilities) {
        continue;
      }

      // Apply custom filter
      if (!this.matchesFilter(task)) {
        continue;
      }

      // Skip if already active
      if (this.activeTasks.has(task.taskId.toString('hex'))) {
        continue;
      }

      tasks.push(task);
    }

    this.logger.debug('Discovered tasks', { count: tasks.length });
    return tasks;
  }

  /**
   * Select the best task based on evaluator
   */
  private async selectBestTask(tasks: OnChainTask[]): Promise<OnChainTask | null> {
    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState) {
      return null;
    }

    const context: EvaluationContext = {
      agent: agentState,
      recentTasks: [], // TODO: get from memory store
      timestamp: Math.floor(Date.now() / 1000),
      activeTaskCount: this.activeTasks.size,
      rateLimitBudget: this.agentManager?.getRateLimitBudget() ?? { tasksRemaining: 100, cooldownEnds: 0 },
    };

    let bestTask: OnChainTask | null = null;
    let bestScore = -Infinity;

    for (const task of tasks) {
      const score = await this.options.evaluator.evaluate(task, context);
      if (score !== null && score > bestScore) {
        bestScore = score;
        bestTask = task;
      }
    }

    if (bestTask) {
      this.logger.debug('Selected task', {
        taskId: bestTask.taskId.toString('hex'),
        score: bestScore,
        reward: bestTask.rewardAmount.toString(),
      });
    }

    return bestTask;
  }

  /**
   * Claim and execute a task
   */
  async claimAndExecute(task: OnChainTask): Promise<void> {
    if (!this.taskHandler) {
      throw new Error('No task handler registered');
    }

    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState) {
      throw new Error('Agent not registered');
    }

    const taskIdHex = task.taskId.toString('hex');

    // Claim the task
    this.state = ExecutorState.Claiming;
    const claim = await this.claimTask(task, agentState);

    this.emit({
      type: 'taskClaimed',
      taskId: task.taskId,
      claimPda: claim.address,
    });

    // Set up abort controller
    const abortController = new AbortController();
    this.activeTasks.set(taskIdHex, { task, claim, abortController });

    // Execute
    this.state = ExecutorState.Executing;
    this.emit({
      type: 'taskExecuting',
      taskId: task.taskId,
      startedAt: Date.now(),
    });

    try {
      const result = await this.executeWithRetry(task, claim, agentState, abortController.signal);

      // Submit completion
      this.state = ExecutorState.Submitting;
      const txSignature = await this.submitCompletion(task, claim, result);

      this.emit({
        type: 'taskCompleted',
        taskId: task.taskId,
        txSignature,
        rewardPaid: task.rewardAmount, // TODO: get actual from event
      });

      this.logger.info('Task completed', { taskId: taskIdHex, txSignature });
    } catch (error) {
      this.emit({
        type: 'taskFailed',
        taskId: task.taskId,
        error: error as Error,
      });
      throw error;
    } finally {
      this.activeTasks.delete(taskIdHex);
      this.state = ExecutorState.Idle;
    }
  }

  /**
   * Claim a task on-chain
   */
  private async claimTask(task: OnChainTask, agentState: AgentState): Promise<TaskClaim> {
    this.logger.debug('Claiming task', { taskId: task.taskId.toString('hex') });

    // Derive claim PDA
    const [claimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('claim'), task.address.toBuffer(), agentState.pda.toBuffer()],
      this.program.programId
    );

    await this.program.methods
      .claimTask()
      .accountsPartial({
        task: task.address,
        claim: claimPda,
        worker: agentState.pda,
        protocolConfig: this.protocolPda,
        authority: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.wallet])
      .rpc();

    // Fetch claim account
    const accounts = this.program.account as Record<string, { fetch: (key: PublicKey) => Promise<unknown> }>;
    const claimAccount = await accounts['taskClaim'].fetch(claimPda);

    return this.parseClaim(claimPda, claimAccount);
  }

  /**
   * Execute task handler with retry logic
   */
  private async executeWithRetry(
    task: OnChainTask,
    claim: TaskClaim,
    agentState: AgentState,
    signal: AbortSignal
  ): Promise<TaskResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.options.retryAttempts; attempt++) {
      if (signal.aborted) {
        throw new Error('Task execution aborted');
      }

      try {
        const context: TaskExecutionContext = {
          agent: agentState,
          claim,
          log: this.logger,
          signal,
        };

        // Set timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Task execution timeout')), this.options.taskTimeout);
        });

        const result = await Promise.race([
          this.taskHandler!(task, context),
          timeoutPromise,
        ]);

        return result;
      } catch (error) {
        lastError = error as Error;
        this.logger.warn('Task execution failed, retrying', {
          taskId: task.taskId.toString('hex'),
          attempt: attempt + 1,
          maxAttempts: this.options.retryAttempts,
          error: lastError.message,
        });

        if (attempt < this.options.retryAttempts - 1) {
          const delay = this.options.retryBaseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Submit task completion on-chain
   */
  private async submitCompletion(task: OnChainTask, claim: TaskClaim, result: TaskResult): Promise<string> {
    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState) {
      throw new Error('Agent not registered');
    }

    // Check if private task
    const isPrivate = task.constraintHash !== null && !task.constraintHash.every((b) => b === 0);

    if (isPrivate) {
      // TODO: Generate ZK proof and submit privately
      throw new Error(
        'Private task completion requires ZK proof generation. ' +
        'Use ProofEngine to generate proof first.'
      );
    }

    // Derive escrow PDA
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), task.address.toBuffer()],
      this.program.programId
    );

    // Get treasury from protocol config
    const accounts = this.program.account as Record<string, { fetch: (key: PublicKey) => Promise<unknown> }>;
    const protocolConfig = await accounts['protocolConfig'].fetch(this.protocolPda) as { treasury: PublicKey };
    const treasury = protocolConfig.treasury;

    // Prepare result data
    const resultHash = result.resultData ?? Buffer.alloc(32);
    const resultData = result.resultData ?? Buffer.alloc(64);

    const txSignature = await this.program.methods
      .completeTask(Array.from(resultHash.subarray(0, 32)), Array.from(resultData.subarray(0, 64)))
      .accountsPartial({
        task: task.address,
        claim: claim.address,
        escrow: escrowPda,
        worker: agentState.pda,
        protocolConfig: this.protocolPda,
        treasury,
        authority: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.wallet])
      .rpc();

    return txSignature;
  }

  /**
   * Check if task matches filter
   */
  private matchesFilter(task: OnChainTask): boolean {
    const f = this.options.filter;

    if (f.minReward !== undefined && task.rewardAmount < f.minReward) {
      return false;
    }

    if (f.maxReward !== undefined && task.rewardAmount > f.maxReward) {
      return false;
    }

    if (f.taskTypes && !f.taskTypes.includes(task.taskType)) {
      return false;
    }

    if (f.maxDeadline !== undefined && task.deadline > 0 && task.deadline > f.maxDeadline) {
      return false;
    }

    if (f.minDeadline !== undefined && task.deadline > 0 && task.deadline < f.minDeadline) {
      return false;
    }

    const hasConstraint = task.constraintHash !== null && !task.constraintHash.every((b) => b === 0);
    if (f.privateOnly && !hasConstraint) {
      return false;
    }
    if (f.publicOnly && hasConstraint) {
      return false;
    }

    if (f.custom && !f.custom(task)) {
      return false;
    }

    return true;
  }

  /**
   * Parse task account to OnChainTask
   */
  private parseTask(address: PublicKey, account: unknown): OnChainTask {
    const a = account as {
      taskId: number[];
      creator: PublicKey;
      requiredCapabilities: { toString: () => string };
      description: number[];
      constraintHash: number[];
      rewardAmount: { toString: () => string };
      maxWorkers: number;
      currentWorkers: number;
      status: { open?: unknown; inProgress?: unknown; pendingValidation?: unknown; completed?: unknown; cancelled?: unknown; disputed?: unknown };
      taskType: { exclusive?: unknown; collaborative?: unknown; competitive?: unknown };
      createdAt: { toNumber: () => number };
      deadline: { toNumber: () => number };
      completedAt: { toNumber: () => number };
      escrow: PublicKey;
      result: number[];
      completions: number;
      requiredCompletions: number;
    };

    const status = a.status.open !== undefined ? 0 as ConfigTaskStatus
      : a.status.inProgress !== undefined ? 1 as ConfigTaskStatus
      : a.status.pendingValidation !== undefined ? 2 as ConfigTaskStatus
      : a.status.completed !== undefined ? 3 as ConfigTaskStatus
      : a.status.cancelled !== undefined ? 4 as ConfigTaskStatus
      : 5 as ConfigTaskStatus;

    const taskType = a.taskType.exclusive !== undefined ? 0 as ConfigTaskType
      : a.taskType.collaborative !== undefined ? 1 as ConfigTaskType
      : 2 as ConfigTaskType;

    const constraintHash = Buffer.from(a.constraintHash);
    const hasConstraint = !constraintHash.every((b) => b === 0);

    return {
      address,
      taskId: Buffer.from(a.taskId),
      creator: a.creator,
      requiredCapabilities: BigInt(a.requiredCapabilities.toString()),
      description: Buffer.from(a.description),
      constraintHash: hasConstraint ? constraintHash : null,
      rewardAmount: BigInt(a.rewardAmount.toString()),
      maxWorkers: a.maxWorkers,
      currentWorkers: a.currentWorkers,
      status,
      taskType,
      createdAt: a.createdAt.toNumber(),
      deadline: a.deadline.toNumber(),
      completedAt: a.completedAt.toNumber(),
      escrow: a.escrow,
      result: Buffer.from(a.result),
      completions: a.completions,
      requiredCompletions: a.requiredCompletions,
    };
  }

  /**
   * Parse claim account to TaskClaim
   */
  private parseClaim(address: PublicKey, account: unknown): TaskClaim {
    const a = account as {
      task: PublicKey;
      worker: PublicKey;
      claimedAt: { toNumber: () => number };
      expiresAt: { toNumber: () => number };
      completedAt: { toNumber: () => number };
      proofHash: number[];
      resultData: number[];
      isCompleted: boolean;
      isValidated: boolean;
      rewardPaid: { toString: () => string };
    };

    return {
      address,
      task: a.task,
      worker: a.worker,
      claimedAt: a.claimedAt.toNumber(),
      expiresAt: a.expiresAt.toNumber(),
      completedAt: a.completedAt.toNumber(),
      proofHash: Buffer.from(a.proofHash),
      resultData: Buffer.from(a.resultData),
      isCompleted: a.isCompleted,
      isValidated: a.isValidated,
      rewardPaid: BigInt(a.rewardPaid.toString()),
    };
  }

  /**
   * Emit runtime event
   */
  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error('Event listener error', { error });
      }
    }
  }

  /**
   * Handle error
   */
  private handleError(error: Error): void {
    this.logger.error('TaskExecutor error', { error: error.message });
    this.emit({ type: 'error', error, context: 'TaskExecutor' });
    this.state = ExecutorState.Idle;
  }
}
