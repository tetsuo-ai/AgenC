# Key Interface Class Diagrams

Class diagrams for the 10 most important interfaces in the runtime. These are the contracts that new modules must integrate with.

## AgentManager

```mermaid
classDiagram
    class AgentManager {
        -connection: Connection
        -program: Program
        -wallet: WalletAdapter
        -agentPda: PublicKey
        -agentId: Uint8Array
        -cachedState: AgentState
        -eventSubscription: EventSubscription
        +register(capabilities, stake, endpoint?) Promise~string~
        +getState() Promise~AgentState~
        +update(capabilities?, endpoint?, status?) Promise~string~
        +deregister() Promise~string~
        +subscribeToEvents(callbacks) EventSubscription
        +getAgentPda() PublicKey
    }

    class AgentState {
        +authority: PublicKey
        +capabilities: bigint
        +status: AgentStatus
        +reputation: number
        +activeTasks: number
        +stake: bigint
        +endpoint: string
    }

    class AgentCapabilities {
        +COMPUTE: bigint
        +INFERENCE: bigint
        +STORAGE: bigint
        +NETWORK: bigint
        +SENSOR: bigint
        +ACTUATOR: bigint
        +COORDINATOR: bigint
        +ARBITER: bigint
        +VALIDATOR: bigint
        +AGGREGATOR: bigint
    }

    AgentManager --> AgentState
    AgentManager --> AgentCapabilities
```

## TaskOperations

```mermaid
classDiagram
    class TaskOperations {
        -connection: Connection
        -program: Program
        -wallet: WalletAdapter
        -protocolPda: PublicKey
        -treasuryCache: PublicKey
        +createTask(params) Promise~TaskResult~
        +createDependentTask(params) Promise~TaskResult~
        +claimTask(taskPda) Promise~string~
        +completeTask(taskPda, proofHash, resultData) Promise~string~
        +completeTaskPrivate(taskPda, proof, publicInputs) Promise~string~
        +cancelTask(taskPda) Promise~string~
        +getTask(taskPda) Promise~OnChainTask~
        +fetchClaimableTasks(capabilities?) Promise~OnChainTask[]~
        +fetchTasksByCreator(creator) Promise~OnChainTask[]~
    }

    class OnChainTask {
        +creator: PublicKey
        +taskId: Uint8Array
        +status: TaskStatus
        +requiredCapabilities: bigint
        +rewardAmount: bigint
        +rewardMint: PublicKey
        +deadline: number
        +maxWorkers: number
        +completions: number
        +constraintHash: Uint8Array
    }

    TaskOperations --> OnChainTask
```

## AutonomousAgent

```mermaid
classDiagram
    class AutonomousAgent {
        -connection: Connection
        -wallet: WalletAdapter
        -taskOps: TaskOperations
        -scanner: TaskScanner
        -executor: TaskExecutor
        -proofGenerator: ProofGenerator
        -running: boolean
        +start() Promise~void~
        +stop() Promise~void~
        +isRunning() boolean
        +getStats() AgentStats
    }

    class TaskExecutor {
        <<interface>>
        +execute(task, context) Promise~TaskResult~
    }

    class ProofGenerator {
        <<interface>>
        +generatePublicProof(taskPda, output) Promise~ProofHash~
        +generatePrivateProof(taskPda, output, salt) Promise~Proof~
    }

    class TaskScanner {
        -discoveryMode: string
        -scanIntervalMs: number
        +scan() Promise~OnChainTask[]~
        +start() void
        +stop() void
    }

    AutonomousAgent --> TaskExecutor
    AutonomousAgent --> ProofGenerator
    AutonomousAgent --> TaskScanner
```

## LLMProvider

```mermaid
classDiagram
    class LLMProvider {
        <<interface>>
        +chat(messages, options?) Promise~LLMResponse~
        +chatStream(messages, options?) AsyncIterable~string~
        +getModelInfo() ModelInfo
    }

    class GrokProvider {
        -client: OpenAI
        -model: string
        +chat(messages, options?) Promise~LLMResponse~
        +chatStream(messages, options?) AsyncIterable~string~
        +getModelInfo() ModelInfo
    }

    class AnthropicProvider {
        -client: Anthropic
        -model: string
        +chat(messages, options?) Promise~LLMResponse~
        +chatStream(messages, options?) AsyncIterable~string~
        +getModelInfo() ModelInfo
    }

    class OllamaProvider {
        -client: Ollama
        -model: string
        +chat(messages, options?) Promise~LLMResponse~
        +chatStream(messages, options?) AsyncIterable~string~
        +getModelInfo() ModelInfo
    }

    class LLMTaskExecutor {
        -provider: LLMProvider
        -toolHandler: ToolHandler
        -maxToolRounds: number
        +execute(task, systemPrompt) Promise~bigint[]~
    }

    LLMProvider <|.. GrokProvider
    LLMProvider <|.. AnthropicProvider
    LLMProvider <|.. OllamaProvider
    LLMTaskExecutor --> LLMProvider
```

## ToolRegistry and Tool

```mermaid
classDiagram
    class Tool {
        <<interface>>
        +name: string
        +description: string
        +inputSchema: JSONSchema
        +execute(args) Promise~ToolResult~
    }

    class ToolResult {
        +content: string
        +isError: boolean
    }

    class ToolRegistry {
        -tools: Map~string, Tool~
        -logger: Logger
        +register(tool) void
        +registerAll(tools) void
        +get(name) Tool
        +has(name) boolean
        +list() Tool[]
        +toLLMTools() LLMTool[]
        +createToolHandler() ToolHandler
    }

    class ToolHandler {
        <<interface>>
        +handle(name, args) Promise~ToolResult~
    }

    ToolRegistry --> Tool
    ToolRegistry --> ToolHandler
    Tool --> ToolResult
```

## MemoryBackend

```mermaid
classDiagram
    class MemoryBackend {
        <<interface>>
        +addEntry(sessionId, entry) Promise~void~
        +getEntries(sessionId, options?) Promise~MemoryEntry[]~
        +getSessionCount() Promise~number~
        +listSessions() Promise~string[]~
        +deleteSession(sessionId) Promise~void~
        +set(key, value, ttlMs?) Promise~void~
        +get(key) Promise~unknown~
        +delete(key) Promise~boolean~
        +connect() Promise~void~
        +disconnect() Promise~void~
        +isConnected() boolean
    }

    class MemoryEntry {
        +role: string
        +content: string
        +timestamp: number
        +metadata: Record
    }

    class InMemoryBackend {
        -threads: Map
        -kv: Map
        -config: InMemoryBackendConfig
    }

    class SqliteBackend {
        -db: Database
        -config: SqliteBackendConfig
    }

    class RedisBackend {
        -client: Redis
        -config: RedisBackendConfig
    }

    MemoryBackend <|.. InMemoryBackend
    MemoryBackend <|.. SqliteBackend
    MemoryBackend <|.. RedisBackend
    MemoryBackend --> MemoryEntry
```

## ProofEngine

```mermaid
classDiagram
    class ProofGenerator {
        <<interface>>
        +generatePublicProof(taskPda, output) Promise~ProofHash~
        +generatePrivateProof(taskPda, output, salt) Promise~Proof~
    }

    class ProofEngine {
        -config: ProofEngineConfig
        -cache: ProofCache
        -stats: ProofEngineStats
        +generate(inputs) Promise~EngineProofResult~
        +verify(proof, publicInputs) Promise~boolean~
        +getStats() ProofEngineStats
        +clearCache() void
        +generatePublicProof(taskPda, output) Promise~ProofHash~
        +generatePrivateProof(taskPda, output, salt) Promise~Proof~
    }

    class ProofCache {
        -entries: Map
        -ttlMs: number
        -maxEntries: number
        +get(key) CachedProof
        +set(key, proof) void
        +clear() void
        +size() number
    }

    ProofGenerator <|.. ProofEngine
    ProofEngine --> ProofCache
```

## DisputeOperations

```mermaid
classDiagram
    class DisputeOperations {
        -connection: Connection
        -program: Program
        -wallet: WalletAdapter
        -agentPda: PublicKey
        -protocolPda: PublicKey
        +initiateDispute(params) Promise~string~
        +voteDispute(disputePda, approved) Promise~string~
        +resolveDispute(disputePda, arbiterPairs, workerPairs) Promise~string~
        +applySlash(disputePda) Promise~string~
        +cancelDispute(disputePda) Promise~string~
        +expireDispute(disputePda) Promise~string~
        +getDispute(disputePda) Promise~OnChainDispute~
        +fetchActiveDisputes() Promise~OnChainDispute[]~
        +fetchDisputesForTask(taskPda) Promise~OnChainDispute[]~
    }

    class OnChainDispute {
        +disputeId: Uint8Array
        +task: PublicKey
        +initiator: PublicKey
        +defendant: PublicKey
        +resolutionType: ResolutionType
        +status: DisputeStatus
        +votesFor: number
        +votesAgainst: number
        +votingDeadline: number
    }

    DisputeOperations --> OnChainDispute
```

## DAGOrchestrator

```mermaid
classDiagram
    class DAGOrchestrator {
        -taskOps: TaskOperations
        -logger: Logger
        +validateWorkflow(tasks) ValidationResult
        +topologicalSort(tasks) WorkflowTask[]
        +executeWorkflow(workflow) Promise~WorkflowResult~
        +getWorkflowStatus(workflowId) WorkflowStatus
    }

    class GoalCompiler {
        -llmProvider: LLMProvider
        +compile(goal, context) Promise~WorkflowTask[]~
    }

    class WorkflowOptimizer {
        -mutationEngine: MutationEngine
        +optimize(workflow, corpus) Promise~OptimizedWorkflow~
    }

    class WorkflowTask {
        +id: string
        +parentId: string
        +description: string
        +requiredCapabilities: bigint
        +reward: bigint
        +status: TaskStatus
    }

    DAGOrchestrator --> WorkflowTask
    DAGOrchestrator --> GoalCompiler
    DAGOrchestrator --> WorkflowOptimizer
```

## PolicyEngine

```mermaid
classDiagram
    class PolicyEngine {
        -budgets: Map
        -circuitBreakers: Map
        -accessRules: AccessRule[]
        +checkBudget(action, amount) PolicyDecision
        +checkCircuitBreaker(service) PolicyDecision
        +checkAccess(action, context) PolicyDecision
        +recordAction(action, amount) void
        +resetBudget(budgetId) void
        +getStatus() PolicyStatus
    }

    class PolicyDecision {
        +allowed: boolean
        +reason: string
        +retryAfterMs: number
    }

    class CircuitBreaker {
        +state: string
        +failureCount: number
        +lastFailure: number
        +threshold: number
        +cooldownMs: number
    }

    PolicyEngine --> PolicyDecision
    PolicyEngine --> CircuitBreaker
```

## Interface Integration Map

Shows how interfaces connect at runtime:

```mermaid
flowchart LR
    AgentBuilder -->|creates| AgentManager
    AgentBuilder -->|creates| AutonomousAgent
    AgentBuilder -->|configures| LLMProvider
    AgentBuilder -->|configures| MemoryBackend
    AgentBuilder -->|configures| ProofEngine
    AgentBuilder -->|configures| ToolRegistry

    AutonomousAgent -->|uses| TaskOperations
    AutonomousAgent -->|uses| ProofEngine
    AutonomousAgent -->|uses| LLMProvider

    LLMTaskExecutor -->|uses| LLMProvider
    LLMTaskExecutor -->|uses| ToolRegistry

    DAGOrchestrator -->|uses| TaskOperations
    DAGOrchestrator -->|uses| GoalCompiler

    DisputeOperations -->|queries| AgentManager

    AgentRuntime -->|wraps| AgentManager
    AgentRuntime -->|wraps| AutonomousAgent
```
