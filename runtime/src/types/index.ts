/**
 * Type definitions for @agenc/runtime
 * @packageDocumentation
 */

// Protocol configuration types
export {
  ProtocolConfig,
  parseProtocolConfig,
  MAX_MULTISIG_OWNERS,
} from './protocol.js';

// Error types, constants, and helpers
export {
  // Constants
  RuntimeErrorCodes,
  AnchorErrorCodes,
  // Types
  RuntimeErrorCode,
  AnchorErrorCode,
  AnchorErrorName,
  ParsedAnchorError,
  // Base error class
  RuntimeError,
  // Specific error classes
  AgentNotRegisteredError,
  AgentAlreadyRegisteredError,
  ValidationError,
  RateLimitError,
  InsufficientStakeError,
  ActiveTasksError,
  PendingDisputeVotesError,
  RecentVoteActivityError,
  // Helper functions
  isAnchorError,
  parseAnchorError,
  getAnchorErrorName,
  getAnchorErrorMessage,
  isRuntimeError,
} from './errors.js';

// Agent types and utilities
export {
  // Constants
  AgentCapabilities,
  AGENT_REGISTRATION_SIZE,
  AGENT_ID_LENGTH,
  MAX_ENDPOINT_LENGTH,
  MAX_METADATA_URI_LENGTH,
  MAX_REPUTATION,
  MAX_U8,
  CAPABILITY_NAMES,
  // Enum
  AgentStatus,
  // Functions
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
  // Types
  type AgentCapability,
  type CapabilityName,
  type AgentState,
  type AgentRegistrationParams,
  type AgentUpdateParams,
  type RateLimitState,
  type AgentRegisteredEvent,
  type AgentUpdatedEvent,
  type AgentDeregisteredEvent,
  type PdaWithBump,
  type AgentEventCallback,
  type EventSubscription,
  type AgentEventCallbacks,
  type EventSubscriptionOptions,
  type AgentManagerConfig,
  type ProtocolConfigCacheOptions,
  type GetProtocolConfigOptions,
} from '../agent/index.js';

// Wallet types and helpers
export {
  type Wallet,
  type SignMessageWallet,
  KeypairFileError,
  keypairToWallet,
  loadKeypairFromFile,
  loadKeypairFromFileSync,
  getDefaultKeypairPath,
  loadDefaultKeypair,
} from './wallet.js';

// Runtime configuration types
export { type AgentRuntimeConfig, isKeypair } from './config.js';

// Task types and utilities (Phase 3)
export {
  // Constants
  TASK_ID_LENGTH,
  // Enums
  OnChainTaskStatus,
  DiscoveryMode,
  OperatingMode,
  TaskExecutorStatus,
  // Functions
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
  // PDA derivation
  deriveTaskPda,
  findTaskPda,
  deriveClaimPda,
  findClaimPda,
  deriveEscrowPda,
  findEscrowPda,
  // Types
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
} from '../task/index.js';

// Event monitoring types (Phase 2)
export {
  // Enums
  TaskType,
  ResolutionType,
  RateLimitActionType,
  RateLimitType,

  // Task event types
  type TaskCreatedEvent,
  type TaskClaimedEvent,
  type TaskCompletedEvent,
  type TaskCancelledEvent,
  type TaskEventCallbacks,
  type TaskEventFilterOptions,

  // Dispute event types
  type DisputeInitiatedEvent,
  type DisputeVoteCastEvent,
  type DisputeResolvedEvent,
  type DisputeExpiredEvent,
  type DisputeEventCallbacks,
  type DisputeEventFilterOptions,

  // Protocol event types
  type StateUpdatedEvent,
  type ProtocolInitializedEvent,
  type RewardDistributedEvent,
  type RateLimitHitEvent,
  type MigrationCompletedEvent,
  type ProtocolVersionUpdatedEvent,
  type ProtocolEventCallbacks,
  type ProtocolEventFilterOptions,

  // EventMonitor types
  type EventMonitorConfig,
  type EventMonitorMetrics,
} from '../events/index.js';
