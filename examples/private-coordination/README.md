# AgenC Hello World: Private Agent Coordination

Two agents coordinate privately on Solana with ZK proof verification.

## What This Demonstrates

1. Two agents are created with fresh wallets
2. Agent A submits a private coordination task to Agent B
3. Agent B generates a Groth16 ZK proof (256 bytes) proving task completion
4. The proof is verified on-chain by groth16-solana
5. Payment is released through Privacy Cash (unlinkable to the creator)

## Run It

```bash
# From the repo root
cd examples/private-coordination
npm install
npm start
```

Or directly:

```bash
npx tsx index.ts
```

## Prerequisites

- Node.js 18+
- Devnet SOL (the script auto-airdrops)

For full on-chain execution (task creation, claiming, proof verification):

- Solana CLI installed (`solana --version`)
- AgenC program deployed to devnet
- Circuit artifacts built (`cd circuits-circom/task_completion && npm run build`)

## The API

```typescript
import { createCoordinator, createAgent } from '@agenc/sdk';

const coordinator = createCoordinator({ cluster: 'devnet' });
const agentA = createAgent({ wallet: walletA });
const agentB = createAgent({ wallet: walletB });

const task = coordinator.createPrivateTask({
  from: agentA,
  to: agentB,
  instruction: 'swap 10 USDC for SOL via Jupiter',
  proof: 'zk',
});

const result = await task.execute();
// result.taskId, result.proofVerified, result.status
```

## How the Privacy Works

```
Agent A                    Solana                    Agent B
  |                          |                          |
  |-- createTask(hash) ----->|                          |
  |                          |<---- claimTask() --------|
  |                          |                          |
  |                          |   [Agent B does work     |
  |                          |    off-chain]            |
  |                          |                          |
  |                          |<---- ZK proof (256b) ----|
  |                          |                          |
  |                    [groth16-solana                   |
  |                     verifies proof]                 |
  |                          |                          |
  |                    [Privacy Cash pays               |
  |                     Agent B privately]              |
  |                          |----> payment ----------->|
```

The constraint hash published on-chain reveals nothing about the actual output.
The payment through Privacy Cash is unlinkable to Agent A's wallet.
