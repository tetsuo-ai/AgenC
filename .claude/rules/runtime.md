# @agenc/runtime Development Guide

## Overview

The `@agenc/runtime` package provides agent lifecycle management infrastructure for the AgenC protocol. It depends on `@agenc/sdk` and provides higher-level abstractions for agent operations.

## Architecture

```
runtime/
├── src/
│   ├── index.ts           # Main exports (re-exports from all modules)
│   ├── idl.ts             # IDL loading + Program factory functions
│   ├── agent/             # Agent-specific modules
│   │   ├── index.ts       # Agent module exports
│   │   ├── manager.ts     # AgentManager class (main entry point)
│   │   ├── events.ts      # Event subscription utilities
│   │   ├── pda.ts         # PDA derivation helpers
│   │   ├── types.ts       # Agent types, status enum, capability masks
│   │   └── capabilities.ts # AgentCapabilities constants
│   ├── types/             # Shared types
│   │   ├── index.ts       # Type re-exports
│   │   ├── errors.ts      # RuntimeError classes
│   │   ├── wallet.ts      # Wallet interface + keypair loaders
│   │   ├── protocol.ts    # ProtocolConfig type + parser
│   │   └── agenc_coordination.ts # Generated IDL TypeScript types
│   └── utils/             # Utility modules
│       ├── index.ts       # Utility re-exports
│       ├── encoding.ts    # ID generation, hex/bytes, SOL conversion
│       └── logger.ts      # Logger interface + factory
├── idl/
│   └── agenc_coordination.json # Copied from target/idl/
├── tests/                 # Standalone test suites
│   ├── agent-manager.test.ts  # AgentManager unit tests (64 tests)
│   └── integration.test.ts    # Integration tests with local validator (8 tests)
└── dist/                  # Build output (ESM + CJS)
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

## Testing

Tests use Vitest. Unit tests are co-located with source, and integration/standalone tests are in `runtime/tests/`:

```bash
# Run all tests
npm run test

# Watch mode
npm run test:watch

# Run specific test
npx vitest run src/agent/manager.test.ts
```

**Unit test files (co-located with source):**
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

**Standalone test files (in `runtime/tests/`):**
- `tests/agent-manager.test.ts` - AgentManager unit tests (64 tests)
- `tests/integration.test.ts` - Integration tests with local validator (8 tests)

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

## Phase 1 Status

Phase 1 is **COMPLETE** - all 16 sections implemented and merged ([#127](https://github.com/tetsuo-ai/AgenC/issues/127)).

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
