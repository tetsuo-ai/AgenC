//! Delegate reputation points to a trusted peer

use crate::errors::CoordinationError;
use crate::events::ReputationDelegated;
use crate::state::{AgentRegistration, AgentStatus, ReputationDelegation};
use anchor_lang::prelude::*;

use super::constants::{MAX_REPUTATION, MIN_DELEGATION_AMOUNT};

#[derive(Accounts)]
pub struct DelegateReputation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub delegator_agent: Account<'info, AgentRegistration>,

    pub delegatee_agent: Account<'info, AgentRegistration>,

    #[account(
        init,
        payer = authority,
        space = ReputationDelegation::SIZE,
        seeds = [b"reputation_delegation", delegator_agent.key().as_ref(), delegatee_agent.key().as_ref()],
        bump
    )]
    pub delegation: Account<'info, ReputationDelegation>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DelegateReputation>, amount: u16, expires_at: i64) -> Result<()> {
    let delegator = &ctx.accounts.delegator_agent;
    let delegatee = &ctx.accounts.delegatee_agent;

    // Both agents must be Active
    require!(
        delegator.status == AgentStatus::Active,
        CoordinationError::ReputationAgentNotActive
    );
    require!(
        delegatee.status == AgentStatus::Active,
        CoordinationError::ReputationAgentNotActive
    );

    // Cannot self-delegate
    require!(
        ctx.accounts.delegator_agent.key() != ctx.accounts.delegatee_agent.key(),
        CoordinationError::ReputationCannotDelegateSelf
    );

    // Validate amount
    require!(
        amount > 0 && amount <= MAX_REPUTATION && amount >= MIN_DELEGATION_AMOUNT,
        CoordinationError::ReputationDelegationAmountInvalid
    );

    let clock = Clock::get()?;

    // Validate expires_at: 0 = no expiry, otherwise must be in the future
    require!(
        expires_at == 0 || expires_at > clock.unix_timestamp,
        CoordinationError::ReputationDelegationExpired
    );

    let delegation = &mut ctx.accounts.delegation;
    delegation.delegator = ctx.accounts.delegator_agent.key();
    delegation.delegatee = ctx.accounts.delegatee_agent.key();
    delegation.amount = amount;
    delegation.expires_at = expires_at;
    delegation.created_at = clock.unix_timestamp;
    delegation.bump = ctx.bumps.delegation;

    emit!(ReputationDelegated {
        delegator: delegation.delegator,
        delegatee: delegation.delegatee,
        amount,
        expires_at,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
