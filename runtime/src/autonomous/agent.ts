/**
 * AutonomousAgent - Self-operating agent that discovers, claims, and completes tasks
 *
 * @module
 */

import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { generateProof, generateSalt } from '@agenc/sdk';
import { AgentRuntime } from '../runtime.js';
import { TaskScanner, TaskEventSubscription } from './scanner.js';
import {
  Task,
  AutonomousTaskExecutor,
  RevisionCapableTaskExecutor,
  RevisionInput,
  ClaimStrategy,
  AutonomousAgentConfig,
  AutonomousAgentStats,
  DefaultClaimStrategy,
  DiscoveryMode,
  VerifierEscalationMetadata,
  VerifierExecutionResult,
  VerifierVerdictPayload,
  type SpeculationConfig,
} from './types.js';
import { Logger, createLogger, silentLogger } from '../utils/logger.js';
import { createProgram } from '../idl.js';
import { findClaimPda, findEscrowPda } from '../task/pda.js';
import { findProtocolPda } from '../agent/pda.js';
import { fetchTreasury } from '../utils/treasury.js';
import { bigintsToProofHash, toAnchorBytes } from '../utils/encoding.js';
import { buildCompleteTaskTokenAccounts } from '../utils/token.js';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type { Wallet } from '../types/wallet.js';
import { ensureWallet } from '../types/wallet.js';
import type { AgentState } from '../agent/types.js';
import type { ProofEngine } from '../proof/engine.js';
import type { MemoryBackend } from '../memory/types.js';
import { SpeculativeExecutor } from '../task/speculative-executor.js';
import { TaskOperations } from '../task/operations.js';
import { DependencyType } from '../task/dependency-graph.js';
import {
  autonomousTaskToOnChainTask,
  executorToTaskHandler,
} from './speculation-adapter.js';
import type { OnChainTask } from '../task/types.js';
import type { MetricsProvider } from '../task/types.js';
import { VerifierExecutor, VerifierLaneEscalationError } from './verifier.js';
import type { PolicyEngine } from '../policy/engine.js';
import { PolicyViolationError } from '../policy/types.js';
import type { PolicyAction, PolicyDecision, PolicyViolation } from '../policy/types.js';
import type { TrajectoryEventType, TrajectoryRecorderSink } from '../eval/types.js';

/**
 * Create a minimal placeholder OnChainTask for dependency graph registration.
 * Replaced with real data when the task is discovered and claimed.
 */
function createPlaceholderOnChainTask(): OnChainTask {
  return {
    taskId: new Uint8Array(32),
    creator: PublicKey.default,
    requiredCapabilities: 0n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 0n,
    maxWorkers: 1,
    currentWorkers: 0,
    status: 0, // Open
    taskType: 0, // Exclusive
    createdAt: 0,
    deadline: 0,
    completedAt: 0,
    escrow: PublicKey.default,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 0,
    rewardMint: null,
  } as OnChainTask;
}

// Default configuration constants
const DEFAULT_SCAN_INTERVAL_MS = 5000;
const DEFAULT_MAX_CONCURRENT_TASKS = 1;
const DEFAULT_DISCOVERY_MODE: DiscoveryMode = 'hybrid';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_CIRCUIT_PATH = './circuits-circom/task_completion';
const DEFAULT_MEMORY_TTL_MS = 86_400_000; // 24h
const SHUTDOWN_TIMEOUT_MS = 30000;

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
  private readonly proofEngine?: ProofEngine;
  private readonly memory?: MemoryBackend;
  private readonly memoryTtlMs: number;
  private readonly autonomousLogger: Logger;
  private readonly discoveryMode: DiscoveryMode;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly speculationConfig?: SpeculationConfig;
  private readonly verifierConfig?: AutonomousAgentConfig['verifier'];
  private readonly metricsProvider?: MetricsProvider;
  private readonly policyEngine?: PolicyEngine;

  // Components
  private scanner: TaskScanner | null = null;
  private program: Program<AgencCoordination> | null = null;
  private agentWallet: Wallet;
  private taskEventSubscription: TaskEventSubscription | null = null;

  // Speculative execution
  private specExecutor: SpeculativeExecutor | null = null;
  private taskOps: TaskOperations | null = null;
  private awaitingProof: Map<string, Task> = new Map();
  private verifierExecutor: VerifierExecutor | null = null;

  // Cached protocol data
  private cachedTreasury: PublicKey | null = null;

  // State
  private scanLoopRunning = false;
  private scanLoopInterval: ReturnType<typeof setInterval> | null = null;
  private activeTasks: Map<string, ActiveTask> = new Map();
  private pendingTasks: Map<string, Task> = new Map(); // Tasks waiting to be claimed
  private startTime: number = 0;
  private processingLock = false;

  // Poll backoff tracking
  private consecutivePollFailures = 0;
  private readonly maxConsecutiveFailures = 5;

  // Fire-and-forget operation tracking for graceful shutdown
  private pendingOperations = new Set<Promise<unknown>>();

  // Stats
  private stats: AutonomousAgentStats = {
    tasksDiscovered: 0,
    tasksClaimed: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    totalEarnings: 0n,
    earningsByMint: {},
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
  private readonly onEarnings?: (amount: bigint, task: Task, mint?: PublicKey | null) => void;
  private readonly onProofGenerated?: (task: Task, proofSizeBytes: number, durationMs: number) => void;
  private readonly onVerifierVerdict?: (task: Task, verdict: VerifierVerdictPayload) => void;
  private readonly onTaskEscalated?: (task: Task, metadata: VerifierEscalationMetadata) => void;
  private readonly onPolicyViolation?: (violation: PolicyViolation) => void;
  private readonly trajectoryRecorder?: TrajectoryRecorderSink;

  constructor(config: AutonomousAgentConfig) {
    super(config);

    this.executor = config.executor;
    this.claimStrategy = config.claimStrategy ?? DefaultClaimStrategy;
    this.scanIntervalMs = config.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.maxConcurrentTasks = config.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.generateProofs = config.generateProofs ?? true;
    this.circuitPath = config.circuitPath ?? DEFAULT_CIRCUIT_PATH;
    this.proofEngine = config.proofEngine;
    this.memory = config.memory;
    this.memoryTtlMs = config.memoryTtlMs ?? DEFAULT_MEMORY_TTL_MS;
    this.discoveryMode = config.discoveryMode ?? DEFAULT_DISCOVERY_MODE;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    this.speculationConfig = config.speculation;
    this.verifierConfig = config.verifier;
    this.metricsProvider = config.metrics;
    this.policyEngine = config.policyEngine;

    // Store wallet for later use - convert Keypair to Wallet if needed
    this.agentWallet = ensureWallet(config.wallet);

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
    this.onVerifierVerdict = config.onVerifierVerdict;
    this.onTaskEscalated = config.onTaskEscalated;
    this.onPolicyViolation = config.onPolicyViolation;
    this.trajectoryRecorder = config.trajectoryRecorder;

    this.initVerifierLane();
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
    const manager = this.getAgentManager();
    const connection = manager.getConnection();
    const programId = manager.getProgramId();

    const provider = new AnchorProvider(connection, this.agentWallet, { commitment: 'confirmed' });
    this.program = createProgram(provider, programId);

    // Initialize scanner
    this.scanner = new TaskScanner({
      connection,
      program: this.program,
      logger: this.autonomousLogger,
    });

    // Initialize speculative executor if enabled
    this.initSpeculation();

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

    // Drain pending fire-and-forget operations
    if (this.pendingOperations.size > 0) {
      this.autonomousLogger.debug(`Waiting for ${this.pendingOperations.size} pending operations...`);
      await Promise.allSettled([...this.pendingOperations]);
    }

    // Shutdown speculative executor (aborts speculative tasks, waits for in-flight proofs)
    if (this.specExecutor) {
      await this.specExecutor.shutdown();
      this.specExecutor = null;
    }

    // Wait for active tasks to complete (with timeout)
    if (this.activeTasks.size > 0) {
      this.autonomousLogger.info(`Waiting for ${this.activeTasks.size} active tasks to complete...`);
      const timeout = Date.now() + SHUTDOWN_TIMEOUT_MS;
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
   * Initialize speculative executor and proof pipeline events.
   *
   * Called from start() when speculation is enabled. Creates TaskOperations,
   * SpeculativeExecutor, and wires proof pipeline event handlers.
   */
  private initSpeculation(): void {
    if (!this.speculationConfig?.enabled || !this.program) return;

    const agentPda = this.getAgentPda();
    const agentId = this.getAgentId();
    if (!agentPda || !agentId) return;

    this.taskOps = new TaskOperations({
      program: this.program,
      agentId,
      logger: this.autonomousLogger,
    });

    const handler = executorToTaskHandler(this.executor);

    this.specExecutor = new SpeculativeExecutor({
      operations: this.taskOps,
      handler,
      agentId,
      agentPda,
      logger: this.autonomousLogger,
      enableSpeculation: true,
      maxSpeculativeTasksPerParent: this.speculationConfig.maxSpeculativeTasksPerParent,
      maxSpeculationDepth: this.speculationConfig.maxSpeculationDepth,
      speculatableDependencyTypes: this.speculationConfig.speculatableDependencyTypes,
      abortOnParentFailure: this.speculationConfig.abortOnParentFailure,
      proofPipelineConfig: this.speculationConfig.proofPipelineConfig,
      metrics: this.metricsProvider,
    });

    // Wire proof pipeline events for async proof confirmation
    this.specExecutor.on({
      onSpeculativeExecutionStarted: (taskPda, parentPda) => {
        this.recordTrajectoryByPda(taskPda, 'speculation_started', {
          parentPda: parentPda.toBase58(),
        });
        this.speculationConfig?.onSpeculativeStarted?.(taskPda, parentPda);
      },
      onSpeculativeExecutionConfirmed: (taskPda) => {
        this.recordTrajectoryByPda(taskPda, 'speculation_confirmed', {});
        this.speculationConfig?.onSpeculativeConfirmed?.(taskPda);
      },
      onSpeculativeExecutionAborted: (taskPda, reason) => {
        this.recordTrajectoryByPda(taskPda, 'speculation_aborted', { reason });
        this.speculationConfig?.onSpeculativeAborted?.(taskPda, reason);
      },
      onParentProofConfirmed: (parentPda) => {
        this.handleProofConfirmed(parentPda);
      },
      onParentProofFailed: (parentPda, error) => {
        this.handleProofFailed(parentPda, error);
      },
    });

    this.autonomousLogger.info('Speculative execution enabled');
  }

  /**
   * Initialize verifier lane (Executor + Critic), if configured.
   */
  private initVerifierLane(): void {
    if (!this.verifierConfig) return;

    const revisionExecutor = this.executor as Partial<RevisionCapableTaskExecutor>;
    const reviseTask = typeof revisionExecutor.revise === 'function'
      ? (input: RevisionInput) => this.executeRevisionWithRetry(
        revisionExecutor as RevisionCapableTaskExecutor,
        input,
      )
      : undefined;

    this.verifierExecutor = new VerifierExecutor({
      verifierConfig: this.verifierConfig,
      executeTask: (task) => this.executeWithRetry(task),
      reviseTask,
      metrics: this.metricsProvider,
      onVerdict: (task, verdict, attempt) => {
        this.onVerifierVerdict?.(task, verdict);
        this.trackOperation(this.journalEvent(task, 'verifier_verdict', {
          attempt,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          reasons: verdict.reasons,
          metadata: verdict.metadata,
        }));
      },
    });
  }

  private evaluatePolicyAction(action: PolicyAction, task?: Task): PolicyDecision | null {
    if (!this.policyEngine) return null;

    const decision = this.policyEngine.evaluate(action);
    if (decision.allowed) {
      return decision;
    }

    const violation = decision.violations[0];
    if (violation) {
      this.onPolicyViolation?.(violation);
      this.autonomousLogger.warn(
        `Policy blocked ${action.type}:${action.name} (${violation.code})`,
      );
      if (task) {
        this.trackOperation(this.journalEvent(task, 'policy_violation', {
          action,
          violation,
          mode: decision.mode,
        }));
      }
    }

    return decision;
  }

  /**
   * Evaluate policy action and return allow/deny.
   */
  private isPolicyAllowed(action: PolicyAction, task?: Task): boolean {
    const decision = this.evaluatePolicyAction(action, task);
    return decision ? decision.allowed : true;
  }

  /**
   * Evaluate policy and throw on denial.
   */
  private requirePolicyAllowed(action: PolicyAction, task?: Task): void {
    const decision = this.evaluatePolicyAction(action, task);
    if (!decision || decision.allowed) return;
    throw new PolicyViolationError(action, decision);
  }

  /**
   * Get current agent stats
   */
  getStats(): AutonomousAgentStats {
    const stats: AutonomousAgentStats = {
      ...this.stats,
      activeTasks: this.activeTasks.size + this.awaitingProof.size,
      uptimeMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
      avgCompletionTimeMs: this.calculateAvgCompletionTime(),
    };

    if (this.specExecutor) {
      const m = this.specExecutor.getMetrics();
      stats.speculativeExecutionsStarted = m.speculativeExecutionsStarted;
      stats.speculativeExecutionsConfirmed = m.speculativeExecutionsConfirmed;
      stats.speculativeExecutionsAborted = m.speculativeExecutionsAborted;
      stats.estimatedTimeSavedMs = m.estimatedTimeSavedMs;
    }

    if (this.verifierExecutor) {
      const m = this.verifierExecutor.getMetrics();
      stats.verifierChecks = m.checks;
      stats.verifierPasses = m.passes;
      stats.verifierFailures = m.fails;
      stats.verifierNeedsRevision = m.needsRevision;
      stats.verifierDisagreements = m.disagreements;
      stats.verifierRevisions = m.revisions;
      stats.verifierEscalations = m.escalations;
      stats.verifierAddedLatencyMs = m.addedLatencyMs;
      stats.verifierPassRate = m.checks > 0 ? m.passes / m.checks : 0;
      stats.verifierDisagreementRate = m.checks > 0 ? m.disagreements / m.checks : 0;
    }

    return stats;
  }

  /**
   * Get the Anchor program instance (available after start())
   */
  getProgram(): Program<AgencCoordination> | null {
    return this.program;
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
   * Register a dependency between two tasks for speculative execution.
   *
   * When a child task depends on a parent, the speculative executor will
   * start executing the child while the parent's proof is being generated.
   *
   * @param childPda - Child task PDA
   * @param parentPda - Parent task PDA
   * @param type - Dependency type (default: Data)
   * @throws Error if speculation is not enabled or agent not started
   */
  registerDependency(
    childPda: PublicKey,
    parentPda: PublicKey,
    type: DependencyType = DependencyType.Data,
  ): void {
    if (!this.specExecutor) {
      throw new Error('Speculation not enabled — set speculation.enabled in config');
    }
    if (!this.isStarted()) {
      throw new Error('Agent not started — call start() first');
    }

    const graph = this.specExecutor.getDependencyGraph();

    // If child isn't in the graph yet, we can't add a parent relationship.
    // Add it as a placeholder node with a minimal OnChainTask.
    if (!graph.hasTask(childPda)) {
      this.autonomousLogger.debug(
        `Adding placeholder for child ${childPda.toBase58().slice(0, 8)} in dependency graph`,
      );
      // Will be replaced with real data when the task is discovered and claimed
      graph.addTaskWithParent(
        createPlaceholderOnChainTask(),
        childPda,
        parentPda,
        type,
      );
    }

    this.autonomousLogger.info(
      `Registered dependency: ${childPda.toBase58().slice(0, 8)} depends on ${parentPda.toBase58().slice(0, 8)} (${DependencyType[type]})`,
    );
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
      const canDiscover = this.isPolicyAllowed({
        type: 'task_discovery',
        name: 'poll_discovery',
        access: 'read',
      });
      if (!canDiscover) {
        return;
      }

      // Scan for tasks
      const tasks = await this.scanner.scan();
      this.consecutivePollFailures = 0;

      for (const task of tasks) {
        this.handleDiscoveredTask(task);
      }

      // Process pending tasks
      await this.processPendingTasks();
    } catch (error) {
      this.consecutivePollFailures++;
      this.autonomousLogger.error(
        `Poll cycle failed (${this.consecutivePollFailures}/${this.maxConsecutiveFailures}):`,
        error,
      );

      if (this.consecutivePollFailures >= this.maxConsecutiveFailures) {
        this.autonomousLogger.error('Max consecutive poll failures reached, pausing discovery');
        this.stopPolling();
        // Auto-resume after 60s cooldown (only if agent is still running)
        setTimeout(() => {
          if (this.isStarted()) {
            this.consecutivePollFailures = 0;
            this.startPolling();
          }
        }, 60_000);
      }
    }
  }

  /**
   * Handle a newly discovered task
   */
  private handleDiscoveredTask(task: Task): void {
    const allowed = this.isPolicyAllowed({
      type: 'task_discovery',
      name: 'event_discovery',
      access: 'read',
      metadata: { taskPda: task.pda.toBase58() },
    }, task);
    if (!allowed) return;

    const taskKey = task.pda.toBase58();

    // Skip if already active, pending, or awaiting proof
    if (this.isTaskTracked(taskKey)) {
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
    this.recordTrajectoryEvent('discovered', {
      rewardLamports: task.reward.toString(),
      currentClaims: task.currentClaims,
      maxWorkers: task.maxWorkers,
      taskType: task.taskType ?? null,
    }, task.pda);

    this.autonomousLogger.debug(`Discovered task: ${taskKey.slice(0, 8)} (reward: ${Number(task.reward) / LAMPORTS_PER_SOL} SOL)`);

    // Trigger processing if not already running
    if (!this.processingLock) {
      this.trackOperation(this.processPendingTasks());
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
        this.trackOperation(this.claimAndProcess(task));
      }
    } finally {
      this.processingLock = false;
    }
  }

  /**
   * Claim a task and process it.
   *
   * Verifies availability, claims the task, then delegates to the speculative
   * or sequential execution path.
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
      this.requirePolicyAllowed({
        type: 'task_claim',
        name: 'claim_task',
        access: 'write',
        metadata: { taskPda: taskKey },
      }, task);

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
      await this.journalEvent(task, 'claimed', { claimTx });
      this.autonomousLogger.info(`Claimed task ${taskKey.slice(0, 8)}: ${claimTx}`);

      // Delegate to the appropriate execution path
      const verifierGated = this.verifierExecutor?.shouldVerify(task) ?? false;
      const policyManaged = this.policyEngine !== undefined;
      if (this.specExecutor && !verifierGated && !policyManaged) {
        return await this.executeSpeculative(task, taskKey, startTime);
      }
      if (this.specExecutor && (verifierGated || policyManaged)) {
        await this.journalEvent(task, 'sequential_enforcement_bypass', {
          reason: verifierGated ? 'verifier_gated_task' : 'policy_managed_task',
        });
      }
      return await this.executeSequential(task, activeTask, taskKey);
    } catch (error) {
      this.activeTasks.delete(taskKey);
      this.stats.tasksFailed++;

      const err = error instanceof Error ? error : new Error(String(error));
      if (err instanceof VerifierLaneEscalationError) {
        this.onTaskEscalated?.(task, err.metadata);
        await this.journalEvent(task, 'escalated', {
          escalation: err.metadata,
          verifierHistory: err.history,
        });
      }
      this.onTaskFailed?.(task, err);
      await this.journalEvent(task, 'failed', { error: err.message });
      this.autonomousLogger.error(`Task ${taskKey.slice(0, 8)} failed:`, err.message);

      return { success: false, task, error: err, durationMs: Date.now() - startTime };
    }
  }

  /**
   * Speculative execution path.
   *
   * Delegates execution and proof generation to SpeculativeExecutor, moves the
   * task to awaitingProof (freeing the concurrency slot), and returns immediately.
   * ProofPipeline events drive async completion tracking and callbacks.
   */
  private async executeSpeculative(task: Task, taskKey: string, startTime: number): Promise<TaskResult> {
    const adaptedTask = autonomousTaskToOnChainTask(task);
    this.specExecutor!.addTaskToGraph(adaptedTask, task.pda);

    this.autonomousLogger.info(`Executing task ${taskKey.slice(0, 8)} (speculative)...`);
    await this.specExecutor!.executeWithSpeculation(task.pda);

    // Move from activeTasks → awaitingProof (frees concurrency slot)
    this.activeTasks.delete(taskKey);
    this.awaitingProof.set(taskKey, task);
    await this.journalEvent(task, 'executed_speculative', {});
    this.autonomousLogger.info(`Task ${taskKey.slice(0, 8)} executed, proof queued (speculative)`);

    return { success: true, task, durationMs: Date.now() - startTime };
  }

  /**
   * Sequential execution path (default).
   *
   * Executes the task, generates proof, and submits on-chain — all blocking.
   * The concurrency slot is held until completion.
   */
  private async executeSequential(
    task: Task,
    activeTask: ActiveTask,
    taskKey: string,
  ): Promise<TaskResult> {
    this.requirePolicyAllowed({
      type: 'task_execution',
      name: 'execute_task',
      access: 'write',
      metadata: { taskPda: taskKey },
    }, task);

    this.autonomousLogger.info(`Executing task ${taskKey.slice(0, 8)}...`);
    let output: bigint[];
    let verifierResult: VerifierExecutionResult | null = null;

    if (this.verifierExecutor?.shouldVerify(task)) {
      verifierResult = await this.verifierExecutor.execute(task);
      output = verifierResult.output;
    } else {
      output = await this.executeWithRetry(task);
    }

    this.onTaskExecuted?.(task, output);
    await this.journalEvent(task, 'executed', {
      outputLength: output.length,
      verifier: verifierResult ? {
        attempts: verifierResult.attempts,
        revisions: verifierResult.revisions,
        addedLatencyMs: verifierResult.durationMs,
      } : null,
    });
    this.autonomousLogger.info(`Executed task ${taskKey.slice(0, 8)}`);

    // Complete the task with retry
    this.requirePolicyAllowed({
      type: 'tx_submission',
      name: 'complete_task_submission',
      access: 'write',
      spendLamports: task.reward,
      metadata: { taskPda: taskKey },
    }, task);
    const completeTx = await this.completeTaskWithRetry(task, output);

    const durationMs = Date.now() - activeTask.claimedAt;
    this.recordCompletion(durationMs);

    this.activeTasks.delete(taskKey);
    this.stats.tasksCompleted++;
    this.stats.totalEarnings += task.reward;
    const mintKey = task.rewardMint?.toBase58() ?? 'SOL';
    this.stats.earningsByMint[mintKey] = (this.stats.earningsByMint[mintKey] ?? 0n) + task.reward;

    this.onTaskCompleted?.(task, completeTx);
    this.onEarnings?.(task.reward, task, task.rewardMint ?? null);
    await this.journalEvent(task, 'completed', { completionTx: completeTx, durationMs, reward: task.reward.toString() });

    this.autonomousLogger.info(
      `Completed task ${taskKey.slice(0, 8)} in ${durationMs}ms, earned ${Number(task.reward) / LAMPORTS_PER_SOL} SOL`
    );

    return { success: true, task, completionTx: completeTx, durationMs };
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
   * Execute a targeted revision with retry logic.
   */
  private async executeRevisionWithRetry(
    executor: RevisionCapableTaskExecutor,
    input: RevisionInput,
  ): Promise<bigint[]> {
    return this.withRetry(() => executor.revise(input), 'revise task');
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
   * Fetch treasury address, caching the result to avoid repeated RPC calls.
   */
  private async getTreasury(): Promise<PublicKey> {
    if (this.cachedTreasury) return this.cachedTreasury;
    if (!this.program) throw new Error('Agent not started');
    this.cachedTreasury = await fetchTreasury(this.program, this.program.programId);
    return this.cachedTreasury;
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
    const treasury = await this.getTreasury();
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      this.agentWallet.publicKey,
      treasury,
    );

    // Hash the output for public completion
    const resultHash = bigintsToProofHash(output);

    const tx = await this.program.methods
      .completeTask(toAnchorBytes(resultHash), null)
      .accountsPartial({
        task: task.pda,
        claim: claimPda,
        escrow: escrowPda,
        worker: agentPda,
        protocolConfig: protocolPda,
        treasury,
        authority: this.agentWallet.publicKey,
        systemProgram: SystemProgram.programId,
        ...tokenAccounts,
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

    // Generate proof — delegate to ProofEngine when available for caching + stats
    this.autonomousLogger.info('Generating ZK proof...');
    const proofStartTime = Date.now();

    let proofResult: { proof: Uint8Array; constraintHash: Uint8Array; outputCommitment: Uint8Array; expectedBinding: Uint8Array; proofSize: number };
    if (this.proofEngine) {
      const salt = this.proofEngine.generateSalt();
      proofResult = await this.proofEngine.generate({
        taskPda: task.pda,
        agentPubkey: this.agentWallet.publicKey,
        output,
        salt,
      });
    } else {
      const salt = generateSalt();
      proofResult = await generateProof({
        taskPda: task.pda,
        agentPubkey: this.agentWallet.publicKey,
        output,
        salt,
        circuitPath: this.circuitPath,
      });
    }

    const proofDuration = Date.now() - proofStartTime;
    this.onProofGenerated?.(task, proofResult.proofSize, proofDuration);
    this.recordTrajectoryEvent('proof_generated', {
      proofSizeBytes: proofResult.proofSize,
      durationMs: proofDuration,
    }, task.pda);
    this.autonomousLogger.info(`Proof generated in ${proofDuration}ms (${proofResult.proofSize} bytes)`);

    const claimPda = findClaimPda(task.pda, agentPda, this.program.programId);
    const escrowPda = findEscrowPda(task.pda, this.program.programId);
    const protocolPda = findProtocolPda(this.program.programId);
    const treasury = await this.getTreasury();
    const tokenAccounts = buildCompleteTaskTokenAccounts(
      task.rewardMint,
      escrowPda,
      this.agentWallet.publicKey,
      treasury,
    );

    const tx = await this.program.methods
      .completeTaskPrivate(new BN(0), {
        proofData: toAnchorBytes(proofResult.proof),
        constraintHash: toAnchorBytes(proofResult.constraintHash),
        outputCommitment: toAnchorBytes(proofResult.outputCommitment),
        expectedBinding: toAnchorBytes(proofResult.expectedBinding),
      })
      .accountsPartial({
        task: task.pda,
        claim: claimPda,
        escrow: escrowPda,
        worker: agentPda,
        protocolConfig: protocolPda,
        treasury,
        authority: this.agentWallet.publicKey,
        systemProgram: SystemProgram.programId,
        ...tokenAccounts,
      })
      .rpc();

    return tx;
  }

  private async journalEvent(
    task: Task,
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.recordTrajectoryEvent(event, data, task.pda);
    if (!this.memory) return;
    const sessionId = `lifecycle:${task.pda.toBase58()}`;
    try {
      await this.memory.addEntry({
        sessionId,
        role: 'system',
        content: JSON.stringify({ event, timestamp: Date.now(), ...data }),
        taskPda: task.pda.toBase58(),
        metadata: { type: 'lifecycle', event },
        ttlMs: this.memoryTtlMs,
      });
    } catch (err) {
      this.autonomousLogger.warn(`Failed to journal ${event} event:`, err);
    }
  }

  private recordTrajectoryByPda(
    taskPda: PublicKey,
    event: TrajectoryEventType,
    payload: Record<string, unknown>,
  ): void {
    this.recordTrajectoryEvent(event, payload, taskPda);
  }

  private recordTrajectoryEvent(
    event: string,
    payload: Record<string, unknown>,
    taskPda?: PublicKey,
  ): void {
    if (!this.trajectoryRecorder) return;
    try {
      this.trajectoryRecorder.record({
        type: event as TrajectoryEventType,
        taskPda: taskPda?.toBase58(),
        payload,
      });
    } catch (err) {
      this.autonomousLogger.warn(`Failed to record trajectory event ${event}:`, err);
    }
  }

  /**
   * Track a fire-and-forget promise for graceful shutdown.
   */
  private trackOperation(promise: Promise<unknown>): void {
    this.pendingOperations.add(promise);
    promise.finally(() => this.pendingOperations.delete(promise));
  }

  /**
   * Check if a task is already tracked in any map.
   */
  private isTaskTracked(taskKey: string): boolean {
    return this.activeTasks.has(taskKey)
      || this.pendingTasks.has(taskKey)
      || this.awaitingProof.has(taskKey);
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

  // ==========================================================================
  // Speculative Execution Event Handlers
  // ==========================================================================

  /**
   * Handle proof confirmed from ProofPipeline (via SpeculativeExecutor event).
   * Updates stats, fires callbacks, and removes from awaitingProof.
   */
  private handleProofConfirmed(taskPda: PublicKey): void {
    const taskKey = taskPda.toBase58();
    const task = this.awaitingProof.get(taskKey);
    if (!task) return;

    this.awaitingProof.delete(taskKey);
    this.stats.tasksCompleted++;
    this.stats.totalEarnings += task.reward;

    // Get the transaction signature from the proof pipeline job
    const job = this.specExecutor?.getProofPipeline().getJob(taskPda);
    const txSig = job?.transactionSignature ?? '';

    this.onTaskCompleted?.(task, txSig);
    this.onEarnings?.(task.reward, task);

    void this.journalEvent(task, 'completed_speculative', {
      completionTx: txSig,
    });

    this.autonomousLogger.info(
      `Task ${taskKey.slice(0, 8)} proof confirmed (speculative), earned ${Number(task.reward) / LAMPORTS_PER_SOL} SOL`,
    );
  }

  /**
   * Handle proof failed from ProofPipeline (via SpeculativeExecutor event).
   * Updates stats, fires callbacks, and removes from awaitingProof.
   */
  private handleProofFailed(taskPda: PublicKey, error: Error): void {
    const taskKey = taskPda.toBase58();
    const task = this.awaitingProof.get(taskKey);
    if (!task) return;

    this.awaitingProof.delete(taskKey);
    this.stats.tasksFailed++;

    this.onTaskFailed?.(task, error);

    void this.journalEvent(task, 'proof_failed', {
      error: error.message,
    });

    this.autonomousLogger.error(
      `Task ${taskKey.slice(0, 8)} proof failed: ${error.message}`,
    );
  }
}
