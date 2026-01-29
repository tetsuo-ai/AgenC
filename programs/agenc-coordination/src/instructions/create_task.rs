//! Create a new task with reward escrow

use crate::errors::CoordinationError;
use crate::events::{RateLimitHit, TaskCreated};
use crate::state::{AgentRegistration, DependencyType, ProtocolConfig, Task, TaskEscrow, TaskStatus, TaskType};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

use super::constants::WINDOW_24H;

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateTask<'info> {
    #[account(
        init,
        payer = creator,
        space = Task::SIZE,
        seeds = [b"task", creator.key().as_ref(), task_id.as_ref()],
        bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        init,
        payer = creator,
        space = TaskEscrow::SIZE,
        seeds = [b"escrow", task.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Creator's agent registration for rate limiting (required)
    #[account(
        mut,
        seeds = [b"agent", creator_agent.agent_id.as_ref()],
        bump = creator_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub creator_agent: Account<'info, AgentRegistration>,

    /// The authority that owns the creator_agent
    pub authority: Signer<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Creates a new task.
///
/// # Parameters
/// - `task_type`: Task execution type (0=Exclusive, 1=Collaborative, 2=Competitive)
///   Validated to be in range 0-2.
#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateTask>,
    task_id: [u8; 32],
    required_capabilities: u64,
    description: [u8; 64],
    reward_amount: u64,
    max_workers: u8,
    deadline: i64,
    task_type: u8,
    constraint_hash: Option<[u8; 32]>,
) -> Result<()> {
    // Validate task_id is not zero (#367)
    require!(task_id != [0u8; 32], CoordinationError::InvalidTaskId);
    // Validate description is not empty (#369)
    require!(description != [0u8; 64], CoordinationError::InvalidDescription);
    // Validate max_workers bounds (#412)
    require!(max_workers > 0 && max_workers <= 100, CoordinationError::InvalidMaxWorkers);
    require!(task_type <= 2, CoordinationError::InvalidTaskType);
    // Validate reward is not zero (#540)
    require!(reward_amount > 0, CoordinationError::InvalidReward);

    let clock = Clock::get()?;
    let config = &ctx.accounts.protocol_config;

    check_version_compatible(config)?;

    // Validate deadline - must be set and in the future (#575)
    require!(deadline > 0, CoordinationError::InvalidDeadline);
    require!(
        deadline > clock.unix_timestamp,
        CoordinationError::InvalidInput
    );

    let creator_agent = &mut ctx.accounts.creator_agent;

    // Check cooldown period
    if config.task_creation_cooldown > 0 && creator_agent.last_task_created > 0 {
        // Using saturating_sub intentionally - handles clock drift safely
        let elapsed = clock
            .unix_timestamp
            .saturating_sub(creator_agent.last_task_created);
        if elapsed < config.task_creation_cooldown {
            // Using saturating_sub intentionally - underflow returns 0 (safe time calculation)
            let remaining = config.task_creation_cooldown.saturating_sub(elapsed);
            emit!(RateLimitHit {
                agent_id: creator_agent.agent_id,
                action_type: 0, // task_creation
                limit_type: 0,  // cooldown
                current_count: creator_agent.task_count_24h,
                max_count: config.max_tasks_per_24h,
                cooldown_remaining: remaining,
                timestamp: clock.unix_timestamp,
            });
            return Err(CoordinationError::CooldownNotElapsed.into());
        }
    }

    // Check 24h window limit
    if config.max_tasks_per_24h > 0 {
        // Reset window if 24h has passed
        // Using saturating_sub intentionally - handles clock drift safely
        if clock
            .unix_timestamp
            .saturating_sub(creator_agent.rate_limit_window_start)
            >= WINDOW_24H
        {
            // Round window start to prevent drift
            let window_start = (clock.unix_timestamp / WINDOW_24H) * WINDOW_24H;
            creator_agent.rate_limit_window_start = window_start;
            // Note: Both counters reset together when window expires.
            // This is intentional - ensures clean state at window boundary.
            creator_agent.task_count_24h = 0;
            creator_agent.dispute_count_24h = 0;
        }

        // Check if limit exceeded
        if creator_agent.task_count_24h >= config.max_tasks_per_24h {
            emit!(RateLimitHit {
                agent_id: creator_agent.agent_id,
                action_type: 0, // task_creation
                limit_type: 1,  // 24h_window
                current_count: creator_agent.task_count_24h,
                max_count: config.max_tasks_per_24h,
                cooldown_remaining: 0,
                timestamp: clock.unix_timestamp,
            });
            return Err(CoordinationError::RateLimitExceeded.into());
        }

        // Increment counter
        creator_agent.task_count_24h = creator_agent
            .task_count_24h
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    // Update last task created timestamp
    creator_agent.last_task_created = clock.unix_timestamp;
    creator_agent.last_active = clock.unix_timestamp;

    // Transfer reward to escrow
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        reward_amount,
    )?;

    // Initialize task
    let task = &mut ctx.accounts.task;
    task.task_id = task_id;
    task.creator = ctx.accounts.creator.key();
    task.required_capabilities = required_capabilities;
    task.description = description;
    task.constraint_hash = constraint_hash.unwrap_or([0u8; 32]);
    task.reward_amount = reward_amount;
    task.max_workers = max_workers;
    task.current_workers = 0;
    task.status = TaskStatus::Open;
    task.task_type = match task_type {
        0 => TaskType::Exclusive,
        1 => TaskType::Collaborative,
        2 => TaskType::Competitive,
        _ => return Err(CoordinationError::InvalidTaskType.into()),
    };
    task.created_at = clock.unix_timestamp;
    task.deadline = deadline;
    task.completed_at = 0;
    task.escrow = ctx.accounts.escrow.key();
    task.result = [0u8; 64];
    task.completions = 0;
    task.required_completions = if task_type == 1 { max_workers } else { 1 };
    task.bump = ctx.bumps.task;
    // Lock protocol fee at task creation (#479)
    task.protocol_fee_bps = config.protocol_fee_bps;

    // Independent task - no dependencies
    task.dependency_type = DependencyType::None;
    task.depends_on = None;

    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    escrow.task = task.key();
    escrow.amount = reward_amount;
    escrow.distributed = 0;
    escrow.is_closed = false;
    escrow.bump = ctx.bumps.escrow;

    // Update protocol stats
    let protocol_config = &mut ctx.accounts.protocol_config;
    protocol_config.total_tasks = protocol_config
        .total_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(TaskCreated {
        task_id,
        creator: task.creator,
        required_capabilities,
        reward_amount,
        task_type,
        deadline,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
