# State Machine: SpeculativeCommitment Lifecycle

> **Related Issues:** #266, #271  
> **Last Updated:** 2026-01-28

## Overview

This state machine defines the lifecycle of a `SpeculativeCommitment`, from creation through confirmation or rollback.

## State Diagram

```mermaid
stateDiagram-v2
    direction TB
    
    [*] --> PENDING: createCommitment()
    
    PENDING --> EXECUTING: bondStake() success
    PENDING --> FAILED: bondStake() failed<br/>(insufficient balance)
    
    EXECUTING --> EXECUTED: execution completes
    EXECUTING --> FAILED: execution error
    EXECUTING --> ROLLED_BACK: ancestor failed<br/>during execution
    
    EXECUTED --> PROOF_GENERATING: startProofGeneration()
    EXECUTED --> ROLLED_BACK: ancestor failed
    
    PROOF_GENERATING --> PROOF_GENERATED: proof ready
    PROOF_GENERATING --> FAILED: proof generation error
    PROOF_GENERATING --> FAILED: proof timeout
    PROOF_GENERATING --> ROLLED_BACK: ancestor failed
    
    PROOF_GENERATED --> AWAITING_ANCESTORS: has unconfirmed ancestors
    PROOF_GENERATED --> SUBMITTING: no unconfirmed ancestors
    PROOF_GENERATED --> ROLLED_BACK: ancestor failed
    
    AWAITING_ANCESTORS --> SUBMITTING: all ancestors confirmed
    AWAITING_ANCESTORS --> ROLLED_BACK: ancestor failed
    
    SUBMITTING --> CONFIRMED: proof verified on-chain
    SUBMITTING --> FAILED: proof rejected on-chain
    SUBMITTING --> FAILED: submission timeout
    
    CONFIRMED --> [*]: stake released
    FAILED --> [*]: stake slashed (if root cause)<br/>or released (if victim)
    ROLLED_BACK --> [*]: stake released
    
    note right of PENDING
        Initial state when commitment
        is created but not yet bonded
    end note
    
    note right of AWAITING_ANCESTORS
        ADR-002: Cannot submit proof
        until all ancestors confirmed
    end note
    
    note right of FAILED
        Root cause: stake slashed
        Victim: stake returned
    end note
```

## State Descriptions

| State | Description | Entry Conditions | Exit Conditions |
|-------|-------------|------------------|-----------------|
| `PENDING` | Commitment created, awaiting stake bond | `createCommitment()` called | Stake bonded or bond failed |
| `EXECUTING` | Task is actively computing | Stake successfully bonded | Execution completes or fails |
| `EXECUTED` | Compute finished, results available | Execution returned successfully | Proof generation starts or rollback |
| `PROOF_GENERATING` | ZK proof being generated | `startProofGeneration()` called | Proof ready, error, or timeout |
| `PROOF_GENERATED` | Proof ready, checking ancestor status | Prover returned valid proof | Ancestors checked |
| `AWAITING_ANCESTORS` | Proof ready but waiting for ancestor confirmations | Has unconfirmed ancestors | All ancestors confirmed or one fails |
| `SUBMITTING` | Proof being submitted to Solana | All ancestors confirmed | On-chain result received |
| `CONFIRMED` | Proof verified, commitment finalized | On-chain verification passed | Stake released (terminal) |
| `FAILED` | Commitment failed (various reasons) | See failure transitions | Stake handled (terminal) |
| `ROLLED_BACK` | Rolled back due to ancestor failure | Ancestor entered FAILED state | Stake released (terminal) |

## Transition Details

### Happy Path Transitions

```mermaid
graph LR
    A[PENDING] -->|"bondStake()"| B[EXECUTING]
    B -->|"complete"| C[EXECUTED]
    C -->|"startProof()"| D[PROOF_GENERATING]
    D -->|"proofReady"| E[PROOF_GENERATED]
    E -->|"no ancestors"| F[SUBMITTING]
    F -->|"verified"| G[CONFIRMED]
    
    style A fill:#f9f
    style G fill:#9f9
```

### Speculative Path (With Ancestors)

```mermaid
graph LR
    E[PROOF_GENERATED] -->|"has ancestors"| F[AWAITING_ANCESTORS]
    F -->|"all confirmed"| G[SUBMITTING]
    G -->|"verified"| H[CONFIRMED]
    
    style F fill:#ff9
    style H fill:#9f9
```

### Failure Paths

```mermaid
graph TD
    subgraph "Self-Caused Failures"
        A1[PENDING] -->|"insufficient balance"| F1[FAILED]
        A2[EXECUTING] -->|"execution error"| F2[FAILED]
        A3[PROOF_GENERATING] -->|"proof error/timeout"| F3[FAILED]
        A4[SUBMITTING] -->|"proof rejected"| F4[FAILED]
    end
    
    subgraph "Ancestor-Caused Rollbacks"
        B1[EXECUTING] -->|"ancestor failed"| R1[ROLLED_BACK]
        B2[EXECUTED] -->|"ancestor failed"| R2[ROLLED_BACK]
        B3[PROOF_GENERATING] -->|"ancestor failed"| R3[ROLLED_BACK]
        B4[PROOF_GENERATED] -->|"ancestor failed"| R4[ROLLED_BACK]
        B5[AWAITING_ANCESTORS] -->|"ancestor failed"| R5[ROLLED_BACK]
    end
    
    style F1 fill:#f66
    style F2 fill:#f66
    style F3 fill:#f66
    style F4 fill:#f66
    style R1 fill:#fa6
    style R2 fill:#fa6
    style R3 fill:#fa6
    style R4 fill:#fa6
    style R5 fill:#fa6
```

## State Entry Actions

| State | Entry Actions |
|-------|---------------|
| `PENDING` | Initialize commitment record, record creation timestamp |
| `EXECUTING` | Lock bonded stake, emit `speculation.started` metric |
| `EXECUTED` | Record execution timestamp, store outputs |
| `PROOF_GENERATING` | Start proof job, set timeout timer |
| `PROOF_GENERATED` | Store proof, query ancestor statuses |
| `AWAITING_ANCESTORS` | Subscribe to ancestor status changes |
| `SUBMITTING` | Create and submit transaction |
| `CONFIRMED` | Release stake, emit `speculation.confirmed` metric |
| `FAILED` | Determine if root cause, slash or release stake |
| `ROLLED_BACK` | Release stake, emit `speculation.rolled_back` metric |

## Valid Transition Matrix

| From \ To | PENDING | EXECUTING | EXECUTED | PROOF_GEN | PROOF_READY | AWAIT | SUBMIT | CONFIRMED | FAILED | ROLLED_BACK |
|-----------|---------|-----------|----------|-----------|-------------|-------|--------|-----------|--------|-------------|
| PENDING | - | ✓ | - | - | - | - | - | - | ✓ | - |
| EXECUTING | - | - | ✓ | - | - | - | - | - | ✓ | ✓ |
| EXECUTED | - | - | - | ✓ | - | - | - | - | - | ✓ |
| PROOF_GEN | - | - | - | - | ✓ | - | - | - | ✓ | ✓ |
| PROOF_READY | - | - | - | - | - | ✓ | ✓ | - | - | ✓ |
| AWAIT | - | - | - | - | - | - | ✓ | - | - | ✓ |
| SUBMIT | - | - | - | - | - | - | - | ✓ | ✓ | - |
| CONFIRMED | - | - | - | - | - | - | - | - | - | - |
| FAILED | - | - | - | - | - | - | - | - | - | - |
| ROLLED_BACK | - | - | - | - | - | - | - | - | - | - |

## Invariants

1. **Terminal states are final:** `CONFIRMED`, `FAILED`, and `ROLLED_BACK` have no outgoing transitions
2. **Stake lifecycle:**
   - Bonded in `PENDING` → `EXECUTING`
   - Released in `CONFIRMED` or `ROLLED_BACK`
   - Slashed in `FAILED` (if root cause)
3. **Proof ordering (ADR-002):** Cannot transition from `PROOF_GENERATED` to `SUBMITTING` if any ancestor is not `CONFIRMED`
4. **Ancestor failure propagation:** Any non-terminal state can transition to `ROLLED_BACK` when an ancestor enters `FAILED`

## Implementation Notes

```typescript
class SpeculativeCommitment {
  // Valid transitions for each state
  private static VALID_TRANSITIONS: Record<CommitmentStatus, CommitmentStatus[]> = {
    [CommitmentStatus.PENDING]: [CommitmentStatus.EXECUTING, CommitmentStatus.FAILED],
    [CommitmentStatus.EXECUTING]: [CommitmentStatus.EXECUTED, CommitmentStatus.FAILED, CommitmentStatus.ROLLED_BACK],
    [CommitmentStatus.EXECUTED]: [CommitmentStatus.PROOF_GENERATING, CommitmentStatus.ROLLED_BACK],
    [CommitmentStatus.PROOF_GENERATING]: [CommitmentStatus.PROOF_GENERATED, CommitmentStatus.FAILED, CommitmentStatus.ROLLED_BACK],
    [CommitmentStatus.PROOF_GENERATED]: [CommitmentStatus.AWAITING_ANCESTORS, CommitmentStatus.SUBMITTING, CommitmentStatus.ROLLED_BACK],
    [CommitmentStatus.AWAITING_ANCESTORS]: [CommitmentStatus.SUBMITTING, CommitmentStatus.ROLLED_BACK],
    [CommitmentStatus.SUBMITTING]: [CommitmentStatus.CONFIRMED, CommitmentStatus.FAILED],
    [CommitmentStatus.CONFIRMED]: [],  // Terminal
    [CommitmentStatus.FAILED]: [],      // Terminal
    [CommitmentStatus.ROLLED_BACK]: [], // Terminal
  };
  
  transitionTo(newStatus: CommitmentStatus): void {
    if (!SpeculativeCommitment.VALID_TRANSITIONS[this.status].includes(newStatus)) {
      throw new InvalidStateTransitionError(this.status, newStatus);
    }
    this.status = newStatus;
  }
}
```
