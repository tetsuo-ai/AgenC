//! Resolve a dispute and execute the outcome

use crate::errors::CoordinationError;
use crate::events::DisputeResolved;
use crate::state::{
    Dispute, DisputeStatus, ProtocolConfig, ResolutionType, Task, TaskEscrow, TaskStatus,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Account<'info, Dispute>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = dispute.task == task.key() @ CoordinationError::TaskNotFound
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Task creator for refund
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: Worker for payment (if applicable)
    #[account(mut)]
    pub worker: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ResolveDispute>) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let escrow = &mut ctx.accounts.escrow;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    // Verify dispute is active
    require!(
        dispute.status == DisputeStatus::Active,
        CoordinationError::DisputeNotActive
    );

    // Verify voting period has ended
    require!(
        clock.unix_timestamp >= dispute.voting_deadline,
        CoordinationError::VotingNotEnded
    );

    // Calculate total votes and check threshold
    let total_votes = dispute.votes_for.saturating_add(dispute.votes_against);
    require!(total_votes > 0, CoordinationError::InsufficientVotes);

    // Calculate approval percentage
    let approval_pct = (dispute.votes_for as u64)
        .checked_mul(100)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(total_votes as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)? as u8;

    // Determine outcome based on threshold
    let approved = approval_pct >= config.dispute_threshold;

    // Calculate remaining escrow funds
    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Execute resolution based on type and approval
    if approved {
        match dispute.resolution_type {
            ResolutionType::Refund => {
                // Full refund to creator
                if remaining_funds > 0 {
                    **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
                    **ctx
                        .accounts
                        .creator
                        .to_account_info()
                        .try_borrow_mut_lamports()? += remaining_funds;
                }
                task.status = TaskStatus::Cancelled;
            }
            ResolutionType::Complete => {
                // Pay worker if provided
                if let Some(worker) = &ctx.accounts.worker {
                    if remaining_funds > 0 {
                        **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
                        **worker.to_account_info().try_borrow_mut_lamports()? += remaining_funds;
                    }
                }
                task.status = TaskStatus::Completed;
                task.completed_at = clock.unix_timestamp;
            }
            ResolutionType::Split => {
                // Split 50/50 between creator and worker
                let half = remaining_funds
                    .checked_div(2)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;

                if half > 0 {
                    **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
                    **ctx
                        .accounts
                        .creator
                        .to_account_info()
                        .try_borrow_mut_lamports()? += half;

                    if let Some(worker) = &ctx.accounts.worker {
                        **worker.to_account_info().try_borrow_mut_lamports()? +=
                            remaining_funds - half;
                    } else {
                        // If no worker, give all to creator
                        **ctx
                            .accounts
                            .creator
                            .to_account_info()
                            .try_borrow_mut_lamports()? += remaining_funds - half;
                    }
                }
                task.status = TaskStatus::Cancelled;
            }
        }
    } else {
        // Dispute rejected - refund to creator by default
        if remaining_funds > 0 {
            **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
            **ctx
                .accounts
                .creator
                .to_account_info()
                .try_borrow_mut_lamports()? += remaining_funds;
        }
        task.status = TaskStatus::Cancelled;
    }

    // Update dispute status
    dispute.status = DisputeStatus::Resolved;
    dispute.resolved_at = clock.unix_timestamp;
    escrow.is_closed = true;

    emit!(DisputeResolved {
        dispute_id: dispute.dispute_id,
        resolution_type: dispute.resolution_type as u8,
        votes_for: dispute.votes_for,
        votes_against: dispute.votes_against,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
