//! Deregister an agent and reclaim rent

use crate::errors::CoordinationError;
use crate::events::AgentDeregistered;
use crate::instructions::slash_helpers::SLASH_WINDOW;
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
    let clock = Clock::get()?;

    // Ensure agent has no active tasks
    require!(
        agent.active_tasks == 0,
        CoordinationError::AgentHasActiveTasks
    );

    // If defendant disputes are still tracked, only allow deregistration after the
    // slash window anchored to the agent's latest activity has elapsed.
    if agent.disputes_as_defendant > 0 {
        let time_since_last_activity = clock
            .unix_timestamp
            .checked_sub(agent.last_active)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            time_since_last_activity > SLASH_WINDOW,
            CoordinationError::ActiveDisputesExist
        );
    }

    require!(
        agent.active_dispute_votes == 0,
        CoordinationError::ActiveDisputeVotes
    );

    // Conservative initiator-slash gating: hold deregistration for a full dispute
    // lifecycle window plus slash window after the last dispute initiation.
    if agent.last_dispute_initiated > 0 {
        let dispute_lifecycle_window = ctx
            .accounts
            .protocol_config
            .max_dispute_duration
            .max(ctx.accounts.protocol_config.voting_period)
            .max(0);
        let initiator_guard_window = dispute_lifecycle_window
            .checked_add(SLASH_WINDOW)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let time_since_last_dispute = clock
            .unix_timestamp
            .checked_sub(agent.last_dispute_initiated)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            time_since_last_dispute > initiator_guard_window,
            CoordinationError::CooldownNotElapsed
        );
    }

    // Only check vote cooldown if agent has actually voted before
    // When last_vote_timestamp is 0 (never voted), skip the check
    if agent.last_vote_timestamp > 0 {
        /// Vote cooldown period (same as WINDOW_24H for consistency)
        /// Intentionally duplicated to allow independent adjustment
        const VOTE_COOLDOWN: i64 = 86400;
        let time_since_vote = clock
            .unix_timestamp
            .checked_sub(agent.last_vote_timestamp)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            time_since_vote > VOTE_COOLDOWN,
            CoordinationError::RecentVoteActivity
        );
    }

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
