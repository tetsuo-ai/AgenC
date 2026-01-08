//! Register a new agent on-chain

use crate::errors::CoordinationError;
use crate::events::AgentRegistered;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(agent_id: [u8; 32])]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = AgentRegistration::SIZE,
        seeds = [b"agent", agent_id.as_ref()],
        bump
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterAgent>,
    agent_id: [u8; 32],
    capabilities: u64,
    endpoint: String,
    metadata_uri: Option<String>,
) -> Result<()> {
    require!(endpoint.len() <= 128, CoordinationError::StringTooLong);

    let metadata = metadata_uri.unwrap_or_default();
    require!(metadata.len() <= 128, CoordinationError::StringTooLong);

    let clock = Clock::get()?;
    let agent = &mut ctx.accounts.agent;

    agent.agent_id = agent_id;
    agent.authority = ctx.accounts.authority.key();
    agent.capabilities = capabilities;
    agent.status = AgentStatus::Active;
    agent.endpoint = endpoint.clone();
    agent.metadata_uri = metadata;
    agent.registered_at = clock.unix_timestamp;
    agent.last_active = clock.unix_timestamp;
    agent.tasks_completed = 0;
    agent.total_earned = 0;
    agent.reputation = 5000; // Start at 50%
    agent.active_tasks = 0;
    agent.stake = 0;
    agent.bump = ctx.bumps.agent;

    // Update protocol stats
    let config = &mut ctx.accounts.protocol_config;
    config.total_agents = config
        .total_agents
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(AgentRegistered {
        agent_id,
        authority: agent.authority,
        capabilities,
        endpoint,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
