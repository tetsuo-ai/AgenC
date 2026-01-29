//! Cancel a task and refund the creator

use crate::errors::CoordinationError;
use crate::events::TaskCancelled;
use crate::state::{AgentRegistration, Task, TaskClaim, TaskEscrow, TaskStatus};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        has_one = creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        close = creator,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelTask>) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let escrow = &mut ctx.accounts.escrow;
    let clock = Clock::get()?;

    // Can only cancel if:
    // 1. Task is open (no workers yet)
    // 2. Task has expired and no completions
    let can_cancel = match task.status {
        TaskStatus::Open => true,
        TaskStatus::InProgress => {
            // Can cancel if deadline passed and no completions
            task.deadline > 0 && clock.unix_timestamp > task.deadline && task.completions == 0
        }
        _ => false,
    };

    require!(can_cancel, CoordinationError::TaskCannotBeCancelled);

    // Calculate refund (total minus any distributed)
    let refund_amount = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Transfer refund to creator
    if refund_amount > 0 {
        **escrow.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
        let creator_info = ctx.accounts.creator.to_account_info();
        **creator_info.try_borrow_mut_lamports()? = creator_info
            .lamports()
            .checked_add(refund_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    // Update task status
    task.status = TaskStatus::Cancelled;
    escrow.is_closed = true;

    emit!(TaskCancelled {
        task_id: task.task_id,
        creator: task.creator,
        refund_amount,
        timestamp: clock.unix_timestamp,
    });

    // After task cancellation, decrement active_tasks for all claimants
    // remaining_accounts should contain pairs of (claim, worker_agent)
    let num_pairs = ctx.remaining_accounts.len() / 2;
    for i in 0..num_pairs {
        let claim_info = &ctx.remaining_accounts[i * 2];
        let worker_info = &ctx.remaining_accounts[i * 2 + 1];

        // Validate claim belongs to this task
        require!(
            claim_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        let claim_data = claim_info.try_borrow_data()?;
        let claim = TaskClaim::try_deserialize(&mut &claim_data[..])?;
        require!(claim.task == task.key(), CoordinationError::InvalidInput);
        drop(claim_data);

        // Decrement worker's active_tasks
        require!(
            worker_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        require!(worker_info.is_writable, CoordinationError::InvalidInput);
        require!(
            worker_info.key() == claim.worker,
            CoordinationError::InvalidInput
        );
        let mut worker_data = worker_info.try_borrow_mut_data()?;
        let mut worker = AgentRegistration::try_deserialize(&mut &worker_data[..])?;
        worker.active_tasks = worker.active_tasks.saturating_sub(1);
        worker.try_serialize(&mut &mut worker_data[8..])?;
    }

    // Validate all workers were provided
    require!(
        num_pairs == task.current_workers as usize,
        CoordinationError::IncompleteWorkerAccounts
    );

    // Reset current_workers since all workers are removed on cancel
    task.current_workers = 0;

    Ok(())
}
