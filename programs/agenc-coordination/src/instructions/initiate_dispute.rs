//! Initiate a dispute for conflict resolution

use anchor_lang::prelude::*;
use crate::state::{Dispute, DisputeStatus, ResolutionType, Task, TaskStatus, AgentRegistration, AgentStatus};
use crate::errors::CoordinationError;
use crate::events::DisputeInitiated;

/// Default voting period: 24 hours
const VOTING_PERIOD: i64 = 24 * 60 * 60;

#[derive(Accounts)]
#[instruction(dispute_id: [u8; 32], task_id: [u8; 32])]
pub struct InitiateDispute<'info> {
    #[account(
        init,
        payer = authority,
        space = Dispute::SIZE,
        seeds = [b"dispute", dispute_id.as_ref()],
        bump
    )]
    pub dispute: Account<'info, Dispute>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.task_id == task_id @ CoordinationError::TaskNotFound
    )]
    pub task: Account<'info, Task>,

    #[account(
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitiateDispute>,
    dispute_id: [u8; 32],
    task_id: [u8; 32],
    evidence_hash: [u8; 32],
    resolution_type: u8,
) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let agent = &ctx.accounts.agent;
    let clock = Clock::get()?;

    // Verify agent is active
    require!(
        agent.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    // Verify task is in a disputable state
    require!(
        task.status == TaskStatus::InProgress || task.status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotInProgress
    );

    // Validate resolution type
    require!(resolution_type <= 2, CoordinationError::InvalidInput);

    // Initialize dispute
    dispute.dispute_id = dispute_id;
    dispute.task = task.key();
    dispute.initiator = agent.key();
    dispute.evidence_hash = evidence_hash;
    dispute.resolution_type = match resolution_type {
        0 => ResolutionType::Refund,
        1 => ResolutionType::Complete,
        2 => ResolutionType::Split,
        _ => return Err(CoordinationError::InvalidInput.into()),
    };
    dispute.status = DisputeStatus::Active;
    dispute.created_at = clock.unix_timestamp;
    dispute.resolved_at = 0;
    dispute.votes_for = 0;
    dispute.votes_against = 0;
    dispute.total_voters = 0; // Will be set during voting
    dispute.voting_deadline = clock.unix_timestamp
        .checked_add(VOTING_PERIOD)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    dispute.bump = ctx.bumps.dispute;

    // Mark task as disputed
    task.status = TaskStatus::Disputed;

    emit!(DisputeInitiated {
        dispute_id,
        task_id,
        initiator: agent.key(),
        resolution_type,
        voting_deadline: dispute.voting_deadline,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
