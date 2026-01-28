# Component Diagram: Speculative Execution System

> **Related Issues:** #261, #264, #266, #269, #271, #273  
> **Last Updated:** 2026-01-28

## Overview

This diagram shows the high-level component relationships in the Speculative Execution subsystem, including both runtime and external dependencies.

## C4 Context Diagram

```mermaid
C4Context
    title System Context - Speculative Execution
    
    Person(agent, "Agent Operator", "Runs AgenC runtime to execute AI tasks")
    
    System(agenc, "AgenC Runtime", "Executes tasks with speculative execution optimization")
    
    System_Ext(solana, "Solana Blockchain", "On-chain task registry, proofs, and stake")
    System_Ext(zkprover, "ZK Prover Service", "Generates zero-knowledge proofs")
    System_Ext(taskpool, "Task Pool", "Source of available tasks (on-chain/off-chain)")
    
    Rel(agent, agenc, "Operates", "CLI/API")
    Rel(agenc, solana, "Submits proofs, reads tasks", "RPC/WebSocket")
    Rel(agenc, zkprover, "Requests proofs", "gRPC/HTTP")
    Rel(agenc, taskpool, "Discovers tasks", "Subscription")
```

## C4 Container Diagram

```mermaid
C4Container
    title Container Diagram - AgenC Runtime with Speculation
    
    Person(operator, "Agent Operator")
    
    Container_Boundary(runtime, "AgenC Runtime") {
        Container(scheduler, "SpeculativeTaskScheduler", "TypeScript", "Orchestrates speculation decisions and lifecycle")
        Container(discovery, "TaskDiscovery", "TypeScript", "Discovers claimable tasks from pool")
        Container(executor, "TaskExecutor", "TypeScript", "Executes AI compute tasks")
        Container(depgraph, "DependencyGraph", "TypeScript", "Tracks task dependencies")
        Container(ledger, "CommitmentLedger", "TypeScript", "Records speculative commitments")
        Container(proofmgr, "ProofDeferralManager", "TypeScript", "Manages proof generation and deferral")
        Container(rollback, "RollbackController", "TypeScript", "Handles cascading rollbacks")
        Container(metrics, "MetricsCollector", "Prometheus", "Exports speculation metrics")
    }
    
    System_Ext(solana, "Solana RPC", "Blockchain")
    System_Ext(zkprover, "ZK Prover", "External Service")
    
    Rel(operator, scheduler, "Configures", "CLI")
    Rel(discovery, scheduler, "Notifies new tasks")
    Rel(scheduler, depgraph, "Queries/updates graph")
    Rel(scheduler, ledger, "Creates/updates commitments")
    Rel(scheduler, proofmgr, "Starts/cancels proofs")
    Rel(scheduler, rollback, "Initiates rollbacks")
    Rel(scheduler, executor, "Dispatches tasks")
    Rel(proofmgr, zkprover, "Generates proofs", "gRPC")
    Rel(proofmgr, solana, "Submits proofs", "RPC")
    Rel(ledger, solana, "Persists commitments", "RPC")
    Rel(scheduler, metrics, "Emits metrics")
```

## Component Relationships

```mermaid
graph TB
    subgraph "External Systems"
        SOL[Solana RPC]
        ZK[ZK Prover]
        POOL[Task Pool]
    end
    
    subgraph "Discovery Layer"
        TD[TaskDiscovery]
    end
    
    subgraph "Core Scheduler"
        STS[SpeculativeTaskScheduler]
    end
    
    subgraph "Graph & State"
        DG[DependencyGraph]
        CL[CommitmentLedger]
    end
    
    subgraph "Execution"
        EX[TaskExecutor]
        PDM[ProofDeferralManager]
    end
    
    subgraph "Recovery"
        RC[RollbackController]
    end
    
    subgraph "Observability"
        MET[Metrics]
        LOG[Structured Logs]
    end
    
    %% External connections
    POOL -->|"task events"| TD
    PDM -->|"proof requests"| ZK
    ZK -->|"proof results"| PDM
    PDM -->|"submit proof"| SOL
    CL -->|"persist commitment"| SOL
    SOL -->|"confirmation"| PDM
    
    %% Internal flows
    TD -->|"onTaskDiscovered"| STS
    STS -->|"addTask/addDependency"| DG
    STS -->|"createCommitment"| CL
    STS -->|"executeTask"| EX
    STS -->|"startProofGeneration"| PDM
    STS -->|"initiateRollback"| RC
    
    %% Cross-component queries
    RC -->|"getDescendants"| DG
    RC -->|"updateStatus"| CL
    PDM -->|"getUnconfirmedAncestors"| DG
    
    %% Observability
    STS -->|"emit"| MET
    CL -->|"emit"| MET
    PDM -->|"emit"| MET
    RC -->|"emit"| MET
    
    STS -->|"log"| LOG
    RC -->|"log"| LOG
    
    style STS fill:#e1f5fe
    style DG fill:#f3e5f5
    style CL fill:#f3e5f5
    style PDM fill:#e8f5e9
    style RC fill:#ffebee
```

## Component Interface Matrix

| Component | Provides | Consumes |
|-----------|----------|----------|
| **TaskDiscovery** | `onTaskDiscovered(task)` events | Task Pool subscriptions |
| **SpeculativeTaskScheduler** | Orchestration, speculation decisions | All internal components |
| **DependencyGraph** | Graph queries, topological sorts | Task metadata |
| **CommitmentLedger** | Commitment CRUD, stake management | Solana RPC (optional) |
| **ProofDeferralManager** | Proof lifecycle management | ZK Prover, DependencyGraph |
| **RollbackController** | Rollback execution | DependencyGraph, CommitmentLedger |
| **TaskExecutor** | Task execution results | Task specifications |

## Dependency Injection Structure

```mermaid
graph TD
    subgraph "Configuration"
        CFG[SpeculationConfig]
    end
    
    subgraph "Core Components"
        DG[DependencyGraph]
        CL[CommitmentLedger]
        PDM[ProofDeferralManager]
        RC[RollbackController]
    end
    
    subgraph "Orchestrator"
        STS[SpeculativeTaskScheduler]
    end
    
    subgraph "External Adapters"
        RPC[SolanaRpcAdapter]
        ZKA[ZKProverAdapter]
    end
    
    CFG --> STS
    CFG --> CL
    CFG --> PDM
    
    DG --> STS
    CL --> STS
    PDM --> STS
    RC --> STS
    
    DG --> RC
    CL --> RC
    DG --> PDM
    
    RPC --> CL
    RPC --> PDM
    ZKA --> PDM
```

## Component Lifecycle

```mermaid
sequenceDiagram
    participant Main as main()
    participant CFG as Config
    participant DG as DependencyGraph
    participant CL as CommitmentLedger
    participant PDM as ProofDeferralManager
    participant RC as RollbackController
    participant STS as SpeculativeTaskScheduler
    
    Main->>CFG: load()
    Main->>DG: new DependencyGraph()
    Main->>CL: new CommitmentLedger(config, rpcAdapter)
    Main->>PDM: new ProofDeferralManager(config, zkAdapter, dependencyGraph)
    Main->>RC: new RollbackController(dependencyGraph, commitmentLedger)
    Main->>STS: new SpeculativeTaskScheduler(config, dg, cl, pdm, rc)
    Main->>STS: start()
    
    Note over STS: Runtime active...
    
    Main->>STS: stop()
    STS->>PDM: cancelAllPendingProofs()
    STS->>CL: persistState()
```

## External System Interfaces

### Solana RPC Interface

```mermaid
graph LR
    subgraph "AgenC Runtime"
        CL[CommitmentLedger]
        PDM[ProofDeferralManager]
    end
    
    subgraph "Solana RPC"
        READ[Read Methods]
        WRITE[Write Methods]
        SUB[Subscriptions]
    end
    
    CL -->|"getAccountInfo"| READ
    CL -->|"sendTransaction"| WRITE
    PDM -->|"sendTransaction"| WRITE
    PDM -->|"confirmTransaction"| READ
    CL -->|"accountSubscribe"| SUB
```

**Required RPC Methods:**
- `getAccountInfo` - Read task and commitment accounts
- `sendTransaction` - Submit proofs, create commitments
- `confirmTransaction` - Wait for finality
- `accountSubscribe` - Watch for on-chain state changes

### ZK Prover Interface

```mermaid
graph LR
    subgraph "AgenC Runtime"
        PDM[ProofDeferralManager]
    end
    
    subgraph "ZK Prover Service"
        GEN[generateProof]
        EST[estimateTime]
        CAN[cancelGeneration]
        STAT[getStatus]
    end
    
    PDM -->|"ProofInputs"| GEN
    GEN -->|"Proof"| PDM
    PDM -->|"ProofInputs"| EST
    EST -->|"number"| PDM
    PDM -->|"jobId"| CAN
    PDM -->|"jobId"| STAT
```

**ZK Prover Methods:**
- `generateProof(inputs: ProofInputs): Promise<Proof>` - Generate ZK proof
- `estimateTime(inputs: ProofInputs): number` - Estimate generation time
- `cancelGeneration(jobId: string): void` - Cancel pending job
- `getStatus(jobId: string): ProofJobStatus` - Query job status

## Deployment Topology

```mermaid
graph TB
    subgraph "Agent Machine"
        subgraph "AgenC Process"
            STS[Speculative Scheduler]
            EX[Executor]
        end
        
        subgraph "Local Storage"
            DB[(State DB)]
            LOGS[(Log Files)]
        end
        
        STS --> DB
        STS --> LOGS
    end
    
    subgraph "External Infrastructure"
        subgraph "Blockchain"
            RPC1[Solana RPC 1]
            RPC2[Solana RPC 2]
        end
        
        subgraph "ZK Infrastructure"
            ZK1[ZK Prover Pool]
        end
    end
    
    STS -->|"primary"| RPC1
    STS -->|"failover"| RPC2
    STS -->|"proof requests"| ZK1
```

## Phase 1 vs Phase 2 Components

### Phase 1: Runtime-Only (ADR-004)

```mermaid
graph TB
    subgraph "Phase 1 - Runtime Only"
        STS[SpeculativeTaskScheduler]
        DG[DependencyGraph]
        CL[CommitmentLedger<br/>in-memory only]
        PDM[ProofDeferralManager]
        RC[RollbackController]
    end
    
    ZK[ZK Prover]
    SOL[Solana<br/>proofs only]
    
    PDM --> ZK
    PDM --> SOL
    
    style CL fill:#fff3e0
```

### Phase 2: On-Chain Commitments

```mermaid
graph TB
    subgraph "Phase 2 - On-Chain"
        STS[SpeculativeTaskScheduler]
        DG[DependencyGraph]
        CL[CommitmentLedger<br/>on-chain sync]
        PDM[ProofDeferralManager]
        RC[RollbackController]
        STAKE[Stake Manager]
    end
    
    ZK[ZK Prover]
    SOL[Solana<br/>proofs + commitments + stake]
    
    PDM --> ZK
    PDM --> SOL
    CL --> SOL
    STAKE --> SOL
    
    style CL fill:#c8e6c9
    style STAKE fill:#c8e6c9
```
