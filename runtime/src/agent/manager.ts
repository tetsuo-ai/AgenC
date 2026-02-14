/**
 * AgentManager - High-level agent lifecycle management
 *
 * Provides a stateful, user-friendly interface for managing agent registration,
 * updates, and deregistration in the AgenC protocol.
 *
 * @module
 */

import { Connection, PublicKey, TransactionSignature } from '@solana/web3.js';
import anchor, { Program, AnchorProvider } from '@coral-xyz/anchor';
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
 * Options for protocol config cache behavior.
 *
 * The cache provides automatic TTL-based expiration, promise deduplication
 * to prevent thundering herd, and optional stale-while-revalidate semantics.
 */
export interface ProtocolConfigCacheOptions {
  /**
   * Time-to-live in milliseconds.
   * After this duration, cached data is considered stale and will be refreshed
   * on the next access.
   *
   * - Set to 0 to disable caching (always fetch fresh)
   * - Set to Infinity to cache indefinitely (manual invalidation only)
   *
   * @default 300000 (5 minutes)
   */
  ttlMs?: number;

  /**
   * If true, returns stale cached data when a fetch fails, rather than
   * propagating the error. This provides resilience against temporary
   * RPC failures at the cost of potentially stale data.
   *
   * Only applies when stale data exists in the cache. If no cached data
   * exists, errors are always propagated.
   *
   * Note: This takes precedence even when `forceRefresh: true` is used.
   * If you need guaranteed fresh data or failure, set this to false.
   *
   * @default false
   */
  returnStaleOnError?: boolean;
}

/**
 * Options for getProtocolConfig method.
 */
export interface GetProtocolConfigOptions {
  /**
   * If true, bypasses cached data and ensures a fetch from chain.
   * The fetched data will still be cached for subsequent calls.
   *
   * Note: If a fetch is already in progress (from another concurrent call),
   * this will await that fetch rather than starting a redundant one.
   * The result will still be fresh data, just potentially shared with
   * other callers.
   *
   * @default false
   */
  forceRefresh?: boolean;
}

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
  /**
   * Protocol config cache options.
   * If not provided, uses default TTL of 5 minutes with no stale fallback.
   */
  protocolConfigCache?: ProtocolConfigCacheOptions;
  /** Pre-built Program instance (for testing with LiteSVM). If provided, skips internal provider creation. */
  program?: Program<AgencCoordination>;
}

/**
 * Internal structure for cached protocol config with metadata.
 * @internal
 */
interface CachedProtocolConfig {
  /** The cached protocol configuration */
  value: ProtocolConfig;
  /** Unix timestamp (ms) when the value was fetched */
  fetchedAt: number;
}

/** Default cache TTL: 5 minutes */
const DEFAULT_PROTOCOL_CONFIG_TTL_MS = 5 * 60 * 1000;

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

  // Cached agent state
  private cachedState: AgentState | null = null;
  private agentPda: PublicKey | null = null;
  private agentId: Uint8Array | null = null;

  // Active event subscriptions
  private eventSubscription: EventSubscription | null = null;

  // Protocol config cache
  private readonly protocolConfigTtlMs: number;
  private readonly protocolConfigReturnStaleOnError: boolean;
  private protocolConfigCache: CachedProtocolConfig | null = null;
  /**
   * In-flight fetch promise for protocol config.
   * Used to deduplicate concurrent requests (thundering herd prevention).
   * When multiple callers request the config simultaneously during a cache miss,
   * they all await the same promise rather than triggering redundant RPC calls.
   */
  private protocolConfigFetchPromise: Promise<ProtocolConfig> | null = null;
  /**
   * Generation counter for cache invalidation.
   * Incremented on each invalidation. Fetches capture the generation at start
   * and only update the cache if the generation hasn't changed, preventing
   * stale data from an in-flight fetch from overwriting a post-invalidation state.
   */
  private protocolConfigCacheGeneration = 0;

  constructor(config: AgentManagerConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.programId = config.programId ?? PROGRAM_ID;
    this.logger = config.logger ?? silentLogger;

    // Initialize protocol config cache settings
    const cacheOptions = config.protocolConfigCache ?? {};
    this.protocolConfigTtlMs = cacheOptions.ttlMs ?? DEFAULT_PROTOCOL_CONFIG_TTL_MS;
    this.protocolConfigReturnStaleOnError = cacheOptions.returnStaleOnError ?? false;

    // Validate cache TTL (must be non-negative number, not NaN)
    if (this.protocolConfigTtlMs < 0 || Number.isNaN(this.protocolConfigTtlMs)) {
      throw new ValidationError(
        `Protocol config cache TTL must be a non-negative number, got: ${this.protocolConfigTtlMs}`
      );
    }

    // Use injected program or create Anchor provider and program
    if (config.program) {
      this.program = config.program;
    } else {
      const provider = new AnchorProvider(
        this.connection,
        this.wallet,
        { commitment: 'confirmed' }
      );
      this.program = createProgram(provider, this.programId);
    }
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
        new anchor.BN(params.capabilities.toString()),
        params.endpoint,
        params.metadataUri ?? null,
        new anchor.BN(params.stakeAmount.toString())
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
      ? new anchor.BN(params.capabilities.toString())
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
   * Get the underlying Anchor program instance.
   * Useful for creating event monitors and performing advanced operations.
   */
  getProgram(): Program<AgencCoordination> {
    return this.program;
  }

  /**
   * Get the Solana RPC connection used by this manager.
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get the program ID used by this manager.
   */
  getProgramId(): PublicKey {
    return this.programId;
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
   * Get protocol configuration with intelligent caching.
   *
   * This method implements a robust caching strategy:
   * - **TTL-based expiration**: Cached data expires after the configured TTL
   * - **Promise deduplication**: Concurrent calls share a single RPC request
   * - **Error isolation**: Failed fetches don't poison the cache
   * - **Stale fallback** (optional): Returns stale data if fetch fails
   *
   * @param options - Optional configuration for this specific call
   * @param options.forceRefresh - Bypass cache and fetch fresh data
   * @returns Protocol configuration (do not mutate - shared with cache)
   *
   * @example
   * ```typescript
   * // Normal usage (uses cache)
   * const config = await manager.getProtocolConfig();
   *
   * // Force fresh data after protocol update
   * const freshConfig = await manager.getProtocolConfig({ forceRefresh: true });
   * ```
   */
  async getProtocolConfig(options?: GetProtocolConfigOptions): Promise<ProtocolConfig> {
    const forceRefresh = options?.forceRefresh ?? false;

    // Fast path: return cached value if fresh and not forcing refresh
    if (!forceRefresh) {
      const cached = this.getCachedProtocolConfigIfFresh();
      if (cached !== null) {
        this.logger.debug('Returning cached protocol config');
        return cached;
      }
    }

    // Deduplicate concurrent requests: if a fetch is already in progress,
    // piggyback on it rather than starting a new one.
    // All callers await the same promise and get the same result/error handling.
    if (this.protocolConfigFetchPromise !== null) {
      this.logger.debug('Waiting for in-flight protocol config fetch');
      return this.protocolConfigFetchPromise;
    }

    // Start a new fetch with error handling baked into the promise.
    // This ensures ALL callers (including piggybacking ones) get the same
    // stale-fallback behavior, not just the initiating caller.
    this.logger.debug('Fetching protocol config from chain');

    // Create the promise chain and capture the reference so we can
    // conditionally clear it in finally (avoiding clobbering a newer fetch)
    const fetchPromise = this.fetchAndCacheProtocolConfig()
      .catch((error) => {
        // If configured and we have stale data, return it instead of throwing
        if (this.protocolConfigReturnStaleOnError && this.protocolConfigCache !== null) {
          this.logger.warn(
            'Protocol config fetch failed, returning stale cached data',
            error instanceof Error ? error.message : String(error)
          );
          return this.protocolConfigCache.value;
        }
        throw error;
      })
      .finally(() => {
        // Only clear the promise if it's still this fetch's promise.
        // If invalidation occurred and a new fetch started, don't clobber it.
        if (this.protocolConfigFetchPromise === fetchPromise) {
          this.protocolConfigFetchPromise = null;
        }
      });

    this.protocolConfigFetchPromise = fetchPromise;
    return fetchPromise;
  }

  /**
   * Invalidate the protocol config cache.
   *
   * Call this when you know the protocol config has changed on-chain
   * (e.g., after observing a ProtocolUpdated event) to ensure the next
   * call to getProtocolConfig() fetches fresh data.
   *
   * This method:
   * - Clears the cached value
   * - Increments the cache generation (prevents in-flight fetches from caching stale data)
   * - Clears any in-flight fetch promise (new callers will start a fresh fetch)
   *
   * Callers who already received the in-flight promise will still get their result,
   * but the data won't be cached due to the generation mismatch.
   *
   * @example
   * ```typescript
   * // After protocol update event
   * manager.invalidateProtocolConfigCache();
   * const freshConfig = await manager.getProtocolConfig(); // Guaranteed fresh fetch
   * ```
   */
  invalidateProtocolConfigCache(): void {
    this.protocolConfigCache = null;
    this.protocolConfigCacheGeneration++;
    // Also clear the in-flight promise so new callers start a fresh fetch.
    // Existing callers who already have the promise reference will still
    // receive their result, but the data won't be cached (generation mismatch).
    this.protocolConfigFetchPromise = null;
    this.logger.debug('Protocol config cache invalidated');
  }

  /**
   * Get the cached protocol config without fetching.
   *
   * Returns the cached value regardless of whether it's stale, or null if
   * nothing is cached. Useful for synchronous access when you've previously
   * populated the cache and want to avoid async operations.
   *
   * To check freshness, use isProtocolConfigCacheFresh().
   *
   * **Important**: Do not mutate the returned object as it's shared with
   * the internal cache. Mutations would corrupt cached data.
   *
   * @returns Cached protocol config or null if not cached
   *
   * @example
   * ```typescript
   * // Pre-populate cache
   * await manager.getProtocolConfig();
   *
   * // Later, synchronous access
   * const cached = manager.getCachedProtocolConfig();
   * if (cached) {
   *   console.log(`Min stake: ${cached.minAgentStake}`);
   * }
   * ```
   */
  getCachedProtocolConfig(): ProtocolConfig | null {
    return this.protocolConfigCache?.value ?? null;
  }

  /**
   * Check if the protocol config cache contains fresh (non-stale) data.
   *
   * @returns True if cache exists and is within TTL
   *
   * @example
   * ```typescript
   * if (manager.isProtocolConfigCacheFresh()) {
   *   // Safe to use getCachedProtocolConfig() synchronously
   *   const config = manager.getCachedProtocolConfig()!;
   * } else {
   *   // Need to fetch
   *   const config = await manager.getProtocolConfig();
   * }
   * ```
   */
  isProtocolConfigCacheFresh(): boolean {
    return this.getCachedProtocolConfigIfFresh() !== null;
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

  // ==========================================================================
  // Private Helpers - Protocol Config Cache
  // ==========================================================================

  /**
   * Get cached protocol config if it exists and is still fresh (within TTL).
   *
   * @returns Cached protocol config or null if missing/stale
   */
  private getCachedProtocolConfigIfFresh(): ProtocolConfig | null {
    if (this.protocolConfigCache === null) {
      return null;
    }

    // TTL of 0 means caching is disabled
    if (this.protocolConfigTtlMs === 0) {
      return null;
    }

    // Check if cache has expired
    const age = Date.now() - this.protocolConfigCache.fetchedAt;
    if (age >= this.protocolConfigTtlMs) {
      this.logger.debug(
        `Protocol config cache stale (age: ${age}ms, ttl: ${this.protocolConfigTtlMs}ms)`
      );
      return null;
    }

    return this.protocolConfigCache.value;
  }

  /**
   * Fetch protocol config from chain and update the cache.
   *
   * This is the core fetch operation. It does NOT handle promise deduplication
   * or error fallback - that logic is in getProtocolConfig().
   *
   * Uses a generation counter to prevent stale data from an in-flight fetch
   * from overwriting a post-invalidation cache state.
   *
   * @returns Fetched protocol config (always returned, but may not be cached)
   */
  private async fetchAndCacheProtocolConfig(): Promise<ProtocolConfig> {
    // Capture generation at start of fetch
    const startGeneration = this.protocolConfigCacheGeneration;

    const protocolPda = findProtocolPda(this.programId);
    const rawData = await this.program.account.protocolConfig.fetch(protocolPda);
    const config = parseProtocolConfig(rawData);

    // Only update cache if generation hasn't changed (no invalidation during fetch)
    if (this.protocolConfigCacheGeneration === startGeneration) {
      this.protocolConfigCache = {
        value: config,
        fetchedAt: Date.now(),
      };
      this.logger.debug('Protocol config fetched and cached');
    } else {
      this.logger.debug(
        'Protocol config fetched but cache was invalidated during fetch, not caching'
      );
    }

    return config;
  }
}
