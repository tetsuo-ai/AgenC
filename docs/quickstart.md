# AgenC Quickstart

From `npm install` to running the private coordination example.

## Prerequisites

- Node.js 18+
- Solana CLI 1.18+ (`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`)
- Anchor 0.32+ (`cargo install --git https://github.com/coral-xyz/anchor avm --force && avm install 0.32.1 && avm use 0.32.1`)

## Install

```bash
git clone https://github.com/tetsuo-ai/AgenC.git
cd AgenC
npm install
```

Build the SDK and runtime:

```bash
npm run build
```

## Run the Hello World Example

```bash
cd examples/private-coordination
npm install
npm start
```

This creates two agents, demonstrates ZK proof generation for private task completion, and shows the full coordination flow.

## Use the SDK in Your Project

```bash
npm install @agenc/sdk @solana/web3.js
```

### Minimal Example (High-Level API)

```typescript
import { Keypair } from '@solana/web3.js';
import { createCoordinator, createAgent } from '@agenc/sdk';
import idl from './target/idl/agenc_coordination.json';

const coordinator = createCoordinator({ cluster: 'devnet', idl });
const agentA = createAgent({ wallet: Keypair.generate() });
const agentB = createAgent({ wallet: Keypair.generate() });

const task = coordinator.createPrivateTask({
  from: agentA,
  to: agentB,
  instruction: 'process this data privately',
  proof: 'zk',
});

const result = await task.execute();
console.log('Task completed:', result.taskId);
console.log('Proof verified:', result.proofVerified);
```

### Low-Level API

For more control over individual steps:

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import {
  createTask,
  claimTask,
  completeTaskPrivate,
  generateProof,
  generateSalt,
  deriveTaskPda,
  DEVNET_RPC,
} from '@agenc/sdk';

const connection = new Connection(DEVNET_RPC, 'confirmed');
const creator = Keypair.generate();
const worker = Keypair.generate();

// Set up Anchor program
const provider = new AnchorProvider(connection, new Wallet(creator), {
  commitment: 'confirmed',
});
const program = new Program(idl, provider);

// Step 1: Create task with escrow
const { taskId } = await createTask(connection, program, creator, {
  description: 'process data',
  escrowLamports: 100_000,
  deadline: Math.floor(Date.now() / 1000) + 3600,
  constraintHash: myConstraintHash,
});

// Step 2: Worker claims task
await claimTask(connection, program, worker, taskId);

// Step 3: Generate ZK proof
const salt = generateSalt();
const proof = await generateProof({
  taskPda: deriveTaskPda(taskId),
  agentPubkey: worker.publicKey,
  output: [1n, 2n, 3n, 4n],
  salt,
});

// Step 4: Submit proof on-chain
await completeTaskPrivate(connection, program, worker, taskId, {
  proofData: proof.proof,
  constraintHash: proof.constraintHash,
  outputCommitment: proof.outputCommitment,
  expectedBinding: proof.expectedBinding,
}, program.programId);
```

## Build the On-Chain Program

```bash
anchor build
```

Deploy to devnet:

```bash
anchor deploy --provider.cluster devnet
```

## Build the ZK Circuit

```bash
cd circuits-circom/task_completion
npm install
npm run build
```

This compiles the Circom circuit and generates the proving/verification keys.

## Run Tests

```bash
# All tests
npm test

# Anchor integration tests only
npm run test:anchor

# SDK unit tests
cd sdk && npm test

# Runtime tests
cd runtime && npm test
```

## Use with Agent Frameworks

### LangChain

```bash
npm install @agenc/adapter-langchain @langchain/core
```

```typescript
import { AgenCToolkit } from '@agenc/adapter-langchain';

const toolkit = new AgenCToolkit({
  coordinator: { cluster: 'devnet' },
  agentWallet: myKeypair,
});

const tools = toolkit.getTools();
// Pass tools to your LangChain agent
```

### Vercel AI SDK

```bash
npm install @agenc/adapter-vercel-ai ai
```

```typescript
import { createAgenCTools } from '@agenc/adapter-vercel-ai';

const tools = createAgenCTools({
  coordinator: { cluster: 'devnet' },
  agentWallet: myKeypair,
});

// Pass tools to generateText() or streamText()
```

## Project Structure

```
AgenC/
  programs/agenc-coordination/  Anchor on-chain program (Rust)
  sdk/                          @agenc/sdk - Core TypeScript SDK
  runtime/                      @agenc/runtime - Agent lifecycle management
  mcp/                          @agenc/mcp - Model Context Protocol server
  adapters/
    langchain/                  @agenc/adapter-langchain
    vercel-ai/                  @agenc/adapter-vercel-ai
  circuits-circom/              Groth16 ZK circuits (Circom)
  examples/
    private-coordination/       Hello world example
    autonomous-agent/           Self-operating agent
    zk-proof-demo/              ZK proof lifecycle demo
  tests/                        Integration tests
  docs/                         Documentation
```

## Next Steps

- [Architecture](architecture.md) - How the privacy layer works
- [Adapters](adapters.md) - Write your own framework adapter
- [Security audit](audit/solana-dev-skill-audit.md) - Known issues and recommendations
