//! Fuzz target for resolve_dispute instruction
//!
//! Tests invariants:
//! - D1: Dispute state machine (Active -> Resolved)
//! - D3: Resolution requires voting deadline passed
//! - D4: Threshold-based resolution
//! - E3: Distribution bounded by deposit
//! - E4: Single closure
//! - T1: Valid task state transitions
//!
//! Run with: cargo test --release -p agenc-coordination-fuzz resolve_dispute

use crate::*;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    /// Fuzz resolve_dispute with arbitrary inputs
    #[test]
    fn fuzz_resolve_dispute(input in any::<ResolveDisputeInput>()) {
        // Ensure we have at least one vote
        let votes_for = input.votes_for.max(1);
        let escrow_distributed = input.escrow_distributed.min(input.escrow_amount);

        let mut dispute = SimulatedDispute {
            dispute_id: input.dispute_id,
            status: dispute_status::ACTIVE,
            resolution_type: input.resolution_type.min(2),
            votes_for,
            votes_against: input.votes_against,
            total_voters: votes_for.saturating_add(input.votes_against),
            voting_deadline: input.voting_deadline,
        };

        let mut task = SimulatedTask {
            task_id: [0u8; 32],
            status: task_status::DISPUTED,
            reward_amount: input.escrow_amount,
            max_workers: 1,
            current_workers: 1,
            required_capabilities: 0,
            deadline: 0,
            completions: 0,
            required_completions: 1,
            task_type: 0,
        };

        let mut escrow = SimulatedEscrow {
            amount: input.escrow_amount,
            distributed: escrow_distributed,
            is_closed: false,
        };

        let config = SimulatedConfig {
            dispute_threshold: input.dispute_threshold.max(1).min(100),
            ..Default::default()
        };

        // Use timestamp after deadline
        let current_time = input.voting_deadline.saturating_add(1);

        // Store old status values for invariant verification logging
        let _old_dispute_status = dispute.status;
        let _old_task_status = task.status;

        let result = simulate_resolve_dispute(
            &mut dispute,
            &mut task,
            &mut escrow,
            &config,
            current_time,
        );

        // Should never have invariant violations
        prop_assert!(!result.is_invariant_violation(),
            "Invariant violation: {:?}", result);

        if result.is_success() {
            // D1: Dispute should be resolved
            prop_assert!(dispute.status == dispute_status::RESOLVED,
                "D1 violated: dispute status is {} not RESOLVED",
                dispute.status);

            // T1: Task should be in terminal state
            prop_assert!(
                task.status == task_status::COMPLETED || task.status == task_status::CANCELLED,
                "T1 violated: task status {} is not terminal",
                task.status);

            // E4: Escrow should be closed
            prop_assert!(escrow.is_closed,
                "E4 violated: escrow not closed after resolution");

            // E3: Distribution bounded
            prop_assert!(escrow.distributed <= escrow.amount,
                "E3 violated: distributed {} > amount {}",
                escrow.distributed, escrow.amount);
        }
    }

    /// Test resolution timing enforcement
    #[test]
    fn fuzz_resolution_timing(
        voting_deadline in 1i64..i64::MAX/2,
        current_time in 0i64..i64::MAX,
    ) {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            votes_for: 1,
            votes_against: 0,
            total_voters: 1,
            voting_deadline,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let config = SimulatedConfig::default();

        let result = simulate_resolve_dispute(
            &mut dispute,
            &mut task,
            &mut escrow,
            &config,
            current_time,
        );

        // D3: If before deadline, should fail
        if current_time < voting_deadline {
            prop_assert!(result.is_error(),
                "D3 violated: resolution succeeded before deadline. time={}, deadline={}",
                current_time, voting_deadline);
        }
    }

    /// Test threshold-based approval
    #[test]
    fn fuzz_threshold_approval(
        votes_for in 0u8..=100u8,
        votes_against in 0u8..=100u8,
        threshold in 1u8..=100u8,
    ) {
        // Need at least one vote
        let votes_for = votes_for.max(1);

        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            resolution_type: 1, // Complete
            votes_for,
            votes_against,
            total_voters: votes_for.saturating_add(votes_against),
            voting_deadline: 100,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let config = SimulatedConfig {
            dispute_threshold: threshold,
            ..Default::default()
        };

        let result = simulate_resolve_dispute(
            &mut dispute,
            &mut task,
            &mut escrow,
            &config,
            200,
        );

        prop_assert!(!result.is_invariant_violation(),
            "Invariant violation: {:?}", result);

        if result.is_success() {
            let total = votes_for.checked_add(votes_against)
                .expect("Vote total overflow in test") as u64;
            // Guard against division by zero (though total should always be > 0 here)
            let approval_pct = if total > 0 {
                (votes_for as u64 * 100) / total
            } else {
                0
            };
            let should_approve = approval_pct >= threshold as u64;

            // D4: Task status should match threshold result
            if should_approve {
                // Resolution type 1 = Complete
                prop_assert!(task.status == task_status::COMPLETED,
                    "D4 violated: approved but task not completed. pct={}, threshold={}",
                    approval_pct, threshold);
            } else {
                prop_assert!(task.status == task_status::CANCELLED,
                    "D4 violated: rejected but task not cancelled. pct={}, threshold={}",
                    approval_pct, threshold);
            }
        }
    }

    /// Test all resolution types
    #[test]
    fn fuzz_resolution_types(
        resolution_type in 0u8..=2u8,
        amount in 1u64..u64::MAX/2,
        distributed in 0u64..u64::MAX/2,
    ) {
        let distributed = distributed.min(amount.saturating_sub(1));

        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            resolution_type,
            votes_for: 10,
            votes_against: 1,
            total_voters: 11,
            voting_deadline: 100,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount,
            distributed,
            is_closed: false,
        };

        let config = SimulatedConfig {
            dispute_threshold: 50,
            ..Default::default()
        };

        let result = simulate_resolve_dispute(
            &mut dispute,
            &mut task,
            &mut escrow,
            &config,
            200,
        );

        prop_assert!(!result.is_invariant_violation(),
            "Invariant violation with resolution_type={}: {:?}",
            resolution_type, result);

        if result.is_success() {
            // E3: All funds should be accounted for
            prop_assert!(escrow.distributed <= escrow.amount,
                "E3 violated: distributed {} > amount {}",
                escrow.distributed, escrow.amount);
        }
    }
}

#[cfg(test)]
mod edge_cases {
    use super::*;

    #[test]
    fn test_resolve_refund() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            resolution_type: 0, // Refund
            votes_for: 10,
            votes_against: 1,
            total_voters: 11,
            voting_deadline: 100,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let config = SimulatedConfig {
            dispute_threshold: 50,
            ..Default::default()
        };

        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &config, 200);
        assert!(result.is_success());
        assert_eq!(task.status, task_status::CANCELLED);
        assert!(escrow.is_closed);
    }

    #[test]
    fn test_resolve_complete() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            resolution_type: 1, // Complete
            votes_for: 10,
            votes_against: 1,
            total_voters: 11,
            voting_deadline: 100,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let config = SimulatedConfig {
            dispute_threshold: 50,
            ..Default::default()
        };

        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &config, 200);
        assert!(result.is_success());
        assert_eq!(task.status, task_status::COMPLETED);
    }

    #[test]
    fn test_resolve_split() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            resolution_type: 2, // Split
            votes_for: 10,
            votes_against: 1,
            total_voters: 11,
            voting_deadline: 100,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let config = SimulatedConfig {
            dispute_threshold: 50,
            ..Default::default()
        };

        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &config, 200);
        assert!(result.is_success());
        assert_eq!(task.status, task_status::CANCELLED);
    }

    #[test]
    fn test_resolve_rejected() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            resolution_type: 1, // Complete (but will be rejected)
            votes_for: 1,
            votes_against: 10, // Majority against
            total_voters: 11,
            voting_deadline: 100,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let config = SimulatedConfig {
            dispute_threshold: 50,
            ..Default::default()
        };

        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &config, 200);
        assert!(result.is_success());
        // Rejected = refund to creator
        assert_eq!(task.status, task_status::CANCELLED);
    }

    #[test]
    fn test_resolve_no_votes_fails() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            resolution_type: 0,
            votes_for: 0,
            votes_against: 0,
            total_voters: 0,
            voting_deadline: 100,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let config = SimulatedConfig::default();

        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &config, 200);
        assert!(result.is_error());
    }

    #[test]
    fn test_resolve_before_deadline_fails() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            votes_for: 10,
            votes_against: 1,
            total_voters: 11,
            voting_deadline: 1000,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let config = SimulatedConfig::default();

        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &config, 500);
        assert!(result.is_error());
    }

    #[test]
    fn test_resolve_already_resolved_fails() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::RESOLVED,
            votes_for: 10,
            votes_against: 1,
            total_voters: 11,
            voting_deadline: 100,
            ..Default::default()
        };

        let mut task = SimulatedTask {
            status: task_status::DISPUTED,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let config = SimulatedConfig::default();

        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &config, 200);
        assert!(result.is_error());
    }
}
