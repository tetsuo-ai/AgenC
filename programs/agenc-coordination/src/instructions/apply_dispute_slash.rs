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
use crate::instructions::constants::PERCENT_BASE;
use crate::instructions::slash_helpers::{
    apply_reputation_penalty, calculate_approval_percentage, transfer_slash_to_treasury,
    validate_slash_window,
};
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, ProtocolConfig, ResolutionType, Task, TaskClaim,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

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

    // Calculate slash based on stake at dispute time, not current stake (fix #836)
    // This prevents workers from withdrawing stake after dispute to reduce slashing exposure
    let slash_amount_calculated = dispute
        .worker_stake_at_dispute
        .checked_mul(config.slash_percentage as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Cap slash at current stake to avoid underflow (can't slash more than what's staked)
    let slash_amount = slash_amount_calculated.min(worker_agent.stake);

    require!(
        slash_amount > 0,
        CoordinationError::InvalidSlashAmount
    );

    // Apply reputation penalty for losing the dispute (before lamport transfer to satisfy borrow checker)
    apply_reputation_penalty(worker_agent, &clock)?;

    if slash_amount > 0 {
        worker_agent.stake = worker_agent
            .stake
            .checked_sub(slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;

        // Fix #374: Actually transfer lamports to treasury
        transfer_slash_to_treasury(
            &ctx.accounts.worker_agent.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            slash_amount,
        )?;
    }

    dispute.slash_applied = true;

    Ok(())
}
