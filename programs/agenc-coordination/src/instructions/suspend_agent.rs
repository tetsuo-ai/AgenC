//! Suspend an agent (protocol authority only)
//!
//! Separates suspension from `update_agent` so that only the protocol authority
//! can suspend agents, not the agent's own authority (fix #819).

use crate::errors::CoordinationError;
use crate::events::AgentSuspended;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SuspendAgent<'info> {
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

pub fn handler(ctx: Context<SuspendAgent>) -> Result<()> {
    let agent = &mut ctx.accounts.agent;

    require!(
        agent.status != AgentStatus::Suspended,
        CoordinationError::AgentSuspended
    );

    agent.status = AgentStatus::Suspended;

    let clock = Clock::get()?;
    agent.last_state_update = clock.unix_timestamp;

    emit!(AgentSuspended {
        agent_id: agent.agent_id,
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
