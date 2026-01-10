# Fuzz Testing Guide

This document describes the fuzz testing infrastructure for the AgenC Coordination Protocol.

## Overview

The fuzz testing suite uses **property-based testing** with [proptest](https://github.com/proptest-rs/proptest) to verify protocol invariants as documented in [THREAT_MODEL.md](audit/THREAT_MODEL.md).

### Why Property-Based Testing?

Traditional `cargo-fuzz` (libFuzzer) doesn't work well with Anchor/Solana programs because:
1. Requires LLVM instrumentation incompatible with BPF target
2. Can't run on-chain code directly
3. Limited integration with Anchor's account validation

Property-based testing provides:
- **Deterministic reproduction** of failures
- **Shrinking** to minimal failing cases
- **Integration with standard test runner**
- **No special toolchain requirements**

## Directory Structure

```
programs/agenc-coordination/fuzz/
├── Cargo.toml                    # Fuzz crate configuration
├── src/
│   ├── lib.rs                    # Library root
│   ├── arbitrary.rs              # Input generators
│   ├── invariants.rs             # Invariant checking functions
│   ├── scenarios.rs              # Simulation scenarios
│   └── main.rs                   # Fuzz test runner
└── fuzz_targets/
    ├── mod.rs                    # Target module declarations
    ├── claim_task.rs             # claim_task instruction tests
    ├── complete_task.rs          # complete_task instruction tests
    ├── vote_dispute.rs           # vote_dispute instruction tests
    └── resolve_dispute.rs        # resolve_dispute instruction tests
```

## Running Fuzz Tests

### Quick Start

```bash
cd programs/agenc-coordination/fuzz

# Run all fuzz tests (100 iterations each)
cargo run --release

# Run property-based tests
cargo test --release

# Run specific target
cargo test --release claim_task

# Run with more iterations
PROPTEST_CASES=10000 cargo test --release
```

### Configuration

Set environment variables to control test behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROPTEST_CASES` | 256 | Number of test cases per property |
| `PROPTEST_MAX_SHRINK_ITERS` | 10000 | Max shrinking iterations |
| `PROPTEST_VERBOSE` | 0 | Verbosity level (0-2) |

Example:
```bash
PROPTEST_CASES=5000 PROPTEST_VERBOSE=1 cargo test --release
```

## Tested Invariants

### Escrow Invariants (E1-E5)

| ID | Invariant | Tested In |
|----|-----------|-----------|
| E1 | Balance Conservation | `complete_task`, `resolve_dispute` |
| E2 | Monotonic Distribution | `complete_task` |
| E3 | Distribution Bounded by Deposit | `complete_task`, `resolve_dispute` |
| E4 | Single Closure | `complete_task`, `resolve_dispute` |
| E5 | Escrow-Task Binding | Account validation |

### Task State Machine Invariants (T1-T5)

| ID | Invariant | Tested In |
|----|-----------|-----------|
| T1 | Valid State Transitions | All task instructions |
| T2 | Terminal State Immutability | `complete_task` |
| T3 | Worker Count Consistency | `claim_task` |
| T4 | Completion Count Bounded | `complete_task` |
| T5 | Deadline Enforcement | `claim_task` |

### Reputation Invariants (R1-R4)

| ID | Invariant | Tested In |
|----|-----------|-----------|
| R1 | Reputation Bounds (0-10000) | `complete_task` |
| R2 | Initial Reputation (5000) | `register_agent` |
| R3 | Increment Rules (+100, capped) | `complete_task` |
| R4 | Single Application Per Completion | Claim tracking |

### Dispute Invariants (D1-D5)

| ID | Invariant | Tested In |
|----|-----------|-----------|
| D1 | Dispute State Machine | `resolve_dispute` |
| D2 | Single Vote Per Arbiter | PDA uniqueness |
| D3 | Voting Window Enforcement | `vote_dispute`, `resolve_dispute` |
| D4 | Threshold-Based Resolution | `resolve_dispute` |
| D5 | Disputable State Requirement | `initiate_dispute` |

### Authority Invariants (A1-A5)

| ID | Invariant | Tested In |
|----|-----------|-----------|
| A4 | Arbiter Capability Requirement | `vote_dispute` |
| S1 | Arbiter Stake Threshold | `vote_dispute` |

## Edge Cases Tested

### Arithmetic Boundaries
- `u64::MAX` reward amounts
- Zero reward amounts
- Maximum protocol fee (100%)
- Division by zero prevention

### State Boundaries
- Maximum reputation (10000)
- Maximum active tasks (10)
- Maximum workers per task (255)
- Vote count overflow (255 max)

### Race Conditions
- Concurrent task claims
- Double completion attempts
- Multiple dispute votes

## Interpreting Results

### Success Output
```
=== AgenC Coordination Protocol Fuzz Testing ===

Running claim_task fuzz tests...
  claim_task: 100 passed, 0 failed
Running complete_task fuzz tests...
  complete_task: 100 passed, 0 failed
...
=== Fuzz Testing Complete ===
Total tests: 450
Passed: 450
Failed: 0
Duration: 1.234s
```

### Failure Output
```
Running claim_task fuzz tests...
  [FAIL] Iteration 42: InvariantViolation("T3: Worker count 6 exceeds max 5")
  claim_task: 99 passed, 1 failed
```

### Proptest Failure
When proptest finds a failure, it shows:
1. **Minimal failing input** (after shrinking)
2. **Seed** for reproduction
3. **Failure message**

```
thread 'claim_task::fuzz_claim_task' panicked at 'Test failed:
Invariant violation: T3 violated: current_workers 6 > max_workers 5
minimal failing input: ClaimTaskInput {
    task_max_workers: 5,
    task_current_workers: 5,
    ...
}
seed: [1, 2, 3, 4, ...]'
```

### Reproducing Failures

Save the seed and re-run:
```bash
PROPTEST_CASES=1 cargo test --release claim_task -- --nocapture
```

Or use the `proptest-regressions` file that's automatically created.

## CI Integration

The fuzz tests run in CI on every PR to main. See `.github/workflows/ci.yml`:

```yaml
fuzz_tests:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: dtolnay/rust-toolchain@stable
    - name: Run fuzz tests
      working-directory: programs/agenc-coordination/fuzz
      run: |
        PROPTEST_CASES=500 cargo test --release
        cargo run --release
```

### Coverage Targets

| Target | Minimum Iterations | CI Iterations |
|--------|-------------------|---------------|
| `claim_task` | 100 | 500 |
| `complete_task` | 100 | 500 |
| `vote_dispute` | 100 | 500 |
| `resolve_dispute` | 100 | 500 |
| Edge cases | 10 | 10 |
| Race conditions | 50 | 50 |

## Adding New Fuzz Targets

### 1. Create Input Generator

In `src/arbitrary.rs`:

```rust
#[derive(Debug, Clone)]
pub struct NewInstructionInput {
    pub field1: u64,
    pub field2: [u8; 32],
}

impl Arbitrary for NewInstructionInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (arb_reward_amount(), arb_id())
            .prop_map(|(field1, field2)| NewInstructionInput { field1, field2 })
            .boxed()
    }
}
```

### 2. Add Simulation Function

In `src/scenarios.rs`:

```rust
pub fn simulate_new_instruction(
    input: &NewInstructionInput,
    state: &mut SimulatedState,
) -> SimulationResult {
    // Pre-condition checks
    if !precondition_met {
        return SimulationResult::Error("PreconditionFailed".to_string());
    }

    // Execute logic
    // ...

    // Post-condition invariant checks
    if invariant_violated {
        return SimulationResult::InvariantViolation("E3 violated".to_string());
    }

    SimulationResult::Success
}
```

### 3. Create Fuzz Target

In `fuzz_targets/new_instruction.rs`:

```rust
use agenc_coordination_fuzz::*;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    #[test]
    fn fuzz_new_instruction(input in any::<NewInstructionInput>()) {
        let result = simulate_new_instruction(&input, &mut state);
        prop_assert!(!result.is_invariant_violation());
    }
}
```

### 4. Register in `fuzz_targets/mod.rs`

```rust
pub mod new_instruction;
```

## Troubleshooting

### Tests Run Too Slowly

- Use `--release` flag
- Reduce `PROPTEST_CASES`
- Profile with `cargo flamegraph`

### Out of Memory

Proptest stores history for shrinking. Reduce:
```bash
PROPTEST_MAX_SHRINK_ITERS=1000 cargo test --release
```

### Non-Deterministic Failures

Check for:
- Uninitialized memory
- System time dependencies
- Random number generation without seed

### Compilation Errors

Ensure you're in the fuzz directory:
```bash
cd programs/agenc-coordination/fuzz
cargo build
```

## References

- [Proptest Book](https://proptest-rs.github.io/proptest/proptest/index.html)
- [THREAT_MODEL.md](audit/THREAT_MODEL.md) - Protocol invariants
- [Solana Security Best Practices](https://github.com/coral-xyz/sealevel-attacks)
