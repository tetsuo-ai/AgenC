# Speculative Execution - Implementation Guide for Agents

This guide helps AI coding agents implement the speculative execution system.

## Quick Links

- **Epic:** #291
- **Design Document:** `DESIGN-DOCUMENT.md`
- **API Spec:** `API-SPECIFICATION.md`
- **On-Chain Spec:** `ON-CHAIN-SPECIFICATION.md`

## Implementation Order

**CRITICAL: Follow this order. Each phase depends on the previous.**

### Phase 0: On-Chain Prerequisites (START HERE)
```
#260 → #262 → #263
```
1. **#260** - Add `depends_on` field to Task struct in `programs/agenc-coordination/src/state.rs`
2. **#262** - Add SDK query helpers in `packages/sdk/src/`
3. **#263** - Add `create_dependent_task` instruction

### Phase 1: Runtime Foundation
```
#265 → #267 → #268
```
1. **#265** - Create `DependencyGraph` class in `packages/runtime/src/task/`
2. **#267** - Create `ProofPipeline` for async proof generation
3. **#268** - Basic single-level speculation (MVP milestone)

### Phase 2: Full Speculation Core
```
#270 → #272 → #274 → #276
```
1. **#270** - `CommitmentLedger`
2. **#272** - `ProofDeferralManager`
3. **#274** - `RollbackController`
4. **#276** - `SpeculativeTaskScheduler` (ties everything together)

### Phase 3: Safety & Bounds
```
#277, #279, #280 (can be parallel)
```

### Phase 4: On-Chain State (Optional)
```
#281 → #283 → #284
```

### Phase 5: Observability & Testing
```
#286, #287, #288
```

## Key Files to Modify

### On-Chain (Anchor/Rust)
```
programs/agenc-coordination/src/
├── state.rs          # Task struct (add depends_on)
├── instructions/
│   ├── mod.rs
│   └── create_dependent_task.rs  # NEW
├── events.rs         # DependentTaskCreated event
└── errors.rs         # New error codes
```

### Runtime (TypeScript)
```
packages/runtime/src/task/
├── dependency-graph.ts        # NEW (#265)
├── proof-pipeline.ts          # NEW (#267)
├── speculative-executor.ts    # NEW (#268)
├── commitment-ledger.ts       # NEW (#270)
├── proof-deferral.ts          # NEW (#272)
├── rollback-controller.ts     # NEW (#274)
└── speculative-scheduler.ts   # NEW (#276)
```

### SDK (TypeScript)
```
packages/sdk/src/
├── queries.ts                 # Add getTasksByDependency (#262)
└── instructions/
    └── createDependentTask.ts # NEW (#263)
```

## Critical Invariant

**NEVER submit a proof until all ancestor proofs are confirmed on-chain.**

This must be enforced in:
- `ProofDeferralManager.trySubmit()`
- `SpeculativeTaskScheduler.shouldSpeculate()`

See `DESIGN-DOCUMENT.md` Section 5.1 for the formal correctness argument.

## Testing Requirements

Each PR must include:
1. Unit tests for new code (see `test-plans/unit-test-plan.md`)
2. Integration tests if touching multiple components
3. Update to existing tests if modifying shared code

Run tests:
```bash
# Unit tests
yarn test

# Integration tests (requires localnet)
yarn test:integration

# Specific package
yarn workspace @agenc/runtime test
```

## Code Patterns

### TypeScript Interfaces

Follow the patterns in `API-SPECIFICATION.md`. Example:

```typescript
// Good: matches spec
export interface SpeculativeCommitment {
  id: string;
  sourceTaskPda: PublicKey;
  resultHash: Uint8Array;
  proofStatus: ProofStatus;
  // ... all fields from spec
}

// Bad: deviating from spec
export interface Commitment {
  taskId: string;  // Wrong: should be sourceTaskPda
  hash: string;    // Wrong: should be Uint8Array
}
```

### Rust Accounts

Follow existing patterns in `state.rs`:

```rust
#[account]
pub struct Task {
    // ... existing fields ...
    
    /// NEW: Optional parent task dependency
    pub depends_on: Option<Pubkey>,
    pub dependency_type: DependencyType,
}
```

### Events

All state changes must emit events:

```rust
emit!(DependentTaskCreated {
    task_id,
    parent_task: ctx.accounts.parent_task.key(),
    dependency_type,
    creator: ctx.accounts.creator.key(),
    timestamp: Clock::get()?.unix_timestamp,
});
```

## Common Mistakes to Avoid

1. **Don't skip phases** - Phase 1 code depends on Phase 0 being complete
2. **Don't forget events** - Every instruction needs events for indexing
3. **Don't ignore the invariant** - Proof ordering is critical for correctness
4. **Don't hardcode limits** - Use config for depth/stake limits
5. **Don't skip tests** - Every PR needs tests

## Reference Documents

| Need | Document |
|------|----------|
| TypeScript interfaces | `API-SPECIFICATION.md` |
| Rust structs/instructions | `ON-CHAIN-SPECIFICATION.md` |
| Component relationships | `diagrams/class-diagram.md` |
| Execution flow | `diagrams/sequence-happy-path.md` |
| Rollback flow | `diagrams/sequence-rollback.md` |
| State transitions | `diagrams/state-machine-*.md` |
| Test cases | `test-plans/unit-test-plan.md` |
| Failure modes | `RISK-ASSESSMENT.md` |

## Debugging Tips

1. **Check dependency graph** - Use `graph.toJSON()` to inspect state
2. **Check commitment ledger** - Use `ledger.getStats()` for counts
3. **Enable debug logging** - Set `LOG_LEVEL=debug`
4. **Trace proof lifecycle** - Check `proofStatus` transitions

## Getting Help

- Check issue description for acceptance criteria
- Check `DESIGN-DOCUMENT.md` for detailed design
- Check test plans for expected behavior
- Reference existing runtime code for patterns
