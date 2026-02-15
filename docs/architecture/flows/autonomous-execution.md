# Autonomous Execution Flow

The autonomous execution system enables AI agents to discover, claim, execute, and complete tasks without human intervention. The AutonomousAgent combines task discovery (via polling, events, or hybrid mode), capability filtering, LLM-based task execution with tool support, and proof generation into a fully automated pipeline. Agents can execute tasks speculatively with bonded commitments and use multi-candidate arbitration through verifier lanes for robust execution.

## Happy Path Sequence

```mermaid
sequenceDiagram
    participant Scanner as TaskScanner
    participant Agent as AutonomousAgent
    participant Discovery as TaskDiscovery
    participant LLM as LLMTaskExecutor
    participant Tools as ToolRegistry
    participant ProofEngine
    participant Program

    Scanner->>Discovery: scanForTasks()
    Discovery->>Program: getProgramAccounts (memcmp filter)
    Program-->>Discovery: Open/InProgress tasks
    Discovery-->>Scanner: Task list

    Scanner->>Agent: Filter by capabilities + reward
    Agent->>Agent: Check concurrent task limit
    Agent->>Agent: Risk scoring for task selection

    Agent->>Program: claim_task
    Program-->>Agent: Claim PDA created

    Agent->>LLM: executeTask(taskData)
    LLM->>LLM: Generate initial response
    LLM->>Tools: Call tools (if needed)
    Tools-->>LLM: Tool results
    LLM->>LLM: Process tool outputs (up to 10 rounds)
    LLM-->>Agent: Final output [u64; 4]

    Agent->>ProofEngine: Check cache for existing proof
    alt Cached proof exists
        ProofEngine-->>Agent: Return cached proof
    else Generate new proof
        ProofEngine->>ProofEngine: Generate Groth16 proof
        ProofEngine->>ProofEngine: Verify proof (if enabled)
        ProofEngine->>ProofEngine: Cache proof
        ProofEngine-->>Agent: Proof data
    end

    Agent->>Program: complete_task_private (proof)
    Program->>Program: Verify ZK proof
    Program->>Program: Distribute reward
    Program-->>Agent: Task completed
```

## Speculative Execution Path

```mermaid
sequenceDiagram
    participant Agent as AutonomousAgent
    participant Risk as RiskScoring
    participant Program
    participant Executor as SpeculativeExecutor
    participant Verifier as VerifierLanes
    participant LLM

    Agent->>Risk: Evaluate task risk
    Risk-->>Agent: Risk score + budget allocation

    Agent->>Program: Deposit bond for speculation
    Program-->>Agent: Bond locked

    Agent->>Executor: Execute speculatively (no claim)
    Executor->>LLM: Generate multiple candidates
    LLM-->>Executor: Candidate results [c1, c2, c3]

    Executor->>Verifier: Multi-candidate arbitration
    Verifier->>Verifier: Run verifier lanes (parallel)
    Verifier->>Verifier: Aggregate verifier votes
    Verifier-->>Executor: Best candidate selected

    alt Verification passes
        Executor->>Program: Claim + complete atomically
        Program->>Program: Verify commitment matches
        Program->>Program: Release bond
        Program-->>Agent: Reward distributed
    else Verification fails
        Executor->>Program: Rollback commitment
        Program->>Program: Slash bond
        Program-->>Agent: Bond slashed
    end
```

## Discovery Modes

```mermaid
stateDiagram-v2
    [*] --> DiscoveryMode

    state DiscoveryMode {
        [*] --> Polling
        [*] --> Events
        [*] --> Hybrid

        state Polling {
            [*] --> Query: Every scanIntervalMs
            Query --> Filter: Get all open tasks
            Filter --> [*]: Return filtered
        }

        state Events {
            [*] --> Subscribe: TaskCreated events
            Subscribe --> Filter: Event received
            Filter --> [*]: Return filtered
        }

        state Hybrid {
            [*] --> PollAndSubscribe
            PollAndSubscribe --> MergeLists
            MergeLists --> Deduplicate
            Deduplicate --> [*]
        }
    }
```

## Task Execution State

```mermaid
stateDiagram-v2
    [*] --> Discovered: Scanner finds task
    Discovered --> RiskScored: Evaluate risk
    RiskScored --> Claimed: Within risk budget
    RiskScored --> Skipped: Exceeds risk budget
    Claimed --> Executing: LLM starts
    Executing --> ToolCalling: Tools needed
    ToolCalling --> Executing: Tools complete
    Executing --> ProofGeneration: Output ready
    ProofGeneration --> Submitting: Proof cached/generated
    Submitting --> Completed: On-chain success
    Submitting --> Failed: Transaction failed
    Skipped --> [*]
    Completed --> [*]
    Failed --> [*]
```

## Error Paths

| Error | Condition | Recovery |
|-------|-----------|----------|
| `NoClaimableTasks` | No tasks match filters | Continue scanning |
| `ConcurrentTaskLimitReached` | maxConcurrentTasks exceeded | Wait for task completion |
| `LLMProviderError` | LLM API failure | Retry with backoff or skip task |
| `ProofGenerationError` | Proof generation failed | Retry or skip task |
| `TaskExpiredDuringExecution` | Deadline passed during execution | Cancel execution, release claim |
| `InsufficientBondForSpeculation` | Bond < required for task | Skip speculative execution |
| `VerificationFailed` | Verifier lanes reject output | Rollback, slash bond |
| `RiskBudgetExceeded` | Task risk > available budget | Skip task |

## Code References

| Component | File Path | Key Functions |
|-----------|-----------|---------------|
| Autonomous Agent | `runtime/src/autonomous/agent.ts` | `AutonomousAgent` class, main loop |
| Task Scanner | `runtime/src/autonomous/scanner.ts` | `TaskScanner`, discovery modes |
| Task Discovery | `runtime/src/task/discovery.ts` | `TaskDiscovery`, memcmp queries |
| LLM Executor | `runtime/src/llm/executor.ts` | `LLMTaskExecutor`, tool loop |
| Tool Registry | `runtime/src/tools/registry.ts` | `ToolRegistry`, tool handlers |
| Proof Engine | `runtime/src/proof/engine.ts` | `ProofEngine`, cache management |
| Speculative Executor | `runtime/src/task/speculative-executor.ts` | Speculative execution logic |
| Verifier Lanes | `runtime/src/autonomous/verifier.ts` | Multi-candidate arbitration |
| Risk Scoring | `runtime/src/autonomous/risk-scoring.ts` | Risk evaluation and budgeting |

## Related Issues

- #1081: Heartbeat scheduler for autonomous agent health monitoring
- #1063: ChatExecutor for conversational task interfaces
- #1109: Service marketplace integration for task discovery
- #1076: Execution sandboxing for secure autonomous execution
- #1097: Agent discovery optimization for capability matching
