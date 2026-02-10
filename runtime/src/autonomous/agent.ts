/**
 * AutonomousAgent - Self-operating agent that discovers, claims, and completes tasks
 *
 * @module
 */

import { Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { PROGRAM_ID, generateProof, generateSalt } from '@agenc/sdk';
import { AgentRuntime } from '../runtime.js';
import { TaskScanner, TaskEventSubscription } from './scanner.js';
import {
  Task,
  AutonomousTaskExecutor,
  ClaimStrategy,
  AutonomousAgentConfig,
  AutonomousAgentStats,
  DefaultClaimStrategy,
  DiscoveryMode,
} from './types.js';
import { Logger, createLogger, silentLogger } from '../utils/logger.js';
import { createProgram } from '../idl.js';
import { findClaimPda, findEscrowPda } from '../task/pda.js';
import { findProtocolPda } from '../agent/pda.js';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type { Wallet } from '../types/wallet.js';
import { keypairToWallet } from '../types/wallet.js';
import { isKeypair } from '../types/config.js';
import type { AgentState } from '../agent/types.js';

/**
 * Internal task tracking
 */
interface ActiveTask {
  task: Task;
  claimedAt: number;
  claimTx: string;
  retryCount: number;
}

/**
 * Task processing result
 */
interface TaskResult {
  success: boolean;
  task: Task;
  completionTx?: string;
  error?: Error;
  durationMs: number;
}

/**
 * AutonomousAgent extends AgentRuntime with autonomous task discovery and execution.
 *
 * The agent runs a continuous loop that:
 * 1. Discovers available tasks (via polling or event subscription)
 * 2. Claims tasks according to its strategy
 * 3. Executes tasks using the provided executor
 * 4. Generates proofs (for private tasks)
 * 5. Submits completion and collects rewards
 *
 * @example
 * ```typescript
 * const agent = new AutonomousAgent({
 *   connection: new Connection('https://api.devnet.solana.com'),
 *   wallet: keypair,
 *   capabilities: AgentCapabilities.INFERENCE,
 *   initialStake: 1_000_000_000n,
 *   executor: new LLMExecutor({ model: 'gpt-4' }),
 *   discoveryMode: 'hybrid', // Use both polling and events
 *   taskFilter: { minReward: 0.1 * LAMPORTS_PER_SOL },
 *   onTaskCompleted: (task, tx) => console.log('Completed:', tx),
 * });
 *
 * await agent.start();
 * // Agent now autonomously processes tasks
 * ```
 */
export class AutonomousAgent extends AgentRuntime {
  private readonly executor: AutonomousTaskExecutor;
  private readonly claimStrategy: ClaimStrategy;
  private readonly scanIntervalMs: number;
  private readonly maxConcurrentTasks: number;
  private readonly generateProofs: boolean;
  private readonly circuitPath: string;
  private readonly autonomousLogger: Logger;
  private readonly discoveryMode: DiscoveryMode;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  // Components
  private scanner: TaskScanner | null = null;
  private program: Program<AgencCoordination> | null = null;
  private agentWallet: Wallet;
  private taskEventSubscription: TaskEventSubscription | null = null;

  // State
  private scanLoopRunning = false;
  private scanLoopInterval: ReturnType<typeof setInterval> | null = null;
  private activeTasks: Map<string, ActiveTask> = new Map();
  private pendingTasks: Map<string, Task> = new Map(); // Tasks waiting to be claimed
  private startTime: number = 0;
  private processingLock = false;

  // Stats
  private stats: AutonomousAgentStats = {
    tasksDiscovered: 0,
    tasksClaimed: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    totalEarnings: 0n,
    activeTasks: 0,
    avgCompletionTimeMs: 0,
    uptimeMs: 0,
  };

  // Completion time tracking for average calculation
  private completionTimes: number[] = [];
  private readonly maxCompletionTimeSamples = 100;

  // Callbacks
  private readonly onTaskDiscovered?: (task: Task) => void;
  private readonly onTaskClaimed?: (task: Task, txSignature: string) => void;
  private readonly onTaskExecuted?: (task: Task, output: bigint[]) => void;
  private readonly onTaskCompleted?: (task: Task, txSignature: string) => void;
  private readonly onTaskFailed?: (task: Task, error: Error) => void;
  private readonly onEarnings?: (amount: bigint, task: Task) => void;
  private readonly onProofGenerated?: (task: Task, proofSizeBytes: number, durationMs: number) => void;

  constructor(config: AutonomousAgentConfig) {
    super(config);

    this.executor = config.executor;
    this.claimStrategy = config.claimStrategy ?? DefaultClaimStrategy;
    this.scanIntervalMs = config.scanIntervalMs ?? 5000;
    this.maxConcurrentTasks = config.maxConcurrentTasks ?? 1;
    this.generateProofs = config.generateProofs ?? true;
    this.circuitPath = config.circuitPath ?? './circuits-circom/task_completion';
    this.discoveryMode = config.discoveryMode ?? 'hybrid';
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;

    // Store wallet for later use - convert Keypair to Wallet if needed
    if (isKeypair(config.wallet)) {
      this.agentWallet = keypairToWallet(config.wallet);
    } else {
      this.agentWallet = config.wallet;
    }

    // Setup logger
    this.autonomousLogger = config.logLevel
      ? createLogger(config.logLevel, '[AutonomousAgent]')
      : silentLogger;

    // Callbacks
    this.onTaskDiscovered = config.onTaskDiscovered;
    this.onTaskClaimed = config.onTaskClaimed;
    this.onTaskExecuted = config.onTaskExecuted;
    this.onTaskCompleted = config.onTaskCompleted;
    this.onTaskFailed = config.onTaskFailed;
    this.onEarnings = config.onEarnings;
    this.onProofGenerated = config.onProofGenerated;
  }

  /**
   * Start the autonomous agent.
   *
   * This calls the parent AgentRuntime.start() and then begins
   * the autonomous task scanning and execution loop.
   */
  override async start(): Promise<AgentState> {
    this.autonomousLogger.info('Starting AutonomousAgent...');

    // Start the base runtime (register agent, set active)
    const state = await super.start();

    // Get connection from the agent manager
    const manager = this.getAgentManager() as unknown as { connection: Connection; programId: PublicKey };
    const connection = manager.connection;
    const programId = manager.programId ?? PROGRAM_ID;

    const provider = new AnchorProvider(connection, this.agentWallet, { commitment: 'confirmed' });
    this.program = createProgram(provider, programId);

    // Initialize scanner
    this.scanner = new TaskScanner({
      connection,
      program: this.program,
      logger: this.autonomousLogger,
    });

    // Start discovery based on mode
    this.startDiscovery();
    this.startTime = Date.now();

    this.autonomousLogger.info(`AutonomousAgent started (discovery: ${this.discoveryMode})`);
    return state;
  }

  /**
   * Stop the autonomous agent.
   *
   * Stops the scan loop and completes any in-progress tasks before
   * calling the parent AgentRuntime.stop().
   */
  override async stop(): Promise<void> {
    this.autonomousLogger.info('Stopping AutonomousAgent...');

    // Stop discovery
    this.stopDiscovery();

    // Wait for active tasks to complete (with timeout)
    if (this.activeTasks.size > 0) {
      this.autonomousLogger.info(`Waiting for ${this.activeTasks.size} active tasks to complete...`);
      const timeout = Date.now() + 30000;
      while (this.activeTasks.size > 0 && Date.now() < timeout) {
        await this.sleep(1000);
      }
      if (this.activeTasks.size > 0) {
        this.autonomousLogger.warn(`${this.activeTasks.size} tasks did not complete in time`);
      }
    }

    // Stop the base runtime
    await super.stop();

    this.autonomousLogger.info('AutonomousAgent stopped');
  }

  /**
   * Get current agent stats
   */
  getStats(): AutonomousAgentStats {
    return {
      ...this.stats,
      activeTasks: this.activeTasks.size,
      uptimeMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
      avgCompletionTimeMs: this.calculateAvgCompletionTime(),
    };
  }

  /**
   * Get number of pending tasks (discovered but not yet claimed)
   */
  getPendingTaskCount(): number {
    return this.pendingTasks.size;
  }

  /**
   * Get number of active tasks (claimed and being processed)
   */
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  /**
   * Check if agent can accept more tasks
   */
  canAcceptMoreTasks(): boolean {
    return this.activeTasks.size < this.maxConcurrentTasks;
  }

  /**
   * Start task discovery based on configured mode
   */
  private startDiscovery(): void {
    if (!this.scanner) return;

    switch (this.discoveryMode) {
      case 'polling':
        this.startPolling();
        break;
      case 'events':
        this.startEventSubscription();
        break;
      case 'hybrid':
        this.startPolling();
        this.startEventSubscription();
        break;
    }
  }

  /**
   * Stop all discovery mechanisms
   */
  private stopDiscovery(): void {
    this.stopPolling();
    this.stopEventSubscription();
  }

  /**
   * Start polling-based discovery
   */
  private startPolling(): void {
    if (this.scanLoopRunning) return;

    this.scanLoopRunning = true;
    this.autonomousLogger.debug(`Starting poll loop (interval: ${this.scanIntervalMs}ms)`);

    // Run immediately, then on interval
    void this.pollAndProcess();

    this.scanLoopInterval = setInterval(() => {
      void this.pollAndProcess();
    }, this.scanIntervalMs);
  }

  /**
   * Stop polling-based discovery
   */
  private stopPolling(): void {
    this.scanLoopRunning = false;

    if (this.scanLoopInterval) {
      clearInterval(this.scanLoopInterval);
      this.scanLoopInterval = null;
    }

    this.autonomousLogger.debug('Poll loop stopped');
  }

  /**
   * Start event-based discovery
   */
  private startEventSubscription(): void {
    if (!this.scanner || this.taskEventSubscription) return;

    this.autonomousLogger.debug('Starting event subscription...');

    this.taskEventSubscription = this.scanner.subscribeToNewTasks((task, slot, _signature) => {
      this.autonomousLogger.debug(`New task event: ${task.pda.toBase58().slice(0, 8)} (slot: ${slot})`);
      this.handleDiscoveredTask(task);
    });
  }

  /**
   * Stop event-based discovery
   */
  private stopEventSubscription(): void {
    if (this.taskEventSubscription) {
      void this.taskEventSubscription.unsubscribe();
      this.taskEventSubscription = null;
      this.autonomousLogger.debug('Event subscription stopped');
    }
  }

  /**
   * Poll for tasks and process them
   */
  private async pollAndProcess(): Promise<void> {
    if (!this.scanLoopRunning || !this.scanner) return;

    try {
      // Scan for tasks
      const tasks = await this.scanner.scan();

      for (const task of tasks) {
        this.handleDiscoveredTask(task);
      }

      // Process pending tasks
      await this.processPendingTasks();
    } catch (error) {
      this.autonomousLogger.error('Poll cycle failed:', error);
    }
  }

  /**
   * Handle a newly discovered task
   */
  private handleDiscoveredTask(task: Task): void {
    const taskKey = task.pda.toBase58();

    // Skip if already active or pending
    if (this.activeTasks.has(taskKey) || this.pendingTasks.has(taskKey)) {
      return;
    }

    // Check if executor can handle this task
    if (this.executor.canExecute && !this.executor.canExecute(task)) {
      return;
    }

    // Add to pending
    this.pendingTasks.set(taskKey, task);
    this.stats.tasksDiscovered++;
    this.onTaskDiscovered?.(task);

    this.autonomousLogger.debug(`Discovered task: ${taskKey.slice(0, 8)} (reward: ${Number(task.reward) / LAMPORTS_PER_SOL} SOL)`);

    // Trigger processing if not already running
    if (!this.processingLock) {
      void this.processPendingTasks();
    }
  }

  /**
   * Process pending tasks according to strategy
   */
  private async processPendingTasks(): Promise<void> {
    if (this.processingLock || this.pendingTasks.size === 0) return;

    this.processingLock = true;

    try {
      // Sort pending tasks by priority
      const sortedTasks = Array.from(this.pendingTasks.values()).sort(
        (a, b) => this.claimStrategy.priority(b) - this.claimStrategy.priority(a)
      );

      for (const task of sortedTasks) {
        // Check if we can take more tasks
        if (!this.canAcceptMoreTasks()) break;

        // Check strategy
        if (!this.claimStrategy.shouldClaim(task, this.activeTasks.size)) {
          continue;
        }

        // Remove from pending
        this.pendingTasks.delete(task.pda.toBase58());

        // Claim and process (don't await - process concurrently)
        void this.claimAndProcess(task);
      }
    } finally {
      this.processingLock = false;
    }
  }

  /**
   * Claim a task and process it
   */
  private async claimAndProcess(task: Task): Promise<TaskResult> {
    const taskKey = task.pda.toBase58();
    const startTime = Date.now();

    try {
      // Verify task is still available
      if (this.scanner) {
        const available = await this.scanner.isTaskAvailable(task);
        if (!available) {
          this.autonomousLogger.debug(`Task ${taskKey.slice(0, 8)} no longer available`);
          return { success: false, task, error: new Error('Task no longer available'), durationMs: Date.now() - startTime };
        }
      }

      // Claim the task with retry
      this.autonomousLogger.info(`Claiming task ${taskKey.slice(0, 8)}...`);
      const claimTx = await this.claimTaskWithRetry(task);

      // Track active task
      const activeTask: ActiveTask = {
        task,
        claimedAt: Date.now(),
        claimTx,
        retryCount: 0,
      };
      this.activeTasks.set(taskKey, activeTask);
      this.stats.tasksClaimed++;

      this.onTaskClaimed?.(task, claimTx);
      this.autonomousLogger.info(`Claimed task ${taskKey.slice(0, 8)}: ${claimTx}`);

      // Execute the task
      this.autonomousLogger.info(`Executing task ${taskKey.slice(0, 8)}...`);
      const output = await this.executeWithRetry(task);
      this.onTaskExecuted?.(task, output);
      this.autonomousLogger.info(`Executed task ${taskKey.slice(0, 8)}`);

      // Complete the task with retry
      const completeTx = await this.completeTaskWithRetry(task, output);

      // Success!
      const durationMs = Date.now() - activeTask.claimedAt;
      this.recordCompletion(durationMs);

      this.activeTasks.delete(taskKey);
      this.stats.tasksCompleted++;
      this.stats.totalEarnings += task.reward;

      this.onTaskCompleted?.(task, completeTx);
      this.onEarnings?.(task.reward, task);

      this.autonomousLogger.info(
        `Completed task ${taskKey.slice(0, 8)} in ${durationMs}ms, earned ${Number(task.reward) / LAMPORTS_PER_SOL} SOL`
      );

      return { success: true, task, completionTx: completeTx, durationMs };
    } catch (error) {
      this.activeTasks.delete(taskKey);
      this.stats.tasksFailed++;

      const err = error instanceof Error ? error : new Error(String(error));
      this.onTaskFailed?.(task, err);
      this.autonomousLogger.error(`Task ${taskKey.slice(0, 8)} failed:`, err.message);

      return { success: false, task, error: err, durationMs: Date.now() - startTime };
    }
  }

  /**
   * Claim a task with retry logic
   */
  private async claimTaskWithRetry(task: Task): Promise<string> {
    return this.withRetry(() => this.claimTask(task), 'claim task');
  }

  /**
   * Execute a task with retry logic
   */
  private async executeWithRetry(task: Task): Promise<bigint[]> {
    return this.withRetry(() => this.executor.execute(task), 'execute task');
  }

  /**
   * Complete a task with retry logic
   */
  private async completeTaskWithRetry(task: Task, output: bigint[]): Promise<string> {
    return this.withRetry(() => this.completeTask(task, output), 'complete task');
  }

  /**
   * Generic retry wrapper
   */
  private async withRetry<T>(fn: () => Promise<T>, operation: string): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt - 1); // Exponential backoff
          this.autonomousLogger.warn(`${operation} failed (attempt ${attempt}/${this.maxRetries}), retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error(`${operation} failed after ${this.maxRetries} attempts`);
  }

  /**
   * Claim a task on-chain
   */
  private async claimTask(task: Task): Promise<string> {
    if (!this.program) {
      throw new Error('Agent not started');
    }

    const agentPda = this.getAgentPda();
    if (!agentPda) {
      throw new Error('Agent not registered');
    }

    const claimPda = findClaimPda(task.pda, agentPda, this.program.programId);
    const protocolPda = findProtocolPda(this.program.programId);

    const tx = await this.program.methods
      .claimTask()
      .accountsPartial({
        task: task.pda,
        claim: claimPda,
        worker: agentPda,
        protocolConfig: protocolPda,
        authority: this.agentWallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Complete a task on-chain
   */
  private async completeTask(task: Task, output: bigint[]): Promise<string> {
    if (!this.program) {
      throw new Error('Agent not started');
    }

    const agentPda = this.getAgentPda();
    if (!agentPda) {
      throw new Error('Agent not registered');
    }

    const isPrivate = !this.isZeroHash(task.constraintHash);

    if (isPrivate && this.generateProofs) {
      return this.completeTaskPrivate(task, output);
    } else {
      return this.completeTaskPublic(task, output);
    }
  }

  /**
   * Complete a public task
   */
  private async completeTaskPublic(task: Task, output: bigint[]): Promise<string> {
    if (!this.program) {
      throw new Error('Agent not started');
    }

    const agentPda = this.getAgentPda();
    if (!agentPda) throw new Error('Agent not registered');

    const claimPda = findClaimPda(task.pda, agentPda, this.program.programId);
    const escrowPda = findEscrowPda(task.pda, this.program.programId);
    const protocolPda = findProtocolPda(this.program.programId);

    // Fetch protocol config for treasury
    const protocolConfig = await (
      this.program.account as unknown as Record<string, { fetch: (key: PublicKey) => Promise<{ treasury: PublicKey }> }>
    ).protocolConfig.fetch(protocolPda);

    // Hash the output for public completion
    const resultHash = this.hashOutput(output);

    const tx = await this.program.methods
      .completeTask(Array.from(resultHash), null)
      .accountsPartial({
        task: task.pda,
        claim: claimPda,
        escrow: escrowPda,
        worker: agentPda,
        protocolConfig: protocolPda,
        treasury: protocolConfig.treasury,
        authority: this.agentWallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Complete a private task with ZK proof
   */
  private async completeTaskPrivate(task: Task, output: bigint[]): Promise<string> {
    if (!this.program) {
      throw new Error('Agent not started');
    }

    const agentPda = this.getAgentPda();
    if (!agentPda) throw new Error('Agent not registered');

    // Generate proof
    this.autonomousLogger.info('Generating ZK proof...');
    const proofStartTime = Date.now();

    const salt = generateSalt();
    const proofResult = await generateProof({
      taskPda: task.pda,
      agentPubkey: this.agentWallet.publicKey,
      output,
      salt,
      circuitPath: this.circuitPath,
    });

    const proofDuration = Date.now() - proofStartTime;
    this.onProofGenerated?.(task, proofResult.proofSize, proofDuration);
    this.autonomousLogger.info(`Proof generated in ${proofDuration}ms (${proofResult.proofSize} bytes)`);

    const claimPda = findClaimPda(task.pda, agentPda, this.program.programId);
    const escrowPda = findEscrowPda(task.pda, this.program.programId);
    const protocolPda = findProtocolPda(this.program.programId);

    // Fetch protocol config
    const protocolConfig = await (
      this.program.account as unknown as Record<string, { fetch: (key: PublicKey) => Promise<{ treasury: PublicKey }> }>
    ).protocolConfig.fetch(protocolPda);

    const tx = await this.program.methods
      .completeTaskPrivate(new BN(0), {
        proofData: Array.from(proofResult.proof),
        constraintHash: Array.from(proofResult.constraintHash),
        outputCommitment: Array.from(proofResult.outputCommitment),
        expectedBinding: Array.from(proofResult.expectedBinding),
      })
      .accountsPartial({
        task: task.pda,
        claim: claimPda,
        escrow: escrowPda,
        worker: agentPda,
        protocolConfig: protocolPda,
        treasury: protocolConfig.treasury,
        authority: this.agentWallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Hash output for public task completion
   */
  private hashOutput(output: bigint[]): Uint8Array {
    const buffer = new Uint8Array(32);
    for (let i = 0; i < Math.min(output.length, 4); i++) {
      const bytes = this.bigintToBytes(output[i], 8);
      buffer.set(bytes, i * 8);
    }
    return buffer;
  }

  private bigintToBytes(value: bigint, length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    let remaining = value;
    for (let i = 0; i < length; i++) {
      bytes[i] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return bytes;
  }

  private isZeroHash(hash: Uint8Array): boolean {
    return hash.every((b) => b === 0);
  }

  private recordCompletion(durationMs: number): void {
    this.completionTimes.push(durationMs);
    if (this.completionTimes.length > this.maxCompletionTimeSamples) {
      this.completionTimes.shift();
    }
  }

  private calculateAvgCompletionTime(): number {
    if (this.completionTimes.length === 0) return 0;
    const sum = this.completionTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.completionTimes.length);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
