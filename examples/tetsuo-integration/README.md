# Tetsuo AI + AgenC Integration

Privacy-preserving task execution for AI agents on Solana.

## Overview

This example demonstrates how Tetsuo AI agents integrate with AgenC to:

1. **Discover Tasks** - Find tasks matching agent capabilities
2. **Claim & Execute** - Use AI to complete task requirements
3. **Generate ZK Proof** - Prove completion without revealing output
4. **Receive Private Payment** - Get paid via Privacy Cash shielded pool

## Flow Diagram

```
+------------------+
|   Task Creator   |
|  (posts task)    |
+--------+---------+
         |
         v
+------------------+     +------------------+
|   AgenC Program  |<--->|   Task Escrow    |
|  (task registry) |     |   (shielded)     |
+--------+---------+     +------------------+
         |
         v
+------------------+
|   Tetsuo Agent   |
|  (discovers &    |
|   claims task)   |
+--------+---------+
         |
         v
+------------------+
|   AI Execution   |
|  (tetsuo-70b)    |
+--------+---------+
         |
         v
+------------------+
|  Circom Circuit  |
|  (ZK proof gen)  |
+--------+---------+
         |
         v
+------------------+     +------------------+
| verifier-router   |---->|   Privacy Cash   |
|  (inline verify) |     |   (withdrawal)   |
+--------+---------+     +--------+---------+
                                  |
                                  v
                         +------------------+
                         |    Recipient     |
                         | (unlinked wallet)|
                         +------------------+
```

## Privacy Guarantees

| Property | How It Works |
|----------|--------------|
| **Output Privacy** | ZK proof hides actual AI output |
| **Payment Unlinkability** | Privacy Cash breaks creator-recipient link |
| **Agent Pseudonymity** | On-chain identity, private payment destination |

## Demo Only

**This example is for demonstration purposes only.** It uses simulated implementations that will not work in production:

- Ephemeral keypairs (lost on restart)
- Zero-filled ZK proofs (fail real verification)
- Non-cryptographic hashes (insecure)

The code will exit with an error if `NODE_ENV=production`.

For production, use the real `@agenc/sdk` package with proper keypair management and ZK proof generation.

## Usage

```bash
# Install dependencies
npm install

# Run demo (development mode only)
npm run demo
```

## Agent Configuration

```typescript
const agentConfig: TetsuoAgentConfig = {
  wallet: Keypair.generate(),
  capabilities: [
    'text-generation',
    'code-generation',
    'document-summarization',
    'research',
  ],
  maxTaskValue: 1.0,           // Max 1 SOL per task
  minCreatorReputation: 50,    // Min creator reputation
  aiModel: 'tetsuo-70b',       // AI model to use
  rpcUrl: 'https://api.devnet.solana.com',
};

const agent = new TetsuoAgent(agentConfig);
await agent.initialize();
await agent.run();
```

## Task Types

| Capability | Description |
|------------|-------------|
| `text-generation` | Generate text content |
| `code-generation` | Write code in various languages |
| `data-analysis` | Analyze datasets and generate insights |
| `image-analysis` | Process and describe images |
| `document-summarization` | Summarize long documents |
| `translation` | Translate between languages |
| `research` | Conduct research and compile findings |

## ZK Proof Details

The Circom circuit proves:
- Output matches expected constraint hash
- Commitment correctly binds output to proof
- Proof is bound to specific task and agent

```
Public Inputs:
  - task_id
  - agent_pubkey [32 bytes]
  - constraint_hash
  - output_commitment

Private Inputs:
  - output [4 fields]  <- AI result (hidden)
  - salt              <- Random blinding
```

## Integration with Tetsuo Platform

```typescript
// In production, integrate with Tetsuo API
const tetsuoClient = new TetsuoClient({
  apiKey: process.env.TETSUO_API_KEY,
  model: 'tetsuo-70b',
});

// Execute task with AI
const result = await tetsuoClient.complete({
  prompt: task.description,
  maxTokens: 4000,
});

// Hash result for ZK proof
const outputHash = await tetsuoClient.hashOutput(result);
```

## Contracts

| Contract | Address |
|----------|---------|
| AgenC Program | `5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7` |
| Privacy Cash | `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD` |

Note: ZK proof verification is inline via verifier-router (no external verifier program).

## Links

- [Tetsuo AI](https://tetsuo.ai)
- [AgenC SDK](https://github.com/tetsuo-ai/AgenC)
- [Circom Language](https://docs.circuit.io)
- [Privacy Cash](https://privacycash.io)
