//! Fuzz target for task dependency graph invariants
//!
//! Tests:
//! - Dependent task cannot complete before parent
//! - No cycles in dependency chains (cycles rejected in model)
//! - Diamond dependencies handled correctly (multiple parents)
//!
//! Run with: cargo test --release -p agenc-coordination-fuzz dependency_graph

use crate::*;
use proptest::prelude::*;

fn has_path(graph: &[Vec<usize>], from: usize, to: usize, visited: &mut [bool]) -> bool {
    if from == to {
        return true;
    }
    if visited[from] {
        return false;
    }
    visited[from] = true;
    for &next in &graph[from] {
        if has_path(graph, next, to, visited) {
            return true;
        }
    }
    false
}

fn would_create_cycle(graph: &[Vec<usize>], parent: usize, child: usize) -> bool {
    // Adding parent -> child creates a cycle if there is already a path child -> parent
    let mut visited = vec![false; graph.len()];
    has_path(graph, child, parent, &mut visited)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    #[test]
    fn fuzz_dependency_graph(input in any::<DependencyGraphInput>()) {
        let task_count = input.task_count.max(1).min(10) as usize;

        let mut tasks: Vec<SimulatedTask> = (0..task_count)
            .map(|i| SimulatedTask {
                task_id: [i as u8; 32],
                status: task_status::OPEN,
                reward_amount: 1,
                max_workers: 1,
                current_workers: 0,
                required_capabilities: 0,
                deadline: 0,
                completions: 0,
                required_completions: 1,
                task_type: 0,
            })
            .collect();

        // Build dependency edges (filter invalid indices, reject cycles)
        let mut graph: Vec<Vec<usize>> = vec![Vec::new(); task_count];
        let mut edges: Vec<(usize, usize)> = Vec::new();

        for (p_raw, c_raw) in &input.edges {
            let p = (*p_raw as usize) % task_count;
            let c = (*c_raw as usize) % task_count;
            if p == c {
                continue;
            }

            if would_create_cycle(&graph, p, c) {
                continue;
            }

            graph[p].push(c);
            edges.push((p, c));
        }

        for &task_index in &input.completion_order {
            let idx = (task_index as usize) % task_count;

            let parents: Vec<usize> = edges
                .iter()
                .filter(|(_, c)| *c == idx)
                .map(|(p, _)| *p)
                .collect();

            let has_parents = !parents.is_empty();
            let all_parents_completed = parents
                .iter()
                .all(|&p| tasks[p].status == task_status::COMPLETED);

            if tasks[idx].status == task_status::OPEN && all_parents_completed {
                tasks[idx].status = task_status::IN_PROGRESS;
            }

            let result = simulate_complete_dependent_task(&mut tasks[idx], all_parents_completed);

            prop_assert!(
                !result.is_invariant_violation(),
                "Invariant violation: {:?}\nInput: {:?}",
                result,
                input
            );

            // INVARIANT: dependent task completion fails if any parent not completed
            if has_parents && !all_parents_completed {
                prop_assert!(
                    !result.is_success(),
                    "Dependent task completed before parent at index {}.\nInput: {:?}",
                    idx,
                    input
                );
            }

            // INVARIANT: repeated completions should not succeed
            if tasks[idx].status == task_status::COMPLETED {
                prop_assert!(
                    !result.is_success() || all_parents_completed,
                    "Unexpected completion success in Completed state.\nInput: {:?}",
                    input
                );
            }
        }
    }
}

