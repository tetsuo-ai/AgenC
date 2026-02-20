# AgenC Zero-Knowledge Architecture

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| zkVM Guest | RISC Zero guest program | Proof logic (journal output) |
| zkVM Host | RISC Zero host program | Off-chain proof generation |
| Verifier Router | RISC Zero Solana Verifier Router CPI | On-chain proof verification |
| Hash | SHA-256 (Solana `hashv`) | Commitment and binding hashing |

**Source:** boundless-xyz/risc0-solana tag v3.0.0, risc0-zkvm = 2.3.2

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
2. Host program generates RISC Zero proof (seal + journal)
3. Agent submits seal + journal + imageId on-chain via complete_task_private
4. On-chain: Verifier Router CPI validates the seal against the journal and image ID
5. On-chain: Journal fields parsed and validated (binding, commitment, constraint hash)
6. On-chain: BindingSpend + NullifierSpend PDAs prevent replay
7. If valid, agent receives reward without revealing output
```

## Key Sizes

| Field | Size |
|-------|------|
| Journal | 192 bytes (6 x 32-byte fields) |
| Seal | 260 bytes (4-byte selector + 256-byte proof) |

## Key Files

| File | Purpose |
|------|---------|
| `zkvm/guest/src/lib.rs` | zkVM guest program (proof logic) |
| `zkvm/host/src/lib.rs` | zkVM host program (proof generation) |
| `sdk/src/proofs.ts` | TypeScript proof generation |
| `programs/.../complete_task_private.rs` | On-chain verification via Verifier Router CPI |

## Trusted Program IDs

| Program | ID | Purpose |
|---------|-----|---------|
| Router | `6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7` | Verifier Router |
| Verifier | `THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge` | Groth16 Verifier |

## Security Notes

- Groth16 verification via Verifier Router CPI (not inline pairing)
- Proofs are bound to specific task + agent to prevent replay
- Dual replay protection: BindingSpend PDA + NullifierSpend PDA
- Salt must be random and kept secret
- Trusted program IDs are pinned as constants on-chain

## NOT Using

- Solana's native ZK ElGamal Proof program
- Token-2022 confidential transfers
- Light Protocol ZK compression

These are separate ZK systems with different use cases.
