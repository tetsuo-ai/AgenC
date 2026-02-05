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

/// Check rate limits for task creation and update agent state.
///
/// This function enforces two rate limiting mechanisms:
/// 1. **Cooldown period**: Minimum time between task creations
/// 2. **24-hour window limit**: Maximum tasks per rolling 24-hour window
///
/// If rate limits pass, the function updates the agent's counters:
/// - Increments `task_count_24h`
/// - Updates `last_task_created` timestamp
/// - Updates `last_active` timestamp
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
    // Check cooldown period
    if config.task_creation_cooldown > 0 && creator_agent.last_task_created > 0 {
        // Using saturating_sub intentionally - handles clock drift safely
        let elapsed = clock
            .unix_timestamp
            .saturating_sub(creator_agent.last_task_created);
        if elapsed < config.task_creation_cooldown {
            // Using saturating_sub intentionally - underflow returns 0 (safe time calculation)
            let remaining = config.task_creation_cooldown.saturating_sub(elapsed);
            emit!(RateLimitHit {
                agent_id: creator_agent.agent_id,
                action_type: 0, // task_creation
                limit_type: 0,  // cooldown
                current_count: creator_agent.task_count_24h,
                max_count: config.max_tasks_per_24h,
                cooldown_remaining: remaining,
                timestamp: clock.unix_timestamp,
            });
            return Err(CoordinationError::CooldownNotElapsed.into());
        }
    }

    // Check 24h window limit
    if config.max_tasks_per_24h > 0 {
        // Reset window if 24h has passed
        // Using saturating_sub intentionally - handles clock drift safely
        if clock
            .unix_timestamp
            .saturating_sub(creator_agent.rate_limit_window_start)
            >= WINDOW_24H
        {
            // Round window start to prevent drift
            let window_start = (clock.unix_timestamp / WINDOW_24H) * WINDOW_24H;
            creator_agent.rate_limit_window_start = window_start;
            // Note: Both counters reset together when window expires.
            // This is intentional - ensures clean state at window boundary.
            creator_agent.task_count_24h = 0;
            creator_agent.dispute_count_24h = 0;
        }

        // Check if limit exceeded
        if creator_agent.task_count_24h >= config.max_tasks_per_24h {
            emit!(RateLimitHit {
                agent_id: creator_agent.agent_id,
                action_type: 0, // task_creation
                limit_type: 1,  // 24h_window
                current_count: creator_agent.task_count_24h,
                max_count: config.max_tasks_per_24h,
                cooldown_remaining: 0,
                timestamp: clock.unix_timestamp,
            });
            return Err(CoordinationError::RateLimitExceeded.into());
        }

        // Increment counter
        creator_agent.task_count_24h = creator_agent
            .task_count_24h
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    // Update last task created timestamp
    creator_agent.last_task_created = clock.unix_timestamp;
    creator_agent.last_active = clock.unix_timestamp;

    Ok(())
}

/// Check rate limits for dispute initiation and update agent state.
///
/// This function enforces two rate limiting mechanisms:
/// 1. **Cooldown period**: Minimum time between dispute initiations
/// 2. **24-hour window limit**: Maximum disputes per rolling 24-hour window
///
/// If rate limits pass, the function updates the agent's counters:
/// - Increments `dispute_count_24h`
/// - Updates `last_dispute_initiated` timestamp
/// - Updates `last_active` timestamp
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
    // Check cooldown period
    if config.dispute_initiation_cooldown > 0 && agent.last_dispute_initiated > 0 {
        // Using saturating_sub intentionally - handles clock drift safely
        let elapsed = clock
            .unix_timestamp
            .saturating_sub(agent.last_dispute_initiated);
        if elapsed < config.dispute_initiation_cooldown {
            // Using saturating_sub intentionally - underflow returns 0 (safe time calculation)
            let remaining = config.dispute_initiation_cooldown.saturating_sub(elapsed);
            emit!(RateLimitHit {
                agent_id: agent.agent_id,
                action_type: ACTION_TYPE_DISPUTE_INITIATION,
                limit_type: LIMIT_TYPE_COOLDOWN,
                current_count: agent.dispute_count_24h,
                max_count: config.max_disputes_per_24h,
                cooldown_remaining: remaining,
                timestamp: clock.unix_timestamp,
            });
            return Err(CoordinationError::CooldownNotElapsed.into());
        }
    }

    // Check 24h window limit
    if config.max_disputes_per_24h > 0 {
        // Reset window if 24h has passed
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

        // Check if limit exceeded
        if agent.dispute_count_24h >= config.max_disputes_per_24h {
            emit!(RateLimitHit {
                agent_id: agent.agent_id,
                action_type: ACTION_TYPE_DISPUTE_INITIATION,
                limit_type: LIMIT_TYPE_24H_WINDOW,
                current_count: agent.dispute_count_24h,
                max_count: config.max_disputes_per_24h,
                cooldown_remaining: 0,
                timestamp: clock.unix_timestamp,
            });
            return Err(CoordinationError::RateLimitExceeded.into());
        }

        // Increment counter
        agent.dispute_count_24h = agent
            .dispute_count_24h
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    // Update last dispute initiated timestamp
    agent.last_dispute_initiated = clock.unix_timestamp;
    agent.last_active = clock.unix_timestamp;

    Ok(())
}
