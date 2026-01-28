/**
 * @agenc/runtime - Agent runtime infrastructure for AgenC
 *
 * This is the main entry point for the @agenc/runtime package.
 * It re-exports all public APIs including agent management, types,
 * utilities, and key constants from @agenc/sdk.
 *
 * @packageDocumentation
 */

// Re-export SDK constants for convenience
export {
  PROGRAM_ID,
  PRIVACY_CASH_PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  SEEDS,
  HASH_SIZE,
  RESULT_DATA_SIZE,
  U64_SIZE,
  DISCRIMINATOR_SIZE,
  OUTPUT_FIELD_COUNT,
  PROOF_SIZE_BYTES,
  VERIFICATION_COMPUTE_UNITS,
  PUBLIC_INPUTS_COUNT,
  PERCENT_BASE,
  DEFAULT_FEE_PERCENT,
  TaskState,
  TaskStatus,
} from '@agenc/sdk';

// IDL and program creation
export {
  IDL,
  type AgencCoordination,
  createProgram,
  createReadOnlyProgram,
} from './idl.js';

export const VERSION = '0.1.0';

// Runtime class
export { AgentRuntime } from './runtime.js';

// Types (protocol, errors, wallet, config) — all via types barrel
export {
  // Protocol types
  ProtocolConfig,
  parseProtocolConfig,
  MAX_MULTISIG_OWNERS,
  // Error constants
  RuntimeErrorCodes,
  AnchorErrorCodes,
  // Error types
  type RuntimeErrorCode,
  type AnchorErrorCode,
  type AnchorErrorName,
  type ParsedAnchorError,
  // Error classes
  RuntimeError,
  AgentNotRegisteredError,
  AgentAlreadyRegisteredError,
  ValidationError,
  RateLimitError,
  InsufficientStakeError,
  ActiveTasksError,
  PendingDisputeVotesError,
  RecentVoteActivityError,
  TaskNotFoundError,
  TaskNotClaimableError,
  TaskExecutionError,
  TaskSubmissionError,
  ExecutorStateError,
  // Error helper functions
  isAnchorError,
  parseAnchorError,
  getAnchorErrorName,
  getAnchorErrorMessage,
  isRuntimeError,
  // Agent constants
  AgentCapabilities,
  AGENT_REGISTRATION_SIZE,
  AGENT_ID_LENGTH,
  MAX_ENDPOINT_LENGTH,
  MAX_METADATA_URI_LENGTH,
  MAX_REPUTATION,
  MAX_U8,
  CAPABILITY_NAMES,
  // Agent enum
  AgentStatus,
  // Agent functions
  agentStatusToString,
  isValidAgentStatus,
  hasCapability,
  getCapabilityNames,
  createCapabilityMask,
  parseAgentState,
  computeRateLimitState,
  // PDA derivation helpers
  deriveAgentPda,
  deriveProtocolPda,
  findAgentPda,
  findProtocolPda,
  deriveAuthorityVotePda,
  findAuthorityVotePda,
  // Event subscriptions
  subscribeToAgentRegistered,
  subscribeToAgentUpdated,
  subscribeToAgentDeregistered,
  subscribeToAllAgentEvents,
  // AgentManager class
  AgentManager,
  // Agent types
  type AgentCapability,
  type CapabilityName,
  type AgentState,
  type AgentRegistrationParams,
  type AgentUpdateParams,
  type RateLimitState,
  type AgentRegisteredEvent,
  type AgentUpdatedEvent,
  type AgentDeregisteredEvent,
  // PDA types
  type PdaWithBump,
  // Event types
  type AgentEventCallback,
  type EventSubscription,
  type AgentEventCallbacks,
  type EventSubscriptionOptions,
  // AgentManager types
  type AgentManagerConfig,
  type ProtocolConfigCacheOptions,
  type GetProtocolConfigOptions,
  // Wallet types and helpers
  type Wallet,
  type SignMessageWallet,
  KeypairFileError,
  keypairToWallet,
  loadKeypairFromFile,
  loadKeypairFromFileSync,
  getDefaultKeypairPath,
  loadDefaultKeypair,
  // AgentRuntime types
  type AgentRuntimeConfig,
  isKeypair,
  // Task constants (Phase 3)
  TASK_ID_LENGTH,
  // Task enums
  OnChainTaskStatus,
  DiscoveryMode,
  OperatingMode,
  TaskExecutorStatus,
  // Task functions
  taskStatusToString,
  taskTypeToString,
  parseTaskStatus,
  parseTaskType,
  parseOnChainTask,
  parseOnChainTaskClaim,
  isPrivateTask,
  isTaskExpired,
  isTaskClaimable,
  isPrivateExecutionResult,
  // Task PDA derivation
  deriveTaskPda,
  findTaskPda,
  deriveClaimPda,
  findClaimPda,
  deriveEscrowPda,
  findEscrowPda,
  // Task types
  type OnChainTask,
  type OnChainTaskClaim,
  type RawOnChainTask,
  type RawOnChainTaskClaim,
  type TaskExecutionContext,
  type TaskExecutionResult,
  type PrivateTaskExecutionResult,
  type TaskHandler,
  type DiscoveredTask,
  type TaskFilterConfig,
  type TaskScorer,
  type TaskDiscoveryConfig,
  type TaskOperationsConfig,
  type ClaimResult,
  type CompleteResult,
  type TaskExecutorConfig,
  type TaskExecutorEvents,
} from './types/index.js';

// Logger utilities
export {
  Logger,
  LogLevel,
  createLogger,
  silentLogger,
} from './utils/index.js';

// Encoding utilities
export {
  generateAgentId,
  hexToBytes,
  bytesToHex,
  agentIdFromString,
  agentIdToString,
  agentIdToShortString,
  agentIdsEqual,
  lamportsToSol,
  solToLamports,
} from './utils/index.js';

// Event monitoring (Phase 2)
export {
  // Shared types
  type EventCallback,

  // Enums
  TaskType,
  ResolutionType,
  RateLimitActionType,
  RateLimitType,

  // Task events
  type TaskCreatedEvent,
  type TaskClaimedEvent,
  type TaskCompletedEvent,
  type TaskCancelledEvent,
  type TaskEventCallbacks,
  type TaskEventFilterOptions,
  subscribeToTaskCreated,
  subscribeToTaskClaimed,
  subscribeToTaskCompleted,
  subscribeToTaskCancelled,
  subscribeToAllTaskEvents,

  // Dispute events
  type DisputeInitiatedEvent,
  type DisputeVoteCastEvent,
  type DisputeResolvedEvent,
  type DisputeExpiredEvent,
  type DisputeEventCallbacks,
  type DisputeEventFilterOptions,
  subscribeToDisputeInitiated,
  subscribeToDisputeVoteCast,
  subscribeToDisputeResolved,
  subscribeToDisputeExpired,
  subscribeToAllDisputeEvents,

  // Protocol events
  type StateUpdatedEvent,
  type ProtocolInitializedEvent,
  type RewardDistributedEvent,
  type RateLimitHitEvent,
  type MigrationCompletedEvent,
  type ProtocolVersionUpdatedEvent,
  type ProtocolEventCallbacks,
  type ProtocolEventFilterOptions,
  subscribeToStateUpdated,
  subscribeToProtocolInitialized,
  subscribeToRewardDistributed,
  subscribeToRateLimitHit,
  subscribeToMigrationCompleted,
  subscribeToProtocolVersionUpdated,
  subscribeToAllProtocolEvents,

  // Parse functions
  parseTaskCreatedEvent,
  parseTaskClaimedEvent,
  parseTaskCompletedEvent,
  parseTaskCancelledEvent,
  parseDisputeInitiatedEvent,
  parseDisputeVoteCastEvent,
  parseDisputeResolvedEvent,
  parseDisputeExpiredEvent,
  parseStateUpdatedEvent,
  parseProtocolInitializedEvent,
  parseRewardDistributedEvent,
  parseRateLimitHitEvent,
  parseMigrationCompletedEvent,
  parseProtocolVersionUpdatedEvent,

  // EventMonitor
  EventMonitor,
  type EventMonitorConfig,
  type EventMonitorMetrics,
} from './events/index.js';
