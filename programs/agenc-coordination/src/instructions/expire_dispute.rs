//! Expires a dispute after voting period ends.
//!
//! # Permissionless Design
//! This instruction can be called by anyone. This is intentional:
//! - Prevents disputes from being permanently stuck
//! - Allows third-party cleanup services
//! - No economic risk since only valid expirations succeed
//!
//! # Fair Refund Distribution (fix #418)
//! When a dispute expires, funds are distributed based on context:
//! - Worker completed + no votes: Worker gets 100% (did work, dispute not properly engaged)
//! - No completion + no votes: 50/50 split (neither party engaged arbiters)
//! - Some votes but insufficient quorum: Creator gets refund (dispute was contested)

use std::collections::HashSet;

use crate::errors::CoordinationError;
use crate::events::{ArbiterVotesCleanedUp, DisputeExpired};
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, DisputeVote, ProtocolConfig, Task, TaskClaim,
    TaskEscrow, TaskStatus,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// Note: Large accounts use Box<Account<...>> to avoid stack overflow
/// Consistent with Anchor best practices for accounts > 10KB
#[derive(Accounts)]
pub struct ExpireDispute<'info> {
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
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Task creator for refund - validated to match task.creator
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    /// Worker's claim on the disputed task (fix #137)
    /// Optional - when provided, allows decrementing worker's active_tasks
    /// and enables fair refund distribution (fix #418)
    #[account(
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
        constraint = worker_claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub worker_claim: Option<Box<Account<'info, TaskClaim>>>,

    /// CHECK: Worker's AgentRegistration PDA - validated to match worker_claim.worker (fix #137)
    #[account(mut)]
    pub worker: Option<UncheckedAccount<'info>>,

    /// CHECK: Worker's authority wallet for receiving payment (fix #418)
    /// Required when worker should receive funds on expiration
    #[account(mut)]
    pub worker_authority: Option<UncheckedAccount<'info>>,
}

/// Expires a dispute after voting period ends.
///
/// # Permissionless Design
/// This instruction can be called by anyone. This is intentional:
/// - Prevents disputes from being permanently stuck
/// - Allows third-party cleanup services
/// - No economic risk since only valid expirations succeed
pub fn handler(ctx: Context<ExpireDispute>) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let escrow = &mut ctx.accounts.escrow;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;

    require!(
        dispute.status == DisputeStatus::Active,
        CoordinationError::DisputeNotActive
    );

    // Validate task is in disputed state and transition is allowed (fix #538)
    require!(
        task.status == TaskStatus::Disputed,
        CoordinationError::TaskNotInProgress
    );
    require!(
        task.status.can_transition_to(TaskStatus::Cancelled),
        CoordinationError::InvalidStatusTransition
    );

    // Fix #574: Allow expiration when EITHER expires_at OR voting_deadline has passed.
    // This closes the gap between voting_deadline and expires_at where disputes
    // could get stuck with funds locked if no one called resolve_dispute.
    require!(
        clock.unix_timestamp > dispute.expires_at
            || clock.unix_timestamp >= dispute.voting_deadline,
        CoordinationError::DisputeNotExpired
    );

    // Validate worker account matches worker_claim if both provided (fix #137)
    if let (Some(worker), Some(worker_claim)) =
        (&ctx.accounts.worker, &ctx.accounts.worker_claim)
    {
        require!(
            worker.key() == worker_claim.worker,
            CoordinationError::UnauthorizedAgent
        );
    }

    // Validate worker_authority matches worker's authority field (fix #418)
    if let (Some(worker), Some(worker_authority)) =
        (&ctx.accounts.worker, &ctx.accounts.worker_authority)
    {
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

    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Track distribution for event emission (fix #418)
    let mut creator_amount: u64 = 0;
    let mut worker_amount: u64 = 0;

    // Fair refund distribution based on context (fix #418)
    // - Worker completed + no votes: Worker gets 100% (did work, dispute not properly engaged)
    // - No completion + no votes: 50/50 split (neither party engaged arbiters)
    // - Some votes but insufficient quorum: Creator gets refund (dispute was contested)
    if remaining_funds > 0 {
        let worker_completed = ctx
            .accounts
            .worker_claim
            .as_ref()
            .map(|c| c.is_completed)
            .unwrap_or(false);
        let no_votes = dispute.total_voters == 0;

        if no_votes && worker_completed {
            // Worker completed the task but arbiters didn't engage
            // Worker should receive funds since they did the work
            if let Some(worker_authority) = &ctx.accounts.worker_authority {
                worker_amount = remaining_funds;
                **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
                **worker_authority.to_account_info().try_borrow_mut_lamports()? += remaining_funds;
            } else {
                // Fallback: if no worker_authority provided, split 50/50
                let worker_share = remaining_funds
                    .checked_div(2)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
                let creator_share = remaining_funds
                    .checked_sub(worker_share)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
                // Note: worker_share goes to creator as fallback since we can't pay worker
                creator_amount = remaining_funds;
                **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
                **ctx
                    .accounts
                    .creator
                    .to_account_info()
                    .try_borrow_mut_lamports()? += creator_share;
                **ctx
                    .accounts
                    .creator
                    .to_account_info()
                    .try_borrow_mut_lamports()? += worker_share;
            }
        } else if no_votes {
            // Neither party engaged arbiters, split 50/50
            let worker_share = remaining_funds
                .checked_div(2)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            let creator_share = remaining_funds
                .checked_sub(worker_share)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            creator_amount = creator_share;
            **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
            **ctx
                .accounts
                .creator
                .to_account_info()
                .try_borrow_mut_lamports()? += creator_share;

            if let Some(worker_authority) = &ctx.accounts.worker_authority {
                worker_amount = worker_share;
                **worker_authority.to_account_info().try_borrow_mut_lamports()? += worker_share;
            } else {
                // Fallback: creator gets all if no worker_authority
                creator_amount = remaining_funds;
                **ctx
                    .accounts
                    .creator
                    .to_account_info()
                    .try_borrow_mut_lamports()? += worker_share;
            }
        } else {
            // Some votes were cast but not enough for quorum
            // Creator gets refund (dispute was actively contested but inconclusive)
            creator_amount = remaining_funds;
            **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
            **ctx
                .accounts
                .creator
                .to_account_info()
                .try_borrow_mut_lamports()? += remaining_funds;
        }
    }

    // Decrement worker's active_tasks counter (fix #137)
    // The worker account is the AgentRegistration PDA - deserialize to update state
    if let Some(worker) = &ctx.accounts.worker {
        require!(
            ctx.accounts.worker_claim.is_some(),
            CoordinationError::NotClaimed
        );
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

    // Decrement active_dispute_votes for each arbiter who voted (fix #328)
    //
    // Worker accounts processing - shared pattern with resolve_dispute/expire_dispute
    // The duplication is intentional to avoid cross-instruction dependencies
    // and keep each instruction self-contained.
    //
    // remaining_accounts format (fix #333):
    // - First: (vote, arbiter) pairs for total_voters
    // - Then: optional (claim, worker) pairs for additional workers on collaborative tasks
    let arbiter_accounts = dispute
        .total_voters
        .checked_mul(2)
        .ok_or(CoordinationError::ArithmeticOverflow)? as usize;

    // Validate we have at least enough accounts for arbiters
    require!(
        ctx.remaining_accounts.len() >= arbiter_accounts,
        CoordinationError::InvalidInput
    );

    // Additional accounts must come in pairs (claim, worker)
    let extra_accounts = ctx.remaining_accounts.len() - arbiter_accounts;
    require!(extra_accounts % 2 == 0, CoordinationError::InvalidInput);

    // Check for duplicate arbiters (fix #583)
    let mut seen_arbiters: HashSet<Pubkey> = HashSet::new();
    for i in (0..arbiter_accounts).step_by(2) {
        let arbiter_key = ctx.remaining_accounts[i + 1].key();
        require!(
            seen_arbiters.insert(arbiter_key),
            CoordinationError::DuplicateArbiter
        );
    }

    // Process arbiter (vote, arbiter) pairs
    for i in (0..arbiter_accounts).step_by(2) {
        let vote_info = &ctx.remaining_accounts[i];
        let arbiter_info = &ctx.remaining_accounts[i + 1];

            require!(
                vote_info.owner == &crate::ID,
                CoordinationError::InvalidAccountOwner
            );
            require!(
                arbiter_info.owner == &crate::ID,
                CoordinationError::InvalidAccountOwner
            );

            let vote_data = vote_info.try_borrow_data()?;
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
            let mut arbiter_data = arbiter_info.try_borrow_mut_data()?;
            let mut arbiter = AgentRegistration::try_deserialize(&mut &**arbiter_data)?;
            // Using saturating_sub intentionally - underflow returns 0 (safe counter decrement)
            arbiter.active_dispute_votes = arbiter.active_dispute_votes.saturating_sub(1);
            arbiter.try_serialize(&mut &mut arbiter_data[8..])?;
        }

    // Emit event for arbiter vote cleanup (fix #572)
    emit!(ArbiterVotesCleanedUp {
        dispute_id: dispute.dispute_id,
        arbiter_count: dispute.total_voters,
    });

    // Process additional worker (claim, worker) pairs to decrement active_tasks (fix #333)
    // This handles collaborative tasks where multiple workers claimed the task
    for i in (arbiter_accounts..ctx.remaining_accounts.len()).step_by(2) {
        let claim_info = &ctx.remaining_accounts[i];
        let worker_info = &ctx.remaining_accounts[i + 1];

        // Validate account ownership
        require!(
            claim_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        require!(
            worker_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );

        // Validate claim belongs to this task
        let claim_data = claim_info.try_borrow_data()?;
        let claim = TaskClaim::try_deserialize(&mut &**claim_data)?;
        require!(
            claim.task == task.key(),
            CoordinationError::InvalidInput
        );
        require!(
            claim.worker == worker_info.key(),
            CoordinationError::InvalidInput
        );
        drop(claim_data);

        // Decrement worker's active_tasks
        require!(worker_info.is_writable, CoordinationError::InvalidInput);
        let mut worker_data = worker_info.try_borrow_mut_data()?;
        let mut worker_reg = AgentRegistration::try_deserialize(&mut &**worker_data)?;
        // Using saturating_sub intentionally - underflow returns 0 (safe counter decrement)
        worker_reg.active_tasks = worker_reg.active_tasks.saturating_sub(1);
        worker_reg.try_serialize(&mut &mut worker_data[8..])?;
    }

    task.status = TaskStatus::Cancelled;
    dispute.status = DisputeStatus::Expired;
    dispute.resolved_at = clock.unix_timestamp;
    escrow.is_closed = true;

    emit!(DisputeExpired {
        dispute_id: dispute.dispute_id,
        task_id: task.task_id,
        refund_amount: remaining_funds,
        creator_amount,
        worker_amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
