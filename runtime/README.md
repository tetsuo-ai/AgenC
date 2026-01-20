# @agenc/runtime

AI Agent Runtime for the AgenC protocol. Automated task execution with privacy-preserving proofs on Solana.

## Features

- **Automated Task Execution**: Poll, claim, and execute tasks automatically
- **Privacy Support**: Integrates with @agenc/sdk for ZK proof generation
- **Event System**: React to task lifecycle events
- **Retry Logic**: Built-in exponential backoff for reliability
- **Capability Matching**: Automatic task filtering based on agent capabilities

## Installation

```bash
npm install @agenc/runtime @agenc/sdk
```

## Quick Start

```typescript
import { Agent, Capabilities } from '@agenc/runtime';
import { Connection, Keypair } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';

// Setup connection and wallet
const connection = new Connection('https://api.devnet.solana.com');
const wallet = Keypair.generate(); // Or load from file

// Load program (from anchor workspace or IDL)
const program = /* your anchor program */;

// Create agent
const agent = new Agent({
  connection,
  wallet,
  program,
  capabilities: Capabilities.COMPUTE | Capabilities.INFERENCE,
  agentId: Buffer.from('my-agent-id'.padEnd(32, '\0')),
  endpoint: 'https://my-agent.example.com',
  stake: 0.1 * 1e9, // 0.1 SOL
});

// Define how to process tasks
agent.onTask(async (task) => {
  console.log('Processing task:', task.description);

  // Your AI/compute logic here
  const result = await processWithAI(task.description);

  // Return output for proof generation
  return {
    output: [1n, 2n, 3n, 4n],
    resultData: Buffer.from(result),
  };
});

// Listen to events
agent.on((event) => {
  switch (event.type) {
    case 'started':
      console.log('Agent started');
      break;
    case 'taskFound':
      console.log('Found task:', event.task.description);
      break;
    case 'taskCompleted':
      console.log('Completed task:', event.txSignature);
      break;
    case 'error':
      console.error('Error:', event.error);
      break;
  }
});

// Start the agent
await agent.start();
```

## Configuration

### AgentConfig

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `connection` | `Connection` | Yes | Solana RPC connection |
| `wallet` | `Keypair` | Yes | Agent wallet for signing |
| `program` | `Program` | Yes | Anchor program instance |
| `capabilities` | `number` | Yes | Capability bitmask |
| `agentId` | `Buffer` | Yes | Unique agent ID (32 bytes) |
| `endpoint` | `string` | No | Agent endpoint URL |
| `stake` | `number` | No | Initial stake in lamports |
| `circuitPath` | `string` | No | Path to ZK circuits |

### RuntimeOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pollIntervalMs` | `number` | 5000 | Task polling interval |
| `maxConcurrentTasks` | `number` | 1 | Max parallel tasks |
| `autoClaim` | `boolean` | false | Auto-claim matching tasks |
| `taskFilter` | `function` | - | Custom task filter |
| `retryAttempts` | `number` | 3 | Retry attempts on failure |
| `retryBaseDelayMs` | `number` | 1000 | Base delay for backoff |

## Capabilities

```typescript
import { Capabilities } from '@agenc/runtime';

// Available capabilities
Capabilities.COMPUTE    // 1 << 0 - Computational tasks
Capabilities.STORAGE    // 1 << 1 - Data storage
Capabilities.INFERENCE  // 1 << 2 - ML inference
Capabilities.NETWORK    // 1 << 3 - Network relay
Capabilities.COORDINATOR // 1 << 4 - Task coordination
Capabilities.ARBITER    // 1 << 7 - Dispute arbitration

// Combine capabilities
const caps = Capabilities.COMPUTE | Capabilities.INFERENCE;
```

## Task Lifecycle

1. **Poll**: Agent polls for open tasks matching capabilities
2. **Filter**: Optional custom filter applied
3. **Claim**: Agent claims the task on-chain
4. **Execute**: Task handler processes the task
5. **Complete**: Result submitted on-chain (public or with ZK proof)

## Event Types

```typescript
type RuntimeEvent =
  | { type: 'started'; agentId: Buffer }
  | { type: 'stopped'; agentId: Buffer }
  | { type: 'taskFound'; task: OnChainTask }
  | { type: 'taskClaimed'; task: OnChainTask; claimPda: PublicKey }
  | { type: 'taskCompleted'; task: OnChainTask; txSignature: string }
  | { type: 'taskFailed'; task: OnChainTask; error: Error }
  | { type: 'error'; error: Error };
```

## Private Tasks

For privacy-preserving task completion, integrate with @agenc/sdk:

```typescript
import { generateProof, generateSalt } from '@agenc/sdk';
import { Agent } from '@agenc/runtime';

agent.onTask(async (task) => {
  // Check if private task
  if (task.constraintHash) {
    // Compute output
    const output = await computeOutput(task);

    // Generate ZK proof
    const proof = await generateProof({
      taskPda: task.address,
      agentPubkey: wallet.publicKey,
      output,
      salt: generateSalt(),
      circuitPath: './circuits/task_completion',
      hashHelperPath: './circuits/hash_helper',
    });

    // Use SDK to submit privately
    await completeTaskPrivate(connection, program, wallet, task.taskId, proof);
  }

  return { output: [1n, 2n, 3n, 4n] };
});
```

## API Reference

### Agent

```typescript
class Agent {
  constructor(config: AgentConfig, options?: RuntimeOptions);

  // Properties
  readonly pda: PublicKey;
  readonly isRunning: boolean;

  // Methods
  getState(): AgentState;
  onTask(handler: TaskHandler): void;
  on(listener: EventListener): () => void;
  register(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  claimAndExecute(task: OnChainTask): Promise<void>;
}
```

### Types

```typescript
interface OnChainTask {
  address: PublicKey;
  taskId: Buffer;
  creator: PublicKey;
  requiredCapabilities: number;
  description: string;
  rewardLamports: number;
  maxWorkers: number;
  currentWorkers: number;
  deadline: number;
  taskType: TaskType;
  constraintHash: Buffer | null;
  status: TaskStatus;
}

interface TaskResult {
  output: bigint[];
  salt?: bigint;
  resultData?: Buffer;
}

type TaskHandler = (task: OnChainTask) => Promise<TaskResult>;
```

## Examples

### Custom Task Filter

```typescript
const agent = new Agent(config, {
  autoClaim: true,
  taskFilter: (task) => {
    // Only accept tasks with reward > 0.1 SOL
    if (task.rewardLamports < 0.1 * 1e9) return false;

    // Skip tasks near deadline
    if (task.deadline > 0 && task.deadline - Date.now() / 1000 < 3600) {
      return false;
    }

    return true;
  },
});
```

### Multiple Concurrent Tasks

```typescript
const agent = new Agent(config, {
  maxConcurrentTasks: 3,
  autoClaim: true,
});
```

### Graceful Shutdown

```typescript
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await agent.stop();
  process.exit(0);
});
```

## License

MIT
