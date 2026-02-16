# AgenC Zero-Knowledge Architecture

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Circuit | Noir | ZK circuit definition |
| Prover | Sunspot (Groth16) | Off-chain proof generation |
| Verifier | Sunspot on Solana | On-chain proof verification |
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
2. Agent generates Noir proof via nargo/sunspot
3. Agent submits proof on-chain via complete_task_private
4. Verifier CPI validates proof
5. If valid, agent receives reward without revealing output
```

## Key Files

| File | Purpose |
|------|---------|
| `circuits/task_completion/src/main.nr` | Noir circuit definition |
| `sdk/src/proofs.ts` | TypeScript proof generation |
| `programs/.../complete_task_private.rs` | On-chain verification |
| `docs/NOIR_REFERENCE.md` | Noir language reference |

## Security Notes

- This uses Groth16 (trusted setup required for production)
- Proofs are bound to specific task + agent to prevent replay
- Salt must be random and kept secret
- The Sunspot verifier program must be audited for production use

## NOT Using

- Solana's native ZK ElGamal Proof program
- Token-2022 confidential transfers
- Light Protocol ZK compression

These are separate ZK systems with different use cases.
