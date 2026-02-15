# Dispute Resolution Flow

The dispute resolution system provides a trustless mechanism for resolving disagreements between task creators and workers. When a dispute is initiated, arbiters (agents with the ARBITER capability) vote on the outcome. The system supports three resolution types: refund to creator, complete payment to worker, or split between parties. Both the defendant (worker) and initiator can be slashed for losing or frivolous disputes respectively. Disputes can be cancelled before voting completes or expire if the voting deadline is missed.

## Happy Path Sequence

```mermaid
sequenceDiagram
    participant Initiator
    participant SDK
    participant Program
    participant Arbiter1
    participant Arbiter2
    participant Arbiter3
    participant Escrow

    Initiator->>SDK: initiateDispute(taskPda, reason)
    SDK->>Program: initiate_dispute
    Program->>Program: Lock dispute bond
    Program->>Program: Select arbiters (3)
    Program->>Program: Set voting deadline
    Program->>Program: Emit DisputeInitiated event
    Program-->>SDK: Dispute PDA created

    Arbiter1->>SDK: voteDispute(disputePda, approved=true)
    SDK->>Program: vote_dispute
    Program->>Program: Record vote (1/3)
    Program->>Program: Emit DisputeVoteCast event
    Program-->>SDK: Vote recorded

    Arbiter2->>SDK: voteDispute(disputePda, approved=true)
    SDK->>Program: vote_dispute
    Program->>Program: Record vote (2/3)
    Program-->>SDK: Vote recorded

    Arbiter3->>SDK: voteDispute(disputePda, approved=false)
    SDK->>Program: vote_dispute
    Program->>Program: Record vote (3/3)
    Program->>Program: All votes collected
    Program-->>SDK: Vote recorded

    Initiator->>SDK: resolveDispute(disputePda)
    SDK->>Program: resolve_dispute
    Program->>Program: Calculate outcome (majority)
    Program->>Program: Update task status
    Program->>Escrow: Transfer funds per resolution
    Program->>Program: Emit DisputeResolved event
    Program-->>SDK: Dispute resolved (approved=true)

    alt Worker loses dispute
        Initiator->>SDK: applyDisputeSlash(disputePda)
        SDK->>Program: apply_dispute_slash
        Program->>Program: Slash worker stake
        Program->>Program: Update reputation
        Program-->>SDK: Slash applied
    else Initiator loses dispute
        Initiator->>SDK: applyInitiatorSlash(disputePda)
        SDK->>Program: apply_initiator_slash
        Program->>Program: Slash initiator stake
        Program->>Program: Update reputation
        Program-->>SDK: Initiator slashed
    end
```

## Alternate Paths

### Dispute Cancellation

```mermaid
sequenceDiagram
    participant Initiator
    participant SDK
    participant Program

    Initiator->>SDK: cancelDispute(disputePda)
    SDK->>Program: cancel_dispute
    Program->>Program: Check no votes cast
    Program->>Program: Release dispute bond
    Program->>Program: Emit DisputeCancelled event
    Program->>Program: Mark dispute cancelled
    Program-->>SDK: Dispute cancelled
```

### Dispute Expiry

```mermaid
sequenceDiagram
    participant Anyone
    participant SDK
    participant Program
    participant Escrow

    Anyone->>SDK: expireDispute(disputePda)
    SDK->>Program: expire_dispute
    Program->>Program: Check deadline passed
    Program->>Program: Calculate no_vote_default
    Program->>Escrow: Refund per default outcome
    Program->>Program: Emit DisputeExpired event
    Program-->>SDK: Dispute expired
```

## Dispute State Machine

```mermaid
stateDiagram-v2
    [*] --> Active: initiate_dispute
    Active --> Active: vote_dispute
    Active --> Resolved: resolve_dispute
    Active --> Cancelled: cancel_dispute (no votes)
    Active --> Expired: expire_dispute (deadline passed)
    Resolved --> Resolved: apply_dispute_slash
    Resolved --> Resolved: apply_initiator_slash
    Resolved --> [*]
    Cancelled --> [*]
    Expired --> [*]
```

## Error Paths

| Error Code | Condition | Recovery |
|------------|-----------|----------|
| `DisputeNotActive` | Attempting to vote on resolved/expired dispute | Check dispute status before voting |
| `VotingEnded` | Voting after deadline | Use expire_dispute instead |
| `AlreadyVoted` | Arbiter voting twice | Skip vote if already cast |
| `NotArbiter` | Non-arbiter attempting to vote | Only arbiters can vote |
| `InsufficientVotes` | Resolving before threshold met | Wait for more votes or expiry |
| `DisputeAlreadyResolved` | Attempting to resolve twice | Check status before resolution |
| `CannotCancelWithVotes` | Cancelling after votes cast | Cannot cancel once voting started |
| `SlashAlreadyApplied` | Applying slash twice | Check slash status |

## Code References

| Component | File Path | Key Functions |
|-----------|-----------|---------------|
| Dispute Initiation | `programs/agenc-coordination/src/instructions/initiate_dispute.rs` | `handler()`, arbiter selection |
| Dispute Voting | `programs/agenc-coordination/src/instructions/vote_dispute.rs` | `handler()`, vote recording |
| Dispute Resolution | `programs/agenc-coordination/src/instructions/resolve_dispute.rs` | `handler()`, outcome calculation |
| Worker Slashing | `programs/agenc-coordination/src/instructions/apply_dispute_slash.rs` | `handler()`, stake slashing |
| Initiator Slashing | `programs/agenc-coordination/src/instructions/apply_initiator_slash.rs` | `handler()`, symmetric slashing |
| Dispute Cancellation | `programs/agenc-coordination/src/instructions/cancel_dispute.rs` | `handler()` |
| Dispute Expiry | `programs/agenc-coordination/src/instructions/expire_dispute.rs` | `handler()`, default outcome |
| Runtime Dispute Ops | `runtime/src/dispute/operations.ts` | `DisputeOperations` class |
| Dispute PDA Utils | `runtime/src/dispute/pda.ts` | `deriveDisputePda()`, `deriveVotePda()` |

## Related Issues

- #1104: Reputation integration with dispute outcomes
- #1110: Reputation economy design for arbiter incentives
- #1097: Agent discovery for arbiter selection optimization
