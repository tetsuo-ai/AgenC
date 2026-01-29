//! Update rate limit configuration (multisig gated)

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::RateLimitsUpdated;
use crate::state::ProtocolConfig;
use crate::utils::multisig::require_multisig;

/// Maximum cooldown value (24 hours in seconds)
const MAX_COOLDOWN_SECONDS: i64 = 86400;

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
    require!(task_creation_cooldown >= 0, CoordinationError::InvalidCooldown);
    require!(dispute_initiation_cooldown >= 0, CoordinationError::InvalidCooldown);

    // Validate cooldown values have upper bounds (max 24 hours)
    require!(task_creation_cooldown <= MAX_COOLDOWN_SECONDS, CoordinationError::CooldownTooLarge);
    require!(dispute_initiation_cooldown <= MAX_COOLDOWN_SECONDS, CoordinationError::CooldownTooLarge);

    let config = &mut ctx.accounts.protocol_config;
    config.task_creation_cooldown = task_creation_cooldown;
    config.max_tasks_per_24h = max_tasks_per_24h;
    config.dispute_initiation_cooldown = dispute_initiation_cooldown;
    config.max_disputes_per_24h = max_disputes_per_24h;
    config.min_stake_for_dispute = min_stake_for_dispute;

    let clock = Clock::get()?;
    let updated_by = ctx
        .remaining_accounts
        .first()
        .map(|a| a.key())
        .unwrap_or_default();

    emit!(RateLimitsUpdated {
        task_creation_cooldown,
        max_tasks_per_24h,
        dispute_initiation_cooldown,
        max_disputes_per_24h,
        min_stake_for_dispute,
        updated_by,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
