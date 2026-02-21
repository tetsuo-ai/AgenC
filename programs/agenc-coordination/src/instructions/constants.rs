//! Shared constants for instruction handlers

/// Divisor for basis points calculations (100% = 10000 bps)
pub const BASIS_POINTS_DIVISOR: u64 = 10000;

/// Maximum protocol fee in basis points (10% = 1000 bps)
pub const MAX_PROTOCOL_FEE_BPS: u16 = 1000;

/// Base for percentage calculations (100 = 100%)
pub const PERCENT_BASE: u64 = 100;

/// Maximum valid percentage value
pub const MAX_PERCENT: u8 = 100;

/// Reputation points awarded per successful task completion
pub const REPUTATION_PER_COMPLETION: u16 = 100;

/// Maximum reputation an agent can accumulate
pub const MAX_REPUTATION: u16 = 10000;

/// 24-hour window in seconds (86400)
pub const WINDOW_24H: i64 = 86400;

// ============================================================================
// Reputation System Constants
// ============================================================================

/// Minimum possible reputation score
pub const MIN_REPUTATION: u16 = 0;

/// Reputation points lost when losing a dispute (worker or initiator)
pub const REPUTATION_SLASH_LOSS: u16 = 300;

/// Reputation points decayed per inactive period
pub const REPUTATION_DECAY_RATE: u16 = 50;

/// Duration of one decay period in seconds (30 days)
pub const REPUTATION_DECAY_PERIOD: i64 = 2_592_000;

/// Minimum reputation score after decay (floor)
pub const REPUTATION_DECAY_MIN: u16 = 1000;

// ============================================================================
// Dispute Resolution Constants
// ============================================================================

/// Minimum number of voters required for dispute resolution
pub const MIN_VOTERS_FOR_RESOLUTION: usize = 3;

// ============================================================================
// Reputation Economy Constants
// ============================================================================

/// Cooldown period before staked SOL can be withdrawn (7 days in seconds)
pub const REPUTATION_STAKING_COOLDOWN: i64 = 7 * 24 * 60 * 60;

/// Minimum delegation amount in reputation points (1% of max reputation)
pub const MIN_DELEGATION_AMOUNT: u16 = 100;

// ============================================================================
// Default Rate Limit Constants
// ============================================================================

/// Maximum deadline relative to current time (1 year in seconds)
pub const MAX_DEADLINE_SECONDS: i64 = 365 * 24 * 3600;

/// Default cooldown between task creations in seconds
pub const DEFAULT_TASK_CREATION_COOLDOWN: i64 = 60;

/// Default maximum tasks per agent per 24-hour window
pub const DEFAULT_MAX_TASKS_PER_24H: u8 = 50;

/// Default cooldown between dispute initiations in seconds (5 minutes)
pub const DEFAULT_DISPUTE_INITIATION_COOLDOWN: i64 = 300;

/// Default maximum disputes per agent per 24-hour window
pub const DEFAULT_MAX_DISPUTES_PER_24H: u8 = 10;
