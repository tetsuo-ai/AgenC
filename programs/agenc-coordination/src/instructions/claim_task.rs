//! Claim a task to signal intent to work on it

use anchor_lang::prelude::*;
use crate::state::{Task, TaskStatus, TaskClaim, AgentRegistration, AgentStatus};
use crate::errors::CoordinationError;
use crate::events::TaskClaimed;

#[derive(Accounts)]
pub struct ClaimTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        init,
        payer = authority,
        space = TaskClaim::SIZE,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump
    )]
    pub claim: Account<'info, TaskClaim>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Account<'info, AgentRegistration>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimTask>) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let worker = &mut ctx.accounts.worker;
    let claim = &mut ctx.accounts.claim;
    let clock = Clock::get()?;

    // Validate task state
    require!(
        task.status == TaskStatus::Open || task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotOpen
    );

    // Check deadline
    if task.deadline > 0 {
        require!(
            clock.unix_timestamp < task.deadline,
            CoordinationError::TaskExpired
        );
    }

    // Check worker count
    require!(
        task.current_workers < task.max_workers,
        CoordinationError::TaskFullyClaimed
    );

    // Check worker is active
    require!(
        worker.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    // Check worker has required capabilities
    require!(
        (worker.capabilities & task.required_capabilities) == task.required_capabilities,
        CoordinationError::InsufficientCapabilities
    );

    // Check worker doesn't have too many active tasks
    require!(
        worker.active_tasks < 10,
        CoordinationError::MaxActiveTasksReached
    );

    // Initialize claim
    claim.task = task.key();
    claim.worker = worker.key();
    claim.claimed_at = clock.unix_timestamp;
    claim.completed_at = 0;
    claim.proof_hash = [0u8; 32];
    claim.result_data = [0u8; 64];
    claim.is_completed = false;
    claim.is_validated = false;
    claim.reward_paid = 0;
    claim.bump = ctx.bumps.claim;

    // Update task
    task.current_workers = task.current_workers.checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    task.status = TaskStatus::InProgress;

    // Update worker
    worker.active_tasks = worker.active_tasks.checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.last_active = clock.unix_timestamp;

    emit!(TaskClaimed {
        task_id: task.task_id,
        worker: worker.key(),
        current_workers: task.current_workers,
        max_workers: task.max_workers,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
