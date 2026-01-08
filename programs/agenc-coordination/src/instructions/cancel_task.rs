//! Cancel a task and refund the creator

use crate::errors::CoordinationError;
use crate::events::TaskCancelled;
use crate::state::{Task, TaskEscrow, TaskStatus};
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
        **ctx
            .accounts
            .creator
            .to_account_info()
            .try_borrow_mut_lamports()? += refund_amount;
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

    Ok(())
}
