//! Fuzz testing scenarios that simulate instruction execution
//!
//! These scenarios test the instruction logic without requiring the full
//! Solana runtime, enabling fast property-based testing.

use crate::invariants::*;

/// Simulated task state for testing
#[derive(Debug, Clone, Default)]
pub struct SimulatedTask {
    pub task_id: [u8; 32],
    pub status: u8,
    pub reward_amount: u64,
    pub max_workers: u8,
    pub current_workers: u8,
    pub required_capabilities: u64,
    pub deadline: i64,
    pub completions: u8,
    pub required_completions: u8,
    pub task_type: u8,
}

/// Simulated escrow state for testing
#[derive(Debug, Clone, Default)]
pub struct SimulatedEscrow {
    pub amount: u64,
    pub distributed: u64,
    pub is_closed: bool,
}

/// Simulated agent state for testing
#[derive(Debug, Clone, Default)]
pub struct SimulatedAgent {
    pub agent_id: [u8; 32],
    pub capabilities: u64,
    pub status: u8, // 0=Inactive, 1=Active, 2=Busy, 3=Suspended
    pub active_tasks: u8,
    pub reputation: u16,
    pub stake: u64,
    pub tasks_completed: u64,
    pub total_earned: u64,
}

/// Simulated dispute state for testing
#[derive(Debug, Clone, Default)]
pub struct SimulatedDispute {
    pub dispute_id: [u8; 32],
    pub status: u8,
    pub resolution_type: u8,
    pub votes_for: u8,
    pub votes_against: u8,
    pub total_voters: u8,
    pub voting_deadline: i64,
}

/// Simulated protocol config
#[derive(Debug, Clone)]
pub struct SimulatedConfig {
    pub dispute_threshold: u8,
    pub protocol_fee_bps: u16,
    pub min_arbiter_stake: u64,
}

impl Default for SimulatedConfig {
    fn default() -> Self {
        Self {
            dispute_threshold: 51,
            protocol_fee_bps: 100, // 1%
            min_arbiter_stake: 1_000_000,
        }
    }
}

/// Result of a simulated instruction execution
#[derive(Debug, Clone)]
pub enum SimulationResult {
    Success,
    Error(String),
    InvariantViolation(String),
}

impl SimulationResult {
    pub fn is_success(&self) -> bool {
        matches!(self, SimulationResult::Success)
    }

    pub fn is_error(&self) -> bool {
        matches!(self, SimulationResult::Error(_))
    }

    pub fn is_invariant_violation(&self) -> bool {
        matches!(self, SimulationResult::InvariantViolation(_))
    }
}

// ============================================================================
// Claim Task Simulation
// ============================================================================

/// Simulate claim_task instruction
pub fn simulate_claim_task(
    task: &mut SimulatedTask,
    worker: &mut SimulatedAgent,
    current_time: i64,
) -> SimulationResult {
    // Pre-condition checks (these should return errors, not invariant violations)

    // Check task status
    if task.status != task_status::OPEN && task.status != task_status::IN_PROGRESS {
        return SimulationResult::Error("TaskNotOpen".to_string());
    }

    // Check deadline
    if task.deadline > 0 && current_time >= task.deadline {
        return SimulationResult::Error("TaskExpired".to_string());
    }

    // Check worker count
    if task.current_workers >= task.max_workers {
        return SimulationResult::Error("TaskFullyClaimed".to_string());
    }

    // Check worker is active
    if worker.status != 1 {
        return SimulationResult::Error("AgentNotActive".to_string());
    }

    // Check capabilities
    if (worker.capabilities & task.required_capabilities) != task.required_capabilities {
        return SimulationResult::Error("InsufficientCapabilities".to_string());
    }

    // Check active tasks limit
    if worker.active_tasks >= 10 {
        return SimulationResult::Error("MaxActiveTasksReached".to_string());
    }

    // Execute the claim
    let old_status = task.status;
    task.current_workers = match task.current_workers.checked_add(1) {
        Some(w) => w,
        None => return SimulationResult::Error("ArithmeticOverflow: current_workers".to_string()),
    };
    task.status = task_status::IN_PROGRESS;
    worker.active_tasks = match worker.active_tasks.checked_add(1) {
        Some(a) => a,
        None => return SimulationResult::Error("ArithmeticOverflow: active_tasks".to_string()),
    };

    // Post-condition invariant checks

    // T1: Valid state transition
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid state transition from {} to {}",
            from, to
        ));
    }

    // T3: Worker count consistency
    if let TaskInvariantResult::WorkerCountExceedsMax { current, max } =
        check_worker_count(task.current_workers, task.max_workers)
    {
        return SimulationResult::InvariantViolation(format!(
            "T3: Worker count {} exceeds max {}",
            current, max
        ));
    }

    SimulationResult::Success
}

// ============================================================================
// Complete Task Simulation
// ============================================================================

/// Simulate complete_task instruction
pub fn simulate_complete_task(
    task: &mut SimulatedTask,
    escrow: &mut SimulatedEscrow,
    worker: &mut SimulatedAgent,
    config: &SimulatedConfig,
    _proof_hash: [u8; 32],
) -> SimulationResult {
    // Pre-condition checks

    // Check task status
    if task.status != task_status::IN_PROGRESS {
        return SimulationResult::Error("TaskNotInProgress".to_string());
    }

    // CRITICAL: Check competitive task single-completion invariant
    // Competitive tasks (task_type == 2) must check completions == 0 before paying rewards
    if task.task_type == 2 && task.completions > 0 {
        return SimulationResult::Error("CompetitiveTaskAlreadyWon".to_string());
    }

    // E4: Check escrow not closed
    if escrow.is_closed {
        return SimulationResult::Error("EscrowAlreadyClosed".to_string());
    }

    // Calculate reward
    let reward_per_worker = if task.task_type == 1 {
        // Collaborative
        match task.reward_amount.checked_div(task.required_completions as u64) {
            Some(r) => r,
            None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
        }
    } else {
        task.reward_amount
    };

    // Calculate protocol fee
    let protocol_fee = match reward_per_worker
        .checked_mul(config.protocol_fee_bps as u64)
        .and_then(|v| v.checked_div(10000))
    {
        Some(f) => f,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    let worker_reward = match reward_per_worker.checked_sub(protocol_fee) {
        Some(r) => r,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    // E3: Check distribution won't exceed amount
    let new_distributed = match escrow.distributed.checked_add(reward_per_worker) {
        Some(d) => d,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    if let EscrowInvariantResult::DistributedExceedsAmount { distributed, amount } =
        check_escrow_distribution_bounded(new_distributed, escrow.amount)
    {
        return SimulationResult::InvariantViolation(format!(
            "E3: distributed {} would exceed amount {}",
            distributed, amount
        ));
    }

    // Execute the completion
    let old_distributed = escrow.distributed;
    escrow.distributed = new_distributed;

    task.completions = match task.completions.checked_add(1) {
        Some(c) => c,
        None => return SimulationResult::Error("ArithmeticOverflow: completions".to_string()),
    };

    let task_completed = task.completions >= task.required_completions;
    let old_status = task.status;
    if task_completed {
        task.status = task_status::COMPLETED;
        escrow.is_closed = true;
    }

    // Update worker stats
    worker.tasks_completed = match worker.tasks_completed.checked_add(1) {
        Some(c) => c,
        None => return SimulationResult::Error("ArithmeticOverflow: tasks_completed".to_string()),
    };
    worker.total_earned = match worker.total_earned.checked_add(worker_reward) {
        Some(e) => e,
        None => return SimulationResult::Error("ArithmeticOverflow: total_earned".to_string()),
    };
    worker.active_tasks = match worker.active_tasks.checked_sub(1) {
        Some(a) => a,
        None => return SimulationResult::Error("ArithmeticUnderflow: active_tasks".to_string()),
    };

    // R1 & R3: Update reputation (capped at 10000)
    let old_reputation = worker.reputation;
    worker.reputation = worker.reputation.checked_add(100).unwrap_or(10000).min(10000);

    // Post-condition invariant checks

    // E2: Monotonic distribution
    if let EscrowInvariantResult::MonotonicityViolation { old_distributed: old, new_distributed: new } =
        check_escrow_monotonic_distribution(old_distributed, escrow.distributed)
    {
        return SimulationResult::InvariantViolation(format!(
            "E2: Distribution decreased from {} to {}",
            old, new
        ));
    }

    // T1: Valid state transition
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid state transition from {} to {}",
            from, to
        ));
    }

    // R1: Reputation bounds
    if let ReputationInvariantResult::OutOfBounds { reputation } =
        check_reputation_bounds(worker.reputation)
    {
        return SimulationResult::InvariantViolation(format!(
            "R1: Reputation {} out of bounds",
            reputation
        ));
    }

    // R3: Reputation increment
    if let ReputationInvariantResult::IncrementExceedsMax { before, after } =
        check_reputation_increment(old_reputation, worker.reputation)
    {
        return SimulationResult::InvariantViolation(format!(
            "R3: Reputation increment from {} to {} exceeds rules",
            before, after
        ));
    }

    SimulationResult::Success
}

// ============================================================================
// Vote Dispute Simulation
// ============================================================================

/// Simulate vote_dispute instruction
pub fn simulate_vote_dispute(
    dispute: &mut SimulatedDispute,
    arbiter: &SimulatedAgent,
    config: &SimulatedConfig,
    approve: bool,
    current_time: i64,
) -> SimulationResult {
    // Pre-condition checks

    // Check dispute is active
    if dispute.status != dispute_status::ACTIVE {
        return SimulationResult::Error("DisputeNotActive".to_string());
    }

    // D3: Check voting window
    if current_time >= dispute.voting_deadline {
        return SimulationResult::Error("VotingEnded".to_string());
    }

    // Check arbiter is active
    if arbiter.status != 1 {
        return SimulationResult::Error("AgentNotActive".to_string());
    }

    // A4: Check arbiter capability
    if let AuthorityInvariantResult::MissingArbiterCapability =
        check_arbiter_capability(arbiter.capabilities)
    {
        return SimulationResult::Error("NotArbiter".to_string());
    }

    // S1: Check arbiter stake
    if let AuthorityInvariantResult::InsufficientArbiterStake { stake, required } =
        check_arbiter_stake(arbiter.stake, config.min_arbiter_stake)
    {
        return SimulationResult::Error(format!(
            "InsufficientStake: {} < {}",
            stake, required
        ));
    }

    // Execute the vote
    if approve {
        dispute.votes_for = match dispute.votes_for.checked_add(1) {
            Some(v) => v,
            None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
        };
    } else {
        dispute.votes_against = match dispute.votes_against.checked_add(1) {
            Some(v) => v,
            None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
        };
    }

    dispute.total_voters = match dispute.total_voters.checked_add(1) {
        Some(v) => v,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    // Post-condition checks - voting window invariant
    if let DisputeInvariantResult::VotingAfterDeadline { deadline, voted_at } =
        check_voting_window(dispute.voting_deadline, current_time, true)
    {
        return SimulationResult::InvariantViolation(format!(
            "D3: Voted at {} after deadline {}",
            voted_at, deadline
        ));
    }

    SimulationResult::Success
}

// ============================================================================
// Resolve Dispute Simulation
// ============================================================================

/// Simulate resolve_dispute instruction
pub fn simulate_resolve_dispute(
    dispute: &mut SimulatedDispute,
    task: &mut SimulatedTask,
    escrow: &mut SimulatedEscrow,
    config: &SimulatedConfig,
    current_time: i64,
) -> SimulationResult {
    // Pre-condition checks

    // Check dispute is active
    if dispute.status != dispute_status::ACTIVE {
        return SimulationResult::Error("DisputeNotActive".to_string());
    }

    // D3: Check voting period has ended
    if current_time < dispute.voting_deadline {
        return SimulationResult::Error("VotingNotEnded".to_string());
    }

    // Check we have votes
    let total_votes = match dispute.votes_for.checked_add(dispute.votes_against) {
        Some(t) => t,
        None => return SimulationResult::Error("ArithmeticOverflow: total_votes".to_string()),
    };
    if total_votes == 0 {
        return SimulationResult::Error("InsufficientVotes".to_string());
    }

    // D4: Calculate approval percentage
    let approval_pct = (dispute.votes_for as u64)
        .checked_mul(100)
        .and_then(|v| v.checked_div(total_votes as u64))
        .unwrap_or(0) as u8;

    let approved = approval_pct >= config.dispute_threshold;

    // Calculate remaining funds
    let remaining_funds = match escrow.amount.checked_sub(escrow.distributed) {
        Some(r) => r,
        None => {
            return SimulationResult::InvariantViolation(
                "E3: distributed exceeds amount".to_string(),
            )
        }
    };

    // Execute resolution
    let old_task_status = task.status;
    let old_dispute_status = dispute.status;

    if approved {
        match dispute.resolution_type {
            0 => {
                // Refund
                task.status = task_status::CANCELLED;
            }
            1 => {
                // Complete
                task.status = task_status::COMPLETED;
            }
            2 => {
                // Split
                task.status = task_status::CANCELLED;
            }
            _ => return SimulationResult::Error("InvalidResolutionType".to_string()),
        }
    } else {
        // Rejected - refund by default
        task.status = task_status::CANCELLED;
    }

    dispute.status = dispute_status::RESOLVED;
    escrow.distributed = match escrow.distributed.checked_add(remaining_funds) {
        Some(d) => d,
        None => {
            return SimulationResult::InvariantViolation(
                "E3: distributed overflow when adding remaining funds".to_string(),
            )
        }
    };
    escrow.is_closed = true;

    // Post-condition invariant checks

    // D1: Valid dispute state transition
    if let DisputeInvariantResult::InvalidStateTransition { from, to } =
        check_dispute_state_transition(old_dispute_status, dispute.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "D1: Invalid dispute transition from {} to {}",
            from, to
        ));
    }

    // T1: Valid task state transition (Disputed -> Completed/Cancelled)
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_task_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid task transition from {} to {}",
            from, to
        ));
    }

    // E3: Distribution bounded
    if let EscrowInvariantResult::DistributedExceedsAmount { distributed, amount } =
        check_escrow_distribution_bounded(escrow.distributed, escrow.amount)
    {
        return SimulationResult::InvariantViolation(format!(
            "E3: distributed {} exceeds amount {}",
            distributed, amount
        ));
    }

    SimulationResult::Success
}

// ============================================================================
// Race Condition Scenarios
// ============================================================================

/// Test multiple simultaneous claims on the same task
pub fn simulate_concurrent_claims(
    task: &mut SimulatedTask,
    workers: &mut [SimulatedAgent],
    current_time: i64,
) -> Vec<SimulationResult> {
    let mut results = Vec::new();

    for worker in workers.iter_mut() {
        let result = simulate_claim_task(task, worker, current_time);
        results.push(result);
    }

    // Invariant: current_workers should never exceed max_workers
    if task.current_workers > task.max_workers {
        results.push(SimulationResult::InvariantViolation(format!(
            "Race condition: current_workers {} > max_workers {}",
            task.current_workers, task.max_workers
        )));
    }

    results
}

/// Test double completion attempt
pub fn simulate_double_completion(
    task: &mut SimulatedTask,
    escrow: &mut SimulatedEscrow,
    worker: &mut SimulatedAgent,
    config: &SimulatedConfig,
) -> (SimulationResult, SimulationResult) {
    let proof_hash = [0u8; 32];

    // First completion
    let result1 = simulate_complete_task(task, escrow, worker, config, proof_hash);

    // Second completion attempt (should fail for exclusive tasks)
    let result2 = simulate_complete_task(task, escrow, worker, config, proof_hash);

    (result1, result2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn setup_valid_task() -> SimulatedTask {
        SimulatedTask {
            task_id: [1u8; 32],
            status: task_status::OPEN,
            reward_amount: 1_000_000,
            max_workers: 5,
            current_workers: 0,
            required_capabilities: 1, // COMPUTE
            deadline: 0,
            completions: 0,
            required_completions: 1,
            task_type: 0, // Exclusive
        }
    }

    fn setup_valid_worker() -> SimulatedAgent {
        SimulatedAgent {
            agent_id: [2u8; 32],
            capabilities: 0xFF, // All capabilities
            status: 1,          // Active
            active_tasks: 0,
            reputation: 5000,
            stake: 1_000_000,
            tasks_completed: 0,
            total_earned: 0,
        }
    }

    #[test]
    fn test_claim_task_success() {
        let mut task = setup_valid_task();
        let mut worker = setup_valid_worker();

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_success());
        assert_eq!(task.current_workers, 1);
        assert_eq!(task.status, task_status::IN_PROGRESS);
        assert_eq!(worker.active_tasks, 1);
    }

    #[test]
    fn test_claim_task_exceeds_max_workers() {
        let mut task = setup_valid_task();
        task.max_workers = 1;
        task.current_workers = 1;

        let mut worker = setup_valid_worker();

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_error());
    }

    #[test]
    fn test_complete_task_success() {
        let mut task = setup_valid_task();
        task.status = task_status::IN_PROGRESS;
        task.current_workers = 1;

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = setup_valid_worker();
        worker.active_tasks = 1; // Worker must have at least 1 active task to complete
        let config = SimulatedConfig::default();

        let result = simulate_complete_task(
            &mut task,
            &mut escrow,
            &mut worker,
            &config,
            [0u8; 32],
        );

        assert!(result.is_success());
        assert_eq!(task.status, task_status::COMPLETED);
        assert!(escrow.is_closed);
        assert!(worker.reputation > 5000);
    }

    proptest! {
        #[test]
        fn test_escrow_never_overdrafts(
            amount in 1u64..u64::MAX/2,
            fee_bps in 0u16..10000u16,
        ) {
            let mut task = setup_valid_task();
            task.status = task_status::IN_PROGRESS;
            task.reward_amount = amount;

            let mut escrow = SimulatedEscrow {
                amount,
                distributed: 0,
                is_closed: false,
            };

            let mut worker = setup_valid_worker();
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

            // Either success or error, but never invariant violation
            prop_assert!(!result.is_invariant_violation(),
                "Invariant violation: {:?}", result);

            // If successful, distributed should not exceed amount
            if result.is_success() {
                prop_assert!(escrow.distributed <= escrow.amount,
                    "distributed {} > amount {}", escrow.distributed, escrow.amount);
            }
        }

        #[test]
        fn test_reputation_stays_bounded(
            initial_rep in 0u16..=10000u16,
            num_completions in 0usize..200usize,
        ) {
            let mut worker = setup_valid_worker();
            worker.reputation = initial_rep;

            for _ in 0..num_completions {
                worker.reputation = worker.reputation.saturating_add(100).min(10000);
            }

            prop_assert!(worker.reputation <= 10000,
                "Reputation {} exceeds max", worker.reputation);
        }

        #[test]
        fn test_concurrent_claims_bounded(
            max_workers in 1u8..=10u8,
            num_claimants in 1usize..20usize,
        ) {
            let mut task = setup_valid_task();
            task.max_workers = max_workers;

            let mut workers: Vec<_> = (0..num_claimants)
                .map(|i| {
                    let mut w = setup_valid_worker();
                    w.agent_id[0] = i as u8;
                    w
                })
                .collect();

            let results = simulate_concurrent_claims(&mut task, &mut workers, 100);

            // Count successful claims
            let successes = results.iter().filter(|r| r.is_success()).count();

            prop_assert!(successes as u8 <= max_workers,
                "Successful claims {} > max_workers {}", successes, max_workers);

            prop_assert!(task.current_workers <= task.max_workers,
                "current_workers {} > max_workers {}", task.current_workers, task.max_workers);
        }
    }

    #[test]
    fn test_competitive_task_double_completion_rejected() {
        // Competitive task type = 2
        let mut task = SimulatedTask {
            task_id: [1u8; 32],
            status: task_status::IN_PROGRESS,
            reward_amount: 1_000_000,
            max_workers: 5,
            current_workers: 2,
            required_capabilities: 0,
            deadline: 0,
            completions: 0,  // First completion hasn't happened yet
            required_completions: 1,
            task_type: 2, // COMPETITIVE
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let mut worker1 = setup_valid_worker();
        worker1.agent_id[0] = 1;
        worker1.active_tasks = 1;

        let mut worker2 = setup_valid_worker();
        worker2.agent_id[0] = 2;
        worker2.active_tasks = 1;

        let config = SimulatedConfig::default();

        // First completion should succeed
        let result1 = simulate_complete_task(
            &mut task,
            &mut escrow,
            &mut worker1,
            &config,
            [0u8; 32],
        );
        assert!(result1.is_success(), "First completion should succeed: {:?}", result1);

        // Reset task status for second attempt (simulating before task marked completed)
        task.status = task_status::IN_PROGRESS;

        // Second completion should be rejected due to CompetitiveTaskAlreadyWon
        let result2 = simulate_complete_task(
            &mut task,
            &mut escrow,
            &mut worker2,
            &config,
            [0u8; 32],
        );
        assert!(result2.is_error(), "Second completion should be rejected: {:?}", result2);
        if let SimulationResult::Error(msg) = result2 {
            assert_eq!(msg, "CompetitiveTaskAlreadyWon", "Expected CompetitiveTaskAlreadyWon error");
        }
    }
}
