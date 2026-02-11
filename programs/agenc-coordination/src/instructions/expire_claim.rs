//! Expires a stale claim after its deadline passes.
//!
//! # Grace Period Protection (Issue #421)
//! To prevent griefing attacks where malicious actors race workers to expire
//! their claims exactly at timeout, a grace period is enforced:
//! - During the grace period (60 seconds after expiry), only the worker authority
//!   can call expire_claim on their own claim
//! - After the grace period, anyone can call expire_claim for cleanup
//!
//! This protects workers from MEV attacks and transaction reordering while
//! still allowing permissionless cleanup of truly abandoned claims.
//!
//! # Cleanup Reward
//! Callers receive a small reward (0.000001 SOL) from the task escrow
//! to incentivize timely cleanup of expired claims.

use crate::errors::CoordinationError;
use crate::state::{AgentRegistration, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// Small reward for calling expire_claim (0.000001 SOL)
/// Incentivizes third-party cleanup services
const CLEANUP_REWARD: u64 = 1000;

/// Grace period in seconds after claim expiry during which only the worker
/// authority can expire the claim. This prevents griefing attacks where
/// malicious actors race workers to expire their claims. (Issue #421)
const GRACE_PERIOD: i64 = 60;

#[derive(Accounts)]
pub struct ExpireClaim<'info> {
    /// Caller who triggers the expiration - receives cleanup reward
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump,
        constraint = escrow.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub claim: Account<'info, TaskClaim>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump
    )]
    pub worker: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Receives rent from closed claim account - validated to be worker authority
    #[account(
        mut,
        constraint = rent_recipient.key() == worker.authority @ CoordinationError::InvalidRentRecipient
    )]
    pub rent_recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Expires a stale claim after its deadline passes.
///
/// # Permissionless Design
/// This instruction can be called by anyone. This is intentional:
/// - Prevents claims from blocking task slots indefinitely
/// - Allows third-party cleanup services
/// - No economic risk since only valid expirations succeed
///
/// # Cleanup Reward
/// Callers receive a small reward from the task escrow to incentivize
/// timely cleanup of expired claims.
pub fn handler(ctx: Context<ExpireClaim>) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;

    let task = &mut ctx.accounts.task;
    let worker = &mut ctx.accounts.worker;
    let escrow = &mut ctx.accounts.escrow;
    let claim = &ctx.accounts.claim;
    let clock = Clock::get()?;

    // Can only expire incomplete claims
    require!(
        !claim.is_completed,
        CoordinationError::ClaimAlreadyCompleted
    );

    // Claims with expires_at = 0 are invalid (shouldn't exist)
    require!(
        claim.expires_at > 0,
        CoordinationError::InvalidExpiration
    );

    // Check claim has expired
    require!(
        clock.unix_timestamp > claim.expires_at,
        CoordinationError::ClaimNotExpired
    );

    // Grace period protection (Issue #421):
    // During the grace period after expiry, only the worker authority can expire
    // their own claim. This prevents griefing attacks where malicious actors race
    // workers to expire their claims exactly at timeout.
    let grace_period_ended = clock.unix_timestamp > claim.expires_at.saturating_add(GRACE_PERIOD);
    let is_worker_authority = ctx.accounts.caller.key() == worker.authority;

    require!(
        grace_period_ended || is_worker_authority,
        CoordinationError::GracePeriodNotPassed
    );

    // Transfer cleanup reward from escrow to caller (fix #531)
    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let reward = CLEANUP_REWARD.min(remaining_funds);
    if reward > 0 {
        let escrow_info = escrow.to_account_info();
        **escrow_info.try_borrow_mut_lamports()? = escrow_info
            .lamports()
            .checked_sub(reward)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let caller_info = ctx.accounts.caller.to_account_info();
        **caller_info.try_borrow_mut_lamports()? = caller_info
            .lamports()
            .checked_add(reward)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        escrow.distributed = escrow
            .distributed
            .checked_add(reward)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    // Decrement task worker count
    task.current_workers = task
        .current_workers
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Reopen task if no workers left AND task is still in progress
    // (Don't reopen cancelled/completed/disputed tasks - prevents zombie task attack)
    if task.current_workers == 0 && task.status == TaskStatus::InProgress {
        task.status = TaskStatus::Open;
    }

    // Decrement worker active tasks
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    Ok(())
}
