//! Vote on a dispute resolution

use anchor_lang::prelude::*;
use crate::state::{Dispute, DisputeStatus, DisputeVote, AgentRegistration, AgentStatus, ProtocolConfig, capability};
use crate::errors::CoordinationError;
use crate::events::DisputeVoteCast;

#[derive(Accounts)]
pub struct VoteDispute<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Account<'info, Dispute>,

    #[account(
        init,
        payer = authority,
        space = DisputeVote::SIZE,
        seeds = [b"vote", dispute.key().as_ref(), arbiter.key().as_ref()],
        bump
    )]
    pub vote: Account<'info, DisputeVote>,

    #[account(
        seeds = [b"agent", arbiter.agent_id.as_ref()],
        bump = arbiter.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub arbiter: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<VoteDispute>, approve: bool) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let vote = &mut ctx.accounts.vote;
    let arbiter = &ctx.accounts.arbiter;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    // Verify dispute is active
    require!(
        dispute.status == DisputeStatus::Active,
        CoordinationError::DisputeNotActive
    );

    // Verify voting period hasn't ended
    require!(
        clock.unix_timestamp < dispute.voting_deadline,
        CoordinationError::VotingEnded
    );

    // Verify arbiter is active and has arbiter capability
    require!(
        arbiter.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );
    require!(
        (arbiter.capabilities & capability::ARBITER) != 0,
        CoordinationError::NotArbiter
    );

    // Verify arbiter has sufficient stake
    require!(
        arbiter.stake >= config.min_arbiter_stake,
        CoordinationError::InsufficientStake
    );

    // Record vote
    vote.dispute = dispute.key();
    vote.voter = arbiter.key();
    vote.approved = approve;
    vote.voted_at = clock.unix_timestamp;
    vote.bump = ctx.bumps.vote;

    // Update dispute vote counts
    if approve {
        dispute.votes_for = dispute.votes_for.checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    } else {
        dispute.votes_against = dispute.votes_against.checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }
    dispute.total_voters = dispute.total_voters.checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(DisputeVoteCast {
        dispute_id: dispute.dispute_id,
        voter: arbiter.key(),
        approved: approve,
        votes_for: dispute.votes_for,
        votes_against: dispute.votes_against,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
