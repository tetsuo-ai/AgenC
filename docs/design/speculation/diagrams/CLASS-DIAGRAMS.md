# AgenC Speculative Execution - UML Class Diagrams

Comprehensive class diagrams for the speculative execution subsystem, enabling deferred proof verification with rollback capability.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Core Runtime Classes](#2-core-runtime-classes)
3. [Data Types & Enums](#3-data-types--enums)
4. [Events & Callbacks](#4-events--callbacks)
5. [Full System Relationships](#5-full-system-relationships)

---

## 1. System Overview

High-level view of component relationships in the speculative execution system.

```mermaid
classDiagram
    direction TB
    
    class SpeculativeTaskScheduler {
        <<orchestrator>>
    }
    
    class DependencyGraph {
        <<graph engine>>
    }
    
    class ProofDeferralManager {
        <<proof lifecycle>>
    }
    
    class CommitmentLedger {
        <<on-chain storage>>
    }
    
    class RollbackController {
        <<failure recovery>>
    }
    
    SpeculativeTaskScheduler --> DependencyGraph : queries
    SpeculativeTaskScheduler --> ProofDeferralManager : manages proofs
    SpeculativeTaskScheduler --> CommitmentLedger : records commitments
    SpeculativeTaskScheduler --> RollbackController : triggers rollbacks
    
    DependencyGraph --> CommitmentLedger : reads dependencies
    ProofDeferralManager --> CommitmentLedger : updates status
    RollbackController --> DependencyGraph : traverses
    RollbackController --> CommitmentLedger : invalidates
```

---

## 2. Core Runtime Classes

### 2.1 DependencyGraph

Manages task dependency relationships for speculative execution ordering and rollback traversal.

```mermaid
classDiagram
    class DependencyGraph {
        -nodes: Map~TaskId, GraphNode~
        -edges: Map~TaskId, TaskDependency[]~
        -reverseEdges: Map~TaskId, TaskId[]~
        -topologicalOrder: TaskId[]
        -dirty: boolean
        -maxDepth: u8
        -cycleDetectionCache: Set~string~
        
        +new(config: GraphConfig) DependencyGraph
        +addNode(taskId: TaskId, metadata: NodeMetadata) Result~void~
        +removeNode(taskId: TaskId) Result~GraphNode~
        +addEdge(dependency: TaskDependency) Result~void~
        +removeEdge(from: TaskId, to: TaskId) Result~void~
        +getNode(taskId: TaskId) Option~GraphNode~
        +getDirectDependencies(taskId: TaskId) TaskId[]
        +getTransitiveDependencies(taskId: TaskId) TaskId[]
        +getDependents(taskId: TaskId) TaskId[]
        +getTransitiveDependents(taskId: TaskId) TaskId[]
        +getTopologicalOrder() TaskId[]
        +getExecutionOrder(tasks: TaskId[]) Result~TaskId[]~
        +detectCycle(from: TaskId, to: TaskId) boolean
        +hasCycle() boolean
        +getRollbackOrder(failedTask: TaskId) TaskId[]
        +getDepth(taskId: TaskId) u8
        +getCriticalPath() TaskId[]
        +getParallelizableGroups() TaskId[][]
        +prune(olderThan: Timestamp) u32
        +serialize() bytes
        +deserialize(data: bytes) DependencyGraph
        -rebuildTopologicalOrder() void
        -invalidateCache() void
        -dfs(taskId: TaskId, visited: Set, stack: Set) boolean
    }
    
    class GraphNode {
        +taskId: TaskId
        +status: NodeStatus
        +depth: u8
        +createdAt: Timestamp
        +executedAt: Option~Timestamp~
        +metadata: NodeMetadata
    }
    
    class NodeMetadata {
        +priority: u8
        +estimatedDuration: u64
        +resourceRequirements: ResourceSpec
        +labels: Map~string, string~
    }
    
    class GraphConfig {
        +maxNodes: u32
        +maxEdgesPerNode: u16
        +maxDepth: u8
        +enableCycleDetection: boolean
        +pruneAfterSeconds: u64
    }
    
    class NodeStatus {
        <<enumeration>>
        Pending
        Executing
        SpeculativelyComplete
        Verified
        RolledBack
        Failed
    }
    
    DependencyGraph "1" *-- "*" GraphNode : contains
    DependencyGraph "1" *-- "*" TaskDependency : manages
    GraphNode "1" *-- "1" NodeMetadata : has
    GraphNode "1" --> "1" NodeStatus : has state
    DependencyGraph "1" --> "1" GraphConfig : configured by
```

### 2.2 ProofDeferralManager

Manages the lifecycle of deferred proofs from submission through verification or timeout.

```mermaid
classDiagram
    class ProofDeferralManager {
        -deferredProofs: Map~ProofId, DeferredProof~
        -byTask: Map~TaskId, ProofId[]~
        -byStatus: Map~ProofStatus, Set~ProofId~~
        -config: DeferralConfig
        -verifierPool: VerifierPool
        -eventEmitter: EventEmitter~ProofEvent~
        -metrics: ProofMetrics
        
        +new(config: DeferralConfig) ProofDeferralManager
        +submitProof(taskId: TaskId, proof: ProofData, priority: Priority) Result~ProofId~
        +deferProof(proofId: ProofId, reason: DeferralReason) Result~void~
        +scheduleVerification(proofId: ProofId, deadline: Timestamp) Result~void~
        +verifyProof(proofId: ProofId) Result~VerificationResult~
        +batchVerify(proofIds: ProofId[]) Result~BatchVerificationResult~
        +cancelProof(proofId: ProofId, reason: CancellationReason) Result~void~
        +getProof(proofId: ProofId) Option~DeferredProof~
        +getProofsByTask(taskId: TaskId) DeferredProof[]
        +getProofsByStatus(status: ProofStatus) DeferredProof[]
        +getPendingProofs() DeferredProof[]
        +getExpiredProofs() DeferredProof[]
        +processExpiredProofs() Result~u32~
        +getVerificationQueue() ProofId[]
        +getQueuePosition(proofId: ProofId) Option~u32~
        +updatePriority(proofId: ProofId, priority: Priority) Result~void~
        +getMetrics() ProofMetrics
        +prune(olderThan: Timestamp) u32
        +onVerificationComplete(callback: VerificationCallback) void
        +onProofExpired(callback: ExpirationCallback) void
        -calculateDeadline(priority: Priority) Timestamp
        -validateProofData(proof: ProofData) Result~void~
        -emitEvent(event: ProofEvent) void
    }
    
    class DeferralConfig {
        +maxDeferralDuration: u64
        +defaultPriority: Priority
        +verificationTimeout: u64
        +maxRetries: u8
        +batchSize: u16
        +minVerificationDelay: u64
        +maxQueueDepth: u32
        +enableParallelVerification: boolean
    }
    
    class VerifierPool {
        -verifiers: Verifier[]
        -roundRobin: u32
        +verify(proof: ProofData) Result~boolean~
        +batchVerify(proofs: ProofData[]) Result~boolean[]~
        +getAvailableVerifiers() u32
    }
    
    class ProofMetrics {
        +totalSubmitted: u64
        +totalVerified: u64
        +totalFailed: u64
        +totalExpired: u64
        +avgVerificationTime: u64
        +currentQueueDepth: u32
        +peakQueueDepth: u32
    }
    
    ProofDeferralManager "1" *-- "*" DeferredProof : manages
    ProofDeferralManager "1" --> "1" DeferralConfig : configured by
    ProofDeferralManager "1" --> "1" VerifierPool : uses
    ProofDeferralManager "1" --> "1" ProofMetrics : tracks
```

### 2.3 CommitmentLedger

On-chain storage for speculative commitments with query and mutation operations.

```mermaid
classDiagram
    class CommitmentLedger {
        -commitments: Map~CommitmentId, SpeculativeCommitment~
        -byTask: Map~TaskId, CommitmentId[]~
        -byAgent: Map~AgentId, CommitmentId[]~
        -byStatus: Map~CommitmentStatus, Set~CommitmentId~~
        -merkleRoot: bytes32
        -sequence: u64
        -config: LedgerConfig
        
        +new(config: LedgerConfig) CommitmentLedger
        +recordCommitment(commitment: SpeculativeCommitment) Result~CommitmentId~
        +updateStatus(commitmentId: CommitmentId, status: CommitmentStatus) Result~void~
        +finalizeCommitment(commitmentId: CommitmentId, proofHash: bytes32) Result~void~
        +invalidateCommitment(commitmentId: CommitmentId, reason: InvalidationReason) Result~void~
        +batchInvalidate(commitmentIds: CommitmentId[]) Result~u32~
        +getCommitment(commitmentId: CommitmentId) Option~SpeculativeCommitment~
        +getCommitmentsByTask(taskId: TaskId) SpeculativeCommitment[]
        +getCommitmentsByAgent(agentId: AgentId) SpeculativeCommitment[]
        +getCommitmentsByStatus(status: CommitmentStatus) SpeculativeCommitment[]
        +getActiveCommitments() SpeculativeCommitment[]
        +getPendingCommitments() SpeculativeCommitment[]
        +getCommitmentHistory(taskId: TaskId) CommitmentHistoryEntry[]
        +queryCommitments(filter: CommitmentFilter) SpeculativeCommitment[]
        +getSequence() u64
        +getMerkleRoot() bytes32
        +getMerkleProof(commitmentId: CommitmentId) MerkleProof
        +verifyMerkleProof(commitmentId: CommitmentId, proof: MerkleProof) boolean
        +getStatistics() LedgerStatistics
        +checkpoint() CheckpointData
        +restore(checkpoint: CheckpointData) Result~void~
        +prune(olderThan: Timestamp) u32
        -updateMerkleRoot() void
        -validateCommitment(commitment: SpeculativeCommitment) Result~void~
        -emitLedgerEvent(event: LedgerEvent) void
    }
    
    class LedgerConfig {
        +maxCommitmentsPerTask: u16
        +maxCommitmentsPerAgent: u32
        +retentionPeriod: u64
        +enableMerkleProofs: boolean
        +checkpointInterval: u32
        +maxHistoryDepth: u16
    }
    
    class CommitmentFilter {
        +taskIds: Option~TaskId[]~
        +agentIds: Option~AgentId[]~
        +statuses: Option~CommitmentStatus[]~
        +createdAfter: Option~Timestamp~
        +createdBefore: Option~Timestamp~
        +limit: Option~u32~
        +offset: Option~u32~
    }
    
    class LedgerStatistics {
        +totalCommitments: u64
        +activeCommitments: u64
        +finalizedCommitments: u64
        +invalidatedCommitments: u64
        +avgCommitmentAge: u64
        +storageUsed: u64
    }
    
    class MerkleProof {
        +leaf: bytes32
        +siblings: bytes32[]
        +path: boolean[]
    }
    
    class CheckpointData {
        +sequence: u64
        +merkleRoot: bytes32
        +timestamp: Timestamp
        +commitmentCount: u64
    }
    
    CommitmentLedger "1" *-- "*" SpeculativeCommitment : stores
    CommitmentLedger "1" --> "1" LedgerConfig : configured by
    CommitmentLedger "1" --> "*" MerkleProof : generates
    CommitmentLedger "1" --> "1" LedgerStatistics : provides
```

### 2.4 RollbackController

Handles failure recovery by traversing dependency graph and aborting affected speculative executions.

```mermaid
classDiagram
    class RollbackController {
        -graph: DependencyGraph
        -ledger: CommitmentLedger
        -activeRollbacks: Map~RollbackId, RollbackSession~
        -config: RollbackConfig
        -eventEmitter: EventEmitter~RollbackEvent~
        -compensationHandlers: Map~string, CompensationHandler~
        
        +new(graph: DependencyGraph, ledger: CommitmentLedger, config: RollbackConfig) RollbackController
        +initiateRollback(failedTask: TaskId, reason: RollbackReason) Result~RollbackId~
        +executeRollback(rollbackId: RollbackId) Result~RollbackResult~
        +abortRollback(rollbackId: RollbackId) Result~void~
        +getRollbackStatus(rollbackId: RollbackId) Option~RollbackSession~
        +getActiveRollbacks() RollbackSession[]
        +calculateImpact(taskId: TaskId) RollbackImpact
        +getAffectedTasks(taskId: TaskId) TaskId[]
        +getAffectedCommitments(taskId: TaskId) CommitmentId[]
        +previewRollback(taskId: TaskId) RollbackPreview
        +registerCompensationHandler(taskType: string, handler: CompensationHandler) void
        +executeCompensation(taskId: TaskId, handler: CompensationHandler) Result~void~
        +getRollbackHistory(taskId: TaskId) RollbackHistoryEntry[]
        +getStatistics() RollbackStatistics
        +setMaxConcurrentRollbacks(max: u8) void
        +onRollbackComplete(callback: RollbackCallback) void
        +onCompensationRequired(callback: CompensationCallback) void
        -traverseDependents(taskId: TaskId, visited: Set) TaskId[]
        -invalidateCommitments(commitmentIds: CommitmentId[]) Result~u32~
        -updateNodeStatuses(taskIds: TaskId[], status: NodeStatus) void
        -emitEvent(event: RollbackEvent) void
        -recordRollback(result: RollbackResult) void
    }
    
    class RollbackSession {
        +rollbackId: RollbackId
        +triggeredBy: TaskId
        +reason: RollbackReason
        +status: RollbackSessionStatus
        +affectedTasks: TaskId[]
        +affectedCommitments: CommitmentId[]
        +startedAt: Timestamp
        +completedAt: Option~Timestamp~
        +progress: RollbackProgress
        +error: Option~RollbackError~
    }
    
    class RollbackConfig {
        +maxConcurrentRollbacks: u8
        +rollbackTimeout: u64
        +enableCompensation: boolean
        +compensationTimeout: u64
        +maxRetries: u8
        +parallelInvalidation: boolean
        +batchSize: u16
    }
    
    class RollbackImpact {
        +affectedTaskCount: u32
        +affectedCommitmentCount: u32
        +estimatedDuration: u64
        +cascadeDepth: u8
        +resourcesLocked: ResourceSummary
    }
    
    class RollbackPreview {
        +impact: RollbackImpact
        +taskList: TaskId[]
        +commitmentList: CommitmentId[]
        +compensationRequired: boolean
        +estimatedCost: u64
    }
    
    class RollbackProgress {
        +totalTasks: u32
        +processedTasks: u32
        +totalCommitments: u32
        +invalidatedCommitments: u32
        +compensationsExecuted: u32
        +percentComplete: u8
    }
    
    class RollbackSessionStatus {
        <<enumeration>>
        Pending
        InProgress
        CompensationPhase
        Completing
        Completed
        Aborted
        Failed
    }
    
    class RollbackStatistics {
        +totalRollbacks: u64
        +successfulRollbacks: u64
        +failedRollbacks: u64
        +avgDuration: u64
        +avgAffectedTasks: f64
        +avgCascadeDepth: f64
    }
    
    RollbackController "1" --> "1" DependencyGraph : uses
    RollbackController "1" --> "1" CommitmentLedger : invalidates
    RollbackController "1" *-- "*" RollbackSession : manages
    RollbackController "1" --> "1" RollbackConfig : configured by
    RollbackSession "1" --> "1" RollbackProgress : tracks
    RollbackSession "1" --> "1" RollbackSessionStatus : has state
```

### 2.5 SpeculativeTaskScheduler

Main orchestrator that coordinates speculative execution decisions and manages the overall flow.

```mermaid
classDiagram
    class SpeculativeTaskScheduler {
        -graph: DependencyGraph
        -proofManager: ProofDeferralManager
        -ledger: CommitmentLedger
        -rollbackController: RollbackController
        -pendingTasks: PriorityQueue~ScheduledTask~
        -executingTasks: Map~TaskId, ExecutionContext~
        -config: SchedulerConfig
        -strategy: SpeculationStrategy
        -riskAssessor: RiskAssessor
        -eventEmitter: EventEmitter~SchedulerEvent~
        -metrics: SchedulerMetrics
        
        +new(config: SchedulerConfig) SpeculativeTaskScheduler
        +initialize(graph: DependencyGraph, ledger: CommitmentLedger) Result~void~
        +scheduleTask(task: Task, dependencies: TaskId[]) Result~TaskId~
        +executeSpeculatively(taskId: TaskId) Result~ExecutionHandle~
        +shouldSpeculate(taskId: TaskId) SpeculationDecision
        +evaluateSpeculation(taskId: TaskId, context: EvaluationContext) SpeculationDecision
        +getExecutionOrder(taskIds: TaskId[]) TaskId[]
        +submitResult(taskId: TaskId, result: TaskResult) Result~CommitmentId~
        +confirmExecution(taskId: TaskId, proofHash: bytes32) Result~void~
        +handleProofFailure(taskId: TaskId, error: ProofError) Result~RollbackId~
        +cancelTask(taskId: TaskId) Result~void~
        +getTaskStatus(taskId: TaskId) Option~TaskExecutionStatus~
        +getPendingTasks() ScheduledTask[]
        +getExecutingTasks() ExecutionContext[]
        +getSchedulerState() SchedulerState
        +pause() void
        +resume() void
        +drain() Result~void~
        +setStrategy(strategy: SpeculationStrategy) void
        +getMetrics() SchedulerMetrics
        +onTaskComplete(callback: TaskCompleteCallback) void
        +onSpeculationDecision(callback: DecisionCallback) void
        -processQueue() void
        -selectNextTask() Option~ScheduledTask~
        -calculatePriority(task: Task) Priority
        -assessRisk(taskId: TaskId) RiskAssessment
        -emitEvent(event: SchedulerEvent) void
    }
    
    class SchedulerConfig {
        +maxConcurrentSpeculative: u16
        +maxSpeculationDepth: u8
        +defaultSpeculationTimeout: u64
        +riskThreshold: f64
        +enableAdaptiveStrategy: boolean
        +queueCapacity: u32
        +processingInterval: u64
        +enableMetrics: boolean
    }
    
    class ScheduledTask {
        +taskId: TaskId
        +task: Task
        +priority: Priority
        +scheduledAt: Timestamp
        +dependencies: TaskId[]
        +speculative: boolean
        +deadline: Option~Timestamp~
    }
    
    class ExecutionContext {
        +taskId: TaskId
        +startedAt: Timestamp
        +speculative: boolean
        +commitmentId: Option~CommitmentId~
        +proofId: Option~ProofId~
        +timeout: Timestamp
        +retryCount: u8
    }
    
    class SchedulerState {
        +status: SchedulerStatus
        +pendingCount: u32
        +executingCount: u32
        +speculativeCount: u32
        +totalProcessed: u64
        +lastProcessedAt: Option~Timestamp~
    }
    
    class SchedulerStatus {
        <<enumeration>>
        Running
        Paused
        Draining
        Stopped
    }
    
    class SchedulerMetrics {
        +tasksScheduled: u64
        +tasksExecuted: u64
        +speculativeExecutions: u64
        +speculativeSuccesses: u64
        +speculativeFailures: u64
        +avgExecutionTime: u64
        +avgQueueWait: u64
        +rollbacksTriggered: u64
        +speculationAccuracy: f64
    }
    
    SpeculativeTaskScheduler "1" --> "1" DependencyGraph : uses
    SpeculativeTaskScheduler "1" --> "1" ProofDeferralManager : uses
    SpeculativeTaskScheduler "1" --> "1" CommitmentLedger : uses
    SpeculativeTaskScheduler "1" --> "1" RollbackController : uses
    SpeculativeTaskScheduler "1" --> "1" SpeculationStrategy : applies
    SpeculativeTaskScheduler "1" --> "1" RiskAssessor : consults
    SpeculativeTaskScheduler "1" *-- "*" ScheduledTask : queues
    SpeculativeTaskScheduler "1" *-- "*" ExecutionContext : tracks
    SpeculativeTaskScheduler "1" --> "1" SchedulerConfig : configured by
    SpeculativeTaskScheduler "1" --> "1" SchedulerMetrics : collects
```

### 2.6 Supporting Classes (Strategy & Risk)

```mermaid
classDiagram
    class SpeculationStrategy {
        <<interface>>
        +shouldSpeculate(context: StrategyContext) boolean
        +calculatePriority(task: Task, graph: DependencyGraph) Priority
        +selectTasks(candidates: Task[], limit: u32) Task[]
        +adjustParameters(metrics: SchedulerMetrics) void
    }
    
    class AggressiveStrategy {
        -maxSpeculationDepth: u8
        -minConfidence: f64
        +shouldSpeculate(context: StrategyContext) boolean
        +calculatePriority(task: Task, graph: DependencyGraph) Priority
        +selectTasks(candidates: Task[], limit: u32) Task[]
        +adjustParameters(metrics: SchedulerMetrics) void
    }
    
    class ConservativeStrategy {
        -requireAllDepsVerified: boolean
        -maxPendingProofs: u8
        +shouldSpeculate(context: StrategyContext) boolean
        +calculatePriority(task: Task, graph: DependencyGraph) Priority
        +selectTasks(candidates: Task[], limit: u32) Task[]
        +adjustParameters(metrics: SchedulerMetrics) void
    }
    
    class AdaptiveStrategy {
        -currentMode: StrategyMode
        -windowSize: u32
        -successHistory: CircularBuffer~boolean~
        +shouldSpeculate(context: StrategyContext) boolean
        +calculatePriority(task: Task, graph: DependencyGraph) Priority
        +selectTasks(candidates: Task[], limit: u32) Task[]
        +adjustParameters(metrics: SchedulerMetrics) void
        -evaluatePerformance() StrategyMode
    }
    
    class StrategyContext {
        +task: Task
        +graph: DependencyGraph
        +pendingProofs: u32
        +speculativeDepth: u8
        +recentFailureRate: f64
        +resourceUtilization: f64
    }
    
    class StrategyMode {
        <<enumeration>>
        Aggressive
        Balanced
        Conservative
    }
    
    class RiskAssessor {
        -weights: RiskWeights
        -history: RiskHistory
        +assessRisk(taskId: TaskId, context: RiskContext) RiskAssessment
        +calculateConfidence(taskId: TaskId) f64
        +getProbabilityOfFailure(taskId: TaskId) f64
        +getRiskFactors(taskId: TaskId) RiskFactor[]
        +updateWeights(feedback: RiskFeedback) void
    }
    
    class RiskAssessment {
        +score: f64
        +level: RiskLevel
        +factors: RiskFactor[]
        +recommendation: RiskRecommendation
        +confidence: f64
    }
    
    class RiskLevel {
        <<enumeration>>
        Negligible
        Low
        Medium
        High
        Critical
    }
    
    class RiskFactor {
        +name: string
        +weight: f64
        +value: f64
        +contribution: f64
    }
    
    SpeculationStrategy <|.. AggressiveStrategy : implements
    SpeculationStrategy <|.. ConservativeStrategy : implements
    SpeculationStrategy <|.. AdaptiveStrategy : implements
    AdaptiveStrategy --> StrategyMode : uses
    RiskAssessor --> RiskAssessment : produces
    RiskAssessment --> RiskLevel : has
    RiskAssessment *-- RiskFactor : contains
```

---

## 3. Data Types & Enums

### 3.1 Core Data Structures

```mermaid
classDiagram
    class SpeculativeCommitment {
        +commitmentId: CommitmentId
        +taskId: TaskId
        +agentId: AgentId
        +status: CommitmentStatus
        +resultHash: bytes32
        +proofId: Option~ProofId~
        +speculativeDepth: u8
        +parentCommitments: CommitmentId[]
        +createdAt: Timestamp
        +expiresAt: Timestamp
        +finalizedAt: Option~Timestamp~
        +slot: u64
        +bump: u8
    }
    
    class DeferredProof {
        +proofId: ProofId
        +taskId: TaskId
        +agentId: AgentId
        +status: ProofStatus
        +privatePayload: Risc0PrivatePayload
        +priority: Priority
        +submittedAt: Timestamp
        +deferredUntil: Option~Timestamp~
        +verificationDeadline: Timestamp
        +retryCount: u8
        +lastError: Option~ProofError~
        +verifiedAt: Option~Timestamp~
        +verificationType: VerificationType
    }
    
    class TaskDependency {
        +from: TaskId
        +to: TaskId
        +dependencyType: DependencyType
        +required: boolean
        +createdAt: Timestamp
        +metadata: DependencyMetadata
    }
    
    class RollbackResult {
        +rollbackId: RollbackId
        +triggeredBy: TaskId
        +reason: RollbackReason
        +success: boolean
        +tasksRolledBack: TaskId[]
        +commitmentsInvalidated: CommitmentId[]
        +compensationsExecuted: u32
        +duration: u64
        +error: Option~RollbackError~
        +timestamp: Timestamp
    }
    
    class SpeculationDecision {
        +taskId: TaskId
        +shouldSpeculate: boolean
        +confidence: f64
        +riskAssessment: RiskAssessment
        +reasons: DecisionReason[]
        +suggestedDeadline: Option~Timestamp~
        +alternativeStrategy: Option~string~
        +decidedAt: Timestamp
    }
    
    class ProofData {
        +proofType: ProofType
        +circuitId: bytes32
        +publicInputs: Field[]
        +proofBytes: bytes
        +verifyingKeyHash: bytes32
    }
    
    class DependencyMetadata {
        +label: Option~string~
        +weight: f64
        +timeout: Option~u64~
    }
    
    SpeculativeCommitment --> CommitmentStatus : has
    DeferredProof --> ProofStatus : has
    DeferredProof --> ProofData : contains
    TaskDependency --> DependencyType : has
    TaskDependency --> DependencyMetadata : has
    RollbackResult --> RollbackReason : has
    SpeculationDecision --> RiskAssessment : includes
```

### 3.2 All Enumerations

```mermaid
classDiagram
    class CommitmentStatus {
        <<enumeration>>
        Pending
        Active
        AwaitingProof
        Verified
        Finalized
        Invalidated
        Expired
        RolledBack
    }
    
    class ProofStatus {
        <<enumeration>>
        Submitted
        Queued
        Deferred
        Verifying
        Verified
        Failed
        Expired
        Cancelled
    }
    
    class RollbackReason {
        <<enumeration>>
        ProofVerificationFailed
        ProofTimeout
        DependencyFailed
        ManualCancellation
        ResourceExhausted
        CircuitError
        InvalidState
        Cascading
        PolicyViolation
    }
    
    class DependencyType {
        <<enumeration>>
        DataFlow
        Temporal
        Resource
        Causal
        Conditional
    }
    
    class Priority {
        <<enumeration>>
        Critical
        High
        Normal
        Low
        Background
    }
    
    class VerificationType {
        <<enumeration>>
        Groth16
        Plonk
        Stark
        Fflonk
        Custom
    }
    
    class ProofType {
        <<enumeration>>
        TaskCompletion
        StateTransition
        Aggregated
        Recursive
        Custom
    }
    
    class InvalidationReason {
        <<enumeration>>
        ProofFailed
        DependencyInvalidated
        Timeout
        ManualInvalidation
        DoubleSpend
        StateConflict
    }
    
    class CancellationReason {
        <<enumeration>>
        UserRequested
        Timeout
        DependencyFailed
        ResourceUnavailable
        PolicyViolation
    }
    
    class DeferralReason {
        <<enumeration>>
        QueueFull
        ResourceConstrained
        LowPriority
        BatchPending
        ManualDefer
    }
    
    class DecisionReason {
        <<enumeration>>
        DependenciesVerified
        HighConfidence
        LowRisk
        ResourceAvailable
        DeadlinePressure
        DependenciesPending
        HighRisk
        ResourceConstrained
        HistoricalFailures
        PolicyRestriction
    }
```

### 3.3 Identity & Reference Types

```mermaid
classDiagram
    class TaskId {
        +bytes: [u8; 32]
        +new(bytes: [u8; 32]) TaskId
        +fromString(s: string) Result~TaskId~
        +toBase58() string
        +toBytes() [u8; 32]
    }
    
    class CommitmentId {
        +bytes: [u8; 32]
        +new(bytes: [u8; 32]) CommitmentId
        +derive(taskId: TaskId, agent: AgentId, nonce: u64) CommitmentId
        +toBase58() string
    }
    
    class ProofId {
        +bytes: [u8; 32]
        +new(bytes: [u8; 32]) ProofId
        +derive(taskId: TaskId, timestamp: Timestamp) ProofId
        +toBase58() string
    }
    
    class AgentId {
        +pubkey: Pubkey
        +new(pubkey: Pubkey) AgentId
        +fromBase58(s: string) Result~AgentId~
        +toBase58() string
    }
    
    class RollbackId {
        +bytes: [u8; 32]
        +new(bytes: [u8; 32]) RollbackId
        +generate() RollbackId
        +toBase58() string
    }
    
    class Timestamp {
        +unixSeconds: i64
        +now() Timestamp
        +fromUnix(secs: i64) Timestamp
        +add(duration: u64) Timestamp
        +sub(duration: u64) Timestamp
        +isExpired() boolean
        +durationUntil() u64
    }
    
    class Field {
        +bytes: [u8; 32]
        +fromBigInt(n: BigInt) Field
        +toBigInt() BigInt
        +isZero() boolean
    }
```

---

## 4. Events & Callbacks

### 4.1 Event Interfaces

```mermaid
classDiagram
    class SchedulerEvent {
        <<interface>>
        +eventType: SchedulerEventType
        +timestamp: Timestamp
        +taskId: Option~TaskId~
    }
    
    class TaskScheduledEvent {
        +eventType: SchedulerEventType
        +timestamp: Timestamp
        +taskId: TaskId
        +priority: Priority
        +speculative: boolean
        +dependencies: TaskId[]
    }
    
    class TaskExecutionStartedEvent {
        +eventType: SchedulerEventType
        +timestamp: Timestamp
        +taskId: TaskId
        +speculative: boolean
        +executionContext: ExecutionContext
    }
    
    class TaskCompletedEvent {
        +eventType: SchedulerEventType
        +timestamp: Timestamp
        +taskId: TaskId
        +commitmentId: CommitmentId
        +duration: u64
        +speculative: boolean
    }
    
    class SpeculationDecisionEvent {
        +eventType: SchedulerEventType
        +timestamp: Timestamp
        +taskId: TaskId
        +decision: SpeculationDecision
    }
    
    class SchedulerEventType {
        <<enumeration>>
        TaskScheduled
        TaskExecutionStarted
        TaskCompleted
        TaskFailed
        TaskCancelled
        SpeculationDecision
        QueueDrained
        SchedulerPaused
        SchedulerResumed
    }
    
    SchedulerEvent <|.. TaskScheduledEvent
    SchedulerEvent <|.. TaskExecutionStartedEvent
    SchedulerEvent <|.. TaskCompletedEvent
    SchedulerEvent <|.. SpeculationDecisionEvent
```

### 4.2 Proof Events

```mermaid
classDiagram
    class ProofEvent {
        <<interface>>
        +eventType: ProofEventType
        +timestamp: Timestamp
        +proofId: ProofId
    }
    
    class ProofSubmittedEvent {
        +eventType: ProofEventType
        +timestamp: Timestamp
        +proofId: ProofId
        +taskId: TaskId
        +priority: Priority
        +queuePosition: u32
    }
    
    class ProofDeferredEvent {
        +eventType: ProofEventType
        +timestamp: Timestamp
        +proofId: ProofId
        +reason: DeferralReason
        +deferredUntil: Timestamp
    }
    
    class ProofVerificationStartedEvent {
        +eventType: ProofEventType
        +timestamp: Timestamp
        +proofId: ProofId
        +verificationType: VerificationType
    }
    
    class ProofVerifiedEvent {
        +eventType: ProofEventType
        +timestamp: Timestamp
        +proofId: ProofId
        +success: boolean
        +verificationTime: u64
        +error: Option~ProofError~
    }
    
    class ProofExpiredEvent {
        +eventType: ProofEventType
        +timestamp: Timestamp
        +proofId: ProofId
        +taskId: TaskId
        +deferralDuration: u64
    }
    
    class ProofEventType {
        <<enumeration>>
        Submitted
        Queued
        Deferred
        VerificationStarted
        Verified
        Failed
        Expired
        Cancelled
        PriorityUpdated
    }
    
    ProofEvent <|.. ProofSubmittedEvent
    ProofEvent <|.. ProofDeferredEvent
    ProofEvent <|.. ProofVerificationStartedEvent
    ProofEvent <|.. ProofVerifiedEvent
    ProofEvent <|.. ProofExpiredEvent
```

### 4.3 Ledger Events

```mermaid
classDiagram
    class LedgerEvent {
        <<interface>>
        +eventType: LedgerEventType
        +timestamp: Timestamp
        +sequence: u64
    }
    
    class CommitmentRecordedEvent {
        +eventType: LedgerEventType
        +timestamp: Timestamp
        +sequence: u64
        +commitmentId: CommitmentId
        +taskId: TaskId
        +agentId: AgentId
        +speculativeDepth: u8
    }
    
    class CommitmentStatusChangedEvent {
        +eventType: LedgerEventType
        +timestamp: Timestamp
        +sequence: u64
        +commitmentId: CommitmentId
        +previousStatus: CommitmentStatus
        +newStatus: CommitmentStatus
    }
    
    class CommitmentFinalizedEvent {
        +eventType: LedgerEventType
        +timestamp: Timestamp
        +sequence: u64
        +commitmentId: CommitmentId
        +proofHash: bytes32
        +slot: u64
    }
    
    class CommitmentInvalidatedEvent {
        +eventType: LedgerEventType
        +timestamp: Timestamp
        +sequence: u64
        +commitmentId: CommitmentId
        +reason: InvalidationReason
        +cascadedFrom: Option~CommitmentId~
    }
    
    class LedgerEventType {
        <<enumeration>>
        CommitmentRecorded
        StatusChanged
        Finalized
        Invalidated
        BatchInvalidated
        CheckpointCreated
        Pruned
    }
    
    LedgerEvent <|.. CommitmentRecordedEvent
    LedgerEvent <|.. CommitmentStatusChangedEvent
    LedgerEvent <|.. CommitmentFinalizedEvent
    LedgerEvent <|.. CommitmentInvalidatedEvent
```

### 4.4 Rollback Events

```mermaid
classDiagram
    class RollbackEvent {
        <<interface>>
        +eventType: RollbackEventType
        +timestamp: Timestamp
        +rollbackId: RollbackId
    }
    
    class RollbackInitiatedEvent {
        +eventType: RollbackEventType
        +timestamp: Timestamp
        +rollbackId: RollbackId
        +triggeredBy: TaskId
        +reason: RollbackReason
        +estimatedImpact: RollbackImpact
    }
    
    class RollbackProgressEvent {
        +eventType: RollbackEventType
        +timestamp: Timestamp
        +rollbackId: RollbackId
        +progress: RollbackProgress
        +currentTask: Option~TaskId~
    }
    
    class RollbackCompletedEvent {
        +eventType: RollbackEventType
        +timestamp: Timestamp
        +rollbackId: RollbackId
        +result: RollbackResult
    }
    
    class CompensationExecutedEvent {
        +eventType: RollbackEventType
        +timestamp: Timestamp
        +rollbackId: RollbackId
        +taskId: TaskId
        +success: boolean
        +duration: u64
    }
    
    class RollbackEventType {
        <<enumeration>>
        Initiated
        InProgress
        TaskRolledBack
        CommitmentInvalidated
        CompensationStarted
        CompensationCompleted
        Completed
        Aborted
        Failed
    }
    
    RollbackEvent <|.. RollbackInitiatedEvent
    RollbackEvent <|.. RollbackProgressEvent
    RollbackEvent <|.. RollbackCompletedEvent
    RollbackEvent <|.. CompensationExecutedEvent
```

### 4.5 Callback Signatures

```mermaid
classDiagram
    class VerificationCallback {
        <<callback>>
        +invoke(proofId: ProofId, result: VerificationResult) void
    }
    
    class ExpirationCallback {
        <<callback>>
        +invoke(proofId: ProofId, taskId: TaskId) void
    }
    
    class RollbackCallback {
        <<callback>>
        +invoke(rollbackId: RollbackId, result: RollbackResult) void
    }
    
    class CompensationCallback {
        <<callback>>
        +invoke(taskId: TaskId, requiresCompensation: boolean) void
    }
    
    class TaskCompleteCallback {
        <<callback>>
        +invoke(taskId: TaskId, commitmentId: CommitmentId, speculative: boolean) void
    }
    
    class DecisionCallback {
        <<callback>>
        +invoke(taskId: TaskId, decision: SpeculationDecision) void
    }
    
    class CompensationHandler {
        <<callback>>
        +execute(taskId: TaskId, context: CompensationContext) Result~void~
        +canHandle(taskType: string) boolean
        +estimateDuration(taskId: TaskId) u64
    }
    
    class EventEmitter~T~ {
        -listeners: Map~string, Listener~T~~[]
        +on(eventType: string, listener: Listener~T~) void
        +off(eventType: string, listener: Listener~T~) void
        +emit(event: T) void
        +once(eventType: string, listener: Listener~T~) void
        +removeAllListeners(eventType: string) void
    }
    
    class VerificationResult {
        +proofId: ProofId
        +valid: boolean
        +verificationTime: u64
        +error: Option~ProofError~
    }
    
    class CompensationContext {
        +rollbackId: RollbackId
        +taskId: TaskId
        +commitment: SpeculativeCommitment
        +timeout: u64
    }
```

---

## 5. Full System Relationships

### 5.1 Complete Component Relationships

```mermaid
classDiagram
    direction TB
    
    %% Core Components
    class SpeculativeTaskScheduler {
        +scheduleTask()
        +executeSpeculatively()
        +shouldSpeculate()
        +handleProofFailure()
    }
    
    class DependencyGraph {
        +addNode()
        +addEdge()
        +getTransitiveDependents()
        +getRollbackOrder()
    }
    
    class ProofDeferralManager {
        +submitProof()
        +deferProof()
        +verifyProof()
        +processExpiredProofs()
    }
    
    class CommitmentLedger {
        +recordCommitment()
        +finalizeCommitment()
        +invalidateCommitment()
        +queryCommitments()
    }
    
    class RollbackController {
        +initiateRollback()
        +executeRollback()
        +calculateImpact()
        +executeCompensation()
    }
    
    %% Supporting Components
    class SpeculationStrategy {
        <<interface>>
    }
    
    class RiskAssessor {
        +assessRisk()
        +calculateConfidence()
    }
    
    class VerifierPool {
        +verify()
        +batchVerify()
    }
    
    %% Data Types
    class SpeculativeCommitment {
        +commitmentId
        +taskId
        +status
    }
    
    class DeferredProof {
        +proofId
        +taskId
        +status
    }
    
    class TaskDependency {
        +from
        +to
        +dependencyType
    }
    
    class RollbackResult {
        +rollbackId
        +tasksRolledBack
        +success
    }
    
    class SpeculationDecision {
        +shouldSpeculate
        +confidence
        +reasons
    }
    
    %% Relationships - Composition
    SpeculativeTaskScheduler "1" *-- "1" DependencyGraph : owns
    SpeculativeTaskScheduler "1" *-- "1" ProofDeferralManager : owns
    SpeculativeTaskScheduler "1" *-- "1" CommitmentLedger : owns
    SpeculativeTaskScheduler "1" *-- "1" RollbackController : owns
    
    %% Relationships - Dependencies
    SpeculativeTaskScheduler --> SpeculationStrategy : uses
    SpeculativeTaskScheduler --> RiskAssessor : consults
    ProofDeferralManager --> VerifierPool : delegates to
    RollbackController --> DependencyGraph : traverses
    RollbackController --> CommitmentLedger : invalidates
    
    %% Data relationships
    CommitmentLedger "1" *-- "*" SpeculativeCommitment : stores
    ProofDeferralManager "1" *-- "*" DeferredProof : manages
    DependencyGraph "1" *-- "*" TaskDependency : tracks
    RollbackController --> RollbackResult : produces
    SpeculativeTaskScheduler --> SpeculationDecision : produces
```

### 5.2 Data Flow Relationships

```mermaid
classDiagram
    direction LR
    
    %% Input/Output flow
    class Task {
        +taskId: TaskId
        +description: bytes
        +reward: u64
    }
    
    class TaskResult {
        +taskId: TaskId
        +outputHash: bytes32
        +resultData: bytes
    }
    
    class ScheduledTask {
        +task: Task
        +priority: Priority
        +speculative: boolean
    }
    
    class ExecutionContext {
        +taskId: TaskId
        +speculative: boolean
        +commitmentId: Option
    }
    
    class SpeculativeCommitment {
        +commitmentId: CommitmentId
        +resultHash: bytes32
        +status: CommitmentStatus
    }
    
    class DeferredProof {
        +proofId: ProofId
        +privatePayload: Risc0PrivatePayload
        +status: ProofStatus
    }
    
    class RollbackSession {
        +rollbackId: RollbackId
        +affectedTasks: TaskId[]
        +status: RollbackSessionStatus
    }
    
    class RollbackResult {
        +success: boolean
        +tasksRolledBack: TaskId[]
    }
    
    %% Flow
    Task --> ScheduledTask : scheduled as
    ScheduledTask --> ExecutionContext : executes in
    ExecutionContext --> TaskResult : produces
    TaskResult --> SpeculativeCommitment : recorded as
    SpeculativeCommitment --> DeferredProof : awaits
    DeferredProof --> SpeculativeCommitment : verifies
    SpeculativeCommitment --> RollbackSession : may trigger
    RollbackSession --> RollbackResult : completes with
```

### 5.3 Interface Implementations

```mermaid
classDiagram
    %% Strategy implementations
    class SpeculationStrategy {
        <<interface>>
        +shouldSpeculate(context: StrategyContext) boolean
        +calculatePriority(task: Task, graph: DependencyGraph) Priority
        +selectTasks(candidates: Task[], limit: u32) Task[]
        +adjustParameters(metrics: SchedulerMetrics) void
    }
    
    class AggressiveStrategy {
        -maxSpeculationDepth: u8
        -minConfidence: f64
    }
    
    class ConservativeStrategy {
        -requireAllDepsVerified: boolean
        -maxPendingProofs: u8
    }
    
    class AdaptiveStrategy {
        -currentMode: StrategyMode
        -successHistory: CircularBuffer
    }
    
    SpeculationStrategy <|.. AggressiveStrategy : implements
    SpeculationStrategy <|.. ConservativeStrategy : implements
    SpeculationStrategy <|.. AdaptiveStrategy : implements
    
    %% Event interfaces
    class SchedulerEvent {
        <<interface>>
        +eventType: SchedulerEventType
        +timestamp: Timestamp
    }
    
    class ProofEvent {
        <<interface>>
        +eventType: ProofEventType
        +timestamp: Timestamp
    }
    
    class LedgerEvent {
        <<interface>>
        +eventType: LedgerEventType
        +sequence: u64
    }
    
    class RollbackEvent {
        <<interface>>
        +eventType: RollbackEventType
        +rollbackId: RollbackId
    }
    
    %% Event emitters
    class SpeculativeTaskScheduler {
        -eventEmitter: EventEmitter~SchedulerEvent~
    }
    
    class ProofDeferralManager {
        -eventEmitter: EventEmitter~ProofEvent~
    }
    
    class CommitmentLedger {
        -eventEmitter: EventEmitter~LedgerEvent~
    }
    
    class RollbackController {
        -eventEmitter: EventEmitter~RollbackEvent~
    }
    
    SpeculativeTaskScheduler ..> SchedulerEvent : emits
    ProofDeferralManager ..> ProofEvent : emits
    CommitmentLedger ..> LedgerEvent : emits
    RollbackController ..> RollbackEvent : emits
```

### 5.4 Error Types

```mermaid
classDiagram
    class SpeculationError {
        <<enumeration>>
        TaskNotFound
        InvalidDependency
        CycleDetected
        MaxDepthExceeded
        ResourceExhausted
        InvalidState
        Timeout
        ConfigurationError
    }
    
    class ProofError {
        <<enumeration>>
        InvalidProofFormat
        VerificationFailed
        CircuitMismatch
        PublicInputMismatch
        VerifierUnavailable
        Timeout
        DeserializationFailed
    }
    
    class LedgerError {
        <<enumeration>>
        CommitmentNotFound
        DuplicateCommitment
        InvalidStatus
        MerkleProofFailed
        StorageFull
        CheckpointFailed
    }
    
    class RollbackError {
        <<enumeration>>
        RollbackNotFound
        AlreadyInProgress
        CompensationFailed
        Timeout
        PartialFailure
        InvalidState
    }
    
    class GraphError {
        <<enumeration>>
        NodeNotFound
        EdgeNotFound
        CycleDetected
        MaxNodesExceeded
        MaxEdgesExceeded
        InvalidOperation
    }
```

---

## Appendix: Quick Reference

### Type Aliases

| Alias | Underlying Type | Description |
|-------|-----------------|-------------|
| `TaskId` | `[u8; 32]` | Unique task identifier |
| `CommitmentId` | `[u8; 32]` | Unique commitment identifier |
| `ProofId` | `[u8; 32]` | Unique proof identifier |
| `AgentId` | `Pubkey` | Agent's public key |
| `RollbackId` | `[u8; 32]` | Unique rollback session identifier |
| `Timestamp` | `i64` | Unix timestamp in seconds |
| `Field` | `[u8; 32]` | ZK circuit field element |
| `bytes32` | `[u8; 32]` | 32-byte hash or data |

### Status State Machines

**CommitmentStatus Transitions:**
```
Pending → Active → AwaitingProof → Verified → Finalized
                                 ↘ Failed → Invalidated
                        (any) → RolledBack
                        (any) → Expired
```

**ProofStatus Transitions:**
```
Submitted → Queued → Deferred → Verifying → Verified
                              ↘ Failed
                   (any) → Expired
                   (any) → Cancelled
```

**RollbackSessionStatus Transitions:**
```
Pending → InProgress → CompensationPhase → Completing → Completed
                     ↘ Failed
         (any) → Aborted
```
