/**
 * @agenc/sdk - Privacy-preserving agent coordination on Solana
 *
 * AgenC enables agents to complete tasks and receive payments with full privacy:
 * - RISC0 payloads verify task completion without revealing outputs
 * - Router-verifier account model is used for private completion
 * - Private payload shape is seal/journal/image/binding/nullifier seeds
 */

export {
  generateProof,
  generateProofWithProver,
  verifyProofLocally,
  computeHashes,
  generateSalt,
  pubkeyToField,
  FIELD_MODULUS,
  // Hash computation functions
  computeBinding,
  computeConstraintHash,
  // Types
  ProofGenerationParams,
  ProofResult,
  HashResult,
} from './proofs';

export {
  type ProverConfig,
  type LocalBinaryProverConfig,
  type RemoteProverConfig,
  type ProverInput,
  ProverError,
} from './prover';

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
  PrivateCompletionPayload,
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
  RISC0_SELECTOR_LEN,
  RISC0_GROTH16_SEAL_LEN,
  RISC0_SEAL_BORSH_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_IMAGE_ID_LEN,
  TRUSTED_RISC0_SELECTOR,
  TRUSTED_RISC0_IMAGE_ID,
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
  // Current API
  runProofSubmissionPreflight,
  DEFAULT_MAX_PROOF_AGE_MS,
  type ProofSubmissionPreflightResult,
  type ProofSubmissionPreflightFailure,
  type ProofSubmissionPreflightWarning,
  type ProofSubmissionPreflightParams,
  // Deprecated aliases (v1.6.0)
  validateProofPreconditions,
  type ProofPreconditionResult,
  type ProofPreconditionFailure,
  type ProofPreconditionWarning,
  type ValidateProofParams,
} from './proof-validation';

export {
  NullifierCache,
} from './nullifier-cache';

export {
  checkVersionCompatibility,
  requireVersionCompatibility,
  getFeaturesForVersion,
  SDK_PROTOCOL_VERSION,
  SDK_MIN_PROTOCOL_VERSION,
  SDK_PACKAGE_VERSION,
  VersionStatus,
  type ProtocolVersionInfo,
  type FeatureFlags,
  type VersionCompatibilityOptions,
} from './version';

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

export {
  ProposalType,
  ProposalStatus,
  deriveGovernanceConfigPda,
  deriveProposalPda,
  deriveGovernanceVotePda,
  initializeGovernance,
  createProposal,
  voteProposal,
  executeProposal,
  cancelProposal,
  getProposal,
  RECOMMENDED_CU_INITIALIZE_GOVERNANCE,
  RECOMMENDED_CU_CREATE_PROPOSAL,
  RECOMMENDED_CU_VOTE_PROPOSAL,
  RECOMMENDED_CU_EXECUTE_PROPOSAL,
  RECOMMENDED_CU_CANCEL_PROPOSAL,
} from './governance';
export type {
  InitializeGovernanceParams,
  CreateProposalParams,
  ProposalState,
} from './governance';

export {
  deriveSkillPda,
  deriveSkillRatingPda,
  deriveSkillPurchasePda,
  RECOMMENDED_CU_REGISTER_SKILL,
  RECOMMENDED_CU_UPDATE_SKILL,
  RECOMMENDED_CU_RATE_SKILL,
  RECOMMENDED_CU_PURCHASE_SKILL,
  RECOMMENDED_CU_PURCHASE_SKILL_TOKEN,
  type RegisterSkillParams,
  type UpdateSkillParams,
  type RateSkillParams,
  type SkillState,
  type SkillRatingState,
  type PurchaseRecordState,
} from './skills';

export {
  PrivacyClient,
  type PrivacyClientConfig,
} from './client';

export {
  validateProverEndpoint,
  validateRisc0PayloadShape,
  type Risc0PayloadLike,
} from './validation';

// Version info
export const VERSION = '1.3.0';
