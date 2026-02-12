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
  TaskTimeoutError,
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
  ensureWallet,
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
  type OperatingMode,
  type BatchTaskItem,
  type TaskExecutorStatus,
} from './types/index.js';

// Task module (Phase 3)
export {
  // TaskOperations class
  TaskOperations,
  type TaskOpsConfig,
  // Task filter functions
  matchesFilter,
  hasRequiredCapabilities,
  defaultTaskScorer,
  rankTasks,
  filterAndRank,
  // TaskDiscovery class
  TaskDiscovery,
  type TaskDiscoveryOptions,
  type TaskDiscoveryResult,
  type TaskDiscoveryListener,
  type TaskDiscoveryMode,
  // TaskExecutor class
  TaskExecutor,
} from './task/index.js';

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
  bigintsToProofHash,
  proofHashToBigints,
  toAnchorBytes,
} from './utils/index.js';

// SPL Token utilities
export {
  isTokenTask,
  buildCompleteTaskTokenAccounts,
  buildResolveDisputeTokenAccounts,
  buildExpireDisputeTokenAccounts,
  buildCreateTaskTokenAccounts,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
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

// Skill library system
export {
  // Core types
  type Skill,
  type SkillMetadata,
  type SkillAction,
  type SkillContext,
  type SemanticVersion,
  type SkillRegistryConfig,
  SkillState,
  // Error types
  SkillNotFoundError,
  SkillNotReadyError,
  SkillActionNotFoundError,
  SkillInitializationError,
  SkillAlreadyRegisteredError,
  // Registry
  SkillRegistry,
  // Jupiter skill
  JupiterSkill,
  JupiterClient,
  JupiterApiError,
  type JupiterSkillConfig,
  type SwapQuoteParams,
  type SwapQuote,
  type SwapResult,
  type TokenBalance,
  type TransferSolParams,
  type TransferTokenParams,
  type TransferResult,
  type TokenPrice,
  type TokenMint,
  JUPITER_API_BASE_URL,
  JUPITER_PRICE_API_URL,
  WSOL_MINT,
  USDC_MINT,
  USDT_MINT,
  WELL_KNOWN_TOKENS,
} from './skills/index.js';

// LLM Adapters (Phase 4)
export {
  // Core types
  type LLMProvider,
  type LLMProviderConfig,
  type LLMMessage,
  type LLMResponse,
  type LLMStreamChunk,
  type LLMTool,
  type LLMToolCall,
  type LLMUsage,
  type MessageRole,
  type StreamProgressCallback,
  type ToolHandler,
  // Error classes
  LLMProviderError,
  LLMRateLimitError,
  LLMResponseConversionError,
  LLMToolCallError,
  LLMTimeoutError,
  // Response converter
  responseToOutput,
  // LLM Task Executor
  LLMTaskExecutor,
  type LLMTaskExecutorConfig,
  // Provider adapters
  GrokProvider,
  type GrokProviderConfig,
  AnthropicProvider,
  type AnthropicProviderConfig,
  OllamaProvider,
  type OllamaProviderConfig,
} from './llm/index.js';

// Autonomous Agent System
export {
  AutonomousAgent,
  TaskScanner,
  type TaskScannerConfig,
  type Task,
  TaskStatus as AutonomousTaskStatus,
  type TaskFilter,
  type ClaimStrategy,
  type AutonomousTaskExecutor,
  type AutonomousAgentConfig,
  type AutonomousAgentStats,
  type DiscoveryMode,
  type SpeculationConfig,
  DefaultClaimStrategy,
} from './autonomous/index.js';

// Tool System (Phase 5)
export {
  // Core types
  type Tool,
  type ToolResult,
  type ToolContext,
  type ToolRegistryConfig,
  type JSONSchema,
  bigintReplacer,
  safeStringify,
  // Error types
  ToolNotFoundError,
  ToolAlreadyRegisteredError,
  ToolExecutionError,
  // Registry
  ToolRegistry,
  // Skill-to-Tool adapter
  skillToTools,
  type ActionSchemaMap,
  type SkillToToolsOptions,
  JUPITER_ACTION_SCHEMAS,
  // Built-in AgenC tools
  createAgencTools,
  createListTasksTool,
  createGetTaskTool,
  createGetTokenBalanceTool,
  createCreateTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
  type SerializedTask,
  type SerializedAgent,
  type SerializedProtocolConfig,
} from './tools/index.js';

// ZK Proof Engine (Phase 7)
export {
  // Core types
  type ProofEngineConfig,
  type ProofCacheConfig,
  type ProofInputs,
  type EngineProofResult,
  type ProofEngineStats,
  type HashResult,
  type ToolsStatus,
  // Error classes
  ProofGenerationError,
  ProofVerificationError,
  ProofCacheError,
  // Cache
  ProofCache,
  deriveCacheKey,
  // Engine
  ProofEngine,
} from './proof/index.js';

// Memory Backends (Phase 6)
export {
  // Core types
  type MemoryBackend,
  type MemoryBackendConfig,
  type MemoryEntry,
  type MemoryRole,
  type MemoryQuery,
  type AddEntryOptions,
  // LLM interop helpers
  entryToMessage,
  messageToEntryOptions,
  // Error classes
  MemoryBackendError,
  MemoryConnectionError,
  MemorySerializationError,
  // In-memory backend
  InMemoryBackend,
  type InMemoryBackendConfig,
  // SQLite backend
  SqliteBackend,
  type SqliteBackendConfig,
  // Redis backend
  RedisBackend,
  type RedisBackendConfig,
} from './memory/index.js';

// Dispute Operations (Phase 8)
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
  // Operations class
  DisputeOperations,
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
} from './dispute/index.js';

// Workflow DAG Orchestrator (Phase 9)
export {
  // Enums
  OnChainDependencyType,
  WorkflowNodeStatus,
  WorkflowStatus,
  // Types
  type TaskTemplate,
  type WorkflowEdge,
  type WorkflowDefinition,
  type WorkflowConfig,
  type WorkflowNode,
  type WorkflowState,
  type WorkflowStats,
  type WorkflowCallbacks,
  type DAGOrchestratorConfig,
  // Error classes
  WorkflowValidationError,
  WorkflowSubmissionError,
  WorkflowMonitoringError,
  WorkflowStateError,
  // Validation
  validateWorkflow,
  topologicalSort,
  // Classes
  DAGSubmitter,
  DAGMonitor,
  DAGOrchestrator,
} from './workflow/index.js';

// Connection Manager
export {
  // Types
  type EndpointConfig,
  type RetryConfig,
  type HealthCheckConfig,
  type ConnectionManagerConfig,
  type EndpointHealth,
  type ConnectionManagerStats,
  // Error classes
  ConnectionError,
  AllEndpointsUnhealthyError,
  // Utilities
  isRetryableError,
  isConnectionLevelError,
  isWriteMethod,
  computeBackoff,
  deriveCoalesceKey,
  // Class
  ConnectionManager,
} from './connection/index.js';

// Telemetry (Phase 11)
export {
  // Core types
  type TelemetryCollector,
  type TelemetrySnapshot,
  type TelemetrySink,
  type TelemetryConfig,
  // Collector implementations
  UnifiedTelemetryCollector,
  NoopTelemetryCollector,
  // Built-in sinks
  ConsoleSink,
  CallbackSink,
  // Error class
  TelemetryError,
  // Metric name constants
  TELEMETRY_METRIC_NAMES,
} from './telemetry/index.js';

// Agent Builder (Phase 10)
export { AgentBuilder, BuiltAgent } from './builder.js';
