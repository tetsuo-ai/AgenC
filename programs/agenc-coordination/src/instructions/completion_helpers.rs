//! Shared helper functions for task completion logic.
//!
//! Used by both `complete_task` (public) and `complete_task_private` (ZK) instructions.

use crate::errors::CoordinationError;
use crate::events::{reputation_reason, ReputationChanged, RewardDistributed, TaskCompleted};
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::instructions::constants::{
    BASIS_POINTS_DIVISOR, MAX_REPUTATION, REPUTATION_PER_COMPLETION,
};
use crate::state::{
    AgentRegistration, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus, TaskType,
    RESULT_DATA_SIZE,
};
use crate::utils::compute_budget::{calculate_reputation_fee_discount, calculate_tiered_fee};
use anchor_lang::prelude::*;

/// Calculate worker reward and protocol fee from task reward amount.
///
/// For collaborative tasks, splits reward among required completions.
/// For exclusive/competitive tasks, uses full reward amount.
pub fn calculate_reward_split(task: &Task, protocol_fee_bps: u16) -> Result<(u64, u64)> {
    let reward_per_worker = calculate_reward_per_worker(task)?;

    let protocol_fee = reward_per_worker
        .checked_mul(protocol_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let worker_reward = reward_per_worker
        .checked_sub(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Ensure worker gets at least 1 lamport
    require!(worker_reward > 0, CoordinationError::RewardTooSmall);

    Ok((worker_reward, protocol_fee))
}

/// Calculate worker reward and protocol fee with volume-based tiered discounts (issue #40).
///
/// High-volume creators (measured by completed_tasks on their agent account) receive
/// reduced protocol fees. This incentivizes protocol usage while maintaining revenue.
///
/// See [`calculate_tiered_fee`] for tier thresholds and discount amounts.
pub fn calculate_reward_split_tiered(
    task: &Task,
    base_fee_bps: u16,
    creator_completed_tasks: u64,
) -> Result<(u64, u64, u16)> {
    let effective_fee_bps = calculate_tiered_fee(base_fee_bps, creator_completed_tasks);
    let (worker_reward, protocol_fee) = calculate_reward_split(task, effective_fee_bps)?;
    Ok((worker_reward, protocol_fee, effective_fee_bps))
}

/// Calculate per-worker reward based on task type.
///
/// Note: Remainder distribution is deterministic based on worker index.
/// First N workers get +1 lamport where N = total % num_workers.
/// This is predictable but fair across all workers.
fn calculate_reward_per_worker(task: &Task) -> Result<u64> {
    match task.task_type {
        TaskType::Collaborative => {
            let num_workers = task.required_completions as u64;
            let base_share = task
                .reward_amount
                .checked_div(num_workers)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            let remainder = task
                .reward_amount
                .checked_rem(num_workers)
                .ok_or(CoordinationError::ArithmeticOverflow)?;

            // Give extra 1 lamport to first `remainder` workers
            let worker_index = task.completions as u64;
            if worker_index < remainder {
                Ok(base_share
                    .checked_add(1)
                    .ok_or(CoordinationError::ArithmeticOverflow)?)
            } else {
                Ok(base_share)
            }
        }
        TaskType::Competitive | TaskType::Exclusive => Ok(task.reward_amount),
    }
}

/// Transfer lamports from escrow to worker and treasury.
pub fn transfer_rewards<'info>(
    escrow: &mut Account<'info, TaskEscrow>,
    worker_account: &AccountInfo<'info>,
    treasury: &AccountInfo<'info>,
    worker_reward: u64,
    protocol_fee: u64,
) -> Result<()> {
    transfer_lamports(&escrow.to_account_info(), worker_account, worker_reward)?;
    transfer_lamports(&escrow.to_account_info(), treasury, protocol_fee)?;
    Ok(())
}

/// Update claim state after completion.
///
/// Tracks both worker_reward and protocol_fee in escrow.distributed to
/// accurately reflect total funds withdrawn. This prevents remaining_funds
/// from being overestimated during dispute resolution.
pub fn update_claim_state(
    claim: &mut Account<TaskClaim>,
    escrow: &mut Account<TaskEscrow>,
    worker_reward: u64,
    protocol_fee: u64,
) -> Result<()> {
    claim.reward_paid = worker_reward;

    let total_withdrawn = worker_reward
        .checked_add(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    escrow.distributed = escrow
        .distributed
        .checked_add(total_withdrawn)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

/// Update task state after completion. Returns true if task is fully completed.
///
/// For private completions, pass `None` for result_data to zero the result field.
pub fn update_task_state(
    task: &mut Account<Task>,
    timestamp: i64,
    escrow: &mut Account<TaskEscrow>,
    result_data: Option<[u8; RESULT_DATA_SIZE]>,
) -> Result<bool> {
    task.completions = task
        .completions
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let completed = task.completions >= task.required_completions;
    if completed {
        task.status = TaskStatus::Completed;
        task.completed_at = timestamp;
        // Private completions pass None to preserve privacy
        task.result = result_data.unwrap_or([0u8; RESULT_DATA_SIZE]);
        escrow.is_closed = true;
    }

    Ok(completed)
}

/// Update worker statistics after task completion.
/// Returns `(old_reputation, new_reputation)` for event emission.
pub fn update_worker_state(
    worker: &mut Account<AgentRegistration>,
    reward: u64,
    timestamp: i64,
) -> Result<(u16, u16)> {
    worker.tasks_completed = worker
        .tasks_completed
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.total_earned = worker
        .total_earned
        .checked_add(reward)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.last_active = timestamp;
    // Reputation uses saturating_add intentionally - reputation overflow to MAX_REPUTATION
    // is the intended behavior (capped at 10000), not an error condition
    let old_rep = worker.reputation;
    worker.reputation = worker
        .reputation
        .saturating_add(REPUTATION_PER_COMPLETION)
        .min(MAX_REPUTATION);
    Ok((old_rep, worker.reputation))
}

/// Update protocol statistics after task completion.
pub fn update_protocol_stats(config: &mut Account<ProtocolConfig>, reward: u64) -> Result<()> {
    config.completed_tasks = config
        .completed_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    config.total_value_distributed = config
        .total_value_distributed
        .checked_add(reward)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

/// Validate that a task is ready for completion.
///
/// Shared by `complete_task` (public) and `complete_task_private` (ZK).
/// Checks status, status transition, deadline, claim, and competitive-task guard.
pub fn validate_completion_prereqs(
    task: &Task,
    claim: &TaskClaim,
    clock: &Clock,
) -> Result<()> {
    require!(
        task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotInProgress
    );
    require!(
        task.status.can_transition_to(TaskStatus::Completed),
        CoordinationError::InvalidStatusTransition
    );
    if task.deadline > 0 {
        require!(
            clock.unix_timestamp <= task.deadline,
            CoordinationError::DeadlinePassed
        );
    }
    require!(
        !claim.is_completed,
        CoordinationError::ClaimAlreadyCompleted
    );
    if task.task_type == TaskType::Competitive {
        require!(
            task.completions == 0,
            CoordinationError::CompetitiveTaskAlreadyWon
        );
    }
    Ok(())
}

/// Calculate protocol fee with reputation-based discount.
///
/// Uses the task-locked fee (not current protocol config) per PR #479.
/// Floors at 1 bps to prevent zero-fee completion.
pub fn calculate_fee_with_reputation(task_protocol_fee_bps: u16, worker_reputation: u16) -> u16 {
    let rep_discount = calculate_reputation_fee_discount(worker_reputation);
    task_protocol_fee_bps.saturating_sub(rep_discount).max(1)
}

/// Execute reward transfer, state updates, and event emissions.
///
/// Shared by both `complete_task` (public) and `complete_task_private` (ZK) handlers.
///
/// # Preconditions
///
/// The caller MUST set these claim fields before calling:
/// - `claim.proof_hash`
/// - `claim.result_data`
/// - `claim.is_completed`
/// - `claim.completed_at`
///
/// The `TaskCompleted` event reads `proof_hash` and `result_data` from the claim.
pub fn execute_completion_rewards<'info>(
    task: &mut Account<'info, Task>,
    claim: &mut Account<'info, TaskClaim>,
    escrow: &mut Account<'info, TaskEscrow>,
    worker: &mut Account<'info, AgentRegistration>,
    protocol_config: &mut Account<'info, ProtocolConfig>,
    authority_info: &AccountInfo<'info>,
    treasury_info: &AccountInfo<'info>,
    protocol_fee_bps: u16,
    result_data_for_task: Option<[u8; RESULT_DATA_SIZE]>,
    clock: &Clock,
) -> Result<()> {
    let (worker_reward, protocol_fee) = calculate_reward_split(task, protocol_fee_bps)?;

    // Validate escrow has sufficient balance
    let total = worker_reward
        .checked_add(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        escrow.to_account_info().lamports() >= total,
        CoordinationError::InsufficientEscrowBalance
    );

    transfer_rewards(escrow, authority_info, treasury_info, worker_reward, protocol_fee)?;
    update_claim_state(claim, escrow, worker_reward, protocol_fee)?;
    let task_completed =
        update_task_state(task, clock.unix_timestamp, escrow, result_data_for_task)?;
    let (old_rep, new_rep) = update_worker_state(worker, worker_reward, clock.unix_timestamp)?;

    if old_rep != new_rep {
        emit!(ReputationChanged {
            agent_id: worker.agent_id,
            old_reputation: old_rep,
            new_reputation: new_rep,
            reason: reputation_reason::COMPLETION,
            timestamp: clock.unix_timestamp,
        });
    }

    if task_completed {
        update_protocol_stats(protocol_config, task.reward_amount)?;
    }

    emit!(TaskCompleted {
        task_id: task.task_id,
        worker: worker.key(),
        proof_hash: claim.proof_hash,
        result_data: claim.result_data,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{DependencyType, TaskStatus};

    /// Create a test task with configurable parameters
    fn create_test_task(
        task_type: TaskType,
        reward_amount: u64,
        required_completions: u8,
        completions: u8,
    ) -> Task {
        Task {
            task_id: [0u8; 32],
            creator: Pubkey::default(),
            required_capabilities: 0,
            description: [0u8; 64],
            constraint_hash: [0u8; 32],
            reward_amount,
            max_workers: 1,
            current_workers: 1,
            status: TaskStatus::InProgress,
            task_type,
            created_at: 0,
            deadline: 0,
            completed_at: 0,
            escrow: Pubkey::default(),
            result: [0u8; 64],
            required_completions,
            completions,
            bump: 0,
            protocol_fee_bps: 100, // 1% default for tests
            depends_on: None,
            dependency_type: DependencyType::default(),
            min_reputation: 0,
            _reserved: [0u8; 30],
        }
    }

    mod calculate_reward_per_worker_tests {
        use super::*;

        #[test]
        fn test_exclusive_task_full_reward() {
            let task = create_test_task(TaskType::Exclusive, 1000, 1, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 1000);
        }

        #[test]
        fn test_competitive_task_full_reward() {
            let task = create_test_task(TaskType::Competitive, 1000, 1, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 1000);
        }

        #[test]
        fn test_collaborative_task_even_split() {
            // 1000 / 4 = 250 per worker
            let task = create_test_task(TaskType::Collaborative, 1000, 4, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 250);
        }

        #[test]
        fn test_collaborative_task_fair_rounding_first_worker_gets_extra() {
            // 1003 / 4 = 250 with remainder 3
            // First 3 workers (indices 0,1,2) get 251, last worker gets 250
            let task = create_test_task(TaskType::Collaborative, 1003, 4, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 251); // Worker 0 gets +1
        }

        #[test]
        fn test_collaborative_task_fair_rounding_middle_worker() {
            // 1003 / 4 = 250 with remainder 3
            // Worker index 2 (third worker) still gets +1
            let task = create_test_task(TaskType::Collaborative, 1003, 4, 2);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 251); // Worker 2 gets +1
        }

        #[test]
        fn test_collaborative_task_fair_rounding_last_worker_no_extra() {
            // 1003 / 4 = 250 with remainder 3
            // Last worker (index 3) doesn't get extra since 3 >= remainder
            let task = create_test_task(TaskType::Collaborative, 1003, 4, 3);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 250); // Worker 3 gets base only
        }

        #[test]
        fn test_collaborative_task_fair_rounding_all_workers() {
            // 1003 / 4 = 250 with remainder 3
            // Verify total: 251 + 251 + 251 + 250 = 1003
            let mut total = 0u64;
            for i in 0..4 {
                let task = create_test_task(TaskType::Collaborative, 1003, 4, i);
                total += calculate_reward_per_worker(&task).unwrap();
            }
            assert_eq!(total, 1003);
        }

        #[test]
        fn test_collaborative_single_worker() {
            let task = create_test_task(TaskType::Collaborative, 1000, 1, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 1000);
        }

        #[test]
        fn test_large_reward_no_overflow() {
            let task = create_test_task(TaskType::Exclusive, u64::MAX - 1, 1, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, u64::MAX - 1);
        }
    }

    mod calculate_reward_split_tests {
        use super::*;

        #[test]
        fn test_zero_protocol_fee() {
            let task = create_test_task(TaskType::Exclusive, 1000, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 0).unwrap();
            assert_eq!(worker, 1000);
            assert_eq!(fee, 0);
        }

        #[test]
        fn test_1_percent_fee() {
            // 1% = 100 basis points
            let task = create_test_task(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 100).unwrap();
            assert_eq!(fee, 100); // 1% of 10000
            assert_eq!(worker, 9900);
        }

        #[test]
        fn test_10_percent_fee() {
            // 10% = 1000 basis points
            let task = create_test_task(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 1000).unwrap();
            assert_eq!(fee, 1000); // 10% of 10000
            assert_eq!(worker, 9000);
        }

        #[test]
        fn test_fee_rounds_down() {
            // 1% of 99 = 0.99, rounds down to 0
            let task = create_test_task(TaskType::Exclusive, 99, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 100).unwrap();
            assert_eq!(fee, 0);
            assert_eq!(worker, 99);
        }

        #[test]
        fn test_collaborative_with_fee() {
            // 4 workers, 10000 total = 2500 each
            // 5% fee on 2500 = 125
            let task = create_test_task(TaskType::Collaborative, 10000, 4, 0);
            let (worker, fee) = calculate_reward_split(&task, 500).unwrap();
            assert_eq!(fee, 125); // 5% of 2500
            assert_eq!(worker, 2375);
        }

        #[test]
        fn test_max_fee_100_percent() {
            // 100% = 10000 basis points - this would take all funds
            // Our max is usually capped at 1000 bps (10%), but let's test the math
            let task = create_test_task(TaskType::Exclusive, 1000, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 10000).unwrap();
            assert_eq!(fee, 1000); // All goes to fee
            assert_eq!(worker, 0);
        }

        #[test]
        fn test_small_reward_small_fee() {
            // 1 lamport reward with 1% fee = 0 fee (rounds down)
            let task = create_test_task(TaskType::Exclusive, 1, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 100).unwrap();
            assert_eq!(fee, 0);
            assert_eq!(worker, 1);
        }
    }

    mod edge_cases {
        use super::*;

        #[test]
        fn test_zero_reward() {
            let task = create_test_task(TaskType::Exclusive, 0, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 100).unwrap();
            assert_eq!(worker, 0);
            assert_eq!(fee, 0);
        }

        #[test]
        fn test_max_completions() {
            let task = create_test_task(TaskType::Collaborative, 25500, 255, 254);
            let reward = calculate_reward_per_worker(&task).unwrap();
            // 25500 / 255 = 100, remainder 0
            assert_eq!(reward, 100);
        }
    }

    mod tiered_fee_tests {
        use super::*;

        #[test]
        fn test_tiered_split_base_tier() {
            // New creator with 0 completed tasks -> no discount
            let task = create_test_task(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee, effective_bps) =
                calculate_reward_split_tiered(&task, 100, 0).unwrap();
            assert_eq!(effective_bps, 100); // No discount
            assert_eq!(fee, 100);
            assert_eq!(worker, 9900);
        }

        #[test]
        fn test_tiered_split_bronze() {
            // Creator with 50 completed tasks -> 10 bps discount
            let task = create_test_task(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee, effective_bps) =
                calculate_reward_split_tiered(&task, 100, 50).unwrap();
            assert_eq!(effective_bps, 90); // 10 bps discount
            assert_eq!(fee, 90);
            assert_eq!(worker, 9910);
        }

        #[test]
        fn test_tiered_split_gold() {
            // Creator with 1000+ completed tasks -> 40 bps discount
            let task = create_test_task(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee, effective_bps) =
                calculate_reward_split_tiered(&task, 100, 1500).unwrap();
            assert_eq!(effective_bps, 60); // 40 bps discount
            assert_eq!(fee, 60);
            assert_eq!(worker, 9940);
        }

        #[test]
        fn test_tiered_split_collaborative() {
            // 4 workers, 10000 total = 2500 each, bronze tier
            let task = create_test_task(TaskType::Collaborative, 10000, 4, 0);
            let (worker, fee, effective_bps) =
                calculate_reward_split_tiered(&task, 500, 100).unwrap();
            assert_eq!(effective_bps, 490); // 10 bps discount on 500
            assert_eq!(fee, 122); // 4.9% of 2500 = 122.5 -> rounds down
            assert_eq!(worker, 2378);
        }
    }
}
