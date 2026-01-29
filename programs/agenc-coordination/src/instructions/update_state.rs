//! Update shared coordination state

/// Minimum seconds between state updates per agent
const STATE_UPDATE_COOLDOWN: i64 = 60; // seconds

use crate::errors::CoordinationError;
use crate::events::StateUpdated;
use crate::state::{AgentRegistration, AgentStatus, CoordinationState};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(state_key: [u8; 32])]
pub struct UpdateState<'info> {
    #[account(
        init_if_needed,
        payer = authority,
        space = CoordinationState::SIZE,
        seeds = [b"state", authority.key().as_ref(), state_key.as_ref()],
        bump
    )]
    pub state: Account<'info, CoordinationState>,

    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<UpdateState>,
    state_key: [u8; 32],
    state_value: [u8; 64],
    expected_version: u64,
) -> Result<()> {
    let state = &mut ctx.accounts.state;
    let agent = &mut ctx.accounts.agent;
    let clock = Clock::get()?;

    // Verify agent is active
    require!(
        agent.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    if agent.last_state_update > 0 {
        // Using saturating_sub intentionally - handles clock drift safely
        let elapsed = clock.unix_timestamp.saturating_sub(agent.last_state_update);
        if elapsed < STATE_UPDATE_COOLDOWN {
            return Err(CoordinationError::RateLimitExceeded.into());
        }
    }

    // Validate state_value is not all zeros
    require!(
        state_value.iter().any(|&b| b != 0),
        CoordinationError::InvalidStateValue
    );

    // Always check version (fix #431 - first update was bypassing)
    require!(
        state.version == expected_version,
        CoordinationError::VersionMismatch
    );

    // Ownership model (fix #395): Only the creator agent can update state
    // For new state (version 0), the creating agent becomes the owner
    // For existing state, verify the updating agent is the owner
    let is_new_state = state.version == 0 && state.last_updater == Pubkey::default();
    if !is_new_state {
        require!(
            state.last_updater == agent.key(),
            CoordinationError::StateOwnershipViolation
        );
    }

    // Update state
    state.owner = ctx.accounts.authority.key();
    state.state_key = state_key;
    state.state_value = state_value;
    state.last_updater = agent.key();
    state.version = state
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    state.updated_at = clock.unix_timestamp;
    state.bump = ctx.bumps.state;

    // Update agent activity
    agent.last_active = clock.unix_timestamp;
    agent.last_state_update = clock.unix_timestamp;

    emit!(StateUpdated {
        state_key,
        state_value,
        updater: agent.key(),
        version: state.version,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
