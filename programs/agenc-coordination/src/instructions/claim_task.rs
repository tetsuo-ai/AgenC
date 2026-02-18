//! Claim a task to signal intent to work on it

use crate::errors::CoordinationError;
use crate::events::{reputation_reason, ReputationChanged, TaskClaimed};
use crate::instructions::constants::{
    MAX_REPUTATION, REPUTATION_DECAY_MIN, REPUTATION_DECAY_PERIOD, REPUTATION_DECAY_RATE,
};
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig, Task, TaskClaim, TaskStatus};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClaimTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        init_if_needed,
        payer = authority,
        space = TaskClaim::SIZE,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump
    )]
    pub claim: Account<'info, TaskClaim>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Account<'info, AgentRegistration>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimTask>) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let worker = &mut ctx.accounts.worker;
    let claim = &mut ctx.accounts.claim;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    check_version_compatible(config)?;

    // Prevent self-task claiming: worker authority must differ from task creator (fix #831)
    // Without this check, the same wallet can create, claim, and complete its own task,
    // farming +100 reputation per cycle at near-zero cost.
    require!(
        worker.authority != task.creator,
        CoordinationError::SelfTaskNotAllowed
    );

    // Check if worker already has a claim on this task (fix #480)
    // claimed_at > 0 indicates an existing claim (not freshly initialized)
    if claim.claimed_at > 0 {
        // Worker already completed this task
        require!(
            !claim.is_completed,
            CoordinationError::ClaimAlreadyCompleted
        );
        // Worker has an active (incomplete) claim - already claimed
        return Err(CoordinationError::AlreadyClaimed.into());
    }

    // Validate task state - must be Open or InProgress (for collaborative tasks)
    require!(
        task.status == TaskStatus::Open || task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotOpen
    );

    // Validate status transition is allowed (fix #538)
    require!(
        task.status.can_transition_to(TaskStatus::InProgress),
        CoordinationError::InvalidStatusTransition
    );

    // Check deadline
    if task.deadline > 0 {
        require!(
            clock.unix_timestamp < task.deadline,
            CoordinationError::TaskExpired
        );
    }

    // Check worker count
    require!(
        task.current_workers < task.max_workers,
        CoordinationError::TaskFullyClaimed
    );

    // Check worker is active
    require!(
        worker.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    // Check worker has required capabilities
    require!(
        (worker.capabilities & task.required_capabilities) == task.required_capabilities,
        CoordinationError::InsufficientCapabilities
    );

    // Apply passive reputation decay for inactivity
    let inactive_periods = clock
        .unix_timestamp
        .saturating_sub(worker.last_active)
        .checked_div(REPUTATION_DECAY_PERIOD)
        .unwrap_or(0);
    if inactive_periods > 0 && worker.reputation > REPUTATION_DECAY_MIN {
        // Clamp periods to prevent u16 truncation (max useful = MAX_REPUTATION / DECAY_RATE + 1)
        let max_periods = ((MAX_REPUTATION / REPUTATION_DECAY_RATE) as i64) + 1;
        let capped_periods = inactive_periods.min(max_periods) as u16;
        let decay = capped_periods.saturating_mul(REPUTATION_DECAY_RATE);
        let old_rep = worker.reputation;
        worker.reputation = worker
            .reputation
            .saturating_sub(decay)
            .max(REPUTATION_DECAY_MIN);
        if worker.reputation != old_rep {
            emit!(ReputationChanged {
                agent_id: worker.agent_id,
                old_reputation: old_rep,
                new_reputation: worker.reputation,
                reason: reputation_reason::DECAY,
                timestamp: clock.unix_timestamp,
            });
        }
    }

    // Check worker meets minimum reputation requirement
    if task.min_reputation > 0 {
        require!(
            worker.reputation >= task.min_reputation,
            CoordinationError::InsufficientReputation
        );
    }

    // Check worker doesn't have too many active tasks
    const MAX_ACTIVE_TASKS: u8 = 10;
    require!(
        worker.active_tasks < MAX_ACTIVE_TASKS,
        CoordinationError::MaxActiveTasksReached
    );

    // Calculate claim expiration
    // Add buffer past deadline so workers can complete and submit proof
    const COMPLETION_BUFFER: i64 = 3600; // 1 hour buffer
    let expires_at = if task.deadline > 0 {
        task.deadline
            .checked_add(COMPLETION_BUFFER)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    } else {
        clock
            .unix_timestamp
            .checked_add(config.max_claim_duration)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    };

    // Initialize claim
    claim.task = task.key();
    claim.worker = worker.key();
    claim.claimed_at = clock.unix_timestamp;
    claim.expires_at = expires_at;
    claim.completed_at = 0;
    claim.proof_hash = [0u8; 32];
    claim.result_data = [0u8; 64];
    claim.is_completed = false;
    claim.is_validated = false;
    claim.reward_paid = 0;
    claim.bump = ctx.bumps.claim;

    // Update task
    task.current_workers = task
        .current_workers
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    task.status = TaskStatus::InProgress;

    // Update worker
    worker.active_tasks = worker
        .active_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.last_active = clock.unix_timestamp;

    emit!(TaskClaimed {
        task_id: task.task_id,
        worker: worker.key(),
        current_workers: task.current_workers,
        max_workers: task.max_workers,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
