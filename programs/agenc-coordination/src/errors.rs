//! Error codes for the AgenC Coordination Protocol

use anchor_lang::prelude::*;

/// Protocol error codes
///
/// Note: Error code range comments (e.g., 6100-6199) are organizational
/// and may become stale. Anchor assigns codes sequentially.
#[error_code]
pub enum CoordinationError {
    // Agent errors (6000-6099)
    #[msg("Agent is already registered")]
    AgentAlreadyRegistered,

    #[msg("Agent not found")]
    AgentNotFound,

    #[msg("Agent is not active")]
    AgentNotActive,

    #[msg("Agent has insufficient capabilities")]
    InsufficientCapabilities,

    #[msg("Agent capabilities bitmask cannot be zero")]
    InvalidCapabilities,

    #[msg("Agent has reached maximum active tasks")]
    MaxActiveTasksReached,

    #[msg("Agent has active tasks and cannot be deregistered")]
    AgentHasActiveTasks,

    #[msg("Only the agent authority can perform this action")]
    UnauthorizedAgent,

    #[msg("Creator must match authority to prevent social engineering")]
    CreatorAuthorityMismatch,

    #[msg("Invalid agent ID: agent_id cannot be all zeros")]
    InvalidAgentId,

    #[msg("Agent registration required to create tasks")]
    AgentRegistrationRequired,

    #[msg("Agent is suspended and cannot change status")]
    AgentSuspended,

    #[msg("Agent cannot set status to Active while having active tasks")]
    AgentBusyWithTasks,

    // Task errors (6100-6199)
    #[msg("Task not found")]
    TaskNotFound,

    #[msg("Task is not open for claims")]
    TaskNotOpen,

    #[msg("Task has reached maximum workers")]
    TaskFullyClaimed,

    #[msg("Task has expired")]
    TaskExpired,

    #[msg("Task deadline has not passed")]
    TaskNotExpired,

    #[msg("Task deadline has passed")]
    DeadlinePassed,

    #[msg("Task is not in progress")]
    TaskNotInProgress,

    #[msg("Task is already completed")]
    TaskAlreadyCompleted,

    #[msg("Task cannot be cancelled")]
    TaskCannotBeCancelled,

    #[msg("Only the task creator can perform this action")]
    UnauthorizedTaskAction,

    #[msg("Invalid creator")]
    InvalidCreator,

    #[msg("Invalid task ID: cannot be zero")]
    InvalidTaskId,

    #[msg("Invalid description: cannot be empty")]
    InvalidDescription,

    #[msg("Invalid max workers: must be between 1 and 100")]
    InvalidMaxWorkers,

    #[msg("Invalid task type")]
    InvalidTaskType,

    #[msg("Invalid deadline: deadline must be greater than zero")]
    InvalidDeadline,

    #[msg("Invalid reward: reward must be greater than zero")]
    InvalidReward,

    #[msg("Invalid required capabilities: required_capabilities cannot be zero")]
    InvalidRequiredCapabilities,

    #[msg("Competitive task already completed by another worker")]
    CompetitiveTaskAlreadyWon,

    #[msg("Task has no workers")]
    NoWorkers,

    #[msg("Proof constraint hash does not match task's stored constraint hash")]
    ConstraintHashMismatch,

    #[msg("Task is not a private task (no constraint hash set)")]
    NotPrivateTask,

    // Claim errors (6200-6299)
    #[msg("Worker has already claimed this task")]
    AlreadyClaimed,

    #[msg("Worker has not claimed this task")]
    NotClaimed,

    #[msg("Claim has already been completed")]
    ClaimAlreadyCompleted,

    #[msg("Claim has not expired yet")]
    ClaimNotExpired,

    #[msg("Claim has expired")]
    ClaimExpired,

    #[msg("Invalid expiration: expires_at cannot be zero")]
    InvalidExpiration,

    #[msg("Invalid proof of work")]
    InvalidProof,

    #[msg("ZK proof verification failed")]
    ZkVerificationFailed,

    #[msg("Invalid proof size - expected 256 bytes for Groth16")]
    InvalidProofSize,

    #[msg("Invalid proof binding: expected_binding cannot be all zeros")]
    InvalidProofBinding,

    #[msg("Invalid output commitment: output_commitment cannot be all zeros")]
    InvalidOutputCommitment,

    #[msg("Invalid rent recipient: must be worker authority")]
    InvalidRentRecipient,

    #[msg("Grace period not passed: only worker authority can expire claim within 60 seconds of expiry")]
    GracePeriodNotPassed,

    #[msg("Invalid proof hash: proof_hash cannot be all zeros")]
    InvalidProofHash,

    #[msg("Invalid result data: result_data cannot be all zeros when provided")]
    InvalidResultData,

    // Dispute errors (6300-6399)
    #[msg("Dispute is not active")]
    DisputeNotActive,

    #[msg("Voting period has ended")]
    VotingEnded,

    #[msg("Voting period has not ended")]
    VotingNotEnded,

    #[msg("Already voted on this dispute")]
    AlreadyVoted,

    #[msg("Not authorized to vote (not an arbiter)")]
    NotArbiter,

    #[msg("Insufficient votes to resolve")]
    InsufficientVotes,

    #[msg("Dispute has already been resolved")]
    DisputeAlreadyResolved,

    #[msg("Only protocol authority or dispute initiator can resolve disputes")]
    UnauthorizedResolver,

    #[msg("Agent has active dispute votes pending resolution")]
    ActiveDisputeVotes,

    #[msg("Agent must wait 24 hours after voting before deregistering")]
    RecentVoteActivity,

    #[msg("Authority has already voted on this dispute")]
    AuthorityAlreadyVoted,

    #[msg("Insufficient dispute evidence provided")]
    InsufficientEvidence,

    #[msg("Dispute evidence exceeds maximum allowed length")]
    EvidenceTooLong,

    #[msg("Dispute has not expired")]
    DisputeNotExpired,

    #[msg("Dispute slashing already applied")]
    SlashAlreadyApplied,

    #[msg("Slash window expired: must apply slashing within 7 days of resolution")]
    SlashWindowExpired,

    #[msg("Dispute has not been resolved")]
    DisputeNotResolved,

    #[msg("Only task creator or workers can initiate disputes")]
    NotTaskParticipant,

    #[msg("Invalid evidence hash: cannot be all zeros")]
    InvalidEvidenceHash,

    #[msg("Arbiter cannot vote on disputes they are a participant in")]
    ArbiterIsDisputeParticipant,

    #[msg("Insufficient quorum: minimum number of voters not reached")]
    InsufficientQuorum,

    #[msg("Agent has active disputes as defendant and cannot deregister")]
    ActiveDisputesExist,

    #[msg("Worker agent account required when creator initiates dispute")]
    WorkerAgentRequired,

    #[msg("Worker claim account required when creator initiates dispute")]
    WorkerClaimRequired,

    #[msg("Worker was not involved in this dispute")]
    WorkerNotInDispute,

    #[msg("Dispute initiator cannot resolve their own dispute")]
    InitiatorCannotResolve,

    // State errors (6400-6499)
    #[msg("State version mismatch (concurrent modification)")]
    VersionMismatch,

    #[msg("State key already exists")]
    StateKeyExists,

    #[msg("State not found")]
    StateNotFound,

    #[msg("Invalid state value: state_value cannot be all zeros")]
    InvalidStateValue,

    #[msg("State ownership violation: only the creator agent can update this state")]
    StateOwnershipViolation,

    #[msg("Invalid state key: state_key cannot be all zeros")]
    InvalidStateKey,

    // Protocol errors (6500-6599)
    #[msg("Protocol is already initialized")]
    ProtocolAlreadyInitialized,

    #[msg("Protocol is not initialized")]
    ProtocolNotInitialized,

    #[msg("Invalid protocol fee (must be <= 1000 bps)")]
    InvalidProtocolFee,

    #[msg("Invalid treasury: treasury account cannot be default pubkey")]
    InvalidTreasury,

    #[msg("Invalid dispute threshold: must be 1-100 (percentage of votes required)")]
    InvalidDisputeThreshold,

    #[msg("Insufficient stake for arbiter registration")]
    InsufficientStake,

    #[msg("Invalid multisig threshold")]
    MultisigInvalidThreshold,

    #[msg("Invalid multisig signer configuration")]
    MultisigInvalidSigners,

    #[msg("Not enough multisig signers")]
    MultisigNotEnoughSigners,

    #[msg("Duplicate multisig signer provided")]
    MultisigDuplicateSigner,

    #[msg("Multisig signer cannot be default pubkey")]
    MultisigDefaultSigner,

    #[msg("Multisig signer account not owned by System Program")]
    MultisigSignerNotSystemOwned,

    // General errors (6600-6699)
    #[msg("Invalid input parameter")]
    InvalidInput,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Vote count overflow")]
    VoteOverflow,

    #[msg("Insufficient funds")]
    InsufficientFunds,

    #[msg("Reward too small: worker must receive at least 1 lamport")]
    RewardTooSmall,

    #[msg("Account data is corrupted")]
    CorruptedData,

    #[msg("String too long")]
    StringTooLong,

    #[msg("Account owner validation failed: account not owned by this program")]
    InvalidAccountOwner,

    // Rate limiting errors (6700-6799)
    #[msg("Rate limit exceeded: maximum actions per 24h window reached")]
    RateLimitExceeded,

    #[msg("Cooldown period has not elapsed since last action")]
    CooldownNotElapsed,

    #[msg("Agent update too frequent: must wait cooldown period")]
    UpdateTooFrequent,

    #[msg("Cooldown value cannot be negative")]
    InvalidCooldown,

    #[msg("Cooldown value exceeds maximum (24 hours)")]
    CooldownTooLarge,

    #[msg("Rate limit value exceeds maximum allowed (1000)")]
    RateLimitTooHigh,

    #[msg("Cooldown value exceeds maximum allowed (1 week)")]
    CooldownTooLong,

    #[msg("Insufficient stake to initiate dispute")]
    InsufficientStakeForDispute,

    #[msg("Creator-initiated disputes require 2x the minimum stake")]
    InsufficientStakeForCreatorDispute,

    // Version/upgrade errors (6800-6899)
    #[msg("Protocol version mismatch: account version incompatible with current program")]
    VersionMismatchProtocol,

    #[msg("Account version too old: migration required")]
    AccountVersionTooOld,

    #[msg("Account version too new: program upgrade required")]
    AccountVersionTooNew,

    #[msg("Migration not allowed: invalid source version")]
    InvalidMigrationSource,

    #[msg("Migration not allowed: invalid target version")]
    InvalidMigrationTarget,

    #[msg("Only upgrade authority can perform this action")]
    UnauthorizedUpgrade,

    #[msg("Minimum version cannot exceed current protocol version")]
    InvalidMinVersion,

    #[msg("Protocol config account required: suspending an agent requires the protocol config PDA in remaining_accounts")]
    ProtocolConfigRequired,

    // Dependency errors (6900-6999)
    #[msg("Parent task has been cancelled")]
    ParentTaskCancelled,

    #[msg("Parent task is in disputed state")]
    ParentTaskDisputed,

    #[msg("Invalid dependency type")]
    InvalidDependencyType,

    #[msg("Parent task must be completed before completing a proof-dependent task")]
    ParentTaskNotCompleted,

    #[msg("Parent task account required for proof-dependent task completion")]
    ParentTaskAccountRequired,

    #[msg("Parent task does not belong to the same creator")]
    UnauthorizedCreator,

    // Nullifier errors (7000-7099)
    #[msg("Nullifier has already been spent - proof/knowledge reuse detected")]
    NullifierAlreadySpent,

    #[msg("Invalid nullifier: nullifier value cannot be all zeros")]
    InvalidNullifier,

    // Cancel task errors (7100-7199)
    #[msg("All worker accounts must be provided when cancelling a task with active claims")]
    IncompleteWorkerAccounts,

    #[msg("Worker accounts required when task has active workers")]
    WorkerAccountsRequired,

    // Duplicate account errors (7200-7299)
    #[msg("Duplicate arbiter provided in remaining_accounts")]
    DuplicateArbiter,

    // Escrow errors (7300-7399)
    #[msg("Escrow has insufficient balance for reward transfer")]
    InsufficientEscrowBalance,

    // Status transition errors (7300-7399)
    #[msg("Invalid task status transition")]
    InvalidStatusTransition,

    // Stake validation errors (7400-7499)
    #[msg("Stake value is below minimum required (0.001 SOL)")]
    StakeTooLow,

    #[msg("min_stake_for_dispute must be greater than zero")]
    InvalidMinStake,

    #[msg("Slash amount must be greater than zero")]
    InvalidSlashAmount,

    // Speculation Bond errors (7500-7599)
    #[msg("Bond amount too low")]
    BondAmountTooLow,

    #[msg("Bond already exists")]
    BondAlreadyExists,

    #[msg("Bond not found")]
    BondNotFound,

    #[msg("Bond not yet matured")]
    BondNotMatured,
}
