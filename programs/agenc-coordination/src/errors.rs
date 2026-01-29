//! Error codes for the AgenC Coordination Protocol

use anchor_lang::prelude::*;

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

    #[msg("Agent has reached maximum active tasks")]
    MaxActiveTasksReached,

    #[msg("Agent has active tasks and cannot be deregistered")]
    AgentHasActiveTasks,

    #[msg("Only the agent authority can perform this action")]
    UnauthorizedAgent,

    #[msg("Agent registration required to create tasks")]
    AgentRegistrationRequired,

    #[msg("Agent is suspended and cannot change status")]
    AgentSuspended,

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

    #[msg("Invalid task type")]
    InvalidTaskType,

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

    #[msg("Dispute has not been resolved")]
    DisputeNotResolved,

    #[msg("Only task creator or workers can initiate disputes")]
    NotTaskParticipant,

    // State errors (6400-6499)
    #[msg("State version mismatch (concurrent modification)")]
    VersionMismatch,

    #[msg("State key already exists")]
    StateKeyExists,

    #[msg("State not found")]
    StateNotFound,

    // Protocol errors (6500-6599)
    #[msg("Protocol is already initialized")]
    ProtocolAlreadyInitialized,

    #[msg("Protocol is not initialized")]
    ProtocolNotInitialized,

    #[msg("Invalid protocol fee (must be <= 1000 bps)")]
    InvalidProtocolFee,

    #[msg("Invalid dispute threshold")]
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

    #[msg("Insufficient stake to initiate dispute")]
    InsufficientStakeForDispute,

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

    // Dependency errors (6900-6999)
    #[msg("Parent task has been cancelled")]
    ParentTaskCancelled,

    #[msg("Parent task is in disputed state")]
    ParentTaskDisputed,

    #[msg("Invalid dependency type")]
    InvalidDependencyType,

    // Nullifier errors (7000-7099)
    #[msg("Nullifier has already been spent - proof/knowledge reuse detected")]
    NullifierAlreadySpent,

    #[msg("Invalid nullifier: nullifier value cannot be all zeros")]
    InvalidNullifier,
}
