//! Resolve a dispute and execute the outcome

use crate::errors::CoordinationError;
use crate::events::DisputeResolved;
use crate::instructions::constants::PERCENT_BASE;
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, DisputeVote, ProtocolConfig, ResolutionType, Task,
    TaskClaim, TaskEscrow, TaskStatus,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

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
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        constraint = resolver.key() == protocol_config.authority
            || resolver.key() == dispute.initiator
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

    // Calculate total votes and check threshold
    let total_votes = dispute
        .votes_for
        .checked_add(dispute.votes_against)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(total_votes > 0, CoordinationError::InsufficientVotes);

    // Calculate approval percentage
    let approval_pct = dispute
        .votes_for
        .checked_mul(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(total_votes)
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
            }
            ResolutionType::Split => {
                // Split remaining funds between creator and worker.
                // Use remaining_funds > 0 (not half > 0) to handle the edge case
                // where remaining_funds = 1 and half rounds down to 0.
                if remaining_funds > 0 {
                    let half = remaining_funds
                        .checked_div(2)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    let other_half = remaining_funds
                        .checked_sub(half)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;

                    **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
                    **ctx
                        .accounts
                        .creator
                        .to_account_info()
                        .try_borrow_mut_lamports()? += half;

                    if let Some(worker_authority) = &ctx.accounts.worker_authority {
                        // Worker must have valid claim (fix #296: pay to authority wallet)
                        require!(
                            ctx.accounts.worker_claim.is_some() && ctx.accounts.worker.is_some(),
                            CoordinationError::NotClaimed
                        );
                        **worker_authority.to_account_info().try_borrow_mut_lamports()? +=
                            other_half;
                    } else {
                        // If no worker_authority, give all to creator
                        **ctx
                            .accounts
                            .creator
                            .to_account_info()
                            .try_borrow_mut_lamports()? += other_half;
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
        worker_reg.try_serialize(&mut &mut worker_data[8..])?;
    }

    // Update dispute status - decrement active_dispute_votes for each arbiter
    if dispute.total_voters > 0 {
        let expected = dispute
            .total_voters
            .checked_mul(2)
            .ok_or(CoordinationError::ArithmeticOverflow)? as usize;
        require!(
            ctx.remaining_accounts.len() == expected,
            CoordinationError::InvalidInput
        );

        for i in (0..expected).step_by(2) {
            let vote_info = &ctx.remaining_accounts[i];
            let arbiter_info = &ctx.remaining_accounts[i + 1];

            // CRITICAL: Validate account ownership before deserialization (fix: unsafe deserialization)
            // Without this check, attackers could pass fake accounts not owned by this program
            require!(
                vote_info.owner == &crate::ID,
                CoordinationError::InvalidAccountOwner
            );
            require!(
                arbiter_info.owner == &crate::ID,
                CoordinationError::InvalidAccountOwner
            );

            // Validate vote account
            let vote_data = vote_info.try_borrow_data()?;
            // try_deserialize expects full data including discriminator
            let vote = DisputeVote::try_deserialize(&mut &**vote_data)?;
            require!(
                vote.dispute == dispute.key(),
                CoordinationError::InvalidInput
            );
            require!(
                vote.voter == arbiter_info.key(),
                CoordinationError::InvalidInput
            );
            drop(vote_data);

            require!(arbiter_info.is_writable, CoordinationError::InvalidInput);

            // Decrement active_dispute_votes on arbiter
            let mut arbiter_data = arbiter_info.try_borrow_mut_data()?;
            // try_deserialize expects full data including discriminator
            let mut arbiter = AgentRegistration::try_deserialize(&mut &**arbiter_data)?;
            // Use checked_sub to catch accounting errors - underflow here indicates a bug
            arbiter.active_dispute_votes = arbiter
                .active_dispute_votes
                .checked_sub(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            // Serialize back, skipping discriminator (already validated during deserialize)
            arbiter.try_serialize(&mut &mut arbiter_data[8..])?;
        }
    } else {
        require!(
            ctx.remaining_accounts.is_empty(),
            CoordinationError::InvalidInput
        );
    }

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
