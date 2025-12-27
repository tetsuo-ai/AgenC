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

    #[msg("Task is not in progress")]
    TaskNotInProgress,

    #[msg("Task is already completed")]
    TaskAlreadyCompleted,

    #[msg("Task cannot be cancelled")]
    TaskCannotBeCancelled,

    #[msg("Only the task creator can perform this action")]
    UnauthorizedTaskAction,

    #[msg("Invalid task type")]
    InvalidTaskType,

    #[msg("Task has no workers")]
    NoWorkers,

    // Claim errors (6200-6299)
    #[msg("Worker has already claimed this task")]
    AlreadyClaimed,

    #[msg("Worker has not claimed this task")]
    NotClaimed,

    #[msg("Claim has already been completed")]
    ClaimAlreadyCompleted,

    #[msg("Invalid proof of work")]
    InvalidProof,

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

    // General errors (6600-6699)
    #[msg("Invalid input parameter")]
    InvalidInput,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Insufficient funds")]
    InsufficientFunds,

    #[msg("Account data is corrupted")]
    CorruptedData,

    #[msg("String too long")]
    StringTooLong,
}
