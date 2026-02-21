//! Resolve a dispute and execute the outcome

use crate::errors::CoordinationError;
use crate::events::{dispute_outcome, DisputeResolved};
use crate::instructions::completion_helpers::update_protocol_stats;
use crate::instructions::constants::{MIN_VOTERS_FOR_RESOLUTION, PERCENT_BASE};
use crate::instructions::dispute_helpers::{
    check_duplicate_arbiters, check_duplicate_workers, process_arbiter_vote_pair,
    process_worker_claim_pair, validate_remaining_accounts_structure,
};
use crate::instructions::lamport_transfer::{credit_lamports, debit_lamports, transfer_lamports};
use crate::instructions::slash_helpers::calculate_slash_amount;
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_account,
};
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, ProtocolConfig, ResolutionType, Task, TaskClaim,
    TaskEscrow, TaskStatus,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

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

    /// Worker agent account for the dispute defendant.
    #[account(mut)]
    pub worker: Option<Box<Account<'info, AgentRegistration>>>,

    /// CHECK: Worker's authority wallet for receiving payment
    #[account(mut)]
    pub worker_authority: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    /// Token escrow ATA holding reward tokens (optional)
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// Creator's token account for refund (optional)
    /// CHECK: Validated in handler
    #[account(mut)]
    pub creator_token_account: Option<UncheckedAccount<'info>>,

    /// Worker's token account for payment (optional)
    /// CHECK: Validated in handler
    #[account(mut)]
    pub worker_token_account_ata: Option<UncheckedAccount<'info>>,

    /// Treasury's token account for protocol fees (optional)
    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    /// SPL token mint (optional, must match task.reward_mint)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,
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

    // Validate and bind defendant worker accounts (fix #842)
    validate_worker_accounts(
        dispute.as_ref(),
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
    require!(
        dispute.total_voters as usize >= MIN_VOTERS_FOR_RESOLUTION,
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

    let (approved, outcome) =
        determine_dispute_outcome(dispute.votes_for, dispute.votes_against, total_votes, config)?;

    // Calculate remaining escrow funds
    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Prepare token context if this is a token-denominated task
    let is_token_task = task.reward_mint.is_some();
    let task_key = task.key();
    let worker_stake_now = ctx
        .accounts
        .worker
        .as_ref()
        .ok_or(CoordinationError::WorkerAgentRequired)?
        .stake;

    if is_token_task {
        require!(
            ctx.accounts.token_escrow_ata.is_some()
                && ctx.accounts.reward_mint.is_some()
                && ctx.accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );
        let mint = ctx.accounts.reward_mint.as_ref().unwrap();
        require!(
            mint.key() == task.reward_mint.unwrap(),
            CoordinationError::InvalidTokenMint
        );
        let token_escrow = ctx.accounts.token_escrow_ata.as_ref().unwrap();
        validate_token_account(token_escrow, &mint.key(), &escrow.key())?;
    }

    // A worker "loses" when dispute is approved and resolution is not Complete.
    // This matches apply_dispute_slash semantics.
    let worker_lost = approved && dispute.resolution_type != ResolutionType::Complete;
    let slash_amount = if worker_lost {
        calculate_slash_amount(
            dispute.worker_stake_at_dispute,
            worker_stake_now,
            config.slash_percentage,
        )?
    } else {
        0
    };
    let token_slash_reserve = if is_token_task && worker_lost {
        slash_amount.min(remaining_funds)
    } else {
        0
    };
    let worker_slash_pending = worker_lost && slash_amount > 0;
    let defer_token_escrow_close = is_token_task && worker_slash_pending;
    let defer_worker_claim_close = worker_slash_pending;

    // Pre-compute escrow PDA signer seeds (used by all token paths)
    let task_key_bytes = task_key.to_bytes();
    let bump_slice = [escrow.bump];
    let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];

    // Execute resolution based on type and approval
    if approved {
        match dispute.resolution_type {
            ResolutionType::Refund => {
                if is_token_task {
                    let token_escrow = ctx.accounts.token_escrow_ata.as_ref().unwrap();
                    let token_program = ctx.accounts.token_program.as_ref().unwrap();
                    require!(
                        ctx.accounts.creator_token_account.is_some(),
                        CoordinationError::MissingTokenAccounts
                    );
                    let creator_ta = ctx.accounts.creator_token_account.as_ref().unwrap();
                    let creator_refund = remaining_funds
                        .checked_sub(token_slash_reserve)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    transfer_tokens_from_escrow(
                        token_escrow,
                        &creator_ta.to_account_info(),
                        &escrow.to_account_info(),
                        creator_refund,
                        escrow_seeds,
                        token_program,
                    )?;
                    if !defer_token_escrow_close {
                        close_token_escrow(
                            token_escrow,
                            &ctx.accounts.creator.to_account_info(),
                            &escrow.to_account_info(),
                            escrow_seeds,
                            token_program,
                        )?;
                    }
                } else {
                    transfer_lamports(
                        &escrow.to_account_info(),
                        &ctx.accounts.creator.to_account_info(),
                        remaining_funds,
                    )?;
                }
                task.status = TaskStatus::Cancelled;
            }
            ResolutionType::Complete => {
                let worker_authority = ctx.accounts.worker_authority.as_ref().unwrap();
                if is_token_task {
                    let token_escrow = ctx.accounts.token_escrow_ata.as_ref().unwrap();
                    let token_program = ctx.accounts.token_program.as_ref().unwrap();
                    require!(
                        ctx.accounts.worker_token_account_ata.is_some(),
                        CoordinationError::MissingTokenAccounts
                    );
                    let worker_ta = ctx.accounts.worker_token_account_ata.as_ref().unwrap();
                    transfer_tokens_from_escrow(
                        token_escrow,
                        &worker_ta.to_account_info(),
                        &escrow.to_account_info(),
                        remaining_funds,
                        escrow_seeds,
                        token_program,
                    )?;
                    close_token_escrow(
                        token_escrow,
                        &ctx.accounts.creator.to_account_info(),
                        &escrow.to_account_info(),
                        escrow_seeds,
                        token_program,
                    )?;
                } else {
                    transfer_lamports(
                        &escrow.to_account_info(),
                        &worker_authority.to_account_info(),
                        remaining_funds,
                    )?;
                }
                task.status = TaskStatus::Completed;
                task.completed_at = clock.unix_timestamp;
                update_protocol_stats(&mut ctx.accounts.protocol_config, remaining_funds)?;
            }
            ResolutionType::Split => {
                if remaining_funds > 0 {
                    let distributable = remaining_funds
                        .checked_sub(token_slash_reserve)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    let worker_share = distributable
                        .checked_div(2)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    let creator_share = distributable
                        .checked_sub(worker_share)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;

                    let worker_authority = ctx.accounts.worker_authority.as_ref().unwrap();

                    if is_token_task {
                        let token_escrow = ctx.accounts.token_escrow_ata.as_ref().unwrap();
                        let token_program = ctx.accounts.token_program.as_ref().unwrap();
                        require!(
                            ctx.accounts.creator_token_account.is_some()
                                && ctx.accounts.worker_token_account_ata.is_some(),
                            CoordinationError::MissingTokenAccounts
                        );
                        let creator_ta = ctx.accounts.creator_token_account.as_ref().unwrap();
                        let worker_ta = ctx.accounts.worker_token_account_ata.as_ref().unwrap();
                        transfer_tokens_from_escrow(
                            token_escrow,
                            &creator_ta.to_account_info(),
                            &escrow.to_account_info(),
                            creator_share,
                            escrow_seeds,
                            token_program,
                        )?;
                        transfer_tokens_from_escrow(
                            token_escrow,
                            &worker_ta.to_account_info(),
                            &escrow.to_account_info(),
                            worker_share,
                            escrow_seeds,
                            token_program,
                        )?;
                        if !defer_token_escrow_close {
                            close_token_escrow(
                                token_escrow,
                                &ctx.accounts.creator.to_account_info(),
                                &escrow.to_account_info(),
                                escrow_seeds,
                                token_program,
                            )?;
                        }
                    } else {
                        debit_lamports(&escrow.to_account_info(), remaining_funds)?;
                        let creator_info = ctx.accounts.creator.to_account_info();
                        credit_lamports(&creator_info, creator_share)?;
                        credit_lamports(&worker_authority.to_account_info(), worker_share)?;
                    }
                }
                task.status = TaskStatus::Cancelled;
            }
        }
    } else {
        // Dispute rejected - refund to creator by default
        if is_token_task {
            let token_escrow = ctx.accounts.token_escrow_ata.as_ref().unwrap();
            let token_program = ctx.accounts.token_program.as_ref().unwrap();
            require!(
                ctx.accounts.creator_token_account.is_some(),
                CoordinationError::MissingTokenAccounts
            );
            let creator_ta = ctx.accounts.creator_token_account.as_ref().unwrap();
            transfer_tokens_from_escrow(
                token_escrow,
                &creator_ta.to_account_info(),
                &escrow.to_account_info(),
                remaining_funds,
                escrow_seeds,
                token_program,
            )?;
            close_token_escrow(
                token_escrow,
                &ctx.accounts.creator.to_account_info(),
                &escrow.to_account_info(),
                escrow_seeds,
                token_program,
            )?;
        } else {
            transfer_lamports(
                &escrow.to_account_info(),
                &ctx.accounts.creator.to_account_info(),
                remaining_funds,
            )?;
        }
        task.status = TaskStatus::Cancelled;
    }

    // Decrement defendant counters deterministically (fix #544, #842)
    let worker = ctx
        .accounts
        .worker
        .as_mut()
        .ok_or(CoordinationError::WorkerAgentRequired)?;
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    // Update activity timestamp so fallback deregistration gating has a deterministic anchor.
    worker.last_active = clock.unix_timestamp;
    if !worker_slash_pending {
        worker.disputes_as_defendant = worker.disputes_as_defendant.saturating_sub(1);
    }
    let defendant_worker_key = worker.key();

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

    let worker_pairs = (ctx.remaining_accounts.len() - arbiter_accounts) / 2;
    let expected_worker_pairs = usize::from(
        task.current_workers
            .checked_sub(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?,
    );
    require!(
        worker_pairs == expected_worker_pairs,
        CoordinationError::IncompleteWorkerAccounts
    );

    // Check for duplicate workers before processing (fix #826)
    check_duplicate_workers(
        ctx.remaining_accounts,
        arbiter_accounts,
        Some(defendant_worker_key),
    )?;

    for i in (arbiter_accounts..ctx.remaining_accounts.len()).step_by(2) {
        process_worker_claim_pair(
            &ctx.remaining_accounts[i],
            &ctx.remaining_accounts[i + 1],
            &task.key(),
        )?;
    }

    dispute.status = DisputeStatus::Resolved;
    dispute.resolved_at = clock.unix_timestamp;
    let distributed_now = remaining_funds
        .checked_sub(token_slash_reserve)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    escrow.distributed = escrow
        .distributed
        .checked_add(distributed_now)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    escrow.is_closed = !defer_token_escrow_close;
    task.current_workers = 0;

    if !defer_token_escrow_close {
        escrow.close(ctx.accounts.creator.to_account_info())?;
    }

    // Close worker_claim account and return rent lamports to worker authority (fix #838)
    // The claim rent was paid by worker authority at creation, so return it there
    if !defer_worker_claim_close {
        let claim = ctx
            .accounts
            .worker_claim
            .as_ref()
            .ok_or(CoordinationError::WorkerClaimRequired)?;
        let worker_authority = ctx
            .accounts
            .worker_authority
            .as_ref()
            .ok_or(CoordinationError::IncompleteWorkerAccounts)?;
        claim.close(worker_authority.to_account_info())?;
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

/// Validates worker account consistency and defendant binding.
fn validate_worker_accounts(
    dispute: &Dispute,
    worker: &Option<Box<Account<AgentRegistration>>>,
    worker_claim: &Option<Box<Account<TaskClaim>>>,
    worker_authority: &Option<UncheckedAccount>,
    task_key: &Pubkey,
) -> Result<()> {
    let worker = worker
        .as_ref()
        .ok_or(CoordinationError::WorkerAgentRequired)?;
    let worker_claim = worker_claim
        .as_ref()
        .ok_or(CoordinationError::WorkerClaimRequired)?;
    let worker_authority = worker_authority
        .as_ref()
        .ok_or(CoordinationError::IncompleteWorkerAccounts)?;

    // Worker must be the dispute defendant.
    require!(
        worker.key() == dispute.defendant,
        CoordinationError::WorkerNotInDispute
    );

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

    // Verify worker authority binding.
    require!(
        worker_authority.key() == worker.authority,
        CoordinationError::UnauthorizedAgent
    );

    Ok(())
}

/// Determine dispute outcome from vote counts.
///
/// Returns `(approved, outcome_code)` where outcome_code is one of:
/// - `dispute_outcome::REJECTED` (0): Arbiters actively voted against
/// - `dispute_outcome::APPROVED` (1): Arbiters voted in favor and met threshold
/// - `dispute_outcome::NO_VOTE_DEFAULT` (2): No votes cast, defaulted to rejection
fn determine_dispute_outcome(
    votes_for: u64,
    _votes_against: u64,
    total_votes: u64,
    config: &ProtocolConfig,
) -> Result<(bool, u8)> {
    if total_votes == 0 {
        return Ok((false, dispute_outcome::NO_VOTE_DEFAULT));
    }

    let approval_pct = votes_for
        .checked_mul(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(total_votes)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let is_approved = approval_pct >= config.dispute_threshold as u64;
    let outcome = if is_approved {
        dispute_outcome::APPROVED
    } else {
        dispute_outcome::REJECTED
    };
    Ok((is_approved, outcome))
}
