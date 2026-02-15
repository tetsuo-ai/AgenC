# Cross-Module Integration Points

This guide covers how runtime modules integrate with each other and the broader system.

## AgentRuntime Lifecycle

`AgentRuntime` is the top-level lifecycle wrapper:

```typescript
import { AgentRuntime } from '@agenc/runtime';

const runtime = new AgentRuntime({
  connection,
  wallet,
  capabilities: AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE,
  initialStake: 1_000_000_000n,
  config: {
    scanIntervalMs: 5000,
    maxConcurrentTasks: 1,
  },
});

// Start lifecycle
await runtime.start();
// - Registers agent (if not already registered)
// - Starts autonomous agent scanner
// - Subscribes to events

// Running state
runtime.isRunning // true

// Stop lifecycle
await runtime.stop();
// - Stops autonomous agent
// - Unsubscribes from events
// - Cleans up resources
```

**Internal composition:**
- Wraps `AgentManager` for registration/updates
- Wraps `AutonomousAgent` for task scanning/execution
- Manages event subscriptions
- Coordinates cleanup

## AgentBuilder Composition

`AgentBuilder` provides fluent API for constructing runtime with dependencies:

```typescript
import { AgentBuilder } from '@agenc/runtime';

const agent = new AgentBuilder()
  // Core config
  .withConnection(connection)
  .withWallet(keypair)
  .withCapabilities(AgentCapabilities.COMPUTE)

  // LLM integration
  .withLLM('grok', {
    apiKey: process.env.GROK_API_KEY,
    model: 'grok-3',
  })

  // Memory backend
  .withMemory(memoryBackend)

  // Proof engine
  .withProofEngine(proofEngine)

  // RPC resilience
  .withRpcEndpoints([url1, url2])

  // Telemetry
  .withTelemetry(collector)

  // Policy enforcement
  .withPolicy(policyEngine)

  // Build runtime
  .build();
```

### Flow

1. Each `.with*()` method stores config
2. `.build()` constructs dependencies in order
3. Returns configured `AgentRuntime` instance

### Pattern for New Modules

```typescript
export class AgentBuilder {
  private yourModuleConfig?: YourModuleConfig;

  withYourModule(config: YourModuleConfig): this {
    this.yourModuleConfig = config;
    return this;
  }

  build(): AgentRuntime {
    // Construct shared dependencies first
    const connection = this.connection;
    const program = createProgram(this.provider);

    // Construct your module
    const yourModule = this.yourModuleConfig
      ? new YourModule(
          connection,
          program,
          this.wallet.publicKey,
          this.yourModuleConfig,
          this.logger
        )
      : undefined;

    // Pass to AgentRuntime or other consumers
    return new AgentRuntime({
      // ...
      yourModule,
    });
  }
}
```

## Telemetry Integration

`UnifiedTelemetryCollector` is passed to all module constructors:

```typescript
import { UnifiedTelemetryCollector } from '@agenc/runtime';

// Create collector
const collector = new UnifiedTelemetryCollector({
  sinks: [
    (record) => console.log(JSON.stringify(record)),
  ],
});

// Pass to modules
const module = new YourModule({
  // ...
  telemetry: collector,
});

// Module records metrics
collector.record({
  type: 'counter',
  category: 'your_module',
  name: 'operations_total',
  value: 1,
  labels: { status: 'success' },
  timestamp: Date.now(),
});

// Tests use NoopTelemetryCollector
import { NoopTelemetryCollector } from '@agenc/runtime';
const noopCollector = new NoopTelemetryCollector();
```

### Metric Types

- `counter`: Cumulative count
- `gauge`: Point-in-time value
- `histogram`: Value distribution

## Policy Integration

`PolicyEngine` enforces budgets and access control:

```typescript
import { PolicyEngine } from '@agenc/runtime';

const policy = new PolicyEngine({
  budgets: {
    llm: {
      perAction: 1_000_000n,   // Max 0.001 SOL per LLM call
      perEpoch: 10_000_000n,    // Max 0.01 SOL per hour
      total: 100_000_000n,      // Max 0.1 SOL total
    },
  },
  circuitBreaker: {
    mode: 'fail-closed',        // Fail safe on error
    errorThreshold: 5,          // Trip after 5 errors
    cooldownMs: 60000,          // 1 minute cooldown
  },
});

// Before expensive operations
await policy.checkBudget('llm', estimatedCost);

// For access control
await policy.checkAccess(wallet.publicKey, 'sensitive_operation');

// Circuit breaker wrapping
await policy.execute('task_execution', async () => {
  // Risky operation
});
```

## Event Subscription

`EventMonitor` subscribes to on-chain events:

```typescript
import { EventMonitor } from '@agenc/runtime';

const monitor = new EventMonitor(program, {
  logger,
  pollingIntervalMs: 5000,
});

// Subscribe to task events
monitor.subscribe({
  taskCreated: (event) => {
    logger.info('Task created', {
      taskId: event.taskId,
      creator: event.creator.toBase58(),
      reward: event.rewardAmount,
    });
  },
  taskCompleted: (event) => {
    logger.info('Task completed', {
      taskId: event.taskId,
      worker: event.worker.toBase58(),
    });
  },
});

await monitor.start();
// ... later
await monitor.stop();
```

**Event types** (17+ available):
- `taskCreated`, `taskClaimed`, `taskCompleted`, `taskCancelled`
- `agentRegistered`, `agentUpdated`, `agentSuspended`
- `disputeInitiated`, `disputeVoteCast`, `disputeResolved`
- etc.

**Parse functions** convert raw Anchor events (BN, number[]) to typed events (bigint, Uint8Array).

## Connection Sharing

`ConnectionManager` is a singleton, passed to all modules:

```typescript
import { ConnectionManager } from '@agenc/runtime';

const manager = new ConnectionManager({
  endpoints: [
    { url: 'https://api.mainnet-beta.solana.com', priority: 1 },
    { url: 'https://solana-api.projectserum.com', priority: 2 },
  ],
  retryConfig: {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
  },
  healthCheck: {
    intervalMs: 30000,
    timeoutMs: 5000,
  },
});

await manager.initialize();

// Get connection (automatically handles retry/failover)
const connection = manager.getConnection();

// All modules share this connection
const module1 = new TaskOperations({ connection, ... });
const module2 = new DisputeOperations({ connection, ... });
```

**Behavior:**
- Reads: full retry with exponential backoff + request coalescing
- Writes: NO retry, only failover on connection-level errors
- Health tracking: cooldown-based auto-recovery

## IDL and Program

Use factory functions from `runtime/src/idl.ts`:

```typescript
import { createProgram, createReadOnlyProgram, IDL } from '@agenc/runtime';

// With wallet (for transactions)
const program = createProgram(provider, programId);

// Read-only (for queries)
const program = createReadOnlyProgram(connection, programId);

// Raw IDL access
console.log(IDL.version); // "0.1.0"
```

**Never construct Program directly** — always use factory functions.

## Treasury Caching

Shared treasury PDA fetching via `utils/treasury.ts`:

```typescript
import { fetchTreasury } from '../utils/treasury.js';

export class TaskOperations {
  private cachedTreasury: PublicKey | null = null;

  async claimTask(taskPda: PublicKey): Promise<string> {
    // Fetch and cache treasury
    if (!this.cachedTreasury) {
      this.cachedTreasury = await fetchTreasury(this.program, this.connection);
    }

    return await this.program.methods
      .claimTask()
      .accountsPartial({
        treasury: this.cachedTreasury,
        // ...
      })
      .rpc();
  }
}
```

**Used by:** `TaskOperations`, `DisputeOperations`, `AutonomousAgent`

## Lazy Loading

Optional dependencies use `ensureLazyModule()` from `utils/lazy-import.ts`:

```typescript
import { ensureLazyModule } from '../utils/lazy-import.js';

export class SqliteBackend {
  private db: Database | null = null;

  private async ensureDb(): Promise<Database> {
    if (this.db) return this.db;

    // Lazy load better-sqlite3
    const sqlite3 = await ensureLazyModule<typeof import('better-sqlite3')>(
      'better-sqlite3',
      'SqliteBackend requires better-sqlite3'
    );

    this.db = new (sqlite3.default)(this.config.dbPath);
    return this.db;
  }
}
```

**Pattern used by:**
- LLM adapters: `openai`, `@anthropic-ai/sdk`, `ollama`
- Memory backends: `better-sqlite3`, `ioredis`

## Barrel Export Wiring

### Module index.ts

```typescript
// runtime/src/your-module/index.ts
export * from './types.js';
export * from './errors.js';
export * from './your-module.js';
```

### Runtime index.ts

```typescript
// runtime/src/index.ts

// Your Module
export * from './your-module/index.js';
```

**Result:** All types, errors, and classes exported from `@agenc/runtime`.

## Shared Utilities

| Utility | Path | Purpose |
|---------|------|---------|
| `toUint8Array()` | `utils/encoding.ts` | Buffer → Uint8Array conversion |
| `safeStringify()` | `tools/registry.ts` | JSON.stringify with bigint support |
| `fetchTreasury()` | `utils/treasury.ts` | Cached treasury PDA fetch |
| `ensureLazyModule()` | `utils/lazy-import.ts` | Dynamic import for optional deps |
| `deriveAgentPda()` | `agent/pda.ts` | Agent PDA derivation |
| `deriveTaskPda()` | `task/pda.ts` | Task PDA derivation |
| `isAnchorError()` | `types/errors.ts` | Type guard for Anchor errors |

## Module Dependency Graph

```
AgentRuntime
├── AgentManager
│   ├── Connection
│   └── Program
├── AutonomousAgent
│   ├── TaskOperations
│   │   ├── ProofEngine
│   │   └── Treasury
│   ├── LLMTaskExecutor
│   │   ├── LLMProvider (Grok/Anthropic/Ollama)
│   │   ├── ToolRegistry
│   │   └── MemoryBackend
│   ├── DisputeOperations
│   └── PolicyEngine
└── EventMonitor
```

## Common Integration Pattern

```typescript
export class YourModule {
  constructor(
    private connection: Connection,
    private program: Program<AgencCoordination>,
    private wallet: PublicKey,
    config?: YourModuleConfig,
    private logger?: Logger,
    private telemetry?: TelemetryCollector,
    private policy?: PolicyEngine
  ) {
    this.logger = logger ?? console;
    this.telemetry = telemetry ?? new NoopTelemetryCollector();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async operation(): Promise<void> {
    // Policy check
    if (this.policy) {
      await this.policy.checkBudget('your_module', estimatedCost);
    }

    // Telemetry
    this.telemetry.record({
      type: 'counter',
      category: 'your_module',
      name: 'operations_started',
      value: 1,
      timestamp: Date.now(),
    });

    // Operation logic
    try {
      // ...
      this.telemetry.record({ /* success metric */ });
    } catch (error) {
      this.logger.error('Operation failed', error);
      this.telemetry.record({ /* error metric */ });
      throw new YourModuleError('Operation failed');
    }
  }
}
```
