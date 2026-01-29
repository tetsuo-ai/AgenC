//! Apply slashing to a worker after losing a dispute

use crate::errors::CoordinationError;
use crate::instructions::constants::PERCENT_BASE;
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
    pub task: Account<'info, Task>,

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
    pub worker_agent: Account<'info, AgentRegistration>,

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

    require!(
        dispute.status == DisputeStatus::Resolved,
        CoordinationError::DisputeNotResolved
    );
    require!(
        !dispute.slash_applied,
        CoordinationError::SlashAlreadyApplied
    );
    require!(
        worker_agent.key() == ctx.accounts.worker_claim.worker,
        CoordinationError::UnauthorizedAgent
    );

    let total_votes = dispute
        .votes_for
        .checked_add(dispute.votes_against)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(total_votes > 0, CoordinationError::InsufficientVotes);

    let approval_pct = dispute
        .votes_for
        .checked_mul(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(total_votes)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

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

    let slash_amount = worker_agent
        .stake
        .checked_mul(config.slash_percentage as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    if slash_amount > 0 {
        worker_agent.stake = worker_agent
            .stake
            .checked_sub(slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;

        // Fix #374: Actually transfer lamports to treasury
        let worker_agent_info = ctx.accounts.worker_agent.to_account_info();
        let treasury_info = ctx.accounts.treasury.to_account_info();

        **worker_agent_info.try_borrow_mut_lamports()? = worker_agent_info
            .lamports()
            .checked_sub(slash_amount)
            .ok_or(CoordinationError::InsufficientFunds)?;

        **treasury_info.try_borrow_mut_lamports()? = treasury_info
            .lamports()
            .checked_add(slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    dispute.slash_applied = true;

    Ok(())
}
