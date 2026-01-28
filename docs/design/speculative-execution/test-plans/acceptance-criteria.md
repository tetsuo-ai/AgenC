# Acceptance Criteria: Speculative Execution

> **Version:** 1.0  
> **Last Updated:** 2025-01-28  
> **Scope:** Phase-by-phase acceptance criteria for speculative execution

## Overview

This document defines the acceptance criteria for each implementation phase of the speculative execution feature. These criteria serve as gates for phase completion and progression.

---

## Phase Summary

| Phase | Name | Focus | Duration |
|-------|------|-------|----------|
| Phase 0 | Prerequisites | Foundation | 1 sprint |
| Phase 1 | Core Runtime | MVP speculation | 2 sprints |
| Phase 2 | On-Chain Integration | Commitments & stake | 2 sprints |
| Phase 3 | Quality & Observability | Production readiness | 1 sprint |
| Phase 4 | Advanced Features | Optimization | 1-2 sprints |

---

## Phase 0: Prerequisites

**Objective:** Establish the foundation required for speculation.

**Issue Reference:** #259

### Acceptance Criteria

#### AC-0.1: Task Dependency Field
- [ ] `depends_on: Option<Pubkey>` field added to Task struct
- [ ] Field serialization/deserialization working
- [ ] Backward compatible (existing tasks have `None`)
- [ ] Migration script for existing data (if needed)

**Verification:**
```bash
# Create task with dependency
solana program invoke create_task --depends-on <parent_pubkey>

# Query task, verify field
solana account <task_pubkey> --output json | jq '.data.depends_on'
```

#### AC-0.2: Dependent Task Instruction
- [ ] `create_dependent_task` instruction implemented
- [ ] Validates parent task exists
- [ ] Validates parent task is not cancelled
- [ ] Validates parent task is not already completed (optional - for strict mode)

**Verification:**
```rust
// Test: create with valid parent - succeeds
// Test: create with non-existent parent - fails with ParentNotFound
// Test: create with cancelled parent - fails with ParentCancelled
```

#### AC-0.3: Schema Documentation
- [ ] Updated IDL with new field
- [ ] TypeScript types regenerated
- [ ] SDK documentation updated

**Verification:**
```typescript
// TypeScript compilation succeeds
// New field available: task.dependsOn: PublicKey | null
```

### Phase 0 Exit Criteria

| Criterion | Status |
|-----------|--------|
| All unit tests pass | ☐ |
| Integration test: create dependent task | ☐ |
| SDK updated and tested | ☐ |
| Documentation complete | ☐ |
| PR reviewed and merged | ☐ |

---

## Phase 1: Core Runtime (MVP)

**Objective:** Implement runtime-only speculative execution.

**Issue References:** #261, #264, #266, #269, #271

### Component Acceptance Criteria

#### AC-1.1: DependencyGraph (#261)

**Functional Requirements:**
- [ ] Add node with optional parent
- [ ] Remove node (only if leaf)
- [ ] Get ancestors (ordered, nearest-first)
- [ ] Get descendants (topological order)
- [ ] Calculate depth from root
- [ ] Detect cycles on insertion
- [ ] Thread-safe operations

**Performance Requirements:**
- [ ] O(1) node lookup
- [ ] O(depth) ancestor traversal
- [ ] O(descendants) descendant traversal
- [ ] O(n) topological sort

**Verification Tests:**
```
TEST-DG-001 through TEST-DG-042 (see unit-test-plan.md)
```

---

#### AC-1.2: ProofDeferralManager (#264)

**Functional Requirements:**
- [ ] Enqueue proof with ancestor list
- [ ] Check if ancestors are confirmed
- [ ] Dequeue proofs whose ancestors are all confirmed
- [ ] Handle timeout (mark as timed out)
- [ ] Remove proof from queue
- [ ] Event emission on state changes

**Behavioral Requirements:**
- [ ] FIFO ordering for proofs with equal readiness
- [ ] Priority support (optional for MVP)
- [ ] Timeout configurable per-proof or global

**Verification Tests:**
```
TEST-PD-001 through TEST-PD-031 (see unit-test-plan.md)
```

---

#### AC-1.3: CommitmentLedger (#266)

**Functional Requirements:**
- [ ] Create commitment (taskId, agentId, depth, stake)
- [ ] Read commitment by taskId
- [ ] Update status (PENDING → CONFIRMED | FAILED)
- [ ] Delete commitment
- [ ] Calculate stake: `base × 2^depth`
- [ ] Track total stake per agent
- [ ] Cascade failure marking

**Constraints:**
- [ ] CONFIRMED status is terminal (immutable)
- [ ] FAILED status is terminal
- [ ] Status transitions validated

**Verification Tests:**
```
TEST-CL-001 through TEST-CL-032 (see unit-test-plan.md)
```

---

#### AC-1.4: RollbackController (#269)

**Functional Requirements:**
- [ ] Single task rollback
- [ ] Cascade rollback (all descendants)
- [ ] Rollback order: leaves first (reverse topological)
- [ ] Release stake on rollback
- [ ] Idempotent rollback (no double processing)
- [ ] Pre/post hooks for extensibility

**Safety Requirements:**
- [ ] Cannot rollback CONFIRMED tasks
- [ ] Partial rollback supported (stop at confirmed ancestors)
- [ ] State snapshot restoration

**Verification Tests:**
```
TEST-RC-001 through TEST-RC-031 (see unit-test-plan.md)
```

---

#### AC-1.5: SpeculativeScheduler (#271)

**Functional Requirements:**
- [ ] `shouldSpeculate(task)` decision logic
- [ ] Respect `max_depth` limit
- [ ] Respect `max_parallel_branches` limit
- [ ] Respect `max_stake` per agent
- [ ] Claim window buffer check
- [ ] Mode-based configuration (conservative/balanced/aggressive/custom)

**Integration:**
- [ ] Integrates with DependencyGraph for depth check
- [ ] Integrates with CommitmentLedger for stake check
- [ ] Emits scheduling decisions as events

**Verification Tests:**
```
TEST-SS-001 through TEST-SS-032 (see unit-test-plan.md)
```

---

### Phase 1 Integration Criteria

#### AC-1.6: Happy Path Integration
- [ ] Single speculation: Task B speculates on A, both confirm
- [ ] Chain speculation: A → B → C, all confirm in order
- [ ] DAG speculation: Diamond pattern works correctly

**Verification:**
```
INT-HP-001 through INT-HP-004 (see integration-test-plan.md)
```

#### AC-1.7: Failure Handling Integration
- [ ] Proof failure triggers cascade rollback
- [ ] Timeout triggers rollback and stake return
- [ ] Ancestor failure during execution aborts child

**Verification:**
```
INT-FAIL-001 through INT-FAIL-005 (see integration-test-plan.md)
```

#### AC-1.8: Limit Enforcement Integration
- [ ] Depth limit prevents over-deep speculation
- [ ] Stake limit prevents over-committed agents
- [ ] Claim window buffer prevents tight-window speculation

**Verification:**
```
INT-LIM-001 through INT-LIM-004 (see integration-test-plan.md)
```

---

### Phase 1 Performance Criteria

| Metric | MVP Target | Measurement |
|--------|------------|-------------|
| Latency reduction (3-task chain) | ≥1.5× | Benchmark |
| Throughput impact | <15% decrease | Benchmark |
| Memory overhead | <500MB @ depth 5 | Profiling |
| Rollback latency (10 tasks) | <500ms | Benchmark |

---

### Phase 1 Exit Criteria

| Criterion | Required | Status |
|-----------|----------|--------|
| All unit tests pass | Yes | ☐ |
| All integration tests pass | Yes | ☐ |
| Happy path demo | Yes | ☐ |
| Performance targets met | Yes | ☐ |
| Code review approved | Yes | ☐ |
| Documentation complete | Yes | ☐ |
| No critical bugs | Yes | ☐ |

**Phase 1 Deliverable:** Runtime-only speculation working with local state management. Suitable for single-agent use cases.

---

## Phase 2: On-Chain Integration

**Objective:** Add on-chain commitment tracking for cross-agent trust.

**Issue References:** #273, #275

### Acceptance Criteria

#### AC-2.1: SpeculativeCommitment Account (#273)

**Account Structure:**
```rust
pub struct SpeculativeCommitment {
    pub task: Pubkey,           // Task this commitment is for
    pub agent: Pubkey,          // Agent making commitment
    pub parent_task: Pubkey,    // Ancestor task (speculating on)
    pub depth: u8,              // Speculation depth
    pub staked_amount: u64,     // Bonded stake (lamports)
    pub status: CommitmentStatus, // PENDING | CONFIRMED | FAILED
    pub created_at: i64,        // Timestamp
    pub confirmed_at: Option<i64>,
    pub bump: u8,
}
```

**Functional Requirements:**
- [ ] Create commitment (bonds stake)
- [ ] Confirm commitment (releases stake)
- [ ] Fail commitment (triggers slash/return)
- [ ] Query commitment by task
- [ ] Query commitments by agent

**Verification:**
```bash
# Create commitment
solana program invoke create_commitment \
  --task <task> --parent <parent> --stake 1000000

# Query
solana account <commitment_pda> --output json
```

---

#### AC-2.2: Stake Bonding (#275)

**Functional Requirements:**
- [ ] Stake transferred from agent to escrow on commitment
- [ ] Stake formula: `base_bond × 2^depth`
- [ ] Maximum stake per agent enforced
- [ ] Stake returned on successful confirmation
- [ ] Partial slash on failure (configurable %)

**Slash Distribution:**
- [ ] 50% to protocol treasury
- [ ] 50% to affected downstream agents (proportional)

**Verification:**
```rust
// Test: Create commitment, verify stake deducted
// Test: Confirm commitment, verify stake returned
// Test: Fail commitment, verify slash distribution
```

---

#### AC-2.3: On-Chain/Runtime Sync

**Functional Requirements:**
- [ ] Runtime can operate in "on-chain" mode
- [ ] Commitments written to chain before execution
- [ ] Runtime polls chain for confirmation status
- [ ] Handles chain latency gracefully

**Configuration:**
```toml
[speculation]
commitment_mode = "on_chain"  # or "runtime_only"
```

---

### Phase 2 Integration Criteria

#### AC-2.4: Cross-Agent Speculation
- [ ] Agent B can speculate on Agent A's unconfirmed task
- [ ] Stakes tracked per-agent on-chain
- [ ] Failure of A's task triggers B's stake return

#### AC-2.5: Dispute Resolution
- [ ] Invalid speculation claim can be challenged
- [ ] Slashing executed via on-chain instruction
- [ ] Affected agents can claim compensation

---

### Phase 2 Exit Criteria

| Criterion | Required | Status |
|-----------|----------|--------|
| On-chain accounts deployed | Yes | ☐ |
| Stake bonding working | Yes | ☐ |
| Cross-agent test passing | Yes | ☐ |
| Slash distribution correct | Yes | ☐ |
| Audit (optional, recommended) | Recommended | ☐ |
| Devnet deployment successful | Yes | ☐ |

**Phase 2 Deliverable:** Full on-chain commitment tracking suitable for trustless multi-agent speculation.

---

## Phase 3: Quality & Observability

**Objective:** Production-ready quality and monitoring.

**Issue References:** #278, #282

### Acceptance Criteria

#### AC-3.1: Metrics & Observability (#278)

**Required Metrics:**
- [ ] `speculation_tasks_total` (counter)
- [ ] `speculation_tasks_confirmed_total` (counter)
- [ ] `speculation_tasks_rolled_back_total` (counter)
- [ ] `speculation_tasks_failed_total` (counter)
- [ ] `speculation_e2e_latency_ms` (histogram)
- [ ] `speculation_depth_current` (gauge)
- [ ] `speculation_stake_locked_lamports` (gauge)
- [ ] `speculation_rollback_cascade_size` (histogram)

**Dashboards:**
- [ ] Overview dashboard with key metrics
- [ ] Detailed performance dashboard
- [ ] Alert rules configured

**Verification:**
```bash
# Metrics endpoint returns expected metrics
curl http://localhost:9090/metrics | grep speculation_

# Dashboard loads in Grafana
# Alerts fire on test conditions
```

---

#### AC-3.2: Comprehensive Test Suite (#282)

**Test Coverage:**
- [ ] Unit test coverage ≥90%
- [ ] Integration test coverage ≥85%
- [ ] All happy paths tested
- [ ] All failure modes tested
- [ ] Edge cases documented and tested

**Chaos Testing:**
- [ ] Network partition scenario passes
- [ ] Component crash recovery passes
- [ ] Race condition tests pass (5+ seeds)

**Performance Testing:**
- [ ] Latency benchmarks documented
- [ ] Throughput benchmarks documented
- [ ] Memory leak tests pass

**Verification:**
```bash
# Coverage report
pnpm test:coverage

# Chaos tests
pnpm chaos:run --scenario all

# Performance tests
pnpm perf:run --suite full
```

---

#### AC-3.3: Documentation

**Required Documentation:**
- [ ] Configuration guide complete
- [ ] Runbook for operators
- [ ] API reference
- [ ] Architecture diagrams
- [ ] Troubleshooting guide

---

### Phase 3 Exit Criteria

| Criterion | Required | Status |
|-----------|----------|--------|
| Metrics pipeline working | Yes | ☐ |
| Dashboards deployed | Yes | ☐ |
| Alerts configured | Yes | ☐ |
| Test coverage targets met | Yes | ☐ |
| Chaos tests pass | Yes | ☐ |
| Performance baselines established | Yes | ☐ |
| Documentation complete | Yes | ☐ |
| Load testing complete | Yes | ☐ |

**Phase 3 Deliverable:** Production-ready system with monitoring, alerting, and comprehensive test coverage.

---

## Phase 4: Advanced Features (Optional)

**Objective:** Optimization and advanced capabilities.

### Acceptance Criteria

#### AC-4.1: Adaptive Speculation

**Features:**
- [ ] Dynamic depth adjustment based on confirmation rate
- [ ] Learning optimal speculation depth per task type
- [ ] Automatic mode selection based on conditions

---

#### AC-4.2: Speculative Proof Aggregation

**Features:**
- [ ] Batch multiple speculative proofs
- [ ] Single on-chain transaction for chain confirmation
- [ ] Gas cost reduction

---

#### AC-4.3: Cross-Chain Speculation

**Features:**
- [ ] Speculate on tasks with cross-chain dependencies
- [ ] Bridge finality tracking
- [ ] Enhanced timeout handling

---

### Phase 4 Exit Criteria

| Criterion | Required | Status |
|-----------|----------|--------|
| Feature flags implemented | Yes | ☐ |
| A/B testing infrastructure | Recommended | ☐ |
| Performance improvement measured | Yes | ☐ |
| No regression in core features | Yes | ☐ |

---

## Definition of Done (All Phases)

Each phase completion requires:

### Code Quality
- [ ] All tests pass
- [ ] No critical or high severity bugs
- [ ] Code review by 2+ engineers
- [ ] No lint errors or warnings
- [ ] TypeScript strict mode compliance

### Documentation
- [ ] Code comments for complex logic
- [ ] API documentation updated
- [ ] Changelog entry added
- [ ] Architecture docs updated (if changed)

### Operations
- [ ] Deployment runbook updated
- [ ] Rollback procedure documented
- [ ] Feature flag (if applicable) documented
- [ ] Monitoring and alerts updated

### Security
- [ ] No new security vulnerabilities
- [ ] Input validation complete
- [ ] Rate limiting considered
- [ ] Audit trail for sensitive operations

---

## Acceptance Test Checklist

### Functional Acceptance

| Test | Phase | Priority | Status |
|------|-------|----------|--------|
| Create dependent task | 0 | Critical | ☐ |
| Single speculation success | 1 | Critical | ☐ |
| Chain speculation (3 levels) | 1 | Critical | ☐ |
| DAG speculation | 1 | High | ☐ |
| Proof failure cascade | 1 | Critical | ☐ |
| Timeout handling | 1 | Critical | ☐ |
| Depth limit enforcement | 1 | High | ☐ |
| Stake limit enforcement | 1 | High | ☐ |
| On-chain commitment | 2 | Critical | ☐ |
| Stake bonding/return | 2 | Critical | ☐ |
| Cross-agent speculation | 2 | High | ☐ |
| Slash distribution | 2 | High | ☐ |
| Metrics emission | 3 | High | ☐ |
| Dashboard operational | 3 | Medium | ☐ |

### Non-Functional Acceptance

| Test | Phase | Target | Status |
|------|-------|--------|--------|
| Latency improvement | 1 | ≥1.5× | ☐ |
| Throughput impact | 1 | <15% decrease | ☐ |
| Memory usage | 1 | <500MB @ depth 5 | ☐ |
| Rollback latency | 1 | <500ms | ☐ |
| Test coverage | 3 | ≥90% unit, ≥85% integration | ☐ |
| Chaos test pass rate | 3 | 100% | ☐ |

---

## Sign-Off

### Phase 0 Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Engineering Lead | | | |
| QA Lead | | | |

### Phase 1 Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Engineering Lead | | | |
| QA Lead | | | |
| Product Owner | | | |

### Phase 2 Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Engineering Lead | | | |
| QA Lead | | | |
| Security Lead | | | |
| Product Owner | | | |

### Phase 3 Sign-Off (Production Release)

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Engineering Lead | | | |
| QA Lead | | | |
| Security Lead | | | |
| DevOps Lead | | | |
| Product Owner | | | |
| VP Engineering | | | |

---

## Appendix: Risk Register

| Risk | Impact | Likelihood | Mitigation | Phase |
|------|--------|------------|------------|-------|
| Cascade rollback performance | High | Medium | Optimize graph traversal, add limits | 1 |
| Memory leak in long-running | High | Low | Extensive soak testing | 3 |
| Race conditions | High | Medium | Chaos testing, multiple seeds | 3 |
| On-chain stake accounting bugs | Critical | Low | Audit, extensive testing | 2 |
| Cross-agent trust issues | High | Medium | Clear documentation, dispute mechanism | 2 |
