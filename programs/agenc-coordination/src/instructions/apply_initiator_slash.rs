//! Apply slashing to a dispute initiator after their dispute is rejected

use crate::errors::CoordinationError;
use crate::instructions::constants::PERCENT_BASE;
use crate::state::{AgentRegistration, Dispute, DisputeStatus, ProtocolConfig, Task};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ApplyInitiatorSlash<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Account<'info, Dispute>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.key() == dispute.task @ CoordinationError::TaskNotFound
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        seeds = [b"agent", initiator_agent.agent_id.as_ref()],
        bump = initiator_agent.bump
    )]
    pub initiator_agent: Account<'info, AgentRegistration>,

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

pub fn handler(ctx: Context<ApplyInitiatorSlash>) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let initiator_agent = &mut ctx.accounts.initiator_agent;
    let config = &ctx.accounts.protocol_config;

    check_version_compatible(config)?;

    require!(
        dispute.status == DisputeStatus::Resolved,
        CoordinationError::DisputeNotResolved
    );
    require!(
        !dispute.initiator_slash_applied,
        CoordinationError::SlashAlreadyApplied
    );
    require!(
        initiator_agent.key() == dispute.initiator,
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

    // Dispute is rejected if approval percentage is below threshold
    let approved = approval_pct >= config.dispute_threshold as u64;

    // Only slash the initiator if the dispute was NOT approved (initiator lost)
    require!(!approved, CoordinationError::InvalidInput);
    require!(
        initiator_agent.stake > 0,
        CoordinationError::InsufficientStake
    );

    let slash_amount = initiator_agent
        .stake
        .checked_mul(config.slash_percentage as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    if slash_amount > 0 {
        initiator_agent.stake = initiator_agent
            .stake
            .checked_sub(slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;

        // Fix #374: Actually transfer lamports to treasury
        let initiator_agent_info = ctx.accounts.initiator_agent.to_account_info();
        let treasury_info = ctx.accounts.treasury.to_account_info();

        **initiator_agent_info.try_borrow_mut_lamports()? = initiator_agent_info
            .lamports()
            .checked_sub(slash_amount)
            .ok_or(CoordinationError::InsufficientFunds)?;

        **treasury_info.try_borrow_mut_lamports()? = treasury_info
            .lamports()
            .checked_add(slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    dispute.initiator_slash_applied = true;

    Ok(())
}
