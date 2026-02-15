# Type Conventions

This guide covers TypeScript type conventions used throughout the AgenC runtime.

## bigint: On-Chain u64 Values

Use `bigint` for all on-chain u64 values:

- Capabilities: `1n << 0n`, `1n << 1n`, etc.
- Stake amounts: `1_000_000_000n` (1 SOL)
- Reward amounts: `5_000_000n` (0.005 SOL)
- Task IDs (numeric form): `12345n`

**Always use bigint literals:**

```typescript
const capabilities = AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE; // 3n
const minStake = 1_000_000_000n;
const zero = 0n;

// Never mix with number
const wrong = capabilities + 1; // Type error
const right = capabilities + 1n; // OK
```

## BN: Anchor Instruction Boundary Only

`BN` (from `@coral-xyz/anchor`) is only used at the Anchor instruction boundary:

```typescript
import BN from 'bn.js';

// bigint → BN (for instruction params)
const amount: bigint = 1_000_000_000n;
const amountBN = new BN(amount.toString());

await program.methods
  .registerAgent(agentId, amountBN, capabilities)
  .rpc();

// BN → bigint (from account data)
const agentAccount = await program.account.agentRegistration.fetch(pda);
const stake: bigint = BigInt(agentAccount.stakeAmount.toString());
```

**Never store BN in state.** Convert to bigint immediately after fetching.

## number: Small Values Only

Use `number` only for:

- Status enums: `TaskStatus.Open = 0`, `TaskStatus.Completed = 3`
- Small counts: `activeTasks: number`, `voteCount: number`
- Timestamps (seconds): `Math.floor(Date.now() / 1000)`

**Never use for amounts or IDs.**

## Uint8Array: Binary Data

All binary data uses `Uint8Array`:

- Agent IDs: `Uint8Array` (32 bytes)
- Task IDs: `Uint8Array` (32 bytes)
- Proofs: `Uint8Array` (256 bytes for Groth16)
- Hashes: `Uint8Array` (32 bytes)
- Nullifiers: `Uint8Array` (32 bytes)

**Never use Buffer directly.** Use `toUint8Array()` from `utils/encoding.ts`:

```typescript
import { toUint8Array } from '../utils/encoding.js';

// Convert Buffer to Uint8Array
const buffer = Buffer.from('data');
const bytes = toUint8Array(buffer);

// From event (number[] or Buffer)
function parseEvent(raw: RawEvent): Event {
  return {
    agentId: toUint8Array(raw.agentId),
    taskId: toUint8Array(raw.taskId),
  };
}
```

## PublicKey: Solana Addresses

Use `PublicKey` for all Solana addresses:

```typescript
import { PublicKey } from '@solana/web3.js';

interface AgentState {
  authority: PublicKey; // Not string
  agentPda: PublicKey;
}

// Only convert to string for display/logging
logger.info(`Agent PDA: ${agentPda.toBase58()}`);

// Never store as string except in JSON
const json = {
  agentPda: agentPda.toBase58(),
};
```

## string: Display and Logging Only

Use `string` only for:

- Log messages
- Human-readable descriptions
- Display formatting
- JSON serialization (convert from PublicKey/bigint)

**Never use for on-chain IDs or amounts.**

## Record<string, unknown>: Metadata Bags

For arbitrary metadata and config objects:

```typescript
interface TaskParams {
  requiredCapabilities: bigint;
  metadata?: Record<string, unknown>; // Flexible metadata
}

interface ToolResult {
  content: string;
  metadata?: Record<string, unknown>; // Tool-specific data
}
```

## JSON Serialization: safeStringify

Use `safeStringify()` from `runtime/src/tools/registry.ts` for any data with bigint:

```typescript
import { safeStringify } from './tools/registry.js';

const data = {
  capabilities: 1n << 0n,
  stake: 1_000_000_000n,
  agentId: new Uint8Array(32),
};

// JSON.stringify throws on bigint
const wrong = JSON.stringify(data); // Error

// safeStringify converts bigint → string
const right = safeStringify(data); // OK
```

## Anchor IDL Types

Use `Idl` for raw JSON, `AgencCoordination` for `Program<T>` generics:

```typescript
import { Idl, Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from './types/agenc_coordination.js';
import idlJson from '../idl/agenc_coordination.json';

// Raw JSON (snake_case fields)
export const IDL: Idl = idlJson as Idl;

// Program generic (camelCase methods)
export function createProgram(provider: AnchorProvider): Program<AgencCoordination> {
  return new Program<AgencCoordination>(IDL as AgencCoordination, provider);
}
```

**Key difference:**
- `IDL` (type `Idl`): matches JSON structure, used for Program constructor
- `AgencCoordination`: TypeScript types for `.methods`, `.account`, etc.

## Event Types: Raw vs Parsed

Anchor events have raw types (BN, number[]) that must be parsed:

```typescript
// Raw event from Anchor (BN, number[], etc.)
interface RawTaskCreatedEvent {
  taskId: number[] | Uint8Array;
  creator: PublicKey;
  rewardAmount: { toString: () => string }; // BN
  timestamp: { toNumber: () => number }; // BN
}

// Parsed event (bigint, Uint8Array, number)
interface TaskCreatedEvent {
  taskId: Uint8Array;
  creator: PublicKey;
  rewardAmount: bigint;
  timestamp: number;
}

// Parse function
function parseTaskCreatedEvent(raw: RawTaskCreatedEvent): TaskCreatedEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    creator: raw.creator,
    rewardAmount: BigInt(raw.rewardAmount.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}
```

**Naming convention:** Prefix raw types with `Raw*`.

## Type Summary Table

| Type | Use For | Never Use For |
|------|---------|---------------|
| `bigint` | Amounts, capabilities, on-chain u64 | Counts, timestamps |
| `BN` | Anchor instruction params only | State, storage |
| `number` | Enums, counts, timestamps (seconds) | Amounts, IDs |
| `Uint8Array` | Binary data, hashes, proofs | Text, JSON |
| `PublicKey` | Solana addresses | Storage as string |
| `string` | Display, logs, JSON keys | On-chain IDs, amounts |
| `Record<string, unknown>` | Metadata, config bags | Typed structures |

## Conversion Reference

```typescript
// bigint ↔ BN
new BN(amount.toString())     // bigint → BN
BigInt(bn.toString())         // BN → bigint

// Buffer ↔ Uint8Array
toUint8Array(buffer)          // Buffer → Uint8Array
Buffer.from(bytes)            // Uint8Array → Buffer

// PublicKey ↔ string
pubkey.toBase58()             // PublicKey → string
new PublicKey(str)            // string → PublicKey

// bigint → JSON
safeStringify({ val: 1n })   // { val: "1" }
```
