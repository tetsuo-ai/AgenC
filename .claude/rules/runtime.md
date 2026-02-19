# @agenc/runtime Development Guide

## Overview

The `@agenc/runtime` package provides agent lifecycle management infrastructure for the AgenC protocol. It depends on `@agenc/sdk` and provides higher-level abstractions for agent operations.

## Architecture

```
runtime/
├── src/
│   ├── index.ts            # Barrel exports
│   ├── idl.ts              # IDL loading + Program factory functions
│   ├── runtime.ts          # AgentRuntime lifecycle wrapper
│   ├── builder.ts          # AgentBuilder fluent API
│   ├── bin/                # CLI entry (agenc-runtime)
│   ├── cli/                # CLI commands (health, onboard, replay)
│   ├── agent/              # Agent management (manager, events, PDA, capabilities)
│   ├── autonomous/         # Autonomous agents (scanner, verifier, risk scoring)
│   ├── task/               # Task operations + speculative executor
│   ├── events/             # Event monitor + parsing + IDL drift checks
│   ├── replay/             # Replay store + projector + incident reconstruction
│   ├── eval/               # Benchmarks + mutation harness + replay comparison
│   ├── llm/                # Provider adapters + tool-calling loop
│   ├── tools/              # Tool registry + built-in AgenC tools + skill adapter
│   ├── memory/             # Memory backends (InMemory, SQLite, Redis)
│   ├── proof/              # ZK proof engine (caching, stats)
│   ├── dispute/            # Dispute operations + queries
│   ├── workflow/           # DAG orchestration + compiler
│   ├── connection/         # Resilient RPC (retry, failover, coalescing)
│   ├── marketplace/        # Task bidding marketplace
│   ├── team/               # Team contracts + payouts + audits
│   ├── policy/             # Budget enforcement + risk policies
│   ├── skills/             # Skill registry + adapters
│   ├── telemetry/          # Metrics collection + sinks
│   ├── types/              # Shared types (errors, wallet, protocol, IDL types)
│   └── utils/              # Shared utilities
├── tests/                  # Integration tests + fixtures (vitest)
├── scripts/                # Benchmarks + mutation CLI scripts
├── benchmarks/             # Benchmark corpus + artifacts
├── docs/                   # Runbooks + CLI docs
├── idl/                    # Copied from target/idl/
└── dist/                   # Build output
```

## Key Patterns

### IDL Type Handling

The runtime uses `Idl` type for raw JSON and `AgencCoordination` for `Program<T>` generics:

```typescript
import { Idl, Program, AnchorProvider } from '@coral-xyz/anchor';
import type { AgencCoordination } from './types/agenc_coordination.js';
import idlJson from '../idl/agenc_coordination.json';

// IDL typed as generic Idl (matches snake_case JSON)
export const IDL: Idl = idlJson as Idl;

// Program uses AgencCoordination generic for type-safe methods
export function createProgram(
  provider: AnchorProvider,
  programId?: PublicKey
): Program<AgencCoordination> {
  const idl = programId ? { ...IDL, address: programId.toBase58() } : IDL;
  return new Program<AgencCoordination>(idl as AgencCoordination, provider);
}
```

### Event Subscription Pattern

Events are subscribed with type-safe callbacks:

```typescript
// Raw event types from Anchor (BN, number[], etc.)
interface RawAgentRegisteredEvent {
  agentId: number[] | Uint8Array;
  authority: PublicKey;
  capabilities: { toString: () => string };
  timestamp: { toNumber: () => number };
}

// Parsed event types (bigint, Uint8Array, etc.)
interface AgentRegisteredEvent {
  agentId: Uint8Array;
  authority: PublicKey;
  capabilities: bigint;
  timestamp: number;
}

// Parse function converts raw to typed
function parseAgentRegisteredEvent(raw: RawAgentRegisteredEvent): AgentRegisteredEvent
```

### Error Handling

Custom error classes for specific failure modes:

```typescript
// Base class
class RuntimeError extends Error {
  code: string;
}

// Specific errors with typed properties
class InsufficientStakeError extends RuntimeError {
  required: bigint;
  provided: bigint;
}

class ActiveTasksError extends RuntimeError {
  taskCount: number;
}
```

### Capability Bitmask

Capabilities use bigint to match the on-chain u64:

```typescript
export const AgentCapabilities = {
  COMPUTE: 1n << 0n,
  INFERENCE: 1n << 1n,
  STORAGE: 1n << 2n,
  // ... etc
} as const;

// Type-safe checks
export function hasCapability(mask: bigint, cap: bigint): boolean {
  return (mask & cap) !== 0n;
}
```

## Implementation Notes

### AgentManager State

AgentManager caches state locally but always fetches fresh on `getState()`:

- `cachedState` - Last fetched AgentState
- `agentPda` - Derived PDA address
- `agentId` - 32-byte agent identifier

### Subscription Leak Prevention

AgentManager automatically cleans up previous subscriptions:

```typescript
subscribeToEvents(callbacks: AgentEventCallbacks): EventSubscription {
  // Clean up previous subscription to prevent leaks
  if (this.eventSubscription) {
    void this.eventSubscription.unsubscribe();
    this.eventSubscription = null;
  }
  // ... create new subscription
}
```

### Read-Only Program

For queries without a wallet:

```typescript
export function createReadOnlyProgram(
  connection: Connection,
  programId?: PublicKey
): Program<AgencCoordination> {
  // Uses a dummy wallet that throws on sign
}
```

## Tool System (Phase 5)

MCP-compatible tool registry bridging Skills ↔ LLM adapters.

### Key Types

```typescript
interface Tool {
  readonly name: string;           // namespaced: "jupiter.getQuote", "agenc.listTasks"
  readonly description: string;
  readonly inputSchema: JSONSchema; // Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: string;      // JSON string or plain text
  isError?: boolean;    // true = error (content has error message)
}
```

### ToolRegistry

```typescript
const registry = new ToolRegistry({ logger });
registry.register(tool);
registry.registerAll(tools);
registry.toLLMTools();           // → LLMTool[] for provider config
registry.createToolHandler();    // → ToolHandler for LLMTaskExecutor
```

### Skill-to-Tool Adapter

```typescript
// Requires SkillState.Ready; actions without schema entries are skipped
const tools = skillToTools(jupiterSkill, { schemas: JUPITER_ACTION_SCHEMAS });
```

### Built-in AgenC Tools

```typescript
// Creates 4 tools sharing one TaskOperations instance
const tools = createAgencTools({ connection, program, logger });
```

- `agenc.listTasks` — uses `fetchClaimableTasks()` (memcmp) for open/in_progress
- `agenc.getTask` — validates base58, returns `{ isError: true }` on invalid input
- `agenc.getAgent` — same base58 validation pattern
- `agenc.getProtocolConfig` — no params, derives PDA internally

### Critical: safeStringify

`JSON.stringify` throws on bigint. All tool results use `safeStringify()` which converts bigint to string. This applies to skill adapter results and all built-in tool responses.

## Memory Backends (Phase 6)

Pluggable memory storage for conversation history and key-value state. PR #775.

### Architecture

```
runtime/src/memory/
├── types.ts              # MemoryBackend interface, MemoryEntry, entryToMessage/messageToEntryOptions
├── errors.ts             # MemoryBackendError, MemoryConnectionError, MemorySerializationError
├── index.ts              # Module barrel
├── in-memory/            # Zero-dep Map-based backend
│   ├── backend.ts        # InMemoryBackend
│   └── backend.test.ts   # 38 tests
├── sqlite/               # Optional better-sqlite3
│   ├── backend.ts        # SqliteBackend
│   ├── types.ts          # SqliteBackendConfig
│   └── backend.test.ts   # 29 tests
└── redis/                # Optional ioredis
    ├── backend.ts        # RedisBackend
    ├── types.ts          # RedisBackendConfig
    └── backend.test.ts   # 38 tests
```

### Key Patterns

- Same lazy loading as LLM adapters: `ensureDb()` / `ensureClient()` with dynamic `import()`
- `MemoryEntry` is independent of `LLMMessage` — bridge via `entryToMessage()` / `messageToEntryOptions()`
- InMemory: `Map<string, MemoryEntry[]>` for threads, `Map<string, KVEntry>` for KV, lazy TTL expiry on read
- SQLite: WAL mode, prepared statements, `cleanupOnConnect` deletes expired rows, all SELECTs filter `(expires_at IS NULL OR expires_at > ?)`
- Redis: sorted sets `{prefix}thread:{sessionId}` (score=timestamp), native `PEXPIRE`, sessions tracked in set `{prefix}sessions`
- "Not found" returns empty results (`[]`, `0`, `undefined`) — never throws
- Error classes use RuntimeErrorCodes 22-24 (MEMORY_BACKEND_ERROR, MEMORY_CONNECTION_ERROR, MEMORY_SERIALIZATION_ERROR)

### Configuration

| Backend | Config | Key Options |
|---------|--------|-------------|
| InMemoryBackend | `InMemoryBackendConfig` | `maxEntriesPerSession` (1000), `maxTotalEntries` (100k), `defaultTtlMs` |
| SqliteBackend | `SqliteBackendConfig` | `dbPath` (':memory:'), `walMode` (true), `cleanupOnConnect` (true) |
| RedisBackend | `RedisBackendConfig` | `url` or `host`/`port`, `keyPrefix` ('agenc:memory:'), `connectTimeoutMs` (5000) |

## ZK Proof Engine (Phase 7)

ProofEngine wraps SDK proof functions with caching, stats, and error wrapping.

### Architecture

```
runtime/src/proof/
├── types.ts              # ProofEngineConfig, ProofInputs, EngineProofResult, ProofEngineStats
├── errors.ts             # ProofGenerationError, ProofVerificationError, ProofCacheError
├── cache.ts              # ProofCache (in-memory TTL + LRU eviction), deriveCacheKey()
├── engine.ts             # ProofEngine (implements ProofGenerator)
├── engine.test.ts        # 37 tests (fully mocked SDK)
└── index.ts              # Module barrel
```

### Key Patterns

- Static SDK imports (not lazy) — same pattern as `AutonomousAgent`
- `ProofEngine` implements `ProofGenerator` from `task/proof-pipeline.ts`
- Buffer → Uint8Array conversion for runtime consistency
- Cache key: `taskPda.toBase58()|agentPubkey.toBase58()|output[0]|...|output[3]|salt`
- Cache is optional: omit `config.cache` to disable
- Error classes use RuntimeErrorCodes 25-27 (PROOF_GENERATION_ERROR, PROOF_VERIFICATION_ERROR, PROOF_CACHE_ERROR)
- `generate()` flow: check cache → SDK `generateProof()` → optional verify → cache → return
- `ProofGenerator` interface: `generatePublicProof()` returns `result.proofHash`, `generatePrivateProof()` returns `result.proof`

### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `proofProgramPath` | `string` | `'./circuits-legacy-circuit/task_completion'` | Circuit directory path |
| `verifyAfterGeneration` | `boolean` | `false` | Verify proof after generation |
| `cache.ttlMs` | `number` | `300_000` | Cache TTL in ms |
| `cache.maxEntries` | `number` | `100` | Max cached entries |

## Dispute Operations (Phase 8)

DisputeOperations wraps 6 on-chain dispute instructions with PDA derivation, error mapping, and queries. PR #777.

### Architecture

```
runtime/src/dispute/
├── types.ts              # OnChainDispute, OnChainDisputeVote, params, parse functions, status enum
├── pda.ts                # deriveDisputePda, deriveVotePda + find helpers
├── errors.ts             # DisputeNotFoundError, DisputeVoteError, DisputeResolutionError, DisputeSlashError
├── operations.ts         # DisputeOperations class (query + transactions)
├── operations.test.ts    # 56 tests (mocked program)
└── index.ts              # Module barrel
```

### Key Patterns

- Follows same patterns as `TaskOperations` (treasury caching, memcmp queries, error mapping)
- `DisputeOperations` constructor caches `agentPda` and `protocolPda` eagerly
- `buildRemainingAccounts()` private helper — arbiter (vote, agent) pairs then worker (claim, agent) pairs, all writable non-signer
- Parse functions handle Anchor enum objects: `{ refund: {} }` → `ResolutionType.Refund`, `{ active: {} }` → `OnChainDisputeStatus.Active`
- Anchor error codes are sequential (`6000 + enum index` in `programs/agenc-coordination/src/errors.rs`); the runtime's `AnchorErrorCodes` mapping (`types/errors.ts`) is intentionally partial and may drift
- `cancelDispute` has minimal accounts (dispute, task, authority) — no system_program, no protocolConfig
- `expireDispute` and `applySlash` are permissionless — no Signer constraint
- Error classes use RuntimeErrorCodes 28-31 (DISPUTE_NOT_FOUND, DISPUTE_VOTE_ERROR, DISPUTE_RESOLUTION_ERROR, DISPUTE_SLASH_ERROR)

### Account Layout Constants

| Constant | Value | Usage |
|----------|-------|-------|
| `DISPUTE_STATUS_OFFSET` | `169` | memcmp filter for `fetchActiveDisputes()` |
| `DISPUTE_TASK_OFFSET` | `40` | memcmp filter for `fetchDisputesForTask()` |

### Reused Existing Code

| What | Where |
|------|-------|
| `deriveAuthorityVotePda` | `agent/pda.ts` — seeds `["authority_vote", disputePda, authority]` |
| `deriveEscrowPda`, `deriveClaimPda` | `task/pda.ts` |
| `findProtocolPda`, `findAgentPda` | `agent/pda.ts` |
| `ResolutionType` enum | `events/types.ts` |
| `isAnchorError`, `AnchorErrorCodes` | `types/errors.ts` |

## Testing

Tests use Vitest:

```bash
cd runtime

# Run all tests
npm run test

# Watch mode
npm run test:watch

# Run specific test
npx vitest run src/agent/manager.test.ts
```

Test files:
- `src/types/errors.test.ts` - Error class tests
- `src/types/wallet.test.ts` - Wallet utility tests
- `src/types/protocol.test.ts` - Protocol parsing tests
- `src/agent/types.test.ts` - Agent type tests
- `src/agent/capabilities.test.ts` - Capability tests
- `src/agent/pda.test.ts` - PDA derivation tests
- `src/agent/events.test.ts` - Event subscription tests
- `src/agent/manager.test.ts` - AgentManager tests
- `src/utils/encoding.test.ts` - Encoding utility tests
- `src/utils/logger.test.ts` - Logger tests
- `src/idl.test.ts` - IDL loading tests
- `src/tools/registry.test.ts` - Tool registry tests
- `src/tools/skill-adapter.test.ts` - Skill-to-tool adapter tests
- `src/tools/agenc/agenc-tools.test.ts` - Built-in AgenC tools tests
- `src/memory/in-memory/backend.test.ts` - InMemory backend tests
- `src/memory/sqlite/backend.test.ts` - SQLite backend tests (mocked)
- `src/memory/redis/backend.test.ts` - Redis backend tests (mocked)
- `src/proof/engine.test.ts` - ProofEngine tests (mocked SDK)
- `src/dispute/operations.test.ts` - DisputeOperations tests (mocked program)

## Dependencies

Runtime depends on SDK:

```json
{
  "dependencies": {
    "@agenc/sdk": "file:../sdk"
  },
  "peerDependencies": {
    "@coral-xyz/anchor": ">=0.29.0",
    "@solana/web3.js": ">=1.90.0"
  }
}
```

SDK provides:
- `PROGRAM_ID`, `VERIFIER_PROGRAM_ID` - Program addresses
- `DEVNET_RPC`, `MAINNET_RPC` - RPC endpoints
- `SEEDS` - PDA seed constants
- `TaskState`, `TaskStatus` - Task enums

## Common Tasks

### Adding a New Type

1. Add to appropriate file in `src/types/` or `src/agent/`
2. Export from module's `index.ts`
3. Re-export from `src/index.ts` if public API
4. Add tests in `*.test.ts` file

### Adding a New Utility

1. Add to `src/utils/` (or `src/agent/` if agent-specific)
2. Export from `src/utils/index.ts`
3. Re-export from `src/index.ts` if public API
4. Add unit tests

### Updating IDL

1. Run `anchor build` in root
2. Run `npm run prebuild` in runtime/ to copy IDL
3. Regenerate types if needed
