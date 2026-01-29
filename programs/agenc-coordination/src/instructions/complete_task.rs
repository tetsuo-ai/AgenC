//! Complete a task and claim reward

use crate::errors::CoordinationError;
use crate::events::{RewardDistributed, TaskCompleted};
use crate::instructions::completion_helpers::{
    calculate_reward_split, transfer_rewards, update_claim_state, update_protocol_stats,
    update_task_state, update_worker_state,
};
use crate::state::{
    AgentRegistration, DependencyType, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus,
    TaskType, HASH_SIZE, RESULT_DATA_SIZE,
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

    /// Note: Claim account is closed after completion.
    /// If proof-of-completion is needed later, store result_hash
    /// in an event or separate completion record.
    #[account(
        mut,
        close = authority,
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

    // If task has a proof dependency, verify parent task is completed
    if task.dependency_type == DependencyType::Proof {
        // Parent task account must be provided in remaining_accounts
        let parent_task_key = task
            .depends_on
            .ok_or(CoordinationError::InvalidDependencyType)?;

        // Get parent task from remaining_accounts
        require!(
            !ctx.remaining_accounts.is_empty(),
            CoordinationError::ParentTaskAccountRequired
        );
        let parent_task_info = &ctx.remaining_accounts[0];

        // Validate the account matches the expected parent
        require!(
            parent_task_info.key() == parent_task_key,
            CoordinationError::InvalidInput
        );

        // Validate owner is this program
        require!(
            parent_task_info.owner == ctx.program_id,
            CoordinationError::InvalidAccountOwner
        );

        // Deserialize and check parent task status
        let parent_data = parent_task_info.try_borrow_data()?;
        // Skip 8-byte discriminator, then deserialize Task
        let parent_task =
            Task::try_deserialize(&mut &parent_data[..]).map_err(|_| CoordinationError::InvalidInput)?;

        require!(
            parent_task.status == TaskStatus::Completed,
            CoordinationError::ParentTaskNotCompleted
        );
    }

    // Read protocol fee before any mutable borrows of protocol_config
    let protocol_fee_bps = ctx.accounts.protocol_config.protocol_fee_bps;

    // Validate proof_hash is not zero
    require!(
        proof_hash != [0u8; 32],
        CoordinationError::InvalidProofHash
    );

    // Validate result_data is not all zeros (when provided)
    if let Some(ref data) = result_data {
        require!(
            data.iter().any(|&b| b != 0),
            CoordinationError::InvalidResultData
        );
    }

    // Validate task state
    require!(
        task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotInProgress
    );

    // Validate status transition is allowed (fix #538)
    require!(
        task.status.can_transition_to(TaskStatus::Completed),
        CoordinationError::InvalidStatusTransition
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

    // Validate escrow has sufficient balance before transfer
    let total_transfer_amount = worker_reward
        .checked_add(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let escrow_lamports = escrow.to_account_info().lamports();
    require!(
        escrow_lamports >= total_transfer_amount,
        CoordinationError::InsufficientEscrowBalance
    );

    // Transfer rewards
    transfer_rewards(
        escrow,
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        worker_reward,
        protocol_fee,
    )?;

    // Update states
    update_claim_state(claim, escrow, worker_reward, protocol_fee)?;
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
        result_data: claim_result_data,
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
