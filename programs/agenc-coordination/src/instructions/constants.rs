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
