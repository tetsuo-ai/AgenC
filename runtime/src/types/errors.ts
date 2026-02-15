/**
 * Error types and utilities for @agenc/runtime
 *
 * Provides custom runtime error classes, complete Anchor error code mapping,
 * and helper functions for error handling in AgenC applications.
 */

import type { PublicKey } from '@solana/web3.js';

// ============================================================================
// Runtime Error Codes
// ============================================================================

/**
 * String error codes for runtime-specific errors.
 * These are distinct from Anchor program errors.
 */
export const RuntimeErrorCodes = {
  /** Agent is not registered in the protocol */
  AGENT_NOT_REGISTERED: 'AGENT_NOT_REGISTERED',
  /** Agent is already registered */
  AGENT_ALREADY_REGISTERED: 'AGENT_ALREADY_REGISTERED',
  /** Input validation failed */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Rate limit exceeded */
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  /** Insufficient stake for operation */
  INSUFFICIENT_STAKE: 'INSUFFICIENT_STAKE',
  /** Agent has active tasks preventing operation */
  ACTIVE_TASKS_ERROR: 'ACTIVE_TASKS_ERROR',
  /** Agent has pending dispute votes */
  PENDING_DISPUTE_VOTES: 'PENDING_DISPUTE_VOTES',
  /** Agent has recent vote activity */
  RECENT_VOTE_ACTIVITY: 'RECENT_VOTE_ACTIVITY',
  /** Task not found by PDA */
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  /** Task is not claimable */
  TASK_NOT_CLAIMABLE: 'TASK_NOT_CLAIMABLE',
  /** Task execution failed locally */
  TASK_EXECUTION_FAILED: 'TASK_EXECUTION_FAILED',
  /** Task result submission failed on-chain */
  TASK_SUBMISSION_FAILED: 'TASK_SUBMISSION_FAILED',
  /** Executor state machine is in an invalid state */
  EXECUTOR_STATE_ERROR: 'EXECUTOR_STATE_ERROR',
  /** Task execution timed out */
  TASK_TIMEOUT: 'TASK_TIMEOUT',
  /** Claim deadline expired or about to expire */
  CLAIM_EXPIRED: 'CLAIM_EXPIRED',
  /** All retry attempts exhausted */
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  /** LLM provider returned an error */
  LLM_PROVIDER_ERROR: 'LLM_PROVIDER_ERROR',
  /** LLM provider rate limit exceeded */
  LLM_RATE_LIMIT: 'LLM_RATE_LIMIT',
  /** Failed to convert LLM response to output */
  LLM_RESPONSE_CONVERSION: 'LLM_RESPONSE_CONVERSION',
  /** LLM tool call failed */
  LLM_TOOL_CALL_ERROR: 'LLM_TOOL_CALL_ERROR',
  /** LLM request timed out */
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  /** Memory backend operation failure */
  MEMORY_BACKEND_ERROR: 'MEMORY_BACKEND_ERROR',
  /** Memory backend connection failure or missing dependency */
  MEMORY_CONNECTION_ERROR: 'MEMORY_CONNECTION_ERROR',
  /** Memory serialization/deserialization failure */
  MEMORY_SERIALIZATION_ERROR: 'MEMORY_SERIALIZATION_ERROR',
  /** ZK proof generation failed */
  PROOF_GENERATION_ERROR: 'PROOF_GENERATION_ERROR',
  /** ZK proof verification failed */
  PROOF_VERIFICATION_ERROR: 'PROOF_VERIFICATION_ERROR',
  /** Proof cache operation failed */
  PROOF_CACHE_ERROR: 'PROOF_CACHE_ERROR',
  /** Dispute not found by PDA */
  DISPUTE_NOT_FOUND: 'DISPUTE_NOT_FOUND',
  /** Dispute vote operation failed */
  DISPUTE_VOTE_ERROR: 'DISPUTE_VOTE_ERROR',
  /** Dispute resolution operation failed */
  DISPUTE_RESOLUTION_ERROR: 'DISPUTE_RESOLUTION_ERROR',
  /** Dispute slash operation failed */
  DISPUTE_SLASH_ERROR: 'DISPUTE_SLASH_ERROR',
  /** Workflow definition failed validation */
  WORKFLOW_VALIDATION_ERROR: 'WORKFLOW_VALIDATION_ERROR',
  /** Workflow on-chain task submission failed */
  WORKFLOW_SUBMISSION_ERROR: 'WORKFLOW_SUBMISSION_ERROR',
  /** Workflow event subscription or polling failed */
  WORKFLOW_MONITORING_ERROR: 'WORKFLOW_MONITORING_ERROR',
  /** Workflow state transition or lookup failed */
  WORKFLOW_STATE_ERROR: 'WORKFLOW_STATE_ERROR',
  /** Team contract definition failed validation */
  TEAM_CONTRACT_VALIDATION_ERROR: 'TEAM_CONTRACT_VALIDATION_ERROR',
  /** Team contract state transition or lifecycle operation failed */
  TEAM_CONTRACT_STATE_ERROR: 'TEAM_CONTRACT_STATE_ERROR',
  /** Team payout configuration or computation failed */
  TEAM_PAYOUT_ERROR: 'TEAM_PAYOUT_ERROR',
  /** Team workflow topology is not launch-compatible */
  TEAM_WORKFLOW_TOPOLOGY_ERROR: 'TEAM_WORKFLOW_TOPOLOGY_ERROR',
  /** Marketplace bid input validation failed */
  MARKETPLACE_VALIDATION_ERROR: 'MARKETPLACE_VALIDATION_ERROR',
  /** Marketplace lifecycle state transition failed */
  MARKETPLACE_STATE_ERROR: 'MARKETPLACE_STATE_ERROR',
  /** Marketplace authorization failed */
  MARKETPLACE_AUTHORIZATION_ERROR: 'MARKETPLACE_AUTHORIZATION_ERROR',
  /** Marketplace matching/scoring operation failed */
  MARKETPLACE_MATCHING_ERROR: 'MARKETPLACE_MATCHING_ERROR',
  /** RPC connection error (timeout, server error, etc.) */
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  /** All configured RPC endpoints are unhealthy */
  ALL_ENDPOINTS_UNHEALTHY: 'ALL_ENDPOINTS_UNHEALTHY',
  /** Telemetry system error */
  TELEMETRY_ERROR: 'TELEMETRY_ERROR',
  /** Gateway configuration validation failed */
  GATEWAY_VALIDATION_ERROR: 'GATEWAY_VALIDATION_ERROR',
  /** Gateway WebSocket or file system connection error */
  GATEWAY_CONNECTION_ERROR: 'GATEWAY_CONNECTION_ERROR',
  /** Gateway invalid lifecycle state transition */
  GATEWAY_STATE_ERROR: 'GATEWAY_STATE_ERROR',
  /** Gateway start/stop lifecycle failure */
  GATEWAY_LIFECYCLE_ERROR: 'GATEWAY_LIFECYCLE_ERROR',
  /** Workspace configuration validation failed */
  WORKSPACE_VALIDATION_ERROR: 'WORKSPACE_VALIDATION_ERROR',
} as const;

/** Union type of all runtime error code values */
export type RuntimeErrorCode = (typeof RuntimeErrorCodes)[keyof typeof RuntimeErrorCodes];

// ============================================================================
// Anchor Error Codes (147 codes: 6000-6146)
// ============================================================================

/**
 * Numeric error codes matching the Anchor program's CoordinationError enum.
 * Codes are assigned sequentially starting from 6000 based on enum variant order
 * in programs/agenc-coordination/src/errors.rs
 */
export const AnchorErrorCodes = {
  // Agent errors (6000-6012)
  /** Agent is already registered */
  AgentAlreadyRegistered: 6000,
  /** Agent not found */
  AgentNotFound: 6001,
  /** Agent is not active */
  AgentNotActive: 6002,
  /** Agent has insufficient capabilities */
  InsufficientCapabilities: 6003,
  /** Agent capabilities bitmask cannot be zero */
  InvalidCapabilities: 6004,
  /** Agent has reached maximum active tasks */
  MaxActiveTasksReached: 6005,
  /** Agent has active tasks and cannot be deregistered */
  AgentHasActiveTasks: 6006,
  /** Only the agent authority can perform this action */
  UnauthorizedAgent: 6007,
  /** Creator must match authority to prevent social engineering */
  CreatorAuthorityMismatch: 6008,
  /** Invalid agent ID: agent_id cannot be all zeros */
  InvalidAgentId: 6009,
  /** Agent registration required to create tasks */
  AgentRegistrationRequired: 6010,
  /** Agent is suspended and cannot change status */
  AgentSuspended: 6011,
  /** Agent cannot set status to Active while having active tasks */
  AgentBusyWithTasks: 6012,

  // Task errors (6013-6034)
  /** Task not found */
  TaskNotFound: 6013,
  /** Task is not open for claims */
  TaskNotOpen: 6014,
  /** Task has reached maximum workers */
  TaskFullyClaimed: 6015,
  /** Task has expired */
  TaskExpired: 6016,
  /** Task deadline has not passed */
  TaskNotExpired: 6017,
  /** Task deadline has passed */
  DeadlinePassed: 6018,
  /** Task is not in progress */
  TaskNotInProgress: 6019,
  /** Task is already completed */
  TaskAlreadyCompleted: 6020,
  /** Task cannot be cancelled */
  TaskCannotBeCancelled: 6021,
  /** Only the task creator can perform this action */
  UnauthorizedTaskAction: 6022,
  /** Invalid creator */
  InvalidCreator: 6023,
  /** Invalid task ID: cannot be zero */
  InvalidTaskId: 6024,
  /** Invalid description: cannot be empty */
  InvalidDescription: 6025,
  /** Invalid max workers: must be between 1 and 100 */
  InvalidMaxWorkers: 6026,
  /** Invalid task type */
  InvalidTaskType: 6027,
  /** Invalid deadline: deadline must be greater than zero */
  InvalidDeadline: 6028,
  /** Invalid reward: reward must be greater than zero */
  InvalidReward: 6029,
  /** Invalid required capabilities: required_capabilities cannot be zero */
  InvalidRequiredCapabilities: 6030,
  /** Competitive task already completed by another worker */
  CompetitiveTaskAlreadyWon: 6031,
  /** Task has no workers */
  NoWorkers: 6032,
  /** Proof constraint hash does not match task's stored constraint hash */
  ConstraintHashMismatch: 6033,
  /** Task is not a private task (no constraint hash set) */
  NotPrivateTask: 6034,

  // Claim errors (6035-6049)
  /** Worker has already claimed this task */
  AlreadyClaimed: 6035,
  /** Worker has not claimed this task */
  NotClaimed: 6036,
  /** Claim has already been completed */
  ClaimAlreadyCompleted: 6037,
  /** Claim has not expired yet */
  ClaimNotExpired: 6038,
  /** Claim has expired */
  ClaimExpired: 6039,
  /** Invalid expiration: expires_at cannot be zero */
  InvalidExpiration: 6040,
  /** Invalid proof of work */
  InvalidProof: 6041,
  /** ZK proof verification failed */
  ZkVerificationFailed: 6042,
  /** Invalid proof size - expected 256 bytes for Groth16 */
  InvalidProofSize: 6043,
  /** Invalid proof binding: expected_binding cannot be all zeros */
  InvalidProofBinding: 6044,
  /** Invalid output commitment: output_commitment cannot be all zeros */
  InvalidOutputCommitment: 6045,
  /** Invalid rent recipient: must be worker authority */
  InvalidRentRecipient: 6046,
  /** Grace period not passed: only worker authority can expire claim within 60 seconds of expiry */
  GracePeriodNotPassed: 6047,
  /** Invalid proof hash: proof_hash cannot be all zeros */
  InvalidProofHash: 6048,
  /** Invalid result data: result_data cannot be all zeros when provided */
  InvalidResultData: 6049,

  // Dispute errors (6050-6075)
  /** Dispute is not active */
  DisputeNotActive: 6050,
  /** Voting period has ended */
  VotingEnded: 6051,
  /** Voting period has not ended */
  VotingNotEnded: 6052,
  /** Already voted on this dispute */
  AlreadyVoted: 6053,
  /** Not authorized to vote (not an arbiter) */
  NotArbiter: 6054,
  /** Insufficient votes to resolve */
  InsufficientVotes: 6055,
  /** Dispute has already been resolved */
  DisputeAlreadyResolved: 6056,
  /** Only protocol authority or dispute initiator can resolve disputes */
  UnauthorizedResolver: 6057,
  /** Agent has active dispute votes pending resolution */
  ActiveDisputeVotes: 6058,
  /** Agent must wait 24 hours after voting before deregistering */
  RecentVoteActivity: 6059,
  /** Authority has already voted on this dispute */
  AuthorityAlreadyVoted: 6060,
  /** Insufficient dispute evidence provided */
  InsufficientEvidence: 6061,
  /** Dispute evidence exceeds maximum allowed length */
  EvidenceTooLong: 6062,
  /** Dispute has not expired */
  DisputeNotExpired: 6063,
  /** Dispute slashing already applied */
  SlashAlreadyApplied: 6064,
  /** Slash window expired: must apply slashing within 7 days of resolution */
  SlashWindowExpired: 6065,
  /** Dispute has not been resolved */
  DisputeNotResolved: 6066,
  /** Only task creator or workers can initiate disputes */
  NotTaskParticipant: 6067,
  /** Invalid evidence hash: cannot be all zeros */
  InvalidEvidenceHash: 6068,
  /** Arbiter cannot vote on disputes they are a participant in */
  ArbiterIsDisputeParticipant: 6069,
  /** Insufficient quorum: minimum number of voters not reached */
  InsufficientQuorum: 6070,
  /** Agent has active disputes as defendant and cannot deregister */
  ActiveDisputesExist: 6071,
  /** Worker agent account required when creator initiates dispute */
  WorkerAgentRequired: 6072,
  /** Worker claim account required when creator initiates dispute */
  WorkerClaimRequired: 6073,
  /** Worker was not involved in this dispute */
  WorkerNotInDispute: 6074,
  /** Dispute initiator cannot resolve their own dispute */
  InitiatorCannotResolve: 6075,

  // State errors (6076-6081)
  /** State version mismatch (concurrent modification) */
  VersionMismatch: 6076,
  /** State key already exists */
  StateKeyExists: 6077,
  /** State not found */
  StateNotFound: 6078,
  /** Invalid state value: state_value cannot be all zeros */
  InvalidStateValue: 6079,
  /** State ownership violation: only the creator agent can update this state */
  StateOwnershipViolation: 6080,
  /** Invalid state key: state_key cannot be all zeros */
  InvalidStateKey: 6081,

  // Protocol errors (6082-6093)
  /** Protocol is already initialized */
  ProtocolAlreadyInitialized: 6082,
  /** Protocol is not initialized */
  ProtocolNotInitialized: 6083,
  /** Invalid protocol fee (must be <= 1000 bps) */
  InvalidProtocolFee: 6084,
  /** Invalid treasury: treasury account cannot be default pubkey */
  InvalidTreasury: 6085,
  /** Invalid dispute threshold: must be 1-100 (percentage of votes required) */
  InvalidDisputeThreshold: 6086,
  /** Insufficient stake for arbiter registration */
  InsufficientStake: 6087,
  /** Invalid multisig threshold */
  MultisigInvalidThreshold: 6088,
  /** Invalid multisig signer configuration */
  MultisigInvalidSigners: 6089,
  /** Not enough multisig signers */
  MultisigNotEnoughSigners: 6090,
  /** Duplicate multisig signer provided */
  MultisigDuplicateSigner: 6091,
  /** Multisig signer cannot be default pubkey */
  MultisigDefaultSigner: 6092,
  /** Multisig signer account not owned by System Program */
  MultisigSignerNotSystemOwned: 6093,

  // General errors (6094-6101)
  /** Invalid input parameter */
  InvalidInput: 6094,
  /** Arithmetic overflow */
  ArithmeticOverflow: 6095,
  /** Vote count overflow */
  VoteOverflow: 6096,
  /** Insufficient funds */
  InsufficientFunds: 6097,
  /** Reward too small: worker must receive at least 1 lamport */
  RewardTooSmall: 6098,
  /** Account data is corrupted */
  CorruptedData: 6099,
  /** String too long */
  StringTooLong: 6100,
  /** Account owner validation failed: account not owned by this program */
  InvalidAccountOwner: 6101,

  // Rate limiting errors (6102-6110)
  /** Rate limit exceeded: maximum actions per 24h window reached */
  RateLimitExceeded: 6102,
  /** Cooldown period has not elapsed since last action */
  CooldownNotElapsed: 6103,
  /** Agent update too frequent: must wait cooldown period */
  UpdateTooFrequent: 6104,
  /** Cooldown value cannot be negative */
  InvalidCooldown: 6105,
  /** Cooldown value exceeds maximum (24 hours) */
  CooldownTooLarge: 6106,
  /** Rate limit value exceeds maximum allowed (1000) */
  RateLimitTooHigh: 6107,
  /** Cooldown value exceeds maximum allowed (1 week) */
  CooldownTooLong: 6108,
  /** Insufficient stake to initiate dispute */
  InsufficientStakeForDispute: 6109,
  /** Creator-initiated disputes require 2x the minimum stake */
  InsufficientStakeForCreatorDispute: 6110,

  // Version/upgrade errors (6111-6118)
  /** Protocol version mismatch: account version incompatible with current program */
  VersionMismatchProtocol: 6111,
  /** Account version too old: migration required */
  AccountVersionTooOld: 6112,
  /** Account version too new: program upgrade required */
  AccountVersionTooNew: 6113,
  /** Migration not allowed: invalid source version */
  InvalidMigrationSource: 6114,
  /** Migration not allowed: invalid target version */
  InvalidMigrationTarget: 6115,
  /** Only upgrade authority can perform this action */
  UnauthorizedUpgrade: 6116,
  /** Minimum version cannot exceed current protocol version */
  InvalidMinVersion: 6117,
  /** Protocol config account required: suspending an agent requires the protocol config PDA in remaining_accounts */
  ProtocolConfigRequired: 6118,

  // Dependency errors (6119-6124)
  /** Parent task has been cancelled */
  ParentTaskCancelled: 6119,
  /** Parent task is in disputed state */
  ParentTaskDisputed: 6120,
  /** Invalid dependency type */
  InvalidDependencyType: 6121,
  /** Parent task must be completed before completing a proof-dependent task */
  ParentTaskNotCompleted: 6122,
  /** Parent task account required for proof-dependent task completion */
  ParentTaskAccountRequired: 6123,
  /** Parent task does not belong to the same creator */
  UnauthorizedCreator: 6124,

  // Nullifier errors (6125-6126)
  /** Nullifier has already been spent - proof/knowledge reuse detected */
  NullifierAlreadySpent: 6125,
  /** Invalid nullifier: nullifier value cannot be all zeros */
  InvalidNullifier: 6126,

  // Cancel task errors (6127-6128)
  /** All worker accounts must be provided when cancelling a task with active claims */
  IncompleteWorkerAccounts: 6127,
  /** Worker accounts required when task has active workers */
  WorkerAccountsRequired: 6128,

  // Duplicate account errors (6129)
  /** Duplicate arbiter provided in remaining_accounts */
  DuplicateArbiter: 6129,

  // Escrow errors (6130)
  /** Escrow has insufficient balance for reward transfer */
  InsufficientEscrowBalance: 6130,

  // Status transition errors (6131)
  /** Invalid task status transition */
  InvalidStatusTransition: 6131,

  // Stake validation errors (6132-6134)
  /** Stake value is below minimum required (0.001 SOL) */
  StakeTooLow: 6132,
  /** min_stake_for_dispute must be greater than zero */
  InvalidMinStake: 6133,
  /** Slash amount must be greater than zero */
  InvalidSlashAmount: 6134,

  // Speculation Bond errors (6135-6138)
  /** Bond amount too low */
  BondAmountTooLow: 6135,
  /** Bond already exists */
  BondAlreadyExists: 6136,
  /** Bond not found */
  BondNotFound: 6137,
  /** Bond not yet matured */
  BondNotMatured: 6138,

  // Reputation errors (6139-6140)
  /** Agent reputation below task minimum requirement */
  InsufficientReputation: 6139,
  /** Invalid minimum reputation: must be <= 10000 */
  InvalidMinReputation: 6140,

  // Security errors (6141-6142)
  /** Development verifying key detected (gamma == delta). ZK proofs are forgeable. */
  DevelopmentKeyNotAllowed: 6141,
  /** Cannot claim own task: worker authority matches task creator */
  SelfTaskNotAllowed: 6142,

  // SPL Token errors (6143-6146)
  /** Token accounts not provided for token-denominated task */
  MissingTokenAccounts: 6143,
  /** Token escrow ATA does not match expected derivation */
  InvalidTokenEscrow: 6144,
  /** Provided mint does not match task's reward_mint */
  InvalidTokenMint: 6145,
  /** SPL token transfer CPI failed */
  TokenTransferFailed: 6146,
} as const;

/** Union type of all Anchor error code values */
export type AnchorErrorCode = (typeof AnchorErrorCodes)[keyof typeof AnchorErrorCodes];

/** Union type of all Anchor error names */
export type AnchorErrorName = keyof typeof AnchorErrorCodes;

// ============================================================================
// Error Messages Mapping
// ============================================================================

/** Human-readable messages for each Anchor error code */
const AnchorErrorMessages: Record<AnchorErrorCode, string> = {
  // Agent errors (6000-6012)
  6000: 'Agent is already registered',
  6001: 'Agent not found',
  6002: 'Agent is not active',
  6003: 'Agent has insufficient capabilities',
  6004: 'Agent capabilities bitmask cannot be zero',
  6005: 'Agent has reached maximum active tasks',
  6006: 'Agent has active tasks and cannot be deregistered',
  6007: 'Only the agent authority can perform this action',
  6008: 'Creator must match authority to prevent social engineering',
  6009: 'Invalid agent ID: agent_id cannot be all zeros',
  6010: 'Agent registration required to create tasks',
  6011: 'Agent is suspended and cannot change status',
  6012: 'Agent cannot set status to Active while having active tasks',
  // Task errors (6013-6034)
  6013: 'Task not found',
  6014: 'Task is not open for claims',
  6015: 'Task has reached maximum workers',
  6016: 'Task has expired',
  6017: 'Task deadline has not passed',
  6018: 'Task deadline has passed',
  6019: 'Task is not in progress',
  6020: 'Task is already completed',
  6021: 'Task cannot be cancelled',
  6022: 'Only the task creator can perform this action',
  6023: 'Invalid creator',
  6024: 'Invalid task ID: cannot be zero',
  6025: 'Invalid description: cannot be empty',
  6026: 'Invalid max workers: must be between 1 and 100',
  6027: 'Invalid task type',
  6028: 'Invalid deadline: deadline must be greater than zero',
  6029: 'Invalid reward: reward must be greater than zero',
  6030: 'Invalid required capabilities: required_capabilities cannot be zero',
  6031: 'Competitive task already completed by another worker',
  6032: 'Task has no workers',
  6033: "Proof constraint hash does not match task's stored constraint hash",
  6034: 'Task is not a private task (no constraint hash set)',
  // Claim errors (6035-6049)
  6035: 'Worker has already claimed this task',
  6036: 'Worker has not claimed this task',
  6037: 'Claim has already been completed',
  6038: 'Claim has not expired yet',
  6039: 'Claim has expired',
  6040: 'Invalid expiration: expires_at cannot be zero',
  6041: 'Invalid proof of work',
  6042: 'ZK proof verification failed',
  6043: 'Invalid proof size - expected 256 bytes for Groth16',
  6044: 'Invalid proof binding: expected_binding cannot be all zeros',
  6045: 'Invalid output commitment: output_commitment cannot be all zeros',
  6046: 'Invalid rent recipient: must be worker authority',
  6047: 'Grace period not passed: only worker authority can expire claim within 60 seconds of expiry',
  6048: 'Invalid proof hash: proof_hash cannot be all zeros',
  6049: 'Invalid result data: result_data cannot be all zeros when provided',
  // Dispute errors (6050-6075)
  6050: 'Dispute is not active',
  6051: 'Voting period has ended',
  6052: 'Voting period has not ended',
  6053: 'Already voted on this dispute',
  6054: 'Not authorized to vote (not an arbiter)',
  6055: 'Insufficient votes to resolve',
  6056: 'Dispute has already been resolved',
  6057: 'Only protocol authority or dispute initiator can resolve disputes',
  6058: 'Agent has active dispute votes pending resolution',
  6059: 'Agent must wait 24 hours after voting before deregistering',
  6060: 'Authority has already voted on this dispute',
  6061: 'Insufficient dispute evidence provided',
  6062: 'Dispute evidence exceeds maximum allowed length',
  6063: 'Dispute has not expired',
  6064: 'Dispute slashing already applied',
  6065: 'Slash window expired: must apply slashing within 7 days of resolution',
  6066: 'Dispute has not been resolved',
  6067: 'Only task creator or workers can initiate disputes',
  6068: 'Invalid evidence hash: cannot be all zeros',
  6069: 'Arbiter cannot vote on disputes they are a participant in',
  6070: 'Insufficient quorum: minimum number of voters not reached',
  6071: 'Agent has active disputes as defendant and cannot deregister',
  6072: 'Worker agent account required when creator initiates dispute',
  6073: 'Worker claim account required when creator initiates dispute',
  6074: 'Worker was not involved in this dispute',
  6075: 'Dispute initiator cannot resolve their own dispute',
  // State errors (6076-6081)
  6076: 'State version mismatch (concurrent modification)',
  6077: 'State key already exists',
  6078: 'State not found',
  6079: 'Invalid state value: state_value cannot be all zeros',
  6080: 'State ownership violation: only the creator agent can update this state',
  6081: 'Invalid state key: state_key cannot be all zeros',
  // Protocol errors (6082-6093)
  6082: 'Protocol is already initialized',
  6083: 'Protocol is not initialized',
  6084: 'Invalid protocol fee (must be <= 1000 bps)',
  6085: 'Invalid treasury: treasury account cannot be default pubkey',
  6086: 'Invalid dispute threshold: must be 1-100 (percentage of votes required)',
  6087: 'Insufficient stake for arbiter registration',
  6088: 'Invalid multisig threshold',
  6089: 'Invalid multisig signer configuration',
  6090: 'Not enough multisig signers',
  6091: 'Duplicate multisig signer provided',
  6092: 'Multisig signer cannot be default pubkey',
  6093: 'Multisig signer account not owned by System Program',
  // General errors (6094-6101)
  6094: 'Invalid input parameter',
  6095: 'Arithmetic overflow',
  6096: 'Vote count overflow',
  6097: 'Insufficient funds',
  6098: 'Reward too small: worker must receive at least 1 lamport',
  6099: 'Account data is corrupted',
  6100: 'String too long',
  6101: 'Account owner validation failed: account not owned by this program',
  // Rate limiting errors (6102-6110)
  6102: 'Rate limit exceeded: maximum actions per 24h window reached',
  6103: 'Cooldown period has not elapsed since last action',
  6104: 'Agent update too frequent: must wait cooldown period',
  6105: 'Cooldown value cannot be negative',
  6106: 'Cooldown value exceeds maximum (24 hours)',
  6107: 'Rate limit value exceeds maximum allowed (1000)',
  6108: 'Cooldown value exceeds maximum allowed (1 week)',
  6109: 'Insufficient stake to initiate dispute',
  6110: 'Creator-initiated disputes require 2x the minimum stake',
  // Version/upgrade errors (6111-6118)
  6111: 'Protocol version mismatch: account version incompatible with current program',
  6112: 'Account version too old: migration required',
  6113: 'Account version too new: program upgrade required',
  6114: 'Migration not allowed: invalid source version',
  6115: 'Migration not allowed: invalid target version',
  6116: 'Only upgrade authority can perform this action',
  6117: 'Minimum version cannot exceed current protocol version',
  6118: 'Protocol config account required: suspending an agent requires the protocol config PDA in remaining_accounts',
  // Dependency errors (6119-6124)
  6119: 'Parent task has been cancelled',
  6120: 'Parent task is in disputed state',
  6121: 'Invalid dependency type',
  6122: 'Parent task must be completed before completing a proof-dependent task',
  6123: 'Parent task account required for proof-dependent task completion',
  6124: 'Parent task does not belong to the same creator',
  // Nullifier errors (6125-6126)
  6125: 'Nullifier has already been spent - proof/knowledge reuse detected',
  6126: 'Invalid nullifier: nullifier value cannot be all zeros',
  // Cancel task errors (6127-6128)
  6127: 'All worker accounts must be provided when cancelling a task with active claims',
  6128: 'Worker accounts required when task has active workers',
  // Duplicate account errors (6129)
  6129: 'Duplicate arbiter provided in remaining_accounts',
  // Escrow errors (6130)
  6130: 'Escrow has insufficient balance for reward transfer',
  // Status transition errors (6131)
  6131: 'Invalid task status transition',
  // Stake validation errors (6132-6134)
  6132: 'Stake value is below minimum required (0.001 SOL)',
  6133: 'min_stake_for_dispute must be greater than zero',
  6134: 'Slash amount must be greater than zero',
  // Speculation Bond errors (6135-6138)
  6135: 'Bond amount too low',
  6136: 'Bond already exists',
  6137: 'Bond not found',
  6138: 'Bond not yet matured',
  // Reputation errors (6139-6140)
  6139: 'Agent reputation below task minimum requirement',
  6140: 'Invalid minimum reputation: must be <= 10000',
  // Security errors (6141-6142)
  6141: 'Development verifying key detected (gamma == delta). ZK proofs are forgeable.',
  6142: 'Cannot claim own task: worker authority matches task creator',
  // SPL Token errors (6143-6146)
  6143: 'Token accounts not provided for token-denominated task',
  6144: 'Token escrow ATA does not match expected derivation',
  6145: 'Provided mint does not match task\'s reward_mint',
  6146: 'SPL token transfer CPI failed',
};

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validates that a byte array has the expected length.
 * @throws ValidationError if length doesn't match
 */
export function validateByteLength(
  value: Uint8Array | number[],
  expectedLength: number,
  paramName: string,
): Uint8Array {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.length !== expectedLength) {
    throw new ValidationError(
      `Invalid ${paramName}: expected ${expectedLength} bytes, got ${bytes.length}`
    );
  }
  return bytes;
}

/**
 * Validates that a byte array is not all zeros.
 * @throws ValidationError if all bytes are zero
 */
export function validateNonZeroBytes(value: Uint8Array, paramName: string): void {
  if (value.every(b => b === 0)) {
    throw new ValidationError(`Invalid ${paramName}: cannot be all zeros`);
  }
}

// ============================================================================
// Base Runtime Error Class
// ============================================================================

/**
 * Base class for all runtime errors.
 *
 * @example
 * ```typescript
 * try {
 *   await runtime.registerAgent(config);
 * } catch (err) {
 *   if (err instanceof RuntimeError) {
 *     console.log(`Runtime error: ${err.code} - ${err.message}`);
 *   }
 * }
 * ```
 */
export class RuntimeError extends Error {
  /** The error code identifying this error type */
  public readonly code: RuntimeErrorCode;

  constructor(message: string, code: RuntimeErrorCode) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    // Maintain proper stack trace in V8 environments.
    // Using this.constructor ensures subclass constructors are hidden from the
    // stack, making the redundant captureStackTrace calls in subclasses unnecessary.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ============================================================================
// Specific Runtime Error Classes
// ============================================================================

/**
 * Error thrown when an agent is not registered in the protocol.
 *
 * @example
 * ```typescript
 * if (!agent.isRegistered) {
 *   throw new AgentNotRegisteredError();
 * }
 * ```
 */
export class AgentNotRegisteredError extends RuntimeError {
  constructor() {
    super('Agent is not registered in the protocol', RuntimeErrorCodes.AGENT_NOT_REGISTERED);
    this.name = 'AgentNotRegisteredError';
  }
}

/**
 * Error thrown when attempting to register an agent that already exists.
 *
 * @example
 * ```typescript
 * const existing = await getAgent(agentId);
 * if (existing) {
 *   throw new AgentAlreadyRegisteredError(agentId);
 * }
 * ```
 */
export class AgentAlreadyRegisteredError extends RuntimeError {
  /** The ID of the agent that is already registered */
  public readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent "${agentId}" is already registered`, RuntimeErrorCodes.AGENT_ALREADY_REGISTERED);
    this.name = 'AgentAlreadyRegisteredError';
    this.agentId = agentId;
  }
}

/**
 * Error thrown when input validation fails.
 *
 * @example
 * ```typescript
 * if (!isValidEndpoint(endpoint)) {
 *   throw new ValidationError('Invalid endpoint URL format');
 * }
 * ```
 */
export class ValidationError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.VALIDATION_ERROR);
    this.name = 'ValidationError';
  }
}

/**
 * Error thrown when a rate limit is exceeded.
 *
 * @example
 * ```typescript
 * if (taskCount >= maxTasksPer24h) {
 *   throw new RateLimitError('task_creation', cooldownEnd);
 * }
 * ```
 */
export class RateLimitError extends RuntimeError {
  /** The type of rate limit that was exceeded */
  public readonly limitType: string;
  /** When the cooldown period ends */
  public readonly cooldownEnds: Date;

  constructor(limitType: string, cooldownEnds: Date) {
    super(
      `Rate limit exceeded for "${limitType}". Cooldown ends at ${cooldownEnds.toISOString()}`,
      RuntimeErrorCodes.RATE_LIMIT_ERROR
    );
    this.name = 'RateLimitError';
    this.limitType = limitType;
    this.cooldownEnds = cooldownEnds;
  }
}

/**
 * Error thrown when an agent has insufficient stake for an operation.
 *
 * @example
 * ```typescript
 * if (currentStake < requiredStake) {
 *   throw new InsufficientStakeError(requiredStake, currentStake);
 * }
 * ```
 */
export class InsufficientStakeError extends RuntimeError {
  /** The required stake amount in lamports */
  public readonly required: bigint;
  /** The available stake amount in lamports */
  public readonly available: bigint;

  constructor(required: bigint, available: bigint) {
    super(
      `Insufficient stake: required ${required} lamports, available ${available} lamports`,
      RuntimeErrorCodes.INSUFFICIENT_STAKE
    );
    this.name = 'InsufficientStakeError';
    this.required = required;
    this.available = available;
  }
}

/**
 * Error thrown when an agent has active tasks preventing an operation.
 *
 * @example
 * ```typescript
 * if (agent.activeTasks > 0) {
 *   throw new ActiveTasksError(agent.activeTasks);
 * }
 * ```
 */
export class ActiveTasksError extends RuntimeError {
  /** The number of active tasks */
  public readonly activeTaskCount: number;

  constructor(activeTaskCount: number) {
    super(
      `Agent has ${activeTaskCount} active ${activeTaskCount === 1 ? 'task' : 'tasks'} and cannot perform this operation`,
      RuntimeErrorCodes.ACTIVE_TASKS_ERROR
    );
    this.name = 'ActiveTasksError';
    this.activeTaskCount = activeTaskCount;
  }
}

/**
 * Error thrown when an agent has pending dispute votes.
 *
 * @example
 * ```typescript
 * if (pendingVotes > 0) {
 *   throw new PendingDisputeVotesError(pendingVotes);
 * }
 * ```
 */
export class PendingDisputeVotesError extends RuntimeError {
  /** The number of pending dispute votes */
  public readonly voteCount: number;

  constructor(voteCount: number) {
    super(
      `Agent has ${voteCount} pending dispute ${voteCount === 1 ? 'vote' : 'votes'} that must be resolved first`,
      RuntimeErrorCodes.PENDING_DISPUTE_VOTES
    );
    this.name = 'PendingDisputeVotesError';
    this.voteCount = voteCount;
  }
}

/**
 * Error thrown when an agent has recent vote activity.
 *
 * @example
 * ```typescript
 * const waitPeriod = 24 * 60 * 60 * 1000; // 24 hours
 * if (Date.now() - lastVote.getTime() < waitPeriod) {
 *   throw new RecentVoteActivityError(lastVote);
 * }
 * ```
 */
export class RecentVoteActivityError extends RuntimeError {
  /** The timestamp of the last vote */
  public readonly lastVoteTimestamp: Date;

  constructor(lastVoteTimestamp: Date) {
    super(
      `Agent must wait 24 hours after voting before performing this operation. Last vote: ${lastVoteTimestamp.toISOString()}`,
      RuntimeErrorCodes.RECENT_VOTE_ACTIVITY
    );
    this.name = 'RecentVoteActivityError';
    this.lastVoteTimestamp = lastVoteTimestamp;
  }
}

/**
 * Error thrown when a task cannot be found by its PDA.
 *
 * @example
 * ```typescript
 * throw new TaskNotFoundError(taskPda, 'Task account not found on chain');
 * ```
 */
export class TaskNotFoundError extends RuntimeError {
  /** The PDA of the task that was not found */
  public readonly taskPda: PublicKey;

  constructor(taskPda: PublicKey, message?: string) {
    super(message || 'Task not found', RuntimeErrorCodes.TASK_NOT_FOUND);
    this.name = 'TaskNotFoundError';
    this.taskPda = taskPda;
  }
}

/**
 * Error thrown when a task cannot be claimed by the executor.
 *
 * @example
 * ```typescript
 * throw new TaskNotClaimableError(taskPda, 'Task already has maximum workers');
 * ```
 */
export class TaskNotClaimableError extends RuntimeError {
  /** The PDA of the task that could not be claimed */
  public readonly taskPda: PublicKey;
  /** The reason the task is not claimable */
  public readonly reason: string;

  constructor(taskPda: PublicKey, reason: string) {
    super(`Task not claimable: ${reason}`, RuntimeErrorCodes.TASK_NOT_CLAIMABLE);
    this.name = 'TaskNotClaimableError';
    this.taskPda = taskPda;
    this.reason = reason;
  }
}

/**
 * Error thrown when task execution fails locally.
 *
 * @example
 * ```typescript
 * throw new TaskExecutionError(taskPda, 'Circuit generation failed');
 * ```
 */
export class TaskExecutionError extends RuntimeError {
  /** The PDA of the task that failed execution */
  public readonly taskPda: PublicKey;
  /** The cause of the execution failure */
  public readonly cause: string;

  constructor(taskPda: PublicKey, cause: string) {
    super(`Task execution failed: ${cause}`, RuntimeErrorCodes.TASK_EXECUTION_FAILED);
    this.name = 'TaskExecutionError';
    this.taskPda = taskPda;
    this.cause = cause;
  }
}

/**
 * Error thrown when task result submission fails on-chain.
 *
 * @example
 * ```typescript
 * throw new TaskSubmissionError(taskPda, 'Proof verification failed on-chain');
 * ```
 */
export class TaskSubmissionError extends RuntimeError {
  /** The PDA of the task whose submission failed */
  public readonly taskPda: PublicKey;
  /** The cause of the submission failure */
  public readonly cause: string;

  constructor(taskPda: PublicKey, cause: string) {
    super(`Task submission failed: ${cause}`, RuntimeErrorCodes.TASK_SUBMISSION_FAILED);
    this.name = 'TaskSubmissionError';
    this.taskPda = taskPda;
    this.cause = cause;
  }
}

/**
 * Error thrown when the executor state machine is in an invalid state.
 *
 * @example
 * ```typescript
 * throw new ExecutorStateError('Cannot execute task: executor not initialized');
 * ```
 */
export class ExecutorStateError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.EXECUTOR_STATE_ERROR);
    this.name = 'ExecutorStateError';
  }
}

/**
 * Error thrown when a task handler exceeds its execution timeout.
 *
 * @example
 * ```typescript
 * executor.on({
 *   onTaskTimeout: (error, taskPda) => {
 *     console.log(`Task ${taskPda.toBase58()} timed out after ${error.timeoutMs}ms`);
 *   },
 * });
 * ```
 */
export class TaskTimeoutError extends RuntimeError {
  /** The timeout duration in milliseconds that was exceeded */
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Task execution timed out after ${timeoutMs}ms`,
      RuntimeErrorCodes.TASK_TIMEOUT,
    );
    this.name = 'TaskTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when a task's on-chain claim deadline expires or is about to expire.
 *
 * @example
 * ```typescript
 * executor.on({
 *   onClaimExpiring: (error, taskPda) => {
 *     console.log(`Claim for ${taskPda.toBase58()} expiring: ${error.message}`);
 *   },
 * });
 * ```
 */
export class ClaimExpiredError extends RuntimeError {
  /** The claim expiry timestamp (Unix seconds) */
  public readonly expiresAt: number;
  /** The buffer in milliseconds that was configured */
  public readonly bufferMs: number;

  constructor(expiresAt: number, bufferMs: number) {
    super(
      `Claim deadline expiring: expires_at=${expiresAt}, buffer=${bufferMs}ms`,
      RuntimeErrorCodes.CLAIM_EXPIRED,
    );
    this.name = 'ClaimExpiredError';
    this.expiresAt = expiresAt;
    this.bufferMs = bufferMs;
  }
}

/**
 * Error thrown when all retry attempts have been exhausted for a pipeline stage.
 *
 * @example
 * ```typescript
 * executor.on({
 *   onTaskFailed: (error, taskPda) => {
 *     if (error instanceof RetryExhaustedError) {
 *       console.log(`Retries exhausted for ${error.stage} after ${error.attempts} attempts`);
 *     }
 *   },
 * });
 * ```
 */
export class RetryExhaustedError extends RuntimeError {
  /** The pipeline stage that exhausted retries */
  public readonly stage: string;
  /** The number of attempts made */
  public readonly attempts: number;
  /** The last error that caused the final retry to fail */
  public readonly lastError: Error;

  constructor(stage: string, attempts: number, lastError: Error) {
    super(
      `Retry exhausted for ${stage} after ${attempts} attempts: ${lastError.message}`,
      RuntimeErrorCodes.RETRY_EXHAUSTED,
    );
    this.name = 'RetryExhaustedError';
    this.stage = stage;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

// ============================================================================
// Parsed Anchor Error Type
// ============================================================================

/**
 * Structured representation of a parsed Anchor error.
 */
export interface ParsedAnchorError {
  /** The numeric error code */
  code: AnchorErrorCode;
  /** The error name (e.g., 'AgentNotFound') */
  name: AnchorErrorName;
  /** Human-readable error message */
  message: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Reverse lookup map from code to name */
const codeToNameMap: Map<number, AnchorErrorName> = new Map(
  (Object.entries(AnchorErrorCodes) as [AnchorErrorName, number][]).map(([name, code]) => [
    code,
    name,
  ])
);

/**
 * Check if an error matches a specific Anchor error code.
 *
 * Handles multiple error formats:
 * - Direct error code property
 * - Nested errorCode object
 * - Transaction logs containing error code
 * - Error message containing error code
 *
 * @example
 * ```typescript
 * try {
 *   await program.methods.claimTask().rpc();
 * } catch (err) {
 *   if (isAnchorError(err, AnchorErrorCodes.AlreadyClaimed)) {
 *     console.log('Task already claimed by this worker');
 *   } else if (isAnchorError(err, AnchorErrorCodes.TaskNotOpen)) {
 *     console.log('Task is not open for claims');
 *   }
 * }
 * ```
 *
 * @param error - The error to check
 * @param code - The Anchor error code to match
 * @returns True if the error matches the specified code
 */
export function isAnchorError(error: unknown, code: AnchorErrorCode): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as Record<string, unknown>;

  // Check direct code property
  if ('code' in err && err.code === code) {
    return true;
  }

  // Check Anchor SDK errorCode format: { errorCode: { code: string, number: number } }
  if ('errorCode' in err && typeof err.errorCode === 'object' && err.errorCode !== null) {
    const errorCode = err.errorCode as Record<string, unknown>;
    if ('number' in errorCode && errorCode.number === code) {
      return true;
    }
  }

  // Check for error.error format (nested error object)
  if ('error' in err && typeof err.error === 'object' && err.error !== null) {
    const innerError = err.error as Record<string, unknown>;
    if ('errorCode' in innerError && typeof innerError.errorCode === 'object') {
      const errorCode = innerError.errorCode as Record<string, unknown>;
      if ('number' in errorCode && errorCode.number === code) {
        return true;
      }
    }
  }

  // Check transaction logs for error code pattern
  if ('logs' in err && Array.isArray(err.logs)) {
    const errorPattern = new RegExp(`Error Code: \\w+\\. Error Number: ${code}\\.`);
    for (const log of err.logs) {
      if (typeof log === 'string' && errorPattern.test(log)) {
        return true;
      }
    }
  }

  // Check error message for error code
  if ('message' in err && typeof err.message === 'string') {
    // Match patterns like "custom program error: 0x1770" (hex) or "Error Number: 6000"
    const hexCode = `0x${code.toString(16)}`;
    if (
      err.message.includes(`custom program error: ${hexCode}`) ||
      err.message.includes(`Error Number: ${code}`)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Parse an error into a structured Anchor error format.
 *
 * @example
 * ```typescript
 * try {
 *   await program.methods.registerAgent().rpc();
 * } catch (err) {
 *   const parsed = parseAnchorError(err);
 *   if (parsed) {
 *     console.log(`Error ${parsed.code}: ${parsed.name} - ${parsed.message}`);
 *   }
 * }
 * ```
 *
 * @param error - The error to parse
 * @returns Parsed error object if it's an Anchor error, null otherwise
 */
export function parseAnchorError(error: unknown): ParsedAnchorError | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const err = error as Record<string, unknown>;
  let code: number | undefined;
  let name: AnchorErrorName | undefined;

  // Try to extract code from various formats

  // Format 1: Direct code property
  if ('code' in err && typeof err.code === 'number') {
    code = err.code;
  }

  // Format 2: Anchor SDK errorCode format
  if ('errorCode' in err && typeof err.errorCode === 'object' && err.errorCode !== null) {
    const errorCode = err.errorCode as Record<string, unknown>;
    if ('number' in errorCode && typeof errorCode.number === 'number') {
      code = errorCode.number;
    }
    if ('code' in errorCode && typeof errorCode.code === 'string') {
      name = errorCode.code as AnchorErrorName;
    }
  }

  // Format 3: Nested error.error format
  if (!code && 'error' in err && typeof err.error === 'object' && err.error !== null) {
    const innerError = err.error as Record<string, unknown>;
    if ('errorCode' in innerError && typeof innerError.errorCode === 'object') {
      const errorCode = innerError.errorCode as Record<string, unknown>;
      if ('number' in errorCode && typeof errorCode.number === 'number') {
        code = errorCode.number;
      }
      if ('code' in errorCode && typeof errorCode.code === 'string') {
        name = errorCode.code as AnchorErrorName;
      }
    }
  }

  // Format 4: Extract from logs
  if (!code && 'logs' in err && Array.isArray(err.logs)) {
    const errorPattern = /Error Code: (\w+)\. Error Number: (\d+)\./;
    for (const log of err.logs) {
      if (typeof log === 'string') {
        const match = log.match(errorPattern);
        if (match) {
          name = match[1] as AnchorErrorName;
          code = parseInt(match[2], 10);
          break;
        }
      }
    }
  }

  // Format 5: Extract from error message
  if (!code && 'message' in err && typeof err.message === 'string') {
    // Match hex pattern: "custom program error: 0x1770"
    const hexMatch = err.message.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (hexMatch) {
      code = parseInt(hexMatch[1], 16);
    }

    // Match decimal pattern: "Error Number: 6000"
    if (!code) {
      const decMatch = err.message.match(/Error Number: (\d+)/);
      if (decMatch) {
        code = parseInt(decMatch[1], 10);
      }
    }
  }

  // Validate code is in our known range
  if (code === undefined || code < 6000 || code > 6146) {
    return null;
  }

  // Look up name if not already found
  if (!name) {
    name = codeToNameMap.get(code);
  }

  // Final validation
  if (!name || !(name in AnchorErrorCodes)) {
    return null;
  }

  return {
    code: code as AnchorErrorCode,
    name,
    message: AnchorErrorMessages[code as AnchorErrorCode],
  };
}

/**
 * Get the error name for a given Anchor error code.
 *
 * @example
 * ```typescript
 * const name = getAnchorErrorName(6000);
 * console.log(name); // 'AgentAlreadyRegistered'
 * ```
 *
 * @param code - The error code to look up
 * @returns The error name, or undefined if not found
 */
export function getAnchorErrorName(code: number): AnchorErrorName | undefined {
  return codeToNameMap.get(code);
}

/**
 * Get the error message for a given Anchor error code.
 *
 * @example
 * ```typescript
 * const message = getAnchorErrorMessage(6000);
 * console.log(message); // 'Agent is already registered'
 * ```
 *
 * @param code - The error code to look up
 * @returns The error message, or undefined if not found
 */
export function getAnchorErrorMessage(code: AnchorErrorCode): string {
  return AnchorErrorMessages[code];
}

/**
 * Type guard to check if an error is a RuntimeError.
 *
 * @example
 * ```typescript
 * try {
 *   await runtime.doSomething();
 * } catch (err) {
 *   if (isRuntimeError(err)) {
 *     console.log(`Runtime error code: ${err.code}`);
 *   }
 * }
 * ```
 *
 * @param error - The error to check
 * @returns True if the error is a RuntimeError instance
 */
export function isRuntimeError(error: unknown): error is RuntimeError {
  return error instanceof RuntimeError;
}
