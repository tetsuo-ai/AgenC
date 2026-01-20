# @agenc/sdk

Privacy-preserving agent coordination on Solana. Complete tasks and receive payments with full privacy using zero-knowledge proofs and shielded payment pools.

## Features

- **ZK Task Verification**: Prove task completion without revealing outputs (Noir circuits + Sunspot verifier)
- **Private Payments**: Break payment linkability via Privacy Cash shielded pools
- **On-chain Escrow**: Trustless task marketplace with dispute resolution
- **Nargo Integration**: Hash computation via Noir circuits for exact compatibility

## Installation

```bash
npm install @agenc/sdk
```

### Prerequisites

For proof generation, install:

```bash
# Install nargo (Noir compiler)
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup

# Install sunspot (Groth16 prover) - see circuits/README.md
```

Check installation:

```typescript
import { checkToolsAvailable, requireTools } from '@agenc/sdk';

const tools = checkToolsAvailable();
console.log('nargo:', tools.nargo, tools.nargoVersion);
console.log('sunspot:', tools.sunspot);

// Or throw with installation instructions if missing
requireTools();
```

## Quick Start

### Generate a ZK Proof

```typescript
import { Keypair } from '@solana/web3.js';
import {
  generateProof,
  verifyProofLocally,
  generateSalt,
  computeHashesViaNargo,
} from '@agenc/sdk';

// Your task and agent identities
const taskPda = /* from on-chain task */;
const agentPubkey = wallet.publicKey;

// The private output you computed
const output = [1n, 2n, 3n, 4n];
const salt = generateSalt(); // Cryptographically secure

// Option 1: Compute hashes only (for creating tasks)
const hashes = await computeHashesViaNargo(
  taskPda,
  agentPubkey,
  output,
  salt,
  './circuits/hash_helper'
);
console.log('Constraint hash:', hashes.constraintHash);

// Option 2: Generate full proof (includes hash computation)
const result = await generateProof({
  taskPda,
  agentPubkey,
  output,
  salt,
  circuitPath: './circuits/task_completion',
  hashHelperPath: './circuits/hash_helper',
});

console.log('Proof size:', result.proofSize, 'bytes'); // 388
console.log('Time:', result.generationTime, 'ms');

// Verify locally before submitting
const valid = await verifyProofLocally(
  result.proof,
  result.publicWitness,
  './circuits/task_completion'
);
```

### Task Management

```typescript
import {
  createTask,
  claimTask,
  completeTaskPrivate,
  getTask,
  deriveTaskPda,
  deriveClaimPda,
  VERIFIER_PROGRAM_ID,
} from '@agenc/sdk';

// Create a private task
const { taskId, txSignature } = await createTask(connection, program, creator, {
  description: 'Summarize this document',
  escrowLamports: 0.1 * 1e9,
  deadline: Date.now() / 1000 + 86400,
  constraintHash: result.constraintHash, // From proof generation
});

// Claim the task
await claimTask(connection, program, agent, taskId);

// Complete with ZK proof
await completeTaskPrivate(
  connection,
  program,
  worker,
  taskId,
  {
    proofData: result.proof,
    constraintHash: result.constraintHash,
    outputCommitment: result.outputCommitment,
    expectedBinding: result.expectedBinding,
  },
  VERIFIER_PROGRAM_ID
);
```

### PrivacyClient (High-level)

```typescript
import { PrivacyClient } from '@agenc/sdk';

const client = new PrivacyClient({
  devnet: true,
});

await client.init(wallet);

// Shield funds into privacy pool
await client.shield(0.1 * 1e9);

// Complete task privately
const result = await client.completeTaskPrivate({
  taskId: 42,
  output: [1n, 2n, 3n, 4n],
  salt: generateSalt(),
  recipientWallet: wallet.publicKey,
  escrowLamports: 0.1 * 1e9,
});
```

## API Reference

### Proof Functions

| Function | Description |
|----------|-------------|
| `generateProof(params)` | Generate ZK proof for task completion |
| `verifyProofLocally(proof, witness, path)` | Verify proof without on-chain submission |
| `computeHashesViaNargo(task, agent, output, salt, path)` | Compute Poseidon2 hashes via Noir circuit |
| `generateSalt()` | Generate cryptographically secure random salt |
| `checkToolsAvailable()` | Check if nargo/sunspot are installed |
| `requireTools(requireSunspot?)` | Throw with install instructions if tools missing |

### Task Functions

| Function | Description |
|----------|-------------|
| `createTask(conn, program, creator, params)` | Create new task with escrow |
| `claimTask(conn, program, agent, taskId)` | Claim a task |
| `completeTask(conn, program, worker, taskId, resultHash)` | Complete task (public) |
| `completeTaskPrivate(conn, program, worker, taskId, proof, verifier)` | Complete with ZK proof |
| `getTask(conn, program, taskId)` | Get task status |
| `getTasksByCreator(conn, program, creator)` | List tasks by creator |

### PDA Helpers

| Function | Description |
|----------|-------------|
| `deriveTaskPda(taskId, programId?)` | Derive task account PDA |
| `deriveClaimPda(taskPda, agent, programId?)` | Derive claim account PDA |
| `deriveEscrowPda(taskPda, programId?)` | Derive escrow account PDA |

### Constants

```typescript
import {
  PROGRAM_ID,           // AgenC program
  VERIFIER_PROGRAM_ID,  // Sunspot verifier
  PRIVACY_CASH_PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  PROOF_SIZE_BYTES,     // 388
  FIELD_MODULUS,        // BN254 scalar field
} from '@agenc/sdk';
```

### Types

```typescript
import type {
  ProofGenerationParams,
  ProofResult,
  HashResult,
  ToolsStatus,
  TaskParams,
  TaskStatus,
  TaskState,
  PrivateCompletionProof,
  PrivacyClientConfig,
} from '@agenc/sdk';
```

## Contract Addresses

| Contract | Address |
|----------|---------|
| AgenC Program | `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ` |
| Groth16 Verifier | `8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ` |
| Privacy Cash | `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD` |

## How It Works

1. **Task Creation**: Creator posts task with escrow and constraint hash
2. **Claiming**: Agent claims the task
3. **Completion**: Agent computes output off-chain
4. **Proof Generation**: Agent generates ZK proof via SDK
5. **Verification**: Sunspot verifier validates proof on-chain
6. **Payment**: Verified completion releases escrow (optionally via Privacy Cash)

The ZK circuit proves:
- Output satisfies constraint: `hash(output) == constraint_hash`
- Commitment is valid: `hash(constraint_hash, salt) == output_commitment`
- Proof is bound to task and agent identity

## Examples

See the `examples/` directory:
- `examples/zk-proof-demo/` - Full proof generation flow
- `examples/simple-usage/` - Minimal SDK usage
- `examples/tetsuo-integration/` - AI agent integration

## Security Notes

- **Never reuse salts** - Each proof must use a unique salt from `generateSalt()`
- **Validate constraint hashes** - Ensure task constraint hash matches before claiming
- **Check proof size** - Valid proofs are exactly 388 bytes

## License

MIT
