//! Account state structures for the AgenC Coordination Protocol

use anchor_lang::prelude::*;

// ============================================================================
// Size Constants
// ============================================================================

/// Size of cryptographic hashes and IDs (SHA256, Pubkey bytes)
pub const HASH_SIZE: usize = 32;

/// Size of result/description/value data fields
pub const RESULT_DATA_SIZE: usize = 64;

/// Agent capability flags (bitmask).
///
/// Capabilities are represented as a 64-bit bitmask where each bit indicates
/// a specific capability the agent possesses. Tasks specify required capabilities
/// and only agents with matching capabilities can claim them.
///
/// # Currently Defined Bits (10 of 64)
///
/// | Bit | Constant      | Description                                      |
/// |-----|---------------|--------------------------------------------------|
/// |  0  | `COMPUTE`     | General computation tasks                        |
/// |  1  | `INFERENCE`   | Machine learning inference                       |
/// |  2  | `STORAGE`     | Data storage and retrieval                       |
/// |  3  | `NETWORK`     | Network relay and communication                  |
/// |  4  | `SENSOR`      | Sensor data collection (IoT, monitoring)         |
/// |  5  | `ACTUATOR`    | Physical actuation (robotics, hardware control)  |
/// |  6  | `COORDINATOR` | Task coordination and orchestration              |
/// |  7  | `ARBITER`     | Dispute resolution voting rights                 |
/// |  8  | `VALIDATOR`   | Result validation and verification               |
/// |  9  | `AGGREGATOR`  | Data aggregation and summarization               |
///
/// # Reserved Bits
///
/// Bits 10-63 are reserved for future protocol extensions.
///
/// # Usage Examples
///
/// ```ignore
/// use agenc_coordination::state::capability;
///
/// // Single capability
/// let compute_agent = capability::COMPUTE;
///
/// // Multiple capabilities (bitwise OR)
/// let ml_agent = capability::COMPUTE | capability::INFERENCE | capability::STORAGE;
///
/// // Check if agent has required capabilities
/// let has_caps = (agent.capabilities & task.required_capabilities) == task.required_capabilities;
/// ```
pub mod capability {
    /// General computation tasks
    pub const COMPUTE: u64 = 1 << 0;
    /// Machine learning inference
    pub const INFERENCE: u64 = 1 << 1;
    /// Data storage and retrieval
    pub const STORAGE: u64 = 1 << 2;
    /// Network relay and communication
    pub const NETWORK: u64 = 1 << 3;
    /// Sensor data collection (IoT, monitoring)
    pub const SENSOR: u64 = 1 << 4;
    /// Physical actuation (robotics, hardware control)
    pub const ACTUATOR: u64 = 1 << 5;
    /// Task coordination and orchestration
    pub const COORDINATOR: u64 = 1 << 6;
    /// Dispute resolution voting rights
    pub const ARBITER: u64 = 1 << 7;
    /// Result validation and verification
    pub const VALIDATOR: u64 = 1 << 8;
    /// Data aggregation and summarization
    pub const AGGREGATOR: u64 = 1 << 9;

    /// Bitmask covering all currently defined capabilities (bits 0-9)
    pub const ALL_DEFINED: u64 = (1 << 10) - 1;
}

/// Agent status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
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

impl TaskStatus {
    /// Validates whether a status transition is allowed.
    ///
    /// Valid transitions:
    /// - Open → InProgress (when task is claimed)
    /// - Open → Cancelled (when task is cancelled before any claims)
    /// - InProgress → Completed (when task is completed)
    /// - InProgress → Cancelled (when task is cancelled after deadline with no completions)
    /// - InProgress → Disputed (when a dispute is initiated)
    /// - InProgress → PendingValidation (reserved for future validation flow)
    /// - PendingValidation → Completed (after validation passes)
    /// - PendingValidation → Disputed (when validation is contested)
    /// - Disputed → Completed (dispute resolved in favor of completion)
    /// - Disputed → Cancelled (dispute resolved with refund/split, or expired)
    ///
    /// Terminal states (Completed, Cancelled) cannot transition to any other state.
    pub fn can_transition_to(&self, new_status: TaskStatus) -> bool {
        use TaskStatus::*;
        matches!(
            (self, new_status),
            // From Open
            (Open, InProgress) | (Open, Cancelled) |
            // From InProgress (InProgress -> InProgress for additional claims on collaborative tasks)
            (InProgress, InProgress) | (InProgress, Completed) | (InProgress, Cancelled) |
            (InProgress, Disputed) | (InProgress, PendingValidation) |
            // From PendingValidation
            (PendingValidation, Completed) | (PendingValidation, Disputed) |
            // From Disputed
            (Disputed, Completed) | (Disputed, Cancelled)
        )
    }
}

/// Task type enumeration
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum TaskType {
    /// Exclusive - only one worker can claim
    #[default]
    Exclusive = 0,
    /// Collaborative - multiple workers share the task
    Collaborative = 1,
    /// Competitive - multiple workers race; first to complete wins.
    /// Race condition handling: Claims are first-come-first-served.
    /// Only the first valid completion receives the reward.
    Competitive = 2,
}

/// Task dependency type for speculative execution decisions
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum DependencyType {
    /// No dependency - task can execute independently.
    /// This is the default (0) and matches the default field initialization.
    #[default]
    None = 0,
    /// Data dependency - needs parent output data (speculatable)
    Data = 1,
    /// Ordering dependency - must run after parent (speculatable)
    Ordering = 2,
    /// Proof dependency - requires parent task's on-chain completion proof (NOT speculatable)
    Proof = 3,
}

/// Dispute resolution type
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum ResolutionType {
    #[default]
    Refund = 0, // Full refund to task creator
    Complete = 1, // Mark task as complete, pay worker
    Split = 2,    // Split reward between parties
}

/// Dispute status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum DisputeStatus {
    #[default]
    Active = 0,
    Resolved = 1,
    Expired = 2,
    Cancelled = 3,
}

/// Reason for slashing an agent's stake
///
/// These correspond to verification failures where slashing applies as a penalty
/// for submitting invalid or incomplete work.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SlashReason {
    /// Proof verification failed (cryptographic proof invalid)
    ProofFailed = 0,
    /// Proof was not submitted within the required timeframe
    ProofTimeout = 1,
    /// Result data failed validation checks
    InvalidResult = 2,
}

/// Current protocol version
pub const CURRENT_PROTOCOL_VERSION: u8 = 1;

/// Minimum supported protocol version for backward compatibility
pub const MIN_SUPPORTED_VERSION: u8 = 1;

/// Protocol configuration account
/// PDA seeds: ["protocol"]
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    /// Protocol authority
    /// Note: Cannot be updated after initialization.
    pub authority: Pubkey,
    /// Treasury address for protocol fees
    /// Note: Cannot be updated after initialization.
    /// Deploy new protocol if treasury change needed.
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
    /// Cooldown between state updates per agent (seconds, 0 = disabled) (fix #415)
    pub state_update_cooldown: i64,
    /// Voting period for disputes in seconds (default: 24 hours)
    pub voting_period: i64,
    // === Versioning fields ===
    /// Current protocol version (for upgrades)
    pub protocol_version: u8,
    /// Minimum supported version for backward compatibility
    pub min_supported_version: u8,
    /// Padding for future use and alignment
    /// Currently unused but reserved for backwards-compatible additions
    pub _padding: [u8; 2],
    /// Multisig owners (immutable after init for security).
    ///
    /// # Security Note (see #464)
    /// Multisig configuration **cannot be updated** after protocol initialization.
    /// To change multisig, deploy new protocol.
    ///
    /// This is intentional:
    /// - Prevents hostile takeover via multisig reconfiguration
    /// - Ensures governance changes require protocol redeployment with proper ceremony
    /// - The array is fully zeroed before population in `initialize_protocol`
    ///
    /// Only the first `multisig_owners_len` entries are valid; remaining slots
    /// are always `Pubkey::default()`.
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
            min_stake_for_dispute: 100_000_000, // 0.1 SOL default for anti-griefing
            slash_percentage: ProtocolConfig::DEFAULT_SLASH_PERCENTAGE,
            state_update_cooldown: 60, // 60 seconds between state updates (fix #415)
            voting_period: ProtocolConfig::DEFAULT_VOTING_PERIOD,
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
    /// Default percentage of stake slashed for malicious behavior.
    /// Increased from 10% to 25% to provide stronger deterrence against bad actors
    /// while remaining proportionate to typical violation severity.
    pub const DEFAULT_SLASH_PERCENTAGE: u8 = 25;
    /// Default voting period for disputes: 24 hours
    pub const DEFAULT_VOTING_PERIOD: i64 = 24 * 60 * 60;
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
        8 +  // state_update_cooldown
        8 +  // voting_period
        1 +  // protocol_version
        1 +  // min_supported_version
        2 +  // padding
        (32 * Self::MAX_MULTISIG_OWNERS); // multisig owners

    /// Check if the protocol version is compatible
    pub fn is_version_compatible(&self) -> bool {
        // Config's min_supported should be within reasonable bounds
        self.min_supported_version <= self.protocol_version
            && self.protocol_version <= CURRENT_PROTOCOL_VERSION
            // Program can read configs at or above program's min
            && self.protocol_version >= MIN_SUPPORTED_VERSION
    }

    /// Validates that padding bytes are zeroed.
    /// Called during migration to ensure no data corruption.
    pub fn validate_padding_fields(&self) -> bool {
        self._padding == [0u8; 2]
    }
}

/// Agent registration account
/// PDA seeds: ["agent", agent_id]
#[account]
#[derive(Default, InitSpace)]
pub struct AgentRegistration {
    /// Unique agent identifier
    pub agent_id: [u8; 32],
    /// Agent's signing authority
    pub authority: Pubkey,
    /// Agent capabilities as a bitmask (u64).
    ///
    /// Each bit represents a specific capability the agent possesses.
    /// See [`capability`] module for defined bits:
    /// - Bits 0-9: Currently defined capabilities (COMPUTE, INFERENCE, etc.)
    /// - Bits 10-63: Reserved for future protocol extensions
    ///
    /// Agents can only claim tasks where they have all required capabilities:
    /// `(agent.capabilities & task.required_capabilities) == task.required_capabilities`
    pub capabilities: u64,
    /// Agent status
    pub status: AgentStatus,
    /// Network endpoint (max 256 chars)
    #[max_len(256)]
    pub endpoint: String,
    /// Extended metadata URI (max 128 chars)
    #[max_len(128)]
    pub metadata_uri: String,
    /// Registration timestamp
    pub registered_at: i64,
    /// Last activity timestamp
    pub last_active: i64,
    /// Total tasks completed
    pub tasks_completed: u64,
    /// Total rewards earned
    pub total_earned: u64,
    /// Agent reputation score (0-10000)
    /// Initial value: 5000 (neutral starting point)
    /// Can be adjusted via protocol config in future versions
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
    /// Active disputes where this agent is a defendant (can be slashed)
    pub disputes_as_defendant: u8,
    /// Reserved bytes for future use.
    /// Note: Not validated on deserialization - may contain arbitrary data
    /// from previous versions. New fields should handle this gracefully.
    pub _reserved: [u8; 5],
}

impl AgentRegistration {
    pub const SIZE: usize = 8 + // discriminator
        32 + // agent_id
        32 + // authority
        8 +  // capabilities
        1 +  // status
        4 + 256 + // endpoint (string)
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
        1 +  // disputes_as_defendant
        5; // reserved

    /// Validates that reserved bytes are zeroed.
    /// Called during migration to ensure no data corruption.
    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 5]
    }
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
    /// Required capability bitmask (u64).
    ///
    /// Specifies which capabilities an agent must have to claim this task.
    /// See [`capability`] module for defined bits. An agent can claim this
    /// task only if: `(agent.capabilities & required_capabilities) == required_capabilities`
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
    /// Protocol fee in basis points, locked at task creation (#479)
    pub protocol_fee_bps: u16,
    /// Optional parent task this task depends on (None for independent tasks)
    pub depends_on: Option<Pubkey>,
    /// Type of dependency relationship
    pub dependency_type: DependencyType,
    /// Minimum reputation score (0-10000) required for workers to claim this task.
    /// 0 means no reputation gate (default for backward compatibility).
    pub min_reputation: u16,
    /// Optional SPL token mint for reward denomination.
    /// None = SOL rewards (default, backward compatible).
    /// Some(mint) = SPL token rewards using the specified mint.
    pub reward_mint: Option<Pubkey>,
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
            protocol_fee_bps: 0,
            depends_on: None,
            dependency_type: DependencyType::default(),
            min_reputation: 0,
            reward_mint: None,
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
        2 +  // protocol_fee_bps
        33 + // depends_on (Option<Pubkey>: 1 byte discriminator + 32 bytes pubkey)
        1 +  // dependency_type
        2 +  // min_reputation
        33; // reward_mint (Option<Pubkey>: 1 byte discriminator + 32 bytes pubkey)
}

/// Worker's claim on a task
/// PDA seeds: ["claim", task, worker_agent]
#[account]
#[derive(InitSpace)]
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
/// PDA seeds: ["state", owner, state_key]
#[account]
#[derive(InitSpace)]
pub struct CoordinationState {
    /// Owner authority - namespaces state to prevent cross-user collisions
    pub owner: Pubkey,
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
            owner: Pubkey::default(),
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
        32 + // owner
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
#[derive(Default, InitSpace)]
pub struct Dispute {
    /// Dispute identifier
    pub dispute_id: [u8; 32],
    /// Related task
    pub task: Pubkey,
    /// Initiator (agent PDA)
    pub initiator: Pubkey,
    /// Initiator's authority wallet (for resolver constraint)
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
    /// Total arbiters who voted (max 255 due to u8)
    /// Note: Increase to u16 if more arbiters needed
    pub total_voters: u8,
    /// Voting deadline - after this, no new votes accepted
    /// voting_deadline = created_at + voting_period
    pub voting_deadline: i64,
    /// Dispute expiration - after this, can call expire_dispute
    /// expires_at = created_at + max_dispute_duration
    /// Note: expires_at >= voting_deadline, allowing resolution after voting ends
    pub expires_at: i64,
    /// Whether worker slashing has been applied
    pub slash_applied: bool,
    /// Whether initiator slashing has been applied (for rejected disputes)
    pub initiator_slash_applied: bool,
    /// Snapshot of worker's stake at dispute initiation (prevents stake withdrawal attacks)
    pub worker_stake_at_dispute: u64,
    /// Whether the dispute was initiated by the task creator (fix #407)
    /// Used to apply stricter requirements and different expiration behavior for creator disputes
    pub initiated_by_creator: bool,
    /// Bump seed
    pub bump: u8,
    /// The defendant worker's agent PDA (fix #827)
    /// Binds slashing target at dispute initiation to prevent slashing wrong worker
    /// on collaborative tasks with multiple claimants.
    pub defendant: Pubkey,
}

impl Dispute {
    pub const SIZE: usize = 8 + // discriminator
        32 + // dispute_id
        32 + // task
        32 + // initiator
        32 + // initiator_authority
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
        8 +  // worker_stake_at_dispute
        1 +  // initiated_by_creator
        1 +  // bump
        32; // defendant (fix #827)
}

/// Vote record for dispute
/// PDA seeds: ["vote", dispute, voter]
#[account]
#[derive(Default, InitSpace)]
pub struct DisputeVote {
    /// Dispute being voted on
    pub dispute: Pubkey,
    /// Voter (arbiter)
    pub voter: Pubkey,
    /// Vote (true = approve, false = reject)
    pub approved: bool,
    /// Vote timestamp
    pub voted_at: i64,
    /// Arbiter's stake at the time of voting (for weighted resolution)
    pub stake_at_vote: u64,
    /// Bump seed
    pub bump: u8,
}

impl DisputeVote {
    pub const SIZE: usize = 8 + // discriminator
        32 + // dispute
        32 + // voter
        1 +  // approved
        8 +  // voted_at
        8 +  // stake_at_vote
        1; // bump
}

/// Authority-level vote record to prevent Sybil attacks
/// One authority can only vote once per dispute, regardless of how many agents they control
/// PDA seeds: ["authority_vote", dispute, authority]
#[account]
#[derive(Default, InitSpace)]
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
#[derive(Default, InitSpace)]
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
#[derive(Default, InitSpace)]
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
#[derive(Default, InitSpace)]
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

/// Nullifier account to prevent proof/knowledge reuse across tasks.
/// Once a nullifier is "spent" (account exists), the same proof/knowledge
/// combination cannot be used again.
/// PDA seeds: ["nullifier", nullifier_value]
#[account]
#[derive(Default, InitSpace)]
pub struct Nullifier {
    /// The nullifier value (derived from constraint_hash + agent_secret in ZK circuit)
    pub nullifier_value: [u8; 32],
    /// The task where this nullifier was first used
    pub task: Pubkey,
    /// The agent who spent this nullifier
    pub agent: Pubkey,
    /// Timestamp when nullifier was spent
    pub spent_at: i64,
    /// Bump seed for PDA
    pub bump: u8,
}

impl Nullifier {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // nullifier_value
        32 + // task
        32 + // agent
        8 +  // spent_at
        1;   // bump
}

// ============================================================================
// Governance
// ============================================================================

/// Governance configuration account
/// PDA seeds: ["governance"]
#[account]
#[derive(InitSpace)]
pub struct GovernanceConfig {
    /// Protocol authority (must match ProtocolConfig.authority at init time)
    pub authority: Pubkey,
    /// Minimum stake required to create a proposal
    pub min_proposal_stake: u64,
    /// Voting period in seconds for new proposals
    pub voting_period: i64,
    /// Execution delay after voting ends (timelock) in seconds
    pub execution_delay: i64,
    /// Quorum in basis points of total agents' stake
    pub quorum_bps: u16,
    /// Approval threshold in basis points (e.g., 5000 = simple majority)
    pub approval_threshold_bps: u16,
    /// Total proposals created (monotonic counter)
    pub total_proposals: u64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 64],
}

impl GovernanceConfig {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // authority
        8 +  // min_proposal_stake
        8 +  // voting_period
        8 +  // execution_delay
        2 +  // quorum_bps
        2 +  // approval_threshold_bps
        8 +  // total_proposals
        1 +  // bump
        64;  // _reserved

    /// Default voting period: 3 days
    pub const DEFAULT_VOTING_PERIOD: i64 = 3 * 24 * 60 * 60;

    /// Maximum voting period: 7 days
    pub const MAX_VOTING_PERIOD: i64 = 7 * 24 * 60 * 60;

    /// Default execution delay: 1 day
    pub const DEFAULT_EXECUTION_DELAY: i64 = 24 * 60 * 60;

    /// Maximum execution delay: 7 days
    pub const MAX_EXECUTION_DELAY: i64 = 7 * 24 * 60 * 60;
}

/// Governance proposal type
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum ProposalType {
    /// Change protocol parameters (fee tiers, thresholds)
    #[default]
    ProtocolUpgrade = 0,
    /// Change protocol fee
    FeeChange = 1,
    /// Transfer lamports from treasury
    TreasurySpend = 2,
    /// Change rate limit parameters
    RateLimitChange = 3,
}

/// Governance proposal status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum ProposalStatus {
    /// Proposal is accepting votes
    #[default]
    Active = 0,
    /// Proposal passed and was executed
    Executed = 1,
    /// Proposal failed to reach quorum or majority
    Defeated = 2,
    /// Proposal was cancelled by proposer
    Cancelled = 3,
}

/// Governance proposal account
/// PDA seeds: ["proposal", proposer, nonce]
#[account]
#[derive(InitSpace)]
pub struct Proposal {
    /// Proposer's agent PDA
    pub proposer: Pubkey,
    /// Proposer's authority wallet
    pub proposer_authority: Pubkey,
    /// Monotonic nonce per proposer (allows multiple proposals)
    pub nonce: u64,
    /// Proposal type
    pub proposal_type: ProposalType,
    /// Title hash (SHA256 of title string)
    pub title_hash: [u8; 32],
    /// Description hash (SHA256 of description/URI)
    pub description_hash: [u8; 32],
    /// Type-specific payload (64 bytes)
    /// FeeChange: new fee bps as u16 LE in bytes [0..2], rest zero
    /// TreasurySpend: recipient Pubkey [0..32] + amount u64 LE [32..40], rest zero
    /// ProtocolUpgrade: reserved for future parameter batch changes
    pub payload: [u8; 64],
    /// Current status
    pub status: ProposalStatus,
    /// Creation timestamp
    pub created_at: i64,
    /// Voting deadline (no new votes accepted after this)
    pub voting_deadline: i64,
    /// Earliest timestamp at which the proposal can be executed (timelock)
    pub execution_after: i64,
    /// Execution timestamp (0 if not executed)
    pub executed_at: i64,
    /// Total stake-weighted votes for approval
    pub votes_for: u64,
    /// Total stake-weighted votes against
    pub votes_against: u64,
    /// Number of individual voters
    pub total_voters: u16,
    /// Required quorum (minimum total stake-weighted votes)
    pub quorum: u64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 64],
}

impl Proposal {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // proposer
        32 + // proposer_authority
        8 +  // nonce
        1 +  // proposal_type
        32 + // title_hash
        32 + // description_hash
        64 + // payload
        1 +  // status
        8 +  // created_at
        8 +  // voting_deadline
        8 +  // execution_after
        8 +  // executed_at
        8 +  // votes_for
        8 +  // votes_against
        2 +  // total_voters
        8 +  // quorum
        1 +  // bump
        64;  // _reserved
}

/// Governance vote record
/// PDA seeds: ["governance_vote", proposal, voter]
#[account]
#[derive(Default, InitSpace)]
pub struct GovernanceVote {
    /// Proposal being voted on
    pub proposal: Pubkey,
    /// Voter (agent PDA)
    pub voter: Pubkey,
    /// Vote (true = approve, false = reject)
    pub approved: bool,
    /// Vote timestamp
    pub voted_at: i64,
    /// Voter's effective vote weight (reputation * stake, capped)
    pub vote_weight: u64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 8],
}

impl GovernanceVote {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // proposal
        32 + // voter
        1 +  // approved
        8 +  // voted_at
        8 +  // vote_weight
        1 +  // bump
        8;   // _reserved
}

// ============================================================================
// Skill Registry
// ============================================================================

/// Skill registration account
/// PDA seeds: ["skill", author_agent_pda, skill_id]
#[account]
#[derive(InitSpace)]
pub struct SkillRegistration {
    /// Author's agent PDA
    pub author: Pubkey,
    /// Unique skill identifier
    pub skill_id: [u8; 32],
    /// Skill display name
    pub name: [u8; 32],
    /// Content hash (IPFS CID, Arweave tx, etc.)
    pub content_hash: [u8; 32],
    /// Price in lamports (SOL) or token smallest units
    pub price: u64,
    /// Optional SPL token mint for price denomination (None = SOL)
    pub price_mint: Option<Pubkey>,
    /// Tags for discovery (encoded by client)
    pub tags: [u8; 64],
    /// Sum of reputation-weighted ratings
    pub total_rating: u64,
    /// Number of ratings received
    pub rating_count: u32,
    /// Number of purchases
    pub download_count: u32,
    /// Content version (monotonically increasing)
    pub version: u8,
    /// Whether the skill is currently active
    pub is_active: bool,
    /// Creation timestamp
    pub created_at: i64,
    /// Last update timestamp
    pub updated_at: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 8],
}

impl SkillRegistration {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // author
        32 + // skill_id
        32 + // name
        32 + // content_hash
        8 +  // price
        33 + // price_mint (Option<Pubkey>)
        64 + // tags
        8 +  // total_rating
        4 +  // rating_count
        4 +  // download_count
        1 +  // version
        1 +  // is_active
        8 +  // created_at
        8 +  // updated_at
        1 +  // bump
        8;   // _reserved
}

/// Skill rating record (one per rater per skill)
/// PDA seeds: ["skill_rating", skill_pda, rater_agent_pda]
#[account]
#[derive(InitSpace)]
pub struct SkillRating {
    /// Skill being rated
    pub skill: Pubkey,
    /// Rater's agent PDA
    pub rater: Pubkey,
    /// Rating value (1-5)
    pub rating: u8,
    /// Optional review content hash
    pub review_hash: Option<[u8; 32]>,
    /// Rater's reputation at time of rating
    pub rater_reputation: u16,
    /// Rating timestamp
    pub timestamp: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 4],
}

impl SkillRating {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // skill
        32 + // rater
        1 +  // rating
        33 + // review_hash (Option<[u8;32]>)
        2 +  // rater_reputation
        8 +  // timestamp
        1 +  // bump
        4;   // _reserved
}

/// Purchase record (one per buyer per skill, prevents double purchase)
/// PDA seeds: ["skill_purchase", skill_pda, buyer_agent_pda]
#[account]
#[derive(InitSpace)]
pub struct PurchaseRecord {
    /// Skill purchased
    pub skill: Pubkey,
    /// Buyer's agent PDA
    pub buyer: Pubkey,
    /// Price paid at time of purchase
    pub price_paid: u64,
    /// Purchase timestamp
    pub timestamp: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 4],
}

impl PurchaseRecord {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // skill
        32 + // buyer
        8 +  // price_paid
        8 +  // timestamp
        1 +  // bump
        4;   // _reserved
}

/// Agent feed post (content hash stored on-chain, content on IPFS)
/// PDA seeds: ["post", author_agent_pda, nonce]
#[account]
#[derive(InitSpace)]
pub struct FeedPost {
    /// Author agent PDA
    pub author: Pubkey,
    /// IPFS content hash (CIDv1 or SHA-256 of content)
    pub content_hash: [u8; 32],
    /// Topic identifier (application-level grouping)
    pub topic: [u8; 32],
    /// Optional parent post PDA (for replies/threads)
    pub parent_post: Option<Pubkey>,
    /// Unique nonce (client-generated UUID)
    pub nonce: [u8; 32],
    /// Number of upvotes
    pub upvote_count: u32,
    /// Creation timestamp
    pub created_at: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 8],
}

impl FeedPost {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // author
        32 + // content_hash
        32 + // topic
        33 + // parent_post (Option<Pubkey>)
        32 + // nonce
        4 +  // upvote_count
        8 +  // created_at
        1 +  // bump
        8;   // _reserved
}

/// Feed upvote record (one per voter per post, prevents double voting)
/// PDA seeds: ["upvote", post_pda, voter_agent_pda]
#[account]
#[derive(InitSpace)]
pub struct FeedVote {
    /// Post PDA that was upvoted
    pub post: Pubkey,
    /// Voter agent PDA
    pub voter: Pubkey,
    /// Vote timestamp
    pub timestamp: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 4],
}

impl FeedVote {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // post
        32 + // voter
        8 +  // timestamp
        1 +  // bump
        4;   // _reserved
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: SIZE should equal INIT_SPACE (borsh serialized) + 8-byte discriminator.
    /// Note: std::mem::size_of doesn't work here because Rust adds alignment padding
    /// that borsh serialization doesn't include.
    macro_rules! test_size_constant {
        ($struct:ty) => {
            assert_eq!(
                <$struct>::SIZE,
                <$struct as anchor_lang::Space>::INIT_SPACE + 8,
                concat!(stringify!($struct), "::SIZE mismatch with INIT_SPACE")
            );
        };
    }

    #[test]
    fn test_protocol_config_size() {
        test_size_constant!(ProtocolConfig);
    }

    #[test]
    fn test_agent_registration_size() {
        test_size_constant!(AgentRegistration);
    }

    #[test]
    fn test_task_size() {
        test_size_constant!(Task);
    }

    #[test]
    fn test_task_claim_size() {
        test_size_constant!(TaskClaim);
    }

    #[test]
    fn test_coordination_state_size() {
        test_size_constant!(CoordinationState);
    }

    #[test]
    fn test_dispute_size() {
        test_size_constant!(Dispute);
    }

    #[test]
    fn test_dispute_vote_size() {
        test_size_constant!(DisputeVote);
    }

    #[test]
    fn test_authority_dispute_vote_size() {
        test_size_constant!(AuthorityDisputeVote);
    }

    #[test]
    fn test_task_escrow_size() {
        test_size_constant!(TaskEscrow);
    }

    #[test]
    fn test_speculation_bond_size() {
        test_size_constant!(SpeculationBond);
    }

    #[test]
    fn test_speculative_commitment_size() {
        test_size_constant!(SpeculativeCommitment);
    }

    #[test]
    fn test_nullifier_size() {
        test_size_constant!(Nullifier);
    }

    #[test]
    fn test_governance_config_size() {
        test_size_constant!(GovernanceConfig);
    }

    #[test]
    fn test_proposal_size() {
        test_size_constant!(Proposal);
    }

    #[test]
    fn test_governance_vote_size() {
        test_size_constant!(GovernanceVote);
    }

    #[test]
    fn test_skill_registration_size() {
        test_size_constant!(SkillRegistration);
    }

    #[test]
    fn test_skill_rating_size() {
        test_size_constant!(SkillRating);
    }

    #[test]
    fn test_purchase_record_size() {
        test_size_constant!(PurchaseRecord);
    }

    #[test]
    fn test_feed_post_size() {
        test_size_constant!(FeedPost);
    }

    #[test]
    fn test_feed_vote_size() {
        test_size_constant!(FeedVote);
    }

    #[test]
    fn test_agent_registration_reserved_fields_default_to_zero() {
        let agent = AgentRegistration::default();
        assert_eq!(agent._reserved, [0u8; 5]);
    }

    #[test]
    fn test_protocol_config_padding_defaults_to_zero() {
        let config = ProtocolConfig::default();
        assert_eq!(config._padding, [0u8; 2]);
    }

    #[test]
    fn test_agent_validate_reserved_fields_ok() {
        let agent = AgentRegistration::default();
        assert!(agent.validate_reserved_fields());
    }

    #[test]
    fn test_agent_validate_reserved_fields_corrupted() {
        let mut agent = AgentRegistration::default();
        agent._reserved[0] = 0xFF;
        assert!(!agent.validate_reserved_fields());
    }

    #[test]
    fn test_config_validate_padding_fields_ok() {
        let config = ProtocolConfig::default();
        assert!(config.validate_padding_fields());
    }

    #[test]
    fn test_config_validate_padding_fields_corrupted() {
        let mut config = ProtocolConfig::default();
        config._padding[0] = 0xFF;
        assert!(!config.validate_padding_fields());
    }
}
