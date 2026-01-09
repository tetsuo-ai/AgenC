//! Events emitted by the AgenC Coordination Protocol
//!
//! These events can be monitored via WebSocket subscriptions
//! for real-time coordination between agents.

use anchor_lang::prelude::*;

/// Emitted when a new agent registers
#[event]
pub struct AgentRegistered {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
    pub capabilities: u64,
    pub endpoint: String,
    pub timestamp: i64,
}

/// Emitted when an agent updates its registration
#[event]
pub struct AgentUpdated {
    pub agent_id: [u8; 32],
    pub capabilities: u64,
    pub status: u8,
    pub timestamp: i64,
}

/// Emitted when an agent deregisters
#[event]
pub struct AgentDeregistered {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a new task is created
#[event]
pub struct TaskCreated {
    pub task_id: [u8; 32],
    pub creator: Pubkey,
    pub required_capabilities: u64,
    pub reward_amount: u64,
    pub task_type: u8,
    pub deadline: i64,
    pub timestamp: i64,
}

/// Emitted when an agent claims a task
#[event]
pub struct TaskClaimed {
    pub task_id: [u8; 32],
    pub worker: Pubkey,
    pub current_workers: u8,
    pub max_workers: u8,
    pub timestamp: i64,
}

/// Emitted when a task is completed
#[event]
pub struct TaskCompleted {
    pub task_id: [u8; 32],
    pub worker: Pubkey,
    pub proof_hash: [u8; 32],
    pub reward_paid: u64,
    pub timestamp: i64,
}

/// Emitted when a task is cancelled
#[event]
pub struct TaskCancelled {
    pub task_id: [u8; 32],
    pub creator: Pubkey,
    pub refund_amount: u64,
    pub timestamp: i64,
}

/// Emitted when coordination state is updated
#[event]
pub struct StateUpdated {
    pub state_key: [u8; 32],
    pub updater: Pubkey,
    pub version: u64,
    pub timestamp: i64,
}

/// Emitted when a dispute is initiated
#[event]
pub struct DisputeInitiated {
    pub dispute_id: [u8; 32],
    pub task_id: [u8; 32],
    pub initiator: Pubkey,
    pub resolution_type: u8,
    pub voting_deadline: i64,
    pub timestamp: i64,
}

/// Emitted when a vote is cast on a dispute
#[event]
pub struct DisputeVoteCast {
    pub dispute_id: [u8; 32],
    pub voter: Pubkey,
    pub approved: bool,
    pub votes_for: u8,
    pub votes_against: u8,
    pub timestamp: i64,
}

/// Emitted when a dispute is resolved
#[event]
pub struct DisputeResolved {
    pub dispute_id: [u8; 32],
    pub resolution_type: u8,
    pub votes_for: u8,
    pub votes_against: u8,
    pub timestamp: i64,
}

/// Emitted when protocol is initialized
#[event]
pub struct ProtocolInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub dispute_threshold: u8,
    pub protocol_fee_bps: u16,
    pub timestamp: i64,
}

/// Emitted for reward distribution
#[event]
pub struct RewardDistributed {
    pub task_id: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
    pub protocol_fee: u64,
    pub timestamp: i64,
}

/// Emitted when a rate limit is hit
#[event]
pub struct RateLimitHit {
    pub agent_id: [u8; 32],
    pub action_type: u8, // 0 = task_creation, 1 = dispute_initiation
    pub limit_type: u8,  // 0 = cooldown, 1 = 24h_window
    pub current_count: u8,
    pub max_count: u8,
    pub cooldown_remaining: i64,
    pub timestamp: i64,
}

/// Emitted when protocol migration is completed
#[event]
pub struct MigrationCompleted {
    pub from_version: u8,
    pub to_version: u8,
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when protocol version is updated
#[event]
pub struct ProtocolVersionUpdated {
    pub old_version: u8,
    pub new_version: u8,
    pub min_supported_version: u8,
    pub timestamp: i64,
}
