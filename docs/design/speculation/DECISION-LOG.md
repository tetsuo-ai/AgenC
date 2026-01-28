# Architectural Decision Log

This document records significant architectural decisions made during the design of Speculative Execution.

---

## ADR-001: On-Chain Task Dependencies Required

**Date:** 2026-01-28  
**Status:** Accepted  
**Issue:** #259

### Context

The original design doc (#245) proposed speculative execution but didn't specify where dependency information comes from. The on-chain `Task` struct has no `depends_on` field.

### Decision

Add `depends_on: Option<Pubkey>` to the Task struct as a prerequisite for speculation.

### Rationale

- Without on-chain dependency data, the runtime has no way to know which tasks depend on which
- Alternative (off-chain dependency tracking) creates trust issues for cross-agent speculation
- Schema change is backward compatible (existing tasks have `None`)

### Consequences

- +33 bytes per Task account
- New instruction needed for creating dependent tasks
- Must validate parent exists and isn't cancelled

---

## ADR-002: Proof Ordering Invariant

**Date:** 2026-01-28  
**Status:** Accepted  
**Issue:** #271

### Context

When should a speculative task's proof be submitted on-chain?

### Decision

A task's proof can ONLY be submitted when ALL ancestor commitments are CONFIRMED on-chain.

### Rationale

- Submitting proofs out of order would allow invalid state transitions
- If A→B and B's proof submits before A's, a failure in A's proof would mean B's proof verified against invalid inputs
- This is the core safety invariant of the system

### Consequences

- Proof submission may be delayed waiting for ancestors
- Need to track ancestor confirmation status
- Rollback is triggered if ancestor fails while waiting

---

## ADR-003: Exponential Stake Bonding

**Date:** 2026-01-28  
**Status:** Accepted  
**Issue:** #275

### Context

How much stake should be required for speculative commitments?

### Decision

`bonded_stake = base_bond × (2 ^ speculation_depth)`

### Rationale

- Deeper speculation = more downstream work at risk = higher stake
- Exponential growth naturally limits depth without hard caps
- Creates economic disincentive for deep speculation chains
- base_bond can be tuned per-deployment

### Consequences

- Depth 3 requires 8x base_bond
- Agents need sufficient balance for deep speculation
- May limit speculation for low-balance agents

---

## ADR-004: Runtime-First, On-Chain Optional

**Date:** 2026-01-28  
**Status:** Accepted  
**Issues:** #271, #273

### Context

Should speculative commitments be recorded on-chain?

### Decision

Phase 1 implements pure runtime speculation. Phase 2 adds optional on-chain commitments.

### Rationale

- Runtime-only is simpler and sufficient for single-agent speculation
- On-chain commitments needed for cross-agent trust and dispute resolution
- Phased approach allows validating core logic before adding complexity
- On-chain mode can be a configuration flag

### Consequences

- Phase 1 has no on-chain audit trail
- Cross-agent speculation requires Phase 2
- Must design runtime to support both modes

---

## ADR-005: Rollback Order (Leaves First)

**Date:** 2026-01-28  
**Status:** Accepted  
**Issue:** #269

### Context

When rolling back a failed speculation chain, what order should tasks be rolled back?

### Decision

Reverse topological order (leaves first, then parents).

### Rationale

- Rolling back a parent before its children could leave orphaned state
- Leaves have no dependents, safe to abort immediately
- Working up the tree ensures clean state at each level
- Matches intuition: undo in reverse order of execution

### Consequences

- Need efficient reverse topological sort
- Must handle concurrent rollbacks correctly
- Graph mutations during rollback need synchronization

---

## ADR-006: Claim Expiry Buffer

**Date:** 2026-01-28  
**Status:** Accepted  
**Issue:** #271

### Context

Should we speculate on tasks whose claims might expire before proof confirmation?

### Decision

Only speculate if `claim_expiry - now > claimBufferMs` (configurable, default 60s).

### Rationale

- Speculating on expiring claims wastes compute if proof can't be submitted in time
- Buffer should account for proof generation + submission + confirmation time
- Configurable to allow tuning based on actual proof latency

### Consequences

- Some tasks may not be speculatable due to tight claim windows
- Reduces wasted work from claim expiry races
- Buffer should be monitored and tuned

---

## ADR-007: 50/50 Slash Distribution

**Date:** 2026-01-28  
**Status:** Accepted  
**Issue:** #275

### Context

How should slashed stake be distributed?

### Decision

50% to protocol treasury, 50% to affected downstream agents (proportional to wasted compute).

### Rationale

- Treasury share covers protocol operational costs
- Agent share compensates for wasted compute
- 50/50 is simple and fair starting point
- Can be adjusted via SpeculationConfig

### Consequences

- Affected agents must claim their share (gas cost)
- Need to track compute time per affected task
- Distribution calculation adds complexity

---

## Template for Future Decisions

```markdown
## ADR-XXX: [Title]

**Date:** YYYY-MM-DD  
**Status:** Proposed | Accepted | Deprecated | Superseded  
**Issue:** #XXX

### Context

[What is the issue we're addressing?]

### Decision

[What did we decide?]

### Rationale

[Why did we make this decision?]

### Consequences

[What are the implications?]
```
