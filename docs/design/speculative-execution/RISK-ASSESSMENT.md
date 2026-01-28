# Failure Modes and Effects Analysis (FMEA) & Risk Assessment

> **Document:** Speculative Execution Risk Assessment  
> **Epic:** [#285](https://github.com/tetsuo-ai/AgenC/issues/285)  
> **Classification:** Enterprise Risk Management  
> **Last Updated:** 2025-01-28  
> **Status:** Active

---

## Table of Contents

1. [FMEA Table](#1-fmea-table)
2. [Risk Matrix](#2-risk-matrix)
3. [Critical Risks (Top 5)](#3-critical-risks-top-5)
4. [Security Considerations](#4-security-considerations)
5. [Correctness Proof Sketches](#5-correctness-proof-sketches)
6. [Assumptions & Dependencies](#6-assumptions--dependencies)
7. [Monitoring & Detection](#7-monitoring--detection)

---

## 1. FMEA Table

### Scoring Criteria

| Score | Severity | Probability | Detection |
|-------|----------|-------------|-----------|
| 1-2 | Negligible / Cosmetic | Extremely rare (<0.01%) | Always detected immediately |
| 3-4 | Minor / Recoverable | Rare (0.01-0.1%) | Usually detected quickly |
| 5-6 | Moderate / Degraded service | Occasional (0.1-1%) | Sometimes detected |
| 7-8 | Major / Service outage | Frequent (1-10%) | Rarely detected automatically |
| 9-10 | Critical / Data loss / Financial | Very frequent (>10%) | Undetectable until impact |

**RPN (Risk Priority Number) = Severity × Probability × Detection**

---

### 1.1 DependencyGraph Failure Modes

| ID | Component | Failure Mode | Effect | Sev | Prob | Det | RPN | Mitigation |
|----|-----------|--------------|--------|-----|------|-----|-----|------------|
| DG-001 | DependencyGraph | **Cycle introduced in DAG** | Deadlock: tasks wait forever for each other; system hangs | 9 | 3 | 4 | 108 | Cycle detection on every `addEdge()` using Tarjan's algorithm; reject cyclic insertions |
| DG-002 | DependencyGraph | **Stale dependency data** | Tasks execute against outdated state; incorrect outputs committed | 8 | 5 | 6 | 240 | Version vectors on nodes; staleness TTL with forced refresh; consistency checks before execution |
| DG-003 | DependencyGraph | **Memory leak (unbounded growth)** | OOM crash; service restart; all in-flight speculation lost | 7 | 4 | 5 | 140 | Bounded cache with LRU eviction; periodic GC of confirmed/rolled-back nodes; memory usage alerts |
| DG-004 | DependencyGraph | **Concurrent modification race** | Corrupted graph state; undefined traversal behavior | 8 | 4 | 7 | 224 | Reader-writer locks; copy-on-write for traversals; optimistic locking with retry |
| DG-005 | DependencyGraph | **Node deletion with active dependents** | Orphaned tasks with unresolvable dependencies | 7 | 3 | 4 | 84 | Reference counting; soft-delete with tombstones; orphan detection on traversal |
| DG-006 | DependencyGraph | **Topological sort failure** | Incorrect execution ordering; proof ordering violation | 9 | 2 | 3 | 54 | Fallback to verified sort implementation; cross-validation with multiple algorithms |

---

### 1.2 CommitmentLedger Failure Modes

| ID | Component | Failure Mode | Effect | Sev | Prob | Det | RPN | Mitigation |
|----|-----------|--------------|--------|-----|------|-----|-----|------------|
| CL-001 | CommitmentLedger | **Lost commitment record** | Task appears unexecuted; duplicate execution; economic loss | 9 | 3 | 6 | 162 | WAL (write-ahead log); synchronous persistence; periodic consistency audit |
| CL-002 | CommitmentLedger | **Wrong stake calculation** | Under-bonding: insufficient slashing; Over-bonding: agents locked out | 7 | 4 | 5 | 140 | Stake calculation unit tests; on-chain validation; automated reconciliation |
| CL-003 | CommitmentLedger | **Persistence failure (disk full/corruption)** | All commitments lost on restart; massive rollback required | 10 | 2 | 4 | 80 | Multi-region replication; disk space monitoring; integrity checksums |
| CL-004 | CommitmentLedger | **State transition violation** | Commitment in invalid state; proof submitted for unconfirmed task | 9 | 3 | 4 | 108 | State machine with explicit transitions; transition validation; audit logging |
| CL-005 | CommitmentLedger | **Commitment hash collision** | Two different results with same hash; integrity compromise | 10 | 1 | 8 | 80 | SHA-256 minimum; collision-resistant hashing; include task ID in hash input |
| CL-006 | CommitmentLedger | **Double commitment (same task)** | Duplicate proofs; wasted compute; potential economic exploit | 6 | 4 | 3 | 72 | Unique constraint on task_id; idempotency keys; deduplication at insertion |
| CL-007 | CommitmentLedger | **Cross-shard inconsistency** | Partial commit visible; reads return inconsistent state | 8 | 3 | 6 | 144 | Single-shard design initially; distributed transactions if sharding needed |

---

### 1.3 ProofDeferralManager Failure Modes

| ID | Component | Failure Mode | Effect | Sev | Prob | Det | RPN | Mitigation |
|----|-----------|--------------|--------|-----|------|-----|-----|------------|
| PDM-001 | ProofDeferralManager | **Proof lost in queue** | Task never finalized; permanent pending state; stake locked forever | 9 | 3 | 5 | 135 | Persistent queue with acknowledgments; retry with exponential backoff; dead letter queue |
| PDM-002 | ProofDeferralManager | **Wrong proof ordering (submitted before ancestors)** | Invalid state transition on-chain; proof rejected; cascading failures | 10 | 3 | 3 | 90 | Strict ordering invariant check before submission; dependency graph query; blocking on ancestors |
| PDM-003 | ProofDeferralManager | **Deadlock in proof pipeline** | All proof generation stops; backpressure to execution; system freeze | 8 | 4 | 5 | 160 | Deadlock detection; timeout on all locks; circuit breaker pattern |
| PDM-004 | ProofDeferralManager | **Proof generation timeout** | Claim expires before proof ready; wasted execution; potential slash | 7 | 5 | 3 | 105 | Proof generation time estimation; claim buffer validation; early termination |
| PDM-005 | ProofDeferralManager | **Invalid proof generated** | On-chain rejection; slash triggered; reputation damage | 8 | 3 | 4 | 96 | Pre-submission verification; proof validation before queue; automated testing |
| PDM-006 | ProofDeferralManager | **Queue overflow (backpressure)** | New proofs rejected; execution blocked; throughput collapse | 6 | 5 | 3 | 90 | Bounded queue with FIFO eviction of old proofs; admission control; load shedding |
| PDM-007 | ProofDeferralManager | **Worker thread exhaustion** | Proof generation latency spike; claim expiry cascade | 6 | 4 | 4 | 96 | Thread pool monitoring; auto-scaling; work stealing |

---

### 1.4 RollbackController Failure Modes

| ID | Component | Failure Mode | Effect | Sev | Prob | Det | RPN | Mitigation |
|----|-----------|--------------|--------|-----|------|-----|-----|------------|
| RC-001 | RollbackController | **Incomplete rollback cascade** | Orphaned speculative tasks; inconsistent state; potential double-spend | 10 | 3 | 5 | 150 | Transactional rollback; atomic batch operations; post-rollback consistency check |
| RC-002 | RollbackController | **Double rollback (same task)** | State corruption; negative balances; system instability | 8 | 3 | 4 | 96 | Idempotent rollback operations; state tracking; rollback ledger |
| RC-003 | RollbackController | **Missed task in rollback scope** | Inconsistent system state; proof for invalid lineage may succeed | 9 | 4 | 6 | 216 | Complete graph traversal; affected set computation validation; reconciliation checks |
| RC-004 | RollbackController | **Rollback during ongoing execution** | Partial results; corrupt output; undefined behavior | 8 | 4 | 5 | 160 | Execution cancellation protocol; graceful task abort; state isolation |
| RC-005 | RollbackController | **Concurrent rollback conflicts** | Race condition; conflicting state mutations | 8 | 3 | 5 | 120 | Global rollback lock; ordered rollback queue; conflict resolution |
| RC-006 | RollbackController | **Rollback notification failure** | Downstream components unaware; continue processing invalid data | 7 | 3 | 4 | 84 | Synchronous notification; acknowledgment required; retry on failure |
| RC-007 | RollbackController | **Resource cleanup failure** | Memory/connection leaks; gradual degradation | 5 | 5 | 4 | 100 | Resource tracking; cleanup verification; periodic resource audit |

---

### 1.5 SpeculativeScheduler Failure Modes

| ID | Component | Failure Mode | Effect | Sev | Prob | Det | RPN | Mitigation |
|----|-----------|--------------|--------|-----|------|-----|-----|------------|
| SS-001 | SpeculativeScheduler | **Wrong speculation decision (speculate on low-confidence)** | High rollback probability; wasted compute; economic loss | 6 | 5 | 5 | 150 | ML-based confidence scoring; historical success rates; conservative thresholds |
| SS-002 | SpeculativeScheduler | **Resource exhaustion (memory)** | OOM; service crash; all speculation lost | 8 | 4 | 4 | 128 | Memory limits per speculation branch; admission control; resource reservation |
| SS-003 | SpeculativeScheduler | **Deadlock in scheduling queue** | New tasks not scheduled; throughput drops to zero | 8 | 3 | 4 | 96 | Lock-free queue; timeout on queue operations; deadlock detection |
| SS-004 | SpeculativeScheduler | **Depth limit bypass** | Unbounded speculation chains; exponential rollback risk | 9 | 2 | 3 | 54 | Hard enforcement at multiple layers; depth validation before execution |
| SS-005 | SpeculativeScheduler | **Starvation of low-priority tasks** | Unfair scheduling; SLA violations | 5 | 4 | 4 | 80 | Fair scheduling with priority aging; guaranteed minimum throughput |
| SS-006 | SpeculativeScheduler | **Speculation on expiring claims** | Claim expires before proof submission; guaranteed rollback | 6 | 5 | 3 | 90 | Claim buffer validation (claimBufferMs); reject near-expiry tasks |
| SS-007 | SpeculativeScheduler | **Confidence score manipulation** | Attacker influences scheduling decisions; gaming the system | 7 | 3 | 6 | 126 | Input validation; rate limiting; anomaly detection |

---

### 1.6 On-Chain Failure Modes

| ID | Component | Failure Mode | Effect | Sev | Prob | Det | RPN | Mitigation |
|----|-----------|--------------|--------|-----|------|-----|-----|------------|
| OC-001 | OnChainSync | **Transaction failure (rejected)** | Commitment not recorded; must retry or rollback | 6 | 5 | 2 | 60 | Retry with backoff; pre-flight simulation; error classification |
| OC-002 | OnChainSync | **Chain reorganization (reorg)** | Confirmed transaction becomes unconfirmed; false positive finality | 9 | 3 | 5 | 135 | Wait for sufficient confirmations (32+ slots); reorg detection; re-validation |
| OC-003 | OnChainSync | **Race condition (double-submission)** | Duplicate transactions; nonce errors; wasted fees | 5 | 4 | 3 | 60 | Nonce management; transaction deduplication; idempotency |
| OC-004 | OnChainSync | **RPC node failure/latency** | Cannot submit transactions; system stalls | 7 | 4 | 3 | 84 | Multi-RPC failover; health checks; connection pooling |
| OC-005 | OnChainSync | **Insufficient funds for fees** | Transaction rejected; proof submission fails | 6 | 3 | 2 | 36 | Balance monitoring; auto-refill from treasury; fee estimation |
| OC-006 | OnChainSync | **Smart contract bug** | Incorrect on-chain state; funds locked; catastrophic failure | 10 | 2 | 7 | 140 | Formal verification; audits; upgrade path; bug bounty |
| OC-007 | OnChainSync | **Finality observer lag** | Stale confirmation status; premature proof submission | 7 | 4 | 5 | 140 | Real-time WebSocket subscriptions; freshness validation; slot-based checks |
| OC-008 | OnChainSync | **Bond escrow failure** | Agent cannot stake; blocked from speculation | 6 | 3 | 3 | 54 | Pre-validation of bond accounts; retry mechanisms |
| OC-009 | OnChainSync | **Slash distribution failure** | Affected agents not compensated; trust violation | 7 | 2 | 4 | 56 | Atomic slash+distribution; compensation queue; manual resolution fallback |

---

### Summary Statistics

| Component | Total Failure Modes | Max RPN | Avg RPN | Critical (RPN > 150) |
|-----------|--------------------:|--------:|--------:|---------------------:|
| DependencyGraph | 6 | 240 | 142 | 2 |
| CommitmentLedger | 7 | 162 | 112 | 1 |
| ProofDeferralManager | 7 | 160 | 110 | 2 |
| RollbackController | 7 | 216 | 132 | 3 |
| SpeculativeScheduler | 7 | 150 | 103 | 1 |
| OnChainSync | 9 | 140 | 89 | 0 |
| **TOTAL** | **43** | **240** | **113** | **9** |

---

## 2. Risk Matrix

### Visual Risk Matrix (Severity vs Probability)

```
                         P R O B A B I L I T Y
                    1-2      3-4      5-6      7-8      9-10
                  (Rare)   (Low)  (Medium)  (High)  (V.High)
              ┌─────────┬─────────┬─────────┬─────────┬─────────┐
         9-10 │         │ DG-001  │ DG-002  │         │         │
    S  (Crit) │ CL-005  │ RC-001  │ RC-003  │         │         │
    E         │ CL-003  │ PDM-002 │         │         │         │
    V         │ OC-006  │ OC-002  │         │         │         │
    E         ├─────────┼─────────┼─────────┼─────────┼─────────┤
    R    7-8  │         │ DG-004  │ PDM-003 │         │         │
    I  (High) │         │ SS-002  │ RC-004  │         │         │
    T         │         │ CL-007  │ OC-007  │         │         │
    Y         │         │ RC-005  │ OC-006  │         │         │
              ├─────────┼─────────┼─────────┼─────────┼─────────┤
         5-6  │         │ CL-002  │ SS-001  │         │         │
      (Med)   │         │ PDM-005 │ SS-006  │         │         │
              │         │ CL-006  │ PDM-004 │         │         │
              │         │         │ PDM-006 │         │         │
              ├─────────┼─────────┼─────────┼─────────┼─────────┤
         3-4  │         │         │ SS-005  │         │         │
       (Low)  │         │         │ RC-007  │         │         │
              │         │         │         │         │         │
              ├─────────┼─────────┼─────────┼─────────┼─────────┤
         1-2  │         │         │         │         │         │
   (Negligible)│        │         │         │         │         │
              └─────────┴─────────┴─────────┴─────────┴─────────┘

Legend:
  ██████ CRITICAL (Sev×Prob > 40): Immediate action required
  ▓▓▓▓▓▓ HIGH (Sev×Prob 20-40): Action plan within 1 sprint
  ░░░░░░ MEDIUM (Sev×Prob 10-20): Monitor and plan
  ______ LOW (Sev×Prob < 10): Accept or defer
```

### Risk Category Distribution

```
CRITICAL ZONE (Red)        HIGH ZONE (Orange)         MEDIUM ZONE (Yellow)
─────────────────────      ──────────────────         ────────────────────
• DG-002 (Stale data)      • DG-001 (Cycles)          • SS-001 (Wrong decision)
• RC-003 (Missed task)     • DG-004 (Race)            • SS-006 (Expiring claims)
• PDM-003 (Deadlock)       • CL-001 (Lost commit)     • PDM-004 (Timeout)
• RC-004 (Mid-exec)        • CL-004 (State viol.)     • CL-002 (Wrong stake)
• RC-001 (Incomplete)      • PDM-001 (Lost proof)     • SS-005 (Starvation)
                           • OC-002 (Reorg)           • RC-007 (Cleanup)
                           • SS-002 (OOM)             • OC-001 (Tx failure)
```

---

## 3. Critical Risks (Top 5)

### 3.1 RISK-001: Stale Dependency Data (DG-002)

**RPN: 240** | **Severity: 8** | **Probability: 5** | **Detection: 6**

#### Description
The DependencyGraph contains outdated information about task dependencies or completion status. This causes downstream tasks to execute against an assumed state that doesn't match the actual committed state.

#### Impact
- **Correctness**: Tasks produce outputs based on wrong inputs
- **Economic**: Agents stake on invalid speculative work
- **Reputation**: System appears unreliable; trust erosion
- **Cascading**: One stale read can invalidate entire speculation chains

#### Likelihood Assessment
- Distributed system with eventual consistency naturally produces staleness
- High-throughput scenarios increase probability
- Network partitions and RPC lag exacerbate the issue
- Concurrent operations on the same dependency subgraph are common

#### Mitigation Strategy

| Layer | Action | Status |
|-------|--------|--------|
| **Prevention** | Version vectors on all graph nodes; compare versions before execution | Planned |
| **Prevention** | Staleness TTL (configurable, default 5s) with forced refresh | Planned |
| **Detection** | Pre-execution consistency check: re-query critical dependencies | Planned |
| **Detection** | Hash of dependency state included in commitment; validate on-chain | Future |
| **Recovery** | Automatic rollback if staleness detected post-execution | Planned |
| **Recovery** | Reconciliation job comparing runtime and on-chain state | Future |

#### Residual Risk
After mitigations: **RPN ~60** (Sev: 8, Prob: 2, Det: 4)
- Version vectors reduce probability significantly
- Pre-execution checks catch most cases
- Remaining risk: extremely rapid state changes between check and execute

#### Owner
**Team**: Runtime Core  
**DRI**: TBD (assign senior engineer)  
**Review Cadence**: Weekly during implementation; Monthly post-launch

---

### 3.2 RISK-002: Missed Task in Rollback Scope (RC-003)

**RPN: 216** | **Severity: 9** | **Probability: 4** | **Detection: 6**

#### Description
When a rollback is triggered, the RollbackController fails to identify all affected downstream tasks. Some speculative tasks continue execution or remain in a pending state with invalid ancestry.

#### Impact
- **Consistency**: System enters inconsistent state
- **Security**: Proofs may be submitted for tasks with rolled-back ancestors
- **Economic**: Invalid work may be rewarded; valid challenges may fail
- **Audit**: Difficult to trace which tasks were affected

#### Likelihood Assessment
- Complex dependency graphs make complete traversal non-trivial
- Concurrent modifications during rollback can cause missed nodes
- Lazy evaluation of dependents increases risk
- Graph sharding (if implemented) adds complexity

#### Mitigation Strategy

| Layer | Action | Status |
|-------|--------|--------|
| **Prevention** | Snapshot graph state at rollback initiation; traverse immutable copy | Planned |
| **Prevention** | Mark-and-sweep approach: mark all, then sweep | Planned |
| **Detection** | Post-rollback consistency audit: verify no orphans exist | Planned |
| **Detection** | Invariant: every non-root task has confirmed or rolled-back ancestors | Planned |
| **Recovery** | Orphan detection job with automatic cleanup | Planned |
| **Recovery** | Manual reconciliation tools for operators | Future |

#### Residual Risk
After mitigations: **RPN ~36** (Sev: 9, Prob: 2, Det: 2)
- Immutable snapshot eliminates concurrent modification issues
- Post-rollback audit catches remaining cases
- Remaining risk: bugs in traversal algorithm itself

#### Owner
**Team**: Rollback/Recovery  
**DRI**: TBD  
**Review Cadence**: Weekly

---

### 3.3 RISK-003: Concurrent Modification Race in DependencyGraph (DG-004)

**RPN: 224** | **Severity: 8** | **Probability: 4** | **Detection: 7**

#### Description
Multiple threads/processes simultaneously modify the dependency graph, leading to data races that corrupt the graph structure. This can result in lost edges, phantom edges, or inconsistent traversal results.

#### Impact
- **Correctness**: Graph structure doesn't reflect actual dependencies
- **Stability**: Corrupted data structures may cause crashes
- **Unpredictability**: Non-deterministic behavior based on race outcomes
- **Debugging**: Extremely difficult to reproduce and diagnose

#### Likelihood Assessment
- High-throughput systems with many concurrent tasks
- Lack of strong isolation guarantees in initial design
- Complex multi-step operations (add node + edges) are not atomic
- Hot paths under load increase contention

#### Mitigation Strategy

| Layer | Action | Status |
|-------|--------|--------|
| **Prevention** | Reader-writer locks with write preference | Planned |
| **Prevention** | Copy-on-write semantics for read-heavy traversals | Planned |
| **Prevention** | Single-writer principle: mutations through serialized channel | Future |
| **Detection** | Invariant assertions on every read: validate structural integrity | Planned |
| **Detection** | Fuzz testing with concurrent operations | Planned |
| **Recovery** | Rebuild graph from source of truth (CommitmentLedger) on corruption | Planned |

#### Residual Risk
After mitigations: **RPN ~48** (Sev: 8, Prob: 2, Det: 3)
- Proper locking eliminates most races
- Copy-on-write reduces lock contention
- Remaining risk: subtle bugs in lock implementation

#### Owner
**Team**: Runtime Core  
**DRI**: TBD  
**Review Cadence**: During code review; weekly testing

---

### 3.4 RISK-004: Lost Commitment Record (CL-001)

**RPN: 162** | **Severity: 9** | **Probability: 3** | **Detection: 6**

#### Description
A commitment record is created in memory but fails to persist to durable storage. On restart or crash, the commitment is lost, making it appear the task was never executed.

#### Impact
- **Correctness**: Task state inconsistent between runtime and on-chain
- **Economic**: Agent may not receive rewards; may be slashed incorrectly
- **Operational**: Duplicate execution attempts; wasted resources
- **Audit**: Missing audit trail for completed work

#### Likelihood Assessment
- Crash during persistence window before flush
- Storage system failures (disk full, I/O error)
- Asynchronous persistence without confirmation
- Network partition between runtime and storage

#### Mitigation Strategy

| Layer | Action | Status |
|-------|--------|--------|
| **Prevention** | Write-ahead log (WAL) with synchronous commit | Planned |
| **Prevention** | Persistence confirmation before proceeding | Planned |
| **Prevention** | Redundant storage (multi-region replication) | Future |
| **Detection** | Periodic reconciliation: runtime state vs storage | Planned |
| **Detection** | Heartbeat/health checks on storage system | Planned |
| **Recovery** | Recover from on-chain state as source of truth | Planned |
| **Recovery** | Re-execution with idempotency guarantees | Planned |

#### Residual Risk
After mitigations: **RPN ~27** (Sev: 9, Prob: 1, Det: 3)
- WAL with sync commits nearly eliminates loss
- Remaining risk: catastrophic multi-system failure

#### Owner
**Team**: Storage/Persistence  
**DRI**: TBD  
**Review Cadence**: Monthly reliability review

---

### 3.5 RISK-005: Deadlock in Proof Pipeline (PDM-003)

**RPN: 160** | **Severity: 8** | **Probability: 4** | **Detection: 5**

#### Description
The proof generation pipeline enters a deadlock state where workers are waiting on each other or on resources that will never become available. All proof generation stops, causing backpressure that freezes the entire system.

#### Impact
- **Availability**: Proof generation halts completely
- **Latency**: Claims expire; speculative work invalidated
- **Cascading**: Backpressure propagates to task execution
- **Recovery**: May require manual intervention/restart

#### Likelihood Assessment
- Complex multi-stage pipeline with multiple synchronization points
- Resource contention under high load
- Recursive proof dependencies (proof A needs result from proof B)
- Lock ordering violations in complex code paths

#### Mitigation Strategy

| Layer | Action | Status |
|-------|--------|--------|
| **Prevention** | Lock ordering discipline: always acquire in defined order | Planned |
| **Prevention** | Timeout on all blocking operations (no infinite waits) | Planned |
| **Prevention** | Circuit breaker: detect overload, reject new work | Planned |
| **Detection** | Deadlock detection: monitor worker thread states | Planned |
| **Detection** | Throughput monitoring: alert on zero proofs/minute | Planned |
| **Recovery** | Automatic worker restart on deadlock detection | Planned |
| **Recovery** | Manual kill switch to drain and restart pipeline | Planned |

#### Residual Risk
After mitigations: **RPN ~40** (Sev: 8, Prob: 2, Det: 2.5)
- Timeouts prevent permanent deadlock
- Detection enables rapid response
- Remaining risk: complex state to recover from partial deadlock

#### Owner
**Team**: Proof Generation  
**DRI**: TBD  
**Review Cadence**: Weekly performance review

---

## 4. Security Considerations

### 4.1 Economic Attacks

#### 4.1.1 Griefing via Speculation

**Attack Vector**: Malicious agent intentionally triggers rollbacks to waste honest agents' compute resources.

**Mechanism**:
1. Attacker claims parent task, creates speculative commitment
2. Honest agents speculate on children, investing compute
3. Attacker abandons parent or submits invalid proof
4. All downstream work is wasted; honest agents bear compute cost

**Impact**: High (DoS on honest agents; economic drain)

**Mitigations**:
- **Exponential stake bonding** (ADR-003): Deeper speculation requires 2^depth stake
- **Reputation system**: Track agent speculation success rate; penalize chronic failures
- **Slash distribution**: 50% of slashed stake goes to affected downstream agents
- **Speculation whitelist**: Only allow speculation on high-reputation agents

**Residual Risk**: Medium — Economic incentives reduce but don't eliminate griefing

---

#### 4.1.2 Stake Manipulation

**Attack Vector**: Agent manipulates stake calculations to under-bond, reducing slashing penalty.

**Mechanism**:
1. Exploit bug in stake calculation logic
2. Report incorrect speculation depth
3. Get slashed less than should be

**Impact**: Medium (economic leakage; unfair advantage)

**Mitigations**:
- **On-chain stake validation**: Smart contract independently calculates required stake
- **Depth tracking on-chain**: Speculation depth derived from on-chain dependency graph
- **Automated reconciliation**: Compare runtime stake with on-chain state

**Residual Risk**: Low — On-chain validation is authoritative

---

#### 4.1.3 Front-Running Speculation

**Attack Vector**: Observer sees high-value speculative commitment and front-runs to claim task first.

**Mechanism**:
1. Monitor mempool for speculative commitments
2. Race to claim same task before original agent
3. Profit from information asymmetry

**Impact**: Medium (unfair competition; MEV extraction)

**Mitigations**:
- **Commitment-reveal scheme**: Commit to task claim without revealing task ID
- **Private mempool**: Use Jito or similar for transaction privacy
- **Claim expiry**: Short claim windows reduce front-running opportunity

**Residual Risk**: Medium — MEV is inherent to public blockchains

---

### 4.2 DoS Vectors

#### 4.2.1 Proof Queue Flooding

**Attack Vector**: Submit massive number of proof requests to overwhelm pipeline.

**Mechanism**:
1. Create many speculative tasks with dependencies
2. Each generates proof requests
3. Pipeline overloaded; legitimate proofs delayed

**Impact**: High (service degradation for all users)

**Mitigations**:
- **Rate limiting**: Per-agent proof request limits
- **Admission control**: Reject requests when queue exceeds threshold
- **Priority queuing**: High-reputation agents get priority
- **Cost**: Require stake even for proof generation request

**Residual Risk**: Low — Multiple layers of defense

---

#### 4.2.2 Graph Explosion Attack

**Attack Vector**: Create complex dependency graphs designed to slow traversal.

**Mechanism**:
1. Create dense graph with many edges
2. Trigger rollback that requires full traversal
3. System slows to crawl during traversal

**Impact**: Medium (temporary performance degradation)

**Mitigations**:
- **Dependency limit**: Max edges per task
- **Depth limit**: Max speculation depth
- **Traversal timeout**: Abort slow traversals
- **Incremental traversal**: Stream results instead of computing all at once

**Residual Risk**: Low — Limits bound worst-case

---

#### 4.2.3 Storage Exhaustion

**Attack Vector**: Create many speculative commitments that never resolve.

**Mechanism**:
1. Create speculative tasks at maximum allowed rate
2. Never submit proofs
3. Storage fills with pending commitments

**Impact**: Medium (disk space exhaustion)

**Mitigations**:
- **TTL on pending commitments**: Auto-expire after configurable period
- **Per-agent commitment limits**: Bound outstanding commitments
- **Storage quotas**: Hard limits on storage per agent
- **GC**: Aggressive garbage collection of stale data

**Residual Risk**: Low — TTL and limits prevent unbounded growth

---

### 4.3 Information Leakage

#### 4.3.1 Speculative State Exposure

**Attack Vector**: Probe speculative state to learn about pending computations.

**Mechanism**:
1. Query dependency graph or commitment ledger
2. Infer what tasks are being speculated on
3. Gain competitive advantage

**Impact**: Low-Medium (information asymmetry)

**Mitigations**:
- **Access control**: Only task owners can query their speculative state
- **Aggregated metrics only**: Public metrics don't reveal individual tasks
- **Encryption**: Speculative state encrypted at rest

**Residual Risk**: Low — Access control is straightforward

---

#### 4.3.2 Timing Side Channels

**Attack Vector**: Observe timing of operations to infer system state.

**Mechanism**:
1. Measure response times for various queries
2. Infer cache state, speculation depth, queue lengths
3. Time attacks or gain unfair advantage

**Impact**: Low (difficult to exploit meaningfully)

**Mitigations**:
- **Constant-time operations**: Where feasible, avoid data-dependent timing
- **Noise injection**: Add random delays to sensitive operations
- **Rate limiting**: Prevent rapid probing

**Residual Risk**: Low — Timing attacks rarely critical here

---

### 4.4 Race Conditions

#### 4.4.1 Rollback During Proof Submission

**Attack Vector**: Race between rollback signal and proof submission.

**Mechanism**:
1. Task A fails, triggering rollback of dependent task B
2. Simultaneously, B's proof is being submitted on-chain
3. Proof succeeds before rollback completes
4. Inconsistent state: B confirmed but A failed

**Impact**: High (invalid state committed on-chain)

**Mitigations**:
- **Atomic state check**: Verify ancestor status at submission time
- **On-chain validation**: Smart contract verifies all ancestors confirmed
- **Optimistic lock**: Hold ancestor confirmations during submission
- **Post-submission validation**: Even if submitted, don't count as success if invalid

**Residual Risk**: Low — On-chain validation is the final authority

---

#### 4.4.2 Concurrent Commitment Updates

**Attack Vector**: Two processes update same commitment concurrently.

**Mechanism**:
1. Process A reads commitment state = SPECULATIVE
2. Process B reads commitment state = SPECULATIVE
3. A updates to PROVING
4. B updates to ROLLED_BACK
5. Final state depends on write order

**Impact**: Medium (inconsistent commitment state)

**Mitigations**:
- **Optimistic concurrency control**: Version field on commitments
- **Compare-and-swap updates**: Only succeed if version matches
- **Single-writer per commitment**: Route all updates through owner

**Residual Risk**: Low — OCC is well-understood pattern

---

## 5. Correctness Proof Sketches

### 5.1 Invariant: "Proof Never Submitted Before Ancestors Confirmed"

**Formal Statement**: For any task T with proof submitted at time t_s, all ancestors A ∈ ancestors(T) have confirmation time t_c(A) < t_s.

**Proof Sketch**:

1. **Base Case**: Task T with no ancestors (root task)
   - ancestors(T) = ∅
   - Invariant trivially holds (vacuously true)

2. **Inductive Case**: Task T with ancestors A₁, A₂, ..., Aₙ
   
   **Precondition** (enforced by ProofDeferralManager):
   - ProofDeferralManager maintains a blocking wait on each ancestor
   - `awaitAncestorConfirmation(T)` blocks until ∀Aᵢ: status(Aᵢ) = CONFIRMED
   
   **Proof**:
   - Let T be any task with pending proof P
   - Before `submitProof(P)` is called:
     - `checkSubmissionAllowed(T)` queries CommitmentLedger
     - For each Aᵢ ∈ ancestors(T):
       - If status(Aᵢ) ≠ CONFIRMED: `checkSubmissionAllowed` returns FALSE
       - Submission blocked until all ancestors confirmed
   - Once all ancestors confirmed at times t_c(Aᵢ):
     - `checkSubmissionAllowed(T)` returns TRUE at time t_check
     - t_check > max(t_c(Aᵢ)) for all i
   - `submitProof(P)` called at time t_s ≥ t_check
   - Therefore: t_s > t_c(Aᵢ) for all ancestors Aᵢ ∎

3. **Edge Cases**:
   - **Reorg**: If ancestor Aᵢ is re-orged after t_s but before T's confirmation
     - Detection: FinalityTracker monitors for reorgs
     - Response: T's proof is also invalidated and must be resubmitted
   - **Concurrent ancestor confirmation**: Multiple ancestors confirm simultaneously
     - Handled: `awaitAncestorConfirmation` uses barrier synchronization
     - All must confirm before barrier releases

**Implementation Requirement**: The `checkSubmissionAllowed()` function MUST be atomic with `submitProof()` to prevent TOCTOU race.

---

### 5.2 Invariant: "Rollback Cascade is Complete" (No Orphaned Tasks)

**Formal Statement**: After rollback(T) completes, for all tasks D ∈ descendants(T): status(D) ∈ {ROLLED_BACK, NEVER_STARTED}.

**Proof Sketch**:

1. **Algorithm**: `rollbackCascade(T)` operates as follows:
   ```
   function rollbackCascade(T):
     affected = computeAffectedSet(T)
     for D in reverse_topological_order(affected):
       markRolledBack(D)
     validateNoOrphans(affected)
   ```

2. **Proof of Completeness**:

   **Claim**: `computeAffectedSet(T)` returns all descendants of T.
   
   **Proof**:
   - `computeAffectedSet` performs BFS from T following dependency edges
   - DependencyGraph maintains bidirectional edges: parent→children, child→parents
   - BFS visits every reachable node from T via child edges
   - By definition, descendants(T) = reachable nodes via child edges
   - Therefore, affected ⊇ descendants(T)
   
   **Claim**: Every D ∈ affected is marked ROLLED_BACK.
   
   **Proof**:
   - Loop iterates over all elements in affected set
   - Each iteration calls `markRolledBack(D)`
   - `markRolledBack` is idempotent (marking twice is safe)
   - After loop: ∀D ∈ affected: status(D) = ROLLED_BACK
   
   **Claim**: No orphans exist after rollback.
   
   **Proof** (by contradiction):
   - Assume orphan O exists: O ∈ descendants(T) but status(O) ≠ ROLLED_BACK
   - Since O ∈ descendants(T), O is reachable from T via child edges
   - Therefore O ∈ affected (by completeness of BFS)
   - But we proved ∀D ∈ affected: status(D) = ROLLED_BACK
   - Contradiction. Therefore no orphan exists. ∎

3. **Validation Step**: `validateNoOrphans(affected)`:
   ```
   function validateNoOrphans(affected):
     for D in affected:
       assert status(D) == ROLLED_BACK
       for child in children(D):
         assert child in affected OR status(child) == NEVER_STARTED
   ```

4. **Edge Cases**:
   - **Concurrent task creation**: New descendant created during rollback
     - Prevention: Acquire write lock on affected subgraph before rollback
     - New tasks blocked until rollback completes
   - **Already confirmed descendant**: D confirmed on-chain before rollback
     - This should be impossible if ancestor hasn't confirmed (Invariant 5.1)
     - If occurs due to bug: Critical alert; manual reconciliation required

---

### 5.3 Invariant: "Depth Limit Enforced" (Bounded Speculation)

**Formal Statement**: For all tasks T in speculative state, depth(T) ≤ max_depth where depth(T) = length of longest path from any confirmed ancestor to T.

**Proof Sketch**:

1. **Definition**:
   - depth(T) = 0 if T has no speculative ancestors (all ancestors confirmed)
   - depth(T) = max(depth(parent) for parent in speculative_parents(T)) + 1

2. **Enforcement Points**:

   **Point A**: Task scheduling in SpeculativeScheduler
   ```
   function scheduleSpeculative(T):
     currentDepth = computeSpeculativeDepth(T)
     if currentDepth >= config.max_depth:
       return REJECT_DEPTH_EXCEEDED
     // ... proceed with scheduling
   ```

   **Point B**: Commitment creation in CommitmentLedger
   ```
   function createCommitment(T, depth):
     if depth > config.max_depth:
       throw DepthExceededException
     // ... create commitment
   ```

   **Point C**: On-chain validation (Solana program)
   ```rust
   pub fn create_speculative_commitment(ctx: Context, depth: u8) -> Result<()> {
     require!(depth <= ctx.accounts.config.max_depth, ErrorCode::DepthExceeded);
     // ... proceed
   }
   ```

3. **Proof of Enforcement**:

   **Claim**: No task T can enter speculative execution with depth > max_depth.
   
   **Proof**:
   - Path to speculative execution: scheduleSpeculative → executeTask → createCommitment
   - At scheduleSpeculative: depth checked, rejected if exceeds
   - At createCommitment: depth checked again (defense in depth)
   - On-chain: final validation before commitment recorded
   - All three checks must pass for depth > max_depth task
   - If any check fails, task is not speculatively executed
   - Therefore invariant holds ∎

4. **Depth Calculation Correctness**:
   
   **Claim**: `computeSpeculativeDepth(T)` correctly computes depth(T).
   
   **Proof**:
   ```
   function computeSpeculativeDepth(T):
     if all ancestors confirmed:
       return 0
     maxParentDepth = max(computeSpeculativeDepth(P) for P in parents(T) if P.speculative)
     return maxParentDepth + 1
   ```
   - Base case: No speculative ancestors → depth = 0 ✓
   - Inductive case: depth = max parent depth + 1
   - This matches the definition exactly ∎

5. **Edge Cases**:
   - **Ancestor confirms after depth calculation**: Depth decreases; still within limit
   - **Config change lowering max_depth**: Existing tasks grandfathered; new tasks use new limit
   - **Concurrent depth calculation**: Each calculation independent; no race condition

---

## 6. Assumptions & Dependencies

### 6.1 System Assumptions

| ID | Assumption | Consequence if Violated | Validation |
|----|------------|------------------------|------------|
| A-001 | Solana network is available and responsive | System cannot progress; tasks stall | RPC health monitoring; failover |
| A-002 | Clock skew between nodes < 10 seconds | Claim expiry calculations may be wrong | NTP sync required; bound checked |
| A-003 | Storage system is durable (survives crashes) | Data loss; inconsistent state | Use managed DBs with replication |
| A-004 | Network partitions are temporary (< 5 minutes) | Extended partition causes mass rollback | Partition detection; graceful degrade |
| A-005 | Agents are rational economic actors | Attacks may not follow economic models | Defense in depth; monitoring |
| A-006 | ZK proof generation is deterministic | Same inputs may produce different proofs | Validate proof system properties |
| A-007 | Hash functions are collision-resistant | Commitment integrity compromised | Use standard cryptographic hashes |
| A-008 | Solana slot time is approximately 400ms | Timing calculations may drift | Use slot numbers, not wall time |
| A-009 | Smart contract is bug-free after audit | On-chain state corruption possible | Audit; formal verification; upgrade path |
| A-010 | Runtime has sufficient memory for graph | OOM crash; service outage | Memory limits; monitoring; scaling |

### 6.2 External Dependencies

| Dependency | Type | Failure Mode | Impact | Mitigation |
|------------|------|--------------|--------|------------|
| **Solana RPC** | Infrastructure | Unavailable / slow | Cannot submit transactions | Multi-RPC; health checks; failover |
| **Solana Validator** | Infrastructure | Network congestion | Delayed confirmations | Patience; retry; alternative routes |
| **PostgreSQL** | Data Store | Crash / corruption | State loss | Replication; backups; WAL |
| **Redis** | Cache | Crash / eviction | Performance degradation | Treat as cache, not source of truth |
| **ZK Prover** | Compute | Crash / timeout | Proofs not generated | Retry; alternative provers; timeout |
| **Monitoring (Grafana)** | Observability | Unavailable | Blind operations | Backup alerting; log analysis |
| **Time Service (NTP)** | Infrastructure | Drift | Incorrect expiry calculations | Multiple NTP sources; drift detection |

### 6.3 Dependency Failure Modes

#### Solana RPC Failure

```
Failure → Impact → Response
────────────────────────────────────────────────────────────────
RPC timeout    → Tx not submitted → Retry with backoff
RPC error 429  → Rate limited     → Back off; use alt RPC
RPC disconnect → Connection lost  → Reconnect; resume from state
RPC wrong data → Bad chain state  → Cross-validate with other RPCs
```

#### Database Failure

```
Failure → Impact → Response
────────────────────────────────────────────────────────────────
Primary down    → Writes blocked  → Failover to replica
Replication lag → Stale reads     → Route reads to primary
Disk full       → All ops blocked → Alert; emergency cleanup
Corruption      → Data loss       → Restore from backup
```

---

## 7. Monitoring & Detection

### 7.1 Critical Metrics

| Metric | Description | Alert Threshold | Response Time |
|--------|-------------|-----------------|---------------|
| `speculation.rollback_rate` | Rollbacks per minute | > 10/min | 5 minutes |
| `speculation.depth.p99` | 99th percentile speculation depth | > max_depth - 1 | 15 minutes |
| `speculation.orphan_count` | Tasks with invalid ancestry | > 0 | Immediate |
| `commitment.pending_duration_p99` | Time in pending state | > 120s | 10 minutes |
| `proof.queue_depth` | Pending proof requests | > 80% capacity | 5 minutes |
| `proof.generation_errors` | Failed proof generations | > 5/min | 5 minutes |
| `dependency_graph.cycle_detected` | Cycle detection events | > 0 | Immediate |
| `dependency_graph.memory_bytes` | Graph memory usage | > 80% limit | 15 minutes |
| `rollback.cascade_size_p99` | Tasks affected per rollback | > 50 | 10 minutes |
| `rollback.duration_p99` | Rollback completion time | > 30s | 5 minutes |
| `onchain.tx_failure_rate` | Transaction failure rate | > 5% | 5 minutes |
| `onchain.confirmation_lag` | Time to confirmation | > 60s | 10 minutes |

### 7.2 Detection Strategies by Failure Mode

#### DG-002: Stale Dependency Data

| Detection Method | Metric/Signal | Alert Condition |
|------------------|---------------|-----------------|
| **Freshness check** | `dependency.staleness_age_ms` | p99 > 5000ms |
| **Version mismatch** | `dependency.version_mismatch_count` | > 0 in 1 minute |
| **Reconciliation diff** | `dependency.reconciliation_drift` | > 0 items |

**Response**: Trigger full graph refresh; investigate source of staleness.

---

#### RC-003: Missed Task in Rollback

| Detection Method | Metric/Signal | Alert Condition |
|------------------|---------------|-----------------|
| **Orphan detector** | `rollback.orphan_tasks_detected` | > 0 |
| **Consistency audit** | `rollback.post_audit_failures` | > 0 |
| **Anomaly detection** | Tasks with speculative ancestors that are rolled_back | exists |

**Response**: Immediate page; run manual reconciliation; root cause analysis.

---

#### PDM-003: Deadlock in Proof Pipeline

| Detection Method | Metric/Signal | Alert Condition |
|------------------|---------------|-----------------|
| **Throughput drop** | `proof.completed_per_minute` | < 1 for 5 minutes |
| **Queue growth** | `proof.queue_depth` increasing | monotonic for 10 minutes |
| **Worker health** | `proof.active_workers` | < expected |
| **Lock analysis** | Thread dump analysis | Deadlock pattern detected |

**Response**: Restart proof workers; if persists, full service restart.

---

#### CL-001: Lost Commitment Record

| Detection Method | Metric/Signal | Alert Condition |
|------------------|---------------|-----------------|
| **Write confirmation** | `commitment.write_failures` | > 0 |
| **Reconciliation** | `commitment.missing_vs_onchain` | > 0 |
| **WAL monitoring** | `storage.wal_behind_bytes` | > 1MB |

**Response**: Check storage health; recover from WAL or on-chain state.

---

#### OC-002: Chain Reorganization

| Detection Method | Metric/Signal | Alert Condition |
|------------------|---------------|-----------------|
| **Reorg detector** | `onchain.reorg_depth` | > 0 |
| **Confirmation reversal** | `commitment.confirmation_reverted` | > 0 |
| **Slot tracking** | `onchain.slot_regression` | detected |

**Response**: Re-validate all recently confirmed commitments; rollback if needed.

---

### 7.3 Alerting Tiers

| Tier | Severity | Response Time | Escalation | Examples |
|------|----------|---------------|------------|----------|
| **P1** | Critical | < 15 minutes | Immediate page | Orphan detected, deadlock, data loss |
| **P2** | High | < 1 hour | Page if not ack'd | High rollback rate, memory pressure |
| **P3** | Medium | < 4 hours | Slack notification | Elevated latency, queue growth |
| **P4** | Low | Next business day | Ticket | Deprecation warnings, minor anomalies |

### 7.4 Dashboard Panels

#### Speculation Health Dashboard

```
┌─────────────────────────────────────────────────────────────────┐
│ SPECULATION HEALTH                                    [HEALTHY] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Active Speculations    Rollback Rate       Avg Depth           │
│  ┌──────────────────┐  ┌──────────────┐   ┌──────────────┐     │
│  │     1,247        │  │   0.3/min    │   │     2.4      │     │
│  │   ▲ 12% vs avg   │  │  ✓ Normal    │   │  ✓ < limit   │     │
│  └──────────────────┘  └──────────────┘   └──────────────┘     │
│                                                                 │
│  Proof Queue          Confirmation Lag     Memory Usage         │
│  ┌──────────────────┐  ┌──────────────┐   ┌──────────────┐     │
│  │    234 (23%)     │  │   8.2s avg   │   │   3.2 GB     │     │
│  │  ✓ Healthy       │  │  ✓ Normal    │   │  ⚠ 80%       │     │
│  └──────────────────┘  └──────────────┘   └──────────────┘     │
│                                                                 │
│  ─────────────────── Time Series ───────────────────────────── │
│                                                                 │
│  Speculation Rate (tasks/min)                                   │
│  100│    ╭─╮                                                    │
│   80│   ╭╯ ╰╮  ╭─╮                                              │
│   60│  ╭╯   ╰──╯ ╰╮                                             │
│   40│ ╭╯          ╰─╮                                           │
│   20│╭╯             ╰──                                         │
│    0└────────────────────────────────────────────────           │
│      00:00    06:00    12:00    18:00    24:00                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.5 Runbook Integration

Each high-risk failure mode links to operational runbook:

| Failure Mode | Runbook Section |
|--------------|-----------------|
| DG-001 (Cycle) | [RUNBOOK.md#cycle-detected](./runbooks/RUNBOOK.md#cycle-detected) |
| DG-002 (Stale) | [RUNBOOK.md#stale-dependency](./runbooks/RUNBOOK.md#stale-dependency) |
| CL-001 (Lost) | [RUNBOOK.md#lost-commitment](./runbooks/RUNBOOK.md#lost-commitment) |
| PDM-003 (Deadlock) | [RUNBOOK.md#proof-deadlock](./runbooks/RUNBOOK.md#proof-deadlock) |
| RC-001 (Incomplete) | [RUNBOOK.md#incomplete-rollback](./runbooks/RUNBOOK.md#incomplete-rollback) |
| OC-002 (Reorg) | [RUNBOOK.md#chain-reorg](./runbooks/RUNBOOK.md#chain-reorg) |

---

## Appendix A: Risk Register Summary

| Rank | ID | Risk | RPN | Status | Owner |
|-----:|:---|:-----|----:|:-------|:------|
| 1 | DG-002 | Stale dependency data | 240 | Mitigating | Runtime Core |
| 2 | DG-004 | Concurrent modification race | 224 | Mitigating | Runtime Core |
| 3 | RC-003 | Missed task in rollback | 216 | Mitigating | Rollback Team |
| 4 | CL-001 | Lost commitment record | 162 | Mitigating | Storage Team |
| 5 | PDM-003 | Proof pipeline deadlock | 160 | Mitigating | Proof Team |
| 6 | RC-004 | Rollback during execution | 160 | Planned | Rollback Team |
| 7 | SS-001 | Wrong speculation decision | 150 | Planned | Scheduler Team |
| 8 | RC-001 | Incomplete rollback cascade | 150 | Planned | Rollback Team |
| 9 | CL-007 | Cross-shard inconsistency | 144 | Deferred | Storage Team |
| 10 | DG-003 | Memory leak | 140 | Planned | Runtime Core |

---

## Appendix B: Review History

| Date | Reviewer | Changes |
|------|----------|---------|
| 2025-01-28 | Initial | Document created |

---

*Document Version: 1.0*  
*Next Review: 2025-02-28*
