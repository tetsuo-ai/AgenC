//! Complete a task and claim reward

use crate::errors::CoordinationError;
use crate::events::{RewardDistributed, TaskCompleted};
use crate::instructions::completion_helpers::{
    calculate_reward_split, transfer_rewards, update_claim_state, update_protocol_stats,
    update_task_state, update_worker_state,
};
use crate::state::{
    AgentRegistration, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus, TaskType,
    HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

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
    proof_hash: [u8; HASH_SIZE],
    result_data: Option<[u8; RESULT_DATA_SIZE]>,
) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let claim = &mut ctx.accounts.claim;
    let escrow = &mut ctx.accounts.escrow;
    let worker = &mut ctx.accounts.worker;
    let clock = Clock::get()?;

    check_version_compatible(&ctx.accounts.protocol_config)?;

    // Read protocol fee before any mutable borrows of protocol_config
    let protocol_fee_bps = ctx.accounts.protocol_config.protocol_fee_bps;

    // Validate task state
    require!(
        task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotInProgress
    );

    // Enforce deadline
    if task.deadline > 0 {
        require!(
            clock.unix_timestamp <= task.deadline,
            CoordinationError::DeadlinePassed
        );
    }

    // Validate claim not already completed
    require!(
        !claim.is_completed,
        CoordinationError::ClaimAlreadyCompleted
    );

    // For competitive tasks, ensure no one else has completed
    if task.task_type == TaskType::Competitive {
        require!(
            task.completions == 0,
            CoordinationError::CompetitiveTaskAlreadyWon
        );
    }

    // Update claim
    let claim_result_data = result_data.unwrap_or([0u8; RESULT_DATA_SIZE]);
    claim.proof_hash = proof_hash;
    claim.result_data = claim_result_data;
    claim.is_completed = true;
    claim.completed_at = clock.unix_timestamp;

    // Calculate rewards
    let (worker_reward, protocol_fee) = calculate_reward_split(task, protocol_fee_bps)?;

    // Transfer rewards
    transfer_rewards(
        escrow,
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        worker_reward,
        protocol_fee,
    )?;

    // Update states
    update_claim_state(claim, escrow, worker_reward, task.reward_amount)?;
    let task_completed =
        update_task_state(task, clock.unix_timestamp, escrow, Some(claim_result_data))?;
    update_worker_state(worker, worker_reward, clock.unix_timestamp)?;

    // Update protocol stats after other mutable borrows are done
    if task_completed {
        update_protocol_stats(&mut ctx.accounts.protocol_config, task.reward_amount)?;
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
