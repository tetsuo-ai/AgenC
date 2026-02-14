//! Fuzz target for full task lifecycle state transitions
//!
//! Tests invariants:
//! - T1: Valid state transitions across claim/complete/cancel/dispute
//! - T2: No claim/complete/cancel/expire from terminal states
//! - T6: Suspended agent cannot claim or complete
//!
//! Run with: cargo test --release -p agenc-coordination-fuzz task_lifecycle

use crate::*;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn fuzz_task_lifecycle(seq in any::<TaskLifecycleSequence>()) {
        let deadline = seq.current_timestamp.checked_add(seq.deadline_offset).unwrap_or(0);

        let mut task = SimulatedTask {
            task_id: seq.task_id,
            status: task_status::OPEN,
            reward_amount: seq.reward_amount,
            max_workers: seq.max_workers.max(1),
            current_workers: 0,
            required_capabilities: seq.task_required_capabilities,
            deadline,
            completions: 0,
            required_completions: seq.required_completions.max(1),
            task_type: seq.task_type.min(2),
        };

        let mut escrow = SimulatedEscrow {
            amount: seq.reward_amount,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = SimulatedAgent {
            agent_id: seq.worker_id,
            capabilities: seq.worker_capabilities,
            status: seq.worker_status.min(agent_status::SUSPENDED),
            active_tasks: 0,
            reputation: 5000,
            stake: 1_000_000,
            tasks_completed: 0,
            total_earned: 0,
        };

        let config = SimulatedConfig {
            protocol_fee_bps: seq.protocol_fee_bps,
            ..Default::default()
        };

        let mut dispute = SimulatedDispute {
            dispute_id: [0u8; 32],
            status: dispute_status::ACTIVE,
            resolution_type: 0,
            votes_for: 0,
            votes_against: 0,
            total_voters: 0,
            voting_deadline: seq.current_timestamp.saturating_add(10),
        };

        for action in &seq.actions {
            let prev_task_status = task.status;

            let result = match action {
                LifecycleAction::Claim => simulate_claim_task(&mut task, &mut worker, seq.current_timestamp),
                LifecycleAction::Complete { proof_hash } => {
                    simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, *proof_hash)
                }
                LifecycleAction::Cancel => simulate_cancel_task(&mut task, &mut escrow),
                LifecycleAction::ExpireClaim => simulate_expire_claim(&mut task, &mut worker, seq.current_timestamp),
                LifecycleAction::InitiateDispute { dispute_id } => {
                    dispute.dispute_id = *dispute_id;
                    simulate_initiate_dispute(&mut task, &mut dispute)
                }
            };

            // Should never have invariant violations
            prop_assert!(
                !result.is_invariant_violation(),
                "Invariant violation: {:?}\nSeq: {:?}",
                result,
                seq
            );

            // Terminal state restrictions:
            // - Cancelled is terminal for all actions
            // - Completed is terminal for all task actions, but may allow dispute initiation
            if prev_task_status == task_status::CANCELLED {
                prop_assert!(
                    !result.is_success(),
                    "Action succeeded from Cancelled state.\nAction: {:?}\nSeq: {:?}",
                    action,
                    seq
                );
            }

            if prev_task_status == task_status::COMPLETED {
                match action {
                    LifecycleAction::InitiateDispute { .. } => {}
                    _ => prop_assert!(
                        !result.is_success(),
                        "Action succeeded from Completed state.\nAction: {:?}\nSeq: {:?}",
                        action,
                        seq
                    ),
                }
            }

            // T6: Suspended worker cannot claim or complete
            if worker.status == agent_status::SUSPENDED {
                match action {
                    LifecycleAction::Claim | LifecycleAction::Complete { .. } => {
                        prop_assert!(
                            result.is_error(),
                            "Suspended agent action should fail.\nAction: {:?}\nResult: {:?}\nSeq: {:?}",
                            action,
                            result,
                            seq
                        );
                    }
                    _ => {}
                }
            }
        }
    }
}

