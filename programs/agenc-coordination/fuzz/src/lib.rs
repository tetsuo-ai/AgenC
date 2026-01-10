//! Property-based fuzz testing library for AgenC Coordination Protocol
//!
//! This crate provides fuzzing infrastructure to test protocol invariants
//! as documented in docs/audit/THREAT_MODEL.md.
//!
//! # Usage
//!
//! ```bash
//! # Run all property-based tests
//! cargo test --release
//!
//! # Run the fuzz test runner
//! cargo run --release
//!
//! # Run with more iterations
//! PROPTEST_CASES=10000 cargo test --release
//! ```

pub mod arbitrary;
pub mod invariants;
pub mod scenarios;

pub use arbitrary::*;
pub use invariants::*;
pub use scenarios::*;

// Include fuzz targets as test modules
#[cfg(test)]
#[path = "../fuzz_targets/claim_task.rs"]
mod claim_task_tests;

#[cfg(test)]
#[path = "../fuzz_targets/complete_task.rs"]
mod complete_task_tests;

#[cfg(test)]
#[path = "../fuzz_targets/vote_dispute.rs"]
mod vote_dispute_tests;

#[cfg(test)]
#[path = "../fuzz_targets/resolve_dispute.rs"]
mod resolve_dispute_tests;
