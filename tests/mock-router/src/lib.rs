//! Mock Verifier Router for LiteSVM integration tests.
//!
//! Minimal BPF program that accepts any CPI call and returns success (0).
//! Loaded at both the Router and Verifier program IDs in LiteSVM so that
//! `complete_task_private` can succeed without real Groth16 verification.
//!
//! Uses raw BPF entrypoint to avoid `solana-program` dependency issues with
//! the SBF toolchain.

/// BPF entrypoint — returns 0 (success) for any instruction.
#[no_mangle]
pub extern "C" fn entrypoint(_input: *mut u8) -> u64 {
    0 // SUCCESS
}
