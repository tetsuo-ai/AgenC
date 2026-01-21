/**
 * AgentManager - High-level agent lifecycle management
 *
 * Provides a stateful, user-friendly interface for managing agent registration,
 * updates, and deregistration in the AgenC protocol.
 *
 * @module
 */

import { Connection, PublicKey, TransactionSignature } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { PROGRAM_ID } from '@agenc/sdk';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import {
  AgentState,
  AgentStatus,
  AgentRegistrationParams,
  AgentUpdateParams,
  RateLimitState,
  parseAgentState,
  computeRateLimitState,
  AGENT_ID_LENGTH,
  MAX_ENDPOINT_LENGTH,
  MAX_METADATA_URI_LENGTH,
  isValidAgentStatus,
} from './types.js';
import {
  deriveAgentPda,
  findAgentPda,
  findProtocolPda,
} from './pda.js';
import {
  subscribeToAllAgentEvents,
  type EventSubscription,
  type AgentEventCallbacks,
} from './events.js';
import { ProtocolConfig, parseProtocolConfig } from '../types/protocol.js';
import type { Wallet } from '../types/wallet.js';
import {
  AgentNotRegisteredError,
  AgentAlreadyRegisteredError,
  ValidationError,
  InsufficientStakeError,
  ActiveTasksError,
  PendingDisputeVotesError,
  RecentVoteActivityError,
} from '../types/errors.js';
import { createProgram, createReadOnlyProgram } from '../idl.js';
import { Logger, silentLogger } from '../utils/logger.js';
import { agentIdToShortString } from '../utils/encoding.js';

/**
 * Configuration for AgentManager
 */
export interface AgentManagerConfig {
  /** Solana RPC connection */
  connection: Connection;
  /** Wallet for signing transactions */
  wallet: Wallet;
  /** Custom program ID (defaults to PROGRAM_ID from SDK) */
  programId?: PublicKey;
  /** Logger instance (defaults to silent logger) */
  logger?: Logger;
}

/**
 * 24 hours in seconds (for dispute vote cooldown check)
 */
const VOTE_COOLDOWN_SECONDS = 86400;

/**
 * High-level agent lifecycle manager.
 *
 * AgentManager provides a stateful interface for managing an agent's lifecycle
 * in the AgenC protocol. It caches state locally and provides convenient methods
 * for common operations.
 *
 * @example
 * ```typescript
 * import { Connection, Keypair } from '@solana/web3.js';
 * import { AgentManager, keypairToWallet, generateAgentId } from '@agenc/runtime';
 *
 * const connection = new Connection('https://api.devnet.solana.com');
 * const wallet = keypairToWallet(Keypair.generate());
 *
 * const manager = new AgentManager({ connection, wallet });
 *
 * // Register a new agent
 * const agentId = generateAgentId();
 * const state = await manager.register({
 *   agentId,
 *   capabilities: AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE,
 *   endpoint: 'https://my-agent.example.com',
 *   stakeAmount: 1_000_000_000n, // 1 SOL
 * });
 *
 * // Update agent status
 * await manager.updateStatus(AgentStatus.Active);
 *
 * // Later: deregister
 * await manager.deregister();
 * ```
 */
export class AgentManager {
  private readonly connection: Connection;
  private readonly wallet: Wallet;
  private readonly programId: PublicKey;
  private readonly logger: Logger;
  private readonly program: Program<AgencCoordination>;

  // Cached state
  private cachedState: AgentState | null = null;
  private agentPda: PublicKey | null = null;
  private agentId: Uint8Array | null = null;

  // Active event subscriptions
  private eventSubscription: EventSubscription | null = null;

  constructor(config: AgentManagerConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.programId = config.programId ?? PROGRAM_ID;
    this.logger = config.logger ?? silentLogger;

    // Create Anchor provider and program
    const provider = new AnchorProvider(
      this.connection,
      this.wallet,
      { commitment: 'confirmed' }
    );
    this.program = createProgram(provider, this.programId);
  }

  // ==========================================================================
  // Lifecycle Methods
  // ==========================================================================

  /**
   * Register a new agent in the protocol.
   *
   * @param params - Registration parameters
   * @returns The newly created agent state
   * @throws AgentAlreadyRegisteredError if agent with this ID already exists
   * @throws ValidationError if parameters are invalid
   * @throws InsufficientStakeError if stake amount is below minimum
   *
   * @example
   * ```typescript
   * const state = await manager.register({
   *   agentId: generateAgentId(),
   *   capabilities: AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE,
   *   endpoint: 'https://my-agent.example.com',
   *   stakeAmount: 1_000_000_000n,
   * });
   * ```
   */
  async register(params: AgentRegistrationParams): Promise<AgentState> {
    // Validate input
    this.validateRegistrationParams(params);

    // Check if agent already exists
    const { address: agentPda } = deriveAgentPda(params.agentId, this.programId);
    const existing = await this.fetchAgentAccount(agentPda);
    if (existing !== null) {
      throw new AgentAlreadyRegisteredError(agentIdToShortString(params.agentId));
    }

    // Get protocol config to validate stake
    const protocolPda = findProtocolPda(this.programId);
    const protocolConfig = await this.getProtocolConfig();

    if (params.stakeAmount < protocolConfig.minAgentStake) {
      throw new InsufficientStakeError(
        protocolConfig.minAgentStake,
        params.stakeAmount
      );
    }

    this.logger.info(
      `Registering agent ${agentIdToShortString(params.agentId)} with capabilities ${params.capabilities}`
    );

    // Build and send transaction
    await this.program.methods
      .registerAgent(
        Array.from(params.agentId),
        new BN(params.capabilities.toString()),
        params.endpoint,
        params.metadataUri ?? null,
        new BN(params.stakeAmount.toString())
      )
      .accountsPartial({
        agent: agentPda,
        protocolConfig: protocolPda,
        authority: this.wallet.publicKey,
      })
      .rpc();

    // Update cached state (clone agentId to prevent external mutation)
    this.agentId = new Uint8Array(params.agentId);
    this.agentPda = agentPda;
    this.cachedState = await this.fetchAndCacheState();

    this.logger.info(`Agent registered successfully: ${agentPda.toBase58()}`);

    return this.cachedState;
  }

  /**
   * Load an existing agent by its ID.
   *
   * This method fetches the agent state from the chain and caches it locally.
   * Use this when working with an agent that was registered in a previous session.
   *
   * @param agentId - The 32-byte agent identifier
   * @returns The loaded agent state
   * @throws AgentNotRegisteredError if agent doesn't exist
   * @throws ValidationError if agentId is invalid
   *
   * @example
   * ```typescript
   * const state = await manager.load(existingAgentId);
   * console.log(`Loaded agent with status: ${agentStatusToString(state.status)}`);
   * ```
   */
  async load(agentId: Uint8Array): Promise<AgentState> {
    if (agentId.length !== AGENT_ID_LENGTH) {
      throw new ValidationError(
        `Invalid agentId length: ${agentId.length} (must be ${AGENT_ID_LENGTH})`
      );
    }

    const agentPda = findAgentPda(agentId, this.programId);
    const state = await this.fetchAgentAccount(agentPda);

    if (state === null) {
      throw new AgentNotRegisteredError();
    }

    // Update cached state (clone agentId to prevent external mutation)
    this.agentId = new Uint8Array(agentId);
    this.agentPda = agentPda;
    this.cachedState = state;

    this.logger.info(`Loaded agent ${agentIdToShortString(agentId)}`);

    return state;
  }

  /**
   * Deregister the agent from the protocol.
   *
   * Requires:
   * - No active tasks
   * - No pending dispute votes
   * - At least 24 hours since last dispute vote
   *
   * @returns Transaction signature
   * @throws AgentNotRegisteredError if not registered
   * @throws ActiveTasksError if agent has active tasks
   * @throws PendingDisputeVotesError if agent has pending dispute votes
   * @throws RecentVoteActivityError if voted within last 24 hours
   *
   * @example
   * ```typescript
   * await manager.deregister();
   * console.log('Agent deregistered successfully');
   * ```
   */
  async deregister(): Promise<TransactionSignature> {
    this.requireRegistered();

    // Refresh state to check preconditions
    const state = await this.getState();
    const nowUnix = Math.floor(Date.now() / 1000);

    // Check preconditions
    if (state.activeTasks > 0) {
      throw new ActiveTasksError(state.activeTasks);
    }

    if (state.activeDisputeVotes > 0) {
      throw new PendingDisputeVotesError(state.activeDisputeVotes);
    }

    // Check 24h vote cooldown
    if (state.lastVoteTimestamp > 0) {
      const timeSinceLastVote = nowUnix - state.lastVoteTimestamp;
      if (timeSinceLastVote < VOTE_COOLDOWN_SECONDS) {
        throw new RecentVoteActivityError(new Date(state.lastVoteTimestamp * 1000));
      }
    }

    const protocolPda = findProtocolPda(this.programId);

    this.logger.info(`Deregistering agent ${agentIdToShortString(this.agentId!)}`);

    const signature = await this.program.methods
      .deregisterAgent()
      .accountsPartial({
        agent: this.agentPda!,
        protocolConfig: protocolPda,
        authority: this.wallet.publicKey,
      })
      .rpc();

    // Clear cached state
    this.cachedState = null;
    this.agentPda = null;
    this.agentId = null;

    // Unsubscribe from events
    await this.unsubscribeAll();

    this.logger.info('Agent deregistered successfully');

    return signature;
  }

  // ==========================================================================
  // Update Methods
  // ==========================================================================

  /**
   * Update agent registration with new values.
   *
   * All fields are optional - only provided fields will be updated.
   *
   * @param params - Update parameters
   * @returns Updated agent state
   * @throws AgentNotRegisteredError if not registered
   * @throws ValidationError if parameters are invalid
   *
   * @example
   * ```typescript
   * await manager.update({
   *   capabilities: AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE | AgentCapabilities.STORAGE,
   *   endpoint: 'https://new-endpoint.example.com',
   * });
   * ```
   */
  async update(params: AgentUpdateParams): Promise<AgentState> {
    this.requireRegistered();
    this.validateUpdateParams(params);

    // Prepare update values (null means "keep current value" in the instruction)
    const capabilities = params.capabilities !== undefined
      ? new BN(params.capabilities.toString())
      : null;
    const endpoint = params.endpoint ?? null;
    const metadataUri = params.metadataUri ?? null;
    const status = params.status ?? null;

    // Build remaining accounts for Suspended status
    const remainingAccounts: Array<{
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }> = [];

    if (params.status === AgentStatus.Suspended) {
      // Suspended status requires protocol account in remaining_accounts
      const protocolPda = findProtocolPda(this.programId);
      remainingAccounts.push({
        pubkey: protocolPda,
        isSigner: false,
        isWritable: false,
      });
    }

    this.logger.debug(`Updating agent: capabilities=${capabilities}, status=${status}`);

    await this.program.methods
      .updateAgent(
        capabilities,
        endpoint,
        metadataUri,
        status
      )
      .accountsPartial({
        agent: this.agentPda!,
        authority: this.wallet.publicKey,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    // Refresh cached state
    this.cachedState = await this.fetchAndCacheState();

    return this.cachedState;
  }

  /**
   * Update agent status only.
   *
   * @param status - New agent status
   * @returns Updated agent state
   *
   * @example
   * ```typescript
   * await manager.updateStatus(AgentStatus.Busy);
   * ```
   */
  async updateStatus(status: AgentStatus): Promise<AgentState> {
    if (!isValidAgentStatus(status)) {
      throw new ValidationError(`Invalid agent status: ${status}`);
    }
    return this.update({ status });
  }

  /**
   * Update agent capabilities only.
   *
   * @param capabilities - New capability bitmask
   * @returns Updated agent state
   *
   * @example
   * ```typescript
   * await manager.updateCapabilities(AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE);
   * ```
   */
  async updateCapabilities(capabilities: bigint): Promise<AgentState> {
    if (capabilities < 0n) {
      throw new ValidationError('Capabilities must be non-negative');
    }
    return this.update({ capabilities });
  }

  /**
   * Update agent endpoint only.
   *
   * @param endpoint - New endpoint URL
   * @returns Updated agent state
   *
   * @example
   * ```typescript
   * await manager.updateEndpoint('https://new-endpoint.example.com');
   * ```
   */
  async updateEndpoint(endpoint: string): Promise<AgentState> {
    if (endpoint.length > MAX_ENDPOINT_LENGTH) {
      throw new ValidationError(
        `Endpoint too long: ${endpoint.length} (max ${MAX_ENDPOINT_LENGTH})`
      );
    }
    return this.update({ endpoint });
  }

  /**
   * Update agent metadata URI only.
   *
   * @param metadataUri - New metadata URI
   * @returns Updated agent state
   *
   * @example
   * ```typescript
   * await manager.updateMetadataUri('https://metadata.example.com/agent.json');
   * ```
   */
  async updateMetadataUri(metadataUri: string): Promise<AgentState> {
    if (metadataUri.length > MAX_METADATA_URI_LENGTH) {
      throw new ValidationError(
        `Metadata URI too long: ${metadataUri.length} (max ${MAX_METADATA_URI_LENGTH})`
      );
    }
    return this.update({ metadataUri });
  }

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  /**
   * Get current agent state from chain.
   *
   * Always fetches fresh state from the blockchain.
   *
   * @returns Current agent state
   * @throws AgentNotRegisteredError if not registered
   *
   * @example
   * ```typescript
   * const state = await manager.getState();
   * console.log(`Active tasks: ${state.activeTasks}`);
   * ```
   */
  async getState(): Promise<AgentState> {
    this.requireRegistered();
    this.cachedState = await this.fetchAndCacheState();
    return this.cachedState;
  }

  /**
   * Get locally cached agent state.
   *
   * Returns null if no agent is loaded. Use getState() for fresh data.
   *
   * @returns Cached state or null
   *
   * @example
   * ```typescript
   * const cached = manager.getCachedState();
   * if (cached) {
   *   console.log(`Cached status: ${agentStatusToString(cached.status)}`);
   * }
   * ```
   */
  getCachedState(): AgentState | null {
    return this.cachedState;
  }

  /**
   * Get the agent PDA address.
   *
   * @returns Agent PDA or null if not registered
   */
  getAgentPda(): PublicKey | null {
    return this.agentPda;
  }

  /**
   * Get the agent ID.
   *
   * @returns Agent ID or null if not registered
   */
  getAgentId(): Uint8Array | null {
    return this.agentId;
  }

  /**
   * Check if an agent is currently registered (loaded or registered via this manager).
   *
   * @returns True if agent is registered
   */
  isRegistered(): boolean {
    return this.agentPda !== null && this.agentId !== null;
  }

  /**
   * Get current reputation score (0-10000, representing 0.00% - 100.00%).
   *
   * @returns Reputation score
   * @throws AgentNotRegisteredError if not registered
   */
  async getReputation(): Promise<number> {
    const state = await this.getState();
    return state.reputation;
  }

  /**
   * Get computed rate limit state.
   *
   * @returns Rate limit state including cooldowns and remaining counts
   * @throws AgentNotRegisteredError if not registered
   *
   * @example
   * ```typescript
   * const rateLimits = await manager.getRateLimitState();
   * if (!rateLimits.canCreateTask) {
   *   console.log(`Must wait until ${new Date(rateLimits.taskCooldownEnds * 1000)}`);
   * }
   * ```
   */
  async getRateLimitState(): Promise<RateLimitState> {
    this.requireRegistered();

    const [state, config] = await Promise.all([
      this.getState(),
      this.getProtocolConfig(),
    ]);

    const nowUnix = Math.floor(Date.now() / 1000);

    return computeRateLimitState(state, {
      taskCreationCooldown: config.taskCreationCooldown,
      maxTasksPer24h: config.maxTasksPer24h,
      disputeInitiationCooldown: config.disputeInitiationCooldown,
      maxDisputesPer24h: config.maxDisputesPer24h,
    }, nowUnix);
  }

  /**
   * Get protocol configuration.
   *
   * @returns Protocol config
   */
  async getProtocolConfig(): Promise<ProtocolConfig> {
    const protocolPda = findProtocolPda(this.programId);
    const rawData = await this.program.account.protocolConfig.fetch(protocolPda);
    return parseProtocolConfig(rawData);
  }

  // ==========================================================================
  // Event Subscription Methods
  // ==========================================================================

  /**
   * Subscribe to agent-related events.
   *
   * Events are automatically filtered to this agent's ID if registered.
   *
   * @param callbacks - Event callback functions
   * @returns Subscription handle
   *
   * @example
   * ```typescript
   * const subscription = manager.subscribeToEvents({
   *   onUpdated: (event) => console.log('Agent updated:', event.status),
   * });
   *
   * // Later: unsubscribe
   * await subscription.unsubscribe();
   * ```
   */
  subscribeToEvents(callbacks: AgentEventCallbacks): EventSubscription {
    // Clean up previous subscription to prevent leaks
    if (this.eventSubscription) {
      // Fire-and-forget: we don't need to wait for cleanup to complete
      void this.eventSubscription.unsubscribe();
      this.eventSubscription = null;
    }

    // Filter by this agent's ID if registered
    const options = this.agentId ? { agentId: this.agentId } : undefined;

    this.eventSubscription = subscribeToAllAgentEvents(
      this.program,
      callbacks,
      options
    );

    return this.eventSubscription;
  }

  /**
   * Unsubscribe from all events.
   */
  async unsubscribeAll(): Promise<void> {
    if (this.eventSubscription) {
      await this.eventSubscription.unsubscribe();
      this.eventSubscription = null;
    }
  }

  // ==========================================================================
  // Static Methods
  // ==========================================================================

  /**
   * Fetch agent state by agent ID (static, no wallet required).
   *
   * @param connection - Solana RPC connection
   * @param agentId - The 32-byte agent identifier
   * @param programId - Optional custom program ID
   * @returns Agent state or null if not found
   *
   * @example
   * ```typescript
   * const state = await AgentManager.fetchAgent(connection, agentId);
   * if (state) {
   *   console.log(`Agent status: ${agentStatusToString(state.status)}`);
   * }
   * ```
   */
  static async fetchAgent(
    connection: Connection,
    agentId: Uint8Array,
    programId: PublicKey = PROGRAM_ID
  ): Promise<AgentState | null> {
    if (agentId.length !== AGENT_ID_LENGTH) {
      throw new ValidationError(
        `Invalid agentId length: ${agentId.length} (must be ${AGENT_ID_LENGTH})`
      );
    }

    const agentPda = findAgentPda(agentId, programId);
    return AgentManager.fetchAgentByPda(connection, agentPda, programId);
  }

  /**
   * Fetch agent state by PDA address (static, no wallet required).
   *
   * @param connection - Solana RPC connection
   * @param agentPda - The agent PDA address
   * @param programId - Optional custom program ID
   * @returns Agent state or null if not found
   */
  static async fetchAgentByPda(
    connection: Connection,
    agentPda: PublicKey,
    programId: PublicKey = PROGRAM_ID
  ): Promise<AgentState | null> {
    const program = createReadOnlyProgram(connection, programId);

    try {
      const rawData = await program.account.agentRegistration.fetch(agentPda);
      return parseAgentState(rawData);
    } catch (err) {
      // Check if account doesn't exist
      if (
        err instanceof Error &&
        (err.message.includes('Account does not exist') ||
          err.message.includes('could not find'))
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Check if an agent exists (static, no wallet required).
   *
   * @param connection - Solana RPC connection
   * @param agentId - The 32-byte agent identifier
   * @param programId - Optional custom program ID
   * @returns True if agent exists
   *
   * @example
   * ```typescript
   * const exists = await AgentManager.agentExists(connection, agentId);
   * if (!exists) {
   *   console.log('Agent not registered');
   * }
   * ```
   */
  static async agentExists(
    connection: Connection,
    agentId: Uint8Array,
    programId: PublicKey = PROGRAM_ID
  ): Promise<boolean> {
    const state = await AgentManager.fetchAgent(connection, agentId, programId);
    return state !== null;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Require that an agent is registered (loaded or registered).
   * @throws AgentNotRegisteredError if not registered
   */
  private requireRegistered(): void {
    if (!this.isRegistered()) {
      throw new AgentNotRegisteredError();
    }
  }

  /**
   * Validate registration parameters.
   */
  private validateRegistrationParams(params: AgentRegistrationParams): void {
    if (params.agentId.length !== AGENT_ID_LENGTH) {
      throw new ValidationError(
        `Invalid agentId length: ${params.agentId.length} (must be ${AGENT_ID_LENGTH})`
      );
    }

    if (params.capabilities < 0n) {
      throw new ValidationError('Capabilities must be non-negative');
    }

    if (params.endpoint.length > MAX_ENDPOINT_LENGTH) {
      throw new ValidationError(
        `Endpoint too long: ${params.endpoint.length} (max ${MAX_ENDPOINT_LENGTH})`
      );
    }

    if (params.metadataUri && params.metadataUri.length > MAX_METADATA_URI_LENGTH) {
      throw new ValidationError(
        `Metadata URI too long: ${params.metadataUri.length} (max ${MAX_METADATA_URI_LENGTH})`
      );
    }

    if (params.stakeAmount < 0n) {
      throw new ValidationError('Stake amount must be non-negative');
    }
  }

  /**
   * Validate update parameters.
   */
  private validateUpdateParams(params: AgentUpdateParams): void {
    if (params.capabilities !== undefined && params.capabilities < 0n) {
      throw new ValidationError('Capabilities must be non-negative');
    }

    if (params.endpoint !== undefined && params.endpoint.length > MAX_ENDPOINT_LENGTH) {
      throw new ValidationError(
        `Endpoint too long: ${params.endpoint.length} (max ${MAX_ENDPOINT_LENGTH})`
      );
    }

    if (params.metadataUri !== undefined && params.metadataUri.length > MAX_METADATA_URI_LENGTH) {
      throw new ValidationError(
        `Metadata URI too long: ${params.metadataUri.length} (max ${MAX_METADATA_URI_LENGTH})`
      );
    }

    if (params.status !== undefined && !isValidAgentStatus(params.status)) {
      throw new ValidationError(`Invalid agent status: ${params.status}`);
    }
  }

  /**
   * Fetch agent account, returning null if not found.
   */
  private async fetchAgentAccount(agentPda: PublicKey): Promise<AgentState | null> {
    try {
      const rawData = await this.program.account.agentRegistration.fetch(agentPda);
      return parseAgentState(rawData);
    } catch (err) {
      // Check if account doesn't exist
      if (
        err instanceof Error &&
        (err.message.includes('Account does not exist') ||
          err.message.includes('could not find'))
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Fetch and cache current state.
   */
  private async fetchAndCacheState(): Promise<AgentState> {
    const rawData = await this.program.account.agentRegistration.fetch(this.agentPda!);
    return parseAgentState(rawData);
  }
}
