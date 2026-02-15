# Error Handling Patterns

This guide covers error handling conventions in the AgenC runtime.

## RuntimeErrorCodes Enum

All runtime errors use codes from the `RuntimeErrorCodes` enum in `runtime/src/types/errors.ts`.

### Current Allocation (37 codes)

```typescript
export enum RuntimeErrorCodes {
  // Core (1-16)
  AGENT_NOT_REGISTERED = 'AGENT_NOT_REGISTERED',                     // 1
  VALIDATION_ERROR = 'VALIDATION_ERROR',                             // 2
  INSUFFICIENT_STAKE = 'INSUFFICIENT_STAKE',                         // 3
  ACTIVE_TASKS_ERROR = 'ACTIVE_TASKS_ERROR',                         // 4
  TASK_NOT_FOUND = 'TASK_NOT_FOUND',                                 // 5
  TASK_ALREADY_CLAIMED = 'TASK_ALREADY_CLAIMED',                     // 6
  UNAUTHORIZED = 'UNAUTHORIZED',                                     // 7
  INVALID_STATE = 'INVALID_STATE',                                   // 8
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',                           // 9
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',                         // 10
  PROOF_INVALID = 'PROOF_INVALID',                                   // 11
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',                                   // 12
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',                       // 13
  DEPENDENCY_ERROR = 'DEPENDENCY_ERROR',                             // 14
  RPC_ERROR = 'RPC_ERROR',                                           // 15
  SERIALIZATION_ERROR = 'SERIALIZATION_ERROR',                       // 16

  // LLM (17-21)
  LLM_PROVIDER_ERROR = 'LLM_PROVIDER_ERROR',                         // 17
  LLM_RESPONSE_ERROR = 'LLM_RESPONSE_ERROR',                         // 18
  LLM_TIMEOUT_ERROR = 'LLM_TIMEOUT_ERROR',                           // 19
  LLM_RATE_LIMIT_ERROR = 'LLM_RATE_LIMIT_ERROR',                     // 20
  LLM_INVALID_RESPONSE_ERROR = 'LLM_INVALID_RESPONSE_ERROR',         // 21

  // Memory (22-24)
  MEMORY_BACKEND_ERROR = 'MEMORY_BACKEND_ERROR',                     // 22
  MEMORY_CONNECTION_ERROR = 'MEMORY_CONNECTION_ERROR',               // 23
  MEMORY_SERIALIZATION_ERROR = 'MEMORY_SERIALIZATION_ERROR',         // 24

  // Proof (25-27)
  PROOF_GENERATION_ERROR = 'PROOF_GENERATION_ERROR',                 // 25
  PROOF_VERIFICATION_ERROR = 'PROOF_VERIFICATION_ERROR',             // 26
  PROOF_CACHE_ERROR = 'PROOF_CACHE_ERROR',                           // 27

  // Dispute (28-31)
  DISPUTE_NOT_FOUND = 'DISPUTE_NOT_FOUND',                           // 28
  DISPUTE_VOTE_ERROR = 'DISPUTE_VOTE_ERROR',                         // 29
  DISPUTE_RESOLUTION_ERROR = 'DISPUTE_RESOLUTION_ERROR',             // 30
  DISPUTE_SLASH_ERROR = 'DISPUTE_SLASH_ERROR',                       // 31

  // Workflow (32-35)
  WORKFLOW_VALIDATION_ERROR = 'WORKFLOW_VALIDATION_ERROR',           // 32
  WORKFLOW_EXECUTION_ERROR = 'WORKFLOW_EXECUTION_ERROR',             // 33
  WORKFLOW_SUBMISSION_ERROR = 'WORKFLOW_SUBMISSION_ERROR',           // 34
  WORKFLOW_CYCLE_ERROR = 'WORKFLOW_CYCLE_ERROR',                     // 35

  // Connection (36-37)
  CONNECTION_ERROR = 'CONNECTION_ERROR',                             // 36
  ALL_ENDPOINTS_UNHEALTHY = 'ALL_ENDPOINTS_UNHEALTHY',               // 37
}
```

## RuntimeError Base Class

All runtime errors extend `RuntimeError`:

```typescript
export class RuntimeError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}
```

## Specific Error Classes with Typed Properties

Error classes include typed properties for structured error information:

```typescript
export class InsufficientStakeError extends RuntimeError {
  constructor(
    public readonly required: bigint,
    public readonly provided: bigint
  ) {
    super(
      RuntimeErrorCodes.INSUFFICIENT_STAKE,
      `Insufficient stake: required ${required}, provided ${provided}`
    );
    this.name = 'InsufficientStakeError';
  }
}

export class ActiveTasksError extends RuntimeError {
  constructor(public readonly taskCount: number) {
    super(
      RuntimeErrorCodes.ACTIVE_TASKS_ERROR,
      `Cannot deregister: ${taskCount} active tasks`
    );
    this.name = 'ActiveTasksError';
  }
}

export class TaskNotFoundError extends RuntimeError {
  constructor(public readonly taskPda: PublicKey) {
    super(
      RuntimeErrorCodes.TASK_NOT_FOUND,
      `Task not found: ${taskPda.toBase58()}`
    );
    this.name = 'TaskNotFoundError';
  }
}

export class ValidationError extends RuntimeError {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly reason: string
  ) {
    super(
      RuntimeErrorCodes.VALIDATION_ERROR,
      `Validation failed for ${field}: ${reason}`
    );
    this.name = 'ValidationError';
  }
}
```

## Adding a New Error Code

### Step 1: Add to RuntimeErrorCodes Enum

Claim the next available code range in `runtime/src/types/errors.ts`:

```typescript
export enum RuntimeErrorCodes {
  // ... existing codes ...

  // Your Module (38-41)
  YOUR_MODULE_ERROR = 'YOUR_MODULE_ERROR',
  YOUR_MODULE_VALIDATION_ERROR = 'YOUR_MODULE_VALIDATION_ERROR',
  YOUR_MODULE_TIMEOUT_ERROR = 'YOUR_MODULE_TIMEOUT_ERROR',
}
```

### Step 2: Create Error Class in Module's errors.ts

```typescript
import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

export class YourModuleError extends RuntimeError {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(RuntimeErrorCodes.YOUR_MODULE_ERROR, message);
    this.name = 'YourModuleError';
  }
}

export class YourModuleValidationError extends RuntimeError {
  constructor(
    public readonly field: string,
    public readonly value: unknown
  ) {
    super(
      RuntimeErrorCodes.YOUR_MODULE_VALIDATION_ERROR,
      `Invalid ${field}: ${value}`
    );
    this.name = 'YourModuleValidationError';
  }
}
```

### Step 3: Export from Module Index

```typescript
// runtime/src/your-module/index.ts
export * from './errors.js';
```

## Anchor Error Mapping

### AnchorErrorCodes Mapping

The `AnchorErrorCodes` mapping in `runtime/src/types/errors.ts` is **intentionally partial** and **may drift** from the program source.

```typescript
export const AnchorErrorCodes: Record<string, number> = {
  // Intentionally partial mapping
  InsufficientStake: 6002,
  AgentNotRegistered: 6000,
  // ... etc
};
```

**Source of truth:** `programs/agenc-coordination/src/errors.rs`

Anchor assigns codes sequentially: `code = 6000 + enum_index`

### isAnchorError Utility

```typescript
export function isAnchorError(error: unknown): error is { code: number; msg: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as any).code === 'number'
  );
}
```

### Usage Pattern

```typescript
import { isAnchorError, AnchorErrorCodes } from '../types/errors.js';

try {
  await program.methods.registerAgent(...).rpc();
} catch (error) {
  if (isAnchorError(error)) {
    if (error.code === AnchorErrorCodes.InsufficientStake) {
      throw new InsufficientStakeError(required, provided);
    }
    throw new TransactionFailedError(`Anchor error ${error.code}: ${error.msg}`);
  }
  throw new RpcError(`Transaction failed: ${error}`);
}
```

## Error Wrapping Pattern

Always wrap low-level errors in RuntimeError subclasses:

```typescript
async performOperation(params: Params): Promise<Result> {
  try {
    // Attempt operation
    const result = await this.program.methods.instruction(...).rpc();
    return { success: true };
  } catch (error) {
    // Check for Anchor errors first
    if (isAnchorError(error)) {
      if (error.code === 6005) {
        throw new TaskNotFoundError(taskPda);
      }
      throw new TransactionFailedError(error.msg);
    }

    // Wrap other errors
    if (error instanceof Error) {
      throw new YourModuleError(error.message, { params });
    }

    // Unknown error
    throw new YourModuleError('Unknown error occurred', { error, params });
  }
}
```

## Never Throw Raw Strings or Generic Errors

```typescript
// WRONG
throw 'Something went wrong';
throw new Error('Something went wrong');

// RIGHT
throw new YourModuleError('Something went wrong');
throw new ValidationError('field', value, 'must be positive');
```

## Error Serialization

All errors must be JSON-safe (no circular refs, bigint→string):

```typescript
export class SerializableError extends RuntimeError {
  constructor(code: string, message: string, public readonly metadata?: unknown) {
    super(code, message);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      metadata: this.metadata,
    };
  }
}
```

For bigint in error metadata, use `safeStringify()`:

```typescript
import { safeStringify } from '../tools/registry.js';

throw new YourModuleError(
  'Operation failed',
  { amount: 1_000_000_000n } // Will be serialized correctly
);
```

## Error Propagation in Async

Always use try/catch, never swallow errors silently:

```typescript
// WRONG
async function operation() {
  try {
    await riskyOperation();
  } catch (error) {
    // Silent failure
  }
}

// RIGHT
async function operation() {
  try {
    await riskyOperation();
  } catch (error) {
    this.logger.error('Operation failed', error);
    throw new YourModuleError(`Operation failed: ${error}`);
  }
}
```

## Error Logging

Use `logger.error()` with error object, not just message:

```typescript
// WRONG
logger.error('Transaction failed');

// RIGHT
logger.error('Transaction failed', { error, params });
logger.error('Transaction failed', error); // Error object
```

## Testing Error Handling

```typescript
import { expect, it } from 'vitest';
import { YourModuleError } from './errors.js';

it('should throw YourModuleError on failure', async () => {
  await expect(module.performOperation({})).rejects.toThrow(YourModuleError);
});

it('should include error code and properties', async () => {
  try {
    await module.performOperation({});
    expect.fail('Should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(YourModuleError);
    expect(error.code).toBe(RuntimeErrorCodes.YOUR_MODULE_ERROR);
    expect(error.details).toBeDefined();
  }
});
```
