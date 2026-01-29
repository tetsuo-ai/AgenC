//! Vote on a dispute resolution

use crate::errors::CoordinationError;
use crate::events::DisputeVoteCast;
use crate::state::{
    capability, AgentRegistration, AgentStatus, AuthorityDisputeVote, Dispute, DisputeStatus,
    DisputeVote, ProtocolConfig, Task, TaskClaim,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct VoteDispute<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump,
        has_one = task @ CoordinationError::TaskNotFound
    )]
    pub dispute: Account<'info, Dispute>,

    /// Task account for arbiter party validation (fix #461)
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    /// Optional: Worker's claim on the task (for arbiter party validation, fix #461)
    /// If provided, validates arbiter is not the worker
    #[account(
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
    )]
    pub worker_claim: Option<Account<'info, TaskClaim>>,

    #[account(
        init,
        payer = authority,
        space = DisputeVote::SIZE,
        seeds = [b"vote", dispute.key().as_ref(), arbiter.key().as_ref()],
        bump
    )]
    pub vote: Account<'info, DisputeVote>,

    /// Authority-level vote tracking to prevent Sybil attacks (fix #101)
    /// One authority can only vote once per dispute, regardless of how many agents they control
    #[account(
        init,
        payer = authority,
        space = AuthorityDisputeVote::SIZE,
        seeds = [b"authority_vote", dispute.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub authority_vote: Account<'info, AuthorityDisputeVote>,

    #[account(
        mut,
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
    let arbiter = &mut ctx.accounts.arbiter;
    let task = &ctx.accounts.task;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;

    // Verify arbiter is not a dispute participant (fix #391, #461)
    // Check 1: Arbiter cannot be the dispute initiator
    require!(
        arbiter.key() != dispute.initiator,
        CoordinationError::ArbiterIsDisputeParticipant
    );

    // Check 2: Arbiter cannot be the task creator (fix #461)
    require!(
        arbiter.authority != task.creator,
        CoordinationError::ArbiterIsDisputeParticipant
    );

    // Check 3: Arbiter cannot be the worker if worker_claim provided (fix #461)
    if let Some(ref worker_claim) = ctx.accounts.worker_claim {
        require!(
            arbiter.key() != worker_claim.worker,
            CoordinationError::ArbiterIsDisputeParticipant
        );
    }

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
    vote.stake_at_vote = arbiter.stake;
    vote.bump = ctx.bumps.vote;

    // Record authority-level vote (prevents Sybil attacks - fix #101)
    // The `init` constraint on authority_vote already prevents duplicate votes per authority
    let authority_vote_account = &mut ctx.accounts.authority_vote;
    authority_vote_account.dispute = dispute.key();
    authority_vote_account.authority = ctx.accounts.authority.key();
    authority_vote_account.voting_agent = arbiter.key();
    authority_vote_account.voted_at = clock.unix_timestamp;
    authority_vote_account.bump = ctx.bumps.authority_vote;

    // Update dispute vote counts
    if approve {
        dispute.votes_for = dispute
            .votes_for
            .checked_add(arbiter.stake)
            .ok_or(CoordinationError::VoteOverflow)?;
    } else {
        dispute.votes_against = dispute
            .votes_against
            .checked_add(arbiter.stake)
            .ok_or(CoordinationError::VoteOverflow)?;
    }
    dispute.total_voters = dispute
        .total_voters
        .checked_add(1)
        .ok_or(CoordinationError::VoteOverflow)?;

    arbiter.active_dispute_votes = arbiter
        .active_dispute_votes
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    arbiter.last_vote_timestamp = clock.unix_timestamp;
    arbiter.last_active = clock.unix_timestamp;

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
