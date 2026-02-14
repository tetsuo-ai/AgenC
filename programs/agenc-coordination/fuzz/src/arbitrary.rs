//! Arbitrary input generators for fuzz testing
//!
//! Generates random but valid inputs for testing protocol instructions.

use proptest::prelude::*;

/// Arbitrary 32-byte identifier (task_id, agent_id, dispute_id, pubkey, etc.)
pub fn arb_id() -> impl Strategy<Value = [u8; 32]> {
    prop::array::uniform32(any::<u8>())
}

/// Arbitrary 64-byte data (description, result_data, etc.)
pub fn arb_data_64() -> impl Strategy<Value = [u8; 64]> {
    prop::array::uniform32(any::<u8>())
        .prop_flat_map(|a| prop::array::uniform32(any::<u8>()).prop_map(move |b| {
            let mut result = [0u8; 64];
            result[..32].copy_from_slice(&a);
            result[32..].copy_from_slice(&b);
            result
        }))
}

/// Arbitrary reward amount with edge cases
/// Tests: 0, 1, small values, large values, u64::MAX
pub fn arb_reward_amount() -> impl Strategy<Value = u64> {
    prop_oneof![
        // Edge cases (20% of tests)
        Just(0u64),
        Just(1u64),
        Just(u64::MAX),
        Just(u64::MAX - 1),
        Just(u64::MAX / 2),
        // Small amounts (30% of tests)
        1_000u64..1_000_000u64,
        // Typical amounts (30% of tests)
        1_000_000u64..1_000_000_000u64,
        // Large amounts (20% of tests)
        1_000_000_000u64..u64::MAX / 2,
    ]
}

/// Arbitrary malformed reward amounts for corpus-style edge case emphasis
pub fn arb_malformed_reward() -> impl Strategy<Value = u64> {
    prop_oneof![
        Just(0u64),
        Just(1u64),
        Just(u64::MAX),
        Just(u64::MAX - 1),
        (1u64..100u64),
    ]
}

/// Arbitrary protocol fee in basis points (0-10000)
pub fn arb_protocol_fee_bps() -> impl Strategy<Value = u16> {
    prop_oneof![
        // Edge cases
        Just(0u16),
        Just(1u16),
        Just(10000u16),  // 100%
        Just(9999u16),
        // Typical values
        1u16..100u16,     // 0.01% - 1%
        100u16..1000u16,  // 1% - 10%
    ]
}

/// Arbitrary reputation value (0-10000)
pub fn arb_reputation() -> impl Strategy<Value = u16> {
    prop_oneof![
        // Edge cases
        Just(0u16),
        Just(10000u16),
        Just(5000u16),  // Initial reputation
        // Random values
        0u16..10000u16,
    ]
}

/// Arbitrary capability bitmask
pub fn arb_capabilities() -> impl Strategy<Value = u64> {
    prop_oneof![
        // Single capabilities
        Just(1u64 << 0),  // COMPUTE
        Just(1u64 << 1),  // INFERENCE
        Just(1u64 << 7),  // ARBITER
        // Combined capabilities
        Just((1u64 << 0) | (1u64 << 1)),  // COMPUTE + INFERENCE
        Just((1u64 << 7) | (1u64 << 0)),  // ARBITER + COMPUTE
        // All capabilities
        Just((1u64 << 10) - 1),
        // Random combinations
        0u64..((1u64 << 10) - 1),
    ]
}

/// Arbitrary malformed capability masks (0, high bits, max)
pub fn arb_malformed_capabilities() -> impl Strategy<Value = u64> {
    prop_oneof![
        Just(0u64),
        Just(u64::MAX),
        Just(1u64 << 63),
        (0u64..1024u64),
    ]
}

/// Arbitrary worker count (1-255)
pub fn arb_worker_count() -> impl Strategy<Value = u8> {
    prop_oneof![
        Just(1u8),
        Just(10u8),
        Just(255u8),
        1u8..=255u8,
    ]
}

/// Arbitrary timestamp (seconds since Unix epoch)
pub fn arb_timestamp() -> impl Strategy<Value = i64> {
    prop_oneof![
        // Past timestamps
        Just(0i64),
        Just(1_000_000_000i64),  // 2001
        // Current-ish timestamps
        1_700_000_000i64..1_800_000_000i64,
        // Far future
        Just(i64::MAX),
        Just(i64::MAX / 2),
    ]
}

/// Arbitrary deadline (0 = no deadline, or future timestamp)
pub fn arb_deadline() -> impl Strategy<Value = i64> {
    prop_oneof![
        Just(0i64),  // No deadline
        1_700_000_000i64..1_900_000_000i64,  // Future deadline
        Just(i64::MAX),
    ]
}

/// Arbitrary malformed deadlines (negative, min/max, near-term)
pub fn arb_malformed_deadline() -> impl Strategy<Value = i64> {
    prop_oneof![
        Just(0i64),
        Just(-1i64),
        Just(i64::MIN),
        Just(i64::MAX),
        (0i64..100i64),
    ]
}

/// Arbitrary vote (approve/reject)
pub fn arb_vote() -> impl Strategy<Value = bool> {
    any::<bool>()
}

/// Arbitrary dispute threshold (1-100)
pub fn arb_dispute_threshold() -> impl Strategy<Value = u8> {
    prop_oneof![
        Just(1u8),
        Just(50u8),   // Typical
        Just(51u8),   // Simple majority
        Just(67u8),   // Supermajority
        Just(100u8),  // Unanimous
        1u8..=100u8,
    ]
}

/// Arbitrary stake amount
pub fn arb_stake() -> impl Strategy<Value = u64> {
    prop_oneof![
        Just(0u64),
        Just(1u64),
        Just(1_000_000u64),
        Just(u64::MAX),
        0u64..1_000_000_000u64,
    ]
}

/// Arbitrary active task count (0-10)
pub fn arb_active_tasks() -> impl Strategy<Value = u8> {
    prop_oneof![
        Just(0u8),
        Just(9u8),   // Just under limit
        Just(10u8),  // At limit
        0u8..=10u8,
    ]
}

/// Input for claim_task fuzz testing
#[derive(Debug, Clone)]
pub struct ClaimTaskInput {
    pub task_id: [u8; 32],
    pub agent_id: [u8; 32],
    pub task_reward: u64,
    pub task_max_workers: u8,
    pub task_current_workers: u8,
    pub task_required_capabilities: u64,
    pub task_deadline: i64,
    pub worker_capabilities: u64,
    pub worker_active_tasks: u8,
    pub worker_reputation: u16,
    pub current_timestamp: i64,
}

impl Arbitrary for ClaimTaskInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            arb_id(),
            arb_id(),
            arb_reward_amount(),
            arb_worker_count(),
            0u8..=255u8,
            arb_capabilities(),
            arb_deadline(),
            arb_capabilities(),
            arb_active_tasks(),
            arb_reputation(),
            arb_timestamp(),
        )
            .prop_map(|(task_id, agent_id, task_reward, task_max_workers, task_current_workers,
                       task_required_capabilities, task_deadline, worker_capabilities,
                       worker_active_tasks, worker_reputation, current_timestamp)| {
                ClaimTaskInput {
                    task_id,
                    agent_id,
                    task_reward,
                    task_max_workers,
                    task_current_workers,
                    task_required_capabilities,
                    task_deadline,
                    worker_capabilities,
                    worker_active_tasks,
                    worker_reputation,
                    current_timestamp,
                }
            })
            .boxed()
    }
}

/// Input for complete_task fuzz testing
#[derive(Debug, Clone)]
pub struct CompleteTaskInput {
    pub task_id: [u8; 32],
    pub proof_hash: [u8; 32],
    pub result_data: Option<[u8; 64]>,
    pub task_reward: u64,
    pub task_type: u8,  // 0=Exclusive, 1=Collaborative, 2=Competitive
    pub required_completions: u8,
    pub current_completions: u8,
    pub protocol_fee_bps: u16,
    pub escrow_amount: u64,
    pub escrow_distributed: u64,
    pub worker_reputation: u16,
    pub worker_total_earned: u64,
}

impl Arbitrary for CompleteTaskInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            arb_id(),
            arb_id(),
            proptest::option::of(arb_data_64()),
            arb_reward_amount(),
            0u8..=2u8,
            1u8..=255u8,
            0u8..=254u8,
            arb_protocol_fee_bps(),
            arb_reward_amount(),
            arb_reward_amount(),
            arb_reputation(),
            arb_reward_amount(),
        )
            .prop_map(|(task_id, proof_hash, result_data, task_reward, task_type,
                       required_completions, current_completions, protocol_fee_bps,
                       escrow_amount, escrow_distributed, worker_reputation, worker_total_earned)| {
                CompleteTaskInput {
                    task_id,
                    proof_hash,
                    result_data,
                    task_reward,
                    task_type,
                    required_completions,
                    current_completions,
                    protocol_fee_bps,
                    escrow_amount,
                    escrow_distributed,
                    worker_reputation,
                    worker_total_earned,
                }
            })
            .boxed()
    }
}

/// Input for vote_dispute fuzz testing
#[derive(Debug, Clone)]
pub struct VoteDisputeInput {
    pub dispute_id: [u8; 32],
    pub arbiter_id: [u8; 32],
    pub approve: bool,
    pub arbiter_stake: u64,
    pub min_arbiter_stake: u64,
    pub arbiter_capabilities: u64,
    pub current_votes_for: u8,
    pub current_votes_against: u8,
    pub voting_deadline: i64,
    pub current_timestamp: i64,
}

impl Arbitrary for VoteDisputeInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            arb_id(),
            arb_id(),
            arb_vote(),
            arb_stake(),
            arb_stake(),
            arb_capabilities(),
            0u8..=127u8,
            0u8..=127u8,
            arb_timestamp(),
            arb_timestamp(),
        )
            .prop_map(|(dispute_id, arbiter_id, approve, arbiter_stake, min_arbiter_stake,
                       arbiter_capabilities, current_votes_for, current_votes_against,
                       voting_deadline, current_timestamp)| {
                VoteDisputeInput {
                    dispute_id,
                    arbiter_id,
                    approve,
                    arbiter_stake,
                    min_arbiter_stake,
                    arbiter_capabilities,
                    current_votes_for,
                    current_votes_against,
                    voting_deadline,
                    current_timestamp,
                }
            })
            .boxed()
    }
}

/// Input for resolve_dispute fuzz testing
#[derive(Debug, Clone)]
pub struct ResolveDisputeInput {
    pub dispute_id: [u8; 32],
    pub resolution_type: u8,  // 0=Refund, 1=Complete, 2=Split
    pub votes_for: u8,
    pub votes_against: u8,
    pub dispute_threshold: u8,
    pub escrow_amount: u64,
    pub escrow_distributed: u64,
    pub voting_deadline: i64,
    pub current_timestamp: i64,
}

impl Arbitrary for ResolveDisputeInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            arb_id(),
            0u8..=2u8,
            0u8..=127u8,
            0u8..=127u8,
            arb_dispute_threshold(),
            arb_reward_amount(),
            arb_reward_amount(),
            arb_timestamp(),
            arb_timestamp(),
        )
            .prop_map(|(dispute_id, resolution_type, votes_for, votes_against,
                       dispute_threshold, escrow_amount, escrow_distributed,
                       voting_deadline, current_timestamp)| {
                ResolveDisputeInput {
                    dispute_id,
                    resolution_type,
                    votes_for,
                    votes_against,
                    dispute_threshold,
                    escrow_amount,
                    escrow_distributed,
                    voting_deadline,
                    current_timestamp,
                }
            })
            .boxed()
    }
}

// ============================================================================
// Multi-instruction / lifecycle fuzz inputs
// ============================================================================

#[derive(Debug, Clone)]
pub enum LifecycleAction {
    Claim,
    Complete { proof_hash: [u8; 32] },
    Cancel,
    ExpireClaim,
    InitiateDispute { dispute_id: [u8; 32] },
}

impl Arbitrary for LifecycleAction {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        prop_oneof![
            3 => Just(LifecycleAction::Claim),
            3 => arb_id().prop_map(|proof_hash| LifecycleAction::Complete { proof_hash }),
            2 => Just(LifecycleAction::Cancel),
            2 => Just(LifecycleAction::ExpireClaim),
            2 => arb_id().prop_map(|dispute_id| LifecycleAction::InitiateDispute { dispute_id }),
        ]
        .boxed()
    }
}

#[derive(Debug, Clone)]
pub struct TaskLifecycleSequence {
    pub task_id: [u8; 32],
    pub creator_id: [u8; 32],
    pub worker_id: [u8; 32],
    pub worker_status: u8,
    pub worker_capabilities: u64,
    pub task_required_capabilities: u64,
    pub reward_amount: u64,
    pub task_type: u8,
    pub max_workers: u8,
    pub required_completions: u8,
    pub deadline_offset: i64,
    pub current_timestamp: i64,
    pub protocol_fee_bps: u16,
    pub actions: Vec<LifecycleAction>,
}

impl Arbitrary for TaskLifecycleSequence {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            (arb_id(), arb_id(), arb_id()),
            (
                prop_oneof![Just(1u8), Just(3u8), 0u8..=3u8], // emphasize ACTIVE + SUSPENDED
                prop_oneof![arb_capabilities(), arb_malformed_capabilities()],
                prop_oneof![arb_capabilities(), arb_malformed_capabilities()],
            ),
            (
                prop_oneof![arb_reward_amount(), arb_malformed_reward()],
                0u8..=2u8,
                1u8..=10u8,
                1u8..=10u8,
            ),
            (
                prop_oneof![Just(-1i64), Just(0i64), Just(1i64), (-1_000i64..=1_000i64)],
                prop_oneof![arb_timestamp(), 0i64..1_000_000_000i64],
                arb_protocol_fee_bps(),
            ),
            prop::collection::vec(any::<LifecycleAction>(), 0..25),
        )
            .prop_map(
                |(
                    (task_id, creator_id, worker_id),
                    (worker_status, worker_capabilities, task_required_capabilities),
                    (reward_amount, task_type, max_workers, required_completions),
                    (deadline_offset, current_timestamp, protocol_fee_bps),
                    actions,
                )| TaskLifecycleSequence {
                    task_id,
                    creator_id,
                    worker_id,
                    worker_status,
                    worker_capabilities,
                    task_required_capabilities,
                    reward_amount,
                    task_type,
                    max_workers,
                    required_completions,
                    deadline_offset,
                    current_timestamp,
                    protocol_fee_bps,
                    actions,
                },
            )
            .boxed()
    }
}

#[derive(Debug, Clone)]
pub enum DisputeAction {
    Vote { arbiter_index: u8, approved: bool, timestamp: i64 },
    Resolve { timestamp: i64 },
    Cancel { timestamp: i64 },
    Expire { timestamp: i64 },
    ApplySlash { arbiter_index: u8, amount: u64 },
    ApplyInitiatorSlash { amount: u64 },
}

impl Arbitrary for DisputeAction {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        prop_oneof![
            5 => (0u8..=10u8, arb_vote(), arb_timestamp()).prop_map(|(arbiter_index, approved, timestamp)| {
                DisputeAction::Vote { arbiter_index, approved, timestamp }
            }),
            2 => arb_timestamp().prop_map(|timestamp| DisputeAction::Resolve { timestamp }),
            2 => arb_timestamp().prop_map(|timestamp| DisputeAction::Cancel { timestamp }),
            2 => arb_timestamp().prop_map(|timestamp| DisputeAction::Expire { timestamp }),
            2 => (0u8..=10u8, arb_reward_amount()).prop_map(|(arbiter_index, amount)| {
                DisputeAction::ApplySlash { arbiter_index, amount }
            }),
            1 => arb_reward_amount().prop_map(|amount| DisputeAction::ApplyInitiatorSlash { amount }),
        ]
        .boxed()
    }
}

#[derive(Debug, Clone)]
pub struct DisputeLifecycleSequence {
    pub dispute_id: [u8; 32],
    pub task_id: [u8; 32],
    pub initiator_id: [u8; 32],
    pub initiator_stake: u64,
    pub initial_task_status: u8,
    pub arbiter_ids: Vec<[u8; 32]>,
    pub arbiter_stakes: Vec<u64>,
    pub min_arbiter_stake: u64,
    pub resolution_type: u8,
    pub dispute_threshold: u8,
    pub voting_deadline: i64,
    pub escrow_amount: u64,
    pub protocol_fee_bps: u16,
    pub actions: Vec<DisputeAction>,
}

impl Arbitrary for DisputeLifecycleSequence {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            arb_id(),
            arb_id(),
            arb_id(),
            arb_stake(),
            prop_oneof![
                Just(0u8), // OPEN
                Just(1u8), // IN_PROGRESS
                Just(3u8), // COMPLETED
                Just(4u8), // CANCELLED
                Just(5u8), // DISPUTED
            ],
            1usize..=5usize,
            arb_stake(),
            0u8..=2u8,
            arb_dispute_threshold(),
            0i64..1_000_000_000i64,
            arb_reward_amount(),
            arb_protocol_fee_bps(),
        )
            .prop_flat_map(
                |(
                    dispute_id,
                    task_id,
                    initiator_id,
                    initiator_stake,
                    initial_task_status,
                    arbiter_count,
                    min_arbiter_stake,
                    resolution_type,
                    dispute_threshold,
                    voting_deadline,
                    escrow_amount,
                    protocol_fee_bps,
                )| {
                    (
                        (Just(dispute_id), Just(task_id), Just(initiator_id)),
                        (Just(initiator_stake), Just(initial_task_status)),
                        (
                            prop::collection::vec(arb_id(), arbiter_count),
                            prop::collection::vec(arb_stake(), arbiter_count),
                        ),
                        (
                            Just(min_arbiter_stake),
                            Just(resolution_type),
                            Just(dispute_threshold),
                            Just(voting_deadline),
                            Just(escrow_amount),
                            Just(protocol_fee_bps),
                        ),
                        prop::collection::vec(any::<DisputeAction>(), 0..30),
                    )
                },
            )
            .prop_map(
                |(
                    (dispute_id, task_id, initiator_id),
                    (initiator_stake, initial_task_status),
                    (arbiter_ids, arbiter_stakes),
                    (min_arbiter_stake, resolution_type, dispute_threshold, voting_deadline, escrow_amount, protocol_fee_bps),
                    actions
                )| {
                    DisputeLifecycleSequence {
                        dispute_id,
                        task_id,
                        initiator_id,
                        initiator_stake,
                        initial_task_status,
                        arbiter_ids,
                        arbiter_stakes,
                        min_arbiter_stake,
                        resolution_type,
                        dispute_threshold,
                        voting_deadline,
                        escrow_amount,
                        protocol_fee_bps,
                        actions,
                    }
                },
            )
            .boxed()
    }
}

#[derive(Debug, Clone)]
pub struct DependencyGraphInput {
    pub task_count: u8,
    pub edges: Vec<(u8, u8)>,
    pub completion_order: Vec<u8>,
}

impl Arbitrary for DependencyGraphInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            1u8..=10u8,
            prop::collection::vec((0u8..=20u8, 0u8..=20u8), 0..40),
            prop::collection::vec(0u8..=20u8, 0..40),
        )
            .prop_map(|(task_count, edges, completion_order)| DependencyGraphInput {
                task_count,
                edges,
                completion_order,
            })
            .boxed()
    }
}

#[derive(Debug, Clone)]
pub struct DisputeTimingInput {
    pub voting_deadline: i64,
    pub vote_timestamps: Vec<i64>,
    pub resolution_timestamp: i64,
    pub expiry_timestamp: i64,
    pub claim_deadline: i64,
    pub claim_expiry_timestamp: i64,
}

impl Arbitrary for DisputeTimingInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            -1_000i64..=1_000_000i64,
            prop::collection::vec(-1_000i64..=1_000_000i64, 0..20),
            -1_000i64..=1_000_000i64,
            -1_000i64..=1_000_000i64,
            -1_000i64..=1_000_000i64,
            -1_000i64..=1_000_000i64,
        )
            .prop_map(
                |(
                    voting_deadline,
                    vote_timestamps,
                    resolution_timestamp,
                    expiry_timestamp,
                    claim_deadline,
                    claim_expiry_timestamp,
                )| DisputeTimingInput {
                    voting_deadline,
                    vote_timestamps,
                    resolution_timestamp,
                    expiry_timestamp,
                    claim_deadline,
                    claim_expiry_timestamp,
                },
            )
            .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    proptest! {
        #[test]
        fn test_arb_reward_generates_valid_values(reward in arb_reward_amount()) {
            // All u64 values are valid
            let _ = reward;
        }

        #[test]
        fn test_arb_reputation_within_bounds(rep in arb_reputation()) {
            prop_assert!(rep <= 10000);
        }

        #[test]
        fn test_arb_dispute_threshold_within_bounds(threshold in arb_dispute_threshold()) {
            prop_assert!(threshold >= 1 && threshold <= 100);
        }

        #[test]
        fn test_claim_task_input_generates(input in any::<ClaimTaskInput>()) {
            // Ensure input is generated without panicking
            let _ = input.task_id;
            let _ = input.worker_capabilities;
        }

        #[test]
        fn test_complete_task_input_generates(input in any::<CompleteTaskInput>()) {
            prop_assert!(input.task_type <= 2);
            prop_assert!(input.required_completions >= 1);
        }

        #[test]
        fn test_task_lifecycle_sequence_generates(_seq in any::<TaskLifecycleSequence>()) {
        }

        #[test]
        fn test_dispute_lifecycle_sequence_generates(_seq in any::<DisputeLifecycleSequence>()) {
        }

        #[test]
        fn test_dependency_graph_input_generates(_input in any::<DependencyGraphInput>()) {
        }

        #[test]
        fn test_dispute_timing_input_generates(_input in any::<DisputeTimingInput>()) {
        }
    }
}
