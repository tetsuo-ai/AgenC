//! Apply slashing after dispute resolution.
//!
//! # Permissionless Design
//! Can be called by anyone after dispute resolves unfavorably.
//! This is intentional - ensures slashing cannot be avoided.
//!
//! # Time Window (fix #414)
//! Slashing must occur within 7 days of dispute resolution.
//! After this window, slashing can no longer be applied.

use crate::errors::CoordinationError;
use crate::instructions::slash_helpers::{
    apply_reputation_penalty, calculate_approval_percentage, calculate_slash_amount,
    transfer_slash_to_treasury, validate_slash_window,
};
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_account,
};
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, ProtocolConfig, ResolutionType, Task, TaskClaim,
    TaskEscrow,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct ApplyDisputeSlash<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Account<'info, Dispute>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = dispute.task == task.key() @ CoordinationError::TaskNotFound
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
        constraint = worker_claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub worker_claim: Account<'info, TaskClaim>,

    #[account(
        mut,
        seeds = [b"agent", worker_agent.agent_id.as_ref()],
        bump = worker_agent.bump
    )]
    pub worker_agent: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Treasury account to receive slashed lamports
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    // === Optional SPL Token slash accounts (token-denominated tasks only) ===
    /// Escrow PDA for the disputed task (kept open until slash for token disputes)
    #[account(mut)]
    pub escrow: Option<Box<Account<'info, TaskEscrow>>>,

    /// Token escrow ATA holding deferred slash amount
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// Treasury token ATA receiving slashed tokens
    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    /// SPL mint for task rewards (must match task.reward_mint)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// SPL Token program
    pub token_program: Option<Program<'info, Token>>,
}

pub fn handler(ctx: Context<ApplyDisputeSlash>) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let worker_agent = &mut ctx.accounts.worker_agent;
    let config = &ctx.accounts.protocol_config;

    check_version_compatible(config)?;

    // Verify the worker being slashed is the actual defendant (fix #827)
    // Prevents slashing wrong worker on collaborative tasks with multiple claimants
    require!(
        worker_agent.key() == dispute.defendant,
        CoordinationError::WorkerNotInDispute
    );

    // Belt-and-suspenders: also verify worker has a valid claim on the disputed task
    require!(
        ctx.accounts.worker_claim.task == dispute.task
            && ctx.accounts.worker_claim.worker == worker_agent.key(),
        CoordinationError::WorkerNotInDispute
    );

    require!(
        dispute.status == DisputeStatus::Resolved,
        CoordinationError::DisputeNotResolved
    );
    require!(
        !dispute.slash_applied,
        CoordinationError::SlashAlreadyApplied
    );

    // Check slash window hasn't expired (fix #414)
    let clock = Clock::get()?;
    validate_slash_window(dispute.resolved_at, &clock)?;

    let (_total_votes, approval_pct) =
        calculate_approval_percentage(dispute.votes_for, dispute.votes_against)?;

    // Determine if the dispute was approved (votes_for >= threshold percentage)
    let approved = approval_pct >= config.dispute_threshold as u64;

    // Determine if the worker lost the dispute and should be slashed:
    // - If dispute is APPROVED:
    //   - Refund: Worker failed, creator gets money back -> worker lost (slash)
    //   - Split: Partial failure, funds split -> worker lost (slash)
    //   - Complete: Worker vindicated, gets paid -> worker won (no slash)
    // - If dispute is REJECTED (not approved):
    //   - Arbiters ruled in worker's favor -> worker won (no slash)
    //
    // Fix for issue #136: Previously, rejected disputes incorrectly set worker_lost=true,
    // causing innocent workers to be slashed even when arbiters ruled in their favor.
    let worker_lost = if approved {
        // Dispute approved: slash worker unless resolution favors them (Complete)
        dispute.resolution_type != ResolutionType::Complete
    } else {
        // Dispute rejected: worker was vindicated, do NOT slash
        false
    };

    require!(worker_lost, CoordinationError::InvalidInput);
    require!(worker_agent.stake > 0, CoordinationError::InsufficientStake);

    // Calculate slash from stake snapshot and cap by current stake (fix #836).
    let slash_amount = calculate_slash_amount(
        dispute.worker_stake_at_dispute,
        worker_agent.stake,
        config.slash_percentage,
    )?;

    require!(slash_amount > 0, CoordinationError::InvalidSlashAmount);

    // Apply reputation penalty for losing the dispute (before lamport transfer to satisfy borrow checker)
    apply_reputation_penalty(worker_agent, &clock)?;

    if slash_amount > 0 {
        worker_agent.stake = worker_agent
            .stake
            .checked_sub(slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    // Token-denominated disputes that slash a losing worker must settle reserved
    // tokens during this instruction.
    let token_task_requires_settlement =
        ctx.accounts.task.reward_mint.is_some() && worker_lost && slash_amount > 0;

    // If any token accounts are provided, require a complete set.
    let token_accounts_provided = ctx.accounts.escrow.is_some()
        || ctx.accounts.token_escrow_ata.is_some()
        || ctx.accounts.treasury_token_account.is_some()
        || ctx.accounts.reward_mint.is_some()
        || ctx.accounts.token_program.is_some();

    if token_accounts_provided || token_task_requires_settlement {
        require!(
            ctx.accounts.escrow.is_some()
                && ctx.accounts.token_escrow_ata.is_some()
                && ctx.accounts.treasury_token_account.is_some()
                && ctx.accounts.reward_mint.is_some()
                && ctx.accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let escrow = ctx.accounts.escrow.as_mut().unwrap();
        let token_escrow = ctx.accounts.token_escrow_ata.as_ref().unwrap();
        let treasury_ta = ctx.accounts.treasury_token_account.as_ref().unwrap();
        let mint = ctx.accounts.reward_mint.as_ref().unwrap();
        let token_program = ctx.accounts.token_program.as_ref().unwrap();

        require!(
            escrow.task == ctx.accounts.task.key() && ctx.accounts.task.escrow == escrow.key(),
            CoordinationError::TaskNotFound
        );
        require!(
            mint.key() == ctx.accounts.task.reward_mint.unwrap(),
            CoordinationError::InvalidTokenMint
        );
        validate_token_account(token_escrow, &mint.key(), &escrow.key())?;
        validate_token_account(
            treasury_ta,
            &mint.key(),
            &ctx.accounts.protocol_config.treasury,
        )?;

        let task_key_bytes = ctx.accounts.task.key().to_bytes();
        let bump_slice = [escrow.bump];
        let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];

        let token_slash_amount = slash_amount.min(token_escrow.amount);
        if token_slash_amount > 0 {
            transfer_tokens_from_escrow(
                token_escrow,
                &treasury_ta.to_account_info(),
                &escrow.to_account_info(),
                token_slash_amount,
                escrow_seeds,
                token_program,
            )?;
        }

        close_token_escrow(
            token_escrow,
            &ctx.accounts.treasury.to_account_info(),
            &escrow.to_account_info(),
            escrow_seeds,
            token_program,
        )?;

        escrow.is_closed = true;
        escrow.close(ctx.accounts.treasury.to_account_info())?;
    }

    // Perform lamport transfer after all CPIs. Direct lamport mutations are
    // checked against CPI boundaries by the runtime.
    if slash_amount > 0 {
        let worker_agent_info = worker_agent.to_account_info();
        transfer_slash_to_treasury(
            &worker_agent_info,
            &ctx.accounts.treasury.to_account_info(),
            slash_amount,
        )?;
    }

    worker_agent.disputes_as_defendant = worker_agent.disputes_as_defendant.saturating_sub(1);
    worker_agent.last_active = clock.unix_timestamp;
    dispute.slash_applied = true;

    Ok(())
}
