# AgenC - Cursor AI Guide

This file provides guidance when working with code in this repository.

## Critical Rules

**ALWAYS follow these rules:**

1. **No Attribution** - NEVER add Co-authored-by, signatures, or attribution tags to commits or PRs
2. **No Em Dashes** - Never use em dashes (—). Use commas, colons, parentheses, or separate sentences
3. **Branch Workflow** - NEVER push directly to main. Always create a feature branch and PR

## Project Overview

AgenC is a privacy-preserving AI agent coordination protocol on Solana with zero-knowledge proofs.

### Modules

| Module | Location | Purpose |
|--------|----------|---------|
| Anchor Program | `programs/agenc-coordination/` | Solana smart contract |
| SDK | `sdk/` | TypeScript client (`@agenc/sdk`) |
| Runtime | `runtime/` | Agent lifecycle management (`@agenc/runtime`) |
| Demo App | `demo-app/` | React web interface |
| ZK Circuits | `circuits/` | Circom/snarkjs proofs |
| MCP Server | `mcp/` | AI development tools |

### Prerequisites

- Rust + Cargo
- Solana CLI v3.0.13
- Anchor CLI v0.32.1
- Node.js >= 18
- Yarn or npm

## Build Commands

### Anchor Program (Rust)

```bash
anchor build                    # Build program
anchor test                     # Run tests (starts local validator)
cargo check --package agenc-coordination  # Type check only
```

### Runtime (TypeScript)

```bash
cd runtime
npm install
npm run build
npm test
```

### SDK (TypeScript)

```bash
cd sdk
npm install
npm run build
npm test
```

## Architecture

### On-Chain State (`programs/agenc-coordination/src/state.rs`)

```rust
// Core task with dependency support
pub struct Task {
    pub task_id: [u8; 32],
    pub creator: Pubkey,
    pub status: TaskStatus,
    pub depends_on: Option<Pubkey>,        // Parent task
    pub dependency_type: DependencyType,   // None/Data/Ordering/Proof
    // ... other fields
}

// Speculation accounts
pub struct SpeculativeCommitment { ... }
pub struct SpeculationBond { ... }
```

### Runtime Components (`runtime/src/task/`)

```
dependency-graph.ts      - DAG for task relationships
proof-pipeline.ts        - Async proof generation
commitment-ledger.ts     - Speculative state tracking
proof-deferral.ts        - Ancestor-aware submission
rollback-controller.ts   - Cascade rollbacks
speculative-executor.ts  - Single-level speculation
speculative-scheduler.ts - Main orchestrator
speculation-metrics.ts   - Observability
proof-time-estimator.ts  - Claim safety checks
```

## Speculative Execution

### What It Does

Overlaps task execution with proof generation for 2-3x latency reduction on dependent task chains.

### Critical Safety Invariant

**Proofs are NEVER submitted until all ancestor proofs are confirmed on-chain.**

### Key Classes

```typescript
// Main orchestrator
const scheduler = new SpeculativeTaskScheduler({
  maxSpeculationDepth: 3,
  maxSpeculativeStake: 10_000_000_000n, // 10 SOL
  enableSpeculation: true,
}, graph, ledger, deferral, rollback);

// Check if speculation allowed
const decision = scheduler.shouldSpeculate(taskPda);
if (decision.allowed) {
  // Execute speculatively
}
```

### Dependency Types

| Type | Value | Speculatable? |
|------|-------|---------------|
| None | 0 | N/A |
| Data | 1 | Yes - needs parent output |
| Ordering | 2 | Yes - must run after parent |
| Proof | 3 | No - needs parent proof on-chain |

### Rollback Flow

When a parent proof fails:
1. `RollbackController.rollback(parentPda, 'proof_failed')`
2. BFS traversal finds all dependent tasks
3. Active tasks aborted via AbortController
4. Pending proofs cancelled
5. Commitments marked as rolled_back
6. Metrics updated (wasted compute, stake lost)

## Testing

```bash
# Full test suite
cd runtime && npm test

# Specific component
npm test -- --grep "DependencyGraph"
npm test -- --grep "SpeculativeScheduler"
npm test -- --grep "RollbackController"

# Integration tests
npm test -- --grep "Integration"

# Chaos tests
npm test -- --grep "Chaos"
```

## Common Tasks

### Add a New Instruction

1. Create `programs/agenc-coordination/src/instructions/new_instruction.rs`
2. Add to `instructions/mod.rs`
3. Add handler to `lib.rs`
4. Add events to `events.rs`
5. Add errors to `errors.rs`
6. Run `anchor build`

### Add a Runtime Component

1. Create `runtime/src/task/new-component.ts`
2. Add tests in `runtime/src/task/__tests__/new-component.test.ts`
3. Export from `runtime/src/task/index.ts`
4. Run `npm run build && npm test`

### Create a PR

```bash
git checkout -b feat/description
# make changes
git add -A
git commit -m "feat(scope): description"
git push -u origin feat/description
gh pr create --title "feat(scope): description" --body "Description. Closes #XXX"
```

## Documentation

| Document | Location |
|----------|----------|
| Design Document | `docs/design/speculative-execution/DESIGN-DOCUMENT.md` |
| API Specification | `docs/design/speculative-execution/API-SPECIFICATION.md` |
| On-Chain Spec | `docs/design/speculative-execution/ON-CHAIN-SPECIFICATION.md` |
| White Paper | `docs/whitepaper/SPECULATIVE-EXECUTION-WHITEPAPER.md` |
| Risk Assessment | `docs/design/speculative-execution/RISK-ASSESSMENT.md` |
| Test Plans | `docs/design/speculative-execution/test-plans/` |
| Runbooks | `docs/design/speculative-execution/runbooks/` |

## Error Handling

### Anchor Errors (6900+)

```rust
ParentTaskCancelled = 6900,
ParentTaskDisputed = 6901,
InvalidDependencyType = 6902,
```

### Runtime Errors

```typescript
class SpeculationError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean
  ) { super(message); }
}
```

## Metrics

```typescript
const metrics = scheduler.getMetrics();
// {
//   speculativeExecutions: number,
//   speculativeHits: number,
//   speculativeMisses: number,
//   hitRate: number,
//   rollbackRate: number,
// }
```

## IDL Regeneration

After changing Anchor program:

```bash
anchor build
# IDL is at target/idl/agenc_coordination.json
# Types at target/types/agenc_coordination.ts
```

Copy to runtime/sdk if needed:
```bash
cp target/idl/agenc_coordination.json runtime/idl/
cp target/types/agenc_coordination.ts runtime/src/types/
```
