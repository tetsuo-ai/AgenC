/**
 * AgentRuntime - High-level agent lifecycle management with automatic startup/shutdown
 *
 * Provides a simple interface for running agents with automatic registration,
 * status management, and graceful shutdown handling.
 *
 * @module
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import { PROGRAM_ID } from '@agenc/sdk';
import type { AgencCoordination } from './types/agenc_coordination.js';
import { AgentManager } from './agent/manager.js';
import { AgentState, AgentStatus, AgentRegistrationParams, AGENT_ID_LENGTH } from './agent/types.js';
import { findAgentPda } from './agent/pda.js';
import { EventMonitor } from './events/index.js';
import { ReplayEventBridge, type ReplayBridgeConfig, type ReplayBridgeHandle } from './replay/bridge.js';
import type { BackfillResult } from './replay/types.js';
import { TaskExecutor } from './task/index.js';
import type { TaskExecutorConfig } from './task/types.js';
import type { AgentRuntimeConfig, RuntimeReplayConfig, ReplayBackfillConfig } from './types/config.js';
import type { Wallet } from './types/wallet.js';
import { ensureWallet } from './types/wallet.js';
import { Logger, createLogger, silentLogger } from './utils/logger.js';
import { generateAgentId, agentIdToShortString } from './utils/encoding.js';
import { ValidationError } from './types/errors.js';

/**
 * High-level agent runtime with automatic lifecycle management.
 *
 * AgentRuntime wraps AgentManager and provides:
 * - Automatic agent registration or loading on start()
 * - Automatic status transition to Active on start
 * - Graceful shutdown with status transition to Inactive
 * - Process signal handling for clean termination
 *
 * @example
 * ```typescript
 * import { Connection, Keypair } from '@solana/web3.js';
 * import { AgentRuntime, AgentCapabilities } from '@agenc/runtime';
 *
 * const runtime = new AgentRuntime({
 *   connection: new Connection('https://api.devnet.solana.com'),
 *   wallet: Keypair.generate(),
 *   capabilities: AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE,
 *   initialStake: 1_000_000_000n, // 1 SOL
 *   logLevel: 'info',
 * });
 *
 * // Register shutdown handlers (optional - for graceful process termination)
 * runtime.registerShutdownHandlers();
 *
 * // Start the runtime (registers agent if needed, sets Active status)
 * await runtime.start();
 *
 * console.log('Agent running:', runtime.getAgentId());
 *
 * // ... agent operations ...
 *
 * // Stop the runtime (sets Inactive status, cleans up subscriptions)
 * await runtime.stop();
 * ```
 */
export class AgentRuntime {
  private readonly connection: Connection;
  private readonly wallet: Wallet;
  private readonly programId: PublicKey;
  private readonly logger: Logger;
  private readonly agentManager: AgentManager;

  // Configuration for registration
  private readonly agentId: Uint8Array;
  private readonly capabilities: bigint | undefined;
  private readonly endpoint: string | undefined;
  private readonly metadataUri: string | undefined;
  private readonly initialStake: bigint;

  // Runtime state
  private started = false;
  private shutdownHandlersRegistered = false;
  private readonly replayBridge: ReplayBridgeHandle | null;
  private readonly replayBackfillDefaults?: ReplayBackfillConfig;
  private readonly replayTraceId?: string;

  /**
   * Create a new AgentRuntime instance.
   *
   * @param config - Runtime configuration
   * @throws ValidationError if configuration is invalid
   */
  constructor(config: AgentRuntimeConfig) {
    // Validate required fields
    if (!config.connection) {
      throw new ValidationError('connection is required');
    }
    if (!config.wallet) {
      throw new ValidationError('wallet is required');
    }

    this.connection = config.connection;
    this.programId = config.programId ?? PROGRAM_ID;

    // Convert Keypair to Wallet if needed
    this.wallet = ensureWallet(config.wallet);

    // Setup logger
    if (config.logLevel !== undefined) {
      this.logger = createLogger(config.logLevel, '[AgentRuntime]');
    } else {
      this.logger = silentLogger;
    }

    // Validate and store agent ID
    if (config.agentId !== undefined && config.agentId.length !== AGENT_ID_LENGTH) {
      throw new ValidationError(
        `Invalid agentId length: ${config.agentId.length} (must be ${AGENT_ID_LENGTH})`
      );
    }
    this.agentId = config.agentId ?? generateAgentId();
    this.capabilities = config.capabilities;
    this.endpoint = config.endpoint;
    this.metadataUri = config.metadataUri;
    this.initialStake = config.initialStake ?? 0n;

    // Create AgentManager
    this.agentManager = new AgentManager({
      connection: this.connection,
      wallet: this.wallet,
      programId: this.programId,
      logger: this.logger,
      program: config.program as Program<AgencCoordination> | undefined,
    });

    const replayConfig = config.replay;
    const tracing = replayConfig?.tracing;
    this.replayBackfillDefaults = replayConfig?.backfill;
    this.replayTraceId = tracing?.traceId ?? replayConfig?.traceId;
    this.replayBridge = this.createReplayBridge(replayConfig ? {
      ...replayConfig,
      tracing,
      traceId: replayConfig?.traceId,
    } : undefined);

    this.logger.debug('AgentRuntime created');
  }

  /**
   * Start the agent runtime.
   *
   * This method:
   * 1. Checks if agent is already registered on-chain
   * 2. If not registered, registers the agent (requires capabilities)
   * 3. Sets the agent status to Active
   *
   * @returns The current agent state
   * @throws ValidationError if capabilities not provided for new registration
   * @throws Error if registration or status update fails
   *
   * @example
   * ```typescript
   * await runtime.start();
   * console.log('Agent is now active');
   * ```
   */
  async start(): Promise<AgentState> {
    if (this.started) {
      this.logger.warn('AgentRuntime already started');
      return this.agentManager.getState();
    }

    const shortId = agentIdToShortString(this.agentId);
    this.logger.info(`Starting AgentRuntime for ${shortId}`);

    // Check if agent already exists on-chain
    const exists = await AgentManager.agentExists(
      this.connection,
      this.agentId,
      this.programId
    );

    let state: AgentState;

    if (exists) {
      // Load existing agent
      this.logger.info(`Loading existing agent ${shortId}`);
      state = await this.agentManager.load(this.agentId);
    } else {
      // Register new agent
      if (this.capabilities === undefined) {
        throw new ValidationError(
          'capabilities are required for new agent registration'
        );
      }

      // Generate default endpoint if not provided
      const endpoint = this.endpoint ?? `agent://${shortId}`;

      this.logger.info(`Registering new agent ${shortId}`);

      const params: AgentRegistrationParams = {
        agentId: this.agentId,
        capabilities: this.capabilities,
        endpoint,
        metadataUri: this.metadataUri,
        stakeAmount: this.initialStake,
      };

      state = await this.agentManager.register(params);
    }

    // Set status to Active if not already
    if (state.status !== AgentStatus.Active) {
      this.logger.debug('Setting agent status to Active');
      state = await this.agentManager.updateStatus(AgentStatus.Active);
    }

    await this.replayBridge?.start();

    this.started = true;
    this.logger.info(`AgentRuntime started successfully for ${shortId}`);

    return state;
  }

  /**
   * Stop the agent runtime.
   *
   * This method:
   * 1. Sets the agent status to Inactive (logs warning on failure)
   * 2. Unsubscribes from all events
   *
   * This method is idempotent - calling it multiple times is safe.
   *
   * @example
   * ```typescript
   * await runtime.stop();
   * console.log('Agent stopped');
   * ```
   */
  async stop(): Promise<void> {
    if (!this.started) {
      this.logger.debug('AgentRuntime not started, nothing to stop');
      return;
    }

    const shortId = agentIdToShortString(this.agentId);
    this.logger.info(`Stopping AgentRuntime for ${shortId}`);

    // Try to set status to Inactive, but don't throw on failure
    try {
      if (this.agentManager.isRegistered()) {
        const state = this.agentManager.getCachedState();
        if (state && state.status !== AgentStatus.Inactive) {
          await this.agentManager.updateStatus(AgentStatus.Inactive);
          this.logger.debug('Agent status set to Inactive');
        }
      }
    } catch (err) {
      // Log warning but don't throw - we want cleanup to continue
      this.logger.warn(
        'Failed to set agent status to Inactive:',
        err instanceof Error ? err.message : String(err)
      );
    }

    // Stop replay bridge before tearing down runtime subscriptions
    await this.replayBridge?.stop();

    // Unsubscribe from all events
    await this.agentManager.unsubscribeAll();

    this.started = false;
    this.logger.info(`AgentRuntime stopped for ${shortId}`);
  }

  /**
   * Perform graceful shutdown and exit the process.
   *
   * This method:
   * 1. Calls stop() to clean up
   * 2. Exits with code 0
   *
   * @example
   * ```typescript
   * // In your cleanup code
   * await runtime.gracefulShutdown();
   * // Process will exit after this
   * ```
   */
  async gracefulShutdown(): Promise<never> {
    this.logger.info('Graceful shutdown initiated');
    await this.stop();
    this.logger.info('Exiting process');
    process.exit(0);
  }

  /**
   * Register process signal handlers for graceful shutdown.
   *
   * Registers handlers for SIGINT (Ctrl+C) and SIGTERM that call
   * gracefulShutdown(). This method is idempotent.
   *
   * @example
   * ```typescript
   * runtime.registerShutdownHandlers();
   * await runtime.start();
   * // Now Ctrl+C will trigger graceful shutdown
   * ```
   */
  registerShutdownHandlers(): void {
    if (this.shutdownHandlersRegistered) {
      this.logger.debug('Shutdown handlers already registered');
      return;
    }

    const handler = () => {
      void this.gracefulShutdown();
    };

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);

    this.shutdownHandlersRegistered = true;
    this.logger.debug('Shutdown handlers registered for SIGINT and SIGTERM');
  }

  // ==========================================================================
  // Query Methods (delegate to AgentManager)
  // ==========================================================================

  /**
   * Get the current agent state from chain.
   *
   * @returns Current agent state
   * @throws AgentNotRegisteredError if runtime not started
   *
   * @example
   * ```typescript
   * const state = await runtime.getAgentState();
   * console.log(`Active tasks: ${state.activeTasks}`);
   * ```
   */
  async getAgentState(): Promise<AgentState> {
    return this.agentManager.getState();
  }

  /**
   * Get the agent ID.
   *
   * This is always available, even before start() is called.
   *
   * @returns A copy of the agent ID (32 bytes)
   *
   * @example
   * ```typescript
   * const id = runtime.getAgentId();
   * console.log('Agent ID:', agentIdToString(id));
   * ```
   */
  getAgentId(): Uint8Array {
    // Return a copy to prevent external mutation
    return new Uint8Array(this.agentId);
  }

  /**
   * Get the agent PDA address.
   *
   * @returns Agent PDA or null if not started
   *
   * @example
   * ```typescript
   * const pda = runtime.getAgentPda();
   * if (pda) {
   *   console.log('Agent PDA:', pda.toBase58());
   * }
   * ```
   */
  getAgentPda(): PublicKey | null {
    return this.agentManager.getAgentPda();
  }

  /**
   * Get the underlying AgentManager instance.
   *
   * Use this for advanced operations not exposed directly by AgentRuntime.
   *
   * @returns The AgentManager instance
   *
   * @example
   * ```typescript
   * const manager = runtime.getAgentManager();
   * await manager.updateCapabilities(newCapabilities);
   * ```
   */
  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  /**
   * Get the replay bridge handle for manual operations (query/backfill/debug tooling).
   */
  getReplayBridge(): ReplayBridgeHandle | null {
    return this.replayBridge;
  }

  /**
   * Run a manual replay backfill using configured defaults and provided overrides.
   */
  async runReplayBackfill(
    options: {
      fetcher: Parameters<ReplayBridgeHandle['runBackfill']>[0]['fetcher'];
      toSlot?: number;
      pageSize?: number;
    },
  ): Promise<BackfillResult> {
    if (!this.replayBridge) {
      throw new Error('Replay bridge is not enabled');
    }

    const toSlot = options.toSlot ?? this.replayBackfillDefaults?.toSlot;
    if (typeof toSlot !== 'number' || !Number.isInteger(toSlot) || toSlot < 0) {
      throw new Error('runReplayBackfill requires a valid toSlot');
    }

    return this.replayBridge.runBackfill({
      fetcher: options.fetcher,
      toSlot,
      pageSize: options.pageSize ?? this.replayBackfillDefaults?.pageSize,
      traceId: this.replayTraceId,
    });
  }

  private createReplayBridge(
    replayConfig?: RuntimeReplayConfig,
  ): ReplayBridgeHandle | null {
    if (!replayConfig?.enabled) {
      return null;
    }

    const logger = replayConfig.traceLevel
      ? createLogger(replayConfig.traceLevel, '[ReplayBridge]')
      : this.logger;

    const options: ReplayBridgeConfig = {
      traceId: replayConfig.traceId,
      tracing: replayConfig.tracing,
      projectionSeed: replayConfig.projectionSeed,
      strictProjection: replayConfig.strictProjection,
      store: replayConfig.store,
      logger,
    };

    return ReplayEventBridge.create(
      this.agentManager.getProgram(),
      options,
    );
  }

  /**
   * Check if the runtime has been started.
   *
   * @returns True if start() has been called and stop() has not been called
   */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * Create an EventMonitor instance configured with this runtime's program and logger.
   *
   * The returned EventMonitor can subscribe to task, dispute, protocol, and agent
   * events with transparent metrics tracking.
   *
   * @returns A new EventMonitor instance
   *
   * @example
   * ```typescript
   * const monitor = runtime.createEventMonitor();
   * monitor.subscribeToTaskEvents({
   *   onTaskCreated: (event) => console.log('Task created:', event.taskId),
   * });
   * monitor.start();
   * ```
   */
  createEventMonitor(): EventMonitor {
    return new EventMonitor({
      program: this.agentManager.getProgram(),
      logger: this.logger,
    });
  }

  /**
   * Create a TaskExecutor configured with this runtime's agent identity and logger.
   *
   * Automatically injects `agentId`, `agentPda`, and `logger` from the runtime.
   * The logger can be overridden via the config parameter if needed.
   *
   * Note: AgentRuntime.stop() does NOT automatically stop executors.
   * You must manage executor lifecycle independently.
   *
   * @param config - Executor configuration (agentId, agentPda, and logger are auto-injected)
   * @returns A new TaskExecutor instance
   *
   * @example
   * ```typescript
   * const executor = runtime.createTaskExecutor({
   *   operations,
   *   handler: async (ctx) => ({ proofHash: new Uint8Array(32).fill(1) }),
   *   mode: 'autonomous',
   *   discovery,
   * });
   * await executor.start();
   * ```
   */
  createTaskExecutor(
    config: Omit<TaskExecutorConfig, 'agentId' | 'agentPda' | 'logger'> & { logger?: Logger }
  ): TaskExecutor {
    const agentPda = findAgentPda(this.agentId, this.programId);
    return new TaskExecutor({
      ...config,
      agentId: new Uint8Array(this.agentId),
      agentPda,
      logger: config.logger ?? this.logger,
    });
  }
}
