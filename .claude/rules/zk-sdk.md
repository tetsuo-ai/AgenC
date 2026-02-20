---
paths:
  - "sdk/src/proofs.ts"
  - "sdk/src/**/*proof*.ts"
---

# ZK Proof SDK Rules (RISC Zero)

## Proof Generation Flow

1. Prepare proof inputs (task ID, agent pubkey, output, salt, constraint hash)
2. Host program generates RISC Zero proof producing a seal and journal
3. SDK packages seal + journal + imageId into a `ProofResult`
4. Submit on-chain via `completeTaskPrivate` with router accounts

## ProofResult Structure

```typescript
interface ProofResult {
  sealBytes: Uint8Array;      // RISC Zero seal (260 bytes: 4 selector + 256 proof)
  journal: Uint8Array;        // Journal output (192 bytes: 6 x 32-byte fields)
  imageId: Uint8Array;        // RISC Zero image ID (32 bytes)
  bindingSeed: Uint8Array;    // Binding seed for replay protection
  nullifierSeed: Uint8Array;  // Nullifier seed for replay protection
}
```

## Key Constants

```typescript
RISC0_SEAL_BORSH_LEN = 260;          // 4-byte selector + 256-byte Groth16 proof
RISC0_JOURNAL_LEN = 192;             // 6 x 32-byte fields
TRUSTED_RISC0_SELECTOR = [/* ... */]; // 4-byte selector for Groth16 via router
TRUSTED_RISC0_IMAGE_ID = [/* ... */]; // 32-byte image ID of the guest program
```

## Journal Layout (192 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 32 | Task PDA |
| 32 | 32 | Agent pubkey |
| 64 | 32 | Constraint hash |
| 96 | 32 | Output commitment |
| 128 | 32 | Binding seed |
| 160 | 32 | Nullifier seed |

## completeTaskPrivate Flow

1. Generate proof via RISC Zero host
2. Build transaction with seal, journal, and imageId
3. Include router accounts: Verifier Router program, Verifier program
4. On-chain validates seal via Verifier Router CPI
5. On-chain parses journal and validates fields
6. BindingSpend + NullifierSpend PDAs initialized for replay protection

## Router Accounts Required

```typescript
// Additional accounts for complete_task_private
{
  routerProgram: new PublicKey('6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7'),
  verifierProgram: new PublicKey('THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge'),
}
```

## Error Handling

- **InvalidSealEncoding** - Seal bytes cannot be decoded (wrong length or format)
- **InvalidJournalLength** - Journal is not exactly 192 bytes
- **InvalidJournalBinding** - Journal task/agent fields do not match on-chain accounts
- **InvalidConstraintHash** - Journal constraint hash does not match task
- **NullifierAlreadySpent** - Proof replay detected (NullifierSpend PDA already exists)
- **BindingAlreadySpent** - Binding replay detected (BindingSpend PDA already exists)

Always wrap proof generation in try/catch. The RISC Zero host can fail for various reasons (invalid inputs, compilation errors, resource limits).
