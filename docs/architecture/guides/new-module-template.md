# Adding a New Runtime Module

This guide walks through creating a new module in the AgenC runtime package.

## Standard Directory Structure

Every runtime module follows this structure:

```
runtime/src/<module>/
├── types.ts              # Interfaces, config types, enums
├── errors.ts             # Module-specific error classes
├── <primary>.ts          # Main class implementation
├── <primary>.test.ts     # Vitest tests
└── index.ts              # Barrel exports
```

## Error Code Allocation

RuntimeErrorCodes are numbered 1-37 and organized by category:

- Core: 1-16
- LLM: 17-21
- Memory: 22-24
- Proof: 25-27
- Dispute: 28-31
- Workflow: 32-35
- Connection: 36-37

To add a new module error range, claim the next available codes (38+) in `runtime/src/types/errors.ts`:

```typescript
export enum RuntimeErrorCodes {
  // ... existing codes ...

  // Your module (38-41)
  YOUR_MODULE_ERROR = 'YOUR_MODULE_ERROR',
  YOUR_MODULE_VALIDATION_ERROR = 'YOUR_MODULE_VALIDATION_ERROR',
  // ...
}
```

## types.ts Pattern

Define interfaces, config types, and enums:

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';

export interface YourModuleConfig {
  maxRetries?: number;
  timeoutMs?: number;
  // Use optional fields with defaults
}

export interface YourModuleDependencies {
  connection: Connection;
  program: Program<AgencCoordination>;
  wallet: PublicKey;
  logger?: Logger;
}

export enum YourModuleStatus {
  Idle = 0,
  Active = 1,
  Error = 2,
}

export interface YourModuleResult {
  success: boolean;
  data?: Record<string, unknown>;
}
```

## errors.ts Pattern

Extend RuntimeError with typed properties:

```typescript
import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

export class YourModuleError extends RuntimeError {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(RuntimeErrorCodes.YOUR_MODULE_ERROR, message);
    this.name = 'YourModuleError';
  }
}

export class YourModuleValidationError extends RuntimeError {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value: unknown
  ) {
    super(RuntimeErrorCodes.YOUR_MODULE_VALIDATION_ERROR, message);
    this.name = 'YourModuleValidationError';
  }
}
```

## Primary Class Pattern

Constructor takes config + dependencies, async init, typed methods:

```typescript
import type { Connection, PublicKey } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type { Logger } from '../utils/logger.js';
import { YourModuleError } from './errors.js';
import type { YourModuleConfig, YourModuleResult } from './types.js';

export class YourModule {
  private connection: Connection;
  private program: Program<AgencCoordination>;
  private wallet: PublicKey;
  private logger: Logger;
  private config: Required<YourModuleConfig>;

  constructor(
    connection: Connection,
    program: Program<AgencCoordination>,
    wallet: PublicKey,
    config?: YourModuleConfig,
    logger?: Logger
  ) {
    this.connection = connection;
    this.program = program;
    this.wallet = wallet;
    this.logger = logger ?? console;

    // Apply defaults
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      timeoutMs: config?.timeoutMs ?? 30000,
    };
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing YourModule');
    // Async setup here
  }

  async performOperation(params: Record<string, unknown>): Promise<YourModuleResult> {
    try {
      // Implementation
      return { success: true };
    } catch (error) {
      throw new YourModuleError(`Operation failed: ${error}`, { params });
    }
  }

  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up YourModule');
    // Cleanup here
  }
}
```

## Test File Pattern

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { YourModule } from './your-module.js';
import { YourModuleError } from './errors.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe('YourModule', () => {
  let module: YourModule;
  let mockConnection: any;
  let mockProgram: any;

  beforeEach(() => {
    mockConnection = {
      getAccountInfo: vi.fn(),
    };

    mockProgram = {
      methods: {
        yourInstruction: vi.fn().mockReturnValue({
          accountsPartial: vi.fn().mockReturnValue({
            rpc: vi.fn().mockResolvedValue('txhash'),
          }),
        }),
      },
    };

    module = new YourModule(
      mockConnection,
      mockProgram,
      PublicKey.default,
      {},
      silentLogger
    );
  });

  it('should initialize successfully', async () => {
    await expect(module.initialize()).resolves.toBeUndefined();
  });

  it('should throw YourModuleError on failure', async () => {
    mockProgram.methods.yourInstruction = vi.fn().mockImplementation(() => {
      throw new Error('RPC error');
    });

    await expect(module.performOperation({})).rejects.toThrow(YourModuleError);
  });
});
```

## index.ts Barrel

Re-export everything:

```typescript
export * from './types.js';
export * from './errors.js';
export * from './your-module.js';
```

## Wiring into runtime/src/index.ts

Add to barrel exports:

```typescript
// Your Module
export * from './your-module/index.js';
```

## Wiring into AgentBuilder

Add fluent method in `runtime/src/builder.ts`:

```typescript
import type { YourModuleConfig } from './your-module/types.js';

export class AgentBuilder {
  private yourModuleConfig?: YourModuleConfig;

  withYourModule(config: YourModuleConfig): this {
    this.yourModuleConfig = config;
    return this;
  }

  build(): AgentRuntime {
    // In build method:
    const yourModule = new YourModule(
      this.connection,
      program,
      this.wallet.publicKey,
      this.yourModuleConfig,
      this.logger
    );

    // Pass to AgentRuntime constructor
  }
}
```

## Example: dispute/ Module

The `runtime/src/dispute/` module is a complete example:

- `types.ts`: OnChainDispute, params interfaces, status enum
- `errors.ts`: DisputeNotFoundError, DisputeVoteError, etc.
- `operations.ts`: DisputeOperations class with query + transaction methods
- `operations.test.ts`: 56 tests with mocked program
- `index.ts`: barrel exports
- Used by AutonomousAgent for arbitration
