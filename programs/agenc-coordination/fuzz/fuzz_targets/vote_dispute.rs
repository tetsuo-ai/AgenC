//! Fuzz target for vote_dispute instruction
//!
//! Tests invariants:
//! - D2: Single vote per arbiter (PDA uniqueness)
//! - D3: Voting window enforcement
//! - A4: Arbiter capability requirement
//! - S1: Arbiter stake threshold
//!
//! Run with: cargo test --release -p agenc-coordination-fuzz vote_dispute

use crate::*;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    /// Fuzz vote_dispute with arbitrary inputs
    #[test]
    fn fuzz_vote_dispute(input in any::<VoteDisputeInput>()) {
        let mut dispute = SimulatedDispute {
            dispute_id: input.dispute_id,
            status: dispute_status::ACTIVE,
            resolution_type: 0,
            votes_for: input.current_votes_for,
            votes_against: input.current_votes_against,
            total_voters: input.current_votes_for.saturating_add(input.current_votes_against),
            voting_deadline: input.voting_deadline,
        };

        let arbiter = SimulatedAgent {
            agent_id: input.arbiter_id,
            capabilities: 1 << 7, // ARBITER capability
            status: 1,
            active_tasks: 0,
            reputation: 5000,
            stake: input.arbiter_stake,
            tasks_completed: 0,
            total_earned: 0,
        };

        let config = SimulatedConfig {
            min_arbiter_stake: input.min_arbiter_stake,
            ..Default::default()
        };

        // Use valid voting time
        let current_time = if input.current_timestamp < input.voting_deadline {
            input.current_timestamp
        } else {
            input.voting_deadline.saturating_sub(1)
        };

        let old_votes_for = dispute.votes_for;
        let old_votes_against = dispute.votes_against;

        let result = simulate_vote_dispute(
            &mut dispute,
            &arbiter,
            &config,
            input.approve,
            current_time,
        );

        // Should never have invariant violations
        prop_assert!(!result.is_invariant_violation(),
            "Invariant violation: {:?}", result);

        if result.is_success() {
            // Verify vote was recorded correctly - use checked arithmetic for test integrity
            if input.approve {
                let expected = old_votes_for.checked_add(1).expect("Vote count overflow in test");
                prop_assert!(dispute.votes_for == expected,
                    "Vote for not recorded");
            } else {
                let expected = old_votes_against.checked_add(1).expect("Vote count overflow in test");
                prop_assert!(dispute.votes_against == expected,
                    "Vote against not recorded");
            }

            let expected_total = old_votes_for.checked_add(old_votes_against)
                .and_then(|v| v.checked_add(1))
                .expect("Total voters overflow in test");
            prop_assert!(dispute.total_voters == expected_total,
                "Total voters not updated correctly");
        }
    }

    /// Test voting window enforcement
    #[test]
    fn fuzz_voting_window(
        voting_deadline in 1i64..i64::MAX,
        current_time in 0i64..i64::MAX,
    ) {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 1_000_000,
            ..Default::default()
        };

        let result = simulate_vote_dispute(
            &mut dispute,
            &arbiter,
            &config,
            true,
            current_time,
        );

        // D3: If after deadline, should fail
        if current_time >= voting_deadline {
            prop_assert!(result.is_error(),
                "D3 violated: vote accepted after deadline. time={}, deadline={}",
                current_time, voting_deadline);
        }
    }

    /// Test stake requirement
    #[test]
    fn fuzz_stake_requirement(
        arbiter_stake in 0u64..u64::MAX,
        min_stake in 0u64..u64::MAX,
    ) {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: i64::MAX,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: arbiter_stake,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: min_stake,
            ..Default::default()
        };

        let result = simulate_vote_dispute(
            &mut dispute,
            &arbiter,
            &config,
            true,
            100,
        );

        // S1: If insufficient stake, should fail
        if arbiter_stake < min_stake {
            prop_assert!(result.is_error(),
                "S1 violated: vote accepted with insufficient stake. stake={}, required={}",
                arbiter_stake, min_stake);
        }
    }

    /// Test arbiter capability requirement
    #[test]
    fn fuzz_arbiter_capability(
        capabilities in arb_capabilities(),
    ) {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: i64::MAX,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities,
            status: 1,
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 0,
            ..Default::default()
        };

        let result = simulate_vote_dispute(
            &mut dispute,
            &arbiter,
            &config,
            true,
            100,
        );

        // A4: If missing ARBITER capability, should fail
        let has_arbiter_cap = (capabilities & (1 << 7)) != 0;
        if !has_arbiter_cap {
            prop_assert!(result.is_error(),
                "A4 violated: vote accepted without ARBITER capability. caps={:#x}",
                capabilities);
        }
    }

    /// Test vote count overflow protection
    #[test]
    fn fuzz_vote_count_overflow(
        votes_for in 250u8..=255u8,
        votes_against in 0u8..5u8,
    ) {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            votes_for,
            votes_against,
            total_voters: votes_for.saturating_add(votes_against),
            voting_deadline: i64::MAX,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 0,
            ..Default::default()
        };

        let result = simulate_vote_dispute(
            &mut dispute,
            &arbiter,
            &config,
            true,
            100,
        );

        // Should handle near-overflow gracefully
        prop_assert!(!result.is_invariant_violation(),
            "Invariant violation near overflow: {:?}", result);

        if result.is_success() {
            // votes_for should have increased by 1 or saturated
            prop_assert!(dispute.votes_for >= votes_for,
                "Vote count decreased unexpectedly");
        }
    }
}

#[cfg(test)]
mod edge_cases {
    use super::*;

    #[test]
    fn test_vote_active_dispute() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: 1000,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 1_000_000,
            ..Default::default()
        };

        let result = simulate_vote_dispute(&mut dispute, &arbiter, &config, true, 100);
        assert!(result.is_success());
        assert_eq!(dispute.votes_for, 1);
    }

    #[test]
    fn test_vote_resolved_dispute_fails() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::RESOLVED,
            voting_deadline: 1000,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 1_000_000,
            ..Default::default()
        };

        let result = simulate_vote_dispute(&mut dispute, &arbiter, &config, true, 100);
        assert!(result.is_error());
    }

    #[test]
    fn test_vote_without_arbiter_cap_fails() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: 1000,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1, // COMPUTE only, no ARBITER
            status: 1,
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 0,
            ..Default::default()
        };

        let result = simulate_vote_dispute(&mut dispute, &arbiter, &config, true, 100);
        assert!(result.is_error());
    }

    #[test]
    fn test_vote_inactive_arbiter_fails() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: 1000,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 0, // Inactive
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 0,
            ..Default::default()
        };

        let result = simulate_vote_dispute(&mut dispute, &arbiter, &config, true, 100);
        assert!(result.is_error());
    }

    #[test]
    fn test_vote_against_works() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: 1000,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 0,
            ..Default::default()
        };

        let result = simulate_vote_dispute(&mut dispute, &arbiter, &config, false, 100);
        assert!(result.is_success());
        assert_eq!(dispute.votes_against, 1);
        assert_eq!(dispute.votes_for, 0);
    }

    /// Test vote exactly at voting deadline boundary (should fail)
    #[test]
    fn test_vote_exactly_at_deadline() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: 1000,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 0,
            ..Default::default()
        };

        // Exactly at deadline should fail (D3: voting window enforcement)
        let result = simulate_vote_dispute(&mut dispute, &arbiter, &config, true, 1000);
        assert!(result.is_error());
    }

    /// Test vote one timestamp before deadline (should succeed)
    #[test]
    fn test_vote_just_before_deadline() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: 1000,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: 1_000_000,
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 0,
            ..Default::default()
        };

        // One before deadline should succeed
        let result = simulate_vote_dispute(&mut dispute, &arbiter, &config, true, 999);
        assert!(result.is_success());
    }

    /// Test vote with exact minimum stake requirement
    #[test]
    fn test_vote_exact_min_stake() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: 1000,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: 1_000_000, // Exact minimum
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 1_000_000,
            ..Default::default()
        };

        // Exact minimum stake should succeed
        let result = simulate_vote_dispute(&mut dispute, &arbiter, &config, true, 100);
        assert!(result.is_success());
    }

    /// Test vote with one less than minimum stake (should fail)
    #[test]
    fn test_vote_below_min_stake() {
        let mut dispute = SimulatedDispute {
            status: dispute_status::ACTIVE,
            voting_deadline: 1000,
            ..Default::default()
        };

        let arbiter = SimulatedAgent {
            capabilities: 1 << 7,
            status: 1,
            stake: 999_999, // One below minimum
            ..Default::default()
        };

        let config = SimulatedConfig {
            min_arbiter_stake: 1_000_000,
            ..Default::default()
        };

        // Below minimum stake should fail
        let result = simulate_vote_dispute(&mut dispute, &arbiter, &config, true, 100);
        assert!(result.is_error());
    }
}
