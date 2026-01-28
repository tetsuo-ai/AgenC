//! Account state structures for the AgenC Coordination Protocol

use anchor_lang::prelude::*;

// ============================================================================
// Size Constants
// ============================================================================

/// Size of cryptographic hashes and IDs (SHA256, Pubkey bytes)
pub const HASH_SIZE: usize = 32;

/// Size of result/description/value data fields
pub const RESULT_DATA_SIZE: usize = 64;

/// Agent capability flags (bitmask)
pub mod capability {
    pub const COMPUTE: u64 = 1 << 0; // General computation
    pub const INFERENCE: u64 = 1 << 1; // ML inference
    pub const STORAGE: u64 = 1 << 2; // Data storage
    pub const NETWORK: u64 = 1 << 3; // Network relay
    pub const SENSOR: u64 = 1 << 4; // Sensor data collection
    pub const ACTUATOR: u64 = 1 << 5; // Physical actuation
    pub const COORDINATOR: u64 = 1 << 6; // Task coordination
    pub const ARBITER: u64 = 1 << 7; // Dispute resolution
    pub const VALIDATOR: u64 = 1 << 8; // Result validation
    pub const AGGREGATOR: u64 = 1 << 9; // Data aggregation
}

/// Agent status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum AgentStatus {
    #[default]
    Inactive = 0,
    Active = 1,
    Busy = 2,
    Suspended = 3,
}

/// Task status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum TaskStatus {
    #[default]
    Open = 0,
    InProgress = 1,
    PendingValidation = 2,
    Completed = 3,
    Cancelled = 4,
    Disputed = 5,
}

/// Task type
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum TaskType {
    #[default]
    Exclusive = 0, // Single worker completes entire task
    Collaborative = 1, // Multiple workers contribute
    Competitive = 2,   // First to complete wins
}

/// Dependency type for speculative execution decisions
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum DependencyType {
    #[default]
    None = 0,     // No dependency
    Data = 1,     // Needs parent output data (speculatable)
    Ordering = 2, // Must run after parent (speculatable)
    Proof = 3,    // Needs parent's on-chain proof (NOT speculatable)
}

/// Dispute resolution type
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum ResolutionType {
    #[default]
    Refund = 0, // Full refund to task creator
    Complete = 1, // Mark task as complete, pay worker
    Split = 2,    // Split reward between parties
}

/// Dispute status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum DisputeStatus {
    #[default]
    Active = 0,
    Resolved = 1,
    Expired = 2,
}

/// Reason for slashing an agent's bond
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SlashReason {
    ProofFailed = 0,
    ProofTimeout = 1,
    InvalidResult = 2,
}

/// Current protocol version
pub const CURRENT_PROTOCOL_VERSION: u8 = 1;

/// Minimum supported protocol version for backward compatibility
pub const MIN_SUPPORTED_VERSION: u8 = 1;

/// Protocol configuration account
/// PDA seeds: ["protocol"]
#[account]
pub struct ProtocolConfig {
    /// Protocol authority
    pub authority: Pubkey,
    /// Treasury for protocol fees
    pub treasury: Pubkey,
    /// Minimum votes needed to resolve dispute (percentage, 1-100)
    pub dispute_threshold: u8,
    /// Protocol fee in basis points (1/100th of a percent)
    pub protocol_fee_bps: u16,
    /// Minimum stake required to register as arbiter
    pub min_arbiter_stake: u64,
    /// Minimum stake required to register as agent
    pub min_agent_stake: u64,
    /// Max duration (seconds) a claim can stay active without completion
    pub max_claim_duration: i64,
    /// Max duration (seconds) a dispute can remain active
    pub max_dispute_duration: i64,
    /// Total registered agents
    pub total_agents: u64,
    /// Total tasks created
    pub total_tasks: u64,
    /// Total tasks completed
    pub completed_tasks: u64,
    /// Total value distributed
    pub total_value_distributed: u64,
    /// Bump seed for PDA
    pub bump: u8,
    /// Multisig threshold
    pub multisig_threshold: u8,
    /// Length of configured multisig owners
    pub multisig_owners_len: u8,
    // === Rate limiting configuration ===
    /// Minimum cooldown between task creations (seconds, 0 = disabled)
    pub task_creation_cooldown: i64,
    /// Maximum tasks an agent can create per 24h window (0 = unlimited)
    pub max_tasks_per_24h: u8,
    /// Minimum cooldown between dispute initiations (seconds, 0 = disabled)
    pub dispute_initiation_cooldown: i64,
    /// Maximum disputes an agent can initiate per 24h window (0 = unlimited)
    pub max_disputes_per_24h: u8,
    /// Minimum stake required to initiate a dispute (griefing resistance)
    pub min_stake_for_dispute: u64,
    /// Percentage of stake slashed on losing dispute (0-100)
    pub slash_percentage: u8,
    // === Versioning fields ===
    /// Current protocol version (for upgrades)
    pub protocol_version: u8,
    /// Minimum supported version for backward compatibility
    pub min_supported_version: u8,
    /// Padding for alignment/future use
    pub _padding: [u8; 2],
    /// Multisig owners (fixed-size)
    pub multisig_owners: [Pubkey; ProtocolConfig::MAX_MULTISIG_OWNERS],
}

impl Default for ProtocolConfig {
    fn default() -> Self {
        Self {
            authority: Pubkey::default(),
            treasury: Pubkey::default(),
            dispute_threshold: 50,
            protocol_fee_bps: 100,
            min_arbiter_stake: 0,
            min_agent_stake: 0,
            max_claim_duration: ProtocolConfig::DEFAULT_MAX_CLAIM_DURATION,
            max_dispute_duration: ProtocolConfig::DEFAULT_MAX_DISPUTE_DURATION,
            total_agents: 0,
            total_tasks: 0,
            completed_tasks: 0,
            total_value_distributed: 0,
            bump: 0,
            multisig_threshold: 0,
            multisig_owners_len: 0,
            // Default rate limits (can be configured post-deployment)
            task_creation_cooldown: 60, // 60 seconds between task creations
            max_tasks_per_24h: 50,      // 50 tasks per 24h window
            dispute_initiation_cooldown: 300, // 5 minutes between disputes
            max_disputes_per_24h: 10,   // 10 disputes per 24h window
            min_stake_for_dispute: 0,   // No stake required by default
            slash_percentage: ProtocolConfig::DEFAULT_SLASH_PERCENTAGE,
            // Versioning
            protocol_version: CURRENT_PROTOCOL_VERSION,
            min_supported_version: MIN_SUPPORTED_VERSION,
            _padding: [0u8; 2],
            multisig_owners: [Pubkey::default(); ProtocolConfig::MAX_MULTISIG_OWNERS],
        }
    }
}

impl ProtocolConfig {
    pub const MAX_MULTISIG_OWNERS: usize = 5;
    pub const DEFAULT_MAX_CLAIM_DURATION: i64 = 7 * 24 * 60 * 60; // 7 days
    pub const DEFAULT_MAX_DISPUTE_DURATION: i64 = 7 * 24 * 60 * 60; // 7 days
    pub const DEFAULT_SLASH_PERCENTAGE: u8 = 10;
    pub const SIZE: usize = 8 + // discriminator
        32 + // authority
        32 + // treasury
        1 +  // dispute_threshold
        2 +  // protocol_fee_bps
        8 +  // min_arbiter_stake
        8 +  // min_agent_stake
        8 +  // max_claim_duration
        8 +  // max_dispute_duration
        8 +  // total_agents
        8 +  // total_tasks
        8 +  // completed_tasks
        8 +  // total_value_distributed
        1 +  // bump
        1 +  // multisig_threshold
        1 +  // multisig_owners_len
        8 +  // task_creation_cooldown
        1 +  // max_tasks_per_24h
        8 +  // dispute_initiation_cooldown
        1 +  // max_disputes_per_24h
        8 +  // min_stake_for_dispute
        1 +  // slash_percentage
        1 +  // protocol_version
        1 +  // min_supported_version
        2 +  // padding
        (32 * Self::MAX_MULTISIG_OWNERS); // multisig owners

    /// Check if the protocol version is compatible
    pub fn is_version_compatible(&self) -> bool {
        self.min_supported_version >= MIN_SUPPORTED_VERSION
            && self.protocol_version >= self.min_supported_version
            && self.protocol_version <= CURRENT_PROTOCOL_VERSION
    }
}

/// Agent registration account
/// PDA seeds: ["agent", agent_id]
#[account]
#[derive(Default)]
pub struct AgentRegistration {
    /// Unique agent identifier
    pub agent_id: [u8; 32],
    /// Agent's signing authority
    pub authority: Pubkey,
    /// Capability bitmask
    pub capabilities: u64,
    /// Agent status
    pub status: AgentStatus,
    /// Network endpoint (max 128 chars)
    pub endpoint: String,
    /// Extended metadata URI (max 128 chars)
    pub metadata_uri: String,
    /// Registration timestamp
    pub registered_at: i64,
    /// Last activity timestamp
    pub last_active: i64,
    /// Total tasks completed
    pub tasks_completed: u64,
    /// Total rewards earned
    pub total_earned: u64,
    /// Reputation score (0-10000)
    pub reputation: u16,
    /// Active task count
    pub active_tasks: u8,
    /// Stake amount (for arbiters)
    pub stake: u64,
    /// Bump seed
    pub bump: u8,
    // === Rate limiting fields ===
    /// Timestamp of last task creation
    pub last_task_created: i64,
    /// Timestamp of last dispute initiated
    pub last_dispute_initiated: i64,
    /// Number of tasks created in current 24h window
    pub task_count_24h: u8,
    /// Number of disputes initiated in current 24h window
    pub dispute_count_24h: u8,
    /// Start of current rate limit window (unix timestamp)
    pub rate_limit_window_start: i64,
    /// Active dispute votes pending resolution
    pub active_dispute_votes: u8,
    /// Timestamp of last dispute vote
    pub last_vote_timestamp: i64,
    /// Timestamp of last state update
    pub last_state_update: i64,
    /// Reserved for future use
    pub _reserved: [u8; 6],
}

impl AgentRegistration {
    pub const SIZE: usize = 8 + // discriminator
        32 + // agent_id
        32 + // authority
        8 +  // capabilities
        1 +  // status
        4 + 128 + // endpoint (string)
        4 + 128 + // metadata_uri (string)
        8 +  // registered_at
        8 +  // last_active
        8 +  // tasks_completed
        8 +  // total_earned
        2 +  // reputation
        1 +  // active_tasks
        8 +  // stake
        1 +  // bump
        8 +  // last_task_created
        8 +  // last_dispute_initiated
        1 +  // task_count_24h
        1 +  // dispute_count_24h
        8 +  // rate_limit_window_start
        1 +  // active_dispute_votes
        8 +  // last_vote_timestamp
        8 +  // last_state_update
        6; // reserved
}

/// Task account
/// PDA seeds: ["task", creator, task_id]
#[account]
#[derive(InitSpace)]
pub struct Task {
    /// Unique task identifier
    pub task_id: [u8; 32],
    /// Task creator (paying party)
    pub creator: Pubkey,
    /// Required capability bitmask
    pub required_capabilities: u64,
    /// Task description or instruction hash
    pub description: [u8; 64],
    /// Constraint hash for private task verification (hash of expected output)
    /// For private tasks, workers must prove they know output that hashes to this value
    pub constraint_hash: [u8; 32],
    /// Reward amount in lamports
    pub reward_amount: u64,
    /// Maximum workers allowed
    pub max_workers: u8,
    /// Current worker count
    pub current_workers: u8,
    /// Task status
    pub status: TaskStatus,
    /// Task type
    pub task_type: TaskType,
    /// Creation timestamp
    pub created_at: i64,
    /// Deadline timestamp (0 = no deadline)
    pub deadline: i64,
    /// Completion timestamp
    pub completed_at: i64,
    /// Escrow account for reward
    pub escrow: Pubkey,
    /// Result data or pointer
    pub result: [u8; 64],
    /// Number of completions (for collaborative tasks)
    pub completions: u8,
    /// Required completions
    pub required_completions: u8,
    /// Bump seed
    pub bump: u8,
    /// Optional parent task this task depends on (None for independent tasks)
    pub depends_on: Option<Pubkey>,
    /// Type of dependency relationship
    pub dependency_type: DependencyType,
    /// Reserved
    pub _reserved: [u8; 32],
}

impl Default for Task {
    fn default() -> Self {
        Self {
            task_id: [0u8; 32],
            creator: Pubkey::default(),
            required_capabilities: 0,
            description: [0u8; 64],
            constraint_hash: [0u8; 32],
            reward_amount: 0,
            max_workers: 1,
            current_workers: 0,
            status: TaskStatus::default(),
            task_type: TaskType::default(),
            created_at: 0,
            deadline: 0,
            completed_at: 0,
            escrow: Pubkey::default(),
            result: [0u8; 64],
            completions: 0,
            required_completions: 1,
            bump: 0,
            depends_on: None,
            dependency_type: DependencyType::default(),
            _reserved: [0u8; 32],
        }
    }
}

impl Task {
    /// Prefer using `8 + Task::INIT_SPACE` (from #[derive(InitSpace)]).
    /// This manual constant is kept for backwards compatibility.
    pub const SIZE: usize = 8 + // discriminator
        32 + // task_id
        32 + // creator
        8 +  // required_capabilities
        64 + // description
        32 + // constraint_hash
        8 +  // reward_amount
        1 +  // max_workers
        1 +  // current_workers
        1 +  // status
        1 +  // task_type
        8 +  // created_at
        8 +  // deadline
        8 +  // completed_at
        32 + // escrow
        64 + // result
        1 +  // completions
        1 +  // required_completions
        1 +  // bump
        33 + // depends_on (Option<Pubkey>: 1 byte discriminator + 32 bytes pubkey)
        1 +  // dependency_type
        32; // reserved
}

/// Worker's claim on a task
/// PDA seeds: ["claim", task, worker_agent]
#[account]
pub struct TaskClaim {
    /// Task being claimed
    pub task: Pubkey,
    /// Worker agent
    pub worker: Pubkey,
    /// Claim timestamp
    pub claimed_at: i64,
    /// Expiration timestamp for claim
    pub expires_at: i64,
    /// Completion timestamp
    pub completed_at: i64,
    /// Proof of work hash
    pub proof_hash: [u8; 32],
    /// Result data
    pub result_data: [u8; 64],
    /// Is completed
    pub is_completed: bool,
    /// Is validated
    pub is_validated: bool,
    /// Reward paid
    pub reward_paid: u64,
    /// Bump seed
    pub bump: u8,
}

impl Default for TaskClaim {
    fn default() -> Self {
        Self {
            task: Pubkey::default(),
            worker: Pubkey::default(),
            claimed_at: 0,
            expires_at: 0,
            completed_at: 0,
            proof_hash: [0u8; 32],
            result_data: [0u8; 64],
            is_completed: false,
            is_validated: false,
            reward_paid: 0,
            bump: 0,
        }
    }
}

impl TaskClaim {
    pub const SIZE: usize = 8 + // discriminator
        32 + // task
        32 + // worker
        8 +  // claimed_at
        8 +  // expires_at
        8 +  // completed_at
        32 + // proof_hash
        64 + // result_data
        1 +  // is_completed
        1 +  // is_validated
        8 +  // reward_paid
        1; // bump
}

/// Shared coordination state
/// PDA seeds: ["state", state_key]
#[account]
pub struct CoordinationState {
    /// State key
    pub state_key: [u8; 32],
    /// State value
    pub state_value: [u8; 64],
    /// Last updater
    pub last_updater: Pubkey,
    /// Version for optimistic locking
    pub version: u64,
    /// Last update timestamp
    pub updated_at: i64,
    /// Bump seed
    pub bump: u8,
}

impl Default for CoordinationState {
    fn default() -> Self {
        Self {
            state_key: [0u8; 32],
            state_value: [0u8; 64],
            last_updater: Pubkey::default(),
            version: 0,
            updated_at: 0,
            bump: 0,
        }
    }
}

impl CoordinationState {
    pub const SIZE: usize = 8 + // discriminator
        32 + // state_key
        64 + // state_value
        32 + // last_updater
        8 +  // version
        8 +  // updated_at
        1; // bump
}

/// Dispute account for conflict resolution
/// PDA seeds: ["dispute", dispute_id]
#[account]
#[derive(Default)]
pub struct Dispute {
    /// Dispute identifier
    pub dispute_id: [u8; 32],
    /// Related task
    pub task: Pubkey,
    /// Initiator (agent PDA)
    pub initiator: Pubkey,
    /// Initiator's authority wallet (for resolver signer check, fix #340)
    pub initiator_authority: Pubkey,
    /// Evidence hash
    pub evidence_hash: [u8; 32],
    /// Proposed resolution type
    pub resolution_type: ResolutionType,
    /// Dispute status
    pub status: DisputeStatus,
    /// Creation timestamp
    pub created_at: i64,
    /// Resolution timestamp
    pub resolved_at: i64,
    /// Votes for approval
    pub votes_for: u64,
    /// Votes against
    pub votes_against: u64,
    /// Total eligible voters
    pub total_voters: u8,
    /// Voting deadline
    pub voting_deadline: i64,
    /// Dispute expiration timestamp
    pub expires_at: i64,
    /// Whether worker slashing has been applied
    pub slash_applied: bool,
    /// Whether initiator slashing has been applied (for rejected disputes)
    pub initiator_slash_applied: bool,
    /// Bump seed
    pub bump: u8,
}

impl Dispute {
    pub const SIZE: usize = 8 + // discriminator
        32 + // dispute_id
        32 + // task
        32 + // initiator
        32 + // initiator_authority (fix #340)
        32 + // evidence_hash
        1 +  // resolution_type
        1 +  // status
        8 +  // created_at
        8 +  // resolved_at
        8 +  // votes_for
        8 +  // votes_against
        1 +  // total_voters
        8 +  // voting_deadline
        8 +  // expires_at
        1 +  // slash_applied
        1 +  // initiator_slash_applied
        1; // bump
}

/// Vote record for dispute
/// PDA seeds: ["vote", dispute, voter]
#[account]
#[derive(Default)]
pub struct DisputeVote {
    /// Dispute being voted on
    pub dispute: Pubkey,
    /// Voter (arbiter)
    pub voter: Pubkey,
    /// Vote (true = approve, false = reject)
    pub approved: bool,
    /// Vote timestamp
    pub voted_at: i64,
    /// Bump seed
    pub bump: u8,
}

impl DisputeVote {
    pub const SIZE: usize = 8 + // discriminator
        32 + // dispute
        32 + // voter
        1 +  // approved
        8 +  // voted_at
        1; // bump
}

/// Authority-level vote record to prevent Sybil attacks
/// One authority can only vote once per dispute, regardless of how many agents they control
/// PDA seeds: ["authority_vote", dispute, authority]
#[account]
#[derive(Default)]
pub struct AuthorityDisputeVote {
    /// Dispute being voted on
    pub dispute: Pubkey,
    /// Authority (wallet) that voted
    pub authority: Pubkey,
    /// The agent used to cast this vote
    pub voting_agent: Pubkey,
    /// Vote timestamp
    pub voted_at: i64,
    /// Bump seed
    pub bump: u8,
}

impl AuthorityDisputeVote {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // dispute
        32 + // authority
        32 + // voting_agent
        8 + // voted_at
        1; // bump
}

/// Task escrow account
/// PDA seeds: ["escrow", task]
#[account]
#[derive(Default)]
pub struct TaskEscrow {
    /// Task this escrow belongs to
    pub task: Pubkey,
    /// Total amount deposited
    pub amount: u64,
    /// Amount already distributed
    pub distributed: u64,
    /// Is closed
    pub is_closed: bool,
    /// Bump seed
    pub bump: u8,
}

impl TaskEscrow {
    pub const SIZE: usize = 8 + // discriminator
        32 + // task
        8 +  // amount
        8 +  // distributed
        1 +  // is_closed
        1; // bump
}

/// Agent's speculation bond account
/// PDA seeds: ["speculation_bond", agent]
#[account]
pub struct SpeculationBond {
    pub agent: Pubkey,
    pub total_bonded: u64,
    pub available: u64,
    pub total_deposited: u64,
    pub total_slashed: u64,
    pub bump: u8,
}

impl SpeculationBond {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 1;
}

/// On-chain record of a speculative commitment
#[account]
pub struct SpeculativeCommitment {
    pub task: Pubkey,
    pub producer: Pubkey,
    pub result_hash: [u8; 32],
    pub confirmed: bool,
    pub expires_at: i64,
    pub bonded_stake: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl SpeculativeCommitment {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 1 + 8 + 8 + 8 + 1; // 130 bytes
}
