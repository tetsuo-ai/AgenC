//! Shared helper functions for rate limiting logic.
//!
//! Used by task creation and dispute initiation instructions.

use crate::errors::CoordinationError;
use crate::events::RateLimitHit;
use crate::instructions::constants::WINDOW_24H;
use crate::state::{AgentRegistration, ProtocolConfig};
use anchor_lang::prelude::*;

/// Action types for rate limiting (matches RateLimitHit event field)
pub const ACTION_TYPE_TASK_CREATION: u8 = 0;
pub const ACTION_TYPE_DISPUTE_INITIATION: u8 = 1;

/// Limit types for rate limiting (matches RateLimitHit event field)
pub const LIMIT_TYPE_COOLDOWN: u8 = 0;
pub const LIMIT_TYPE_24H_WINDOW: u8 = 1;

/// Rate limit action type for parameterized checking
#[derive(Clone, Copy)]
pub enum RateLimitAction {
    TaskCreation,
    DisputeInitiation,
}

impl RateLimitAction {
    /// Get the action type constant for events
    pub fn action_type(&self) -> u8 {
        match self {
            RateLimitAction::TaskCreation => ACTION_TYPE_TASK_CREATION,
            RateLimitAction::DisputeInitiation => ACTION_TYPE_DISPUTE_INITIATION,
        }
    }

    /// Get cooldown from protocol config
    pub fn get_cooldown(&self, config: &ProtocolConfig) -> i64 {
        match self {
            RateLimitAction::TaskCreation => config.task_creation_cooldown,
            RateLimitAction::DisputeInitiation => config.dispute_initiation_cooldown,
        }
    }

    /// Get max actions per 24h from protocol config
    pub fn get_max_per_24h(&self, config: &ProtocolConfig) -> u8 {
        match self {
            RateLimitAction::TaskCreation => config.max_tasks_per_24h,
            RateLimitAction::DisputeInitiation => config.max_disputes_per_24h,
        }
    }

    /// Get last action timestamp from agent
    pub fn get_last_timestamp(&self, agent: &AgentRegistration) -> i64 {
        match self {
            RateLimitAction::TaskCreation => agent.last_task_created,
            RateLimitAction::DisputeInitiation => agent.last_dispute_initiated,
        }
    }

    /// Get current count from agent
    pub fn get_count(&self, agent: &AgentRegistration) -> u8 {
        match self {
            RateLimitAction::TaskCreation => agent.task_count_24h,
            RateLimitAction::DisputeInitiation => agent.dispute_count_24h,
        }
    }

    /// Update last action timestamp on agent
    pub fn set_last_timestamp(&self, agent: &mut AgentRegistration, timestamp: i64) {
        match self {
            RateLimitAction::TaskCreation => agent.last_task_created = timestamp,
            RateLimitAction::DisputeInitiation => agent.last_dispute_initiated = timestamp,
        }
    }

    /// Increment count on agent, returns error on overflow
    pub fn increment_count(&self, agent: &mut AgentRegistration) -> Result<()> {
        match self {
            RateLimitAction::TaskCreation => {
                agent.task_count_24h = agent
                    .task_count_24h
                    .checked_add(1)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
            }
            RateLimitAction::DisputeInitiation => {
                agent.dispute_count_24h = agent
                    .dispute_count_24h
                    .checked_add(1)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
            }
        }
        Ok(())
    }
}

/// Emit a rate limit hit event with the given parameters
fn emit_rate_limit_hit(
    agent_id: [u8; 32],
    action: RateLimitAction,
    limit_type: u8,
    current_count: u8,
    max_count: u8,
    cooldown_remaining: i64,
    timestamp: i64,
) {
    emit!(RateLimitHit {
        agent_id,
        action_type: action.action_type(),
        limit_type,
        current_count,
        max_count,
        cooldown_remaining,
        timestamp,
    });
}

/// Reset the 24h rate limit window if expired.
///
/// Both task and dispute counters reset together when the window expires.
/// This ensures clean state at window boundaries.
fn maybe_reset_window(agent: &mut AgentRegistration, clock: &Clock) {
    // Using saturating_sub intentionally - handles clock drift safely
    if clock
        .unix_timestamp
        .saturating_sub(agent.rate_limit_window_start)
        >= WINDOW_24H
    {
        // Round window start to prevent drift
        let window_start = (clock.unix_timestamp / WINDOW_24H) * WINDOW_24H;
        agent.rate_limit_window_start = window_start;
        // Note: Both counters reset together when window expires.
        // This is intentional - ensures clean state at window boundary.
        agent.task_count_24h = 0;
        agent.dispute_count_24h = 0;
    }
}

/// Generic rate limit checker for both task creation and dispute initiation.
///
/// This function enforces two rate limiting mechanisms:
/// 1. **Cooldown period**: Minimum time between actions
/// 2. **24-hour window limit**: Maximum actions per rolling 24-hour window
///
/// If rate limits pass, the function updates the agent's counters and timestamps.
///
/// # Arguments
/// * `agent` - Mutable reference to the agent's registration
/// * `config` - Protocol configuration containing rate limit settings
/// * `clock` - Current clock for timestamp comparisons
/// * `action` - The type of action being rate limited
///
/// # Errors
/// * `CooldownNotElapsed` - Action cooldown has not passed
/// * `RateLimitExceeded` - 24-hour action limit exceeded
/// * `ArithmeticOverflow` - Counter overflow (shouldn't happen in practice)
pub fn check_rate_limits(
    agent: &mut AgentRegistration,
    config: &ProtocolConfig,
    clock: &Clock,
    action: RateLimitAction,
) -> Result<()> {
    let cooldown = action.get_cooldown(config);
    let max_per_24h = action.get_max_per_24h(config);
    let last_timestamp = action.get_last_timestamp(agent);

    // Check cooldown period
    if cooldown > 0 && last_timestamp > 0 {
        // Using saturating_sub intentionally - handles clock drift safely
        let elapsed = clock.unix_timestamp.saturating_sub(last_timestamp);
        if elapsed < cooldown {
            // Using saturating_sub intentionally - underflow returns 0 (safe time calculation)
            let remaining = cooldown.saturating_sub(elapsed);
            emit_rate_limit_hit(
                agent.agent_id,
                action,
                LIMIT_TYPE_COOLDOWN,
                action.get_count(agent),
                max_per_24h,
                remaining,
                clock.unix_timestamp,
            );
            return Err(CoordinationError::CooldownNotElapsed.into());
        }
    }

    // Check 24h window limit
    if max_per_24h > 0 {
        // Reset window if 24h has passed
        maybe_reset_window(agent, clock);

        // Check if limit exceeded
        let current_count = action.get_count(agent);
        if current_count >= max_per_24h {
            emit_rate_limit_hit(
                agent.agent_id,
                action,
                LIMIT_TYPE_24H_WINDOW,
                current_count,
                max_per_24h,
                0,
                clock.unix_timestamp,
            );
            return Err(CoordinationError::RateLimitExceeded.into());
        }

        // Increment counter
        action.increment_count(agent)?;
    }

    // Update timestamps
    action.set_last_timestamp(agent, clock.unix_timestamp);
    agent.last_active = clock.unix_timestamp;

    Ok(())
}

/// Check rate limits for task creation and update agent state.
///
/// Wrapper around `check_rate_limits` for backwards compatibility.
///
/// # Arguments
/// * `creator_agent` - Mutable reference to the agent's registration
/// * `config` - Protocol configuration containing rate limit settings
/// * `clock` - Current clock for timestamp comparisons
///
/// # Errors
/// * `CooldownNotElapsed` - Task creation cooldown has not passed
/// * `RateLimitExceeded` - 24-hour task limit exceeded
/// * `ArithmeticOverflow` - Counter overflow (shouldn't happen in practice)
pub fn check_task_creation_rate_limits(
    creator_agent: &mut AgentRegistration,
    config: &ProtocolConfig,
    clock: &Clock,
) -> Result<()> {
    check_rate_limits(creator_agent, config, clock, RateLimitAction::TaskCreation)
}

/// Check rate limits for dispute initiation and update agent state.
///
/// Wrapper around `check_rate_limits` for backwards compatibility.
///
/// # Arguments
/// * `agent` - Mutable reference to the agent's registration
/// * `config` - Protocol configuration containing rate limit settings
/// * `clock` - Current clock for timestamp comparisons
///
/// # Errors
/// * `CooldownNotElapsed` - Dispute initiation cooldown has not passed
/// * `RateLimitExceeded` - 24-hour dispute limit exceeded
/// * `ArithmeticOverflow` - Counter overflow (shouldn't happen in practice)
pub fn check_dispute_initiation_rate_limits(
    agent: &mut AgentRegistration,
    config: &ProtocolConfig,
    clock: &Clock,
) -> Result<()> {
    check_rate_limits(agent, config, clock, RateLimitAction::DisputeInitiation)
}
