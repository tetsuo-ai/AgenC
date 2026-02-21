//! Cancel a task and refund the creator

use crate::errors::CoordinationError;
use crate::events::TaskCancelled;
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_account,
};
use crate::state::{AgentRegistration, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct CancelTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        has_one = creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        close = creator,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub system_program: Program<'info, System>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    /// Token escrow ATA holding reward tokens (optional)
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// Creator's token account to receive refund (optional)
    /// CHECK: Validated in handler
    #[account(mut)]
    pub creator_token_account: Option<UncheckedAccount<'info>>,

    /// SPL token mint (optional, must match task.reward_mint)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,
}

pub fn handler(ctx: Context<CancelTask>) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;

    let task = &mut ctx.accounts.task;
    let escrow = &mut ctx.accounts.escrow;
    let clock = Clock::get()?;

    // Validate status transition is allowed (fix #538)
    require!(
        task.status.can_transition_to(TaskStatus::Cancelled),
        CoordinationError::InvalidStatusTransition
    );

    // Can only cancel if:
    // 1. Task is open (no workers yet)
    // 2. Task has expired and no completions
    let can_cancel = match task.status {
        TaskStatus::Open => true,
        TaskStatus::InProgress => {
            // Can cancel if deadline passed and no completions
            task.deadline > 0 && clock.unix_timestamp > task.deadline && task.completions == 0
        }
        _ => false,
    };

    require!(can_cancel, CoordinationError::TaskCannotBeCancelled);

    // If task has workers, require accounts
    if task.current_workers > 0 {
        require!(
            !ctx.remaining_accounts.is_empty(),
            CoordinationError::WorkerAccountsRequired
        );
    }

    // Calculate refund (total minus any distributed)
    let refund_amount = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Transfer refund to creator
    let is_token_task = task.reward_mint.is_some();
    if is_token_task {
        // Token path: transfer tokens back to creator
        require!(
            ctx.accounts.token_escrow_ata.is_some()
                && ctx.accounts.creator_token_account.is_some()
                && ctx.accounts.reward_mint.is_some()
                && ctx.accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let token_escrow = ctx.accounts.token_escrow_ata.as_ref().unwrap();
        let creator_ta = ctx.accounts.creator_token_account.as_ref().unwrap();
        let mint = ctx.accounts.reward_mint.as_ref().unwrap();
        let token_program = ctx.accounts.token_program.as_ref().unwrap();

        require!(
            mint.key() == task.reward_mint.unwrap(),
            CoordinationError::InvalidTokenMint
        );
        validate_token_account(token_escrow, &mint.key(), &escrow.key())?;

        let task_key = task.key();
        let task_key_bytes = task_key.to_bytes();
        let bump_slice = [escrow.bump];
        let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];

        // Transfer remaining tokens back to creator
        transfer_tokens_from_escrow(
            token_escrow,
            &creator_ta.to_account_info(),
            &escrow.to_account_info(),
            refund_amount,
            escrow_seeds,
            token_program,
        )?;

        // NOTE: Token escrow ATA close is deferred until after worker processing
        // to ensure all claims are resolved before the ATA is closed.
    } else {
        // SOL path: existing lamport transfer (unchanged)
        transfer_lamports(
            &escrow.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            refund_amount,
        )?;
    }

    // Update task status
    task.status = TaskStatus::Cancelled;
    escrow.is_closed = true;

    emit!(TaskCancelled {
        task_id: task.task_id,
        creator: task.creator,
        refund_amount,
        timestamp: clock.unix_timestamp,
    });

    // After task cancellation, decrement active_tasks for all claimants
    // remaining_accounts should contain pairs of (claim, worker_agent)
    // Claims are closed to return rent to creator (fix #396)
    require!(
        ctx.remaining_accounts.len() % 2 == 0,
        CoordinationError::InvalidInput
    );
    let num_pairs = ctx.remaining_accounts.len() / 2;

    // SECURITY FIX #361: Validate ALL worker claims are provided BEFORE processing
    // Without this check, a malicious caller could pass only a subset of claims,
    // leaving some workers with permanently inflated active_tasks counters (DoS vector)
    require!(
        num_pairs == task.current_workers as usize,
        CoordinationError::IncompleteWorkerAccounts
    );

    for i in 0..num_pairs {
        let claim_info = &ctx.remaining_accounts[i * 2];
        let worker_info = &ctx.remaining_accounts[i * 2 + 1];

        // Validate claim belongs to this task
        require!(
            claim_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        require!(claim_info.is_writable, CoordinationError::InvalidInput);
        let claim_data = claim_info.try_borrow_data()?;
        let claim = TaskClaim::try_deserialize(&mut &claim_data[..])?;
        require!(claim.task == task.key(), CoordinationError::InvalidInput);
        drop(claim_data);

        // Decrement worker's active_tasks
        require!(
            worker_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        require!(worker_info.is_writable, CoordinationError::InvalidInput);
        require!(
            worker_info.key() == claim.worker,
            CoordinationError::InvalidInput
        );
        let mut worker_data = worker_info.try_borrow_mut_data()?;
        let mut worker = AgentRegistration::try_deserialize(&mut &worker_data[..])?;
        // Using saturating_sub intentionally - underflow returns 0 (safe counter decrement)
        worker.active_tasks = worker.active_tasks.saturating_sub(1);
        // Use AnchorSerialize::serialize (Borsh only) — see dispute_helpers.rs comment (fix #960).
        AnchorSerialize::serialize(&worker, &mut &mut worker_data[8..])
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;

        // Close claim account and return rent to creator (fix #396)
        let claim_lamports = claim_info.lamports();
        **claim_info.try_borrow_mut_lamports()? = 0;
        let creator_info = ctx.accounts.creator.to_account_info();
        **creator_info.try_borrow_mut_lamports()? = creator_info
            .lamports()
            .checked_add(claim_lamports)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        // Zero out data then write CLOSED_ACCOUNT_DISCRIMINATOR to prevent
        // init_if_needed from re-initializing the claim after cancellation.
        // Without this, claim_data is all zeros which matches a fresh account,
        // allowing a worker to re-claim via init_if_needed bypass.
        let mut claim_data = claim_info.try_borrow_mut_data()?;
        claim_data.fill(0);
        claim_data[..8].copy_from_slice(&[255u8; 8]);
    }

    // Close token escrow ATA AFTER all worker claims are processed
    if is_token_task {
        let token_escrow = ctx.accounts.token_escrow_ata.as_ref().unwrap();
        let token_program = ctx.accounts.token_program.as_ref().unwrap();
        let task_key = task.key();
        let task_key_bytes = task_key.to_bytes();
        let bump_slice = [escrow.bump];
        let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];
        close_token_escrow(
            token_escrow,
            &ctx.accounts.creator.to_account_info(),
            &escrow.to_account_info(),
            escrow_seeds,
            token_program,
        )?;
    }

    // Reset current_workers since all workers are removed on cancel
    task.current_workers = 0;

    Ok(())
}
