---
paths:
  - "sdk/src/proofs.ts"
  - "sdk/src/**/*proof*.ts"
---

# ZK Proof SDK Rules

## Proof Generation Flow

1. Generate `Prover.toml` with inputs
2. Run `nargo execute` to compile and generate witness
3. Run `sunspot prove` to generate Groth16 proof
4. Verify locally with `sunspot verify` before on-chain submission

## Required Tools

- `nargo` - Noir compiler (>=0.36.0)
- `sunspot` - Groth16 prover for Solana

Check availability:
```typescript
const { nargo, sunspot } = checkToolsAvailable();
```

## Public Inputs Structure

The circuit expects these public inputs:
- `task_id: Field` - Task identifier
- `agent_pubkey: [u8; 32]` - Agent's Solana public key
- `constraint_hash: Field` - Hash of task constraints
- `output_commitment: Field` - Commitment to private output

## Private Inputs

- `output: [Field; 4]` - Actual task output (hidden)
- `salt: Field` - Random value for commitment

## Poseidon2 Implementation

The SDK has placeholder implementations for `computeConstraintHashFromOutput` and `computeCommitment`. These need proper Poseidon2 implementations matching the Noir circuit's `poseidon2_permutation`.

## Proof Result Structure

```typescript
interface ProofResult {
  proof: Buffer;           // Raw Groth16 proof bytes
  publicWitness: Buffer;   // Public inputs for verification
  proofSize: number;       // Size in bytes
  generationTime: number;  // Generation time in ms
}
```

## Error Handling

Always wrap proof generation in try/catch - the `nargo` and `sunspot` CLI tools can fail for various reasons (invalid inputs, missing files, compilation errors).
