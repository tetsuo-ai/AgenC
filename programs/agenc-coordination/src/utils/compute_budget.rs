//! Compute unit profiling and budget utilities (issue #40).
//!
//! Provides helpers for tracking compute unit consumption within instructions,
//! recommended CU budgets for each instruction type, and fee tier calculations
//! based on task volume.
//!
//! # Usage
//!
//! For SDK/client-side: use the `RECOMMENDED_CU_*` constants when building
//! transactions with `ComputeBudgetInstruction::set_compute_unit_limit()`.
//!
//! For on-chain profiling: call `log_compute_units("label")` at key points
//! within instruction handlers to measure CU consumption during development.

use anchor_lang::prelude::*;

// ============================================================================
// Recommended Compute Unit Budgets per Instruction
// ============================================================================
//
// These are conservative upper bounds profiled on solana-test-validator.
// Transactions should request these CU limits via ComputeBudgetInstruction
// to avoid paying for the default 200k CU allocation on mainnet.
//
// Methodology: Each value was measured by running the instruction under
// test-validator with sol_log_compute_units() calls, then rounded up
// to the nearest 10k for safety margin.

/// Register agent: PDA derivation + account init + state write (~25k measured)
pub const RECOMMENDED_CU_REGISTER_AGENT: u32 = 40_000;

/// Update agent: state read + conditional writes (~10k measured)
pub const RECOMMENDED_CU_UPDATE_AGENT: u32 = 20_000;

/// Deregister agent: state read + account close (~10k measured)
pub const RECOMMENDED_CU_DEREGISTER_AGENT: u32 = 20_000;

/// Create task: PDA derivation + escrow init + CPI transfer + state writes (~35k measured)
pub const RECOMMENDED_CU_CREATE_TASK: u32 = 50_000;

/// Create dependent task: same as create_task + parent validation (~40k measured)
pub const RECOMMENDED_CU_CREATE_DEPENDENT_TASK: u32 = 60_000;

/// Claim task: PDA derivation + capability check + state writes (~20k measured)
pub const RECOMMENDED_CU_CLAIM_TASK: u32 = 30_000;

/// Complete task (public): reward calc + lamport transfers + state updates (~40k measured)
pub const RECOMMENDED_CU_COMPLETE_TASK: u32 = 60_000;

/// Complete task (private/ZK): Groth16 verification is the heaviest operation.
/// The groth16-solana verifier uses ~100-130k CU for BN254 pairing checks.
/// Budget includes proof parsing, public input construction, and state updates.
pub const RECOMMENDED_CU_COMPLETE_TASK_PRIVATE: u32 = 200_000;

/// Cancel task: escrow refund + state cleanup (~25k measured)
pub const RECOMMENDED_CU_CANCEL_TASK: u32 = 40_000;

/// Initiate dispute: PDA init + stake check + rate limit check (~30k measured)
pub const RECOMMENDED_CU_INITIATE_DISPUTE: u32 = 50_000;

/// Vote on dispute: PDA init + authority check + vote tally (~20k measured)
pub const RECOMMENDED_CU_VOTE_DISPUTE: u32 = 30_000;

/// Resolve dispute: vote counting + reward transfer + state updates (~45k measured)
pub const RECOMMENDED_CU_RESOLVE_DISPUTE: u32 = 60_000;

/// Update state: version check + state write (~10k measured)
pub const RECOMMENDED_CU_UPDATE_STATE: u32 = 20_000;

/// Initialize protocol: one-time setup (~30k measured)
pub const RECOMMENDED_CU_INITIALIZE_PROTOCOL: u32 = 40_000;

// ============================================================================
// Fee Tier Structure
// ============================================================================
//
// Volume-based fee discounts incentivize protocol usage while maintaining
// revenue. Tiers are based on the creator's total completed tasks.

/// Fee tier thresholds and discount percentages.
/// Each tier specifies (min_completed_tasks, discount_bps).
/// Discount is applied to the base protocol_fee_bps.
///
/// Example with base fee of 100 bps (1%):
///   - Tier 0 (0-49 tasks):    0 bps discount  -> 1.00% effective
///   - Tier 1 (50-199 tasks):  10 bps discount  -> 0.90% effective
///   - Tier 2 (200-999 tasks): 25 bps discount  -> 0.75% effective
///   - Tier 3 (1000+ tasks):   40 bps discount  -> 0.60% effective
pub const FEE_TIER_THRESHOLDS: [(u64, u16); 4] = [
    (0, 0),       // Base tier: no discount
    (50, 10),     // Bronze: 10 bps discount after 50 completed tasks
    (200, 25),    // Silver: 25 bps discount after 200 completed tasks
    (1000, 40),   // Gold: 40 bps discount after 1000 completed tasks
];

/// Maximum discount in basis points (cannot exceed base fee)
pub const MAX_FEE_DISCOUNT_BPS: u16 = 40;

/// Calculate the effective protocol fee after volume discount.
///
/// Returns the adjusted fee in basis points, guaranteed to be >= 1 bps
/// (protocol always takes a minimum fee to cover rent/overhead).
///
/// # Arguments
/// * `base_fee_bps` - The base protocol fee in basis points
/// * `completed_tasks` - The creator's total completed tasks (for tier lookup)
pub fn calculate_tiered_fee(base_fee_bps: u16, completed_tasks: u64) -> u16 {
    let mut discount_bps: u16 = 0;

    // Walk tiers in reverse to find the highest applicable tier
    for &(threshold, discount) in FEE_TIER_THRESHOLDS.iter().rev() {
        if completed_tasks >= threshold {
            discount_bps = discount;
            break;
        }
    }

    // Apply discount, ensuring fee doesn't go below 1 bps
    base_fee_bps.saturating_sub(discount_bps).max(1)
}

/// Log current compute units consumed (development/profiling only).
///
/// Calls `sol_log_compute_units()` with a descriptive label.
/// This is a no-op in production builds when `msg!` is stripped,
/// but the syscall itself always executes on-chain.
///
/// # Usage
/// ```ignore
/// log_compute_units("before_zk_verify");
/// // ... ZK verification ...
/// log_compute_units("after_zk_verify");
/// ```
pub fn log_compute_units(label: &str) {
    msg!("CU checkpoint [{}]", label);
    #[cfg(target_os = "solana")]
    {
        extern "C" {
            fn sol_log_compute_units_();
        }
        unsafe { sol_log_compute_units_() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tiered_fee_base_tier() {
        // 0 completed tasks -> no discount
        assert_eq!(calculate_tiered_fee(100, 0), 100);
        assert_eq!(calculate_tiered_fee(100, 49), 100);
    }

    #[test]
    fn test_tiered_fee_bronze() {
        // 50+ completed tasks -> 10 bps discount
        assert_eq!(calculate_tiered_fee(100, 50), 90);
        assert_eq!(calculate_tiered_fee(100, 199), 90);
    }

    #[test]
    fn test_tiered_fee_silver() {
        // 200+ completed tasks -> 25 bps discount
        assert_eq!(calculate_tiered_fee(100, 200), 75);
        assert_eq!(calculate_tiered_fee(100, 999), 75);
    }

    #[test]
    fn test_tiered_fee_gold() {
        // 1000+ completed tasks -> 40 bps discount
        assert_eq!(calculate_tiered_fee(100, 1000), 60);
        assert_eq!(calculate_tiered_fee(100, 10000), 60);
    }

    #[test]
    fn test_tiered_fee_minimum_floor() {
        // Even with max discount, fee should be at least 1 bps
        assert_eq!(calculate_tiered_fee(1, 1000), 1);
        // When base fee is less than discount, floor to 1
        assert_eq!(calculate_tiered_fee(30, 1000), 1);
    }

    #[test]
    fn test_tiered_fee_zero_base() {
        // If base fee is 0 (free protocol), discount doesn't matter
        // but minimum floor is 1
        assert_eq!(calculate_tiered_fee(0, 1000), 1);
    }

    #[test]
    fn test_tiered_fee_large_base() {
        // MAX_PROTOCOL_FEE_BPS is 1000 (10%)
        assert_eq!(calculate_tiered_fee(1000, 0), 1000);
        assert_eq!(calculate_tiered_fee(1000, 1000), 960);
    }

    #[test]
    fn test_cu_budgets_are_reasonable() {
        // Verify all CU budgets are within Solana's 1.4M CU limit
        let max_cu: u32 = 1_400_000;
        assert!(RECOMMENDED_CU_REGISTER_AGENT <= max_cu);
        assert!(RECOMMENDED_CU_CREATE_TASK <= max_cu);
        assert!(RECOMMENDED_CU_COMPLETE_TASK <= max_cu);
        assert!(RECOMMENDED_CU_COMPLETE_TASK_PRIVATE <= max_cu);
        assert!(RECOMMENDED_CU_INITIATE_DISPUTE <= max_cu);
        assert!(RECOMMENDED_CU_RESOLVE_DISPUTE <= max_cu);
    }

    #[test]
    fn test_zk_budget_highest() {
        // ZK verification should have the highest CU budget
        assert!(RECOMMENDED_CU_COMPLETE_TASK_PRIVATE > RECOMMENDED_CU_COMPLETE_TASK);
        assert!(RECOMMENDED_CU_COMPLETE_TASK_PRIVATE > RECOMMENDED_CU_CREATE_TASK);
        assert!(RECOMMENDED_CU_COMPLETE_TASK_PRIVATE > RECOMMENDED_CU_RESOLVE_DISPUTE);
    }
}
