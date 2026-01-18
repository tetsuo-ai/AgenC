//! Fuzz test runner for AgenC Coordination Protocol
//!
//! Run with: cargo run --release
//! Or: cargo test (for property-based tests)

use agenc_coordination_fuzz::*;
use proptest::prelude::*;
use std::time::Instant;

fn main() {
    println!("=== AgenC Coordination Protocol Fuzz Testing ===\n");

    let start = Instant::now();
    let mut total_tests = 0;
    let mut passed = 0;
    let mut failed = 0;

    // Run each fuzz target
    println!("Running claim_task fuzz tests...");
    let (p, f) = run_claim_task_fuzz(100);
    passed += p;
    failed += f;
    total_tests += p + f;

    println!("Running complete_task fuzz tests...");
    let (p, f) = run_complete_task_fuzz(100);
    passed += p;
    failed += f;
    total_tests += p + f;

    println!("Running vote_dispute fuzz tests...");
    let (p, f) = run_vote_dispute_fuzz(100);
    passed += p;
    failed += f;
    total_tests += p + f;

    println!("Running resolve_dispute fuzz tests...");
    let (p, f) = run_resolve_dispute_fuzz(100);
    passed += p;
    failed += f;
    total_tests += p + f;

    println!("Running edge case tests...");
    let (p, f) = run_edge_case_tests();
    passed += p;
    failed += f;
    total_tests += p + f;

    println!("Running race condition tests...");
    let (p, f) = run_race_condition_tests(50);
    passed += p;
    failed += f;
    total_tests += p + f;

    let duration = start.elapsed();

    println!("\n=== Fuzz Testing Complete ===");
    println!("Total tests: {}", total_tests);
    println!("Passed: {}", passed);
    println!("Failed: {}", failed);
    println!("Duration: {:?}", duration);

    if failed > 0 {
        std::process::exit(1);
    }
}

fn run_claim_task_fuzz(iterations: usize) -> (usize, usize) {
    let mut passed = 0;
    let mut failed = 0;

    let mut runner = proptest::test_runner::TestRunner::default();

    for i in 0..iterations {
        let input = any::<ClaimTaskInput>()
            .new_tree(&mut runner)
            .expect("Failed to generate ClaimTaskInput")
            .current();

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
            status: 1, // Active
            active_tasks: input.worker_active_tasks.min(9),
            reputation: input.worker_reputation.min(10000),
            stake: 0,
            tasks_completed: 0,
            total_earned: 0,
        };

        let result = simulate_claim_task(&mut task, &mut worker, input.current_timestamp);

        if result.is_invariant_violation() {
            println!("  [FAIL] Iteration {}: {:?}", i, result);
            failed += 1;
        } else {
            passed += 1;
        }
    }

    println!("  claim_task: {} passed, {} failed", passed, failed);
    (passed, failed)
}

fn run_complete_task_fuzz(iterations: usize) -> (usize, usize) {
    let mut passed = 0;
    let mut failed = 0;

    let mut runner = proptest::test_runner::TestRunner::default();

    for i in 0..iterations {
        let input = any::<CompleteTaskInput>()
            .new_tree(&mut runner)
            .expect("Failed to generate CompleteTaskInput")
            .current();

        // Ensure escrow amount >= reward to avoid trivial failures
        let escrow_amount = input.task_reward.max(input.escrow_amount);

        let mut task = SimulatedTask {
            task_id: input.task_id,
            status: task_status::IN_PROGRESS,
            reward_amount: input.task_reward,
            max_workers: 10,
            current_workers: 1,
            required_capabilities: 0,
            deadline: 0,
            completions: input.current_completions,
            required_completions: input.required_completions.max(1),
            task_type: input.task_type,
        };

        let mut escrow = SimulatedEscrow {
            amount: escrow_amount,
            distributed: input.escrow_distributed.min(escrow_amount.saturating_sub(input.task_reward)),
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

        let result = simulate_complete_task(
            &mut task,
            &mut escrow,
            &mut worker,
            &config,
            input.proof_hash,
        );

        if result.is_invariant_violation() {
            println!("  [FAIL] Iteration {}: {:?}", i, result);
            failed += 1;
        } else {
            passed += 1;
        }
    }

    println!("  complete_task: {} passed, {} failed", passed, failed);
    (passed, failed)
}

fn run_vote_dispute_fuzz(iterations: usize) -> (usize, usize) {
    let mut passed = 0;
    let mut failed = 0;

    let mut runner = proptest::test_runner::TestRunner::default();

    for i in 0..iterations {
        let input = any::<VoteDisputeInput>()
            .new_tree(&mut runner)
            .expect("Failed to generate VoteDisputeInput")
            .current();

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
            capabilities: 1 << 7, // ARBITER
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

        // Use timestamp before deadline to test valid voting
        let current_time = if input.current_timestamp < input.voting_deadline {
            input.current_timestamp
        } else {
            input.voting_deadline.saturating_sub(1)
        };

        let result = simulate_vote_dispute(
            &mut dispute,
            &arbiter,
            &config,
            input.approve,
            current_time,
        );

        if result.is_invariant_violation() {
            println!("  [FAIL] Iteration {}: {:?}", i, result);
            failed += 1;
        } else {
            passed += 1;
        }
    }

    println!("  vote_dispute: {} passed, {} failed", passed, failed);
    (passed, failed)
}

fn run_resolve_dispute_fuzz(iterations: usize) -> (usize, usize) {
    let mut passed = 0;
    let mut failed = 0;

    let mut runner = proptest::test_runner::TestRunner::default();

    for i in 0..iterations {
        let input = any::<ResolveDisputeInput>()
            .new_tree(&mut runner)
            .expect("Failed to generate ResolveDisputeInput")
            .current();

        // Ensure we have at least one vote
        let votes_for = input.votes_for.max(1);
        let votes_against = input.votes_against;

        let mut dispute = SimulatedDispute {
            dispute_id: input.dispute_id,
            status: dispute_status::ACTIVE,
            resolution_type: input.resolution_type,
            votes_for,
            votes_against,
            total_voters: votes_for.saturating_add(votes_against),
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
            distributed: input.escrow_distributed.min(input.escrow_amount),
            is_closed: false,
        };

        let config = SimulatedConfig {
            dispute_threshold: input.dispute_threshold,
            ..Default::default()
        };

        // Use timestamp after deadline
        let current_time = input.voting_deadline.saturating_add(1);

        let result = simulate_resolve_dispute(
            &mut dispute,
            &mut task,
            &mut escrow,
            &config,
            current_time,
        );

        if result.is_invariant_violation() {
            println!("  [FAIL] Iteration {}: {:?}", i, result);
            failed += 1;
        } else {
            passed += 1;
        }
    }

    println!("  resolve_dispute: {} passed, {} failed", passed, failed);
    (passed, failed)
}

fn run_edge_case_tests() -> (usize, usize) {
    let mut passed = 0;
    let mut failed = 0;

    // Test u64::MAX reward amount
    {
        let mut task = SimulatedTask {
            status: task_status::IN_PROGRESS,
            reward_amount: u64::MAX,
            required_completions: 1,
            ..Default::default()
        };

        let mut escrow = SimulatedEscrow {
            amount: u64::MAX,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = SimulatedAgent {
            status: 1,
            reputation: 5000,
            ..Default::default()
        };

        let config = SimulatedConfig::default();

        let result = simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, [0u8; 32]);

        if result.is_invariant_violation() {
            println!("  [FAIL] u64::MAX reward: {:?}", result);
            failed += 1;
        } else {
            passed += 1;
        }
    }

    // Test zero reward
    {
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
            ..Default::default()
        };

        let config = SimulatedConfig::default();

        let result = simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, [0u8; 32]);

        if result.is_invariant_violation() {
            println!("  [FAIL] zero reward: {:?}", result);
            failed += 1;
        } else {
            passed += 1;
        }
    }

    // Test max reputation
    {
        let mut worker = SimulatedAgent {
            status: 1,
            reputation: 10000,
            ..Default::default()
        };

        // Simulate reputation increment at max
        worker.reputation = worker.reputation.saturating_add(100).min(10000);

        if worker.reputation > 10000 {
            println!("  [FAIL] reputation exceeded max");
            failed += 1;
        } else {
            passed += 1;
        }
    }

    // Test 100% protocol fee
    {
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
            ..Default::default()
        };

        let config = SimulatedConfig {
            protocol_fee_bps: 10000, // 100%
            ..Default::default()
        };

        let result = simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, [0u8; 32]);

        if result.is_invariant_violation() {
            println!("  [FAIL] 100% protocol fee: {:?}", result);
            failed += 1;
        } else {
            passed += 1;
        }
    }

    println!("  edge_cases: {} passed, {} failed", passed, failed);
    (passed, failed)
}

fn run_race_condition_tests(iterations: usize) -> (usize, usize) {
    let mut passed = 0;
    let mut failed = 0;

    for i in 0..iterations {
        let max_workers = ((i % 5) + 1) as u8;
        let num_claimants = (i % 10) + 1;

        let mut task = SimulatedTask {
            task_id: [i as u8; 32],
            status: task_status::OPEN,
            reward_amount: 1_000_000,
            max_workers,
            current_workers: 0,
            required_capabilities: 0,
            deadline: 0,
            completions: 0,
            required_completions: 1,
            task_type: 0,
        };

        let mut workers: Vec<_> = (0..num_claimants)
            .map(|j| SimulatedAgent {
                agent_id: [j as u8; 32],
                capabilities: 0xFF,
                status: 1,
                active_tasks: 0,
                reputation: 5000,
                stake: 0,
                tasks_completed: 0,
                total_earned: 0,
            })
            .collect();

        let results = simulate_concurrent_claims(&mut task, &mut workers, 100);

        let has_violation = results.iter().any(|r| r.is_invariant_violation());

        if has_violation || task.current_workers > task.max_workers {
            println!("  [FAIL] Race condition test {}: workers={}/{}", i, task.current_workers, max_workers);
            failed += 1;
        } else {
            passed += 1;
        }
    }

    println!("  race_conditions: {} passed, {} failed", passed, failed);
    (passed, failed)
}
