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
    pub dispute: Box<Account<'info, Dispute>>,

    /// Task account for arbiter party validation (fix #461)
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    /// Optional: Worker's claim on the task (for arbiter party validation, fix #461)
    /// If provided, validates arbiter is not the worker
    #[account(
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
    )]
    pub worker_claim: Option<Account<'info, TaskClaim>>,

    /// Optional: Defendant's agent registration (for authority-level participant check, fix #824)
    /// If provided, validates arbiter's authority is not the defendant worker's authority.
    /// Must match the dispute's defendant field.
    #[account(
        seeds = [b"agent", defendant_agent.agent_id.as_ref()],
        bump = defendant_agent.bump,
        constraint = defendant_agent.key() == dispute.defendant @ CoordinationError::WorkerNotInDispute
    )]
    pub defendant_agent: Option<Account<'info, AgentRegistration>>,

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
    pub arbiter: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

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

    // Verify arbiter is not a dispute participant (fix #391, #461, #824)
    validate_arbiter_not_participant(
        arbiter,
        dispute,
        task,
        &ctx.accounts.worker_claim,
        &ctx.accounts.defendant_agent,
    )?;

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

    // Verify arbiter has non-zero reputation to prevent sybil voting
    require!(
        arbiter.reputation > 0,
        CoordinationError::InsufficientReputation
    );

    // Cap vote weight to prevent stake-boost attacks (fix #445)
    // Max weight is 10x the minimum arbiter stake to limit plutocratic influence
    // while still rewarding larger stakes
    let max_vote_weight = config.min_arbiter_stake.saturating_mul(10);
    let stake_weight = arbiter.stake.min(max_vote_weight);
    // Apply reputation multiplier: rep/10000 scales weight 0-100%
    let vote_weight_u128 = (stake_weight as u128)
        .checked_mul(arbiter.reputation as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(crate::instructions::constants::MAX_REPUTATION as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let vote_weight =
        u64::try_from(vote_weight_u128).map_err(|_| CoordinationError::ArithmeticOverflow)?;
    // Ensure minimum weight of 1 if arbiter has any stake
    let vote_weight = if stake_weight > 0 {
        vote_weight.max(1)
    } else {
        0
    };

    // Record vote
    vote.dispute = dispute.key();
    vote.voter = arbiter.key();
    vote.approved = approve;
    vote.voted_at = clock.unix_timestamp;
    vote.stake_at_vote = vote_weight; // Store capped weight for resolution
    vote.bump = ctx.bumps.vote;

    // Record authority-level vote (prevents Sybil attacks - fix #101)
    // The `init` constraint on authority_vote already prevents duplicate votes per authority
    let authority_vote_account = &mut ctx.accounts.authority_vote;
    authority_vote_account.dispute = dispute.key();
    authority_vote_account.authority = ctx.accounts.authority.key();
    authority_vote_account.voting_agent = arbiter.key();
    authority_vote_account.voted_at = clock.unix_timestamp;
    authority_vote_account.bump = ctx.bumps.authority_vote;

    // Update dispute vote counts with capped weight
    if approve {
        dispute.votes_for = dispute
            .votes_for
            .checked_add(vote_weight)
            .ok_or(CoordinationError::VoteOverflow)?;
    } else {
        dispute.votes_against = dispute
            .votes_against
            .checked_add(vote_weight)
            .ok_or(CoordinationError::VoteOverflow)?;
    }
    dispute.total_voters = dispute
        .total_voters
        .checked_add(1)
        .ok_or(CoordinationError::VoteOverflow)?;

    // Note: If a vote account is closed externally, active_dispute_votes
    // will be inconsistent. Vote accounts should only be closed via
    // dispute resolution or expiration.
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

/// Validates that the arbiter is not a participant in the dispute (fix #391, #461, #824, #825).
///
/// An arbiter cannot be:
/// 1. The dispute initiator (by PDA or by authority wallet — fix #824)
/// 2. The task creator (by authority wallet)
/// 3. The defendant (the worker being disputed) — checked via dispute.defendant (fix #825)
/// 4. Any worker on the task (if worker_claim/defendant_agent provided, defense-in-depth)
fn validate_arbiter_not_participant(
    arbiter: &Account<AgentRegistration>,
    dispute: &Account<Dispute>,
    task: &Account<Task>,
    worker_claim: &Option<Account<TaskClaim>>,
    defendant_agent: &Option<Account<AgentRegistration>>,
) -> Result<()> {
    // Check 1: Arbiter cannot be the dispute initiator (fix #824)
    // Compare both PDA keys AND authority pubkeys to prevent same-wallet Sybil voting.
    // A single authority can register multiple agents with different PDAs, so PDA
    // comparison alone is insufficient.
    require!(
        arbiter.key() != dispute.initiator,
        CoordinationError::ArbiterIsDisputeParticipant
    );
    require!(
        arbiter.authority != dispute.initiator_authority,
        CoordinationError::ArbiterIsDisputeParticipant
    );

    // Check 2: Arbiter cannot be the task creator (fix #461)
    require!(
        arbiter.authority != task.creator,
        CoordinationError::ArbiterIsDisputeParticipant
    );

    // Check 3: Arbiter cannot be the defendant worker (fix #825)
    // This uses the dispute.defendant field (set at dispute initiation) so it
    // cannot be bypassed by omitting the optional worker_claim account.
    require!(
        arbiter.key() != dispute.defendant,
        CoordinationError::ArbiterIsDisputeParticipant
    );

    // Check 4: Defense-in-depth — if worker_claim is provided, also verify
    // arbiter is not the worker referenced by the claim (fix #461, #824)
    // Compare both PDA keys AND authority pubkeys via the defendant agent account.
    if let Some(ref worker_claim) = worker_claim {
        require!(
            arbiter.key() != worker_claim.worker,
            CoordinationError::ArbiterIsDisputeParticipant
        );
    }
    if let Some(ref defendant) = defendant_agent {
        require!(
            arbiter.authority != defendant.authority,
            CoordinationError::ArbiterIsDisputeParticipant
        );
    }

    Ok(())
}
