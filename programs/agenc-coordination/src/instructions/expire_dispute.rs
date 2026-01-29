//! Expire a dispute after the maximum duration

use std::collections::HashSet;

use crate::errors::CoordinationError;
use crate::events::DisputeExpired;
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, DisputeVote, ProtocolConfig, Task, TaskClaim,
    TaskEscrow, TaskStatus,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ExpireDispute<'info> {
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
        close = creator,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Task creator for refund - validated to match task.creator
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    /// Worker's claim on the disputed task (fix #137)
    /// Optional - when provided, allows decrementing worker's active_tasks
    #[account(
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
        constraint = worker_claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub worker_claim: Option<Account<'info, TaskClaim>>,

    /// CHECK: Worker's AgentRegistration PDA - validated to match worker_claim.worker (fix #137)
    #[account(mut)]
    pub worker: Option<UncheckedAccount<'info>>,
}

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

    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    if remaining_funds > 0 {
        **escrow.to_account_info().try_borrow_mut_lamports()? -= remaining_funds;
        **ctx
            .accounts
            .creator
            .to_account_info()
            .try_borrow_mut_lamports()? += remaining_funds;
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
            arbiter.active_dispute_votes = arbiter.active_dispute_votes.saturating_sub(1);
            arbiter.try_serialize(&mut &mut arbiter_data[8..])?;
        }

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
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
