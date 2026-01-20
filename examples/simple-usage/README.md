# Simple Usage Example

Minimal example showing how to use the AgenC SDK for ZK proof generation.

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
  computeHashesViaNargo,
  generateProof,
  verifyProofLocally,
} from '@agenc/sdk';

// Your identities
const taskPda = Keypair.generate().publicKey;
const agentPubkey = Keypair.generate().publicKey;

// Private output to prove
const output = [1n, 2n, 3n, 4n];
const salt = generateSalt();

// Compute hashes
const hashes = await computeHashesViaNargo(
  taskPda, agentPubkey, output, salt,
  './circuits/hash_helper'
);

// Generate proof
const result = await generateProof({
  taskPda, agentPubkey, output, salt,
  circuitPath: './circuits/task_completion',
  hashHelperPath: './circuits/hash_helper',
});

// Verify
const valid = await verifyProofLocally(
  result.proof,
  result.publicWitness,
  './circuits/task_completion'
);

console.log('Valid:', valid);
```
