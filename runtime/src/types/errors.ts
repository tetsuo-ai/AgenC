/**
 * Error types and utilities for @agenc/runtime
 *
 * Provides custom runtime error classes, complete Anchor error code mapping,
 * and helper functions for error handling in AgenC applications.
 */

import type { PublicKey } from "@solana/web3.js";

// ============================================================================
// Runtime Error Codes
// ============================================================================

/**
 * String error codes for runtime-specific errors.
 * These are distinct from Anchor program errors.
 */
export const RuntimeErrorCodes = {
  /** Agent is not registered in the protocol */
  AGENT_NOT_REGISTERED: "AGENT_NOT_REGISTERED",
  /** Agent is already registered */
  AGENT_ALREADY_REGISTERED: "AGENT_ALREADY_REGISTERED",
  /** Input validation failed */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** Rate limit exceeded */
  RATE_LIMIT_ERROR: "RATE_LIMIT_ERROR",
  /** Insufficient stake for operation */
  INSUFFICIENT_STAKE: "INSUFFICIENT_STAKE",
  /** Agent has active tasks preventing operation */
  ACTIVE_TASKS_ERROR: "ACTIVE_TASKS_ERROR",
  /** Agent has pending dispute votes */
  PENDING_DISPUTE_VOTES: "PENDING_DISPUTE_VOTES",
  /** Agent has recent vote activity */
  RECENT_VOTE_ACTIVITY: "RECENT_VOTE_ACTIVITY",
  /** Task not found by PDA */
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  /** Task is not claimable */
  TASK_NOT_CLAIMABLE: "TASK_NOT_CLAIMABLE",
  /** Task execution failed locally */
  TASK_EXECUTION_FAILED: "TASK_EXECUTION_FAILED",
  /** Task result submission failed on-chain */
  TASK_SUBMISSION_FAILED: "TASK_SUBMISSION_FAILED",
  /** Executor state machine is in an invalid state */
  EXECUTOR_STATE_ERROR: "EXECUTOR_STATE_ERROR",
  /** Task execution timed out */
  TASK_TIMEOUT: "TASK_TIMEOUT",
  /** Claim deadline expired or about to expire */
  CLAIM_EXPIRED: "CLAIM_EXPIRED",
  /** All retry attempts exhausted */
  RETRY_EXHAUSTED: "RETRY_EXHAUSTED",
  /** LLM provider returned an error */
  LLM_PROVIDER_ERROR: "LLM_PROVIDER_ERROR",
  /** LLM provider rate limit exceeded */
  LLM_RATE_LIMIT: "LLM_RATE_LIMIT",
  /** Failed to convert LLM response to output */
  LLM_RESPONSE_CONVERSION: "LLM_RESPONSE_CONVERSION",
  /** LLM tool call failed */
  LLM_TOOL_CALL_ERROR: "LLM_TOOL_CALL_ERROR",
  /** LLM request timed out */
  LLM_TIMEOUT: "LLM_TIMEOUT",
  /** Memory backend operation failure */
  MEMORY_BACKEND_ERROR: "MEMORY_BACKEND_ERROR",
  /** Memory backend connection failure or missing dependency */
  MEMORY_CONNECTION_ERROR: "MEMORY_CONNECTION_ERROR",
  /** Memory serialization/deserialization failure */
  MEMORY_SERIALIZATION_ERROR: "MEMORY_SERIALIZATION_ERROR",
  /** ZK proof generation failed */
  PROOF_GENERATION_ERROR: "PROOF_GENERATION_ERROR",
  /** ZK proof verification failed */
  PROOF_VERIFICATION_ERROR: "PROOF_VERIFICATION_ERROR",
  /** Proof cache operation failed */
  PROOF_CACHE_ERROR: "PROOF_CACHE_ERROR",
  /** Dispute not found by PDA */
  DISPUTE_NOT_FOUND: "DISPUTE_NOT_FOUND",
  /** Dispute vote operation failed */
  DISPUTE_VOTE_ERROR: "DISPUTE_VOTE_ERROR",
  /** Dispute resolution operation failed */
  DISPUTE_RESOLUTION_ERROR: "DISPUTE_RESOLUTION_ERROR",
  /** Dispute slash operation failed */
  DISPUTE_SLASH_ERROR: "DISPUTE_SLASH_ERROR",
  /** Workflow definition failed validation */
  WORKFLOW_VALIDATION_ERROR: "WORKFLOW_VALIDATION_ERROR",
  /** Workflow on-chain task submission failed */
  WORKFLOW_SUBMISSION_ERROR: "WORKFLOW_SUBMISSION_ERROR",
  /** Workflow event subscription or polling failed */
  WORKFLOW_MONITORING_ERROR: "WORKFLOW_MONITORING_ERROR",
  /** Workflow state transition or lookup failed */
  WORKFLOW_STATE_ERROR: "WORKFLOW_STATE_ERROR",
  /** Team contract definition failed validation */
  TEAM_CONTRACT_VALIDATION_ERROR: "TEAM_CONTRACT_VALIDATION_ERROR",
  /** Team contract state transition or lifecycle operation failed */
  TEAM_CONTRACT_STATE_ERROR: "TEAM_CONTRACT_STATE_ERROR",
  /** Team payout configuration or computation failed */
  TEAM_PAYOUT_ERROR: "TEAM_PAYOUT_ERROR",
  /** Team workflow topology is not launch-compatible */
  TEAM_WORKFLOW_TOPOLOGY_ERROR: "TEAM_WORKFLOW_TOPOLOGY_ERROR",
  /** Marketplace bid input validation failed */
  MARKETPLACE_VALIDATION_ERROR: "MARKETPLACE_VALIDATION_ERROR",
  /** Marketplace lifecycle state transition failed */
  MARKETPLACE_STATE_ERROR: "MARKETPLACE_STATE_ERROR",
  /** Marketplace authorization failed */
  MARKETPLACE_AUTHORIZATION_ERROR: "MARKETPLACE_AUTHORIZATION_ERROR",
  /** Marketplace matching/scoring operation failed */
  MARKETPLACE_MATCHING_ERROR: "MARKETPLACE_MATCHING_ERROR",
  /** RPC connection error (timeout, server error, etc.) */
  CONNECTION_ERROR: "CONNECTION_ERROR",
  /** All configured RPC endpoints are unhealthy */
  ALL_ENDPOINTS_UNHEALTHY: "ALL_ENDPOINTS_UNHEALTHY",
  /** Telemetry system error */
  TELEMETRY_ERROR: "TELEMETRY_ERROR",
  /** Gateway configuration validation failed */
  GATEWAY_VALIDATION_ERROR: "GATEWAY_VALIDATION_ERROR",
  /** Gateway WebSocket or file system connection error */
  GATEWAY_CONNECTION_ERROR: "GATEWAY_CONNECTION_ERROR",
  /** Gateway invalid lifecycle state transition */
  GATEWAY_STATE_ERROR: "GATEWAY_STATE_ERROR",
  /** Gateway start/stop lifecycle failure */
  GATEWAY_LIFECYCLE_ERROR: "GATEWAY_LIFECYCLE_ERROR",
  /** Workspace configuration validation failed */
  WORKSPACE_VALIDATION_ERROR: "WORKSPACE_VALIDATION_ERROR",
  /** Chat session token budget exceeded */
  CHAT_BUDGET_EXCEEDED: "CHAT_BUDGET_EXCEEDED",
  /** Governance proposal not found */
  GOVERNANCE_PROPOSAL_NOT_FOUND: "GOVERNANCE_PROPOSAL_NOT_FOUND",
  /** Governance vote operation failed */
  GOVERNANCE_VOTE_ERROR: "GOVERNANCE_VOTE_ERROR",
  /** Governance proposal execution failed */
  GOVERNANCE_EXECUTION_ERROR: "GOVERNANCE_EXECUTION_ERROR",
  /** Identity link code has expired */
  IDENTITY_LINK_EXPIRED: "IDENTITY_LINK_EXPIRED",
  /** Identity link code not found */
  IDENTITY_LINK_NOT_FOUND: "IDENTITY_LINK_NOT_FOUND",
  /** Cannot link an account to itself */
  IDENTITY_SELF_LINK: "IDENTITY_SELF_LINK",
  /** Ed25519 signature verification failed for identity linking */
  IDENTITY_SIGNATURE_INVALID: "IDENTITY_SIGNATURE_INVALID",
  /** Identity input validation failed */
  IDENTITY_VALIDATION_ERROR: "IDENTITY_VALIDATION_ERROR",
  /** Heartbeat scheduler invalid lifecycle state transition */
  HEARTBEAT_STATE_ERROR: "HEARTBEAT_STATE_ERROR",
  /** Heartbeat action execution failed */
  HEARTBEAT_ACTION_FAILED: "HEARTBEAT_ACTION_FAILED",
  /** Heartbeat action exceeded timeout */
  HEARTBEAT_TIMEOUT: "HEARTBEAT_TIMEOUT",
  /** Skill not found in on-chain registry */
  SKILL_REGISTRY_NOT_FOUND: "SKILL_REGISTRY_NOT_FOUND",
  /** Skill download from content gateway failed */
  SKILL_DOWNLOAD_ERROR: "SKILL_DOWNLOAD_ERROR",
  /** Skill content hash verification failed */
  SKILL_VERIFICATION_ERROR: "SKILL_VERIFICATION_ERROR",
  /** Skill publish operation failed */
  SKILL_PUBLISH_ERROR: "SKILL_PUBLISH_ERROR",
  /** Skill purchase operation failed */
  SKILL_PURCHASE_ERROR: "SKILL_PURCHASE_ERROR",
  /** Docker sandbox command execution failed */
  SANDBOX_EXECUTION_ERROR: "SANDBOX_EXECUTION_ERROR",
  /** Docker daemon is not available or not running */
  SANDBOX_UNAVAILABLE: "SANDBOX_UNAVAILABLE",
  /** Agent discovery query failed */
  DISCOVERY_ERROR: "DISCOVERY_ERROR",
  /** Speech-to-text transcription failed */
  VOICE_TRANSCRIPTION_ERROR: "VOICE_TRANSCRIPTION_ERROR",
  /** Text-to-speech synthesis failed */
  VOICE_SYNTHESIS_ERROR: "VOICE_SYNTHESIS_ERROR",
  /** Real-time voice session error (xAI Realtime API) */
  VOICE_REALTIME_ERROR: "VOICE_REALTIME_ERROR",
  /** Cross-protocol bridge operation failed */
  BRIDGE_ERROR: "BRIDGE_ERROR",
  /** x402 payment transfer failed */
  BRIDGE_PAYMENT_ERROR: "BRIDGE_PAYMENT_ERROR",
  /** Sub-agent spawning or setup failed */
  SUB_AGENT_SPAWN_ERROR: "SUB_AGENT_SPAWN_ERROR",
  /** Sub-agent execution exceeded configured timeout */
  SUB_AGENT_TIMEOUT: "SUB_AGENT_TIMEOUT",
  /** Sub-agent session ID not found */
  SUB_AGENT_NOT_FOUND: "SUB_AGENT_NOT_FOUND",
  /** Messaging send failed (on-chain tx or off-chain delivery) */
  MESSAGING_SEND_ERROR: "MESSAGING_SEND_ERROR",
  /** Messaging off-chain connection failed */
  MESSAGING_CONNECTION_ERROR: "MESSAGING_CONNECTION_ERROR",
  /** Messaging Ed25519 signature verification failed */
  MESSAGING_SIGNATURE_ERROR: "MESSAGING_SIGNATURE_ERROR",
  /** Feed post operation failed */
  FEED_POST_ERROR: "FEED_POST_ERROR",
  /** Feed upvote operation failed */
  FEED_UPVOTE_ERROR: "FEED_UPVOTE_ERROR",
  /** Feed query operation failed */
  FEED_QUERY_ERROR: "FEED_QUERY_ERROR",
  /** Reputation scoring computation failed */
  REPUTATION_SCORING_ERROR: "REPUTATION_SCORING_ERROR",
  /** Reputation event tracking or history query failed */
  REPUTATION_TRACKING_ERROR: "REPUTATION_TRACKING_ERROR",
  /** Collaboration request creation or retrieval failed */
  COLLABORATION_REQUEST_ERROR: "COLLABORATION_REQUEST_ERROR",
  /** Collaboration response send or processing failed */
  COLLABORATION_RESPONSE_ERROR: "COLLABORATION_RESPONSE_ERROR",
  /** Team formation from collaboration failed */
  COLLABORATION_FORMATION_ERROR: "COLLABORATION_FORMATION_ERROR",
  /** Skill subscription lifecycle operation failed */
  SKILL_SUBSCRIPTION_ERROR: "SKILL_SUBSCRIPTION_ERROR",
  /** Skill revenue share computation failed */
  SKILL_REVENUE_ERROR: "SKILL_REVENUE_ERROR",
  /** Remote Gateway authentication failed */
  REMOTE_AUTH_ERROR: "REMOTE_AUTH_ERROR",
  /** Reputation staking operation failed */
  REPUTATION_STAKE_ERROR: "REPUTATION_STAKE_ERROR",
  /** Reputation delegation operation failed */
  REPUTATION_DELEGATION_ERROR: "REPUTATION_DELEGATION_ERROR",
  /** Reputation withdrawal operation failed */
  REPUTATION_WITHDRAW_ERROR: "REPUTATION_WITHDRAW_ERROR",
  /** Reputation portability proof operation failed */
  REPUTATION_PORTABILITY_ERROR: "REPUTATION_PORTABILITY_ERROR",
  /** Desktop sandbox container lifecycle error (create, start, stop, destroy) */
  DESKTOP_SANDBOX_LIFECYCLE_ERROR: "DESKTOP_SANDBOX_LIFECYCLE_ERROR",
  /** Desktop sandbox container health check failed */
  DESKTOP_SANDBOX_HEALTH_ERROR: "DESKTOP_SANDBOX_HEALTH_ERROR",
  /** Desktop sandbox REST API connection failed */
  DESKTOP_SANDBOX_CONNECTION_ERROR: "DESKTOP_SANDBOX_CONNECTION_ERROR",
  /** Desktop sandbox pool at max capacity */
  DESKTOP_SANDBOX_POOL_EXHAUSTED: "DESKTOP_SANDBOX_POOL_EXHAUSTED",
} as const;

/** Union type of all runtime error code values */
export type RuntimeErrorCode =
  (typeof RuntimeErrorCodes)[keyof typeof RuntimeErrorCodes];

// ============================================================================
// Anchor Error Codes (199 codes: 6000-6198)
// ============================================================================

/**
 * Numeric error codes matching the Anchor program's CoordinationError enum.
 * Source of truth: runtime/idl/agenc_coordination.json (errors[]).
 */
export const AnchorErrorCodes = {
  AgentAlreadyRegistered: 6000,
  AgentNotFound: 6001,
  AgentNotActive: 6002,
  InsufficientCapabilities: 6003,
  InvalidCapabilities: 6004,
  MaxActiveTasksReached: 6005,
  AgentHasActiveTasks: 6006,
  UnauthorizedAgent: 6007,
  CreatorAuthorityMismatch: 6008,
  InvalidAgentId: 6009,
  AgentRegistrationRequired: 6010,
  AgentSuspended: 6011,
  AgentBusyWithTasks: 6012,
  TaskNotFound: 6013,
  TaskNotOpen: 6014,
  TaskFullyClaimed: 6015,
  TaskExpired: 6016,
  TaskNotExpired: 6017,
  DeadlinePassed: 6018,
  TaskNotInProgress: 6019,
  TaskAlreadyCompleted: 6020,
  TaskCannotBeCancelled: 6021,
  UnauthorizedTaskAction: 6022,
  InvalidCreator: 6023,
  InvalidTaskId: 6024,
  InvalidDescription: 6025,
  InvalidMaxWorkers: 6026,
  InvalidTaskType: 6027,
  InvalidDeadline: 6028,
  InvalidReward: 6029,
  InvalidRequiredCapabilities: 6030,
  CompetitiveTaskAlreadyWon: 6031,
  NoWorkers: 6032,
  ConstraintHashMismatch: 6033,
  NotPrivateTask: 6034,
  AlreadyClaimed: 6035,
  NotClaimed: 6036,
  ClaimAlreadyCompleted: 6037,
  ClaimNotExpired: 6038,
  ClaimExpired: 6039,
  InvalidExpiration: 6040,
  InvalidProof: 6041,
  ZkVerificationFailed: 6042,
  InvalidSealEncoding: 6043,
  InvalidJournalLength: 6044,
  InvalidJournalBinding: 6045,
  InvalidJournalTask: 6046,
  InvalidJournalAuthority: 6047,
  InvalidImageId: 6048,
  TrustedSelectorMismatch: 6049,
  TrustedVerifierProgramMismatch: 6050,
  RouterAccountMismatch: 6051,
  InvalidProofSize: 6052,
  InvalidProofBinding: 6053,
  InvalidOutputCommitment: 6054,
  InvalidRentRecipient: 6055,
  GracePeriodNotPassed: 6056,
  InvalidProofHash: 6057,
  InvalidResultData: 6058,
  DisputeNotActive: 6059,
  VotingEnded: 6060,
  VotingNotEnded: 6061,
  AlreadyVoted: 6062,
  NotArbiter: 6063,
  InsufficientVotes: 6064,
  DisputeAlreadyResolved: 6065,
  UnauthorizedResolver: 6066,
  ActiveDisputeVotes: 6067,
  RecentVoteActivity: 6068,
  AuthorityAlreadyVoted: 6069,
  InsufficientEvidence: 6070,
  EvidenceTooLong: 6071,
  DisputeNotExpired: 6072,
  SlashAlreadyApplied: 6073,
  SlashWindowExpired: 6074,
  DisputeNotResolved: 6075,
  NotTaskParticipant: 6076,
  InvalidEvidenceHash: 6077,
  ArbiterIsDisputeParticipant: 6078,
  InsufficientQuorum: 6079,
  ActiveDisputesExist: 6080,
  TooManyDisputeVoters: 6081,
  WorkerAgentRequired: 6082,
  WorkerClaimRequired: 6083,
  WorkerNotInDispute: 6084,
  InitiatorCannotResolve: 6085,
  VersionMismatch: 6086,
  StateKeyExists: 6087,
  StateNotFound: 6088,
  InvalidStateValue: 6089,
  StateOwnershipViolation: 6090,
  InvalidStateKey: 6091,
  ProtocolAlreadyInitialized: 6092,
  ProtocolNotInitialized: 6093,
  InvalidProtocolFee: 6094,
  InvalidTreasury: 6095,
  InvalidDisputeThreshold: 6096,
  InsufficientStake: 6097,
  MultisigInvalidThreshold: 6098,
  MultisigInvalidSigners: 6099,
  MultisigNotEnoughSigners: 6100,
  MultisigDuplicateSigner: 6101,
  MultisigDefaultSigner: 6102,
  MultisigSignerNotSystemOwned: 6103,
  InvalidInput: 6104,
  ArithmeticOverflow: 6105,
  VoteOverflow: 6106,
  InsufficientFunds: 6107,
  RewardTooSmall: 6108,
  CorruptedData: 6109,
  StringTooLong: 6110,
  InvalidAccountOwner: 6111,
  RateLimitExceeded: 6112,
  CooldownNotElapsed: 6113,
  UpdateTooFrequent: 6114,
  InvalidCooldown: 6115,
  CooldownTooLarge: 6116,
  RateLimitTooHigh: 6117,
  CooldownTooLong: 6118,
  InsufficientStakeForDispute: 6119,
  InsufficientStakeForCreatorDispute: 6120,
  VersionMismatchProtocol: 6121,
  AccountVersionTooOld: 6122,
  AccountVersionTooNew: 6123,
  InvalidMigrationSource: 6124,
  InvalidMigrationTarget: 6125,
  UnauthorizedUpgrade: 6126,
  InvalidMinVersion: 6127,
  ProtocolConfigRequired: 6128,
  ParentTaskCancelled: 6129,
  ParentTaskDisputed: 6130,
  InvalidDependencyType: 6131,
  ParentTaskNotCompleted: 6132,
  ParentTaskAccountRequired: 6133,
  UnauthorizedCreator: 6134,
  NullifierAlreadySpent: 6135,
  InvalidNullifier: 6136,
  IncompleteWorkerAccounts: 6137,
  WorkerAccountsRequired: 6138,
  DuplicateArbiter: 6139,
  InsufficientEscrowBalance: 6140,
  InvalidStatusTransition: 6141,
  StakeTooLow: 6142,
  InvalidMinStake: 6143,
  InvalidSlashAmount: 6144,
  BondAmountTooLow: 6145,
  BondAlreadyExists: 6146,
  BondNotFound: 6147,
  BondNotMatured: 6148,
  InsufficientReputation: 6149,
  InvalidMinReputation: 6150,
  DevelopmentKeyNotAllowed: 6151,
  SelfTaskNotAllowed: 6152,
  MissingTokenAccounts: 6153,
  InvalidTokenEscrow: 6154,
  InvalidTokenMint: 6155,
  TokenTransferFailed: 6156,
  ProposalNotActive: 6157,
  ProposalVotingNotEnded: 6158,
  ProposalVotingEnded: 6159,
  ProposalAlreadyExecuted: 6160,
  ProposalInsufficientQuorum: 6161,
  ProposalNotApproved: 6162,
  ProposalUnauthorizedCancel: 6163,
  ProposalInsufficientStake: 6164,
  InvalidProposalPayload: 6165,
  InvalidProposalType: 6166,
  TreasuryInsufficientBalance: 6167,
  TimelockNotElapsed: 6168,
  InvalidGovernanceParam: 6169,
  TreasuryNotProgramOwned: 6170,
  TreasuryNotSpendable: 6171,
  SkillInvalidId: 6172,
  SkillInvalidName: 6173,
  SkillInvalidContentHash: 6174,
  SkillNotActive: 6175,
  SkillInvalidRating: 6176,
  SkillSelfRating: 6177,
  SkillUnauthorizedUpdate: 6178,
  SkillSelfPurchase: 6179,
  FeedInvalidContentHash: 6180,
  FeedInvalidTopic: 6181,
  FeedPostNotFound: 6182,
  FeedSelfUpvote: 6183,
  ReputationStakeAmountTooLow: 6184,
  ReputationStakeLocked: 6185,
  ReputationStakeInsufficientBalance: 6186,
  ReputationDelegationAmountInvalid: 6187,
  ReputationCannotDelegateSelf: 6188,
  ReputationDelegationExpired: 6189,
  ReputationAgentNotActive: 6190,
  ReputationDisputesPending: 6191,
  PrivateTaskRequiresZkProof: 6192,
  InvalidTokenAccountOwner: 6193,
  InsufficientSeedEntropy: 6194,
  SkillPriceBelowMinimum: 6195,
  SkillPriceChanged: 6196,
  DelegationCooldownNotElapsed: 6197,
  RateLimitBelowMinimum: 6198,
} as const;

/** Union type of all Anchor error code values */
export type AnchorErrorCode =
  (typeof AnchorErrorCodes)[keyof typeof AnchorErrorCodes];

/** Union type of all Anchor error names */
export type AnchorErrorName = keyof typeof AnchorErrorCodes;

// ============================================================================
// Error Messages Mapping
// ============================================================================

/** Human-readable messages for each Anchor error code */
const AnchorErrorMessages: Record<AnchorErrorCode, string> = {
  6000: "Agent is already registered",
  6001: "Agent not found",
  6002: "Agent is not active",
  6003: "Agent has insufficient capabilities",
  6004: "Agent capabilities bitmask cannot be zero",
  6005: "Agent has reached maximum active tasks",
  6006: "Agent has active tasks and cannot be deregistered",
  6007: "Only the agent authority can perform this action",
  6008: "Creator must match authority to prevent social engineering",
  6009: "Invalid agent ID: agent_id cannot be all zeros",
  6010: "Agent registration required to create tasks",
  6011: "Agent is suspended and cannot change status",
  6012: "Agent cannot set status to Active while having active tasks",
  6013: "Task not found",
  6014: "Task is not open for claims",
  6015: "Task has reached maximum workers",
  6016: "Task has expired",
  6017: "Task deadline has not passed",
  6018: "Task deadline has passed",
  6019: "Task is not in progress",
  6020: "Task is already completed",
  6021: "Task cannot be cancelled",
  6022: "Only the task creator can perform this action",
  6023: "Invalid creator",
  6024: "Invalid task ID: cannot be zero",
  6025: "Invalid description: cannot be empty",
  6026: "Invalid max workers: must be between 1 and 100",
  6027: "Invalid task type",
  6028: "Invalid deadline: deadline must be greater than zero",
  6029: "Invalid reward: reward must be greater than zero",
  6030: "Invalid required capabilities: required_capabilities cannot be zero",
  6031: "Competitive task already completed by another worker",
  6032: "Task has no workers",
  6033: "Proof constraint hash does not match task's stored constraint hash",
  6034: "Task is not a private task (no constraint hash set)",
  6035: "Worker has already claimed this task",
  6036: "Worker has not claimed this task",
  6037: "Claim has already been completed",
  6038: "Claim has not expired yet",
  6039: "Claim has expired",
  6040: "Invalid expiration: expires_at cannot be zero",
  6041: "Invalid proof of work",
  6042: "ZK proof verification failed",
  6043: "Invalid RISC0 seal encoding",
  6044: "Invalid RISC0 journal length",
  6045: "Invalid RISC0 journal binding",
  6046: "RISC0 journal task binding mismatch",
  6047: "RISC0 journal authority binding mismatch",
  6048: "Invalid RISC0 image ID",
  6049: "RISC0 seal selector does not match trusted selector",
  6050: "RISC0 verifier program does not match trusted verifier",
  6051: "RISC0 router account constraints failed",
  6052: "Invalid proof size - expected 256 bytes for RISC Zero seal body",
  6053: "Invalid proof binding: expected_binding cannot be all zeros",
  6054: "Invalid output commitment: output_commitment cannot be all zeros",
  6055: "Invalid rent recipient: must be worker authority",
  6056: "Grace period not passed: only worker authority can expire claim within 60 seconds of expiry",
  6057: "Invalid proof hash: proof_hash cannot be all zeros",
  6058: "Invalid result data: result_data cannot be all zeros when provided",
  6059: "Dispute is not active",
  6060: "Voting period has ended",
  6061: "Voting period has not ended",
  6062: "Already voted on this dispute",
  6063: "Not authorized to vote (not an arbiter)",
  6064: "Insufficient votes to resolve",
  6065: "Dispute has already been resolved",
  6066: "Only protocol authority or dispute initiator can resolve disputes",
  6067: "Agent has active dispute votes pending resolution",
  6068: "Agent must wait 24 hours after voting before deregistering",
  6069: "Authority has already voted on this dispute",
  6070: "Insufficient dispute evidence provided",
  6071: "Dispute evidence exceeds maximum allowed length",
  6072: "Dispute has not expired",
  6073: "Dispute slashing already applied",
  6074: "Slash window expired: must apply slashing within 7 days of resolution",
  6075: "Dispute has not been resolved",
  6076: "Only task creator or workers can initiate disputes",
  6077: "Invalid evidence hash: cannot be all zeros",
  6078: "Arbiter cannot vote on disputes they are a participant in",
  6079: "Insufficient quorum: minimum number of voters not reached",
  6080: "Agent has active disputes as defendant and cannot deregister",
  6081: "Dispute has reached maximum voter capacity",
  6082: "Worker agent account required when creator initiates dispute",
  6083: "Worker claim account required when creator initiates dispute",
  6084: "Worker was not involved in this dispute",
  6085: "Dispute initiator cannot resolve their own dispute",
  6086: "State version mismatch (concurrent modification)",
  6087: "State key already exists",
  6088: "State not found",
  6089: "Invalid state value: state_value cannot be all zeros",
  6090: "State ownership violation: only the creator agent can update this state",
  6091: "Invalid state key: state_key cannot be all zeros",
  6092: "Protocol is already initialized",
  6093: "Protocol is not initialized",
  6094: "Invalid protocol fee (must be <= 1000 bps)",
  6095: "Invalid treasury: treasury account cannot be default pubkey",
  6096: "Invalid dispute threshold: must be 1-100 (percentage of votes required)",
  6097: "Insufficient stake for arbiter registration",
  6098: "Invalid multisig threshold",
  6099: "Invalid multisig signer configuration",
  6100: "Not enough multisig signers",
  6101: "Duplicate multisig signer provided",
  6102: "Multisig signer cannot be default pubkey",
  6103: "Multisig signer account not owned by System Program",
  6104: "Invalid input parameter",
  6105: "Arithmetic overflow",
  6106: "Vote count overflow",
  6107: "Insufficient funds",
  6108: "Reward too small: worker must receive at least 1 lamport",
  6109: "Account data is corrupted",
  6110: "String too long",
  6111: "Account owner validation failed: account not owned by this program",
  6112: "Rate limit exceeded: maximum actions per 24h window reached",
  6113: "Cooldown period has not elapsed since last action",
  6114: "Agent update too frequent: must wait cooldown period",
  6115: "Cooldown value cannot be negative",
  6116: "Cooldown value exceeds maximum (24 hours)",
  6117: "Rate limit value exceeds maximum allowed (1000)",
  6118: "Cooldown value exceeds maximum allowed (1 week)",
  6119: "Insufficient stake to initiate dispute",
  6120: "Creator-initiated disputes require 2x the minimum stake",
  6121: "Protocol version mismatch: account version incompatible with current program",
  6122: "Account version too old: migration required",
  6123: "Account version too new: program upgrade required",
  6124: "Migration not allowed: invalid source version",
  6125: "Migration not allowed: invalid target version",
  6126: "Only upgrade authority can perform this action",
  6127: "Minimum version cannot exceed current protocol version",
  6128: "Protocol config account required: suspending an agent requires the protocol config PDA in remaining_accounts",
  6129: "Parent task has been cancelled",
  6130: "Parent task is in disputed state",
  6131: "Invalid dependency type",
  6132: "Parent task must be completed before completing a proof-dependent task",
  6133: "Parent task account required for proof-dependent task completion",
  6134: "Parent task does not belong to the same creator",
  6135: "Nullifier has already been spent - proof/knowledge reuse detected",
  6136: "Invalid nullifier: nullifier value cannot be all zeros",
  6137: "All worker accounts must be provided when cancelling a task with active claims",
  6138: "Worker accounts required when task has active workers",
  6139: "Duplicate arbiter provided in remaining_accounts",
  6140: "Escrow has insufficient balance for reward transfer",
  6141: "Invalid task status transition",
  6142: "Stake value is below minimum required (0.001 SOL)",
  6143: "min_stake_for_dispute must be greater than zero",
  6144: "Slash amount must be greater than zero",
  6145: "Bond amount too low",
  6146: "Bond already exists",
  6147: "Bond not found",
  6148: "Bond not yet matured",
  6149: "Agent reputation below task minimum requirement",
  6150: "Invalid minimum reputation: must be <= 10000",
  6151: "Development verifying key detected (gamma == delta). ZK proofs are forgeable. Run MPC ceremony before use.",
  6152: "Cannot claim own task: worker authority matches task creator",
  6153: "Token accounts not provided for token-denominated task",
  6154: "Token escrow ATA does not match expected derivation",
  6155: "Provided mint does not match task's reward_mint",
  6156: "SPL token transfer CPI failed",
  6157: "Proposal is not active",
  6158: "Voting period has not ended",
  6159: "Voting period has ended",
  6160: "Proposal has already been executed",
  6161: "Insufficient quorum for proposal execution",
  6162: "Proposal did not achieve majority",
  6163: "Only the proposer can cancel this proposal",
  6164: "Insufficient stake to create a proposal",
  6165: "Invalid proposal payload",
  6166: "Invalid proposal type",
  6167: "Treasury spend amount exceeds available balance",
  6168: "Execution timelock has not elapsed",
  6169: "Invalid governance configuration parameter",
  6170: "Treasury must be a program-owned PDA",
  6171: "Treasury must be program-owned, or a signer system account for governance spends",
  6172: "Skill ID cannot be all zeros",
  6173: "Skill name cannot be all zeros",
  6174: "Skill content hash cannot be all zeros",
  6175: "Skill is not active",
  6176: "Rating must be between 1 and 5",
  6177: "Cannot rate own skill",
  6178: "Only the skill author can update this skill",
  6179: "Cannot purchase own skill",
  6180: "Feed content hash cannot be all zeros",
  6181: "Feed topic cannot be all zeros",
  6182: "Feed post not found",
  6183: "Cannot upvote own post",
  6184: "Reputation stake amount must be greater than zero",
  6185: "Reputation stake is locked: withdrawal before cooldown",
  6186: "Reputation stake has insufficient balance for withdrawal",
  6187: "Reputation delegation amount invalid: must be > 0, <= 10000, and >= MIN_DELEGATION_AMOUNT",
  6188: "Cannot delegate reputation to self",
  6189: "Reputation delegation has expired",
  6190: "Agent must be Active to participate in reputation economy",
  6191: "Agent has pending disputes as defendant: cannot withdraw stake",
  6192: "Private tasks (non-zero constraint_hash) must use complete_task_private",
  6193: "Token account owner does not match expected authority",
  6194: "Binding or nullifier seed has insufficient byte diversity (min 8 distinct bytes required)",
  6195: "Skill price below minimum required",
  6196: "Skill price changed since transaction was prepared",
  6197: "Delegation must be active for minimum duration before revocation",
  6198: "Rate limit value below protocol minimum",
};

const ANCHOR_ERROR_MIN_CODE = 6000;
const ANCHOR_ERROR_MAX_CODE = 6198;

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
      `Invalid ${paramName}: expected ${expectedLength} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

/**
 * Validates that a byte array is not all zeros.
 * @throws ValidationError if all bytes are zero
 */
export function validateNonZeroBytes(
  value: Uint8Array,
  paramName: string,
): void {
  if (value.every((b) => b === 0)) {
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
    this.name = "RuntimeError";
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
    super(
      "Agent is not registered in the protocol",
      RuntimeErrorCodes.AGENT_NOT_REGISTERED,
    );
    this.name = "AgentNotRegisteredError";
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
    super(
      `Agent "${agentId}" is already registered`,
      RuntimeErrorCodes.AGENT_ALREADY_REGISTERED,
    );
    this.name = "AgentAlreadyRegisteredError";
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
    this.name = "ValidationError";
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
      RuntimeErrorCodes.RATE_LIMIT_ERROR,
    );
    this.name = "RateLimitError";
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
      RuntimeErrorCodes.INSUFFICIENT_STAKE,
    );
    this.name = "InsufficientStakeError";
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
      `Agent has ${activeTaskCount} active ${activeTaskCount === 1 ? "task" : "tasks"} and cannot perform this operation`,
      RuntimeErrorCodes.ACTIVE_TASKS_ERROR,
    );
    this.name = "ActiveTasksError";
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
      `Agent has ${voteCount} pending dispute ${voteCount === 1 ? "vote" : "votes"} that must be resolved first`,
      RuntimeErrorCodes.PENDING_DISPUTE_VOTES,
    );
    this.name = "PendingDisputeVotesError";
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
      RuntimeErrorCodes.RECENT_VOTE_ACTIVITY,
    );
    this.name = "RecentVoteActivityError";
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
    super(message || "Task not found", RuntimeErrorCodes.TASK_NOT_FOUND);
    this.name = "TaskNotFoundError";
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
    super(
      `Task not claimable: ${reason}`,
      RuntimeErrorCodes.TASK_NOT_CLAIMABLE,
    );
    this.name = "TaskNotClaimableError";
    this.taskPda = taskPda;
    this.reason = reason;
  }
}

/**
 * Error thrown when task execution fails locally.
 *
 * @example
 * ```typescript
 * throw new TaskExecutionError(taskPda, 'Proof generation failed');
 * ```
 */
export class TaskExecutionError extends RuntimeError {
  /** The PDA of the task that failed execution */
  public readonly taskPda: PublicKey;
  /** The cause of the execution failure */
  public readonly cause: string;

  constructor(taskPda: PublicKey, cause: string) {
    super(
      `Task execution failed: ${cause}`,
      RuntimeErrorCodes.TASK_EXECUTION_FAILED,
    );
    this.name = "TaskExecutionError";
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
    super(
      `Task submission failed: ${cause}`,
      RuntimeErrorCodes.TASK_SUBMISSION_FAILED,
    );
    this.name = "TaskSubmissionError";
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
    this.name = "ExecutorStateError";
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
    this.name = "TaskTimeoutError";
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
    this.name = "ClaimExpiredError";
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
    this.name = "RetryExhaustedError";
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
  (Object.entries(AnchorErrorCodes) as [AnchorErrorName, number][]).map(
    ([name, code]) => [code, name],
  ),
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
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as Record<string, unknown>;

  // Check direct code property
  if ("code" in err && err.code === code) {
    return true;
  }

  // Check Anchor SDK errorCode format: { errorCode: { code: string, number: number } }
  if (
    "errorCode" in err &&
    typeof err.errorCode === "object" &&
    err.errorCode !== null
  ) {
    const errorCode = err.errorCode as Record<string, unknown>;
    if ("number" in errorCode && errorCode.number === code) {
      return true;
    }
  }

  // Check for error.error format (nested error object)
  if ("error" in err && typeof err.error === "object" && err.error !== null) {
    const innerError = err.error as Record<string, unknown>;
    if ("errorCode" in innerError && typeof innerError.errorCode === "object") {
      const errorCode = innerError.errorCode as Record<string, unknown>;
      if ("number" in errorCode && errorCode.number === code) {
        return true;
      }
    }
  }

  // Check transaction logs for error code pattern
  if ("logs" in err && Array.isArray(err.logs)) {
    const codeNeedle = `Error Number: ${code}.`;
    for (const log of err.logs) {
      if (
        typeof log === "string"
        && log.includes("Error Code:")
        && log.includes(codeNeedle)
      ) {
        return true;
      }
    }
  }

  // Check error message for error code
  if ("message" in err && typeof err.message === "string") {
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
  if (!error || typeof error !== "object") {
    return null;
  }

  const err = error as Record<string, unknown>;
  let code: number | undefined;
  let name: AnchorErrorName | undefined;

  // Try to extract code from various formats

  // Format 1: Direct code property
  if ("code" in err && typeof err.code === "number") {
    code = err.code;
  }

  // Format 2: Anchor SDK errorCode format
  if (
    "errorCode" in err &&
    typeof err.errorCode === "object" &&
    err.errorCode !== null
  ) {
    const errorCode = err.errorCode as Record<string, unknown>;
    if ("number" in errorCode && typeof errorCode.number === "number") {
      code = errorCode.number;
    }
    if ("code" in errorCode && typeof errorCode.code === "string") {
      name = errorCode.code as AnchorErrorName;
    }
  }

  // Format 3: Nested error.error format
  if (
    !code &&
    "error" in err &&
    typeof err.error === "object" &&
    err.error !== null
  ) {
    const innerError = err.error as Record<string, unknown>;
    if ("errorCode" in innerError && typeof innerError.errorCode === "object") {
      const errorCode = innerError.errorCode as Record<string, unknown>;
      if ("number" in errorCode && typeof errorCode.number === "number") {
        code = errorCode.number;
      }
      if ("code" in errorCode && typeof errorCode.code === "string") {
        name = errorCode.code as AnchorErrorName;
      }
    }
  }

  // Format 4: Extract from logs
  if (!code && "logs" in err && Array.isArray(err.logs)) {
    const errorPattern = /Error Code: (\w+)\. Error Number: (\d+)\./;
    for (const log of err.logs) {
      if (typeof log === "string") {
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
  if (!code && "message" in err && typeof err.message === "string") {
    // Match hex pattern: "custom program error: 0x1770"
    const hexMatch = err.message.match(
      /custom program error: 0x([0-9a-fA-F]+)/,
    );
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
  if (
    code === undefined ||
    code < ANCHOR_ERROR_MIN_CODE ||
    code > ANCHOR_ERROR_MAX_CODE
  ) {
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
