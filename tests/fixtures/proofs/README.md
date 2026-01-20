# ZK Proof Test Fixtures

This directory contains test data for ZK proof verification tests.

## Current Test Approach

The tests in `tests/zk-proof-lifecycle.ts` and `tests/complete_task_private.ts` use
synthetic test proofs that exercise the on-chain validation logic without requiring
the Sunspot verifier program.

This approach tests:
- Proof size validation (exactly 388 bytes)
- Constraint hash binding (must match task)
- Private task requirement (non-zero constraint hash)
- Task status validation (must be InProgress)
- Worker authorization (must own agent PDA)
- Claim validation (must have claimed task)

## Generating Real Proofs

For end-to-end testing with real ZK proof verification:

### Prerequisites

1. Install Noir toolchain:
   ```bash
   curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
   noirup
   ```

2. Compile the circuit:
   ```bash
   cd circuits/task_completion
   nargo compile
   ```

### Proof Generation

1. Create a Prover.toml with your inputs:
   ```toml
   # Public inputs
   task_id = [/* 32 bytes */]
   agent_pubkey = [/* 32 bytes */]
   constraint_hash = [/* 32 bytes */]
   output_commitment = [/* 32 bytes */]
   expected_binding = [/* 32 bytes */]

   # Private inputs
   output = [/* 4 field elements */]
   salt = "12345"
   ```

2. Generate the proof:
   ```bash
   nargo prove
   ```

3. The proof will be written to `proofs/proof.bin` (388 bytes for Groth16 on BN254).

### Using Real Proofs in Tests

```typescript
import * as fs from "fs";

// Load real proof
const proofData = fs.readFileSync("tests/fixtures/proofs/valid_proof.bin");

const proof = {
  proofData: Array.from(proofData),
  constraintHash: /* from your Prover.toml */,
  outputCommitment: /* from your Prover.toml */,
  expectedBinding: /* from your Prover.toml */,
};
```

### Verifier Program

The Sunspot Groth16 verifier must be deployed for on-chain verification:
- Program ID: `8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ`
- The verification key must match the task_completion circuit

## Test Proof Files

| File | Description |
|------|-------------|
| `valid_proof.bin` | Valid 388-byte Groth16 proof (when generated) |
| `tampered_proof.bin` | Valid size but corrupted data |
| `undersized.bin` | Less than 388 bytes |
| `oversized.bin` | More than 388 bytes |

Note: Actual proof files are not checked in. Generate them locally for full testing.

## CI Considerations

For CI without the Sunspot verifier:
- Tests validate all on-chain logic before ZK verification
- ZK verification failures are expected with synthetic proofs
- Full verification requires devnet/testnet with deployed verifier
