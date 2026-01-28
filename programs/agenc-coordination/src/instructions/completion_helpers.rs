//! Shared helper functions for task completion logic.
//!
//! Used by both `complete_task` (public) and `complete_task_private` (ZK) instructions.

use crate::errors::CoordinationError;
use crate::instructions::constants::{
    BASIS_POINTS_DIVISOR, MAX_REPUTATION, REPUTATION_PER_COMPLETION,
};
use crate::state::{
    AgentRegistration, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus, TaskType,
    RESULT_DATA_SIZE,
};
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

    Ok((worker_reward, protocol_fee))
}

/// Calculate per-worker reward based on task type.
fn calculate_reward_per_worker(task: &Task) -> Result<u64> {
    match task.task_type {
        TaskType::Collaborative => {
            let base_reward = task
                .reward_amount
                .checked_div(task.required_completions as u64)
                .ok_or(CoordinationError::ArithmeticOverflow)?;

            // Give remainder to last worker
            let remainder = task
                .reward_amount
                .checked_rem(task.required_completions as u64)
                .ok_or(CoordinationError::ArithmeticOverflow)?;

            if task.completions == task.required_completions.saturating_sub(1) {
                Ok(base_reward
                    .checked_add(remainder)
                    .ok_or(CoordinationError::ArithmeticOverflow)?)
            } else {
                Ok(base_reward)
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
    if worker_reward > 0 {
        **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_reward;
        **worker_account.try_borrow_mut_lamports()? += worker_reward;
    }

    if protocol_fee > 0 {
        **escrow.to_account_info().try_borrow_mut_lamports()? -= protocol_fee;
        **treasury.try_borrow_mut_lamports()? += protocol_fee;
    }

    Ok(())
}

/// Update claim state after completion.
///
/// Note: `reward_amount` is kept for API compatibility but `worker_reward`
/// (the actual amount paid) is used for the distributed counter to maintain
/// invariant E3: `distributed <= amount`.
pub fn update_claim_state(
    claim: &mut Account<TaskClaim>,
    escrow: &mut Account<TaskEscrow>,
    worker_reward: u64,
    _reward_amount: u64,
) -> Result<()> {
    claim.reward_paid = worker_reward;
    escrow.distributed = escrow
        .distributed
        .checked_add(worker_reward)
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
pub fn update_worker_state(
    worker: &mut Account<AgentRegistration>,
    reward: u64,
    timestamp: i64,
) -> Result<()> {
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
    worker.reputation = worker
        .reputation
        .saturating_add(REPUTATION_PER_COMPLETION)
        .min(MAX_REPUTATION);
    Ok(())
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
            depends_on: None,
            dependency_type: DependencyType::default(),
            _reserved: [0u8; 32],
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
        fn test_collaborative_task_with_remainder() {
            // 1003 / 4 = 250 with remainder 3
            // First 3 workers get 250, last worker gets 253
            let task = create_test_task(TaskType::Collaborative, 1003, 4, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 250);
        }

        #[test]
        fn test_collaborative_task_last_worker_gets_remainder() {
            // 1003 / 4 = 250 with remainder 3
            // Last worker (completions = 3, required = 4) gets 250 + 3 = 253
            let task = create_test_task(TaskType::Collaborative, 1003, 4, 3);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 253);
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
}
