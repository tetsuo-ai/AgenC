# AgenC Speculative Execution - Comprehensive Test Plan

> **Version:** 1.0.0  
> **Last Updated:** 2025-01-28  
> **Status:** Draft  
> **Owner:** AgenC Core Team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Test Strategy](#2-test-strategy)
3. [Unit Test Cases](#3-unit-test-cases)
4. [Integration Test Scenarios](#4-integration-test-scenarios)
5. [Chaos Test Scenarios](#5-chaos-test-scenarios)
6. [Performance Test Cases](#6-performance-test-cases)
7. [Security Test Cases](#7-security-test-cases)
8. [Acceptance Criteria Matrix](#8-acceptance-criteria-matrix)
9. [Test Execution Schedule](#9-test-execution-schedule)
10. [Appendix](#10-appendix)

---

## 1. Executive Summary

This document defines the complete testing strategy for the AgenC Speculative Execution feature. Speculative execution enables agents to execute dependent tasks optimistically before ZK proof verification completes, dramatically reducing end-to-end latency for task chains while maintaining cryptographic guarantees through stake-backed commitments and rollback mechanisms.

### 1.1 Feature Overview

**Speculative Execution** allows:
- Tasks to proceed based on cryptographic commitments before proof verification
- Stake-backed guarantees for speculative claims
- Automatic rollback on proof failures
- Support for complex task dependency graphs (linear chains, diamonds, DAGs)

### 1.2 Components Under Test

| Component | Description | Criticality |
|-----------|-------------|-------------|
| **DependencyGraph** | Manages task dependency relationships and topological ordering | Critical |
| **ProofDeferralManager** | Handles deferred proof verification and claim lifecycles | Critical |
| **CommitmentLedger** | Records and validates speculative commitments on-chain | Critical |
| **RollbackController** | Orchestrates cascading rollbacks on proof failures | Critical |
| **SpeculativeTaskScheduler** | Schedules speculative execution based on dependencies | High |

### 1.3 Success Criteria

- ✅ All P0 test cases pass
- ✅ Minimum 80% code coverage across all components
- ✅ Zero critical/high severity bugs in security tests
- ✅ Performance meets latency improvement targets (≥3x for 5-task chains)
- ✅ All chaos tests complete without data corruption

---

## 2. Test Strategy

### 2.1 Test Levels

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TEST PYRAMID                                  │
├─────────────────────────────────────────────────────────────────────┤
│                          ▲                                          │
│                         /E\         E2E Tests (5%)                  │
│                        /2E \        - Full system integration       │
│                       /────\        - Multi-agent scenarios         │
│                      /      \                                       │
│                     /Integr. \      Integration Tests (20%)         │
│                    /──────────\     - Component interactions        │
│                   /            \    - Happy/failure paths           │
│                  /   Unit       \   Unit Tests (75%)                │
│                 /────────────────\  - Component isolation           │
│                                     - Edge cases                    │
└─────────────────────────────────────────────────────────────────────┘
```

| Level | Coverage Target | Tools | Runtime |
|-------|-----------------|-------|---------|
| **Unit** | 85% | Vitest, Rust test | < 2 min |
| **Integration** | 70% | Anchor test, Mocha | < 10 min |
| **E2E** | 50% | Custom harness | < 30 min |
| **Chaos** | N/A | Chaos monkey | < 1 hr |
| **Performance** | N/A | k6, custom bench | < 2 hr |

### 2.2 Test Environments

| Environment | Purpose | Configuration | Data |
|-------------|---------|---------------|------|
| **Local** | Unit + quick integration | Local validator, mock proofs | Synthetic |
| **Devnet** | Full integration + E2E | Solana devnet, real proofs | Test fixtures |
| **Testnet** | Pre-production validation | Solana testnet | Sanitized prod |
| **Staging** | Final validation | Mainnet-like config | Production clone |

#### Environment Setup Matrix

| Capability | Local | Devnet | Testnet | Staging |
|------------|-------|--------|---------|---------|
| Real ZK Proofs | ❌ | ✅ | ✅ | ✅ |
| Multi-Agent | Limited | ✅ | ✅ | ✅ |
| Real Stakes | ❌ | ✅ (test SOL) | ✅ | ✅ |
| Network Latency Sim | ❌ | ✅ | ✅ | ✅ |
| Privacy Cash | Mock | ✅ | ✅ | ✅ |

### 2.3 Coverage Requirements

| Component | Line Coverage | Branch Coverage | Mutation Score |
|-----------|---------------|-----------------|----------------|
| DependencyGraph | 90% | 85% | 75% |
| ProofDeferralManager | 90% | 85% | 75% |
| CommitmentLedger | 95% | 90% | 80% |
| RollbackController | 95% | 90% | 80% |
| SpeculativeTaskScheduler | 85% | 80% | 70% |
| **Overall Minimum** | **80%** | **75%** | **70%** |

### 2.4 CI/CD Integration

```yaml
# .github/workflows/speculation-tests.yml
name: Speculative Execution Tests

on:
  push:
    paths:
      - 'programs/**/speculation/**'
      - 'sdk/src/speculation/**'
      - 'runtime/src/speculation/**'
  pull_request:
    branches: [main, develop]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Unit Tests
        run: |
          npm run test:unit:speculation
          cargo test --package speculation
      - name: Coverage Check
        run: npm run coverage -- --min 80

  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    steps:
      - name: Start Local Validator
        run: solana-test-validator &
      - name: Run Integration Tests
        run: anchor test --skip-build tests/speculation/

  chaos-tests:
    runs-on: ubuntu-latest
    needs: integration-tests
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Run Chaos Suite
        run: npm run test:chaos:speculation
        timeout-minutes: 60

  performance-tests:
    runs-on: ubuntu-latest
    needs: integration-tests
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - name: Run Performance Benchmarks
        run: npm run bench:speculation
      - name: Upload Results
        uses: actions/upload-artifact@v4
        with:
          name: perf-results
          path: bench-results/
```

### 2.5 Test Data Management

- **Fixtures:** `/tests/fixtures/speculation/` - Static test data
- **Generators:** `/tests/generators/speculation/` - Dynamic data generation
- **Snapshots:** `/tests/snapshots/speculation/` - Expected output snapshots
- **Mocks:** `/tests/mocks/speculation/` - Mock implementations

---

## 3. Unit Test Cases

### 3.1 DependencyGraph Component

| Test ID | Description | Input | Expected Output | Priority |
|---------|-------------|-------|-----------------|----------|
| **DG-001** | Create empty graph | `new DependencyGraph()` | Empty graph with 0 nodes | P0 |
| **DG-002** | Add single task node | `addTask(taskId)` | Graph contains task, no edges | P0 |
| **DG-003** | Add task with single dependency | `addTask(B, [A])` | B depends on A | P0 |
| **DG-004** | Add task with multiple dependencies | `addTask(C, [A, B])` | C depends on A and B | P0 |
| **DG-005** | Detect simple cycle (A→B→A) | `addTask(A, [B]); addTask(B, [A])` | Throws `CycleDetectedError` | P0 |
| **DG-006** | Detect complex cycle (A→B→C→A) | Three-node cycle | Throws `CycleDetectedError` | P0 |
| **DG-007** | Topological sort - linear chain | A→B→C | `[A, B, C]` | P0 |
| **DG-008** | Topological sort - diamond | A→B,C→D | `[A, B, C, D]` or `[A, C, B, D]` | P0 |
| **DG-009** | Topological sort - complex DAG | 10-node DAG | Valid topological order | P1 |
| **DG-010** | Get immediate dependencies | `getDependencies(C)` in A→B→C | `[B]` | P0 |
| **DG-011** | Get transitive dependencies | `getAllDependencies(C)` in A→B→C | `[A, B]` | P0 |
| **DG-012** | Get dependents (reverse lookup) | `getDependents(A)` in A→B→C | `[B]` immediate, `[B, C]` transitive | P1 |
| **DG-013** | Remove task - leaf node | Remove C from A→B→C | A→B remains | P1 |
| **DG-014** | Remove task - middle node | Remove B from A→B→C | Throws `HasDependentsError` | P0 |
| **DG-015** | Remove task - cascade option | Remove B with cascade=true | Only A remains | P2 |
| **DG-016** | Check if task is ready | `isReady(B)` when A complete | `true` | P0 |
| **DG-017** | Check if task is blocked | `isReady(B)` when A pending | `false` | P0 |
| **DG-018** | Get all ready tasks | Complex DAG, some complete | List of executable tasks | P1 |
| **DG-019** | Mark task complete | `markComplete(A)` | A status = COMPLETE | P0 |
| **DG-020** | Mark task failed | `markFailed(A)` | A status = FAILED | P0 |
| **DG-021** | Get critical path | Complex DAG | Longest dependency chain | P2 |
| **DG-022** | Serialize graph to JSON | Populated graph | Valid JSON representation | P1 |
| **DG-023** | Deserialize graph from JSON | Valid JSON | Reconstructed graph | P1 |
| **DG-024** | Handle duplicate task addition | `addTask(A)` twice | Throws `DuplicateTaskError` | P1 |
| **DG-025** | Handle non-existent dependency | `addTask(B, [NonExistent])` | Throws `DependencyNotFoundError` | P0 |
| **DG-026** | Max depth limit enforcement | Chain longer than MAX_DEPTH | Throws `MaxDepthExceededError` | P1 |
| **DG-027** | Max width limit enforcement | Fan-out wider than MAX_WIDTH | Throws `MaxWidthExceededError` | P1 |
| **DG-028** | Graph copy/clone | `clone()` | Independent copy | P2 |
| **DG-029** | Subgraph extraction | `getSubgraph(nodeIds)` | Connected subgraph | P2 |
| **DG-030** | Empty graph operations | Sort/traverse empty graph | Empty results, no errors | P1 |

### 3.2 ProofDeferralManager Component

| Test ID | Description | Input | Expected Output | Priority |
|---------|-------------|-------|-----------------|----------|
| **PDM-001** | Create deferred claim | `defer(taskId, commitment, stake)` | Claim created with PENDING status | P0 |
| **PDM-002** | Deferred claim with valid stake | Stake ≥ MIN_STAKE | Claim accepted | P0 |
| **PDM-003** | Deferred claim with insufficient stake | Stake < MIN_STAKE | Throws `InsufficientStakeError` | P0 |
| **PDM-004** | Submit proof for deferred claim | `submitProof(claimId, proof)` | Claim status → PROOF_SUBMITTED | P0 |
| **PDM-005** | Verify valid proof | Valid ZK proof | Claim status → VERIFIED | P0 |
| **PDM-006** | Reject invalid proof | Invalid ZK proof | Claim status → REJECTED, stake slashed | P0 |
| **PDM-007** | Claim expiry - no proof submitted | Time > CLAIM_TTL | Claim status → EXPIRED | P0 |
| **PDM-008** | Claim expiry - proof pending verification | Time > VERIFICATION_TTL | Claim status → TIMED_OUT | P1 |
| **PDM-009** | Get claim status | `getStatus(claimId)` | Current claim state | P0 |
| **PDM-010** | Get all pending claims | `getPendingClaims()` | List of PENDING claims | P1 |
| **PDM-011** | Get claims by agent | `getClaimsByAgent(agentPda)` | Agent's claims | P1 |
| **PDM-012** | Get claims by task | `getClaimsByTask(taskId)` | Task's claims | P1 |
| **PDM-013** | Cancel deferred claim (agent-initiated) | `cancel(claimId)` before proof | Claim cancelled, stake returned | P1 |
| **PDM-014** | Cannot cancel after proof submission | `cancel(claimId)` after proof | Throws `ClaimLockedError` | P1 |
| **PDM-015** | Stake calculation - linear chain | 3-task chain | Cumulative stake requirement | P0 |
| **PDM-016** | Stake calculation - diamond | Diamond pattern | Max parallel path stake | P1 |
| **PDM-017** | Stake return on successful verification | Proof verified | Full stake returned | P0 |
| **PDM-018** | Partial stake slash on rejection | Invalid proof | Slashing % applied | P0 |
| **PDM-019** | Grace period extension | `extendGracePeriod(claimId)` | TTL extended, fee charged | P2 |
| **PDM-020** | Duplicate claim prevention | Same task+agent | Throws `DuplicateClaimError` | P0 |
| **PDM-021** | Concurrent claims - different agents | Two agents, same task | Both allowed | P1 |
| **PDM-022** | Claim priority ordering | Multiple claims | FIFO or stake-weighted | P2 |
| **PDM-023** | Batch proof submission | Multiple proofs at once | All processed atomically | P1 |
| **PDM-024** | Claim metadata storage | Custom metadata field | Preserved through lifecycle | P2 |
| **PDM-025** | Rate limiting - claims per agent | Exceed MAX_CLAIMS_PER_AGENT | Throws `RateLimitError` | P1 |
| **PDM-026** | Event emission on state change | Any state transition | Correct event emitted | P0 |
| **PDM-027** | Idempotent proof resubmission | Submit same proof twice | Second submission ignored | P1 |
| **PDM-028** | Commitment hash validation | Mismatched commitment | Throws `CommitmentMismatchError` | P0 |
| **PDM-029** | Claim dependency resolution | Claim depends on another | Resolves only if dependency verified | P0 |
| **PDM-030** | Emergency pause functionality | System paused | All new claims rejected | P1 |

### 3.3 CommitmentLedger Component

| Test ID | Description | Input | Expected Output | Priority |
|---------|-------------|-------|-----------------|----------|
| **CL-001** | Record new commitment | `record(taskId, commitment, agent)` | Commitment stored on-chain | P0 |
| **CL-002** | Commitment uniqueness | Duplicate commitment hash | Throws `DuplicateCommitmentError` | P0 |
| **CL-003** | Retrieve commitment by ID | `get(commitmentId)` | Commitment data | P0 |
| **CL-004** | Retrieve commitments by task | `getByTask(taskId)` | All task commitments | P1 |
| **CL-005** | Commitment validation - hash check | `validate(commitment, proof)` | True if proof matches commitment | P0 |
| **CL-006** | Commitment validation - signature | `validateSignature(commitment)` | True if agent signature valid | P0 |
| **CL-007** | Mark commitment fulfilled | `fulfill(commitmentId)` | Status → FULFILLED | P0 |
| **CL-008** | Mark commitment violated | `violate(commitmentId, reason)` | Status → VIOLATED | P0 |
| **CL-009** | Commitment expiry | Unfulfilled past TTL | Status → EXPIRED | P0 |
| **CL-010** | Get commitment chain | Task chain commits | Ordered commitment list | P1 |
| **CL-011** | Validate commitment chain integrity | `validateChain(commits)` | Chain hash verification | P0 |
| **CL-012** | Commitment merkle proof generation | `getMerkleProof(commitmentId)` | Valid merkle path | P1 |
| **CL-013** | Commitment merkle proof verification | `verifyMerkleProof(proof)` | True if proof valid | P1 |
| **CL-014** | Batch commitment recording | Multiple commitments | All recorded atomically | P1 |
| **CL-015** | Commitment revocation | `revoke(commitmentId)` before fulfillment | Status → REVOKED | P2 |
| **CL-016** | Cannot revoke fulfilled commitment | `revoke()` after fulfill | Throws `ImmutableCommitmentError` | P1 |
| **CL-017** | Commitment timestamp accuracy | Record with server time | Timestamp within tolerance | P1 |
| **CL-018** | Commitment ordering guarantees | Rapid sequential commits | Correct sequence numbers | P1 |
| **CL-019** | Query commitments by status | `getByStatus(PENDING)` | Filtered list | P1 |
| **CL-020** | Query commitments by time range | `getByTimeRange(start, end)` | Filtered list | P2 |
| **CL-021** | Commitment size limits | Commitment > MAX_SIZE | Throws `CommitmentTooLargeError` | P1 |
| **CL-022** | Ledger compaction | Old fulfilled commitments | Archived successfully | P2 |
| **CL-023** | Commitment audit trail | Full lifecycle | All state changes logged | P1 |
| **CL-024** | Cross-reference validation | Commitment references other | Reference integrity check | P1 |
| **CL-025** | Commitment nonce validation | Replay with same nonce | Throws `NonceReusedError` | P0 |

### 3.4 RollbackController Component

| Test ID | Description | Input | Expected Output | Priority |
|---------|-------------|-------|-----------------|----------|
| **RC-001** | Initiate rollback - single task | `rollback(taskId)` | Task state reverted | P0 |
| **RC-002** | Cascade rollback - linear chain | Fail task A in A→B→C | B and C also rolled back | P0 |
| **RC-003** | Cascade rollback - diamond | Fail A in A→(B,C)→D | B, C, D all rolled back | P0 |
| **RC-004** | Cascade rollback - partial diamond | Fail B in A→(B,C)→D | Only D rolled back (if depends on B) | P0 |
| **RC-005** | Cascade rollback - complex DAG | 10-node graph | All dependents rolled back | P0 |
| **RC-006** | Rollback depth limit | Chain > MAX_ROLLBACK_DEPTH | Limited cascade + alert | P1 |
| **RC-007** | Concurrent rollback prevention | Two rollbacks same task | One succeeds, one fails | P0 |
| **RC-008** | Rollback state preservation | Pre-rollback state | Snapshot stored | P1 |
| **RC-009** | Stake redistribution on rollback | Tasks with stakes | Stakes returned/slashed appropriately | P0 |
| **RC-010** | Rollback notification | Rollback triggered | All affected agents notified | P1 |
| **RC-011** | Rollback reason tracking | `rollback(taskId, reason)` | Reason stored and queryable | P1 |
| **RC-012** | Partial rollback (revert to checkpoint) | `rollbackTo(checkpoint)` | Reverts to specific state | P2 |
| **RC-013** | Rollback idempotency | Double rollback same task | Second is no-op | P0 |
| **RC-014** | Cannot rollback completed task | Task already finalized | Throws `ImmutableTaskError` | P0 |
| **RC-015** | Rollback metrics collection | Any rollback | Metrics recorded | P1 |
| **RC-016** | Get rollback history | `getHistory(taskId)` | List of past rollbacks | P2 |
| **RC-017** | Rollback approval workflow | Requires multi-sig | Waits for approvals | P2 |
| **RC-018** | Emergency rollback bypass | Admin override | Immediate rollback | P1 |
| **RC-019** | Rollback compensation calculation | Complex stake setup | Correct compensation amounts | P0 |
| **RC-020** | Atomic rollback guarantee | Multi-task rollback | All or nothing | P0 |
| **RC-021** | Rollback timeout handling | Rollback takes too long | Timeout with cleanup | P1 |
| **RC-022** | Cross-agent rollback coordination | Multi-agent task chain | All agents coordinated | P1 |
| **RC-023** | Rollback event ordering | Multiple events | Correct causal order | P1 |
| **RC-024** | Dry-run rollback | `dryRun=true` | Preview without execution | P2 |
| **RC-025** | Rollback undo (re-speculate) | `undo(rollbackId)` | Speculation restored | P2 |

### 3.5 SpeculativeTaskScheduler Component

| Test ID | Description | Input | Expected Output | Priority |
|---------|-------------|-------|-----------------|----------|
| **STS-001** | Schedule single task | `schedule(taskId)` | Task queued | P0 |
| **STS-002** | Schedule task with ready dependencies | A complete, schedule B | B executes immediately | P0 |
| **STS-003** | Schedule task with pending dependencies | A pending, schedule B | B waits for A | P0 |
| **STS-004** | Speculative scheduling enabled | Speculation=true | B starts with commitment | P0 |
| **STS-005** | Speculative scheduling disabled | Speculation=false | B waits for A proof | P0 |
| **STS-006** | Priority queue ordering | Mixed priority tasks | High priority first | P1 |
| **STS-007** | Deadline-based scheduling | Tasks with deadlines | Urgent tasks prioritized | P1 |
| **STS-008** | Resource-aware scheduling | Limited compute slots | Respects capacity | P1 |
| **STS-009** | Agent affinity scheduling | Task prefers agent X | Assigned to X if available | P2 |
| **STS-010** | Load balancing | Multiple agents | Even distribution | P1 |
| **STS-011** | Schedule batch of tasks | Multiple tasks at once | Optimal ordering | P1 |
| **STS-012** | Cancel scheduled task | `cancel(taskId)` | Removed from queue | P1 |
| **STS-013** | Pause scheduler | `pause()` | No new executions | P1 |
| **STS-014** | Resume scheduler | `resume()` | Executions continue | P1 |
| **STS-015** | Get scheduler state | `getState()` | Current queue and status | P1 |
| **STS-016** | Handle task failure | Task throws error | Marked failed, dependents notified | P0 |
| **STS-017** | Retry failed task | Retry policy configured | Automatic retry with backoff | P1 |
| **STS-018** | Max retries exceeded | Retries exhausted | Permanent failure | P1 |
| **STS-019** | Speculative chain limit | > MAX_SPEC_CHAIN | Blocks until proofs arrive | P0 |
| **STS-020** | Stake availability check | Insufficient stake | Task waits or fails | P0 |
| **STS-021** | Schedule visualization | Complex DAG | Execution timeline | P2 |
| **STS-022** | Scheduler metrics | Various operations | Latency, throughput stats | P1 |
| **STS-023** | Task timeout handling | Task exceeds timeout | Cancelled and reported | P1 |
| **STS-024** | Graceful shutdown | `shutdown()` | Completes in-flight, drains queue | P1 |
| **STS-025** | Schedule persistence | Scheduler restart | Queue restored | P2 |
| **STS-026** | Concurrent schedule requests | High parallelism | Thread-safe operation | P0 |
| **STS-027** | Dynamic priority adjustment | `updatePriority(taskId)` | Queue reordered | P2 |
| **STS-028** | Dependency resolution caching | Repeated lookups | Cache hit optimization | P2 |
| **STS-029** | Circular wait detection | Potential deadlock | Throws `DeadlockError` | P1 |
| **STS-030** | Schedule optimization hints | `optimize(strategy)` | Improved ordering | P2 |

---

## 4. Integration Test Scenarios

### 4.1 Happy Path Scenarios

#### 4.1.1 Linear Chain Execution

```
Scenario: INTG-HP-001 - Linear Chain Speculative Execution
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topology: A → B → C (3-task linear chain)

GIVEN:
  - Agent has sufficient stake (3 * MIN_STAKE)
  - Speculative execution is enabled
  - All tasks have valid ZK circuits

WHEN:
  1. Task A is submitted and starts execution
  2. Agent commits to A's output (no proof yet)
  3. Task B starts speculatively using A's commitment
  4. Agent commits to B's output
  5. Task C starts speculatively using B's commitment
  6. A's proof is generated and verified
  7. B's proof is generated and verified
  8. C's proof is generated and verified

THEN:
  ✓ All tasks complete successfully
  ✓ Total latency < sequential execution
  ✓ All stakes are returned
  ✓ Commitments are marked fulfilled
  ✓ Events emitted: TaskStarted(A,B,C), CommitmentRecorded(3x), 
    ProofVerified(A,B,C), TaskCompleted(A,B,C)

METRICS:
  - Expected latency: ~1.3x single task (vs 3x sequential)
  - Stake locked duration: Proof generation time
```

#### 4.1.2 Diamond Pattern Execution

```
Scenario: INTG-HP-002 - Diamond Pattern Speculative Execution
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topology:     A
             / \
            B   C
             \ /
              D

GIVEN:
  - Two agents (Agent1: B, Agent2: C)
  - Sufficient combined stake
  - Task D requires both B and C outputs

WHEN:
  1. Task A completes normally (or speculatively)
  2. Tasks B and C start in parallel speculatively
  3. B commits, C commits
  4. Task D starts when both B and C have commitments
  5. All proofs verified in order: A, B, C, D

THEN:
  ✓ Parallel execution of B and C achieved
  ✓ D correctly waits for both commitments
  ✓ Total latency = max(A, max(B,C), D) not sum
  ✓ Cross-agent coordination successful
```

#### 4.1.3 Complex DAG Execution

```
Scenario: INTG-HP-003 - Complex DAG Speculative Execution
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topology:
        A
       /|\
      B C D
      |X|/
      E F
       \|
        G

GIVEN:
  - 7-task DAG with multiple paths
  - E depends on B and C
  - F depends on C and D
  - G depends on E and F

WHEN:
  - All tasks execute speculatively as dependencies allow
  - Proofs verified asynchronously

THEN:
  ✓ Maximum parallelism achieved
  ✓ Critical path determines total latency
  ✓ All dependency constraints respected
  ✓ No task starts before all dependencies have commitments
```

### 4.2 Failure Scenarios

#### 4.2.1 Proof Generation Failure

```
Scenario: INTG-FAIL-001 - Proof Generation Fails Mid-Chain
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topology: A → B → C → D

GIVEN:
  - Chain executing speculatively
  - All tasks have committed
  - B's proof generation fails

WHEN:
  - B's proof submission times out or returns error

THEN:
  ✓ B marked as FAILED
  ✓ Rollback triggered for C and D
  ✓ B's stake slashed (PROOF_FAILURE_SLASH_RATE)
  ✓ A remains completed (proof was valid)
  ✓ C and D agents receive compensation from B's slashed stake
  ✓ Events: ProofFailed(B), RollbackInitiated(C), RollbackInitiated(D)
```

#### 4.2.2 Proof Verification Failure

```
Scenario: INTG-FAIL-002 - Invalid Proof Submitted
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topology: A → B → C

GIVEN:
  - A and B executing speculatively
  - A submits invalid proof (tampered or wrong circuit)

WHEN:
  - Verifier rejects A's proof

THEN:
  ✓ A marked as PROOF_REJECTED
  ✓ Cascade rollback: B and C
  ✓ A's entire stake slashed (FRAUD_SLASH_RATE = 100%)
  ✓ Slashed funds distributed to: protocol treasury, affected agents
  ✓ Agent reputation impacted
  ✓ Events: ProofRejected(A), StakeSlashed(A), RollbackCascade([B,C])
```

#### 4.2.3 Claim Timeout

```
Scenario: INTG-FAIL-003 - Commitment Expires Without Proof
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topology: A → B

GIVEN:
  - A committed and B started speculatively
  - CLAIM_TTL = 30 minutes

WHEN:
  - 30 minutes pass without A's proof submission

THEN:
  ✓ A's claim expires
  ✓ B rolled back
  ✓ A's stake partially slashed (TIMEOUT_SLASH_RATE)
  ✓ Remaining stake returned to A
  ✓ B can be re-scheduled with new commitment
```

### 4.3 Edge Cases

#### 4.3.1 Claim Expiry Race Condition

```
Scenario: INTG-EDGE-001 - Proof Arrives Just After Expiry
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GIVEN:
  - Claim about to expire (TTL - 1 second)
  - Proof in transit

WHEN:
  - Proof arrives 1 second after expiry timestamp
  - Network latency caused the delay

THEN:
  ✓ Grace period of EXPIRY_GRACE_PERIOD applies
  ✓ If within grace: proof accepted, claim valid
  ✓ If outside grace: proof rejected, claim expired
  ✓ Deterministic behavior regardless of validator
```

#### 4.3.2 Concurrent Rollback Requests

```
Scenario: INTG-EDGE-002 - Multiple Failures Trigger Simultaneous Rollbacks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topology:
    A   B
     \ /
      C
     / \
    D   E

GIVEN:
  - A and B both have speculative commitments
  - C, D, E executing speculatively

WHEN:
  - A and B both fail proof verification simultaneously

THEN:
  ✓ Rollback controller handles both atomically
  ✓ C rolled back once (not twice)
  ✓ D and E rolled back once each
  ✓ Stake slashing calculated correctly (combined)
  ✓ No deadlock or race condition
```

#### 4.3.3 Stake Limit Boundary

```
Scenario: INTG-EDGE-003 - Agent at Stake Limit
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GIVEN:
  - Agent has MAX_CONCURRENT_STAKES active
  - Agent wants to start new speculative task

WHEN:
  - New task scheduled requiring stake

THEN:
  ✓ Task queued until stake becomes available
  ✓ OR task executed non-speculatively
  ✓ Agent notified of stake constraint
  ✓ No over-commitment possible
```

### 4.4 Cross-Agent Scenarios

#### 4.4.1 Multi-Agent Linear Chain

```
Scenario: INTG-CROSS-001 - Different Agent Per Task
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topology: A(Agent1) → B(Agent2) → C(Agent3)

GIVEN:
  - Three different agents
  - Each agent stakes for their task

WHEN:
  - Speculative chain executes across agents

THEN:
  ✓ Commitment handoff between agents works
  ✓ Agent2 can verify Agent1's commitment
  ✓ Stake isolation maintained per agent
  ✓ Rollback affects correct agents only
```

#### 4.4.2 Agent Failure Mid-Chain

```
Scenario: INTG-CROSS-002 - Agent Goes Offline
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topology: A(Agent1) → B(Agent2) → C(Agent1)

GIVEN:
  - Agent1 handles A and C
  - Agent2 handles B

WHEN:
  - Agent2 goes offline after committing to B
  - B's proof never submitted

THEN:
  ✓ B times out
  ✓ C cannot complete (depends on B)
  ✓ Agent2's stake slashed
  ✓ Agent1 compensated for wasted work on C
  ✓ Task chain can be retried with different Agent2
```

---

## 5. Chaos Test Scenarios

### 5.1 Random Proof Failures

```
Scenario: CHAOS-001 - Random Proof Failure Injection
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Configuration:
  - 100 concurrent task chains
  - Chain length: 3-7 tasks
  - Failure rate: 5% per proof

CHAOS INJECTION:
  - Randomly fail proof generation
  - Randomly corrupt proofs
  - Randomly delay proof submission beyond TTL

SUCCESS CRITERIA:
  ✓ No orphaned tasks (all complete or rolled back)
  ✓ No stake leakage (all stakes accounted for)
  ✓ No commitment ledger corruption
  ✓ System recovers within 5 minutes
  ✓ No deadlocks detected
```

### 5.2 Network Partitions

```
Scenario: CHAOS-002 - Network Partition Simulation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Configuration:
  - 5 agents across 3 network zones
  - 20 active speculative chains

CHAOS INJECTION:
  - Partition zone A from zones B+C
  - Duration: 30 seconds
  - Restore connectivity
  - Repeat 3 times

SUCCESS CRITERIA:
  ✓ Tasks in partition timeout gracefully
  ✓ No split-brain state inconsistency
  ✓ Post-partition reconciliation successful
  ✓ No duplicate executions
  ✓ Commitment ledger consistent across zones
```

### 5.3 Memory Pressure

```
Scenario: CHAOS-003 - Memory Exhaustion
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Configuration:
  - Large dependency graph (1000 nodes)
  - Memory limit: 512MB per component

CHAOS INJECTION:
  - Gradually increase concurrent chains
  - Fill commitment ledger with entries
  - Trigger GC storms

SUCCESS CRITERIA:
  ✓ Graceful degradation (queuing, not crashing)
  ✓ No memory leaks over 1 hour
  ✓ Critical operations prioritized
  ✓ OOM killer not invoked
  ✓ Recovery after memory freed
```

### 5.4 Concurrent Speculation Bursts

```
Scenario: CHAOS-004 - Speculation Burst
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Configuration:
  - 50 agents
  - Normal load: 10 spec chains/second

CHAOS INJECTION:
  - Spike to 500 spec chains/second for 60 seconds
  - All agents attempt max speculation depth
  - Proofs arrive randomly over next 5 minutes

SUCCESS CRITERIA:
  ✓ Rate limiting engages correctly
  ✓ No request drops (queued or rejected gracefully)
  ✓ Stake limits enforced globally
  ✓ System returns to normal within 10 minutes
  ✓ All eventual consistency guarantees met
```

### 5.5 Byzantine Agent Behavior

```
Scenario: CHAOS-005 - Malicious Agent Simulation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Configuration:
  - 10 honest agents, 2 byzantine agents
  - Byzantine agents: random bad behavior

CHAOS INJECTION:
  - Submit invalid commitments
  - Submit mismatched proofs
  - Attempt double-spending stake
  - Attempt commitment replay

SUCCESS CRITERIA:
  ✓ All byzantine behavior detected
  ✓ Byzantine agents slashed correctly
  ✓ Honest agents unaffected
  ✓ No protocol invariant violations
  ✓ Audit trail captures all violations
```

---

## 6. Performance Test Cases

### 6.1 Latency Benchmarks

#### 6.1.1 Sequential vs Speculative Comparison

| Test ID | Scenario | Sequential Baseline | Speculative Target | Improvement |
|---------|----------|--------------------|--------------------|-------------|
| **PERF-LAT-001** | 2-task chain | 2000ms | < 1200ms | > 40% |
| **PERF-LAT-002** | 3-task chain | 3000ms | < 1500ms | > 50% |
| **PERF-LAT-003** | 5-task chain | 5000ms | < 2000ms | > 60% |
| **PERF-LAT-004** | 10-task chain | 10000ms | < 3500ms | > 65% |
| **PERF-LAT-005** | Diamond (4 tasks) | 3000ms | < 1800ms | > 40% |
| **PERF-LAT-006** | Complex DAG (10 tasks) | 6000ms | < 2500ms | > 58% |

```
Benchmark Configuration:
  - Proof generation time: ~800ms per task (simulated)
  - Network latency: 50ms
  - Commitment overhead: 100ms
  - Verification time: 200ms
  
Measurement:
  - Start: First task submitted
  - End: Last task proof verified
  - Runs: 100 iterations per scenario
  - Report: p50, p95, p99, max
```

#### 6.1.2 Commitment Overhead

| Test ID | Operation | Target Latency | Measurement |
|---------|-----------|----------------|-------------|
| **PERF-LAT-010** | Record commitment | < 50ms | p99 |
| **PERF-LAT-011** | Validate commitment | < 20ms | p99 |
| **PERF-LAT-012** | Merkle proof generation | < 100ms | p99 |
| **PERF-LAT-013** | Rollback single task | < 200ms | p99 |
| **PERF-LAT-014** | Rollback 10-task cascade | < 1000ms | p99 |

### 6.2 Throughput Tests

| Test ID | Scenario | Target TPS | Sustained Duration |
|---------|----------|------------|-------------------|
| **PERF-TPS-001** | New speculative claims | 100/s | 10 minutes |
| **PERF-TPS-002** | Proof submissions | 50/s | 10 minutes |
| **PERF-TPS-003** | Commitment recordings | 200/s | 10 minutes |
| **PERF-TPS-004** | Concurrent chain starts | 20/s | 10 minutes |
| **PERF-TPS-005** | Mixed workload | 150/s combined | 30 minutes |

```
Throughput Test Configuration:
  - Gradual ramp-up: 10% → 100% over 2 minutes
  - Sustain at peak for specified duration
  - Monitor: CPU, memory, network, disk I/O
  - Alert if: error rate > 0.1%, latency p99 > 2x target
```

### 6.3 Scalability Tests

#### 6.3.1 Graph Size Scaling

| Test ID | Graph Size | Max Depth | Max Width | Target Performance |
|---------|------------|-----------|-----------|-------------------|
| **PERF-SCALE-001** | 10 tasks | 5 | 3 | < 100ms graph ops |
| **PERF-SCALE-002** | 100 tasks | 10 | 10 | < 500ms graph ops |
| **PERF-SCALE-003** | 1000 tasks | 20 | 50 | < 2s graph ops |
| **PERF-SCALE-004** | 10000 tasks | 50 | 100 | < 10s graph ops |

#### 6.3.2 Concurrent Chain Scaling

| Test ID | Concurrent Chains | Agents | Target |
|---------|-------------------|--------|--------|
| **PERF-SCALE-010** | 10 | 5 | 100% success |
| **PERF-SCALE-011** | 50 | 20 | 99.9% success |
| **PERF-SCALE-012** | 100 | 50 | 99% success |
| **PERF-SCALE-013** | 500 | 100 | 95% success |

#### 6.3.3 Ledger Growth

| Test ID | Scenario | Duration | Target |
|---------|----------|----------|--------|
| **PERF-SCALE-020** | Commitment accumulation | 24 hours | < 10GB growth |
| **PERF-SCALE-021** | Query performance degradation | After 1M commits | < 2x baseline |
| **PERF-SCALE-022** | Compaction efficiency | After 1M commits | 70% size reduction |

### 6.4 Resource Utilization Limits

| Resource | Soft Limit | Hard Limit | Action at Limit |
|----------|------------|------------|-----------------|
| CPU | 70% | 90% | Rate limit new chains |
| Memory | 80% | 95% | Evict cold cache |
| Disk I/O | 80% | 95% | Queue writes |
| Network | 70% | 90% | Backpressure |
| Open connections | 1000 | 5000 | Reject new |

---

## 7. Security Test Cases

### 7.1 Stake Manipulation Attempts

| Test ID | Attack Vector | Mitigation | Expected Result |
|---------|---------------|------------|-----------------|
| **SEC-STAKE-001** | Double-stake same SOL | On-chain atomic lock | Transaction rejected |
| **SEC-STAKE-002** | Stake withdrawal during speculation | Timelock on withdrawal | Withdrawal blocked |
| **SEC-STAKE-003** | Stake amount underflow | u64 bounds checking | Transaction rejected |
| **SEC-STAKE-004** | Fake stake account injection | PDA verification | Invalid account rejected |
| **SEC-STAKE-005** | Stake transfer to accomplice | Transfer restrictions | Transfer blocked |
| **SEC-STAKE-006** | Flash loan stake attack | Minimum stake duration | Insufficient stake time |
| **SEC-STAKE-007** | Partial stake unlock race | Atomic stake operations | Race condition prevented |

### 7.2 Replay Attacks

| Test ID | Attack Vector | Mitigation | Expected Result |
|---------|---------------|------------|-----------------|
| **SEC-REPLAY-001** | Replay commitment from past | Nonce + timestamp validation | Commitment rejected |
| **SEC-REPLAY-002** | Replay proof for different task | Task ID in proof public inputs | Proof rejected |
| **SEC-REPLAY-003** | Replay successful chain | Chain ID uniqueness | Chain ID collision detected |
| **SEC-REPLAY-004** | Cross-chain commitment replay | Chain-specific commitment format | Format mismatch detected |
| **SEC-REPLAY-005** | Replay after rollback | Rollback nonce increment | Stale commitment detected |

### 7.3 Griefing Scenarios

| Test ID | Attack Description | Mitigation | Expected Outcome |
|---------|-------------------|------------|------------------|
| **SEC-GRIEF-001** | Commit then abandon (stake DoS) | Stake slashing + timeout | Attacker loses stake |
| **SEC-GRIEF-002** | Spam invalid commitments | Commitment fee + rate limit | Attack becomes expensive |
| **SEC-GRIEF-003** | Intentional late proof (cascade rollback) | Graduated slashing | Attacker heavily penalized |
| **SEC-GRIEF-004** | Block other agents' commitments | Priority queue + fair scheduling | Blocking prevented |
| **SEC-GRIEF-005** | Trigger excessive rollbacks | Rollback cost to initiator | Rollback spam prevented |
| **SEC-GRIEF-006** | Resource exhaustion via large graphs | Graph size limits | Graph rejected |
| **SEC-GRIEF-007** | Commitment storage spam | Max commitments per agent | Rate limited |

### 7.4 Cryptographic Security

| Test ID | Test Description | Expected Result |
|---------|------------------|-----------------|
| **SEC-CRYPTO-001** | Commitment hash collision resistance | No collisions in 10M samples |
| **SEC-CRYPTO-002** | Proof forgery attempt | All forged proofs rejected |
| **SEC-CRYPTO-003** | Commitment binding property | Cannot change committed value |
| **SEC-CRYPTO-004** | Commitment hiding property | Cannot derive value from commitment |
| **SEC-CRYPTO-005** | Merkle proof tampering | Tampered proofs rejected |
| **SEC-CRYPTO-006** | Signature malleability | Malleable signatures rejected |

### 7.5 Access Control

| Test ID | Test Description | Expected Result |
|---------|------------------|-----------------|
| **SEC-ACCESS-001** | Non-owner commitment revocation | Revocation rejected |
| **SEC-ACCESS-002** | Non-admin parameter change | Change rejected |
| **SEC-ACCESS-003** | Cross-agent claim cancellation | Cancellation rejected |
| **SEC-ACCESS-004** | Unauthorized rollback trigger | Rollback rejected |
| **SEC-ACCESS-005** | PDA derivation bypass attempt | Invalid PDA rejected |

---

## 8. Acceptance Criteria Matrix

### 8.1 Feature vs Test Coverage

| Feature | Unit | Integration | E2E | Chaos | Perf | Security | Status |
|---------|------|-------------|-----|-------|------|----------|--------|
| **Dependency Graph** |  |  |  |  |  |  |  |
| - Graph creation | ✅ DG-001:003 | ✅ INTG-HP-001 | ✅ | - | ✅ | - | 🟡 |
| - Cycle detection | ✅ DG-005:006 | ✅ INTG-EDGE-002 | ✅ | - | - | - | 🟡 |
| - Topological sort | ✅ DG-007:009 | ✅ INTG-HP-003 | ✅ | - | ✅ PERF-SCALE | - | 🟡 |
| - Task state tracking | ✅ DG-019:020 | ✅ | ✅ | ✅ CHAOS-001 | - | - | 🟡 |
| **Proof Deferral** |  |  |  |  |  |  |  |
| - Claim lifecycle | ✅ PDM-001:010 | ✅ INTG-HP-001:003 | ✅ | ✅ CHAOS-001 | ✅ | ✅ SEC-STAKE | 🟡 |
| - Stake management | ✅ PDM-002:003, 015:018 | ✅ INTG-EDGE-003 | ✅ | ✅ CHAOS-004 | - | ✅ SEC-STAKE | 🟡 |
| - Proof verification | ✅ PDM-005:006 | ✅ INTG-FAIL-002 | ✅ | ✅ CHAOS-001 | ✅ | ✅ SEC-CRYPTO | 🟡 |
| - Expiry handling | ✅ PDM-007:008 | ✅ INTG-FAIL-003 | ✅ | ✅ CHAOS-002 | - | - | 🟡 |
| **Commitment Ledger** |  |  |  |  |  |  |  |
| - Recording | ✅ CL-001:004 | ✅ INTG-HP-001 | ✅ | ✅ CHAOS-003 | ✅ PERF-TPS-003 | ✅ SEC-REPLAY | 🟡 |
| - Validation | ✅ CL-005:006 | ✅ INTG-HP-002 | ✅ | ✅ CHAOS-005 | ✅ | ✅ SEC-CRYPTO | 🟡 |
| - Merkle proofs | ✅ CL-012:013 | ✅ | ✅ | - | ✅ | ✅ SEC-CRYPTO-005 | 🟡 |
| - Chain integrity | ✅ CL-010:011 | ✅ INTG-HP-003 | ✅ | ✅ CHAOS-002 | - | ✅ | 🟡 |
| **Rollback Controller** |  |  |  |  |  |  |  |
| - Single rollback | ✅ RC-001 | ✅ INTG-FAIL-001 | ✅ | ✅ | ✅ PERF-LAT-013 | ✅ SEC-ACCESS-004 | 🟡 |
| - Cascade rollback | ✅ RC-002:005 | ✅ INTG-FAIL-001:002 | ✅ | ✅ CHAOS-001 | ✅ PERF-LAT-014 | ✅ | 🟡 |
| - Stake redistribution | ✅ RC-009, 019 | ✅ INTG-FAIL-002 | ✅ | ✅ | - | ✅ SEC-STAKE | 🟡 |
| - Concurrent handling | ✅ RC-007 | ✅ INTG-EDGE-002 | ✅ | ✅ CHAOS-004 | - | - | 🟡 |
| **Speculative Scheduler** |  |  |  |  |  |  |  |
| - Basic scheduling | ✅ STS-001:005 | ✅ INTG-HP-001 | ✅ | - | ✅ | - | 🟡 |
| - Priority handling | ✅ STS-006:007 | ✅ | ✅ | ✅ CHAOS-004 | ✅ | ✅ SEC-GRIEF-004 | 🟡 |
| - Failure handling | ✅ STS-016:018 | ✅ INTG-FAIL-001:003 | ✅ | ✅ CHAOS-001 | - | - | 🟡 |
| - Chain limits | ✅ STS-019:020 | ✅ INTG-EDGE-003 | ✅ | ✅ CHAOS-004 | ✅ | ✅ SEC-GRIEF | 🟡 |

**Legend:**
- 🟢 Implemented and passing
- 🟡 Designed, not yet implemented  
- 🔴 Not started
- ✅ Covered by test(s)
- - Not applicable

### 8.2 Release Criteria

#### Alpha Release

- [ ] All P0 unit tests passing
- [ ] Basic integration tests (HP-001, HP-002)
- [ ] Manual security review complete
- [ ] Performance baseline established

#### Beta Release

- [ ] All P0 + P1 unit tests passing
- [ ] All happy path integration tests passing
- [ ] Failure scenario tests passing
- [ ] Initial chaos testing complete
- [ ] Security tests for stake manipulation passing
- [ ] 80% code coverage achieved

#### GA Release

- [ ] All unit tests passing (P0/P1/P2)
- [ ] All integration tests passing
- [ ] All chaos tests passing
- [ ] All performance targets met
- [ ] All security tests passing
- [ ] External security audit complete
- [ ] 85% code coverage achieved
- [ ] Documentation complete

---

## 9. Test Execution Schedule

### 9.1 Daily Execution

| Time | Test Suite | Duration | Trigger |
|------|------------|----------|---------|
| On commit | Unit tests | 2 min | Automatic |
| On PR | Unit + Integration | 15 min | Automatic |
| 02:00 UTC | Full integration | 30 min | Scheduled |
| 04:00 UTC | Performance baseline | 1 hr | Scheduled |

### 9.2 Weekly Execution

| Day | Test Suite | Duration | Owner |
|-----|------------|----------|-------|
| Monday | Chaos tests (basic) | 2 hr | DevOps |
| Wednesday | Security scan | 1 hr | Security |
| Friday | Full performance suite | 4 hr | QA |
| Saturday | Extended chaos | 8 hr | Automated |

### 9.3 Pre-Release Execution

| Milestone | Required Tests | Sign-off |
|-----------|----------------|----------|
| Feature freeze | All unit + integration | Tech Lead |
| RC1 | + Chaos + Performance | QA Lead |
| RC2 | + Security audit | Security Lead |
| GA | Full regression | Release Manager |

---

## 10. Appendix

### 10.1 Test Environment Setup

```bash
# Local environment setup
git clone https://github.com/tetsuo-ai/AgenC.git
cd AgenC

# Install dependencies
npm install
cd programs/agenc-coordination && cargo build
cd ../..

# Start local validator with speculation features
solana-test-validator \
  --bpf-program EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ target/deploy/agenc_coordination.so \
  --reset

# Run speculation tests
npm run test:speculation
anchor test tests/speculation/
```

### 10.2 Test Data Generation

```typescript
// Generate test task chain
import { generateTaskChain } from '@agenc/test-utils';

const chain = generateTaskChain({
  length: 5,
  topology: 'linear', // or 'diamond', 'dag'
  proofDelay: 800, // ms
  failureRate: 0.0, // 0-1
});

// Generate test commitment
const commitment = generateCommitment({
  taskId: chain.tasks[0].id,
  agentPubkey: agent.publicKey,
  outputHash: randomHash(),
});
```

### 10.3 Monitoring and Alerting

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Test failure rate | > 1% | > 5% | Page on-call |
| Coverage drop | > 2% | > 5% | Block merge |
| Flaky test rate | > 3% | > 10% | Quarantine test |
| Test duration increase | > 20% | > 50% | Investigate |

### 10.4 Related Documents

- [TEST-DATA.md](./TEST-DATA.md) - Test fixtures and mock configurations
- [../api/SPECULATION-API.md](../api/SPECULATION-API.md) - API specifications
- [../operations/RUNBOOK.md](../operations/RUNBOOK.md) - Operational procedures
- [../../architecture.md](../../architecture.md) - System architecture

---

**Document Control:**
- Created: 2025-01-28
- Last Review: 2025-01-28
- Next Review: 2025-02-28
- Approvers: Tech Lead, QA Lead, Security Lead
