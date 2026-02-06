# Solana Dev Skill Audit Report

Audit of the AgenC codebase against the Solana Foundation dev skill checklist.

**Date**: 2026-02-05
**Skill version**: solana-dev (Jan 2026)
**Codebase**: AgenC Coordination Protocol

---

## 1. @solana/web3.js Usage and Kit Migration

### Current State

The codebase uses `@solana/web3.js` v1.90-1.95 throughout. No `@solana/kit` types are used anywhere. 119 files import from `@solana/web3.js`.

### Files Where web3.js Types Leak Beyond Boundaries

**CRITICAL** - Core SDK types expose `PublicKey`, `Connection`, `Keypair` directly:

| File | Leaked Types | Priority |
|------|-------------|----------|
| `sdk/src/client.ts` | `Connection`, `Keypair`, `PublicKey` in public API | HIGH |
| `sdk/src/tasks.ts` | `Connection`, `PublicKey`, `Transaction` in all function signatures | HIGH |
| `sdk/src/queries.ts` | `Connection`, `PublicKey`, `GetProgramAccountsFilter` | HIGH |
| `runtime/src/runtime.ts` | `Connection`, `PublicKey` stored and returned | HIGH |
| `runtime/src/agent/types.ts` | `PublicKey` in `AgentState` interface | HIGH |
| `runtime/src/types/protocol.ts` | `PublicKey` in `ProtocolConfig` | HIGH |
| `runtime/src/types/config.ts` | `Keypair`, `PublicKey` in config types | HIGH |
| `runtime/src/task/types.ts` | `PublicKey`, `TransactionSignature` | HIGH |
| `runtime/src/events/types.ts` | `PublicKey`, `TransactionSignature` | MEDIUM |

### Correctly Bounded Usage (No Changes Needed)

| Module | Reason |
|--------|--------|
| `runtime/src/types/wallet.ts` | Adapter boundary for Anchor wallet interface |
| `mcp/src/tools/*.ts` | MCP tool layer sits at the boundary |
| `examples/**` | Demo code, not library surface |
| `tests/**` | Test code |

### Migration Recommendations

1. Create abstract address types (`sdk/src/types/address.ts`) wrapping string-based addresses
2. Create connection provider interface abstracting `Connection`
3. Move `@solana/web3.js` usage into `sdk/src/compat/` adapter modules
4. New public API should accept/return `Address` (string) instead of `PublicKey`
5. Keep `@solana/web3.js` as transitive dep via `@solana/web3-compat` for Anchor interop

---

## 2. On-Chain Program Security Audit

Anchor program at `programs/agenc-coordination/src/`.

### CRITICAL Findings

#### 2.1 `init_if_needed` on TaskClaim (Reinitialization Risk)

**File**: `programs/agenc-coordination/src/instructions/claim_task.rs:19-25`

```rust
#[account(
    init_if_needed,
    payer = authority,
    space = TaskClaim::SIZE,
    seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
    bump
)]
pub claim: Account<'info, TaskClaim>,
```

The security.md checklist explicitly warns: "Avoid `init_if_needed` - it permits reinitialization." The code validates `claimed_at > 0` to detect existing claims, but if the account exists with zeroed data, this check is bypassed.

**Recommendation**: Replace with `init` constraint. Handle the "already claimed" case by checking if the PDA account already exists before sending the transaction.

#### 2.2 `init_if_needed` on CoordinationState

**File**: `programs/agenc-coordination/src/instructions/update_state.rs:12-18`

Same pattern. Uses `version == 0 && last_updater == default()` to detect new state, which could be spoofed if the account is created with zeroed data.

**Recommendation**: Replace with `init` or add an explicit `is_initialized` discriminator field.

### HIGH Findings

#### 2.3 Duplicate Accounts Across Remaining Accounts Sections

**File**: `programs/agenc-coordination/src/instructions/resolve_dispute.rs:322-345`

Duplicate arbiter checking only covers the arbiter section of `remaining_accounts`. If the same account appears in both the arbiter section AND worker section, `active_dispute_votes` could be decremented twice.

**Recommendation**: Extend the `seen_arbiters` HashSet check to span both loops, or maintain a single `seen_keys` set across all `remaining_accounts` processing.

#### 2.4 Same Issue in expire_dispute

**File**: `programs/agenc-coordination/src/instructions/expire_dispute.rs:228-257`

Same pattern as resolve_dispute.

### MEDIUM Findings

#### 2.5 Late Owner Validation in cancel_task

**File**: `programs/agenc-coordination/src/instructions/cancel_task.rs:128-146`

Claim data is deserialized before the owner check is fully validated. Move owner validation before data access.

#### 2.6 Inconsistent Deadline Validation

**File**: `programs/agenc-coordination/src/instructions/create_dependent_task.rs:103-108`

`create_task` requires `deadline > 0`, but `create_dependent_task` allows `deadline == 0`. This should be documented if intentional, or made consistent.

#### 2.7 `saturating_sub` for active_tasks Counter

**File**: `programs/agenc-coordination/src/instructions/cancel_task.rs:146`

`worker.active_tasks.saturating_sub(1)` silently clamps to zero instead of failing on underflow. While documented as safe, this could hide accounting bugs.

### PASSED Checks

| Check | Status | Notes |
|-------|--------|-------|
| Signer checks | PASS | All authority accounts use `Signer<'info>` |
| Arbitrary CPI | PASS | Only system_program transfers, validated by Anchor |
| Type cosplay / discriminators | PASS | Anchor `#[account]` macro handles this |
| PDA seed uniqueness | PASS | Seeds include sufficient entropy per account type |
| has_one constraints | PASS | Used correctly throughout |
| Account closure | PASS | `close` constraint used; manual zeroing in cancel_task |
| Checked arithmetic | PASS | `checked_add`/`checked_sub`/`checked_mul` used consistently |

---

## 3. Test Setup Gaps

### Current State

| Framework | Location | Usage |
|-----------|----------|-------|
| ts-mocha + chai | `tests/` (17 files) | Anchor integration tests via solana-test-validator |
| vitest | `sdk/src/__tests__/` (3 files) | SDK unit tests |
| vitest | `runtime/tests/` (1 file) | Runtime integration tests |

### Gaps Identified

#### 3.1 No LiteSVM Usage (HIGH)

All Anchor tests run through solana-test-validator with a 120-second startup wait. SDK and runtime unit tests that don't need a full validator should use LiteSVM for faster feedback.

**Impact**: Slow test iteration. 120 seconds per test run.

#### 3.2 No Mollusk Usage (MEDIUM)

No Rust-side unit testing framework for the on-chain program. Mollusk would enable fast CU benchmarking and isolated instruction testing without a validator.

#### 3.3 No Surfpool Integration Tests (HIGH)

No integration tests against realistic cluster state. Complex CPI testing, time-travel tests, and mainnet account cloning are not possible with current setup.

**What's missing**:
- Cross-program interaction tests with realistic state
- Time-based expiry tests using clock manipulation
- Tests with cloned mainnet program state

#### 3.4 Anchor.toml Only Runs 2 of 17 Test Files

```toml
[scripts]
test = "npx ts-mocha -p ./tsconfig.json -t 300000 tests/test_1.ts tests/dispute-slash-logic.ts"
```

15 test files are excluded from the default test script.

---

## Priority Summary

### Security (Fix Before Mainnet)

1. **CRITICAL**: Replace `init_if_needed` with `init` in `claim_task.rs` and `update_state.rs`
2. **HIGH**: Add cross-section duplicate account checks in `resolve_dispute.rs` and `expire_dispute.rs`

### Correctness

3. **HIGH**: Update Anchor.toml to run all test files
4. **MEDIUM**: Standardize deadline validation across task creation instructions
5. **MEDIUM**: Move owner validation before data access in `cancel_task.rs`

### Modernization

6. **HIGH**: Add LiteSVM for SDK/runtime unit tests
7. **HIGH**: Add Surfpool integration test infrastructure
8. **MEDIUM**: Add Mollusk for on-chain program unit tests
9. **LOW**: Begin @solana/kit migration starting with abstract address types
10. **LOW**: Isolate web3.js behind `@solana/web3-compat` adapter boundary
