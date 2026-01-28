# AgenC Speculative Execution - Data Flow Diagrams

This document provides C4-style architecture diagrams and data flow visualizations for the AgenC Speculative Execution system.

## Table of Contents
1. [System Context (C4 Level 1)](#1-system-context-c4-level-1)
2. [Container Diagram (C4 Level 2)](#2-container-diagram-c4-level-2)
3. [Component Diagram (C4 Level 3)](#3-component-diagram-c4-level-3)
4. [Data Flow Diagrams](#4-data-flow-diagrams)
5. [Integration Points](#5-integration-points)

---

## 1. System Context (C4 Level 1)

The System Context diagram shows AgenC Runtime as the central system and its interactions with external actors.

```mermaid
flowchart TB
    subgraph External Actors
        TC[👤 Task Creators<br/>Submit tasks via SDK]
        AG[🤖 Agents<br/>Execute task logic]
        SN[🌐 Solana Network<br/>Blockchain settlement]
        MON[📊 Monitoring<br/>Dashboards & alerts]
    end

    subgraph AgenC Runtime
        CORE[🎯 AgenC Runtime<br/>Speculative Execution System<br/>───────────────<br/>• Schedules speculative tasks<br/>• Manages commitments & proofs<br/>• Handles rollbacks<br/>• Settles on-chain]
    end

    TC -->|"Submit tasks<br/>(TaskDefinition)"| CORE
    CORE -->|"Task results<br/>(TaskResult)"| TC
    
    AG -->|"Execute logic<br/>(Computation)"| CORE
    CORE -->|"Task assignments<br/>(TaskSpec)"| AG
    
    CORE -->|"Transactions<br/>(Commitments, Proofs)"| SN
    SN -->|"Confirmations<br/>(Finality events)"| CORE
    
    CORE -->|"Metrics & events<br/>(Telemetry)"| MON
    MON -->|"Config updates<br/>(Thresholds)"| CORE

    style CORE fill:#1168bd,stroke:#0b4884,color:#fff
    style TC fill:#08427b,stroke:#052e56,color:#fff
    style AG fill:#08427b,stroke:#052e56,color:#fff
    style SN fill:#999,stroke:#666,color:#fff
    style MON fill:#438dd5,stroke:#2e6295,color:#fff
```

### External Actor Descriptions

| Actor | Description | Data Exchanged |
|-------|-------------|----------------|
| **Task Creators** | Users/systems that submit tasks through the SDK | TaskDefinition → Runtime; TaskResult ← Runtime |
| **Agents** | Autonomous agents executing task logic | TaskSpec ← Runtime; Computation results → Runtime |
| **Solana Network** | On-chain settlement layer for commitments and proofs | Transactions → Chain; Confirmations ← Chain |
| **Monitoring** | Observability infrastructure (Grafana, alerting) | Telemetry → Monitoring; Config/thresholds ← Monitoring |

---

## 2. Container Diagram (C4 Level 2)

The Container diagram shows the major runtime containers and their data flows.

```mermaid
flowchart TB
    subgraph External
        TC[👤 Task Creators]
        AG[🤖 Agents]
        SN[🌐 Solana Network]
        MON[📊 Monitoring]
    end

    subgraph AgenC Runtime [AgenC Runtime Boundary]
        subgraph TaskExec [TaskExecutor Container]
            TE[⚙️ TaskExecutor<br/>───────────<br/>Orchestrates task<br/>lifecycle & execution]
        end

        subgraph SpecSched [SpeculativeScheduler Container]
            SS[📋 SpeculativeScheduler<br/>───────────<br/>Dependency analysis<br/>& speculative dispatch]
        end

        subgraph ProofPipe [ProofPipeline Container]
            PP[🔐 ProofPipeline<br/>───────────<br/>ZK proof generation<br/>& verification]
        end

        subgraph OnChain [OnChainSync Container]
            OCS[⛓️ OnChainSync<br/>───────────<br/>Blockchain transactions<br/>& finality tracking]
        end

        subgraph DataStores [Data Stores]
            DG[(📊 DependencyGraph<br/>Task relationships)]
            CL[(📒 CommitmentLedger<br/>Speculative state)]
        end
    end

    %% External to Containers
    TC -->|"TaskDefinition"| TE
    TE -->|"TaskResult"| TC
    AG -->|"Computation"| TE
    TE -->|"TaskSpec"| AG
    OCS -->|"Transactions"| SN
    SN -->|"Confirmations"| OCS
    TE -->|"Metrics"| MON
    SS -->|"Metrics"| MON
    PP -->|"Metrics"| MON
    OCS -->|"Metrics"| MON

    %% Container to Container flows
    TE <-->|"1. Schedule request<br/>TaskSpec + Dependencies"| SS
    SS -->|"2. Execution order<br/>ScheduledTask[]"| TE
    
    TE -->|"3. Speculative result<br/>TaskResult + Commitment"| PP
    PP -->|"4. Generated proof<br/>ZKProof"| OCS
    
    OCS -->|"5. Finality event<br/>ConfirmationStatus"| TE
    OCS -->|"6. Rollback trigger<br/>RollbackEvent"| SS

    %% Data Store connections
    SS <-->|"Read/Write<br/>Dependencies"| DG
    TE <-->|"Read/Write<br/>Commitments"| CL
    OCS <-->|"Read/Write<br/>Settlement status"| CL

    style TE fill:#438dd5,stroke:#2e6295,color:#fff
    style SS fill:#438dd5,stroke:#2e6295,color:#fff
    style PP fill:#438dd5,stroke:#2e6295,color:#fff
    style OCS fill:#438dd5,stroke:#2e6295,color:#fff
    style DG fill:#f5a623,stroke:#c68000,color:#000
    style CL fill:#f5a623,stroke:#c68000,color:#000
```

### Container Responsibilities

| Container | Responsibility | Key Data |
|-----------|----------------|----------|
| **TaskExecutor** | Orchestrates task lifecycle, manages agent interactions, tracks completion | TaskDefinition, TaskResult, TaskSpec |
| **SpeculativeScheduler** | Analyzes dependencies, determines execution order, enables parallel speculation | ScheduledTask, DependencyEdge |
| **ProofPipeline** | Generates ZK proofs for commitments, verifies proofs on confirmation | ZKProof, ProofRequest, ProofStatus |
| **OnChainSync** | Submits transactions, tracks finality, triggers rollbacks on failure | Transaction, ConfirmationStatus, RollbackEvent |

### Inter-Container Data Flows

```mermaid
flowchart LR
    subgraph Flow Numbers
        direction TB
        F1[1️⃣ Schedule Request]
        F2[2️⃣ Execution Order]
        F3[3️⃣ Speculative Result]
        F4[4️⃣ Generated Proof]
        F5[5️⃣ Finality Event]
        F6[6️⃣ Rollback Trigger]
    end

    subgraph Data Types
        direction TB
        D1["TaskSpec + deps"]
        D2["ScheduledTask[]"]
        D3["TaskResult + Commitment"]
        D4["ZKProof"]
        D5["ConfirmationStatus"]
        D6["RollbackEvent"]
    end

    F1 --- D1
    F2 --- D2
    F3 --- D3
    F4 --- D4
    F5 --- D5
    F6 --- D6
```

---

## 3. Component Diagram (C4 Level 3)

Detailed component breakdown showing classes and their relationships.

### 3.1 TaskExecutor Components

```mermaid
flowchart TB
    subgraph TaskExecutor Container
        subgraph Core Components
            TM[TaskManager<br/>───────────<br/>• createTask()<br/>• getTask()<br/>• updateStatus()]
            
            EO[ExecutionOrchestrator<br/>───────────<br/>• dispatch()<br/>• awaitResult()<br/>• handleTimeout()]
            
            RC[ResultCollector<br/>───────────<br/>• collectResult()<br/>• validateOutput()<br/>• emitCommitment()]
        end

        subgraph Speculation Bridge
            SB[SpeculativeBridge<br/>───────────<br/>• enterSpeculativeMode()<br/>• exitSpeculativeMode()<br/>• queryCommitment()]
        end

        subgraph Agent Interface
            AI[AgentInterface<br/>───────────<br/>• assignTask()<br/>• receiveComputation()<br/>• reportHealth()]
        end
    end

    %% Internal flows
    TM -->|"Task created"| EO
    EO -->|"Dispatch to agent"| AI
    AI -->|"Computation result"| RC
    RC -->|"Emit commitment"| SB
    SB -->|"Update task status"| TM

    %% External connections
    EXT_AG[🤖 Agents] <-->|"Task execution"| AI
    EXT_SS[SpeculativeScheduler] <-->|"Schedule coordination"| SB
    EXT_CL[(CommitmentLedger)] <-->|"Read/Write"| RC

    style TM fill:#85BBF0,stroke:#5D8AC2
    style EO fill:#85BBF0,stroke:#5D8AC2
    style RC fill:#85BBF0,stroke:#5D8AC2
    style SB fill:#85BBF0,stroke:#5D8AC2
    style AI fill:#85BBF0,stroke:#5D8AC2
```

### 3.2 SpeculativeScheduler Components

```mermaid
flowchart TB
    subgraph SpeculativeScheduler Container
        subgraph Scheduling Core
            DA[DependencyAnalyzer<br/>───────────<br/>• buildGraph()<br/>• findCriticalPath()<br/>• detectCycles()]
            
            PS[ParallelScheduler<br/>───────────<br/>• identifyParallel()<br/>• scheduleWave()<br/>• optimizeOrder()]
            
            SQ[SpeculationQueue<br/>───────────<br/>• enqueue()<br/>• dequeue()<br/>• prioritize()]
        end

        subgraph Rollback Management
            RD[RollbackDetector<br/>───────────<br/>• detectFailure()<br/>• identifyAffected()<br/>• triggerRollback()]
            
            GT[GraphTraverser<br/>───────────<br/>• findDependents()<br/>• walkGraph()<br/>• computeSubtree()]
        end

        subgraph State
            DGI[DependencyGraph Interface<br/>───────────<br/>• addEdge()<br/>• removeNode()<br/>• queryDependents()]
        end
    end

    %% Internal flows
    DA -->|"Graph built"| PS
    PS -->|"Scheduled tasks"| SQ
    SQ -->|"Next task"| EXT_TE
    
    RD -->|"Failure detected"| GT
    GT -->|"Affected set"| RD
    RD -->|"Abort signals"| SQ

    DA <-->|"Graph operations"| DGI
    GT <-->|"Graph queries"| DGI

    %% External connections
    EXT_TE[TaskExecutor] -->|"Schedule request"| DA
    EXT_OCS[OnChainSync] -->|"Rollback event"| RD
    EXT_DG[(DependencyGraph)] <-->|"Persist"| DGI

    style DA fill:#85BBF0,stroke:#5D8AC2
    style PS fill:#85BBF0,stroke:#5D8AC2
    style SQ fill:#85BBF0,stroke:#5D8AC2
    style RD fill:#85BBF0,stroke:#5D8AC2
    style GT fill:#85BBF0,stroke:#5D8AC2
    style DGI fill:#85BBF0,stroke:#5D8AC2
```

### 3.3 ProofPipeline Components

```mermaid
flowchart TB
    subgraph ProofPipeline Container
        subgraph Proof Generation
            PG[ProofGenerator<br/>───────────<br/>• generateProof()<br/>• batchProofs()<br/>• estimateCost()]
            
            WM[WitnessManager<br/>───────────<br/>• collectWitness()<br/>• serializeInputs()<br/>• validateWitness()]
            
            CP[CircuitProcessor<br/>───────────<br/>• compileCircuit()<br/>• executeCircuit()<br/>• cacheResult()]
        end

        subgraph Verification
            PV[ProofVerifier<br/>───────────<br/>• verifyProof()<br/>• checkValidity()<br/>• reportResult()]
        end

        subgraph Queue Management
            PQ[ProofQueue<br/>───────────<br/>• submitRequest()<br/>• trackProgress()<br/>• handleCallback()]
        end
    end

    %% Internal flows
    PQ -->|"Proof request"| WM
    WM -->|"Witness data"| CP
    CP -->|"Circuit output"| PG
    PG -->|"Generated proof"| PV
    PV -->|"Verified proof"| EXT_OCS

    %% External connections
    EXT_TE[TaskExecutor] -->|"TaskResult + Commitment"| PQ
    EXT_OCS[OnChainSync] <-->|"Submit proof"| PV

    style PG fill:#85BBF0,stroke:#5D8AC2
    style WM fill:#85BBF0,stroke:#5D8AC2
    style CP fill:#85BBF0,stroke:#5D8AC2
    style PV fill:#85BBF0,stroke:#5D8AC2
    style PQ fill:#85BBF0,stroke:#5D8AC2
```

### 3.4 OnChainSync Components

```mermaid
flowchart TB
    subgraph OnChainSync Container
        subgraph Transaction Management
            TB[TransactionBuilder<br/>───────────<br/>• buildCommitmentTx()<br/>• buildProofTx()<br/>• buildSlashTx()]
            
            TS[TransactionSubmitter<br/>───────────<br/>• submit()<br/>• retry()<br/>• handleError()]
            
            FT[FinalityTracker<br/>───────────<br/>• trackConfirmation()<br/>• detectFinality()<br/>• emitEvent()]
        end

        subgraph Economic Logic
            BM[BondManager<br/>───────────<br/>• escrowBond()<br/>• releaseBond()<br/>• calculateSlash()]
            
            SD[SlashDistributor<br/>───────────<br/>• distributeSlash()<br/>• rewardChallenger()<br/>• updateBalances()]
        end

        subgraph State Sync
            CSI[ChainStateInterface<br/>───────────<br/>• queryState()<br/>• subscribeEvents()<br/>• syncLocal()]
        end
    end

    %% Internal flows
    TB -->|"Built transaction"| TS
    TS -->|"Submitted tx"| FT
    FT -->|"Finality reached"| EXT_TE
    FT -->|"Failure detected"| BM
    BM -->|"Slash calculated"| SD
    SD -->|"Update chain"| TB

    CSI <-->|"Chain queries"| EXT_SN

    %% External connections
    EXT_PP[ProofPipeline] -->|"ZK Proof"| TB
    EXT_TE[TaskExecutor] <-->|"Finality events"| FT
    EXT_SS[SpeculativeScheduler] <-->|"Rollback trigger"| FT
    EXT_SN[🌐 Solana Network] <-->|"Transactions"| TS
    EXT_CL[(CommitmentLedger)] <-->|"Settlement status"| CSI

    style TB fill:#85BBF0,stroke:#5D8AC2
    style TS fill:#85BBF0,stroke:#5D8AC2
    style FT fill:#85BBF0,stroke:#5D8AC2
    style BM fill:#85BBF0,stroke:#5D8AC2
    style SD fill:#85BBF0,stroke:#5D8AC2
    style CSI fill:#85BBF0,stroke:#5D8AC2
```

### 3.5 Data Store Schemas

```mermaid
erDiagram
    DependencyGraph {
        string task_id PK
        string[] dependencies
        string[] dependents
        enum status
        timestamp created_at
        timestamp updated_at
    }

    CommitmentLedger {
        string commitment_id PK
        string task_id FK
        bytes32 commitment_hash
        enum state
        string proof_id FK
        timestamp committed_at
        timestamp confirmed_at
    }

    TaskRecord {
        string task_id PK
        string agent_id FK
        bytes task_spec
        bytes result
        enum execution_status
        timestamp scheduled_at
        timestamp completed_at
    }

    ProofRecord {
        string proof_id PK
        string commitment_id FK
        bytes proof_data
        enum verification_status
        string transaction_id
        timestamp generated_at
    }

    DependencyGraph ||--o{ TaskRecord : "tracks"
    TaskRecord ||--o| CommitmentLedger : "generates"
    CommitmentLedger ||--o| ProofRecord : "requires"
```

---

## 4. Data Flow Diagrams

### 4.1 Task Result Flow (Happy Path)

Execution → Commitment → Proof → Confirmation

```mermaid
sequenceDiagram
    participant TC as Task Creator
    participant TE as TaskExecutor
    participant SS as SpeculativeScheduler
    participant AG as Agent
    participant PP as ProofPipeline
    participant OCS as OnChainSync
    participant SN as Solana Network
    participant CL as CommitmentLedger

    TC->>TE: 1. Submit TaskDefinition
    TE->>SS: 2. Request scheduling
    SS->>SS: 3. Analyze dependencies
    SS-->>TE: 4. Return ScheduledTask[]
    
    TE->>AG: 5. Dispatch TaskSpec
    AG->>AG: 6. Execute computation
    AG-->>TE: 7. Return computation result
    
    TE->>CL: 8. Create speculative commitment
    Note over CL: State: SPECULATIVE
    
    TE->>PP: 9. Request proof generation
    PP->>PP: 10. Generate ZK proof
    PP-->>OCS: 11. Submit proof
    
    OCS->>SN: 12. Submit commitment tx
    SN-->>OCS: 13. Transaction confirmed
    
    OCS->>CL: 14. Update commitment state
    Note over CL: State: CONFIRMED
    
    OCS-->>TE: 15. Emit finality event
    TE-->>TC: 16. Return final TaskResult
```

### 4.2 Rollback Data Flow (Failure Path)

Failure Detection → Graph Traversal → Abort Signals → Cleanup

```mermaid
sequenceDiagram
    participant SN as Solana Network
    participant OCS as OnChainSync
    participant SS as SpeculativeScheduler
    participant DG as DependencyGraph
    participant TE as TaskExecutor
    participant CL as CommitmentLedger
    participant AG as Agent

    SN->>OCS: 1. Transaction failure/timeout
    OCS->>OCS: 2. Detect commitment failure
    
    OCS->>SS: 3. Emit RollbackEvent(task_id)
    
    SS->>DG: 4. Query dependents(task_id)
    DG-->>SS: 5. Return affected_tasks[]
    
    loop For each affected task
        SS->>SS: 6. Mark task for rollback
    end
    
    SS->>TE: 7. Send AbortSignal(affected_tasks)
    
    par Parallel Cleanup
        TE->>AG: 8a. Cancel in-flight tasks
        TE->>CL: 8b. Invalidate commitments
        Note over CL: State: ROLLED_BACK
    end
    
    TE->>TE: 9. Release resources
    TE->>SS: 10. Request reschedule
    
    SS->>SS: 11. Rebuild schedule
    Note over SS: Exclude failed dependency
    
    SS-->>TE: 12. New ScheduledTask[]
```

### 4.3 Economic Data Flow

Bond Escrow → Slash Calculation → Distribution

```mermaid
sequenceDiagram
    participant AG as Agent
    participant TE as TaskExecutor
    participant OCS as OnChainSync
    participant BM as BondManager
    participant SD as SlashDistributor
    participant SN as Solana Network
    participant CH as Challenger

    Note over AG,SN: === Bond Escrow (Task Start) ===
    
    AG->>OCS: 1. Register for task
    OCS->>BM: 2. Request bond escrow
    BM->>SN: 3. Lock bond tokens
    SN-->>BM: 4. Escrow confirmed
    BM-->>TE: 5. Agent bonded, ready
    
    Note over AG,SN: === Successful Completion ===
    
    TE->>OCS: 6. Task completed + proof
    OCS->>SN: 7. Verify on-chain
    SN-->>OCS: 8. Verification passed
    OCS->>BM: 9. Release bond
    BM->>SN: 10. Return bond + reward
    SN-->>AG: 11. Funds released
    
    Note over AG,SN: === Slash Flow (Failure) ===
    
    CH->>OCS: A. Submit challenge
    OCS->>OCS: B. Verify challenge valid
    OCS->>BM: C. Calculate slash amount
    
    BM->>BM: D. Compute slash
    Note over BM: slash = bond × severity_factor
    
    BM->>SD: E. Request distribution
    SD->>SN: F. Distribute slash
    
    par Distribution
        SN-->>CH: G1. Challenger reward (finder_fee%)
        SN-->>SN: G2. Protocol treasury (treasury%)
        SN-->>AG: G3. Remaining bond (if any)
    end
```

### 4.4 Complete System Data Flow

```mermaid
flowchart TB
    subgraph Input Layer
        TC[Task Creator]
        SDK[AgenC SDK]
    end

    subgraph Processing Layer
        TE[TaskExecutor]
        SS[SpeculativeScheduler]
        PP[ProofPipeline]
    end

    subgraph State Layer
        DG[(DependencyGraph)]
        CL[(CommitmentLedger)]
    end

    subgraph Settlement Layer
        OCS[OnChainSync]
        SN[Solana Network]
    end

    subgraph Execution Layer
        AG[Agents]
    end

    %% Happy path (green)
    TC -->|"1. TaskDef"| SDK
    SDK -->|"2. Submit"| TE
    TE -->|"3. Schedule"| SS
    SS -->|"4. Order"| TE
    TE -->|"5. Dispatch"| AG
    AG -->|"6. Result"| TE
    TE -->|"7. Commit"| CL
    TE -->|"8. Prove"| PP
    PP -->|"9. Proof"| OCS
    OCS -->|"10. Submit"| SN
    SN -->|"11. Confirm"| OCS
    OCS -->|"12. Finalize"| CL
    OCS -->|"13. Done"| TE
    TE -->|"14. Result"| TC

    %% Dependency tracking (orange)
    SS <-.->|"Dependencies"| DG

    %% Rollback path (red dashed)
    SN -.->|"Failure"| OCS
    OCS -.->|"Rollback"| SS
    SS -.->|"Abort"| TE
    TE -.->|"Cancel"| AG

    linkStyle 0,1,2,3,4,5,6,7,8,9,10,11,12,13 stroke:#2ecc71,stroke-width:2px
    linkStyle 14 stroke:#f39c12,stroke-width:2px
    linkStyle 15,16,17,18 stroke:#e74c3c,stroke-width:2px,stroke-dasharray:5,5
```

---

## 5. Integration Points

### 5.1 TaskExecutor Integration

Shows how speculation integrates with the existing TaskExecutor.

```mermaid
flowchart TB
    subgraph Existing TaskExecutor
        direction TB
        ET_CORE[Core TaskExecutor<br/>───────────<br/>• Task lifecycle<br/>• Agent management<br/>• Result handling]
    end

    subgraph Speculation Extension
        direction TB
        SPEC_BRIDGE[SpeculativeBridge<br/>───────────<br/>• Mode switching<br/>• Commitment interface]
        
        SPEC_HOOKS[Speculation Hooks<br/>───────────<br/>• onTaskStart<br/>• onTaskComplete<br/>• onRollback]
    end

    subgraph Integration Points
        IP1[🔌 Pre-execution hook<br/>Check speculation mode]
        IP2[🔌 Post-execution hook<br/>Create commitment]
        IP3[🔌 Failure hook<br/>Trigger rollback]
        IP4[🔌 Completion hook<br/>Finalize commitment]
    end

    ET_CORE --> IP1
    IP1 --> SPEC_BRIDGE
    ET_CORE --> IP2
    IP2 --> SPEC_HOOKS
    ET_CORE --> IP3
    IP3 --> SPEC_HOOKS
    ET_CORE --> IP4
    IP4 --> SPEC_BRIDGE

    SPEC_BRIDGE --> EXT_SS[SpeculativeScheduler]
    SPEC_HOOKS --> EXT_CL[(CommitmentLedger)]

    style ET_CORE fill:#3498db,stroke:#2980b9,color:#fff
    style SPEC_BRIDGE fill:#9b59b6,stroke:#8e44ad,color:#fff
    style SPEC_HOOKS fill:#9b59b6,stroke:#8e44ad,color:#fff
    style IP1 fill:#27ae60,stroke:#1e8449,color:#fff
    style IP2 fill:#27ae60,stroke:#1e8449,color:#fff
    style IP3 fill:#e74c3c,stroke:#c0392b,color:#fff
    style IP4 fill:#27ae60,stroke:#1e8449,color:#fff
```

### 5.2 On-Chain Integration

Shows how on-chain components integrate with the runtime.

```mermaid
flowchart LR
    subgraph AgenC Runtime
        OCS[OnChainSync]
        
        subgraph Solana Client
            RPC[RPC Client<br/>───────────<br/>• sendTransaction<br/>• getAccountInfo<br/>• subscribeSlot]
            
            WS[WebSocket Listener<br/>───────────<br/>• onAccountChange<br/>• onSlotUpdate<br/>• onSignature]
        end
    end

    subgraph Solana Network
        subgraph Programs
            COMMIT_PROG[Commitment Program<br/>───────────<br/>• create_commitment<br/>• finalize_commitment<br/>• rollback_commitment]
            
            BOND_PROG[Bond Program<br/>───────────<br/>• escrow_bond<br/>• release_bond<br/>• slash_bond]
            
            PROOF_PROG[Proof Verifier<br/>───────────<br/>• verify_proof<br/>• challenge_proof]
        end

        subgraph Accounts
            COMMIT_ACC[(Commitment<br/>Account)]
            BOND_ACC[(Bond Escrow<br/>Account)]
            PROOF_ACC[(Proof Registry<br/>Account)]
        end
    end

    OCS --> RPC
    OCS --> WS
    
    RPC -->|"Instructions"| COMMIT_PROG
    RPC -->|"Instructions"| BOND_PROG
    RPC -->|"Instructions"| PROOF_PROG
    
    COMMIT_PROG --> COMMIT_ACC
    BOND_PROG --> BOND_ACC
    PROOF_PROG --> PROOF_ACC
    
    WS -.->|"Subscribe"| COMMIT_ACC
    WS -.->|"Subscribe"| BOND_ACC
    WS -.->|"Subscribe"| PROOF_ACC

    style OCS fill:#438dd5,stroke:#2e6295,color:#fff
    style RPC fill:#85BBF0,stroke:#5D8AC2
    style WS fill:#85BBF0,stroke:#5D8AC2
    style COMMIT_PROG fill:#14F195,stroke:#0D9668,color:#000
    style BOND_PROG fill:#14F195,stroke:#0D9668,color:#000
    style PROOF_PROG fill:#14F195,stroke:#0D9668,color:#000
```

### 5.3 SDK Integration Points

```mermaid
flowchart TB
    subgraph SDK Layer
        subgraph Client SDK
            TC[TaskClient<br/>───────────<br/>• submit()<br/>• await()<br/>• cancel()]
            
            SC[SpeculationClient<br/>───────────<br/>• enableSpeculation()<br/>• setMaxDepth()<br/>• queryCommitment()]
            
            MC[MonitoringClient<br/>───────────<br/>• onProgress()<br/>• onRollback()<br/>• onComplete()]
        end

        subgraph Agent SDK
            AH[AgentHandler<br/>───────────<br/>• registerAgent()<br/>• handleTask()<br/>• reportResult()]
            
            BH[BondHandler<br/>───────────<br/>• stakeBond()<br/>• checkBond()<br/>• withdrawBond()]
        end
    end

    subgraph Runtime
        TE[TaskExecutor]
        SS[SpeculativeScheduler]
        OCS[OnChainSync]
    end

    TC -->|"gRPC/REST"| TE
    SC -->|"gRPC/REST"| SS
    MC -->|"WebSocket"| TE
    AH -->|"gRPC"| TE
    BH -->|"gRPC"| OCS

    style TC fill:#e74c3c,stroke:#c0392b,color:#fff
    style SC fill:#e74c3c,stroke:#c0392b,color:#fff
    style MC fill:#e74c3c,stroke:#c0392b,color:#fff
    style AH fill:#3498db,stroke:#2980b9,color:#fff
    style BH fill:#3498db,stroke:#2980b9,color:#fff
```

### 5.4 Integration Summary Matrix

| Integration Point | Source | Target | Protocol | Data |
|-------------------|--------|--------|----------|------|
| Task Submission | SDK.TaskClient | TaskExecutor | gRPC | TaskDefinition |
| Speculation Config | SDK.SpeculationClient | SpeculativeScheduler | gRPC | SpecConfig |
| Progress Events | TaskExecutor | SDK.MonitoringClient | WebSocket | ProgressEvent |
| Agent Registration | SDK.AgentHandler | TaskExecutor | gRPC | AgentRegistration |
| Bond Operations | SDK.BondHandler | OnChainSync | gRPC | BondOperation |
| Chain Transactions | OnChainSync | Solana RPC | JSON-RPC | Transaction |
| Chain Events | Solana WebSocket | OnChainSync | WebSocket | AccountUpdate |

---

## Appendix: Data Type Definitions

```typescript
// Core Types
interface TaskDefinition {
  taskId: string;
  agentRequirements: AgentSpec;
  inputData: bytes;
  timeout: Duration;
  dependencies: string[];  // task IDs
  speculationConfig?: SpecConfig;
}

interface TaskResult {
  taskId: string;
  outputData: bytes;
  executionTime: Duration;
  agentId: string;
  commitmentId?: string;
}

interface SpecConfig {
  maxSpeculativeDepth: number;
  bondAmount: Lamports;
  proofDeadline: Duration;
}

// Commitment Types
interface Commitment {
  commitmentId: string;
  taskId: string;
  hash: bytes32;
  state: CommitmentState;
  proofId?: string;
}

enum CommitmentState {
  SPECULATIVE = 0,
  PROVING = 1,
  SUBMITTED = 2,
  CONFIRMED = 3,
  ROLLED_BACK = 4,
}

// Event Types
interface RollbackEvent {
  sourceTaskId: string;
  reason: RollbackReason;
  affectedTasks: string[];
  timestamp: Timestamp;
}

interface FinalityEvent {
  commitmentId: string;
  transactionSignature: string;
  slot: number;
  timestamp: Timestamp;
}
```

---

*Last Updated: 2025-01-28*
*Document Version: 1.0*
