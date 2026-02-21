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

use crate::errors::CoordinationError;
use crate::events::{ArbiterVotesCleanedUp, DisputeExpired};
use crate::instructions::dispute_helpers::{
    check_duplicate_arbiters, check_duplicate_workers, process_arbiter_vote_pair,
    process_worker_claim_pair, validate_remaining_accounts_structure,
};
use crate::instructions::lamport_transfer::{credit_lamports, debit_lamports, transfer_lamports};
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_account,
};
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, ProtocolConfig, Task, TaskClaim, TaskEscrow,
    TaskStatus,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

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
        mut,
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
        constraint = worker_claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub worker_claim: Option<Box<Account<'info, TaskClaim>>>,

    /// Worker's AgentRegistration PDA (must be dispute defendant).
    #[account(mut)]
    pub worker: Option<Box<Account<'info, AgentRegistration>>>,

    /// CHECK: Worker's authority wallet for receiving payment (fix #418)
    /// Required when worker should receive funds on expiration
    #[account(mut)]
    pub worker_authority: Option<UncheckedAccount<'info>>,

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

    /// SPL token mint (optional, must match task.reward_mint)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,
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
    //
    // Grace period: expire_dispute requires voting_deadline + 2 minutes, giving
    // resolve_dispute priority at the boundary. This prevents front-running attacks
    // where an attacker calls expire_dispute at exactly voting_deadline to get a
    // more favorable fund distribution than resolve_dispute would provide.
    const VOTING_DEADLINE_GRACE: i64 = 120;
    require!(
        clock.unix_timestamp > dispute.expires_at
            || clock.unix_timestamp
                >= dispute
                    .voting_deadline
                    .saturating_add(VOTING_DEADLINE_GRACE),
        CoordinationError::DisputeNotExpired
    );

    // Validate and bind defendant worker accounts (fix #842)
    validate_worker_accounts(
        dispute.as_ref(),
        &ctx.accounts.worker,
        &ctx.accounts.worker_claim,
        &ctx.accounts.worker_authority,
        &task.key(),
    )?;

    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Track distribution for event emission (fix #418)
    let mut creator_amount: u64 = 0;
    let mut worker_amount: u64 = 0;

    // Fair refund distribution based on context (fix #418)
    let is_token_task = task.reward_mint.is_some();
    let task_key = task.key();
    let worker_completed = ctx
        .accounts
        .worker_claim
        .as_ref()
        .ok_or(CoordinationError::WorkerClaimRequired)?
        .is_completed;
    let no_votes = dispute.total_voters == 0;

    if remaining_funds > 0 {
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
            let token_program = ctx.accounts.token_program.as_ref().unwrap();
            let task_key_bytes = task_key.to_bytes();
            let bump_slice = [escrow.bump];
            let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];

            let (ca, wa) = distribute_expired_tokens(
                token_escrow,
                &escrow.to_account_info(),
                ctx.accounts
                    .creator_token_account
                    .as_ref()
                    .map(|a| a.to_account_info())
                    .as_ref(),
                ctx.accounts
                    .worker_token_account_ata
                    .as_ref()
                    .map(|a| a.to_account_info())
                    .as_ref(),
                remaining_funds,
                worker_completed,
                no_votes,
                escrow_seeds,
                token_program,
            )?;
            creator_amount = ca;
            worker_amount = wa;

            // Close token escrow ATA
            close_token_escrow(
                token_escrow,
                &ctx.accounts.creator.to_account_info(),
                &escrow.to_account_info(),
                escrow_seeds,
                token_program,
            )?;
        } else {
            let (ca, wa) = distribute_expired_funds(
                &escrow.to_account_info(),
                &ctx.accounts.creator.to_account_info(),
                &ctx.accounts
                    .worker_authority
                    .as_ref()
                    .expect("worker authority validated above")
                    .to_account_info(),
                remaining_funds,
                worker_completed,
                no_votes,
            )?;
            creator_amount = ca;
            worker_amount = wa;
        }
    }

    // Decrement defendant counters deterministically (fix #544, #842)
    let worker = ctx
        .accounts
        .worker
        .as_mut()
        .expect("worker account validated above");
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.disputes_as_defendant = worker.disputes_as_defendant.saturating_sub(1);
    let defendant_worker_key = worker.key();

    // Decrement active_dispute_votes for each arbiter who voted (fix #328)
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

    // Emit event for arbiter vote cleanup (fix #572)
    emit!(ArbiterVotesCleanedUp {
        dispute_id: dispute.dispute_id,
        arbiter_count: dispute.total_voters,
    });

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

    // Process additional worker (claim, worker) pairs to decrement active_tasks (fix #333)
    for i in (arbiter_accounts..ctx.remaining_accounts.len()).step_by(2) {
        process_worker_claim_pair(
            &ctx.remaining_accounts[i],
            &ctx.remaining_accounts[i + 1],
            &task.key(),
        )?;
    }

    task.status = TaskStatus::Cancelled;
    task.current_workers = 0;
    dispute.status = DisputeStatus::Expired;
    dispute.resolved_at = clock.unix_timestamp;
    escrow.is_closed = true;

    // Close defendant claim account and return rent to worker authority.
    let claim = ctx
        .accounts
        .worker_claim
        .as_ref()
        .expect("worker claim validated above");
    let worker_authority = ctx
        .accounts
        .worker_authority
        .as_ref()
        .expect("worker authority validated above");
    claim.close(worker_authority.to_account_info())?;

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

    require!(
        worker.key() == dispute.defendant,
        CoordinationError::WorkerNotInDispute
    );
    require!(
        worker.key() == worker_claim.worker,
        CoordinationError::UnauthorizedAgent
    );
    require!(
        worker_claim.task == *task_key,
        CoordinationError::NotClaimed
    );
    require!(
        worker_authority.key() == worker.authority,
        CoordinationError::UnauthorizedAgent
    );

    Ok(())
}

/// Distributes remaining escrow funds on dispute expiration based on context (fix #418).
///
/// - Worker completed + no votes: Worker gets 100% (did work, dispute not properly engaged)
/// - No completion + no votes: 50/50 split (neither party engaged arbiters)
/// - Some votes but insufficient quorum: Creator gets refund (dispute was contested)
///
/// Returns (creator_amount, worker_amount) for event emission.
fn distribute_expired_funds<'a>(
    escrow_info: &AccountInfo<'a>,
    creator_info: &AccountInfo<'a>,
    worker_authority_info: &AccountInfo<'a>,
    remaining_funds: u64,
    worker_completed: bool,
    no_votes: bool,
) -> Result<(u64, u64)> {
    let mut creator_amount: u64 = 0;
    let mut worker_amount: u64 = 0;

    if no_votes && worker_completed {
        worker_amount = remaining_funds;
        transfer_lamports(escrow_info, worker_authority_info, remaining_funds)?;
    } else if no_votes {
        let worker_share = remaining_funds
            .checked_div(2)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let creator_share = remaining_funds
            .checked_sub(worker_share)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        creator_amount = creator_share;
        worker_amount = worker_share;

        debit_lamports(escrow_info, remaining_funds)?;
        credit_lamports(creator_info, creator_share)?;
        credit_lamports(worker_authority_info, worker_share)?;
    } else {
        creator_amount = remaining_funds;
        transfer_lamports(escrow_info, creator_info, remaining_funds)?;
    }

    Ok((creator_amount, worker_amount))
}

/// Token variant of distribute_expired_funds for SPL token tasks.
/// Same logic but uses token CPI transfers instead of lamport transfers.
///
/// Returns (creator_amount, worker_amount) for event emission.
fn distribute_expired_tokens<'a>(
    token_escrow: &Account<'a, TokenAccount>,
    escrow_authority: &AccountInfo<'a>,
    creator_token_account: Option<&AccountInfo<'a>>,
    worker_token_account: Option<&AccountInfo<'a>>,
    remaining_funds: u64,
    worker_completed: bool,
    no_votes: bool,
    escrow_seeds: &[&[u8]],
    token_program: &Program<'a, Token>,
) -> Result<(u64, u64)> {
    let mut creator_amount: u64 = 0;
    let mut worker_amount: u64 = 0;

    if no_votes && worker_completed {
        let worker_ta = worker_token_account.ok_or(CoordinationError::MissingTokenAccounts)?;
        worker_amount = remaining_funds;
        transfer_tokens_from_escrow(
            token_escrow,
            worker_ta,
            escrow_authority,
            remaining_funds,
            escrow_seeds,
            token_program,
        )?;
    } else if no_votes {
        let creator_ta = creator_token_account.ok_or(CoordinationError::MissingTokenAccounts)?;
        let worker_ta = worker_token_account.ok_or(CoordinationError::MissingTokenAccounts)?;
        let worker_share = remaining_funds
            .checked_div(2)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let creator_share = remaining_funds
            .checked_sub(worker_share)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        creator_amount = creator_share;
        worker_amount = worker_share;

        transfer_tokens_from_escrow(
            token_escrow,
            creator_ta,
            escrow_authority,
            creator_share,
            escrow_seeds,
            token_program,
        )?;
        transfer_tokens_from_escrow(
            token_escrow,
            worker_ta,
            escrow_authority,
            worker_share,
            escrow_seeds,
            token_program,
        )?;
    } else {
        let creator_ta = creator_token_account.ok_or(CoordinationError::MissingTokenAccounts)?;
        creator_amount = remaining_funds;
        transfer_tokens_from_escrow(
            token_escrow,
            creator_ta,
            escrow_authority,
            remaining_funds,
            escrow_seeds,
            token_program,
        )?;
    }

    Ok((creator_amount, worker_amount))
}
