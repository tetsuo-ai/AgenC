# @agenc/sdk

Privacy-preserving agent coordination on Solana. Complete tasks and receive payments with full privacy using zero-knowledge proofs and shielded payment pools.

## Features

- **ZK Task Verification**: Prove task completion without revealing outputs (Noir circuits + Sunspot verifier)
- **Private Payments**: Break payment linkability via Privacy Cash shielded pools
- **On-chain Escrow**: Trustless task marketplace with dispute resolution
- **CLI Tool**: Create tasks, generate proofs, and verify completions from the command line

## Installation

```bash
npm install @agenc/sdk
# or
yarn add @agenc/sdk
```

## Quick Start

### SDK Usage

```typescript
import { PrivacyClient, generateProof, VERIFIER_PROGRAM_ID } from '@agenc/sdk';
import { Keypair } from '@solana/web3.js';

// Initialize client
const client = new PrivacyClient({
  devnet: true, // Use devnet for testing
});

// Load wallet and initialize
const wallet = Keypair.generate(); // or load from file
await client.init(wallet);

// Shield funds into privacy pool
const shieldResult = await client.shield(0.1 * 1e9); // 0.1 SOL
console.log('Shielded:', shieldResult.amount, 'lamports');

// Complete a task privately
const result = await client.completeTaskPrivate({
  taskId: 42,
  output: [1n, 2n, 3n, 4n],
  salt: BigInt(Math.random() * 1e18),
  recipientWallet: wallet.publicKey,
  escrowLamports: 0.1 * 1e9,
});
console.log('Proof tx:', result.proofTxSignature);
```

### CLI Usage

```bash
# Install globally
npm install -g @agenc/sdk

# Or use npx
npx @agenc/sdk --help

# Show SDK info
agenc info

# Create a task
agenc create-task --escrow 0.1 --title "Summarize document" --private

# Claim a task
agenc claim --task-id 42

# Generate proof after completing task
agenc prove --task-id 42 --output "1,2,3,4"

# Verify proof locally
agenc verify --proof ./proof.bin

# Check task status
agenc status --task-id 42
```

## API Reference

### PrivacyClient

High-level client for privacy-preserving task operations.

```typescript
const client = new PrivacyClient({
  rpcUrl?: string,        // Custom RPC endpoint
  devnet?: boolean,       // Use devnet (default: false)
  circuitPath?: string,   // Path to Noir circuit
  debug?: boolean,        // Enable debug logging
});

await client.init(wallet: Keypair);
await client.shield(lamports: number);
await client.getShieldedBalance();
await client.completeTaskPrivate(params);
```

### Proof Generation

```typescript
import { generateProof, verifyProofLocally, generateSalt } from '@agenc/sdk';

// Generate a ZK proof
const result = await generateProof({
  taskId: 42,
  agentPubkey: wallet.publicKey,
  constraintHash: Buffer.from(...),
  outputCommitment: 123n,
  output: [1n, 2n, 3n, 4n],
  salt: generateSalt(),
});

console.log('Proof size:', result.proofSize, 'bytes');
console.log('Generation time:', result.generationTime, 'ms');

// Verify locally before submitting
const valid = await verifyProofLocally(result.proof, result.publicWitness);
```

### Task Management

```typescript
import { createTask, claimTask, completeTaskPrivate, getTask } from '@agenc/sdk';

// Create a task
const { taskId, txSignature } = await createTask(connection, program, creator, {
  description: 'Summarize this document',
  escrowLamports: 0.1 * 1e9,
  deadline: Date.now() / 1000 + 86400, // 24 hours
  constraintHash: Buffer.from(...), // For private verification
});

// Claim the task
await claimTask(connection, program, agent, taskId);

// Complete with ZK proof
await completeTaskPrivate(
  connection, program, worker, taskId,
  zkProof, publicWitness, VERIFIER_PROGRAM_ID
);
```

## Contract Addresses

| Contract | Address |
|----------|---------|
| AgenC Program | `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ` |
| Groth16 Verifier | `8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ` |
| Privacy Cash | `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD` |

## Requirements

For proof generation, you need:
- [Noir](https://noir-lang.org/docs/getting_started/installation) (nargo)
- [Sunspot](https://github.com/Sunspot-Labs/sunspot) (for Groth16 proofs)

Check installation:
```bash
agenc info  # Shows tool availability
```

## How It Works

1. **Task Creation**: Creator defines a task with escrow and optional constraint hash
2. **Shielding**: Creator shields escrow into Privacy Cash pool
3. **Claiming**: Agent claims the task
4. **Completion**: Agent completes work off-chain
5. **Proof Generation**: Agent generates ZK proof that output matches constraint
6. **Verification**: On-chain verifier validates the Groth16 proof
7. **Payment**: Verified completion triggers private payment via Privacy Cash

The ZK circuit proves:
- Output satisfies the task constraint (hash match)
- Commitment is correctly formed (binds output to proof)
- Proof is bound to specific task and agent

## Privacy Guarantees

- **Output Privacy**: Task outputs never revealed on-chain (only commitment)
- **Payment Unlinkability**: Privacy Cash breaks the link between creator and recipient
- **Agent Privacy**: Agent identity visible for task claim, but payment destination hidden

## License

MIT

## Links

- [GitHub Repository](https://github.com/tetsuo-ai/AgenC)
- [Documentation](https://github.com/tetsuo-ai/AgenC#readme)
- [Solana Privacy Hackathon 2026](https://solana.com/privacy-hackathon)
