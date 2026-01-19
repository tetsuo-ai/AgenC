//! Migration template: Version 1 to Version 2
//!
//! This file documents the migration pattern for future version upgrades.
//! Copy this template when implementing a new version migration.
//!
//! ## When to create a new version:
//! - Adding new fields to ProtocolConfig
//! - Changing field semantics or defaults
//! - Restructuring account data
//!
//! ## Migration Steps:
//! 1. Update state.rs with new fields (use reserved bytes or extend size)
//! 2. Update CURRENT_PROTOCOL_VERSION constant
//! 3. Add migration logic to migrate.rs apply_migration()
//! 4. Test on localnet and devnet
//! 5. Coordinate multisig for mainnet migration

// ============================================================================
// Example Migration: v1 -> v2
// ============================================================================
//
// Scenario: Adding a new `max_concurrent_tasks` field to ProtocolConfig
//
// Step 1: Update state.rs ProtocolConfig
// --------------------------------------
// Add the new field (can use reserved bytes if available):
//
// ```rust
// pub struct ProtocolConfig {
//     // ... existing fields ...
//
//     // NEW in v2: Maximum concurrent tasks per agent
//     pub max_concurrent_tasks: u8,
//
//     // Reduce padding to accommodate new field
//     pub _padding: [u8; 1],  // Was [u8; 2]
// }
// ```
//
// Step 2: Update version constants
// --------------------------------
// In state.rs:
// ```rust
// pub const CURRENT_PROTOCOL_VERSION: u8 = 2;  // Was 1
// // MIN_SUPPORTED_VERSION stays at 1 for backward compatibility
// ```
//
// Step 3: Add migration logic
// ---------------------------
// In migrate.rs apply_migration():
// ```rust
// 2 => {
//     // v1 -> v2: Initialize max_concurrent_tasks
//     config.max_concurrent_tasks = 10;  // Default value
//     msg!("Migrated to v2: set max_concurrent_tasks = 10");
//     Ok(())
// }
// ```
//
// Step 4: Update SIZE calculation
// -------------------------------
// In state.rs ProtocolConfig impl:
// ```rust
// pub const SIZE: usize = 8 +
//     // ... existing fields ...
//     1 +  // max_concurrent_tasks (NEW)
//     1;   // padding (was 2)
// ```
//
// Step 5: Update Default impl
// ---------------------------
// ```rust
// impl Default for ProtocolConfig {
//     fn default() -> Self {
//         Self {
//             // ... existing fields ...
//             max_concurrent_tasks: 10,  // NEW
//             _padding: [0u8; 1],
//         }
//     }
// }
// ```

// ============================================================================
// Security Considerations
// ============================================================================
//
// CRITICAL: All migration code must adhere to these security requirements:
//
// 1. Version Validation
//    - Always check current version BEFORE applying migration
//    - Prevent double-migration by requiring exact source version
//    - Example: require!(config.version == 1, "Expected v1 for migration");
//
// 2. Authorization
//    - Migration instruction MUST require admin/authority signature
//    - Use multisig for mainnet migrations (never single-signer)
//    - Validate signer matches protocol authority
//
// 3. Atomicity
//    - Migration must either fully succeed or fully revert
//    - Update version number LAST, after all data changes
//    - If any step fails, the entire transaction should fail
//
// 4. Data Integrity
//    - Validate account discriminator before deserialization
//    - Check account owner == program_id
//    - Verify existing field values are in valid ranges
//    - Log all changed values for audit trail
//
// 5. Compute Budget
//    - Large migrations may exceed compute limits (200k CU default)
//    - Consider batched migrations for many accounts
//    - Test with compute budget on devnet before mainnet
//
// 6. Account Size Changes
//    - Use realloc constraint for size increases
//    - Ensure payer has sufficient funds for rent increase
//    - Zero-initialize new space to prevent data leaks
//
// ============================================================================
// Migration Verification Checklist
// ============================================================================
//
// Before Migration:
// [ ] New fields have sensible defaults
// [ ] SIZE calculation is correct
// [ ] Default impl includes new fields
// [ ] Migration logic handles all cases
// [ ] Version validation prevents double-migration (SECURITY)
// [ ] Authority constraint enforced (SECURITY)
// [ ] Compute budget tested and sufficient (SECURITY)
// [ ] Tests pass on localnet
// [ ] Tests pass on devnet
//
// After Migration:
// [ ] protocol_version updated to new value
// [ ] New fields have expected values
// [ ] Existing fields unchanged
// [ ] All instructions still work
// [ ] No account corruption
// [ ] Audit log shows expected values (SECURITY)
//
// ============================================================================
// Rollback Plan
// ============================================================================
//
// If migration fails:
// 1. Do NOT call migrate_protocol with lower version
// 2. Deploy previous program binary
// 3. New fields will be ignored by old program
// 4. Document incident and fix before retry
//
// If new code has bugs:
// 1. Deploy hotfix or previous version
// 2. Accounts remain at migrated version
// 3. Both versions must handle the account format
