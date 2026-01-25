# ZK Proof Test Fixtures

This directory contains test data for ZK proof verification tests.

## Current Test Approach

The tests in `tests/zk-proof-lifecycle.ts` and `tests/complete_task_private.ts` use
synthetic test proofs that exercise the on-chain validation logic without requiring
full ZK verification.

This approach tests:
- Proof size validation (exactly 256 bytes for groth16-solana)
- Constraint hash binding (must match task)
- Private task requirement (non-zero constraint hash)
- Task status validation (must be InProgress)
- Worker authorization (must own agent PDA)
- Claim validation (must have claimed task)

## Generating Real Proofs

For end-to-end testing with real ZK proof verification:

### Prerequisites

1. Install circom and snarkjs:
   ```bash
   npm install -g circom snarkjs
   ```

2. Compile the circuit:
   ```bash
   cd circuits-circom/task_completion
   circom circuit.circom --r1cs --wasm --sym
   ```

### Proof Generation

1. Create an input.json with your inputs:
   ```json
   {
     "task_id": [/* 32 bytes */],
     "agent_pubkey": [/* 32 bytes */],
     "constraint_hash": "...",
     "output_commitment": "...",
     "output": [/* 4 field elements */],
     "salt": "12345"
   }
   ```

2. Generate the proof via SDK:
   ```typescript
   import { generateProof, generateSalt } from '@agenc/sdk';

   const result = await generateProof({
     taskPda,
     agentPubkey,
     output: [1n, 2n, 3n, 4n],
     salt: generateSalt(),
   });
   ```

3. The proof will be 256 bytes for Groth16 on BN254.

### Using Real Proofs in Tests

```typescript
import * as fs from "fs";

// Load real proof
const proofData = fs.readFileSync("tests/fixtures/proofs/valid_proof.bin");

const proof = {
  proofData: Array.from(proofData),
  constraintHash: /* computed hash */,
  outputCommitment: /* computed commitment */,
  expectedBinding: /* computed binding */,
};
```

### Verification

The groth16-solana verifier is embedded in the AgenC program:
- Verification happens inline during `complete_task_private`
- The verification key is embedded in the program's verifying_key.rs

## Test Proof Files

| File | Description |
|------|-------------|
| `valid_proof.bin` | Valid 256-byte Groth16 proof (when generated) |
| `tampered_proof.bin` | Valid size but corrupted data |
| `undersized.bin` | Less than 256 bytes |
| `oversized.bin` | More than 256 bytes |

Note: Actual proof files are not checked in. Generate them locally for full testing.

## CI Considerations

For CI:
- Tests validate all on-chain logic before ZK verification
- ZK verification uses the inline groth16-solana verifier
- Full verification tests require proper trusted setup artifacts
