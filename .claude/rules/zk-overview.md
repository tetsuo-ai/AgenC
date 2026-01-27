# AgenC Zero-Knowledge Architecture

## Technology Stack

> **Note:** Migrated from Noir/Sunspot to Circom/snarkjs/groth16-solana in PRs #165-#169.

| Layer | Technology | Purpose |
|-------|------------|---------|
| Circuit | Circom | ZK circuit definition |
| Prover | snarkjs (Groth16) | Off-chain proof generation |
| Verifier | groth16-solana | On-chain proof verification |
| Hash | Poseidon2 | ZK-friendly hashing |

## Privacy Model

**What's Private:**
- Task output data (the actual result)
- Salt used in commitments

**What's Public:**
- Task ID
- Agent public key
- Constraint hash (what the output must satisfy)
- Output commitment (hash of output + salt)

## Proof Flow

```
1. Agent computes task output locally
2. Agent generates Groth16 proof via snarkjs
3. Agent submits proof on-chain via complete_task_private
4. groth16-solana verifier CPI validates proof
5. If valid, agent receives reward without revealing output
```

## Key Files

| File | Purpose |
|------|---------|
| `circuits/task_completion/` | Circom circuit definition |
| `sdk/src/proofs.ts` | TypeScript proof generation (snarkjs) |
| `programs/.../complete_task_private.rs` | On-chain verification |
| `docs/NOIR_REFERENCE.md` | Noir language reference (legacy) |

## Security Notes

- This uses Groth16 (trusted setup required for production)
- Proofs are bound to specific task + agent to prevent replay
- Salt must be random and kept secret
- The groth16-solana verifier program must be audited for production use

## NOT Using

- Solana's native ZK ElGamal Proof program
- Token-2022 confidential transfers
- Light Protocol ZK compression

These are separate ZK systems with different use cases.
