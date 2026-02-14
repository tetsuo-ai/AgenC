//! Fuzz target for dispute timing boundaries
//!
//! Tests timing-sensitive invariants:
//! - Vote exactly at deadline boundary (timestamp == voting_deadline) must fail
//! - Vote after deadline must fail
//! - Resolution before deadline must fail
//! - Expiration timing boundaries
//! - Claim expiry timing boundaries
//!
//! Run with: cargo test --release -p agenc-coordination-fuzz dispute_timing

use crate::*;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn fuzz_dispute_timing(input in any::<DisputeTimingInput>()) {
        let mut dispute = SimulatedDispute {
            dispute_id: [0u8; 32],
            status: dispute_status::ACTIVE,
            resolution_type: 1,
            votes_for: 0,
            votes_against: 0,
            total_voters: 0,
            voting_deadline: input.voting_deadline,
        };

        let arbiter = SimulatedAgent {
            agent_id: [1u8; 32],
            capabilities: 1 << 7, // ARBITER
            status: agent_status::ACTIVE,
            active_tasks: 0,
            reputation: 5000,
            stake: 1_000_000,
            tasks_completed: 0,
            total_earned: 0,
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 0,
            ..Default::default()
        };

        for &vote_ts in &input.vote_timestamps {
            let result = simulate_vote_dispute(
                &mut dispute,
                &arbiter,
                &config,
                true,
                vote_ts,
            );

            prop_assert!(
                !result.is_invariant_violation(),
                "Invariant violation on vote: {:?}\nInput: {:?}",
                result,
                input
            );

            // Votes at/after deadline must fail
            if vote_ts >= input.voting_deadline {
                prop_assert!(
                    result.is_error(),
                    "Vote succeeded at/after deadline. ts={}, deadline={}\nInput: {:?}",
                    vote_ts,
                    input.voting_deadline,
                    input
                );
            }
        }

        // Attempt resolution
        let mut task = SimulatedTask {
            task_id: [2u8; 32],
            status: task_status::DISPUTED,
            reward_amount: 1_000_000,
            max_workers: 1,
            current_workers: 1,
            required_capabilities: 0,
            deadline: 0,
            completions: 0,
            required_completions: 1,
            task_type: 0,
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let resolve_result = simulate_resolve_dispute(
            &mut dispute,
            &mut task,
            &mut escrow,
            &config,
            input.resolution_timestamp,
        );

        prop_assert!(
            !resolve_result.is_invariant_violation(),
            "Invariant violation on resolve: {:?}\nInput: {:?}",
            resolve_result,
            input
        );

        if input.resolution_timestamp < input.voting_deadline {
            prop_assert!(
                resolve_result.is_error(),
                "Resolution succeeded before deadline. ts={}, deadline={}\nInput: {:?}",
                input.resolution_timestamp,
                input.voting_deadline,
                input
            );
        }

        // Attempt expiry (only enforce timing assertion if dispute is still ACTIVE)
        let was_active = dispute.status == dispute_status::ACTIVE;
        let expiry_result = simulate_expire_dispute(&mut dispute, input.expiry_timestamp);

        prop_assert!(
            !expiry_result.is_invariant_violation(),
            "Invariant violation on expiry: {:?}\nInput: {:?}",
            expiry_result,
            input
        );

        if was_active && input.expiry_timestamp < input.voting_deadline {
            prop_assert!(
                expiry_result.is_error(),
                "Dispute expired before deadline. ts={}, deadline={}\nInput: {:?}",
                input.expiry_timestamp,
                input.voting_deadline,
                input
            );
        }

        // Claim expiry timing
        let mut claim_task = SimulatedTask {
            task_id: [3u8; 32],
            status: task_status::IN_PROGRESS,
            reward_amount: 1,
            max_workers: 1,
            current_workers: 1,
            required_capabilities: 0,
            deadline: input.claim_deadline,
            completions: 0,
            required_completions: 1,
            task_type: 0,
        };

        let mut worker = SimulatedAgent {
            agent_id: [4u8; 32],
            capabilities: 0xFF,
            status: agent_status::ACTIVE,
            active_tasks: 1,
            reputation: 5000,
            stake: 0,
            tasks_completed: 0,
            total_earned: 0,
        };

        let claim_expiry_result = simulate_expire_claim(
            &mut claim_task,
            &mut worker,
            input.claim_expiry_timestamp,
        );

        prop_assert!(
            !claim_expiry_result.is_invariant_violation(),
            "Invariant violation on claim expiry: {:?}\nInput: {:?}",
            claim_expiry_result,
            input
        );

        let should_expire_claim = input.claim_deadline > 0
            && input.claim_expiry_timestamp >= input.claim_deadline;

        if should_expire_claim {
            prop_assert!(
                claim_expiry_result.is_success(),
                "Claim expiry should succeed. expiry_ts={}, deadline={}\nInput: {:?}",
                input.claim_expiry_timestamp,
                input.claim_deadline,
                input
            );
        } else {
            prop_assert!(
                claim_expiry_result.is_error(),
                "Claim expiry should fail. expiry_ts={}, deadline={}\nInput: {:?}",
                input.claim_expiry_timestamp,
                input.claim_deadline,
                input
            );
        }
    }
}

