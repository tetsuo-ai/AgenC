//! Update rate limit configuration (multisig gated)

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::state::ProtocolConfig;
use crate::utils::multisig::require_multisig;

/// Maximum rate limit value
const MAX_RATE_LIMIT: u64 = 1000;

/// Maximum cooldown value (1 week in seconds)
const MAX_COOLDOWN: i64 = 86400 * 7;

#[derive(Accounts)]
pub struct UpdateRateLimits<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

/// Update rate limiting parameters
/// All parameters are optional - pass current value to leave unchanged
pub fn handler(
    ctx: Context<UpdateRateLimits>,
    task_creation_cooldown: i64,
    max_tasks_per_24h: u8,
    dispute_initiation_cooldown: i64,
    max_disputes_per_24h: u8,
    min_stake_for_dispute: u64,
) -> Result<()> {
    require_multisig(&ctx.accounts.protocol_config, ctx.remaining_accounts)?;

    // Validate cooldown values are non-negative
    require!(
        task_creation_cooldown >= 0,
        CoordinationError::InvalidCooldown
    );
    require!(
        dispute_initiation_cooldown >= 0,
        CoordinationError::InvalidCooldown
    );

    // Validate cooldown values have upper bounds (max 1 week)
    require!(
        task_creation_cooldown <= MAX_COOLDOWN,
        CoordinationError::CooldownTooLong
    );
    require!(
        dispute_initiation_cooldown <= MAX_COOLDOWN,
        CoordinationError::CooldownTooLong
    );

    // Validate rate limit values have upper bounds
    require!(
        (max_tasks_per_24h as u64) <= MAX_RATE_LIMIT,
        CoordinationError::RateLimitTooHigh
    );
    require!(
        (max_disputes_per_24h as u64) <= MAX_RATE_LIMIT,
        CoordinationError::RateLimitTooHigh
    );

    let config = &mut ctx.accounts.protocol_config;
    config.task_creation_cooldown = task_creation_cooldown;
    config.max_tasks_per_24h = max_tasks_per_24h;
    config.dispute_initiation_cooldown = dispute_initiation_cooldown;
    config.max_disputes_per_24h = max_disputes_per_24h;
    config.min_stake_for_dispute = min_stake_for_dispute;

    Ok(())
}
