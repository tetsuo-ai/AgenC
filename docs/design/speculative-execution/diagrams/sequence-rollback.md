# Sequence Diagram: Rollback on Proof Failure

> **Related Issues:** #269, #271, #275  
> **Last Updated:** 2026-01-28

## Overview

This diagram shows the rollback cascade when Task A's proof fails, requiring Task B (which speculatively executed based on A's unconfirmed outputs) to be rolled back and its work discarded.

```mermaid
sequenceDiagram
    autonumber
    
    participant TD as TaskDiscovery
    participant STS as SpeculativeTaskScheduler
    participant DG as DependencyGraph
    participant CL as CommitmentLedger
    participant PDM as ProofDeferralManager
    participant RC as RollbackController
    participant EX as Executor
    participant ZK as ZK Prover
    participant SOL as Solana RPC
    participant AG as Affected Agents

    %% ============================================
    %% PHASE 1: Setup - Both tasks executing
    %% ============================================
    rect rgb(230, 245, 230)
        Note over TD,AG: Phase 1: Initial Setup (Tasks A and B executing)
        
        Note right of STS: Task A discovered, executed,<br/>proof generating...
        
        TD->>STS: onTaskDiscovered(TaskA)
        STS->>DG: addTask(TaskA)
        STS->>CL: createCommitment(A, depth=0, EXECUTING)
        STS->>EX: executeTask(TaskA)
        EX-->>STS: ExecutionResult(A, outputs)
        STS->>CL: updateStatus(A, PROOF_GENERATING)
        STS->>PDM: startProofGeneration(A)
        PDM->>ZK: generateProof(A)
        activate ZK
        
        Note right of STS: Task B discovered, speculatively<br/>executed based on A's outputs...
        
        TD->>STS: onTaskDiscovered(TaskB, dependsOn=A)
        STS->>DG: addTask(TaskB), addDependency(B→A)
        STS->>CL: createCommitment(B, depth=1, EXECUTING)
        STS->>CL: bondStake(B, 2×baseBond)
        STS->>EX: executeTask(TaskB, speculativeInputs)
        EX-->>STS: ExecutionResult(B, outputs)
        STS->>CL: updateStatus(B, EXECUTED)
        STS->>PDM: startProofGeneration(B)
        PDM->>ZK: generateProof(B)
        Note right of ZK: Both proofs generating<br/>in parallel...
    end

    %% ============================================
    %% PHASE 2: Task A Proof FAILS
    %% ============================================
    rect rgb(255, 230, 230)
        Note over TD,AG: Phase 2: Task A Proof Verification Fails
        
        ZK-->>PDM: proofReady(A, proof)
        deactivate ZK
        
        PDM-->>STS: onProofGenerated(A, proof)
        STS->>CL: updateStatus(A, SUBMITTING)
        
        STS->>PDM: submitProof(A)
        PDM->>SOL: submitProof(A, proof)
        activate SOL
        
        Note right of SOL: ❌ Proof verification FAILS<br/>(invalid computation,<br/>wrong inputs, etc.)
        
        SOL-->>PDM: ProofVerificationError
        deactivate SOL
        
        PDM-->>STS: onProofFailed(A, ProofVerificationError)
        
        STS->>CL: updateStatus(A, FAILED)
        Note right of CL: Record failure reason<br/>and timestamp
    end

    %% ============================================
    %% PHASE 3: Rollback Initiated
    %% ============================================
    rect rgb(255, 240, 200)
        Note over TD,AG: Phase 3: Rollback Controller Takes Over
        
        STS->>RC: initiateRollback(A, PROOF_VERIFICATION_FAILED)
        activate RC
        
        RC->>DG: getDescendants(A)
        Note right of DG: Find all tasks that<br/>speculatively depend on A
        DG-->>RC: [TaskB]
        
        RC->>RC: createRollbackOperation(A, [A, B])
        Note right of RC: Order: reverse topological<br/>(ADR-005: leaves first)
        
        RC->>RC: orderForRollback([A, B]) → [B, A]
    end

    %% ============================================
    %% PHASE 4: Cascade Rollback (Leaves First)
    %% ============================================
    rect rgb(255, 220, 220)
        Note over TD,AG: Phase 4: Rolling Back Task B (leaf node)
        
        RC->>PDM: cancelProofGeneration(B)
        PDM->>ZK: cancel(B)
        ZK-->>PDM: cancelled
        
        RC->>CL: updateStatus(B, ROLLED_BACK)
        RC->>CL: getCommitment(B)
        CL-->>RC: SpeculativeCommitment(B, bondedStake=2×baseBond)
        
        Note right of RC: Task B's stake is NOT slashed<br/>(victim of upstream failure)
        
        RC->>CL: releaseStake(B)
        Note right of CL: 2×baseBond returned to<br/>Task B's agent
        
        RC->>DG: updateNodeStatus(B, ROLLED_BACK)
        
        RC->>RC: recordRolledBackTask(B, computeWasted=X)
    end

    rect rgb(255, 200, 200)
        Note over TD,AG: Phase 5: Rolling Back Task A (root cause)
        
        RC->>CL: updateStatus(A, FAILED)
        RC->>CL: getCommitment(A)
        CL-->>RC: SpeculativeCommitment(A, bondedStake=baseBond)
        
        Note right of RC: Task A CAUSED the failure<br/>→ SLASH the stake
        
        RC->>CL: slashStake(A)
        CL->>CL: calculate slash distribution
        Note right of CL: 50% treasury, 50% affected<br/>(ADR-007)
        CL-->>RC: SlashResult(treasuryShare, affectedShares)
        
        RC->>DG: updateNodeStatus(A, FAILED)
    end

    %% ============================================
    %% PHASE 5: Notify Affected Agents
    %% ============================================
    rect rgb(240, 240, 255)
        Note over TD,AG: Phase 6: Compensation and Notification
        
        RC->>AG: notifyRollback(B, reason=ANCESTOR_FAILED)
        Note right of AG: Agent B learns their<br/>speculative work was wasted
        
        RC->>AG: distributeSlashCompensation(B, share)
        Note right of AG: Agent B receives portion<br/>of A's slashed stake
        
        RC-->>STS: RollbackResult(success=true, rolledBack=[B,A], slashed=baseBond)
        deactivate RC
        
        Note over STS: Metrics updated:<br/>speculation.rolled_back=1<br/>rollback.cascade_size=2<br/>compute.wasted=X tokens
    end

    Note over TD,AG: ❌ Rollback Complete<br/>A: Failed + Slashed<br/>B: Rolled back + Compensated
```

## Rollback Order Explanation (ADR-005)

The rollback proceeds in **reverse topological order** (leaves first):

```mermaid
graph TD
    A[Task A<br/>ROOT CAUSE] --> B[Task B<br/>DEPENDENT]
    
    style A fill:#ff6666
    style B fill:#ffaa66
```

**Rollback sequence:** B → A (not A → B)

**Why?**
- Rolling back A first would leave B in an inconsistent state
- B's outputs may reference A's outputs that no longer exist
- Processing leaves first ensures clean state at each level

## Stake Treatment

| Task | Role | Stake Treatment |
|------|------|-----------------|
| Task A | **Root cause** (proof failed) | **SLASHED** - Agent A loses stake |
| Task B | **Victim** (depended on A) | **RETURNED** - Agent B recovers full stake |

## Compensation Distribution (ADR-007)

When Task A's stake is slashed:

```
Slashed Amount: baseBond
├── 50% → Protocol Treasury
└── 50% → Affected Agents (proportional to wasted compute)
           └── Agent B: receives their share
```

## State Transitions

```mermaid
stateDiagram-v2
    direction LR
    
    state "Task A" as A {
        A_EXEC: EXECUTING
        A_DONE: EXECUTED
        A_PROOF: PROOF_GENERATING
        A_SUB: SUBMITTING
        A_FAIL: FAILED
        
        A_EXEC --> A_DONE
        A_DONE --> A_PROOF
        A_PROOF --> A_SUB
        A_SUB --> A_FAIL: Proof rejected
    }
    
    state "Task B" as B {
        B_EXEC: EXECUTING
        B_DONE: EXECUTED
        B_PROOF: PROOF_GENERATING
        B_ROLL: ROLLED_BACK
        
        B_EXEC --> B_DONE
        B_DONE --> B_PROOF
        B_PROOF --> B_ROLL: Ancestor A failed
    }
```

## Metrics Emitted

| Event | Metric | Value |
|-------|--------|-------|
| Rollback initiated | `rollback.initiated` | +1 |
| Task B rolled back | `speculation.rolled_back` | +1 |
| Cascade size | `rollback.cascade_size` | 2 |
| A's stake slashed | `stake.slashed_lamports` | baseBond |
| B's compute wasted | `compute.wasted_tokens` | X |

## Edge Cases

### Multiple Descendants
If Task A had multiple dependents (B, C, D), all would be rolled back:

```
Rollback order: D → C → B → A (all leaves, then root)
```

### Nested Speculation (A → B → C)
If C speculatively executed based on B's unconfirmed outputs:

```
Rollback order: C → B → A (deepest first)
```

C and B get stake returned (victims); only A gets slashed (root cause).
