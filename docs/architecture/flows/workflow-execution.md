# Workflow Execution Flow

Workflow execution orchestrates complex, multi-step goals by decomposing them into dependency-ordered tasks executed across multiple agents. The GoalCompiler uses an LLM to transform natural language goals into task DAGs. The DAGOrchestrator validates the workflow structure (rejecting cycles and enforcing single-parent constraints), performs topological sorting, and submits tasks in dependency order. The WorkflowOptimizer applies mutation-based optimization with canary rollout to improve future executions. Workflows support tree topology with AND/OR dependency types.

## Happy Path Sequence

```mermaid
sequenceDiagram
    participant User
    participant Compiler as GoalCompiler
    participant LLM
    participant Orchestrator as DAGOrchestrator
    participant Submitter as WorkflowSubmitter
    participant Program
    participant Monitor as EventMonitor
    participant Optimizer as WorkflowOptimizer

    User->>Compiler: compileGoal("Analyze market data")
    Compiler->>LLM: Generate workflow DAG
    LLM-->>Compiler: Task graph with dependencies

    Compiler->>Orchestrator: submitWorkflow(tasks)
    Orchestrator->>Orchestrator: validateWorkflow()
    Orchestrator->>Orchestrator: Cycle detection (DFS)
    Orchestrator->>Orchestrator: Single-parent check
    Orchestrator->>Orchestrator: topologicalSort()

    Orchestrator->>Submitter: Submit tasks in order

    loop For each task in sorted order
        Submitter->>Program: create_dependent_task
        Program->>Program: Validate parent completed (if AND)
        Program-->>Submitter: Task PDA created
        Submitter->>Monitor: Subscribe to TaskCompleted
    end

    Monitor->>Monitor: Wait for task completions
    Monitor-->>Orchestrator: All tasks completed

    Orchestrator->>Optimizer: Record workflow execution
    Optimizer->>Optimizer: Mutation-based optimization
    Optimizer->>Optimizer: Canary rollout (10% traffic)
    Optimizer-->>Orchestrator: Optimized workflow stored
```

## Workflow Validation

```mermaid
sequenceDiagram
    participant Orchestrator
    participant Validator

    Orchestrator->>Validator: validateWorkflow(tasks)

    Validator->>Validator: Build adjacency list
    Validator->>Validator: Check single parent per task

    alt Multi-parent detected
        Validator-->>Orchestrator: WorkflowValidationError
    end

    Validator->>Validator: DFS cycle detection

    alt Cycle detected
        Validator-->>Orchestrator: WorkflowValidationError
    end

    Validator->>Validator: Topological sort (Kahn's algorithm)

    alt Unresolvable dependencies
        Validator-->>Orchestrator: WorkflowValidationError
    end

    Validator-->>Orchestrator: Validation passed
```

## Dependency Type Handling

```mermaid
sequenceDiagram
    participant Parent as Parent Task
    participant Program
    participant Child as Child Task (AND)
    participant Child2 as Child Task (OR)

    Parent->>Program: complete_task
    Program->>Program: Mark parent completed

    Child->>Program: claim_task (AND dependency)
    Program->>Program: Check parent.status == Completed
    alt Parent not completed
        Program-->>Child: DependencyNotMet error
    else Parent completed
        Program-->>Child: Claim allowed
    end

    Child2->>Program: claim_task (OR dependency)
    Program->>Program: Check parent.status IN [InProgress, Completed]
    alt Parent not started
        Program-->>Child2: DependencyNotMet error
    else Parent started/completed
        Program-->>Child2: Claim allowed
    end
```

## Workflow State Machine

```mermaid
stateDiagram-v2
    [*] --> Pending: User submits goal
    Pending --> Compiling: GoalCompiler invoked
    Compiling --> Validating: DAG generated
    Validating --> Failed: Validation error (cycle/multi-parent)
    Validating --> Running: Validation passed
    Running --> Running: Task completion events
    Running --> Completed: All tasks completed
    Running --> Failed: Task failure (critical path)
    Running --> Cancelled: User cancellation
    Completed --> Optimizing: WorkflowOptimizer triggered
    Optimizing --> Completed: Optimization stored
    Completed --> [*]
    Failed --> [*]
    Cancelled --> [*]
```

## Task Submission State

```mermaid
stateDiagram-v2
    [*] --> Queued: In topological order
    Queued --> WaitingForDeps: Has dependencies
    Queued --> Submitting: No dependencies
    WaitingForDeps --> Submitting: Dependencies met
    Submitting --> Submitted: On-chain creation
    Submitting --> Retrying: Submission failed
    Retrying --> Submitting: Retry attempt
    Retrying --> Failed: Max retries exceeded
    Submitted --> [*]
    Failed --> [*]
```

## Error Paths

| Error | Condition | Recovery |
|-------|-----------|----------|
| `WorkflowValidationError` | Cycle detected in DAG | Remove circular dependencies |
| `MultiParentTaskError` | Task has >1 parent | Restructure to tree topology |
| `DependencyNotMet` | Claiming task before parent done | Wait for parent completion |
| `WorkflowSubmissionError` | On-chain submission failed | Retry with backoff |
| `TaskFailureOnCriticalPath` | Critical task failed | Cancel workflow or retry task |
| `WorkflowTimeout` | Workflow exceeds deadline | Cancel remaining tasks |
| `InsufficientFundsForWorkflow` | Cannot fund all tasks | Reduce task count or increase budget |

## Code References

| Component | File Path | Key Functions |
|-----------|-----------|---------------|
| DAG Orchestrator | `runtime/src/workflow/orchestrator.ts` | `DAGOrchestrator`, validation, sorting |
| Goal Compiler | `runtime/src/workflow/compiler.ts` | `GoalCompiler`, LLM-based decomposition |
| Workflow Submitter | `runtime/src/workflow/submitter.ts` | `WorkflowSubmitter`, dependency-aware submission |
| Workflow Optimizer | `runtime/src/workflow/optimizer.ts` | `WorkflowOptimizer`, mutation + canary rollout |
| Dependent Task | `programs/agenc-coordination/src/instructions/create_dependent_task.rs` | `handler()`, dependency validation |
| Workflow Types | `runtime/src/workflow/types.ts` | `WorkflowTask`, `DependencyType` |

## Workflow Optimization

The WorkflowOptimizer uses mutation operators to improve workflow efficiency:

| Mutation | Description |
|----------|-------------|
| Task Reordering | Swap independent tasks to optimize parallelism |
| Dependency Relaxation | Convert AND to OR where safe |
| Task Merging | Combine sequential tasks with same agent |
| Redundant Task Removal | Eliminate duplicate work |

Optimizations are rolled out via canary deployment (10% traffic) with automatic rollback if metrics degrade.

## Related Issues

- #1096: Sub-agent spawning for workflow task execution
- #1109: Service marketplace integration for workflow tasks
- #1081: Heartbeat scheduler for workflow health monitoring
- #1063: ChatExecutor for interactive workflow management
