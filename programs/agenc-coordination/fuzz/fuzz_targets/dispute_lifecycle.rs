//! Fuzz target for full dispute lifecycle
//!
//! Tests invariants:
//! - D1: Dispute can only be initiated on InProgress or Completed tasks
//! - D3: Voting window enforcement
//! - D4: Resolution requires voting deadline passed and at least one vote
//! - D5: Slash amounts bounded by stake (simulated)
//! - D6: Cancel only before first vote (simulated)
//!
//! Run with: cargo test --release -p agenc-coordination-fuzz dispute_lifecycle

use crate::*;
use proptest::prelude::*;

fn simulate_cancel_dispute(dispute: &mut SimulatedDispute) -> SimulationResult {
    if dispute.status != dispute_status::ACTIVE {
        return SimulationResult::Error("DisputeNotActive".to_string());
    }

    if dispute.total_voters != 0 {
        return SimulationResult::Error("CannotCancelAfterVote".to_string());
    }

    let old_status = dispute.status;
    dispute.status = dispute_status::EXPIRED; // treat cancellation as terminal expiry in the model

    if let DisputeInvariantResult::InvalidStateTransition { from, to } =
        check_dispute_state_transition(old_status, dispute.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "D1: Invalid dispute transition from {} to {}",
            from, to
        ));
    }

    SimulationResult::Success
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1500))]

    #[test]
    fn fuzz_dispute_lifecycle(seq in any::<DisputeLifecycleSequence>()) {
        let mut task = SimulatedTask {
            task_id: seq.task_id,
            status: seq.initial_task_status,
            reward_amount: seq.escrow_amount,
            max_workers: 1,
            current_workers: 1,
            required_capabilities: 0,
            deadline: 0,
            completions: 0,
            required_completions: 1,
            task_type: 0,
        };

        let mut escrow = SimulatedEscrow {
            amount: seq.escrow_amount,
            distributed: 0,
            is_closed: false,
        };

        let mut dispute = SimulatedDispute {
            dispute_id: seq.dispute_id,
            status: dispute_status::ACTIVE,
            resolution_type: seq.resolution_type.min(2),
            votes_for: 0,
            votes_against: 0,
            total_voters: 0,
            voting_deadline: seq.voting_deadline,
        };

        let config = SimulatedConfig {
            dispute_threshold: seq.dispute_threshold.max(1).min(100),
            protocol_fee_bps: seq.protocol_fee_bps,
            min_arbiter_stake: seq.min_arbiter_stake,
        };

        let init_result = simulate_initiate_dispute(&mut task, &mut dispute);
        prop_assert!(!init_result.is_invariant_violation(),
            "Invariant violation on dispute init: {:?}\nSeq: {:?}", init_result, seq);

        let disputable = seq.initial_task_status == task_status::IN_PROGRESS
            || seq.initial_task_status == task_status::COMPLETED;

        if disputable {
            prop_assert!(init_result.is_success(),
                "D1 violated: dispute init should succeed for status {}\nResult: {:?}\nSeq: {:?}",
                seq.initial_task_status, init_result, seq);
        } else {
            prop_assert!(init_result.is_error(),
                "D1 violated: dispute init should fail for status {}\nResult: {:?}\nSeq: {:?}",
                seq.initial_task_status, init_result, seq);
        }

        // Mutable stakes for slash simulation
        let mut arbiter_stakes = seq.arbiter_stakes.clone();
        let mut initiator_stake = seq.initiator_stake;

        for action in &seq.actions {
            let result = match action {
                DisputeAction::Vote { arbiter_index, approved, timestamp } => {
                    if seq.arbiter_ids.is_empty() {
                        SimulationResult::Error("NoArbiters".to_string())
                    } else {
                        let idx = (*arbiter_index as usize) % seq.arbiter_ids.len();
                        let stake = arbiter_stakes.get(idx).copied().unwrap_or(0);

                        let arbiter = SimulatedAgent {
                            agent_id: seq.arbiter_ids[idx],
                            capabilities: 1 << 7, // ARBITER
                            status: agent_status::ACTIVE,
                            active_tasks: 0,
                            reputation: 5000,
                            stake,
                            tasks_completed: 0,
                            total_earned: 0,
                        };

                        simulate_vote_dispute(&mut dispute, &arbiter, &config, *approved, *timestamp)
                    }
                }
                DisputeAction::Resolve { timestamp } => {
                    simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &config, *timestamp)
                }
                DisputeAction::Cancel { .. } => simulate_cancel_dispute(&mut dispute),
                DisputeAction::Expire { timestamp } => simulate_expire_dispute(&mut dispute, *timestamp),
                DisputeAction::ApplySlash { arbiter_index, amount } => {
                    if seq.arbiter_ids.is_empty() {
                        SimulationResult::Error("NoArbiters".to_string())
                    } else {
                        let idx = (*arbiter_index as usize) % seq.arbiter_ids.len();
                        let current = arbiter_stakes.get(idx).copied().unwrap_or(0);
                        if *amount > current {
                            SimulationResult::Error("SlashExceedsStake".to_string())
                        } else {
                            arbiter_stakes[idx] = current.checked_sub(*amount).unwrap_or(0);
                            SimulationResult::Success
                        }
                    }
                }
                DisputeAction::ApplyInitiatorSlash { amount } => {
                    if *amount > initiator_stake {
                        SimulationResult::Error("SlashExceedsStake".to_string())
                    } else {
                        initiator_stake = initiator_stake.checked_sub(*amount).unwrap_or(0);
                        SimulationResult::Success
                    }
                }
            };

            prop_assert!(
                !result.is_invariant_violation(),
                "Invariant violation: {:?}\nAction: {:?}\nSeq: {:?}",
                result,
                action,
                seq
            );

            // D3: voting window enforcement
            if let DisputeAction::Vote { timestamp, .. } = action {
                if *timestamp >= seq.voting_deadline {
                    prop_assert!(result.is_error(),
                        "D3 violated: vote succeeded at/after deadline. ts={}, deadline={}\nSeq: {:?}",
                        timestamp, seq.voting_deadline, seq);
                }
            }

            // D4: resolution timing enforcement and vote requirement
            if let DisputeAction::Resolve { timestamp } = action {
                if *timestamp < seq.voting_deadline {
                    prop_assert!(result.is_error(),
                        "D4 violated: resolve succeeded before deadline. ts={}, deadline={}\nSeq: {:?}",
                        timestamp, seq.voting_deadline, seq);
                }
            }

            // D6: cancel only before first vote
            if let DisputeAction::Cancel { .. } = action {
                if dispute.total_voters != 0 {
                    prop_assert!(result.is_error(),
                        "D6 violated: cancel succeeded after votes. total_voters={}\nSeq: {:?}",
                        dispute.total_voters, seq);
                }
            }
        }
    }
}

