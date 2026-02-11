//! Resolve a dispute and execute the outcome

use crate::errors::CoordinationError;
use crate::events::{dispute_outcome, DisputeResolved};
use crate::instructions::completion_helpers::update_protocol_stats;
use crate::instructions::constants::PERCENT_BASE;
use crate::instructions::dispute_helpers::{
    check_duplicate_arbiters, process_arbiter_vote_pair, process_worker_claim_pair,
    validate_remaining_accounts_structure,
};
use crate::instructions::lamport_transfer::{credit_lamports, debit_lamports, transfer_lamports};
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
    /// Made mutable to allow closing after dispute resolution (fix #439)
    #[account(
        mut,
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

    // Validate worker accounts are consistent (fix #59, #296, #457)
    // If any worker account is provided, all must be provided and valid
    validate_worker_accounts(
        &ctx.accounts.worker,
        &ctx.accounts.worker_claim,
        &ctx.accounts.worker_authority,
        &task.key(),
    )?;

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
    //
    // Fix #425: We now explicitly track whether this was a no-vote default vs an actual
    // rejection. This distinction matters because:
    // - No votes could mean arbiters didn't see the dispute (apathy), not that they rejected it
    // - Consumers may want to handle no-vote defaults differently (e.g., extend deadline, split)
    // - Workers should not be penalized the same way for arbiter apathy vs active rejection
    //
    // The `outcome` field in DisputeResolved event distinguishes these cases:
    // - REJECTED (0): Arbiters actively voted against approval
    // - APPROVED (1): Arbiters voted in favor and met threshold
    // - NO_VOTE_DEFAULT (2): No votes cast, defaulted to rejection
    let (approved, outcome) = if total_votes == 0 {
        // No votes = dispute rejected by default (not by active vote)
        // This is arbiter apathy, not an active rejection decision
        (false, dispute_outcome::NO_VOTE_DEFAULT)
    } else {
        let approval_pct = dispute
            .votes_for
            .checked_mul(PERCENT_BASE)
            .ok_or(CoordinationError::ArithmeticOverflow)?
            .checked_div(total_votes)
            .ok_or(CoordinationError::ArithmeticOverflow)? as u8;
        let is_approved = approval_pct >= config.dispute_threshold;
        let outcome = if is_approved {
            dispute_outcome::APPROVED
        } else {
            dispute_outcome::REJECTED
        };
        (is_approved, outcome)
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
                transfer_lamports(
                    &escrow.to_account_info(),
                    &ctx.accounts.creator.to_account_info(),
                    remaining_funds,
                )?;
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
                    transfer_lamports(
                        &escrow.to_account_info(),
                        &worker_authority.to_account_info(),
                        remaining_funds,
                    )?;
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

                    // Debit escrow once for total, credit recipients individually
                    debit_lamports(&escrow.to_account_info(), remaining_funds)?;
                    let creator_info = ctx.accounts.creator.to_account_info();
                    credit_lamports(&creator_info, creator_share)?;

                    if let Some(worker_authority) = &ctx.accounts.worker_authority {
                        // Worker must have valid claim (fix #296: pay to authority wallet)
                        require!(
                            ctx.accounts.worker_claim.is_some() && ctx.accounts.worker.is_some(),
                            CoordinationError::NotClaimed
                        );
                        credit_lamports(&worker_authority.to_account_info(), worker_share)?;
                    } else {
                        // If no worker_authority, give all to creator
                        credit_lamports(&creator_info, worker_share)?;
                    }
                }
                task.status = TaskStatus::Cancelled;
            }
        }
    } else {
        // Dispute rejected - refund to creator by default
        transfer_lamports(
            &escrow.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            remaining_funds,
        )?;
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
        // Using saturating_sub intentionally - underflow returns 0 (safe counter decrement)
        worker_reg.disputes_as_defendant = worker_reg.disputes_as_defendant.saturating_sub(1);
        worker_reg.try_serialize(&mut &mut worker_data[8..])?;
    }

    // Update dispute status - decrement active_dispute_votes for each arbiter
    //
    // remaining_accounts format (fix #333):
    // - First: (vote, arbiter) pairs for total_voters
    // - Then: optional (claim, worker) pairs for additional workers on collaborative tasks
    let arbiter_accounts =
        validate_remaining_accounts_structure(ctx.remaining_accounts, dispute.total_voters)?;
    check_duplicate_arbiters(ctx.remaining_accounts, arbiter_accounts)?;

    for i in (0..arbiter_accounts).step_by(2) {
        process_arbiter_vote_pair(
            &ctx.remaining_accounts[i],
            &ctx.remaining_accounts[i + 1],
            &dispute.key(),
        )?;
    }

    for i in (arbiter_accounts..ctx.remaining_accounts.len()).step_by(2) {
        process_worker_claim_pair(
            &ctx.remaining_accounts[i],
            &ctx.remaining_accounts[i + 1],
            &task.key(),
        )?;
    }

    dispute.status = DisputeStatus::Resolved;
    dispute.resolved_at = clock.unix_timestamp;
    escrow.is_closed = true;

    // Close worker_claim account and return lamports to creator (fix #439)
    // The claim is no longer needed once the dispute is resolved
    if let Some(claim) = ctx.accounts.worker_claim.as_ref() {
        claim.close(ctx.accounts.creator.to_account_info())?;
    }

    emit!(DisputeResolved {
        dispute_id: dispute.dispute_id,
        resolution_type: dispute.resolution_type as u8,
        outcome,
        votes_for: dispute.votes_for,
        votes_against: dispute.votes_against,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Validates worker account consistency (fix #457)
///
/// Ensures that if any worker-related account is provided, all required accounts
/// are present and properly linked. This replaces error-prone nested if-let checks.
fn validate_worker_accounts(
    worker: &Option<UncheckedAccount>,
    worker_claim: &Option<Box<Account<TaskClaim>>>,
    worker_authority: &Option<UncheckedAccount>,
    task_key: &Pubkey,
) -> Result<()> {
    // Count how many worker accounts are provided
    let has_worker = worker.is_some();
    let has_claim = worker_claim.is_some();
    let has_authority = worker_authority.is_some();

    // All-or-nothing: either all are None, or all must be Some
    let provided_count = [has_worker, has_claim, has_authority]
        .iter()
        .filter(|&&x| x)
        .count();

    if provided_count == 0 {
        // No worker accounts - valid for refund-only resolutions
        return Ok(());
    }

    // If any provided, all must be provided
    require!(
        provided_count == 3,
        CoordinationError::NotClaimed
    );

    // Safe: we verified provided_count == 3 above (all are Some)
    let worker = worker.as_ref().expect("verified provided_count == 3 above");
    let worker_claim = worker_claim.as_ref().expect("verified provided_count == 3 above");
    let worker_authority = worker_authority.as_ref().expect("verified provided_count == 3 above");

    // Verify worker matches claim
    require!(
        worker.key() == worker_claim.worker,
        CoordinationError::UnauthorizedAgent
    );

    // Verify claim is for this task
    require!(
        worker_claim.task == *task_key,
        CoordinationError::NotClaimed
    );

    // Verify worker account ownership and authority
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

    Ok(())
}

