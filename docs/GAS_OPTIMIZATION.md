# Gas Optimization Guide

This document outlines gas optimization strategies for the AgenC protocol on Solana.

## Current Account Sizes

| Account | Size (bytes) | Rent (SOL @ 0.00089088/byte) |
|---------|-------------|------------------------------|
| ProtocolConfig | ~334 | ~0.0030 |
| AgentRegistration | ~430 | ~0.0038 |
| Task | ~336 | ~0.0030 |
| TaskClaim | ~203 | ~0.0018 |
| TaskEscrow | ~58 | ~0.0005 |
| Dispute | ~189 | ~0.0017 |
| DisputeVote | ~82 | ~0.0007 |
| CoordinationState | ~153 | ~0.0014 |

## Implemented Optimizations

### 1. Reduced Task Reserved Field

Reduced `Task._reserved` from 32 bytes to 8 bytes, saving 24 bytes per task.

**Before:** 336 bytes
**After:** 312 bytes
**Savings:** 24 bytes (~7% reduction)

### 2. Compute Unit Budgeting Constants

Added constants for instruction CU budgets to help clients request optimal compute units:

```rust
pub mod compute_units {
    pub const CREATE_TASK: u32 = 25_000;
    pub const CLAIM_TASK: u32 = 20_000;
    pub const COMPLETE_TASK: u32 = 35_000;
    pub const COMPLETE_TASK_PRIVATE: u32 = 200_000; // ZK verification
    pub const INITIATE_DISPUTE: u32 = 30_000;
    pub const VOTE_DISPUTE: u32 = 15_000;
    pub const RESOLVE_DISPUTE: u32 = 50_000;
}
```

## Future Optimizations (Breaking Changes)

These optimizations require migrations and should be implemented in a future version:

### 1. Remove Redundant Task.escrow Field

The `escrow` pubkey in Task is redundant because it can always be derived:

```rust
let [escrow_pda] = Pubkey::find_program_address(
    &[b"escrow", task_pda.as_ref()],
    &program_id
);
```

**Savings:** 32 bytes per task (~10% reduction)

**Migration Path:**
1. Add `derive_escrow()` helper function
2. Update all instructions to derive escrow instead of reading from task
3. Remove field in v2 account structure
4. Run migration to resize accounts

### 2. Reduce AgentRegistration String Sizes

Current: 128 chars each for `endpoint` and `metadata_uri`
Proposed: 64 chars each

Most URLs and CID references fit in 64 characters. For longer metadata, use IPFS/Arweave CIDs.

**Savings:** 128 bytes per agent (~30% reduction)

**Migration Path:**
1. Validate existing data fits in 64 chars
2. Update account structure
3. Run migration to resize accounts

### 3. Pack Boolean Fields

Several accounts have multiple boolean fields that could be packed into a single u8 bitmask:

**TaskClaim:**
```rust
// Current (2 bytes)
pub is_completed: bool,
pub is_validated: bool,

// Optimized (1 byte)
pub flags: u8, // bit 0: completed, bit 1: validated
```

**Savings:** 1 byte per claim

## Compute Unit Optimization Tips

### For Clients

1. **Use `setComputeUnitLimit`** with the constants above
2. **Batch operations** when possible (e.g., create + claim in one tx)
3. **Prefetch accounts** to reduce CPI overhead

### For Instructions

1. **Read protocol config once** and pass to helpers
2. **Use checked arithmetic** (already done) but avoid redundant checks
3. **Minimize event data** while preserving indexability

## Fee Structure Optimization

### Current Fee Model

- Protocol fee: Configurable basis points (default: 100 bps = 1%)
- Applied on task completion
- Sent to treasury account

### Recommendations

1. **Tiered fees based on task size:**
   - Small tasks (<0.1 SOL): 0.5% fee
   - Medium tasks (0.1-1 SOL): 1% fee
   - Large tasks (>1 SOL): 0.75% fee

2. **Volume discounts for agents:**
   - Reputation > 5000: 20% fee reduction
   - Tasks completed > 100: 10% fee reduction

3. **Batch completion discounts:**
   - Complete 3+ claims in one tx: 15% fee reduction

## Rent Optimization

### Account Lifecycle

1. **Close completed claims** after reward distribution
2. **Close cancelled task escrows** immediately
3. **Consider temporary accounts** for short-lived data

### Rent Recovery

Implement account closing in:
- `resolve_dispute` (close dispute + votes after resolution)
- `cancel_task` (close escrow)
- `complete_task` (close claim for competitive tasks)

## Benchmarks

Baseline compute units (measured on devnet):

| Instruction | CUs Used | Budget |
|------------|----------|--------|
| create_task | ~22,000 | 25,000 |
| claim_task | ~18,000 | 20,000 |
| complete_task | ~32,000 | 35,000 |
| complete_task_private | ~180,000 | 200,000 |
| initiate_dispute | ~25,000 | 30,000 |
| vote_dispute | ~12,000 | 15,000 |
| resolve_dispute | ~45,000 | 50,000 |

## Implementation Checklist

- [x] Reduce Task._reserved field
- [x] Add CU budget constants
- [x] Document optimization opportunities
- [ ] Implement escrow derivation helper
- [ ] Migrate to smaller Task accounts
- [ ] Migrate to smaller AgentRegistration accounts
- [ ] Implement account closing for rent recovery
- [ ] Add tiered fee structure
