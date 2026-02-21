//! Register a new agent on-chain

use crate::errors::CoordinationError;
use crate::events::AgentRegistered;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig};
use crate::utils::validation::validate_string_input;
use anchor_lang::prelude::*;

use super::constants::WINDOW_24H;
use super::validation::validate_endpoint;

/// Initial reputation score for new agents (50% = 5000/10000)
const INITIAL_REPUTATION: u16 = 5000;

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
/// Note: The agent PDA account holds both rent-exempt balance and staked funds.
/// On deregister, stake is returned but rent remains with the account.
/// The `stake` field in AgentRegistration tracks only the staked portion.
pub fn handler(
    ctx: Context<RegisterAgent>,
    agent_id: [u8; 32],
    capabilities: u64,
    endpoint: String,
    metadata_uri: Option<String>,
    stake_amount: u64,
) -> Result<()> {
    require!(agent_id != [0u8; 32], CoordinationError::InvalidAgentId);

    require!(capabilities != 0, CoordinationError::InvalidCapabilities);
    require!(!endpoint.is_empty(), CoordinationError::InvalidInput);
    require!(
        validate_string_input(&endpoint),
        CoordinationError::InvalidInput
    );
    validate_endpoint(&endpoint)?;

    let metadata = metadata_uri.unwrap_or_default();
    require!(metadata.len() <= 128, CoordinationError::StringTooLong);
    require!(
        validate_string_input(&metadata),
        CoordinationError::InvalidInput
    );

    let config = &ctx.accounts.protocol_config;
    require!(
        stake_amount >= config.min_agent_stake,
        CoordinationError::InsufficientStake
    );

    let clock = Clock::get()?;
    let agent = &mut ctx.accounts.agent;

    // 1. First initialize agent account fields
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
    agent.reputation = INITIAL_REPUTATION;
    agent.active_tasks = 0;
    agent.stake = stake_amount;
    agent.bump = ctx.bumps.agent;

    // Transfer stake SOL from authority to agent PDA (fix #823)
    // Previously stake was recorded but never actually deposited
    if stake_amount > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: agent.to_account_info(),
                },
            ),
            stake_amount,
        )?;
    }
    // Initialize rate limiting fields
    agent.last_task_created = 0;
    agent.last_dispute_initiated = 0;
    agent.task_count_24h = 0;
    agent.dispute_count_24h = 0;
    // Round window start to prevent drift
    let window_start = (clock.unix_timestamp / WINDOW_24H) * WINDOW_24H;
    agent.rate_limit_window_start = window_start;
    agent.active_dispute_votes = 0;
    agent.last_vote_timestamp = 0;
    agent.last_state_update = 0;
    agent.disputes_as_defendant = 0;
    agent._reserved = [0u8; 5];

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
        stake_amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
