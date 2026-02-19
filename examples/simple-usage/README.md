# Simple Usage Example

Minimal example showing how to use the AgenC SDK for ZK proof generation.

## Prerequisites

```bash
npm install risc0-host-prover
```

## Run

```bash
npm install
npm start
```

## Code

```typescript
import { Keypair } from '@solana/web3.js';
import {
  generateSalt,
  computeHashes,
  generateProof,
  verifyProofLocally,
} from '@agenc/sdk';

// Your identities
const taskPda = Keypair.generate().publicKey;
const agentPubkey = Keypair.generate().publicKey;

// Private output to prove
const output = [1n, 2n, 3n, 4n];
const salt = generateSalt();

// Compute hashes (uses poseidon-lite, circuitlib compatible)
const hashes = computeHashes(taskPda, agentPubkey, output, salt);

// Generate proof
const result = await generateProof({
  taskPda,
  agentPubkey,
  output,
  salt,
  proverEndpoint: './circuits-circuit/task_completion',
});

// Verify
const publicSignals = [
  hashes.constraintHash,
  hashes.outputCommitment,
  hashes.bindingValue,
];
const valid = await verifyProofLocally(
  result.proof,
  publicSignals,
  './circuits-circuit/task_completion'
);

console.log('Valid:', valid);
```
