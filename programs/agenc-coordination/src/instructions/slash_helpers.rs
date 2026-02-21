//! Shared helper functions for dispute slashing.
//!
//! Extracts common logic between `apply_dispute_slash` and `apply_initiator_slash`
//! to reduce duplication while keeping each handler self-contained for its
//! specific preconditions.

use crate::errors::CoordinationError;
use crate::events::{reputation_reason, ReputationChanged};
use crate::instructions::constants::{PERCENT_BASE, REPUTATION_SLASH_LOSS};
use crate::state::AgentRegistration;
use anchor_lang::prelude::*;

/// Window for applying slashing after dispute resolution (7 days).
/// After this period, slashing can no longer be applied (fix #414).
pub const SLASH_WINDOW: i64 = 7 * 24 * 60 * 60;

/// Validates that the slash window has not expired since dispute resolution.
pub fn validate_slash_window(resolved_at: i64, clock: &Clock) -> Result<()> {
    require!(
        clock.unix_timestamp <= resolved_at.saturating_add(SLASH_WINDOW),
        CoordinationError::SlashWindowExpired
    );
    Ok(())
}

/// Calculates the approval percentage from dispute votes.
///
/// Returns `(total_votes, approval_pct)`.
/// Errors if total_votes is 0 or on arithmetic overflow.
pub fn calculate_approval_percentage(votes_for: u64, votes_against: u64) -> Result<(u64, u64)> {
    let total_votes = votes_for
        .checked_add(votes_against)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(total_votes > 0, CoordinationError::InsufficientVotes);

    let approval_pct = votes_for
        .checked_mul(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(total_votes)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    Ok((total_votes, approval_pct))
}

/// Calculates slash amount from stake snapshot and current stake.
///
/// Uses snapshot stake to prevent post-dispute withdrawal attacks, then caps by
/// current stake to avoid underflow if stake dropped before slash execution.
pub fn calculate_slash_amount(
    stake_at_dispute: u64,
    current_stake: u64,
    slash_percentage: u8,
) -> Result<u64> {
    require!(
        slash_percentage <= 100,
        CoordinationError::InvalidInput
    );

    let slash_amount = stake_at_dispute
        .checked_mul(slash_percentage as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    Ok(slash_amount.min(current_stake))
}

/// Applies a reputation penalty to an agent for losing a dispute.
/// Emits a `ReputationChanged` event if the reputation actually changed.
pub fn apply_reputation_penalty(agent: &mut AgentRegistration, clock: &Clock) -> Result<()> {
    let old_rep = agent.reputation;
    agent.reputation = agent.reputation.saturating_sub(REPUTATION_SLASH_LOSS);
    if agent.reputation != old_rep {
        emit!(ReputationChanged {
            agent_id: agent.agent_id,
            old_reputation: old_rep,
            new_reputation: agent.reputation,
            reason: reputation_reason::DISPUTE_SLASH,
            timestamp: clock.unix_timestamp,
        });
    }
    Ok(())
}

/// Transfers slashed lamports from an agent account to the treasury.
///
/// Only handles the raw lamport transfer. The caller is responsible for
/// updating `agent.stake` on the deserialized Account before calling this.
pub fn transfer_slash_to_treasury(
    agent_info: &AccountInfo,
    treasury_info: &AccountInfo,
    slash_amount: u64,
) -> Result<()> {
    if slash_amount > 0 {
        **agent_info.try_borrow_mut_lamports()? = agent_info
            .lamports()
            .checked_sub(slash_amount)
            .ok_or(CoordinationError::InsufficientFunds)?;

        **treasury_info.try_borrow_mut_lamports()? = treasury_info
            .lamports()
            .checked_add(slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }
    Ok(())
}
