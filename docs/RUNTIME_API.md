# Runtime API Quick Reference

Practical usage patterns and entry points for `@agenc/runtime`. For comprehensive type signatures and field-level documentation, see [CLAUDE.md](../CLAUDE.md).

## Getting Started

```bash
npm install @agenc/runtime
cd runtime && npm run build
```

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import {
  AgentRuntime,
  AgentCapabilities,
  createProgram,
  createReadOnlyProgram,
  keypairToWallet,
} from '@agenc/runtime';

// Read-only access (queries, event subscriptions — no wallet)
const program = createReadOnlyProgram(connection);

// Full access (transactions — requires wallet)
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const program = createProgram(provider);
```

## Module Map

| Module | Primary Class | Purpose | Config Type |
|--------|--------------|---------|-------------|
| `agent/` | `AgentManager` | Register, update, deregister agents | `AgentManagerConfig` |
| `runtime.ts` | `AgentRuntime` | Lifecycle wrapper around AgentManager | `AgentRuntimeConfig` |
| `autonomous/` | `AutonomousAgent` | Self-operating agent with task discovery | `AutonomousAgentConfig` |
| `task/` | `TaskOperations` | Claim, complete, cancel tasks on-chain | `TaskOpsConfig` |
| `events/` | `EventMonitor` | Subscribe to all protocol events | `EventMonitorConfig` |
| `llm/` | `LLMTaskExecutor` | Bridge LLM providers to task execution | `LLMTaskExecutorConfig` |
| `llm/grok/` | `GrokProvider` | xAI Grok adapter (via `openai` SDK) | `GrokProviderConfig` |
| `llm/anthropic/` | `AnthropicProvider` | Anthropic adapter | `AnthropicProviderConfig` |
| `llm/ollama/` | `OllamaProvider` | Ollama local adapter | `OllamaProviderConfig` |
| `tools/` | `ToolRegistry` | MCP-compatible tool management | `ToolRegistryConfig` |
| `memory/` | `InMemoryBackend` | Zero-dep memory storage | `InMemoryBackendConfig` |
| `memory/sqlite/` | `SqliteBackend` | SQLite-backed storage | `SqliteBackendConfig` |
| `memory/redis/` | `RedisBackend` | Redis-backed storage | `RedisBackendConfig` |
| `proof/` | `ProofEngine` | ZK proof generation with caching | `ProofEngineConfig` |
| `dispute/` | `DisputeOperations` | Dispute lifecycle transactions | `DisputeOpsConfig` |
| `skills/` | `SkillRegistry` | Skill registration and lifecycle | `SkillRegistryConfig` |

## Common Patterns

### Agent Lifecycle

```typescript
const runtime = new AgentRuntime({
  connection,
  wallet: keypair,
  capabilities: BigInt(AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE),
  initialStake: 500_000_000n,
  logLevel: 'info',
});

runtime.registerShutdownHandlers(); // SIGINT/SIGTERM
await runtime.start();              // register or load + set Active
// ... agent operations ...
await runtime.stop();               // set Inactive + cleanup
```

### LLM Provider Selection

```typescript
import { GrokProvider, AnthropicProvider, OllamaProvider } from '@agenc/runtime';

// Grok (requires: npm install openai)
const grok = new GrokProvider({ apiKey: process.env.XAI_API_KEY!, model: 'grok-3', tools });

// Anthropic (requires: npm install @anthropic-ai/sdk)
const anthropic = new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-5-20250929', tools });

// Ollama (requires: npm install ollama + local Ollama server)
const ollama = new OllamaProvider({ model: 'llama3', tools });
```

All providers implement `LLMProvider`: `chat()`, `chatStream()`, `healthCheck()`.

### Tool Wiring (Critical Two-Site Pattern)

Both sites must be connected for tool calls to work:

```typescript
import { ToolRegistry, createAgencTools, LLMTaskExecutor } from '@agenc/runtime';

const registry = new ToolRegistry({ logger });
registry.registerAll(createAgencTools({ connection, program, logger }));

// Site 1: Tool DEFINITIONS go to the provider (so the LLM knows what tools exist)
const provider = new GrokProvider({ apiKey, model, tools: registry.toLLMTools() });

// Site 2: Tool HANDLER goes to the executor (executes tool calls during task loop)
const executor = new LLMTaskExecutor({
  provider,
  toolHandler: registry.createToolHandler(),
});
```

### Memory Integration

```typescript
import { InMemoryBackend, entryToMessage } from '@agenc/runtime';

const memory = new InMemoryBackend({ maxEntriesPerSession: 1000 });

// Store entries
await memory.addEntry({ sessionId: 'sess-1', role: 'user', content: 'Hello' });

// Retrieve and convert to LLM format
const thread = await memory.getThread('sess-1');
const llmMessages = thread.map(entryToMessage);

// Key-value storage
await memory.set('config:model', 'grok-3', 300_000); // with 5min TTL
const model = await memory.get<string>('config:model');
```

### Event Subscription

```typescript
import { EventMonitor, createReadOnlyProgram } from '@agenc/runtime';

// Read-only program works for events (uses Connection WebSocket internally)
const program = createReadOnlyProgram(connection);
const monitor = new EventMonitor({ program, logger });

monitor.subscribeToTaskEvents({
  onTaskCreated: (event, slot, sig) => { /* ... */ },
  onTaskCompleted: (event) => { /* ... */ },
});

monitor.subscribeToDisputeEvents({ /* ... */ });
monitor.subscribeToProtocolEvents({ /* ... */ });
monitor.subscribeToAgentEvents({ /* ... */ });

monitor.start();
const metrics = monitor.getMetrics(); // { totalEventsReceived, eventCounts, uptimeMs }
await monitor.stop();
```

### Proof Generation

```typescript
import { ProofEngine } from '@agenc/runtime';

const engine = new ProofEngine({
  methodId: trustedImageIdBytes,
  routerConfig: {
    routerProgram,
    router,
    verifierEntry,
    verifierProgram,
  },
  verifyAfterGeneration: false,
  cache: { ttlMs: 300_000, maxEntries: 100 },
});

const result = await engine.generate({
  taskPda, agentPubkey,
  output: [1n, 2n, 3n, 4n],
  salt: engine.generateSalt(),
});
// result.fromCache, result.verified, result.proof, result.proofHash
```

### Dispute Operations

```typescript
import { DisputeOperations } from '@agenc/runtime';

const ops = new DisputeOperations({ program, agentId, logger });

const active = await ops.fetchActiveDisputes();      // memcmp-filtered
const forTask = await ops.fetchDisputesForTask(taskPda);

await ops.initiateDispute({ disputeId, taskPda, taskId, evidenceHash, resolutionType: 0, evidence: '...' });
await ops.voteOnDispute({ disputePda, taskPda, approve: true });
await ops.resolveDispute({ disputePda, taskPda, creatorPubkey, arbiterVotes: [...] });
await ops.cancelDispute(disputePda, taskPda);
await ops.expireDispute({ disputePda, taskPda, creatorPubkey, arbiterVotes: [] });
await ops.applySlash({ disputePda, taskPda, workerClaimPda, workerAgentPda });
```

## Error Handling

### RuntimeErrorCodes (31 codes)

| Code | Error Class | Phase |
|------|-------------|-------|
| `AGENT_NOT_REGISTERED` | `AgentNotRegisteredError` | 1 |
| `AGENT_ALREADY_REGISTERED` | `AgentAlreadyRegisteredError` | 1 |
| `VALIDATION_ERROR` | `ValidationError` | 1 |
| `RATE_LIMIT_ERROR` | `RateLimitError` | 1 |
| `INSUFFICIENT_STAKE` | `InsufficientStakeError` | 1 |
| `ACTIVE_TASKS_ERROR` | `ActiveTasksError` | 1 |
| `PENDING_DISPUTE_VOTES` | `PendingDisputeVotesError` | 1 |
| `RECENT_VOTE_ACTIVITY` | `RecentVoteActivityError` | 1 |
| `TASK_NOT_FOUND` | `TaskNotFoundError` | 3 |
| `TASK_NOT_CLAIMABLE` | `TaskNotClaimableError` | 3 |
| `TASK_EXECUTION_FAILED` | `TaskExecutionError` | 3 |
| `TASK_SUBMISSION_FAILED` | `TaskSubmissionError` | 3 |
| `EXECUTOR_STATE_ERROR` | `ExecutorStateError` | 3 |
| `TASK_TIMEOUT` | `TaskTimeoutError` | 3 |
| `CLAIM_EXPIRED` | — | 3 |
| `RETRY_EXHAUSTED` | — | 3 |
| `LLM_PROVIDER_ERROR` | `LLMProviderError` | 4 |
| `LLM_RATE_LIMIT` | `LLMRateLimitError` | 4 |
| `LLM_RESPONSE_CONVERSION` | `LLMResponseConversionError` | 4 |
| `LLM_TOOL_CALL_ERROR` | `LLMToolCallError` | 4 |
| `LLM_TIMEOUT` | `LLMTimeoutError` | 4 |
| `MEMORY_BACKEND_ERROR` | `MemoryBackendError` | 6 |
| `MEMORY_CONNECTION_ERROR` | `MemoryConnectionError` | 6 |
| `MEMORY_SERIALIZATION_ERROR` | `MemorySerializationError` | 6 |
| `PROOF_GENERATION_ERROR` | `ProofGenerationError` | 7 |
| `PROOF_VERIFICATION_ERROR` | `ProofVerificationError` | 7 |
| `PROOF_CACHE_ERROR` | `ProofCacheError` | 7 |
| `DISPUTE_NOT_FOUND` | `DisputeNotFoundError` | 8 |
| `DISPUTE_VOTE_ERROR` | `DisputeVoteError` | 8 |
| `DISPUTE_RESOLUTION_ERROR` | `DisputeResolutionError` | 8 |
| `DISPUTE_SLASH_ERROR` | `DisputeSlashError` | 8 |

All error classes extend `RuntimeError` which has a `code: string` field.

```typescript
import { isRuntimeError, RuntimeErrorCodes } from '@agenc/runtime';

try {
  await manager.register(params);
} catch (err) {
  if (isRuntimeError(err) && err.code === RuntimeErrorCodes.INSUFFICIENT_STAKE) {
    // Handle specific error
  }
}
```

### Anchor Error Mapping

Use `isAnchorError()` and `parseAnchorError()` for on-chain errors:

```typescript
import { isAnchorError, parseAnchorError, getAnchorErrorName } from '@agenc/runtime';

try {
  await program.methods.claimTask().rpc();
} catch (err) {
  if (isAnchorError(err)) {
    const parsed = parseAnchorError(err);
    console.log(parsed.code, parsed.name, parsed.message);
  }
}
```

## Configuration Reference

### AgentRuntimeConfig

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `connection` | `Connection` | Yes | — |
| `wallet` | `Keypair \| Wallet` | Yes | — |
| `programId` | `PublicKey` | No | `PROGRAM_ID` |
| `agentId` | `Uint8Array` | No | Random 32 bytes |
| `capabilities` | `bigint` | For new agents | — |
| `endpoint` | `string` | No | `agent://<short_id>` |
| `metadataUri` | `string` | No | — |
| `initialStake` | `bigint` | No | `0n` |
| `logLevel` | `LogLevel` | No | Silent |

### LLMProviderConfig (shared base)

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `model` | `string` | Yes | — |
| `systemPrompt` | `string` | No | — |
| `temperature` | `number` | No | — |
| `maxTokens` | `number` | No | — |
| `tools` | `LLMTool[]` | No | — |
| `timeoutMs` | `number` | No | — |
| `maxRetries` | `number` | No | — |

Provider-specific additions:
- **GrokProviderConfig**: `apiKey` (required), `baseURL`, `webSearch`, `searchMode`
- **AnthropicProviderConfig**: `apiKey` (required)
- **OllamaProviderConfig**: `baseURL` (default: `http://localhost:11434`)

### LLMTaskExecutorConfig

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `provider` | `LLMProvider` | Yes | — |
| `systemPrompt` | `string` | No | — |
| `streaming` | `boolean` | No | `false` |
| `onStreamChunk` | `StreamProgressCallback` | No | — |
| `toolHandler` | `ToolHandler` | No | — |
| `maxToolRounds` | `number` | No | `10` |
| `responseToOutput` | `(response: string) => bigint[]` | No | SHA-256 converter |
| `requiredCapabilities` | `bigint` | No | — |

### Memory Backend Configs

| Backend | Key Options | Defaults |
|---------|------------|----------|
| `InMemoryBackend` | `maxEntriesPerSession`, `maxTotalEntries`, `defaultTtlMs` | 1000, 100k, none |
| `SqliteBackend` | `dbPath`, `walMode`, `cleanupOnConnect` | `:memory:`, true, true |
| `RedisBackend` | `url` or `host`/`port`, `keyPrefix`, `connectTimeoutMs` | —, `agenc:memory:`, 5000 |

### ProofEngineConfig

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `methodId` | `Uint8Array` | Yes | Trusted image ID bytes |
| `routerConfig.routerProgram` | `PublicKey` | Yes | Trusted router program |
| `routerConfig.router` | `PublicKey` | Yes | Router PDA |
| `routerConfig.verifierEntry` | `PublicKey` | Yes | Verifier-entry PDA |
| `routerConfig.verifierProgram` | `PublicKey` | Yes | Trusted verifier program |
| `verifyAfterGeneration` | `boolean` | No | `false` |
| `cache.ttlMs` | `number` | No | `300_000` |
| `cache.maxEntries` | `number` | No | `100` |

## Runtime Pipeline Config Profiles

These profiles target the gateway runtime pipeline (`ChatExecutor` + provider adapters). Copy into `~/.agenc/config.json` and adjust secrets/ports/RPC URLs.

### Profile 1: Safe Defaults (recommended)

Use for most production channels where correctness and predictable behavior matter more than raw throughput.

```json
{
  "llm": {
    "provider": "grok",
    "apiKey": "${XAI_API_KEY}",
    "model": "grok-3",
    "timeoutMs": 60000,
    "toolCallTimeoutMs": 180000,
    "requestTimeoutMs": 600000,
    "parallelToolCalls": false,
    "contextWindowTokens": 131072,
    "promptSafetyMarginTokens": 2048,
    "promptHardMaxChars": 12000,
    "maxRuntimeHints": 4,
    "plannerEnabled": true,
    "plannerMaxTokens": 320,
    "maxToolRounds": 5,
    "toolBudgetPerRequest": 10,
    "maxModelRecallsPerRequest": 2,
    "maxFailureBudgetPerRequest": 3,
    "retryPolicy": {
      "timeout": { "maxRetries": 2 },
      "provider_error": { "maxRetries": 2 },
      "rate_limited": { "maxRetries": 3 }
    },
    "toolFailureCircuitBreaker": {
      "enabled": true,
      "threshold": 5,
      "windowMs": 300000,
      "cooldownMs": 120000
    },
    "statefulResponses": {
      "enabled": false,
      "store": false,
      "fallbackToStateless": true
    }
  }
}
```

### Profile 2: High Throughput

Use for high-volume low-latency channels where strict retries are less valuable than fast turn completion.

```json
{
  "llm": {
    "provider": "grok",
    "apiKey": "${XAI_API_KEY}",
    "model": "grok-3",
    "timeoutMs": 30000,
    "toolCallTimeoutMs": 90000,
    "requestTimeoutMs": 180000,
    "parallelToolCalls": false,
    "contextWindowTokens": 131072,
    "promptSafetyMarginTokens": 2048,
    "promptHardMaxChars": 10000,
    "maxRuntimeHints": 2,
    "plannerEnabled": false,
    "maxToolRounds": 4,
    "toolBudgetPerRequest": 8,
    "maxModelRecallsPerRequest": 1,
    "maxFailureBudgetPerRequest": 2,
    "statefulResponses": {
      "enabled": true,
      "store": false,
      "fallbackToStateless": true
    },
    "toolRouting": {
      "enabled": true,
      "minToolsPerTurn": 8,
      "maxToolsPerTurn": 24,
      "maxExpandedToolsPerTurn": 32
    }
  }
}
```

### Profile 3: Local Debug

Use during incident triage. This profile prioritizes observability and reproducibility over cost/latency.

```json
{
  "llm": {
    "provider": "grok",
    "apiKey": "${XAI_API_KEY}",
    "model": "grok-3",
    "timeoutMs": 60000,
    "toolCallTimeoutMs": 240000,
    "requestTimeoutMs": 900000,
    "parallelToolCalls": false,
    "plannerEnabled": true,
    "plannerMaxTokens": 320,
    "maxToolRounds": 6,
    "toolBudgetPerRequest": 12,
    "maxModelRecallsPerRequest": 3,
    "maxFailureBudgetPerRequest": 4,
    "statefulResponses": {
      "enabled": false,
      "store": false,
      "fallbackToStateless": true
    }
  },
  "logging": {
    "level": "info",
    "trace": {
      "enabled": true,
      "includeHistory": true,
      "includeSystemPrompt": true,
      "includeToolArgs": true,
      "includeToolResults": true,
      "maxChars": 20000
    }
  }
}
```

### Profile Selection Guide

| Profile | Best For | Tradeoff |
|---------|----------|----------|
| Safe defaults | General production | Higher latency than throughput profile |
| High throughput | High-turnover chat workloads | Less retry depth and tighter budgets |
| Local debug | Incident triage and reproductions | Large logs and higher token spend |

## Capability Constants

```typescript
import { AgentCapabilities, hasCapability, getCapabilityNames } from '@agenc/runtime';

AgentCapabilities.COMPUTE     // 1n << 0n
AgentCapabilities.INFERENCE   // 1n << 1n
AgentCapabilities.STORAGE     // 1n << 2n
AgentCapabilities.NETWORK     // 1n << 3n
AgentCapabilities.SENSOR      // 1n << 4n
AgentCapabilities.ACTUATOR    // 1n << 5n
AgentCapabilities.COORDINATOR // 1n << 6n
AgentCapabilities.ARBITER     // 1n << 7n
AgentCapabilities.VALIDATOR   // 1n << 8n
AgentCapabilities.AGGREGATOR  // 1n << 9n
```

## Examples

| Example | Path | Demonstrates |
|---------|------|-------------|
| Autonomous Agent | `examples/autonomous-agent/` | Task discovery, execution, ZK proofs |
| LLM Agent | `examples/llm-agent/` | LLM providers, tool calling, streaming |
| Dispute Arbiter | `examples/dispute-arbiter/` | DisputeOperations, voting, event monitoring |
| Memory Agent | `examples/memory-agent/` | InMemoryBackend, session threads, KV store |
| Event Dashboard | `examples/event-dashboard/` | EventMonitor, read-only mode, all event types |
| Skill Jupiter | `examples/skill-jupiter/` | JupiterSkill, swap quotes, token balances |

## Links

- [CLAUDE.md](../CLAUDE.md) — Comprehensive type signatures and architecture
- [SDK README](../sdk/README.md) — SDK usage documentation
- [Architecture](architecture.md) — System architecture overview
