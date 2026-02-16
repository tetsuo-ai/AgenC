//! Vote on a governance proposal

use crate::errors::CoordinationError;
use crate::events::GovernanceVoteCast;
use crate::state::{
    AgentRegistration, AgentStatus, GovernanceVote, Proposal, ProposalStatus, ProtocolConfig,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct VoteProposal<'info> {
    #[account(
        mut,
        seeds = [b"proposal", proposal.proposer.as_ref(), proposal.nonce.to_le_bytes().as_ref()],
        bump = proposal.bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        init,
        payer = authority,
        space = GovernanceVote::SIZE,
        seeds = [b"governance_vote", proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote: Account<'info, GovernanceVote>,

    #[account(
        seeds = [b"agent", voter.agent_id.as_ref()],
        bump = voter.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub voter: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<VoteProposal>, approve: bool) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;
    let vote = &mut ctx.accounts.vote;
    let voter = &ctx.accounts.voter;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;

    // Verify proposal is active
    require!(
        proposal.status == ProposalStatus::Active,
        CoordinationError::ProposalNotActive
    );

    // Verify voting period hasn't ended
    require!(
        clock.unix_timestamp < proposal.voting_deadline,
        CoordinationError::ProposalVotingEnded
    );

    // Verify voter is active
    require!(
        voter.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    // Compute vote weight: same formula as vote_dispute.rs
    // Cap at 10x min_arbiter_stake to limit plutocratic influence
    let max_vote_weight = config.min_arbiter_stake.saturating_mul(10);
    let stake_weight = voter.stake.min(max_vote_weight);
    let vote_weight = (stake_weight as u128)
        .checked_mul(voter.reputation as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(crate::instructions::constants::MAX_REPUTATION as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)? as u64;
    // Ensure minimum weight of 1 if voter has any stake
    let vote_weight = if stake_weight > 0 {
        vote_weight.max(1)
    } else {
        0
    };

    // Record vote
    vote.proposal = proposal.key();
    vote.voter = voter.key();
    vote.approved = approve;
    vote.voted_at = clock.unix_timestamp;
    vote.vote_weight = vote_weight;
    vote.bump = ctx.bumps.vote;
    vote._reserved = [0u8; 8];

    // Update proposal vote counts
    if approve {
        proposal.votes_for = proposal
            .votes_for
            .checked_add(vote_weight)
            .ok_or(CoordinationError::VoteOverflow)?;
    } else {
        proposal.votes_against = proposal
            .votes_against
            .checked_add(vote_weight)
            .ok_or(CoordinationError::VoteOverflow)?;
    }
    proposal.total_voters = proposal
        .total_voters
        .checked_add(1)
        .ok_or(CoordinationError::VoteOverflow)?;

    emit!(GovernanceVoteCast {
        proposal: proposal.key(),
        voter: voter.key(),
        approved: approve,
        vote_weight,
        votes_for: proposal.votes_for,
        votes_against: proposal.votes_against,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
