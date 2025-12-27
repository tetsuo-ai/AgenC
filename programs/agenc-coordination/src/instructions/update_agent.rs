//! Update an existing agent's registration

use anchor_lang::prelude::*;
use crate::state::{AgentRegistration, AgentStatus};
use crate::errors::CoordinationError;
use crate::events::AgentUpdated;

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub agent: Account<'info, AgentRegistration>,

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateAgent>,
    capabilities: Option<u64>,
    endpoint: Option<String>,
    metadata_uri: Option<String>,
    status: Option<u8>,
) -> Result<()> {
    let agent = &mut ctx.accounts.agent;
    let clock = Clock::get()?;

    if let Some(caps) = capabilities {
        agent.capabilities = caps;
    }

    if let Some(ep) = endpoint {
        require!(ep.len() <= 128, CoordinationError::StringTooLong);
        agent.endpoint = ep;
    }

    if let Some(uri) = metadata_uri {
        require!(uri.len() <= 128, CoordinationError::StringTooLong);
        agent.metadata_uri = uri;
    }

    if let Some(s) = status {
        agent.status = match s {
            0 => AgentStatus::Inactive,
            1 => AgentStatus::Active,
            2 => AgentStatus::Busy,
            3 => AgentStatus::Suspended,
            _ => return Err(CoordinationError::InvalidInput.into()),
        };
    }

    agent.last_active = clock.unix_timestamp;

    emit!(AgentUpdated {
        agent_id: agent.agent_id,
        capabilities: agent.capabilities,
        status: agent.status as u8,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
