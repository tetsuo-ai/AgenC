//! Revoke a reputation delegation and close the account

use crate::errors::CoordinationError;
use crate::events::ReputationDelegationRevoked;
use crate::state::{AgentRegistration, ReputationDelegation};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RevokeDelegation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub delegator_agent: Account<'info, AgentRegistration>,

    #[account(
        mut,
        close = authority,
        seeds = [b"reputation_delegation", delegator_agent.key().as_ref(), delegation.delegatee.as_ref()],
        bump = delegation.bump,
    )]
    pub delegation: Account<'info, ReputationDelegation>,
}

pub fn handler(ctx: Context<RevokeDelegation>) -> Result<()> {
    let clock = Clock::get()?;

    // Capture delegation fields before mutable borrow of delegator_agent
    let delegation_amount = ctx.accounts.delegation.amount;
    let delegation_delegator = ctx.accounts.delegation.delegator;
    let delegation_delegatee = ctx.accounts.delegation.delegatee;

    // Restore delegated reputation back to the delegator.
    // Use saturating_add capped at MAX_REPUTATION to prevent overflow.
    let delegator = &mut ctx.accounts.delegator_agent;
    delegator.reputation = delegator
        .reputation
        .saturating_add(delegation_amount)
        .min(crate::instructions::constants::MAX_REPUTATION);

    emit!(ReputationDelegationRevoked {
        delegator: delegation_delegator,
        delegatee: delegation_delegatee,
        amount: delegation_amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
