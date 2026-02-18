//! Update an existing agent's registration
//!
//! Note: Suspending an agent does not automatically cancel their active tasks.
//! Tasks may become frozen if workers cannot complete them.
//! Consider canceling or reassigning tasks before suspension.

use crate::errors::CoordinationError;
use crate::events::AgentUpdated;
use crate::instructions::validation::validate_endpoint;
use crate::state::{AgentRegistration, AgentStatus};
use crate::utils::validation::validate_string_input;
use anchor_lang::prelude::*;

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

/// Cooldown period between agent updates (1 minute)
const UPDATE_COOLDOWN: i64 = 60;

pub fn handler(
    ctx: Context<UpdateAgent>,
    capabilities: Option<u64>,
    endpoint: Option<String>,
    metadata_uri: Option<String>,
    status: Option<u8>,
) -> Result<()> {
    let agent = &mut ctx.accounts.agent;
    let clock = Clock::get()?;

    // Rate limit: enforce cooldown between updates
    require!(
        clock.unix_timestamp >= agent.last_state_update + UPDATE_COOLDOWN,
        CoordinationError::UpdateTooFrequent
    );

    if let Some(caps) = capabilities {
        agent.capabilities = caps;
    }

    if let Some(ep) = endpoint {
        require!(!ep.is_empty(), CoordinationError::InvalidInput);
        require!(validate_string_input(&ep), CoordinationError::InvalidInput);
        validate_endpoint(&ep)?;
        agent.endpoint = ep;
    }

    if let Some(uri) = metadata_uri {
        require!(uri.len() <= 128, CoordinationError::StringTooLong);
        require!(validate_string_input(&uri), CoordinationError::InvalidInput);
        agent.metadata_uri = uri;
    }

    if let Some(s) = status {
        // Prevent suspended agents from changing their own status (only protocol authority can unsuspend)
        if s != 3 && agent.status == AgentStatus::Suspended {
            return Err(CoordinationError::AgentSuspended.into());
        }

        // Prevent setting status to Active while agent has active tasks
        // Agents with pending work should remain Busy, not advertise as available
        if s == 1 && agent.active_tasks > 0 {
            return Err(CoordinationError::AgentBusyWithTasks.into());
        }

        agent.status = match s {
            0 => AgentStatus::Inactive,
            1 => AgentStatus::Active,
            2 => AgentStatus::Busy,
            // Suspension is now handled by dedicated suspend_agent instruction (fix #819)
            3 => return Err(CoordinationError::InvalidInput.into()),
            _ => return Err(CoordinationError::InvalidInput.into()),
        };
    }

    agent.last_active = clock.unix_timestamp;
    agent.last_state_update = clock.unix_timestamp;

    emit!(AgentUpdated {
        agent_id: agent.agent_id,
        capabilities: agent.capabilities,
        status: agent.status as u8,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
