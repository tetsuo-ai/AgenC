//! Deregister an agent and reclaim rent

use crate::errors::CoordinationError;
use crate::events::AgentDeregistered;
use crate::state::{AgentRegistration, ProtocolConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
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
}

pub fn handler(ctx: Context<DeregisterAgent>) -> Result<()> {
    let agent = &ctx.accounts.agent;

    // Ensure agent has no active tasks
    require!(
        agent.active_tasks == 0,
        CoordinationError::AgentHasActiveTasks
    );

    let clock = Clock::get()?;

    require!(
        agent.active_dispute_votes == 0,
        CoordinationError::ActiveDisputeVotes
    );

    const VOTE_COOLDOWN: i64 = 24 * 60 * 60;
    let time_since_vote = clock
        .unix_timestamp
        .checked_sub(agent.last_vote_timestamp)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        time_since_vote > VOTE_COOLDOWN,
        CoordinationError::RecentVoteActivity
    );

    // Update protocol stats
    let config = &mut ctx.accounts.protocol_config;
    config.total_agents = config
        .total_agents
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(AgentDeregistered {
        agent_id: agent.agent_id,
        authority: agent.authority,
        timestamp: clock.unix_timestamp,
    });

    // Account is closed automatically via `close = authority`
    Ok(())
}
