//! Update an existing agent's registration

use crate::errors::CoordinationError;
use crate::events::AgentUpdated;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig};
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
            3 => {
                let protocol_config_info = ctx
                    .remaining_accounts
                    .first()
                    .ok_or(CoordinationError::ProtocolConfigRequired)?;
                let (expected_pda, _) =
                    Pubkey::find_program_address(&[b"protocol"], ctx.program_id);
                require!(
                    protocol_config_info.key() == expected_pda,
                    CoordinationError::InvalidInput
                );
                // Validate account ownership before deserializing (defense in depth)
                require!(
                    protocol_config_info.owner == ctx.program_id,
                    CoordinationError::InvalidAccountOwner
                );
                let protocol_data = protocol_config_info.try_borrow_data()?;
                // try_deserialize expects full data including discriminator
                let config = ProtocolConfig::try_deserialize(&mut &**protocol_data)?;
                require!(
                    ctx.accounts.authority.key() == config.authority,
                    CoordinationError::UnauthorizedAgent
                );
                AgentStatus::Suspended
            }
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
