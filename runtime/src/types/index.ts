/**
 * Type definitions for @agenc/runtime
 * @packageDocumentation
 */

// Configuration migration and validation
export {
  CURRENT_CONFIG_VERSION,
  KNOWN_CONFIG_KEYS,
  DEPRECATED_KEYS,
  ConfigMigrationError,
  configVersionToString,
  parseConfigVersion,
  compareVersions,
  migrateConfig,
  validateConfigStrict,
  buildConfigSchemaSnapshot,
  type ConfigVersion,
  type ConfigMigrationFn,
  type ConfigMigrationStep,
  type ConfigWarning,
  type ConfigValidationResult,
  type ConfigSchemaSnapshot,
} from "./config-migration.js";

// Protocol configuration types
export {
  ProtocolConfig,
  parseProtocolConfig,
  MAX_MULTISIG_OWNERS,
} from "./protocol.js";

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
  TaskNotFoundError,
  TaskNotClaimableError,
  TaskExecutionError,
  TaskSubmissionError,
  ExecutorStateError,
  TaskTimeoutError,
  RetryExhaustedError,
  // Helper functions
  isAnchorError,
  parseAnchorError,
  getAnchorErrorName,
  getAnchorErrorMessage,
  isRuntimeError,
  // Validation helpers
  validateByteLength,
  validateNonZeroBytes,
} from "./errors.js";

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
  subscribeToAgentSuspended,
  subscribeToAgentUnsuspended,
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
  type AgentSuspendedEvent,
  type AgentUnsuspendedEvent,
  type PdaWithBump,
  type AgentEventCallback,
  type EventSubscription,
  type AgentEventCallbacks,
  type EventSubscriptionOptions,
  type AgentManagerConfig,
  type ProtocolConfigCacheOptions,
  type GetProtocolConfigOptions,
} from "../agent/index.js";

// Wallet types and helpers
export {
  type Wallet,
  type SignMessageWallet,
  KeypairFileError,
  ensureWallet,
  keypairToWallet,
  loadKeypairFromFile,
  loadKeypairFromFileSync,
  getDefaultKeypairPath,
  loadDefaultKeypair,
} from "./wallet.js";

// Runtime configuration types
export {
  type AgentRuntimeConfig,
  type ReplayBackfillConfig,
  type RuntimeReplayConfig,
  isKeypair,
} from "./config.js";

// Task types and utilities (Phase 3)
export {
  // Constants
  TASK_ID_LENGTH,
  // Enums
  OnChainTaskStatus,
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
  // Filter functions
  matchesFilter,
  hasRequiredCapabilities,
  defaultTaskScorer,
  rankTasks,
  filterAndRank,
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
  type OperatingMode,
  type BatchTaskItem,
  type TaskExecutorStatus,
  type RetryPolicy,
} from "../task/index.js";

// Dispute types and utilities (Phase 8)
export {
  // Enums
  OnChainDisputeStatus,
  // Constants
  DISPUTE_STATUS_OFFSET,
  DISPUTE_TASK_OFFSET,
  // Functions
  parseOnChainDispute,
  parseOnChainDisputeVote,
  disputeStatusToString,
  // PDA derivation
  deriveDisputePda,
  findDisputePda,
  deriveVotePda,
  findVotePda,
  // Error classes
  DisputeNotFoundError,
  DisputeVoteError,
  DisputeResolutionError,
  DisputeSlashError,
  // Types
  type OnChainDispute,
  type OnChainDisputeVote,
  type InitiateDisputeParams,
  type VoteDisputeParams,
  type ResolveDisputeParams,
  type ExpireDisputeParams,
  type ApplySlashParams,
  type DisputeResult,
  type VoteResult,
  type DisputeOpsConfig,
} from "../dispute/index.js";

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
  type DependentTaskCreatedEvent,
  type TaskEventCallbacks,
  type TaskEventFilterOptions,

  // Dispute event types
  type DisputeInitiatedEvent,
  type DisputeVoteCastEvent,
  type DisputeResolvedEvent,
  type DisputeExpiredEvent,
  type DisputeCancelledEvent,
  type ArbiterVotesCleanedUpEvent,
  type DisputeEventCallbacks,
  type DisputeEventFilterOptions,

  // Protocol event types
  type StateUpdatedEvent,
  type ProtocolInitializedEvent,
  type RewardDistributedEvent,
  type RateLimitHitEvent,
  type MigrationCompletedEvent,
  type ProtocolVersionUpdatedEvent,
  type RateLimitsUpdatedEvent,
  type ProtocolFeeUpdatedEvent,
  type ReputationChangedEvent,
  type BondDepositedEvent,
  type BondLockedEvent,
  type BondReleasedEvent,
  type BondSlashedEvent,
  type SpeculativeCommitmentCreatedEvent,
  type ProtocolEventCallbacks,
  type ProtocolEventFilterOptions,

  // EventMonitor types
  type EventMonitorConfig,
  type EventMonitorMetrics,
} from "../events/index.js";
