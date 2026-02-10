//! Create a new task with reward escrow

use crate::errors::CoordinationError;
use crate::events::TaskCreated;
use crate::state::{AgentRegistration, ProtocolConfig, Task, TaskEscrow};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

use super::rate_limit_helpers::check_task_creation_rate_limits;
use super::task_init_helpers::{init_escrow_fields, init_task_fields, increment_total_tasks, validate_deadline, validate_task_params};

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateTask<'info> {
    #[account(
        init,
        payer = creator,
        space = Task::SIZE,
        seeds = [b"task", creator.key().as_ref(), task_id.as_ref()],
        bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        init,
        payer = creator,
        space = TaskEscrow::SIZE,
        seeds = [b"escrow", task.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Creator's agent registration for rate limiting (required)
    #[account(
        mut,
        seeds = [b"agent", creator_agent.agent_id.as_ref()],
        bump = creator_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub creator_agent: Account<'info, AgentRegistration>,

    /// The authority that owns the creator_agent
    pub authority: Signer<'info>,

    /// The creator who pays for and owns the task
    /// Must match authority to prevent social engineering attacks (#375)
    #[account(
        mut,
        constraint = creator.key() == authority.key() @ CoordinationError::CreatorAuthorityMismatch
    )]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Creates a new task.
///
/// # Parameters
/// - `task_type`: Task execution type (0=Exclusive, 1=Collaborative, 2=Competitive)
///   Validated to be in range 0-2.
#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateTask>,
    task_id: [u8; 32],
    required_capabilities: u64,
    description: [u8; 64],
    reward_amount: u64,
    max_workers: u8,
    deadline: i64,
    task_type: u8,
    constraint_hash: Option<[u8; 32]>,
    min_reputation: u16,
) -> Result<()> {
    validate_task_params(&task_id, &description, required_capabilities, max_workers, task_type, min_reputation)?;
    // Validate reward is not zero (#540) - not in shared validator since dependent tasks allow zero
    require!(reward_amount > 0, CoordinationError::InvalidReward);

    let clock = Clock::get()?;
    let config = &ctx.accounts.protocol_config;

    check_version_compatible(config)?;

    // Validate deadline - must be set and in the future (#575)
    validate_deadline(deadline, &clock, true)?;

    let creator_agent = &mut ctx.accounts.creator_agent;

    // Check rate limits and update agent state
    check_task_creation_rate_limits(creator_agent, config, &clock)?;

    // Transfer reward to escrow
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        reward_amount,
    )?;

    // Initialize task
    let task = &mut ctx.accounts.task;
    init_task_fields(
        task,
        task_id,
        ctx.accounts.creator.key(),
        required_capabilities,
        description,
        constraint_hash,
        reward_amount,
        max_workers,
        task_type,
        deadline,
        ctx.accounts.escrow.key(),
        ctx.bumps.task,
        config.protocol_fee_bps,
        clock.unix_timestamp,
        min_reputation,
    )?;

    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    init_escrow_fields(escrow, task.key(), reward_amount, ctx.bumps.escrow);

    // Update protocol stats
    let protocol_config = &mut ctx.accounts.protocol_config;
    increment_total_tasks(protocol_config)?;

    emit!(TaskCreated {
        task_id,
        creator: task.creator,
        required_capabilities,
        reward_amount,
        task_type,
        deadline,
        min_reputation,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
