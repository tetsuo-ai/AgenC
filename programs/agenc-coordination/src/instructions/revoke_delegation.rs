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
    let delegation = &ctx.accounts.delegation;

    emit!(ReputationDelegationRevoked {
        delegator: delegation.delegator,
        delegatee: delegation.delegatee,
        amount: delegation.amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
