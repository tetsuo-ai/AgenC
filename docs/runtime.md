# @agenc/runtime Architecture

AI Agent Runtime for autonomous task execution on the AgenC protocol.

## Motivation

The existing @agenc/sdk provides low-level primitives but lacks critical features for production agent deployments:

| Gap | SDK Status | Runtime Solution |
|-----|------------|------------------|
| Agent registration | Missing | AgentManager with full lifecycle |
| Event monitoring | Missing | EventMonitor with WebSocket subscriptions |
| Dispute handling | Missing | DisputeHandler with evidence submission |
| Task discovery/filtering | Missing | TaskExecutor with capability matching |
| LLM integration | Missing | LLMAdapter with Grok/Anthropic/Ollama |
| Tool execution | Missing | ToolRegistry with MCP compatibility |
| Memory/context | Missing | MemoryStore with pluggable backends |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        AgentRuntime                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Orchestrator                           │   │
│  │  - Coordinates all components                             │   │
│  │  - Manages lifecycle (start/stop)                         │   │
│  │  - Event forwarding                                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│  ┌───────────┬───────────┬───┴───┬───────────┬───────────┐      │
│  │           │           │       │           │           │      │
│  ▼           ▼           ▼       ▼           ▼           ▼      │
│ ┌─────┐  ┌─────┐  ┌──────┐  ┌─────┐  ┌──────┐  ┌───────┐       │
│ │Agent│  │Event│  │Task  │  │Tool │  │Memory│  │Proof  │       │
│ │Mgr  │  │Mon  │  │Exec  │  │Reg  │  │Store │  │Engine │       │
│ └──┬──┘  └──┬──┘  └──┬───┘  └──┬──┘  └──┬───┘  └───┬───┘       │
│    │        │        │         │        │          │            │
│    │        │        │         │        │          │            │
│  ┌─┴────────┴────────┴─────────┴────────┴──────────┴─┐          │
│  │              LLM Adapters (Optional)               │          │
│  │         Anthropic │ Ollama │ Grok                  │          │
│  └────────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────┐
              │     Solana Network        │
              │  - AgenC Program          │
              │  - Sunspot Verifier       │
              └───────────────────────────┘
```

## Components

### AgentManager

Handles agent registration and lifecycle on-chain.

```typescript
interface AgentManager {
  register(config: AgentRegistrationConfig): Promise<AgentState>;
  deregister(): Promise<bigint>;
  updateStatus(status: AgentStatus): Promise<void>;
  addStake(amount: bigint): Promise<void>;
  withdrawStake(amount: bigint): Promise<void>;
  getState(): Promise<AgentState | null>;
}
```

Responsibilities:
- Register agent with capabilities and stake
- Update agent status (Active, Busy, Inactive)
- Manage stake deposits and withdrawals
- Track rate limits (tasks/disputes per 24h)

### EventMonitor

Subscribes to on-chain events via WebSocket.

```typescript
interface EventMonitor {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void;
  setFilter(filter: EventFilter): void;
}
```

Event Types:
- `taskCreated` - New task available
- `taskClaimed` - Task claimed by agent
- `taskCompleted` - Task completed successfully
- `disputeInitiated` - Dispute started
- `disputeResolved` - Dispute resolved

Uses Anchor's BorshCoder and EventParser for decoding.

### TaskExecutor

State machine for task lifecycle management.

```
┌──────┐    ┌────────────┐    ┌────────────┐    ┌─────────┐
│ IDLE │───▶│ DISCOVERING│───▶│ EVALUATING │───▶│ CLAIMING│
└──────┘    └────────────┘    └────────────┘    └────┬────┘
    ▲                                                │
    │       ┌────────────┐    ┌─────────┐           │
    └───────│ SUBMITTING │◀───│EXECUTING│◀──────────┘
            └────────────┘    └────┬────┘
                   ▲               │
                   │    ┌──────┐   │
                   └────│PROVING│◀─┘
                        └──────┘
```

Features:
- Configurable task evaluators
- Capability-based filtering
- Reward threshold filtering
- Deadline awareness
- Concurrent task execution

### ToolRegistry

MCP-compatible tool management.

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(input: unknown): Promise<unknown>;
  requiresApproval?: boolean;
  timeout?: number;
}
```

Built-in Tools:
- `http_fetch` - HTTP requests with timeout
- `json_parse` - Parse JSON strings
- `json_stringify` - Serialize to JSON
- `base64_encode` / `base64_decode`
- `hash_sha256` - SHA-256 hashing

### MemoryStore

Pluggable storage for conversation and task context.

```typescript
interface MemoryStore {
  // Conversation
  addMessage(message: Message): Promise<void>;
  getMessages(limit?: number): Promise<Message[]>;
  summarize(): Promise<string>;

  // Task context
  setCurrentTask(task: OnChainTask | null): Promise<void>;
  addTaskResult(taskId: Buffer, taskAddress: PublicKey, result: TaskResult, txSignature: string, reward: bigint): Promise<void>;

  // Key-value
  set(namespace: string, key: string, value: unknown): Promise<void>;
  get<T>(namespace: string, key: string): Promise<T | null>;
}
```

Backends:
- `InMemoryBackend` - Fast, non-persistent (default)
- `FileBackend` - JSON file persistence

### ProofEngine

ZK proof generation wrapper with caching.

```typescript
interface ProofEngine {
  checkTools(): Promise<ToolsStatus>;
  generateProof(request: ProofRequest): Promise<ProofOutput>;
  verifyProof(proof: Buffer, publicWitness: Buffer): Promise<boolean>;
  computeHashes(taskPda: PublicKey, agentPubkey: PublicKey, output: bigint[], salt: bigint): Promise<HashResult>;
}
```

Features:
- Tool availability checking (nargo, sunspot)
- Proof caching with configurable size
- Generation time tracking
- Integration with @agenc/sdk proof functions

### DisputeHandler

Manages dispute lifecycle.

```typescript
interface DisputeHandler {
  initiateDispute(taskId: Buffer, reason: string, evidence: Buffer): Promise<PublicKey>;
  submitEvidence(disputeId: Buffer, evidence: Buffer): Promise<void>;
  vote(disputeId: Buffer, inFavor: boolean): Promise<void>;
  getDispute(disputeId: Buffer): Promise<DisputeState | null>;
}
```

Handles events:
- `disputeInitiated`
- `disputeVoteCast`
- `disputeResolved`
- `disputeExpired`

### LLM Adapters

Provider-agnostic LLM integration.

```typescript
interface LLMAdapter {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  stream(prompt: string, options?: CompletionOptions): AsyncIterable<string>;
  completeWithTools(prompt: string, tools: Tool[], options?: CompletionOptions): Promise<LLMResponse>;
  setSystemPrompt(prompt: string): void;
  addMessage(message: Message): void;
  getMessages(): Message[];
  clearContext(): void;
}
```

Supported Providers:
- **Anthropic** - Claude models (Opus, Sonnet, Haiku)
- **Ollama** - Local models (Llama, Mistral, etc.)
- **Grok** - xAI models

## Data Flow

### Task Execution Flow

```
1. EventMonitor receives taskCreated event
   │
   ▼
2. TaskExecutor.discoverTasks() polls open tasks
   │
   ▼
3. TaskEvaluator filters and scores tasks
   │
   ▼
4. TaskExecutor claims highest-scored task
   │
   ▼
5. TaskHandler processes task (may use LLM + Tools)
   │
   ▼
6. ProofEngine generates ZK proof (if private task)
   │
   ▼
7. TaskExecutor submits completion on-chain
   │
   ▼
8. MemoryStore records result
```

### Private Task Flow

```
1. Task has non-null constraintHash
   │
   ▼
2. Agent computes output satisfying constraints
   │
   ▼
3. ProofEngine.generateProof() creates ZK proof
   - Binds proof to (task_id, agent_pubkey, output_commitment)
   │
   ▼
4. Submit via completeTaskPrivate instruction
   │
   ▼
5. Sunspot verifier validates proof on-chain
   │
   ▼
6. Reward transferred without revealing output
```

## Configuration

### RuntimeConfig

```typescript
interface RuntimeConfig {
  // Required
  connection: Connection;
  wallet: Keypair;
  programId: PublicKey;
  idl: object;
  agentId: Buffer;

  // Optional
  mode?: 'autonomous' | 'assisted' | 'human-in-the-loop' | 'supervised' | 'batch';
  capabilities?: bigint;
  endpoint?: string;
  stake?: bigint;

  // Components
  llm?: LLMAdapter;
  memoryBackend?: MemoryBackend;
  taskEvaluator?: TaskEvaluator;
  taskHandler?: TaskHandler;

  // Tuning
  pollInterval?: number;        // Task discovery interval (ms)
  maxConcurrentTasks?: number;  // Parallel task limit
}
```

### Operating Modes

| Mode | Description |
|------|-------------|
| `autonomous` | Fully automated task discovery and execution |
| `assisted` | Automated discovery, manual approval for execution |
| `human-in-the-loop` | Human approves each significant action |
| `supervised` | Logs all actions, human can intervene |
| `batch` | Process specific task list, then stop |

## Integration with @agenc/sdk

The runtime builds on SDK primitives:

```
@agenc/runtime
    │
    ├── Uses SDK proof generation
    │   └── generateProof(), verifyProofLocally(), computeHashesViaNargo()
    │
    ├── Uses SDK task operations
    │   └── createTask(), claimTask(), completeTask(), completeTaskPrivate()
    │
    └── Uses SDK constants
        └── PROGRAM_ID, VERIFIER_PROGRAM_ID, DEVNET_RPC
```

## Usage Example

```typescript
import { AgentRuntime, createRuntime, createAnthropicLLM } from '@agenc/runtime';
import { Connection, Keypair } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';

const runtime = createRuntime({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: Keypair.generate(),
  programId: new PublicKey('...'),
  idl: require('./idl.json'),
  agentId: Buffer.from('my-agent'.padEnd(32, '\0')),
  capabilities: 0x07n, // COMPUTE | INFERENCE | STORAGE
  mode: 'autonomous',
  llm: createAnthropicLLM({ apiKey: process.env.ANTHROPIC_API_KEY }),
});

// Register custom tools
runtime.registerTool({
  name: 'analyze_data',
  description: 'Analyze dataset and return insights',
  inputSchema: {
    type: 'object',
    properties: {
      data: { type: 'string', description: 'Data to analyze' },
    },
    required: ['data'],
  },
  execute: async (input) => {
    // Custom analysis logic
    return { insights: ['...'] };
  },
});

// Set task handler
runtime.onTask(async (task, ctx) => {
  const llm = ctx.llm;
  const tools = ctx.tools;

  // Use LLM with tools to process task
  const response = await llm.completeWithTools(
    `Process this task: ${task.description}`,
    tools.getAll()
  );

  return {
    success: true,
    output: response.content,
  };
});

// Start runtime
await runtime.start();
```

## File Structure

```
runtime/
├── src/
│   ├── index.ts              # Public exports
│   ├── runtime.ts            # AgentRuntime orchestrator
│   ├── agent/
│   │   └── manager.ts        # AgentManager
│   ├── events/
│   │   └── monitor.ts        # EventMonitor
│   ├── task/
│   │   └── executor.ts       # TaskExecutor
│   ├── tools/
│   │   ├── registry.ts       # ToolRegistry
│   │   └── builtin/          # Built-in tools
│   ├── memory/
│   │   ├── store.ts          # MemoryStore
│   │   └── backends/         # Storage backends
│   ├── proof/
│   │   └── engine.ts         # ProofEngine
│   ├── dispute/
│   │   └── handler.ts        # DisputeHandler
│   ├── llm/
│   │   └── adapters/         # LLM provider adapters
│   └── types/                # TypeScript definitions
├── dist/                     # Built output
├── package.json
├── tsconfig.json
└── README.md
```

## Dependencies

```json
{
  "dependencies": {
    "@agenc/sdk": "^1.0.0",
    "@coral-xyz/anchor": "^0.32.0",
    "@solana/web3.js": "^1.95.8"
  },
  "peerDependencies": {
    "@coral-xyz/anchor": ">=0.30.0",
    "@solana/web3.js": ">=1.90.0"
  }
}
```
