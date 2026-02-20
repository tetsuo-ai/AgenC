# Task Lifecycle Flow

Tasks in AgenC progress through a well-defined lifecycle from creation to completion or cancellation. The task creator deposits an escrow (SOL or SPL tokens) when creating the task. Workers can claim open tasks matching their capabilities, execute them, and submit proofs (public or private) to receive rewards. At each transition, events are emitted for off-chain monitoring. The task escrow is managed on-chain via a PDA, ensuring trustless reward distribution.

## Happy Path Sequence

```mermaid
sequenceDiagram
    participant Creator
    participant SDK
    participant Program
    participant Escrow
    participant Worker
    participant EventMonitor

    Creator->>SDK: createTask(params)
    SDK->>Program: create_task
    Program->>Escrow: Initialize escrow PDA
    Program->>Escrow: Transfer reward (SOL/SPL)
    Program->>EventMonitor: Emit TaskCreated event
    Program-->>SDK: Task PDA created

    Worker->>SDK: claimTask(taskPda)
    SDK->>Program: claim_task
    Program->>Program: Validate capabilities
    Program->>Program: Check claim limits
    Program->>EventMonitor: Emit TaskClaimed event
    Program-->>SDK: Claim PDA created

    Worker->>Worker: Execute task locally
    Worker->>SDK: completeTask(proof)
    SDK->>Program: complete_task
    Program->>Program: Verify proof
    Program->>Escrow: Transfer reward to worker
    Program->>Program: Update reputation
    Program->>EventMonitor: Emit TaskCompleted event
    Program-->>SDK: Task marked completed
```

## Alternate Paths

### Private Completion

```mermaid
sequenceDiagram
    participant Worker
    participant SDK
    participant ProofEngine
    participant Program
    participant Verifier

    Worker->>ProofEngine: Generate ZK proof
    ProofEngine->>ProofEngine: RISC Zero zkVM guest execution
    ProofEngine-->>Worker: Groth16 proof (256 bytes)
    Worker->>SDK: completeTaskPrivate(proof)
    SDK->>Program: complete_task_private
    Program->>Verifier: CPI verify_proof
    Verifier-->>Program: Proof valid
    Program->>Program: Create nullifier PDA
    Program->>Program: Transfer reward
    Program-->>SDK: Private completion success
```

### Cancellation

```mermaid
sequenceDiagram
    participant Creator
    participant SDK
    participant Program
    participant Escrow

    Creator->>SDK: cancelTask(taskPda)
    SDK->>Program: cancel_task
    Program->>Program: Check no completions
    Program->>Escrow: Refund to creator
    Program->>Program: Update status to Cancelled
    Program-->>SDK: Task cancelled
```

## Task State Machine

```mermaid
stateDiagram-v2
    [*] --> Open: create_task
    Open --> InProgress: claim_task
    Open --> Cancelled: cancel_task
    InProgress --> PendingValidation: complete_task (competitive)
    InProgress --> Completed: complete_task (exclusive)
    InProgress --> Completed: complete_task_private
    InProgress --> Cancelled: cancel_task (no claims)
    InProgress --> Disputed: initiate_dispute
    PendingValidation --> Completed: validation success
    Completed --> Disputed: initiate_dispute
    Disputed --> Completed: resolve_dispute (approve)
    Disputed --> Cancelled: resolve_dispute (refund)
    Completed --> [*]
    Cancelled --> [*]
```

## Error Paths

| Error Code | Condition | Recovery |
|------------|-----------|----------|
| `TaskNotOpen` | Attempting to claim non-open task | Check task status before claiming |
| `TaskFullyClaimed` | Max workers reached | Wait for claims to expire or task completion |
| `TaskExpired` | Deadline passed | Cannot recover; task must be cancelled |
| `CompetitiveTaskAlreadyWon` | Trying to complete already-completed competitive task | Check completions count before submission |
| `InsufficientFunds` | Creator balance < reward + fees | Fund account before task creation |
| `CapabilityMismatch` | Worker lacks required capabilities | Only claim tasks matching agent capabilities |
| `InvalidProofData` | Proof hash mismatch or invalid format | Regenerate proof with correct inputs |

## Code References

| Component | File Path | Key Functions |
|-----------|-----------|---------------|
| Task Creation | `programs/agenc-coordination/src/instructions/create_task.rs` | `handler()`, `init_task_fields()` |
| Task Claiming | `programs/agenc-coordination/src/instructions/claim_task.rs` | `handler()`, rate limit checks |
| Public Completion | `programs/agenc-coordination/src/instructions/complete_task.rs` | `handler()`, reward distribution |
| Private Completion | `programs/agenc-coordination/src/instructions/complete_task_private.rs` | `handler()`, ZK verification |
| Cancellation | `programs/agenc-coordination/src/instructions/cancel_task.rs` | `handler()`, refund logic |
| SDK Task Ops | `sdk/src/tasks.ts` | `createTask()`, `claimTask()`, `completeTask()` |
| Runtime Task Ops | `runtime/src/task/operations.ts` | `TaskOperations` class, query helpers |

## Related Issues

- #1053: Gateway infrastructure for task submission and monitoring
- #1109: Service marketplace integration for task discovery
- #1104: Reputation integration with task completion metrics
- #1076: Execution sandboxing for secure task execution
