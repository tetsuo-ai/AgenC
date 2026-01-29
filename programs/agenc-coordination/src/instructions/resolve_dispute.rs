//! Resolve a dispute and execute the outcome

use crate::errors::CoordinationError;
use crate::events::DisputeResolved;
use crate::instructions::completion_helpers::update_protocol_stats;
use crate::instructions::constants::PERCENT_BASE;
use crate::instructions::dispute_helpers::{
    process_remaining_accounts, DecrementMode, WorkerProcessingOptions,
};
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, ProtocolConfig, ResolutionType, Task, TaskClaim,
    TaskEscrow, TaskStatus,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// Note: Large accounts use Box<Account<...>> to avoid stack overflow
/// Consistent with Anchor best practices for accounts > 10KB
#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = dispute.task == task.key() @ CoordinationError::TaskNotFound
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        close = creator,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        constraint = resolver.key() == protocol_config.authority
            || resolver.key() == dispute.initiator_authority
            @ CoordinationError::UnauthorizedResolver
    )]
    pub resolver: Signer<'info>,

    /// CHECK: Task creator for refund - validated to match task.creator (fix #58)
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub creator: UncheckedAccount<'info>,

    /// Worker's claim proving they worked on task (fix #59)
    /// Required for Complete/Split resolutions that pay a worker
    #[account(
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
        constraint = worker_claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub worker_claim: Option<Box<Account<'info, TaskClaim>>>,

    /// CHECK: Worker receiving payment - must match worker_claim.worker (fix #59)
    #[account(mut)]
    pub worker: Option<UncheckedAccount<'info>>,

    /// CHECK: Worker's authority wallet for receiving payment
    #[account(mut)]
    pub worker_authority: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ResolveDispute>) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let escrow = &mut ctx.accounts.escrow;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;

    // Verify dispute is active
    require!(
        dispute.status == DisputeStatus::Active,
        CoordinationError::DisputeNotActive
    );

    // Prevent initiator from resolving their own dispute (fix #458)
    require!(
        ctx.accounts.resolver.key() != dispute.initiator_authority,
        CoordinationError::InitiatorCannotResolve
    );

    // Verify voting period has ended
    require!(
        clock.unix_timestamp >= dispute.voting_deadline,
        CoordinationError::VotingNotEnded
    );

    // Validate worker account matches worker_claim if both provided (fix #59)
    if let (Some(worker), Some(worker_claim)) = (&ctx.accounts.worker, &ctx.accounts.worker_claim) {
        require!(
            worker.key() == worker_claim.worker,
            CoordinationError::UnauthorizedAgent
        );
    }

    // Validate worker_authority matches worker's authority field (fix #296)
    if let (Some(worker), Some(worker_authority)) = (&ctx.accounts.worker, &ctx.accounts.worker_authority) {
        require!(
            worker.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        let worker_data = worker.try_borrow_data()?;
        let worker_reg = AgentRegistration::try_deserialize(&mut &**worker_data)?;
        require!(
            worker_authority.key() == worker_reg.authority,
            CoordinationError::UnauthorizedAgent
        );
        drop(worker_data);
    }

    // Calculate total votes
    let total_votes = dispute
        .votes_for
        .checked_add(dispute.votes_against)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Require minimum quorum for dispute resolution (fix #546)
    // A single arbiter should not be able to unilaterally decide outcomes
    const MIN_VOTERS_FOR_RESOLUTION: u8 = 3;
    require!(
        dispute.total_voters >= MIN_VOTERS_FOR_RESOLUTION,
        CoordinationError::InsufficientQuorum
    );

    // Validate task is in disputed state and transitions are allowed (fix #538)
    require!(
        task.status == TaskStatus::Disputed,
        CoordinationError::TaskNotInProgress
    );
    require!(
        task.status.can_transition_to(TaskStatus::Completed)
            && task.status.can_transition_to(TaskStatus::Cancelled),
        CoordinationError::InvalidStatusTransition
    );

    // Determine outcome: if no votes, treat as rejected (refund to creator)
    // This prevents tasks from being stuck between voting_deadline and expires_at
    let approved = if total_votes == 0 {
        false // No votes = dispute rejected
    } else {
        let approval_pct = dispute
            .votes_for
            .checked_mul(PERCENT_BASE)
            .ok_or(CoordinationError::ArithmeticOverflow)?
            .checked_div(total_votes)
            .ok_or(CoordinationError::ArithmeticOverflow)? as u8;
        approval_pct >= config.dispute_threshold
    };

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
                // Pay worker - requires valid worker_claim and worker_authority (fix #296)
                require!(
                    ctx.accounts.worker_claim.is_some()
                        && ctx.accounts.worker.is_some()
                        && ctx.accounts.worker_authority.is_some(),
                    CoordinationError::NotClaimed
                );

                // Pay to worker_authority (the actual wallet) instead of worker PDA (fix #296)
                if let Some(worker_authority) = &ctx.accounts.worker_authority {
                    if remaining_funds > 0 {
                        **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
                        **worker_authority.to_account_info().try_borrow_mut_lamports()? +=
                            remaining_funds;
                    }
                }
                task.status = TaskStatus::Completed;
                task.completed_at = clock.unix_timestamp;

                // Update protocol stats for completed dispute resolution (fix #359)
                update_protocol_stats(&mut ctx.accounts.protocol_config, remaining_funds)?;
            }
            ResolutionType::Split => {
                // Split remaining funds between creator and worker.
                // Use remaining_funds > 0 (not half > 0) to handle the edge case
                // where remaining_funds = 1 and half rounds down to 0.
                // Fix #563: Creator gets the rounding remainder for fairness
                // (creator funded the task, so any remainder returns to them)
                if remaining_funds > 0 {
                    let worker_share = remaining_funds
                        .checked_div(2)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    let creator_share = remaining_funds
                        .checked_sub(worker_share)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;

                    **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
                    **ctx
                        .accounts
                        .creator
                        .to_account_info()
                        .try_borrow_mut_lamports()? += creator_share;

                    if let Some(worker_authority) = &ctx.accounts.worker_authority {
                        // Worker must have valid claim (fix #296: pay to authority wallet)
                        require!(
                            ctx.accounts.worker_claim.is_some() && ctx.accounts.worker.is_some(),
                            CoordinationError::NotClaimed
                        );
                        **worker_authority.to_account_info().try_borrow_mut_lamports()? +=
                            worker_share;
                    } else {
                        // If no worker_authority, give all to creator
                        **ctx
                            .accounts
                            .creator
                            .to_account_info()
                            .try_borrow_mut_lamports()? += worker_share;
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

    // Decrement worker's active_tasks counter (fix #137)
    // Also decrement disputes_as_defendant counter (fix #544)
    // The worker account is the AgentRegistration PDA - deserialize to update state
    if let Some(worker) = &ctx.accounts.worker {
        require!(
            worker.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        let mut worker_data = worker.try_borrow_mut_data()?;
        let mut worker_reg = AgentRegistration::try_deserialize(&mut &**worker_data)?;
        worker_reg.active_tasks = worker_reg
            .active_tasks
            .checked_sub(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        // Decrement disputes_as_defendant (fix #544)
        worker_reg.disputes_as_defendant = worker_reg.disputes_as_defendant.saturating_sub(1);
        worker_reg.try_serialize(&mut &mut worker_data[8..])?;
    }

    // Update dispute status - decrement active_dispute_votes for each arbiter
    // remaining_accounts format (fix #333):
    // - First: (vote, arbiter) pairs for total_voters
    // - Then: optional (claim, worker) pairs for additional workers on collaborative tasks
    // See dispute_helpers.rs for implementation details (fix #443)
    process_remaining_accounts(
        ctx.remaining_accounts,
        dispute.total_voters,
        dispute.key(),
        task.key(),
        DecrementMode::Checked, // Use checked_sub - underflow indicates accounting bug
        WorkerProcessingOptions {
            decrement_disputes_as_defendant: true, // fix #544
        },
        &crate::ID,
    )?;

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
