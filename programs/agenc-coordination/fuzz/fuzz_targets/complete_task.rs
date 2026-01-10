//! Fuzz target for complete_task instruction
//!
//! Tests invariants:
//! - E1: Escrow balance conservation
//! - E2: Monotonic distribution
//! - E3: Distribution bounded by deposit
//! - E4: Single closure
//! - R1: Reputation bounds (0-10000)
//! - R3: Reputation increment rules
//! - T1: Valid state transitions
//! - T4: Completion count bounded
//!
//! Run with: cargo test --release -p agenc-coordination-fuzz complete_task

use crate::*;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    /// Fuzz complete_task with arbitrary inputs
    #[test]
    fn fuzz_complete_task(input in any::<CompleteTaskInput>()) {
        // Setup valid preconditions
        let escrow_amount = input.task_reward.max(input.escrow_amount);
        let distributed = input.escrow_distributed.min(
            escrow_amount.saturating_sub(input.task_reward)
        );

        let mut task = SimulatedTask {
            task_id: input.task_id,
            status: task_status::IN_PROGRESS,
            reward_amount: input.task_reward,
            max_workers: 10,
            current_workers: 1,
            required_capabilities: 0,
            deadline: 0,
            completions: input.current_completions.min(input.required_completions.saturating_sub(1)),
            required_completions: input.required_completions.max(1),
            task_type: input.task_type.min(2),
        };

        let mut escrow = SimulatedEscrow {
            amount: escrow_amount,
            distributed,
            is_closed: false,
        };

        let mut worker = SimulatedAgent {
            agent_id: [0u8; 32],
            capabilities: 0xFF,
            status: 1,
            active_tasks: 1,
            reputation: input.worker_reputation.min(10000),
            stake: 0,
            tasks_completed: 0,
            total_earned: input.worker_total_earned,
        };

        let config = SimulatedConfig {
            protocol_fee_bps: input.protocol_fee_bps,
            ..Default::default()
        };

        let old_distributed = escrow.distributed;
        let old_reputation = worker.reputation;

        let result = simulate_complete_task(
            &mut task,
            &mut escrow,
            &mut worker,
            &config,
            input.proof_hash,
        );

        // Should never have invariant violations
        prop_assert!(!result.is_invariant_violation(),
            "Invariant violation: {:?}", result);

        if result.is_success() {
            // E2: Monotonic distribution
            prop_assert!(escrow.distributed >= old_distributed,
                "E2 violated: distribution decreased from {} to {}",
                old_distributed, escrow.distributed);

            // E3: Distribution bounded
            prop_assert!(escrow.distributed <= escrow.amount,
                "E3 violated: distributed {} > amount {}",
                escrow.distributed, escrow.amount);

            // R1: Reputation bounds
            prop_assert!(worker.reputation <= 10000,
                "R1 violated: reputation {} > 10000", worker.reputation);

            // R3: Reputation increment
            let expected_rep = old_reputation.saturating_add(100).min(10000);
            prop_assert!(worker.reputation == expected_rep,
                "R3 violated: expected {} got {}",
                expected_rep, worker.reputation);
        }
    }

    /// Test escrow distribution never exceeds amount
    #[test]
    fn fuzz_escrow_bounded(
        amount in 1u64..u64::MAX/2,
        reward in 1u64..u64::MAX/2,
        fee_bps in 0u16..=10000u16,
    ) {
        let actual_reward = reward.min(amount);

        let mut task = SimulatedTask {
            status: task_status::IN_PROGRESS,
            reward_amount: actual_reward,
            required_completions: 1,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = SimulatedAgent {
            status: 1,
            reputation: 5000,
            active_tasks: 1,
            ..Default::default()
        };

        let config = SimulatedConfig {
            protocol_fee_bps: fee_bps,
            ..Default::default()
        };

        let result = simulate_complete_task(
            &mut task,
            &mut escrow,
            &mut worker,
            &config,
            [0u8; 32],
        );

        prop_assert!(!result.is_invariant_violation(),
            "Invariant violation with amount={}, reward={}, fee={}bps: {:?}",
            amount, actual_reward, fee_bps, result);

        if result.is_success() {
            prop_assert!(escrow.distributed <= escrow.amount,
                "E3 violated: {} > {}", escrow.distributed, escrow.amount);
        }
    }

    /// Test collaborative task reward splitting
    #[test]
    fn fuzz_collaborative_rewards(
        reward in 1u64..u64::MAX/4,
        required_completions in 1u8..=100u8,
    ) {
        let mut task = SimulatedTask {
            status: task_status::IN_PROGRESS,
            reward_amount: reward,
            task_type: 1, // Collaborative
            required_completions,
            completions: 0,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: reward,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = SimulatedAgent {
            status: 1,
            reputation: 5000,
            active_tasks: 1,
            ..Default::default()
        };

        let config = SimulatedConfig::default();

        // Complete once
        let result = simulate_complete_task(
            &mut task,
            &mut escrow,
            &mut worker,
            &config,
            [0u8; 32],
        );

        prop_assert!(!result.is_invariant_violation(),
            "Invariant violation: {:?}", result);

        if result.is_success() {
            // Reward per worker should be reward / required_completions
            let expected_reward_per = reward / (required_completions as u64);
            prop_assert!(escrow.distributed <= expected_reward_per + 1,
                "Distributed {} exceeds expected {}",
                escrow.distributed, expected_reward_per);
        }
    }

    /// Test reputation never exceeds 10000
    #[test]
    fn fuzz_reputation_capped(
        initial_rep in 9900u16..=10000u16,
    ) {
        let mut task = SimulatedTask {
            status: task_status::IN_PROGRESS,
            reward_amount: 1_000_000,
            required_completions: 1,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = SimulatedAgent {
            status: 1,
            reputation: initial_rep,
            active_tasks: 1,
            ..Default::default()
        };

        let config = SimulatedConfig::default();

        let result = simulate_complete_task(
            &mut task,
            &mut escrow,
            &mut worker,
            &config,
            [0u8; 32],
        );

        prop_assert!(!result.is_invariant_violation());

        if result.is_success() {
            prop_assert!(worker.reputation <= 10000,
                "R1 violated: reputation {} > 10000", worker.reputation);
            prop_assert!(worker.reputation == 10000,
                "Should cap at 10000, got {}", worker.reputation);
        }
    }
}

#[cfg(test)]
mod edge_cases {
    use super::*;

    #[test]
    fn test_complete_with_zero_reward() {
        let mut task = SimulatedTask {
            status: task_status::IN_PROGRESS,
            reward_amount: 0,
            required_completions: 1,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 0,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = SimulatedAgent {
            status: 1,
            reputation: 5000,
            active_tasks: 1,
            ..Default::default()
        };

        let config = SimulatedConfig::default();

        let result = simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, [0u8; 32]);
        assert!(result.is_success());
        assert_eq!(escrow.distributed, 0);
    }

    #[test]
    fn test_complete_with_max_fee() {
        let mut task = SimulatedTask {
            status: task_status::IN_PROGRESS,
            reward_amount: 1_000_000,
            required_completions: 1,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = SimulatedAgent {
            status: 1,
            reputation: 5000,
            active_tasks: 1,
            ..Default::default()
        };

        let config = SimulatedConfig {
            protocol_fee_bps: 10000, // 100% fee
            ..Default::default()
        };

        let result = simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, [0u8; 32]);
        // Should succeed but worker gets 0
        assert!(result.is_success());
    }

    #[test]
    fn test_double_completion_fails() {
        let mut task = SimulatedTask {
            status: task_status::IN_PROGRESS,
            reward_amount: 1_000_000,
            required_completions: 1,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = SimulatedAgent {
            status: 1,
            reputation: 5000,
            active_tasks: 1,
            ..Default::default()
        };

        let config = SimulatedConfig::default();

        // First completion
        let result1 = simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, [0u8; 32]);
        assert!(result1.is_success());
        assert_eq!(task.status, task_status::COMPLETED);

        // Second completion should fail
        let result2 = simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, [0u8; 32]);
        assert!(result2.is_error());
    }

    #[test]
    fn test_closed_escrow_fails() {
        let mut task = SimulatedTask {
            status: task_status::IN_PROGRESS,
            reward_amount: 1_000_000,
            required_completions: 1,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: true, // Already closed
        };

        let mut worker = SimulatedAgent {
            status: 1,
            reputation: 5000,
            active_tasks: 1,
            ..Default::default()
        };

        let config = SimulatedConfig::default();

        let result = simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, [0u8; 32]);
        assert!(result.is_error());
    }
}
