//! Cancel a dispute before any votes are cast
//!
//! This allows dispute initiators to cancel their disputes early if:
//! - They realize they made a mistake
//! - The parties reach an off-chain settlement
//! - Circumstances change making the dispute moot
//!
//! Constraints:
//! - Only the initiator can cancel
//! - Only active disputes can be cancelled
//! - No votes must have been cast yet (total_voters == 0)

use crate::errors::CoordinationError;
use crate::events::DisputeCancelled;
use crate::state::{Dispute, DisputeStatus, Task, TaskStatus};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelDispute<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump,
        constraint = dispute.status == DisputeStatus::Active @ CoordinationError::DisputeNotActive
    )]
    pub dispute: Account<'info, Dispute>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.key() == dispute.task @ CoordinationError::InvalidInput
    )]
    pub task: Account<'info, Task>,

    /// Only the initiator's authority can cancel
    #[account(
        constraint = authority.key() == dispute.initiator_authority @ CoordinationError::UnauthorizedResolver
    )]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<CancelDispute>) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let clock = Clock::get()?;

    // Can only cancel if no votes have been cast
    require!(
        dispute.total_voters == 0,
        CoordinationError::VotingEnded
    );

    // Update dispute status
    dispute.status = DisputeStatus::Cancelled;
    dispute.resolved_at = clock.unix_timestamp;

    // Restore task status to InProgress (was Disputed)
    if task.status == TaskStatus::Disputed {
        task.status = TaskStatus::InProgress;
    }

    emit!(DisputeCancelled {
        dispute_id: dispute.dispute_id,
        task: dispute.task,
        initiator: dispute.initiator,
        cancelled_at: clock.unix_timestamp,
    });

    Ok(())
}
