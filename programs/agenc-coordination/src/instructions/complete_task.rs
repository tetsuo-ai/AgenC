//! Complete a task and claim reward

use anchor_lang::prelude::*;
use crate::state::{Task, TaskStatus, TaskType, TaskClaim, TaskEscrow, AgentRegistration, ProtocolConfig};
use crate::errors::CoordinationError;
use crate::events::{TaskCompleted, RewardDistributed};

#[derive(Accounts)]
pub struct CompleteTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Account<'info, TaskClaim>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Account<'info, AgentRegistration>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Treasury account for protocol fees - validated against protocol_config
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CompleteTask>,
    proof_hash: [u8; 32],
    result_data: Option<[u8; 64]>,
) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let claim = &mut ctx.accounts.claim;
    let escrow = &mut ctx.accounts.escrow;
    let worker = &mut ctx.accounts.worker;
    let clock = Clock::get()?;

    // Read protocol fee before any mutable borrows of protocol_config
    let protocol_fee_bps = ctx.accounts.protocol_config.protocol_fee_bps;

    // Validate task state
    require!(
        task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotInProgress
    );

    // Validate claim not already completed
    require!(!claim.is_completed, CoordinationError::ClaimAlreadyCompleted);

    // Update claim
    claim.proof_hash = proof_hash;
    claim.result_data = result_data.unwrap_or([0u8; 64]);
    claim.is_completed = true;
    claim.completed_at = clock.unix_timestamp;

    // Calculate reward
    let reward_per_worker = if task.task_type == TaskType::Collaborative {
        task.reward_amount.checked_div(task.required_completions as u64)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    } else {
        task.reward_amount
    };

    // Calculate protocol fee
    let protocol_fee = reward_per_worker
        .checked_mul(protocol_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(10000)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let worker_reward = reward_per_worker
        .checked_sub(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Transfer reward to worker
    if worker_reward > 0 {
        **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_reward;
        **ctx.accounts.authority.to_account_info().try_borrow_mut_lamports()? += worker_reward;
    }

    // Transfer protocol fee to treasury
    if protocol_fee > 0 {
        **escrow.to_account_info().try_borrow_mut_lamports()? -= protocol_fee;
        **ctx.accounts.treasury.to_account_info().try_borrow_mut_lamports()? += protocol_fee;
    }

    claim.reward_paid = worker_reward;
    escrow.distributed = escrow.distributed.checked_add(reward_per_worker)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Update task completion count
    task.completions = task.completions.checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Check if task is fully completed
    let task_completed = task.completions >= task.required_completions;
    if task_completed {
        task.status = TaskStatus::Completed;
        task.completed_at = clock.unix_timestamp;
        task.result = claim.result_data;
        escrow.is_closed = true;
    }

    // Update worker stats
    worker.tasks_completed = worker.tasks_completed.checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.total_earned = worker.total_earned.checked_add(worker_reward)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.active_tasks = worker.active_tasks.saturating_sub(1);
    worker.last_active = clock.unix_timestamp;

    // Increase reputation for successful completion
    worker.reputation = worker.reputation.saturating_add(100).min(10000);

    // Update protocol stats after other mutable borrows are done
    if task_completed {
        let config = &mut ctx.accounts.protocol_config;
        config.completed_tasks = config.completed_tasks.checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        config.total_value_distributed = config.total_value_distributed
            .checked_add(reward_per_worker)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    emit!(TaskCompleted {
        task_id: task.task_id,
        worker: worker.key(),
        proof_hash,
        reward_paid: worker_reward,
        timestamp: clock.unix_timestamp,
    });

    emit!(RewardDistributed {
        task_id: task.task_id,
        recipient: worker.key(),
        amount: worker_reward,
        protocol_fee,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}