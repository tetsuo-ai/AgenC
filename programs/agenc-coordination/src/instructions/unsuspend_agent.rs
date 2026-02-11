//! Unsuspend an agent (protocol authority only)
//!
//! Restores a suspended agent to Inactive status. Only the protocol authority
//! can unsuspend agents (fix #819).

use crate::errors::CoordinationError;
use crate::events::AgentUnsuspended;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UnsuspendAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        has_one = authority @ CoordinationError::UnauthorizedUpgrade
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UnsuspendAgent>) -> Result<()> {
    let agent = &mut ctx.accounts.agent;

    require!(
        agent.status == AgentStatus::Suspended,
        CoordinationError::InvalidInput
    );

    agent.status = AgentStatus::Inactive;

    let clock = Clock::get()?;
    agent.last_state_update = clock.unix_timestamp;

    emit!(AgentUnsuspended {
        agent_id: agent.agent_id,
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
