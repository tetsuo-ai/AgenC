//! Fuzz target modules
//!
//! Each module contains property-based tests for a specific instruction.
//! Run all tests with: cargo test --release -p agenc-coordination-fuzz

pub mod claim_task;
pub mod complete_task;
pub mod dependency_graph;
pub mod dispute_lifecycle;
pub mod dispute_timing;
pub mod resolve_dispute;
pub mod task_lifecycle;
pub mod vote_dispute;
