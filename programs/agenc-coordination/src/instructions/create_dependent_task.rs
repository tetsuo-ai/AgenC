//! Create a new task that depends on an existing parent task

use crate::errors::CoordinationError;
use crate::events::DependentTaskCreated;
use crate::state::{
    AgentRegistration, DependencyType, ProtocolConfig, Task, TaskEscrow, TaskStatus,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

use super::rate_limit_helpers::check_task_creation_rate_limits;
use super::task_init_helpers::{init_escrow_fields, init_task_fields, increment_total_tasks, validate_deadline, validate_task_params};

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateDependentTask<'info> {
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

    /// The parent task this new task depends on
    #[account(
        constraint = parent_task.status != TaskStatus::Cancelled @ CoordinationError::ParentTaskCancelled,
        constraint = parent_task.status != TaskStatus::Disputed @ CoordinationError::ParentTaskDisputed,
    )]
    pub parent_task: Account<'info, Task>,

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

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateDependentTask>,
    task_id: [u8; 32],
    required_capabilities: u64,
    description: [u8; 64],
    reward_amount: u64,
    max_workers: u8,
    deadline: i64,
    task_type: u8,
    constraint_hash: Option<[u8; 32]>,
    dependency_type: u8,
    min_reputation: u16,
) -> Result<()> {
    validate_task_params(&task_id, &description, required_capabilities, max_workers, task_type, min_reputation)?;
    // Validate parent task belongs to same creator (#520)
    require!(
        ctx.accounts.parent_task.creator == ctx.accounts.creator.key(),
        CoordinationError::UnauthorizedCreator
    );
    require!(
        (1..=3).contains(&dependency_type),
        CoordinationError::InvalidDependencyType
    );

    let clock = Clock::get()?;
    let config = &ctx.accounts.protocol_config;

    check_version_compatible(config)?;

    // Validate deadline if set (optional for dependent tasks)
    validate_deadline(deadline, &clock, false)?;

    let creator_agent = &mut ctx.accounts.creator_agent;

    // Check rate limits and update agent state
    check_task_creation_rate_limits(creator_agent, config, &clock)?;

    // Reject zero-reward dependent tasks (issue #837)
    // Zero-reward tasks cannot be completed due to RewardTooSmall check in completion_helpers
    require!(
        reward_amount > 0,
        CoordinationError::RewardTooSmall
    );

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

    // Initialize task (BUG FIX: protocol_fee_bps was not set before this refactor)
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

    // Override dependency fields (defaults are None from init_task_fields)
    task.depends_on = Some(ctx.accounts.parent_task.key());
    task.dependency_type = match dependency_type {
        1 => DependencyType::Data,
        2 => DependencyType::Ordering,
        3 => DependencyType::Proof,
        _ => return Err(CoordinationError::InvalidDependencyType.into()),
    };

    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    init_escrow_fields(escrow, task.key(), reward_amount, ctx.bumps.escrow);

    // Update protocol stats
    let protocol_config = &mut ctx.accounts.protocol_config;
    increment_total_tasks(protocol_config)?;

    emit!(DependentTaskCreated {
        task_id,
        creator: task.creator,
        depends_on: ctx.accounts.parent_task.key(),
        dependency_type,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
