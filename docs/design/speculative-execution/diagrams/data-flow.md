# Data Flow Diagram: Speculative Execution

> **Related Issues:** #261, #264, #266, #269, #271  
> **Last Updated:** 2026-01-28

## Overview

This document shows how data flows through the Speculative Execution system, from task discovery through confirmation or rollback.

## High-Level Data Flow

```mermaid
flowchart TB
    subgraph "Input"
        TP[(Task Pool)]
    end
    
    subgraph "Discovery"
        TD[Task Discovery]
    end
    
    subgraph "Analysis"
        DG[Dependency Graph]
        SD[Speculation Decision]
    end
    
    subgraph "Execution"
        CL[Commitment Ledger]
        EX[Executor]
    end
    
    subgraph "Proof"
        PDM[Proof Deferral Manager]
        ZK[ZK Prover]
    end
    
    subgraph "Confirmation"
        SOL[Solana RPC]
    end
    
    subgraph "Recovery"
        RC[Rollback Controller]
    end
    
    TP -->|"task events"| TD
    TD -->|"Task"| DG
    DG -->|"TaskNode + depth"| SD
    SD -->|"can speculate"| CL
    CL -->|"commitment"| EX
    EX -->|"outputs"| PDM
    PDM -->|"proof inputs"| ZK
    ZK -->|"proof"| PDM
    PDM -->|"proof tx"| SOL
    SOL -->|"confirmed"| CL
    SOL -->|"failed"| RC
    RC -->|"rollback"| CL
    RC -->|"cancel"| PDM
```

## Detailed Data Flow - Happy Path

```mermaid
flowchart LR
    subgraph "1. Discovery"
        A1[Task Event] --> A2[Parse Task]
        A2 --> A3{Has depends_on?}
        A3 -->|Yes| A4[Extract Parent ID]
        A3 -->|No| A5[Standalone Task]
    end
    
    subgraph "2. Graph Building"
        A4 --> B1[Create TaskNode]
        A5 --> B1
        B1 --> B2[Add to Graph]
        B2 --> B3[Create DependencyEdge]
        B3 --> B4[Calculate Depth]
    end
    
    subgraph "3. Speculation Decision"
        B4 --> C1{Can Speculate?}
        C1 -->|Check depth| C2[depth ≤ maxDepth?]
        C1 -->|Check ancestors| C3[ancestors not failed?]
        C1 -->|Check expiry| C4[claim not expiring?]
        C2 --> C5{All checks pass?}
        C3 --> C5
        C4 --> C5
        C5 -->|Yes| C6[Create Commitment]
        C5 -->|No| C7[Wait for Ancestors]
    end
    
    subgraph "4. Execution"
        C6 --> D1[Bond Stake]
        D1 --> D2[Fetch Inputs]
        D2 --> D3{Ancestor outputs<br/>available?}
        D3 -->|Yes, confirmed| D4[Use confirmed outputs]
        D3 -->|Yes, speculative| D5[Use speculative outputs]
        D4 --> D6[Execute Task]
        D5 --> D6
        D6 --> D7[Store Outputs]
    end
    
    subgraph "5. Proof Generation"
        D7 --> E1[Build ProofInputs]
        E1 --> E2[Queue Proof Job]
        E2 --> E3[ZK Prover Generates]
        E3 --> E4[Proof Ready]
    end
    
    subgraph "6. Proof Submission"
        E4 --> F1{Ancestors Confirmed?}
        F1 -->|No| F2[Defer Proof]
        F1 -->|Yes| F3[Build Transaction]
        F2 -->|ancestor confirms| F3
        F3 --> F4[Submit to Solana]
        F4 --> F5[Await Confirmation]
        F5 --> F6[Proof Confirmed!]
    end
    
    subgraph "7. Finalization"
        F6 --> G1[Update Commitment Status]
        G1 --> G2[Release Stake]
        G2 --> G3[Notify Descendants]
    end
```

## Data Flow - Rollback Path

```mermaid
flowchart TB
    subgraph "Trigger"
        T1[Proof Verification Failed]
        T2[Proof Generation Failed]
        T3[Proof Timeout]
        T4[Claim Expired]
    end
    
    subgraph "Identification"
        T1 --> I1[Identify Failed Task]
        T2 --> I1
        T3 --> I1
        T4 --> I1
        I1 --> I2[Query Dependency Graph]
        I2 --> I3[Get All Descendants]
        I3 --> I4[Order: Reverse Topological]
    end
    
    subgraph "Cascade Rollback"
        I4 --> R1[For each descendant<br/>leaves first]
        R1 --> R2[Cancel Proof Generation]
        R2 --> R3[Update Status → ROLLED_BACK]
        R3 --> R4[Release Bonded Stake]
        R4 --> R5[Record Wasted Compute]
        R5 --> R6{More descendants?}
        R6 -->|Yes| R1
        R6 -->|No| R7[Process Root Task]
    end
    
    subgraph "Root Handling"
        R7 --> H1[Update Status → FAILED]
        H1 --> H2[Calculate Slash Amount]
        H2 --> H3[Slash Bonded Stake]
        H3 --> H4[Distribute to Treasury 50%]
        H4 --> H5[Distribute to Victims 50%]
    end
    
    subgraph "Notification"
        H5 --> N1[Emit rollback.completed event]
        N1 --> N2[Update Metrics]
        N2 --> N3[Log Rollback Details]
    end
```

## Data Structures in Flow

### Task Discovery → Graph

```mermaid
flowchart LR
    subgraph "Input: Task"
        T[Task]
        T1[id: Pubkey]
        T2[dependsOn: Pubkey?]
        T3[claimant: Pubkey]
        T4[claimExpiry: Date]
        T5[inputHash: Buffer]
    end
    
    subgraph "Output: TaskNode"
        N[TaskNode]
        N1[taskId: Pubkey]
        N2[speculationDepth: number]
        N3[status: DISCOVERED]
        N4[claimExpiry: Date]
    end
    
    subgraph "Output: DependencyEdge"
        E[DependencyEdge]
        E1[from: child.id]
        E2[to: parent.id]
        E3[type: OUTPUT_INPUT]
    end
    
    T --> N
    T2 --> E
```

### Speculation Decision Data

```mermaid
flowchart TB
    subgraph "Input"
        I1[TaskNode]
        I2[Current Graph State]
        I3[Config]
    end
    
    subgraph "Checks"
        C1{depth ≤ maxDepth?}
        C2{bond affordable?}
        C3{claim expiry OK?}
        C4{no failed ancestors?}
        C5{no cycles?}
    end
    
    subgraph "Output: SpeculationDecision"
        O[SpeculationDecision]
        O1[canSpeculate: boolean]
        O2[reason?: RejectReason]
        O3[speculationDepth: number]
        O4[requiredBond: bigint]
        O5[ancestorChain: Pubkey[]]
    end
    
    I1 --> C1
    I2 --> C1
    I3 --> C1
    C1 --> C2 --> C3 --> C4 --> C5 --> O
```

### Execution Flow Data

```mermaid
flowchart LR
    subgraph "Input"
        I1[Task]
        I2[Ancestor Outputs<br/>confirmed or speculative]
    end
    
    subgraph "Execution"
        E1[Compute]
    end
    
    subgraph "Output: ExecutionResult"
        O[ExecutionResult]
        O1[taskId: Pubkey]
        O2[outputs: Buffer]
        O3[computeUnits: number]
        O4[executionTime: number]
        O5[isSpeculative: boolean]
    end
    
    I1 --> E1
    I2 --> E1
    E1 --> O
```

### Proof Flow Data

```mermaid
flowchart LR
    subgraph "Input: ProofInputs"
        I[ProofInputs]
        I1[taskId]
        I2[computeOutput]
        I3[inputHashes]
        I4[executionTrace]
    end
    
    subgraph "ZK Prover"
        ZK[Generate Proof]
    end
    
    subgraph "Output: Proof"
        O[Proof]
        O1[taskId]
        O2[proof: Buffer]
        O3[publicInputs: Buffer]
        O4[verificationKey: Pubkey]
    end
    
    I --> ZK --> O
```

### Rollback Flow Data

```mermaid
flowchart TB
    subgraph "Input"
        I1[Failed TaskId]
        I2[RollbackReason]
    end
    
    subgraph "Query"
        Q1[Descendants from Graph]
        Q2[Commitments from Ledger]
    end
    
    subgraph "Output: RollbackResult"
        O[RollbackResult]
        O1[success: boolean]
        O2[rootTaskId: Pubkey]
        O3["rolledBackTasks: RolledBackTask[]"]
        O4[slashedAmount: bigint]
        O5["errors: RollbackError[]"]
    end
    
    subgraph "Per-Task: RolledBackTask"
        R[RolledBackTask]
        R1[taskId]
        R2[previousStatus]
        R3[computeWasted]
        R4[bondReleased]
    end
    
    I1 --> Q1
    I1 --> Q2
    I2 --> O
    Q1 --> O3
    Q2 --> O3
    O3 --> R
```

## Data Persistence Points

```mermaid
flowchart TB
    subgraph "In-Memory"
        M1[DependencyGraph]
        M2[Active ProofJobs]
        M3[Pending Submissions]
    end
    
    subgraph "Local Storage"
        L1[(Commitment Ledger<br/>Phase 1)]
        L2[(Execution Outputs<br/>Cache)]
        L3[(Metrics Buffer)]
    end
    
    subgraph "On-Chain (Phase 2)"
        C1[SpeculativeCommitment<br/>Accounts]
        C2[Proof Records]
        C3[Stake Escrow]
    end
    
    M1 -->|"checkpoint"| L1
    M2 -->|"cache"| L2
    
    L1 -->|"sync"| C1
    M3 -->|"submit"| C2
    L1 -->|"bond/release"| C3
```

## Event Flow Timeline

```mermaid
gantt
    title Speculative Execution Event Timeline
    dateFormat X
    axisFormat %s
    
    section Task A
    Discovered           :a1, 0, 1
    Graph Updated        :a2, after a1, 1
    Commitment Created   :a3, after a2, 1
    Executing            :a4, after a3, 10
    Proof Generating     :a5, after a4, 60
    Proof Submitted      :a6, after a5, 5
    Confirmed            :a7, after a6, 1
    
    section Task B (speculative)
    Discovered           :b1, 5, 1
    Graph Updated        :b2, after b1, 1
    Speculation Decided  :b3, after b2, 1
    Commitment Created   :b4, after b3, 1
    Executing (speculative) :b5, after b4, 10
    Proof Generating     :b6, after b5, 60
    Awaiting Ancestor    :b7, after b6, 5
    Proof Submitted      :b8, after a7, 5
    Confirmed            :b9, after b8, 1
```

## Metrics Data Flow

```mermaid
flowchart LR
    subgraph "Components"
        STS[Scheduler]
        CL[Ledger]
        PDM[ProofMgr]
        RC[Rollback]
    end
    
    subgraph "Metrics Collector"
        MC[MetricsCollector]
    end
    
    subgraph "Output"
        PROM[Prometheus<br/>/metrics]
        GRAF[Grafana<br/>Dashboard]
    end
    
    STS -->|"speculation.*"| MC
    CL -->|"commitment.*"| MC
    PDM -->|"proof.*"| MC
    RC -->|"rollback.*"| MC
    
    MC --> PROM --> GRAF
```

**Key Metrics Collected:**
| Source | Metrics |
|--------|---------|
| Scheduler | `speculation.started`, `speculation.confirmed`, `speculation.depth` |
| Ledger | `commitment.created`, `stake.bonded`, `stake.released`, `stake.slashed` |
| ProofMgr | `proof.queued`, `proof.generated`, `proof.deferred`, `proof.submitted` |
| Rollback | `rollback.initiated`, `rollback.cascade_size`, `compute.wasted` |
