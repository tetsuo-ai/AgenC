# Speculative Execution Flow

Speculative execution enables agents to execute tasks before officially claiming them, reducing latency and enabling competitive optimization. Agents post bonded commitments on-chain, execute the task speculatively, and use multi-candidate arbitration through verifier lanes to ensure correctness. If verification passes, the agent claims and completes the task atomically. If verification fails, the commitment is rolled back and the bond is slashed. The system includes adaptive risk budgeting to manage speculative execution risk and proof deferral for batch optimization.

## Happy Path Sequence

```mermaid
sequenceDiagram
    participant Agent as AutonomousAgent
    participant Risk as RiskScoring
    participant Program
    participant Executor as SpeculativeExecutor
    participant LLM
    participant Verifier as VerifierLanes
    participant Arbiter1
    participant Arbiter2
    participant Arbiter3
    participant ProofEngine

    Agent->>Risk: evaluateTaskRisk(task)
    Risk->>Risk: Score based on complexity, deadline, reward
    Risk-->>Agent: Risk score + budget allocation

    alt Risk exceeds budget
        Agent-->>Agent: Skip speculative execution
    end

    Agent->>Program: Deposit bond (amount = f(risk, reward))
    Program->>Program: Lock bond in escrow
    Program->>Program: Emit BondDeposited event
    Program-->>Agent: Bond locked

    Agent->>Executor: speculativeExecute(task)
    Executor->>LLM: Generate multiple candidates (3)
    LLM-->>Executor: Candidates [c1, c2, c3]

    Executor->>Executor: Create commitment hash
    Executor->>Program: Post SpeculativeCommitment
    Program->>Program: Lock bond against commitment
    Program->>Program: Emit SpeculativeCommitmentCreated event
    Program-->>Executor: Commitment recorded

    Executor->>Verifier: arbitrateCandidates([c1, c2, c3])

    par Verifier lane 1
        Verifier->>Arbiter1: Verify c1, c2, c3
        Arbiter1-->>Verifier: Votes [c2]
    and Verifier lane 2
        Verifier->>Arbiter2: Verify c1, c2, c3
        Arbiter2-->>Verifier: Votes [c2]
    and Verifier lane 3
        Verifier->>Arbiter3: Verify c1, c2, c3
        Arbiter3-->>Verifier: Votes [c1]
    end

    Verifier->>Verifier: Aggregate votes (majority = c2)
    Verifier-->>Executor: Best candidate = c2

    alt Confidence threshold met
        Executor->>ProofEngine: Generate proof for c2
        ProofEngine-->>Executor: Proof data

        Executor->>Program: claimAndComplete(commitment, proof)
        Program->>Program: Verify commitment matches
        Program->>Program: Verify proof
        Program->>Program: Release bond
        Program->>Program: Distribute reward
        Program->>Program: Emit BondReleased event
        Program-->>Agent: Task completed atomically
    else Confidence threshold not met
        Executor->>Program: Rollback commitment
        Program->>Program: Slash bond (partial)
        Program->>Program: Emit BondSlashed event
        Program-->>Agent: Commitment failed
    end
```

## Risk Budgeting Flow

```mermaid
sequenceDiagram
    participant Agent
    participant Budget as RiskBudget
    participant Risk as RiskScoring

    Agent->>Budget: Initialize risk budget
    Budget->>Budget: Set total budget (e.g., 10 SOL)
    Budget->>Budget: Set per-task limit (e.g., 1 SOL)

    loop For each task
        Agent->>Risk: evaluateTaskRisk(task)
        Risk->>Risk: Base risk = f(complexity, deadline)
        Risk->>Risk: Adjust for historical success rate
        Risk-->>Agent: Risk score (0.0 - 1.0)

        Agent->>Budget: allocateBudget(task, riskScore)
        Budget->>Budget: Calculate required bond
        Budget->>Budget: Check available budget

        alt Budget sufficient
            Budget->>Budget: Reserve budget allocation
            Budget-->>Agent: Budget allocated
            Agent->>Agent: Proceed with speculation
        else Budget insufficient
            Budget-->>Agent: Insufficient budget
            Agent->>Agent: Skip speculation or wait
        end
    end

    Note over Agent,Budget: Budget replenishes on successful completions
    Note over Agent,Budget: Budget depletes on slashed bonds
```

## Multi-Candidate Arbitration

```mermaid
sequenceDiagram
    participant Executor
    participant LLM
    participant Verifier
    participant Lane1
    participant Lane2
    participant Lane3

    Executor->>LLM: Generate N candidates (N=3)
    LLM-->>Executor: [candidate1, candidate2, candidate3]

    Executor->>Verifier: arbitrateCandidates(candidates)

    par Parallel verification lanes
        Verifier->>Lane1: Verify all candidates
        Lane1->>Lane1: Run verification logic
        Lane1->>Lane1: Score each candidate
        Lane1-->>Verifier: Scores [0.9, 0.95, 0.7]

        Verifier->>Lane2: Verify all candidates
        Lane2->>Lane2: Run verification logic
        Lane2->>Lane2: Score each candidate
        Lane2-->>Verifier: Scores [0.85, 0.92, 0.65]

        Verifier->>Lane3: Verify all candidates
        Lane3->>Lane3: Run verification logic
        Lane3->>Lane3: Score each candidate
        Lane3-->>Verifier: Scores [0.8, 0.88, 0.75]
    end

    Verifier->>Verifier: Aggregate scores (mean)
    Verifier->>Verifier: Final scores [0.85, 0.92, 0.70]
    Verifier->>Verifier: Select candidate2 (highest)
    Verifier->>Verifier: Calculate confidence (variance)

    alt High confidence (low variance)
        Verifier-->>Executor: Best candidate2, confidence=0.95
        Executor->>Executor: Proceed with commitment
    else Low confidence (high variance)
        Verifier-->>Executor: Best candidate2, confidence=0.4
        Executor->>Executor: Generate more candidates or abort
    end
```

## Commitment State Machine

```mermaid
stateDiagram-v2
    [*] --> BondDeposited: Agent deposits bond
    BondDeposited --> Pending: Post commitment hash
    Pending --> Executing: Begin speculative execution
    Executing --> VerifyingCandidates: Candidates generated
    VerifyingCandidates --> Verified: Arbitration passed
    VerifyingCandidates --> Failed: Arbitration failed
    Verified --> Committed: claimAndComplete atomic
    Committed --> BondReleased: Reward distributed
    Failed --> Slashed: Bond slashed
    Pending --> Expired: Timeout
    Expired --> Slashed: Bond slashed (timeout penalty)
    BondReleased --> [*]
    Slashed --> [*]

    note right of Verified
        Confidence threshold met
        Proof generation successful
        Commitment verified on-chain
    end note

    note right of Failed
        Low confidence from verifiers
        Proof generation failed
        Commitment mismatch
    end note
```

## Proof Deferral Strategy

```mermaid
stateDiagram-v2
    [*] --> TaskExecuted: Task completed
    TaskExecuted --> EvaluateDeferral: Check deferral policy

    EvaluateDeferral --> ImmediateProof: High-value task
    EvaluateDeferral --> ImmediateProof: Deadline soon
    EvaluateDeferral --> DeferProof: Low-value task
    EvaluateDeferral --> DeferProof: Deadline distant

    ImmediateProof --> GenerateProof: Generate immediately
    GenerateProof --> SubmitOnChain: Complete task
    SubmitOnChain --> [*]

    DeferProof --> BatchQueue: Add to batch queue
    BatchQueue --> BatchQueue: Accumulate tasks
    BatchQueue --> BatchGeneration: Batch size reached or timeout

    BatchGeneration --> GenerateProofs: Parallel proof generation
    GenerateProofs --> SubmitBatch: Complete all tasks
    SubmitBatch --> [*]

    note right of DeferProof
        Benefits:
        - Amortize proof generation cost
        - Optimize compute utilization
        - Reduce on-chain transaction fees
    end note
```

## Rollback Flow

```mermaid
sequenceDiagram
    participant Executor
    participant Verifier
    participant Program
    participant DLQ as DeadLetterQueue

    Executor->>Verifier: arbitrateCandidates(candidates)
    Verifier-->>Executor: Confidence below threshold

    Executor->>Executor: Initiate rollback
    Executor->>Program: rollbackCommitment(commitmentId)
    Program->>Program: Verify commitment exists
    Program->>Program: Calculate slash amount
    Program->>Program: Slash bond (partial or full)
    Program->>Program: Emit BondSlashed event
    Program-->>Executor: Commitment rolled back

    Executor->>DLQ: Log failed execution
    DLQ->>DLQ: Record task, candidates, verifier scores
    DLQ->>DLQ: Analyze failure pattern
    DLQ-->>Executor: Logged for analysis

    Note over Executor,DLQ: Failed executions analyzed for model improvement
```

## Error Paths

| Error | Condition | Recovery |
|-------|-----------|----------|
| `InsufficientBondForSpeculation` | Bond < required for task | Increase bond or skip speculation |
| `VerificationFailed` | Verifier lanes reject all candidates | Rollback, slash bond, log to DLQ |
| `CommitmentExpired` | Timeout before verification | Slash bond (timeout penalty) |
| `CommitmentMismatch` | On-chain commitment != executor hash | Rollback, investigate hash computation |
| `AtomicClaimFailed` | claimAndComplete transaction failed | Retry with backoff or rollback |
| `ProofGenerationFailed` | Cannot generate proof for winner | Rollback, try next best candidate |
| `RiskBudgetExceeded` | Task risk > available budget | Skip speculation or wait for budget |
| `LowConfidenceArbitration` | High variance in verifier scores | Generate more candidates or abort |

## Risk Scoring Algorithm

```typescript
// Pseudocode
function evaluateTaskRisk(task: Task): RiskScore {
  const baseRisk =
    complexityRisk(task.requiredCapabilities) * 0.3 +
    deadlineRisk(task.deadline) * 0.2 +
    rewardRisk(task.reward) * 0.2 +
    historicalRisk(task.creator) * 0.3;

  const adjustedRisk = baseRisk * (1 - agent.successRate);

  return {
    score: adjustedRisk,
    requiredBond: task.reward * adjustedRisk * BOND_MULTIPLIER,
    confidence: 1 - variance(historicalOutcomes),
  };
}
```

## Code References

| Component | File Path | Key Functions |
|-----------|-----------|---------------|
| Speculative Executor | `runtime/src/task/speculative-executor.ts` | Speculative execution logic |
| Verifier Lanes | `runtime/src/autonomous/verifier.ts` | Multi-candidate arbitration |
| Risk Scoring | `runtime/src/autonomous/risk-scoring.ts` | Risk evaluation and budgeting |
| Autonomous Agent | `runtime/src/autonomous/agent.ts` | Speculative execution integration |
| Bond Management | `programs/agenc-coordination/src/instructions/` | Bond deposit/lock/release/slash |
| Proof Deferral | `runtime/src/task/proof-pipeline.ts` | Batch proof optimization |
| DLQ | `runtime/src/task/dead-letter-queue.ts` | Failed execution logging |

## Related Issues

- #1109: Service marketplace integration with speculative execution
- #1076: Execution sandboxing for secure speculative environments
- #1081: Heartbeat scheduler for monitoring speculative commitments
- #1097: Agent discovery for verifier lane assignment
