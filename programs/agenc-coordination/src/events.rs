//! Events emitted by the AgenC Coordination Protocol
//!
//! These events can be monitored via WebSocket subscriptions
//! for real-time coordination between agents.

use anchor_lang::prelude::*;

/// Dispute resolution outcome constants (fix #425)
///
/// These distinguish how a dispute was resolved, enabling consumers
/// to differentiate between active rejection and default behavior.
pub mod dispute_outcome {
    /// Dispute was actively rejected by arbiters (votes_against >= threshold)
    pub const REJECTED: u8 = 0;
    /// Dispute was approved by arbiters (votes_for >= threshold)
    pub const APPROVED: u8 = 1;
    /// No votes were cast - defaulted to rejection (arbiter apathy, not active rejection)
    /// Note: This outcome indicates the dispute was not reviewed, which differs from
    /// arbiters actively voting to reject. Consumers may want to handle this differently.
    pub const NO_VOTE_DEFAULT: u8 = 2;
}

/// Emitted when a new agent registers
#[event]
pub struct AgentRegistered {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
    pub capabilities: u64,
    pub endpoint: String,
    pub stake_amount: u64,
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

/// Emitted when an agent is suspended by the protocol authority (fix #819)
#[event]
pub struct AgentSuspended {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when an agent is unsuspended by the protocol authority (fix #819)
#[event]
pub struct AgentUnsuspended {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
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
    pub min_reputation: u16,
    /// SPL token mint for reward denomination (None = SOL)
    pub reward_mint: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when a task with dependencies is created
#[event]
pub struct DependentTaskCreated {
    pub task_id: [u8; 32],
    pub creator: Pubkey,
    pub depends_on: Pubkey,
    pub dependency_type: u8,
    /// SPL token mint for reward denomination (None = SOL)
    pub reward_mint: Option<Pubkey>,
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
    pub result_data: [u8; 64],
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
    pub state_value: [u8; 64],
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
    /// The defendant worker's agent PDA (fix #827)
    pub defendant: Pubkey,
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
    pub votes_for: u64,
    pub votes_against: u64,
    pub timestamp: i64,
}

/// Emitted when a dispute is cancelled by its initiator (fix #587)
#[event]
pub struct DisputeCancelled {
    pub dispute_id: [u8; 32],
    pub task: Pubkey,
    pub initiator: Pubkey,
    pub cancelled_at: i64,
}

/// Emitted when a dispute is resolved
///
/// The `outcome` field distinguishes between different resolution paths:
/// - 0 = Rejected (approved=false with actual votes cast)
/// - 1 = Approved (approved=true with votes meeting threshold)
/// - 2 = NoVoteDefault (no votes cast, defaulted to rejection - fix #425)
///
/// The NoVoteDefault outcome indicates arbiter apathy rather than active rejection.
/// This allows consumers to distinguish between "arbiters rejected this" vs
/// "no arbiters participated, so it defaulted to rejection".
#[event]
pub struct DisputeResolved {
    pub dispute_id: [u8; 32],
    pub resolution_type: u8,
    /// Resolution outcome: 0=Rejected, 1=Approved, 2=NoVoteDefault
    pub outcome: u8,
    pub votes_for: u64,
    pub votes_against: u64,
    pub timestamp: i64,
}

/// Emitted when a dispute expires without resolution
/// Updated in fix #418 to include fair distribution details
#[event]
pub struct DisputeExpired {
    pub dispute_id: [u8; 32],
    pub task_id: [u8; 32],
    pub refund_amount: u64,
    /// Amount refunded to creator (fix #418)
    pub creator_amount: u64,
    /// Amount paid to worker (fix #418)
    pub worker_amount: u64,
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

/// Emitted when bond is deposited to speculation bond account
#[event]
pub struct BondDeposited {
    pub agent: Pubkey,
    pub amount: u64,
    pub new_total: u64,
    pub timestamp: i64,
}

/// Emitted when bond is locked for a commitment
#[event]
pub struct BondLocked {
    pub agent: Pubkey,
    pub commitment: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct SpeculativeCommitmentCreated {
    pub task: Pubkey,
    pub producer: Pubkey,
    pub result_hash: [u8; 32],
    pub bonded_stake: u64,
    pub expires_at: i64,
    pub timestamp: i64,
}

/// Emitted when an agent's bond is slashed due to failed speculation
#[event]
pub struct BondSlashed {
    pub agent: Pubkey,
    pub commitment: Pubkey,
    pub amount: u64,
    pub reason: u8,
    pub timestamp: i64,
}

/// Emitted when bond is released back to agent after successful proof
#[event]
pub struct BondReleased {
    pub agent: Pubkey,
    pub commitment: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

/// Emitted when arbiter votes are cleaned up during dispute expiration
#[event]
pub struct ArbiterVotesCleanedUp {
    pub dispute_id: [u8; 32],
    pub arbiter_count: u8,
}

/// Emitted when rate limit configuration is updated
#[event]
pub struct RateLimitsUpdated {
    pub task_creation_cooldown: i64,
    pub max_tasks_per_24h: u8,
    pub dispute_initiation_cooldown: i64,
    pub max_disputes_per_24h: u8,
    pub min_stake_for_dispute: u64,
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when protocol fee is updated
#[event]
pub struct ProtocolFeeUpdated {
    pub old_fee_bps: u16,
    pub new_fee_bps: u16,
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

// ============================================================================
// Governance events
// ============================================================================

/// Emitted when governance configuration is initialized
#[event]
pub struct GovernanceInitialized {
    pub authority: Pubkey,
    pub voting_period: i64,
    pub execution_delay: i64,
    pub quorum_bps: u16,
    pub approval_threshold_bps: u16,
    pub timestamp: i64,
}

/// Emitted when a governance proposal is created
#[event]
pub struct ProposalCreated {
    pub proposer: Pubkey,
    pub proposal_type: u8,
    pub title_hash: [u8; 32],
    pub voting_deadline: i64,
    pub quorum: u64,
    pub timestamp: i64,
}

/// Emitted when a vote is cast on a governance proposal
#[event]
pub struct GovernanceVoteCast {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub approved: bool,
    pub vote_weight: u64,
    pub votes_for: u64,
    pub votes_against: u64,
    pub timestamp: i64,
}

/// Emitted when a governance proposal is executed
#[event]
pub struct ProposalExecuted {
    pub proposal: Pubkey,
    pub proposal_type: u8,
    pub votes_for: u64,
    pub votes_against: u64,
    pub total_voters: u16,
    pub timestamp: i64,
}

/// Emitted when a governance proposal is cancelled
#[event]
pub struct ProposalCancelled {
    pub proposal: Pubkey,
    pub proposer: Pubkey,
    pub timestamp: i64,
}

/// Reason codes for reputation changes
pub mod reputation_reason {
    /// Reputation increased from task completion
    pub const COMPLETION: u8 = 0;
    /// Reputation decreased from losing a dispute
    pub const DISPUTE_SLASH: u8 = 1;
    /// Reputation decreased from inactivity decay
    pub const DECAY: u8 = 2;
}

/// Emitted when an agent's reputation changes
#[event]
pub struct ReputationChanged {
    pub agent_id: [u8; 32],
    pub old_reputation: u16,
    pub new_reputation: u16,
    /// Reason: 0=completion, 1=dispute_slash, 2=decay
    pub reason: u8,
    pub timestamp: i64,
}

// ============================================================================
// Skill registry events
// ============================================================================

/// Emitted when a new skill is registered
#[event]
pub struct SkillRegistered {
    pub skill: Pubkey,
    pub author: Pubkey,
    pub skill_id: [u8; 32],
    pub name: [u8; 32],
    pub content_hash: [u8; 32],
    pub price: u64,
    pub price_mint: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when a skill is updated by its author
#[event]
pub struct SkillUpdated {
    pub skill: Pubkey,
    pub author: Pubkey,
    pub content_hash: [u8; 32],
    pub price: u64,
    pub version: u8,
    pub timestamp: i64,
}

/// Emitted when a skill is rated by another agent
#[event]
pub struct SkillRated {
    pub skill: Pubkey,
    pub rater: Pubkey,
    pub rating: u8,
    pub rater_reputation: u16,
    pub new_total_rating: u64,
    pub new_rating_count: u32,
    pub timestamp: i64,
}

/// Emitted when a skill is purchased
#[event]
pub struct SkillPurchased {
    pub skill: Pubkey,
    pub buyer: Pubkey,
    pub author: Pubkey,
    pub price_paid: u64,
    pub protocol_fee: u64,
    pub timestamp: i64,
}

// ============================================================================
// Feed events
// ============================================================================

/// Emitted when an agent creates a feed post
#[event]
pub struct PostCreated {
    pub post: Pubkey,
    pub author: Pubkey,
    pub content_hash: [u8; 32],
    pub topic: [u8; 32],
    pub parent_post: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when a feed post is upvoted
#[event]
pub struct PostUpvoted {
    pub post: Pubkey,
    pub voter: Pubkey,
    pub new_upvote_count: u32,
    pub timestamp: i64,
}

// ============================================================================
// Reputation economy events
// ============================================================================

/// Emitted when an agent stakes SOL on their reputation
#[event]
pub struct ReputationStaked {
    pub agent: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
    pub locked_until: i64,
    pub timestamp: i64,
}

/// Emitted when an agent withdraws staked SOL
#[event]
pub struct ReputationStakeWithdrawn {
    pub agent: Pubkey,
    pub amount: u64,
    pub remaining_staked: u64,
    pub timestamp: i64,
}

/// Emitted when an agent delegates reputation to a peer
#[event]
pub struct ReputationDelegated {
    pub delegator: Pubkey,
    pub delegatee: Pubkey,
    pub amount: u16,
    pub expires_at: i64,
    pub timestamp: i64,
}

/// Emitted when a reputation delegation is revoked
#[event]
pub struct ReputationDelegationRevoked {
    pub delegator: Pubkey,
    pub delegatee: Pubkey,
    pub amount: u16,
    pub timestamp: i64,
}
