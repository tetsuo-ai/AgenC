//! Fuzz target for claim_task instruction
//!
//! Tests invariants:
//! - T1: Valid state transitions (Open -> InProgress)
//! - T3: Worker count consistency (current_workers <= max_workers)
//! - T5: Deadline enforcement
//!
//! Run with: cargo test --release -p agenc-coordination-fuzz claim_task

use crate::*;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    /// Fuzz claim_task with arbitrary inputs
    /// Verifies no invariant violations occur regardless of input
    #[test]
    fn fuzz_claim_task(input in any::<ClaimTaskInput>()) {
        let mut task = SimulatedTask {
            task_id: input.task_id,
            status: task_status::OPEN,
            reward_amount: input.task_reward,
            max_workers: input.task_max_workers.max(1),
            current_workers: input.task_current_workers.min(input.task_max_workers.saturating_sub(1)),
            required_capabilities: input.task_required_capabilities,
            deadline: input.task_deadline,
            completions: 0,
            required_completions: 1,
            task_type: 0,
        };

        let mut worker = SimulatedAgent {
            agent_id: input.agent_id,
            capabilities: input.worker_capabilities,
            status: 1,
            active_tasks: input.worker_active_tasks.min(9),
            reputation: input.worker_reputation.min(10000),
            stake: 0,
            tasks_completed: 0,
            total_earned: 0,
        };

        let result = simulate_claim_task(&mut task, &mut worker, input.current_timestamp);

        // Should never have invariant violations
        prop_assert!(!result.is_invariant_violation(),
            "Invariant violation: {:?}\nInput: {:?}", result, input);

        // Post-condition: if successful, verify state
        if result.is_success() {
            prop_assert!(task.current_workers <= task.max_workers,
                "T3 violated: current_workers {} > max_workers {}",
                task.current_workers, task.max_workers);

            prop_assert!(task.status == task_status::IN_PROGRESS,
                "Task should be InProgress after claim");

            prop_assert!(worker.active_tasks > 0,
                "Worker should have active tasks after claim");
        }
    }

    /// Test deadline enforcement specifically
    #[test]
    fn fuzz_claim_task_deadline(
        task_id in arb_id(),
        deadline in 1i64..i64::MAX,
        current_time in 0i64..i64::MAX,
    ) {
        let mut task = SimulatedTask {
            task_id,
            status: task_status::OPEN,
            reward_amount: 1_000_000,
            max_workers: 10,
            current_workers: 0,
            required_capabilities: 0,
            deadline,
            completions: 0,
            required_completions: 1,
            task_type: 0,
        };

        let mut worker = SimulatedAgent {
            agent_id: [0u8; 32],
            capabilities: 0xFF,
            status: 1,
            active_tasks: 0,
            reputation: 5000,
            stake: 0,
            tasks_completed: 0,
            total_earned: 0,
        };

        let result = simulate_claim_task(&mut task, &mut worker, current_time);

        // If current_time >= deadline, should fail
        if current_time >= deadline {
            prop_assert!(result.is_error(),
                "T5 violated: claim succeeded after deadline. time={}, deadline={}",
                current_time, deadline);
        }
    }

    /// Test max workers limit
    #[test]
    fn fuzz_claim_task_max_workers(
        max_workers in 1u8..=255u8,
        initial_workers in 0u8..=255u8,
    ) {
        let initial = initial_workers.min(max_workers);

        let mut task = SimulatedTask {
            task_id: [0u8; 32],
            status: task_status::OPEN,
            reward_amount: 1_000_000,
            max_workers,
            current_workers: initial,
            required_capabilities: 0,
            deadline: 0,
            completions: 0,
            required_completions: 1,
            task_type: 0,
        };

        let mut worker = SimulatedAgent {
            agent_id: [0u8; 32],
            capabilities: 0xFF,
            status: 1,
            active_tasks: 0,
            reputation: 5000,
            stake: 0,
            tasks_completed: 0,
            total_earned: 0,
        };

        let result = simulate_claim_task(&mut task, &mut worker, 100);

        // Verify T3: worker count consistency
        prop_assert!(task.current_workers <= task.max_workers,
            "T3 violated: current_workers {} > max_workers {} after claim",
            task.current_workers, task.max_workers);

        // If at capacity, should fail
        if initial >= max_workers {
            prop_assert!(result.is_error(),
                "Should fail when at max workers. initial={}, max={}",
                initial, max_workers);
        }
    }

    /// Test capability matching
    #[test]
    fn fuzz_claim_task_capabilities(
        required_caps in arb_capabilities(),
        worker_caps in arb_capabilities(),
    ) {
        let mut task = SimulatedTask {
            task_id: [0u8; 32],
            status: task_status::OPEN,
            reward_amount: 1_000_000,
            max_workers: 10,
            current_workers: 0,
            required_capabilities: required_caps,
            deadline: 0,
            completions: 0,
            required_completions: 1,
            task_type: 0,
        };

        let mut worker = SimulatedAgent {
            agent_id: [0u8; 32],
            capabilities: worker_caps,
            status: 1,
            active_tasks: 0,
            reputation: 5000,
            stake: 0,
            tasks_completed: 0,
            total_earned: 0,
        };

        let result = simulate_claim_task(&mut task, &mut worker, 100);

        let has_required = (worker_caps & required_caps) == required_caps;

        if !has_required {
            prop_assert!(result.is_error(),
                "Should fail without required capabilities. required={:#x}, worker={:#x}",
                required_caps, worker_caps);
        }
    }
}

#[cfg(test)]
mod edge_cases {
    use super::*;

    #[test]
    fn test_claim_open_task() {
        let mut task = SimulatedTask {
            status: task_status::OPEN,
            max_workers: 1,
            ..Default::default()
        };

        let mut worker = SimulatedAgent {
            status: 1,
            capabilities: 0xFF,
            ..Default::default()
        };

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_success());
    }

    #[test]
    fn test_claim_in_progress_task() {
        let mut task = SimulatedTask {
            status: task_status::IN_PROGRESS,
            max_workers: 5,
            current_workers: 1,
            ..Default::default()
        };

        let mut worker = SimulatedAgent {
            status: 1,
            capabilities: 0xFF,
            ..Default::default()
        };

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_success());
    }

    #[test]
    fn test_claim_completed_task_fails() {
        let mut task = SimulatedTask {
            status: task_status::COMPLETED,
            max_workers: 5,
            ..Default::default()
        };

        let mut worker = SimulatedAgent {
            status: 1,
            capabilities: 0xFF,
            ..Default::default()
        };

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_error());
    }

    #[test]
    fn test_claim_cancelled_task_fails() {
        let mut task = SimulatedTask {
            status: task_status::CANCELLED,
            max_workers: 5,
            ..Default::default()
        };

        let mut worker = SimulatedAgent {
            status: 1,
            capabilities: 0xFF,
            ..Default::default()
        };

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_error());
    }

    #[test]
    fn test_claim_inactive_worker_fails() {
        let mut task = SimulatedTask {
            status: task_status::OPEN,
            max_workers: 5,
            ..Default::default()
        };

        let mut worker = SimulatedAgent {
            status: 0, // Inactive
            capabilities: 0xFF,
            ..Default::default()
        };

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_error());
    }

    #[test]
    fn test_claim_max_active_tasks_fails() {
        let mut task = SimulatedTask {
            status: task_status::OPEN,
            max_workers: 5,
            ..Default::default()
        };

        let mut worker = SimulatedAgent {
            status: 1,
            capabilities: 0xFF,
            active_tasks: 10, // At limit
            ..Default::default()
        };

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_error());
    }
}
