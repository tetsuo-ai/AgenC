# Testing Patterns

This guide covers testing patterns for the AgenC runtime using Vitest.

## Vitest Setup

Each module has co-located `.test.ts` files:

```
runtime/src/agent/
├── manager.ts
├── manager.test.ts       # Tests for manager.ts
├── events.ts
└── events.test.ts        # Tests for events.ts
```

Configuration in `runtime/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 30000,
  },
});
```

## Mocking Program

Standard mock for Anchor Program:

```typescript
import { vi } from 'vitest';

const mockProgram = {
  methods: {
    registerAgent: vi.fn().mockReturnValue({
      accountsPartial: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue('txhash'),
      }),
    }),
    updateAgent: vi.fn().mockReturnValue({
      accountsPartial: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue('txhash'),
      }),
    }),
  },
  account: {
    agentRegistration: {
      fetch: vi.fn().mockResolvedValue({
        authority: PublicKey.default,
        stakeAmount: new BN(1000000000),
        capabilities: new BN(1),
        status: { active: {} },
      }),
    },
    taskState: {
      fetch: vi.fn(),
    },
  },
  addEventListener: vi.fn().mockReturnValue(1),
  removeEventListener: vi.fn(),
};
```

**Pattern:** Each instruction returns `{ accountsPartial: ..., rpc: ... }` chain.

## Mocking Connection

Standard mock for Solana Connection:

```typescript
const mockConnection = {
  getAccountInfo: vi.fn().mockResolvedValue({
    owner: PublicKey.default,
    lamports: 1000000000,
    data: Buffer.from([]),
    executable: false,
  }),
  getProgramAccounts: vi.fn().mockResolvedValue([]),
  getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(890880),
  getLatestBlockhash: vi.fn().mockResolvedValue({
    blockhash: 'hash',
    lastValidBlockHeight: 1000,
  }),
  sendTransaction: vi.fn().mockResolvedValue('txhash'),
  confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
};
```

## silentLogger: Suppress Test Output

Use `silentLogger` to prevent console spam during tests:

```typescript
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Pass to constructors
const agent = new AutonomousAgent({
  connection: mockConnection,
  wallet: keypair,
  capabilities: 1n,
  executor,
  logger: silentLogger,
});
```

## InMemoryBackend for Memory Tests

For tests requiring memory, use `InMemoryBackend` (zero external deps):

```typescript
import { InMemoryBackend } from '../memory/in-memory/backend.js';

const memory = new InMemoryBackend({
  maxEntriesPerSession: 100,
  logger: silentLogger,
});

await memory.initialize();
// Use in tests
await memory.cleanup();
```

**Never use SQLite or Redis backends in tests** (require external deps).

## NoopTelemetryCollector for Tests

Suppress telemetry in tests:

```typescript
import { NoopTelemetryCollector } from '../telemetry/noop.js';

const collector = new NoopTelemetryCollector();

const module = new YourModule({
  // ...
  telemetry: collector,
});
```

## LiteSVM Integration Test Patterns

For integration tests in `tests/`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createLiteSVMContext,
  fundAccount,
  advanceClock,
  getClockTimestamp,
} from './litesvm-helpers.js';
import {
  CAPABILITY_COMPUTE,
  deriveAgentPda,
  deriveTaskPda,
} from './test-utils.js';

describe('Integration Tests', () => {
  let svm: any;
  let program: Program<AgencCoordination>;
  let wallet: Keypair;

  beforeEach(async () => {
    const ctx = await createLiteSVMContext();
    svm = ctx.svm;
    program = ctx.program;
    wallet = ctx.payer;

    await fundAccount(svm, wallet.publicKey, 10_000_000_000n);
  });

  it('should register agent', async () => {
    const agentPda = deriveAgentPda(agentId, program.programId);

    await program.methods
      .registerAgent(agentId, new BN('1000000000'), new BN(CAPABILITY_COMPUTE))
      .accountsPartial({ authority: wallet.publicKey })
      .rpc();

    const agent = await program.account.agentRegistration.fetch(agentPda);
    expect(agent.authority.toBase58()).toBe(wallet.publicKey.toBase58());
  });
});
```

## LiteSVM Critical Gotchas

### Clock Doesn't Auto-Advance

The clock stays frozen unless explicitly advanced:

```typescript
// Create agent
await program.methods.registerAgent(...).rpc();

// This will FAIL (60s cooldown not elapsed)
await program.methods.updateAgent(...).rpc();

// Must advance clock first
await advanceClock(svm, 61); // Advance 61 seconds

// Now this succeeds
await program.methods.updateAgent(...).rpc();
```

### Use getClockTimestamp(), Not Date.now()

Clock drift accumulates during tests:

```typescript
// WRONG: Uses system time
const deadline = Math.floor(Date.now() / 1000) + 3600;

// RIGHT: Uses on-chain clock
const currentTime = await getClockTimestamp(svm);
const deadline = currentTime + 3600;
```

### SPL Token Tests Need Default Programs

```typescript
const ctx = await createLiteSVMContext();
const svm = ctx.svm.withDefaultPrograms(); // Required for SPL
```

## Test Constants from test-utils.ts

Use canonical constants from `tests/test-utils.ts`:

```typescript
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COLLABORATIVE,
  RESOLUTION_TYPE_REFUND,
  deriveAgentPda,
  deriveTaskPda,
  deriveDisputePda,
} from './test-utils.js';

// Capabilities (bitmask)
const capabilities = CAPABILITY_COMPUTE | CAPABILITY_INFERENCE;

// Task type
const taskType = TASK_TYPE_EXCLUSIVE;

// PDAs (all take programId)
const agentPda = deriveAgentPda(agentId, program.programId);
const taskPda = deriveTaskPda(creator, taskId, program.programId);
```

**Never hardcode constants** — always import from `test-utils.ts`.

## Error Testing

Test that specific error classes are thrown:

```typescript
import { InsufficientStakeError } from '../types/errors.js';

it('should throw InsufficientStakeError', async () => {
  await expect(
    manager.register(agentId, 100n, capabilities) // Too little stake
  ).rejects.toThrow(InsufficientStakeError);
});

it('should include error code', async () => {
  try {
    await manager.register(agentId, 100n, capabilities);
    expect.fail('Should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(InsufficientStakeError);
    expect(error.code).toBe(RuntimeErrorCodes.INSUFFICIENT_STAKE);
    expect(error.required).toBe(1_000_000_000n);
    expect(error.provided).toBe(100n);
  }
});
```

## Snapshot Testing for Event Parsing

For complex event structures:

```typescript
import { expect, it } from 'vitest';

it('should parse event correctly', () => {
  const rawEvent = {
    taskId: [1, 2, 3, /* ... */ 32],
    creator: PublicKey.default,
    rewardAmount: new BN('1000000000'),
    timestamp: new BN(1234567890),
  };

  const parsed = parseTaskCreatedEvent(rawEvent);

  expect(parsed).toMatchSnapshot();
});
```

## Test Organization Pattern

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('YourModule', () => {
  let module: YourModule;
  let mockConnection: any;
  let mockProgram: any;

  beforeEach(() => {
    // Setup mocks
    mockConnection = { /* ... */ };
    mockProgram = { /* ... */ };

    module = new YourModule(
      mockConnection,
      mockProgram,
      PublicKey.default,
      {},
      silentLogger
    );
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      await expect(module.initialize()).resolves.toBeUndefined();
    });
  });

  describe('operations', () => {
    it('should perform operation', async () => {
      const result = await module.performOperation({});
      expect(result.success).toBe(true);
    });

    it('should handle errors', async () => {
      mockProgram.methods.instruction = vi.fn().mockImplementation(() => {
        throw new Error('RPC error');
      });

      await expect(module.performOperation({})).rejects.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources', async () => {
      await expect(module.cleanup()).resolves.toBeUndefined();
    });
  });
});
```

## Runtime Test Commands

```bash
# Run all tests
cd runtime && npm run test

# Watch mode
npm run test:watch

# Specific file
npx vitest run src/agent/manager.test.ts

# With coverage
npm run test -- --coverage
```

## Integration Test Commands

```bash
# LiteSVM integration tests (~5s, 163 tests)
npm run test:fast

# Specific test file
npx ts-mocha tests/test_1.ts
```
