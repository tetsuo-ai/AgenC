//! Expire a stale claim to free task slot

use crate::errors::CoordinationError;
use crate::state::{AgentRegistration, Task, TaskClaim, TaskStatus};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ExpireClaim<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub claim: Account<'info, TaskClaim>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump
    )]
    pub worker: Account<'info, AgentRegistration>,

    /// CHECK: Receives rent from closed claim account
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExpireClaim>) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let worker = &mut ctx.accounts.worker;
    let claim = &ctx.accounts.claim;
    let clock = Clock::get()?;

    // Can only expire incomplete claims
    require!(!claim.is_completed, CoordinationError::ClaimAlreadyCompleted);

    // Check claim has expired
    require!(
        claim.expires_at > 0 && clock.unix_timestamp > claim.expires_at,
        CoordinationError::ClaimNotExpired
    );

    // Decrement task worker count
    task.current_workers = task.current_workers.saturating_sub(1);

    // Reopen task if no workers left
    if task.current_workers == 0 {
        task.status = TaskStatus::Open;
    }

    // Decrement worker active tasks
    worker.active_tasks = worker.active_tasks.saturating_sub(1);

    Ok(())
}
