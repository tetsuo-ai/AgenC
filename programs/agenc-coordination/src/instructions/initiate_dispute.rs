//! Initiate a dispute for conflict resolution

use crate::errors::CoordinationError;
use crate::events::DisputeInitiated;
use crate::state::{
    AgentRegistration, AgentStatus, Dispute, DisputeStatus, ProtocolConfig, ResolutionType, Task,
    TaskClaim, TaskStatus,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

use super::rate_limit_helpers::check_dispute_initiation_rate_limits;

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
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub agent: Box<Account<'info, AgentRegistration>>,

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
    pub worker_agent: Option<Box<Account<'info, AgentRegistration>>>,

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

    // Validate status transition is allowed (fix #538)
    require!(
        task.status.can_transition_to(TaskStatus::Disputed),
        CoordinationError::InvalidStatusTransition
    );

    // Verify task has workers to dispute (fix #502)
    require!(
        task.current_workers > 0,
        CoordinationError::NoWorkers
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
    // Creator-initiated disputes require 2x stake to prevent abuse (fix #407)
    if config.min_stake_for_dispute > 0 {
        if is_creator {
            // Creator disputes require 2x the minimum stake to discourage frivolous disputes
            // that could grief workers who claimed the task in good faith
            let creator_min_stake = config
                .min_stake_for_dispute
                .checked_mul(2)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            require!(
                agent.stake >= creator_min_stake,
                CoordinationError::InsufficientStakeForCreatorDispute
            );
        } else {
            require!(
                agent.stake >= config.min_stake_for_dispute,
                CoordinationError::InsufficientStakeForDispute
            );
        }
    }

    // Check rate limits and update counters
    check_dispute_initiation_rate_limits(agent, config, &clock)?;

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
        .checked_add(config.voting_period)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    dispute.expires_at = clock
        .unix_timestamp
        .checked_add(config.max_dispute_duration)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    dispute.slash_applied = false;
    dispute.initiator_slash_applied = false;
    dispute.worker_stake_at_dispute = worker_stake;
    dispute.initiated_by_creator = is_creator;
    dispute.bump = ctx.bumps.dispute;

    // Bind the defendant worker at dispute initiation (fix #827)
    // This prevents slashing the wrong worker on collaborative tasks.
    dispute.defendant = if is_creator {
        // Creator path: worker_agent was already validated above (lines 182-203)
        ctx.accounts.worker_agent.as_ref()
            .ok_or(CoordinationError::WorkerAgentRequired)?
            .key()
    } else {
        // Worker path: the initiating agent is the subject of the dispute
        agent.key()
    };

    // Mark task as disputed
    task.status = TaskStatus::Disputed;

    // Increment disputes_as_defendant for workers being disputed (fix #544)
    // remaining_accounts should contain (claim, worker) pairs for defendants
    // This prevents workers from deregistering to escape potential slashing
    mark_defendant_workers(ctx.remaining_accounts, &task.key())?;

    emit!(DisputeInitiated {
        dispute_id,
        task_id,
        initiator: agent.key(),
        defendant: dispute.defendant,
        resolution_type,
        voting_deadline: dispute.voting_deadline,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Processes (claim, worker) pairs to increment `disputes_as_defendant` counters.
///
/// Validates account ownership, claim-task linkage, and claim-worker linkage
/// before incrementing each worker's disputes_as_defendant counter via `checked_add`.
fn mark_defendant_workers(
    remaining_accounts: &[AccountInfo],
    task_key: &Pubkey,
) -> Result<()> {
    require!(
        remaining_accounts.len() % 2 == 0,
        CoordinationError::InvalidInput
    );

    for i in (0..remaining_accounts.len()).step_by(2) {
        let claim_info = &remaining_accounts[i];
        let worker_info = &remaining_accounts[i + 1];

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
            claim.task == *task_key,
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

    Ok(())
}
