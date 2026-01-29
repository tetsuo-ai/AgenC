//! Initiate a dispute for conflict resolution

use crate::errors::CoordinationError;
use crate::events::{DisputeInitiated, RateLimitHit};
use crate::state::{
    AgentRegistration, AgentStatus, Dispute, DisputeStatus, ProtocolConfig, ResolutionType, Task,
    TaskClaim, TaskStatus,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// Default voting period: 24 hours
const VOTING_PERIOD: i64 = 24 * 60 * 60;

/// 24 hours in seconds for rate limit window
const WINDOW_24H: i64 = 24 * 60 * 60;

/// Maximum evidence string length
const MAX_EVIDENCE_LEN: usize = 256;

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
        mut,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Optional: Initiator's claim if they are a worker (not the creator)
    #[account(
        seeds = [b"claim", task.key().as_ref(), agent.key().as_ref()],
        bump,
    )]
    pub initiator_claim: Option<Account<'info, TaskClaim>>,

    /// Optional: Worker agent to be disputed (required when initiator is task creator)
    pub worker_agent: Option<Account<'info, AgentRegistration>>,

    /// Optional: Worker's claim (required when worker_agent is provided)
    pub worker_claim: Option<Account<'info, TaskClaim>>,

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
    evidence: String,
) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let agent = &mut ctx.accounts.agent;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;

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

    // Verify initiator is task participant (creator or has claim)
    // Compare task.creator (wallet) with authority (signer's wallet), not agent PDA
    let is_creator = task.creator == ctx.accounts.authority.key();
    let has_claim = ctx.accounts.initiator_claim.is_some();

    require!(
        is_creator || has_claim,
        CoordinationError::NotTaskParticipant
    );

    // If initiator has a claim, verify it's still valid for dispute
    if let Some(claim) = &ctx.accounts.initiator_claim {
        // Workers with completed claims cannot dispute - they already got paid
        require!(
            !claim.is_completed,
            CoordinationError::ClaimAlreadyCompleted
        );
        require!(
            claim.expires_at > clock.unix_timestamp,
            CoordinationError::ClaimExpired
        );
    }

    // Validate resolution type
    require!(resolution_type <= 2, CoordinationError::InvalidInput);

    // Validate evidence hash is not zero
    require!(
        evidence_hash != [0u8; 32],
        CoordinationError::InvalidEvidenceHash
    );

    require!(
        evidence.len() <= MAX_EVIDENCE_LEN,
        CoordinationError::EvidenceTooLong
    );

    // === Rate Limiting Checks ===

    // Check minimum stake requirement for dispute initiation (griefing resistance)
    if config.min_stake_for_dispute > 0 {
        require!(
            agent.stake >= config.min_stake_for_dispute,
            CoordinationError::InsufficientStakeForDispute
        );
    }

    // Check cooldown period
    if config.dispute_initiation_cooldown > 0 && agent.last_dispute_initiated > 0 {
        let elapsed = clock
            .unix_timestamp
            .saturating_sub(agent.last_dispute_initiated);
        if elapsed < config.dispute_initiation_cooldown {
            let remaining = config.dispute_initiation_cooldown.saturating_sub(elapsed);
            emit!(RateLimitHit {
                agent_id: agent.agent_id,
                action_type: 1, // dispute_initiation
                limit_type: 0,  // cooldown
                current_count: agent.dispute_count_24h,
                max_count: config.max_disputes_per_24h,
                cooldown_remaining: remaining,
                timestamp: clock.unix_timestamp,
            });
            return Err(CoordinationError::CooldownNotElapsed.into());
        }
    }

    // Check 24h window limit
    if config.max_disputes_per_24h > 0 {
        // Reset window if 24h has passed
        if clock
            .unix_timestamp
            .saturating_sub(agent.rate_limit_window_start)
            >= WINDOW_24H
        {
            agent.rate_limit_window_start = clock.unix_timestamp;
            agent.task_count_24h = 0;
            agent.dispute_count_24h = 0;
        }

        // Check if limit exceeded
        if agent.dispute_count_24h >= config.max_disputes_per_24h {
            emit!(RateLimitHit {
                agent_id: agent.agent_id,
                action_type: 1, // dispute_initiation
                limit_type: 1,  // 24h_window
                current_count: agent.dispute_count_24h,
                max_count: config.max_disputes_per_24h,
                cooldown_remaining: 0,
                timestamp: clock.unix_timestamp,
            });
            return Err(CoordinationError::RateLimitExceeded.into());
        }

        // Increment counter
        agent.dispute_count_24h = agent
            .dispute_count_24h
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    // Update rate limit tracking
    agent.last_dispute_initiated = clock.unix_timestamp;
    agent.last_active = clock.unix_timestamp;

    // === Determine Worker Stake to Snapshot (fix #550) ===
    // Snapshot the worker's stake at dispute initiation time to prevent
    // attackers from withdrawing stake before being slashed.
    let worker_stake = if has_claim {
        // Initiator is the worker - use their stake
        agent.stake
    } else {
        // Initiator is the creator - need worker_agent to identify the worker
        let worker = ctx
            .accounts
            .worker_agent
            .as_ref()
            .ok_or(CoordinationError::WorkerAgentRequired)?;
        let w_claim = ctx
            .accounts
            .worker_claim
            .as_ref()
            .ok_or(CoordinationError::WorkerClaimRequired)?;

        // Verify worker_claim is for this task and this worker
        require!(
            w_claim.task == task.key(),
            CoordinationError::TaskNotFound
        );
        require!(
            w_claim.worker == worker.key(),
            CoordinationError::UnauthorizedAgent
        );

        worker.stake
    };

    // === Initialize Dispute ===

    dispute.dispute_id = dispute_id;
    dispute.task = task.key();
    dispute.initiator = agent.key();
    dispute.initiator_authority = ctx.accounts.authority.key();
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
    dispute.voting_deadline = clock
        .unix_timestamp
        .checked_add(VOTING_PERIOD)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    dispute.expires_at = clock
        .unix_timestamp
        .checked_add(config.max_dispute_duration)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    dispute.slash_applied = false;
    dispute.initiator_slash_applied = false;
    dispute.worker_stake_at_dispute = worker_stake;
    dispute.bump = ctx.bumps.dispute;

    // Mark task as disputed
    task.status = TaskStatus::Disputed;

    // Increment disputes_as_defendant for workers being disputed (fix #544)
    // remaining_accounts should contain (claim, worker) pairs for defendants
    // This prevents workers from deregistering to escape potential slashing
    require!(
        ctx.remaining_accounts.len() % 2 == 0,
        CoordinationError::InvalidInput
    );

    for i in (0..ctx.remaining_accounts.len()).step_by(2) {
        let claim_info = &ctx.remaining_accounts[i];
        let worker_info = &ctx.remaining_accounts[i + 1];

        // Validate account ownership
        require!(
            claim_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        require!(
            worker_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );

        // Validate claim belongs to this task
        let claim_data = claim_info.try_borrow_data()?;
        let claim = TaskClaim::try_deserialize(&mut &**claim_data)?;
        require!(
            claim.task == task.key(),
            CoordinationError::InvalidInput
        );
        require!(
            claim.worker == worker_info.key(),
            CoordinationError::InvalidInput
        );
        drop(claim_data);

        // Increment worker's disputes_as_defendant counter
        require!(worker_info.is_writable, CoordinationError::InvalidInput);
        let mut worker_data = worker_info.try_borrow_mut_data()?;
        let mut worker_reg = AgentRegistration::try_deserialize(&mut &**worker_data)?;
        worker_reg.disputes_as_defendant = worker_reg
            .disputes_as_defendant
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        worker_reg.try_serialize(&mut &mut worker_data[8..])?;
    }

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
