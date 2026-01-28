//! Expire a dispute after the maximum duration

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
    require!(
        clock.unix_timestamp > dispute.expires_at,
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
    // remaining_accounts layout: [arbiter pairs...][worker pairs...]
    // - Arbiter pairs: (DisputeVote, AgentRegistration) x total_voters
    // - Worker pairs: (TaskClaim, AgentRegistration) for additional workers (fix #333)
    let arbiter_accounts_end = dispute
        .total_voters
        .checked_mul(2)
        .ok_or(CoordinationError::ArithmeticOverflow)? as usize;

    // Validate remaining_accounts has even count for pairs after arbiter section
    let remaining_after_arbiters = ctx
        .remaining_accounts
        .len()
        .checked_sub(arbiter_accounts_end)
        .ok_or(CoordinationError::InvalidInput)?;
    require!(
        remaining_after_arbiters % 2 == 0,
        CoordinationError::InvalidInput
    );

    if dispute.total_voters > 0 {
        require!(
            ctx.remaining_accounts.len() >= arbiter_accounts_end,
            CoordinationError::InvalidInput
        );

        for i in (0..arbiter_accounts_end).step_by(2) {
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
    }

    // Decrement active_tasks for ALL additional workers who claimed the task (fix #333)
    // Process remaining (TaskClaim, AgentRegistration) pairs after arbiter accounts
    for i in (arbiter_accounts_end..ctx.remaining_accounts.len()).step_by(2) {
        let claim_info = &ctx.remaining_accounts[i];
        let worker_info = &ctx.remaining_accounts[i + 1];

        // Validate both accounts are owned by this program
        require!(
            claim_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        require!(
            worker_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );

        // Deserialize and validate claim belongs to this task
        let claim_data = claim_info.try_borrow_data()?;
        let claim = TaskClaim::try_deserialize(&mut &**claim_data)?;
        require!(claim.task == task.key(), CoordinationError::InvalidInput);
        // Validate worker_info matches claim.worker
        require!(
            worker_info.key() == claim.worker,
            CoordinationError::InvalidInput
        );
        drop(claim_data);

        require!(worker_info.is_writable, CoordinationError::InvalidInput);

        // Decrement worker's active_tasks counter
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
