/**
 * @agenc/sdk - Privacy-preserving agent coordination on Solana
 *
 * AgenC enables agents to complete tasks and receive payments with full privacy:
 * - ZK proofs verify task completion without revealing outputs
 * - Privacy Cash breaks payment linkability via shielded pools
 * - Inline groth16-solana verifier validates Circom circuit proofs
 */

// AgenCPrivacyClient is not directly exported — it is used internally by PrivacyClient.
// Requires optional peer dependency: privacycash

export {
  PrivacyClient,
  PrivacyClientConfig,
} from './client';

export {
  generateProof,
  verifyProofLocally,
  computeHashes,
  generateSalt,
  checkToolsAvailable,
  requireTools,
  pubkeyToField,
  FIELD_MODULUS,
  // Hash computation functions
  computeExpectedBinding,
  computeConstraintHash,
  computeCommitment,
  // Types
  ProofGenerationParams,
  ProofResult,
  HashResult,
  ToolsStatus,
} from './proofs';

export {
  createTask,
  createDependentTask,
  claimTask,
  expireClaim,
  completeTask,
  completeTaskPrivate,
  completeTaskPrivateSafe,
  cancelTask,
  getTask,
  getTasksByCreator,
  getTaskLifecycleSummary,
  deriveTaskPda,
  deriveClaimPda,
  deriveEscrowPda,
  formatTaskState,
  calculateEscrowFee,
  TaskParams,
  DependentTaskParams,
  TaskState,
  TaskStatus,
  TaskLifecycleEvent,
  TaskLifecycleSummary,
  PrivateCompletionProof,
  CompleteTaskPrivateSafeOptions,
  ProofPreconditionError,
} from './tasks';

export {
  BPS_BASE,
  BID_ID_MAX_LENGTH,
  MARKETPLACE_ID_PATTERN,
  DEFAULT_WEIGHTED_SCORE_WEIGHTS,
  canonicalizeMarketplaceId,
  validateMarketplaceId,
  isValidBps,
  // Types
  type BidStatus,
  type MatchingPolicy,
  type WeightedScoreWeights,
  type MatchingPolicyConfig,
  type BidRateLimitConfig,
  type BidAntiSpamConfig,
  type TaskBidInput,
  type TaskBidUpdateInput,
  type TaskBid,
  type TaskBidBookState,
  type WeightedScoringBreakdown,
  type TaskBidSelection,
} from './bids';

export {
  deriveTokenEscrowAddress,
  isTokenTask,
  getEscrowTokenBalance,
  formatTokenAmount,
  getMintDecimals,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from './tokens';

export {
  PROGRAM_ID,
  PRIVACY_CASH_PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  // Size constants
  HASH_SIZE,
  RESULT_DATA_SIZE,
  U64_SIZE,
  DISCRIMINATOR_SIZE,
  OUTPUT_FIELD_COUNT,
  // Fee constants
  BASIS_POINTS_DIVISOR,
  PERCENT_BASE,
  DEFAULT_FEE_PERCENT,
  MAX_PROTOCOL_FEE_BPS,
  FEE_TIERS,
  // ZK constants
  PROOF_SIZE_BYTES,
  VERIFICATION_COMPUTE_UNITS,
  PUBLIC_INPUTS_COUNT,
  // Compute budget constants (issue #40)
  RECOMMENDED_CU_REGISTER_AGENT,
  RECOMMENDED_CU_UPDATE_AGENT,
  RECOMMENDED_CU_CREATE_TASK,
  RECOMMENDED_CU_CREATE_DEPENDENT_TASK,
  RECOMMENDED_CU_CLAIM_TASK,
  RECOMMENDED_CU_COMPLETE_TASK,
  RECOMMENDED_CU_COMPLETE_TASK_PRIVATE,
  RECOMMENDED_CU_CANCEL_TASK,
  RECOMMENDED_CU_INITIATE_DISPUTE,
  RECOMMENDED_CU_VOTE_DISPUTE,
  RECOMMENDED_CU_RESOLVE_DISPUTE,
  // Token-path CU constants
  RECOMMENDED_CU_CREATE_TASK_TOKEN,
  RECOMMENDED_CU_COMPLETE_TASK_TOKEN,
  RECOMMENDED_CU_COMPLETE_TASK_PRIVATE_TOKEN,
  RECOMMENDED_CU_CANCEL_TASK_TOKEN,
  // PDA seeds
  SEEDS,
  VERIFIER_PROGRAM_ID,
} from './constants';

export {
  registerAgent,
  updateAgent,
  suspendAgent,
  unsuspendAgent,
  deregisterAgent,
  getAgent,
  deriveAgentPda,
  AgentStatus,
  type RegisterAgentParams,
  type UpdateAgentParams,
  type AgentState,
} from './agents';

export {
  initiateDispute,
  voteDispute,
  resolveDispute,
  applyDisputeSlash,
  applyInitiatorSlash,
  cancelDispute,
  expireDispute,
  getDispute,
  deriveDisputePda,
  deriveVotePda,
  DisputeStatus,
  ResolutionType,
  type InitiateDisputeParams,
  type VoteDisputeParams,
  type ResolveDisputeParams,
  type ApplyDisputeSlashParams,
  type ApplyInitiatorSlashParams,
  type ExpireDisputeParams,
  type DisputeState,
} from './disputes';

export {
  updateState,
  getState,
  deriveStatePda,
  type CoordinationState,
  type UpdateStateParams,
} from './state';

export {
  initializeProtocol,
  updateProtocolFee,
  updateRateLimits,
  migrateProtocol,
  updateMinVersion,
  getProtocolConfig,
  deriveProtocolPda,
  type InitializeProtocolParams,
  type UpdateRateLimitsParams,
  type ProtocolConfigState,
} from './protocol';

export {
  COORDINATION_ERROR_MAP,
  decodeError,
  decodeAnchorError,
  type ErrorCategory,
  type CoordinationErrorEntry,
  type DecodedError,
} from './errors';

export {
  validateProofPreconditions,
  DEFAULT_MAX_PROOF_AGE_MS,
  type ProofPreconditionResult,
  type ProofPreconditionFailure,
  type ProofPreconditionWarning,
  type ValidateProofParams,
} from './proof-validation';

export {
  NullifierCache,
} from './nullifier-cache';

export {
  // Query functions
  getTasksByDependency,
  getDependentTaskCount,
  getTasksByDependencyWithProgram,
  getRootTasks,
  hasDependents,
  getDisputesByActor,
  getReplayHealthCheck,
  // Field offsets for memcmp filtering (for custom queries)
  TASK_FIELD_OFFSETS,
  DISPUTE_FIELD_OFFSETS,
  // Types
  DependentTask,
  ActorDisputeSummary,
  ReplayCursor,
  ReplayTimelineRecord,
  ReplayTimelineStoreLike,
  ReplayHealthCheck,
} from './queries';

export {
  createLogger,
  silentLogger,
  setSdkLogLevel,
  getSdkLogger,
  Logger,
  LogLevel,
} from './logger';

// Version info
export const VERSION = '1.3.0';
