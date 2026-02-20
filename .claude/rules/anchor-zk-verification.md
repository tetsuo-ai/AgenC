---
paths:
  - "programs/**/complete_task_private.rs"
  - "programs/**/*proof*.rs"
  - "programs/**/*zk*.rs"
---

# Anchor ZK Proof Verification Rules (RISC Zero)

## Verifier Router CPI

ZK proofs are verified via CPI to the RISC Zero Verifier Router, NOT inline pairing math.

### Trusted Program IDs (Pinned Constants)

```rust
/// RISC Zero Verifier Router
pub const ROUTER_PROGRAM_ID: Pubkey = pubkey!("6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7");

/// RISC Zero Groth16 Verifier
pub const VERIFIER_PROGRAM_ID: Pubkey = pubkey!("THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge");
```

These are pinned as constants on-chain. The instruction validates that the passed program accounts match these IDs.

## Seal Decode

The seal is 260 bytes total:
- **4 bytes:** Selector (identifies which verifier to route to)
- **256 bytes:** Groth16 proof data

```rust
// Decode seal
let selector = &seal[0..4];       // Route to correct verifier
let proof_data = &seal[4..260];   // Groth16 proof
```

## Journal Parse

The journal is 192 bytes total (6 x 32-byte fields):

| Offset | Field | Validation |
|--------|-------|------------|
| 0..32 | Task PDA | Must match `task.key()` |
| 32..64 | Agent pubkey | Must match signer |
| 64..96 | Constraint hash | Must match `task.constraint_hash` |
| 96..128 | Output commitment | Must not be all zeros |
| 128..160 | Binding seed | Used for BindingSpend PDA |
| 160..192 | Nullifier seed | Used for NullifierSpend PDA |

```rust
// Parse journal fields
let journal_task_pda = &journal[0..32];
let journal_agent = &journal[32..64];
let journal_constraint = &journal[64..96];
let journal_commitment = &journal[96..128];
let journal_binding = &journal[128..160];
let journal_nullifier = &journal[160..192];
```

## Verification via CPI

```rust
// Build CPI to Verifier Router
let verify_ix = risc0_solana::verify_instruction(
    &image_id,
    &journal,
    &seal,
);
invoke(&verify_ix, &[router_program.clone(), verifier_program.clone()])?;
```

## Dual Replay Protection

Two PDAs are initialized during private completion to prevent replay:

### BindingSpend PDA
- **Seeds:** `["binding_spend", binding_seed]`
- **Purpose:** Prevents the same binding (task+agent combination) from being used twice
- **Initialized via `init`:** Transaction fails if PDA already exists

### NullifierSpend PDA
- **Seeds:** `["nullifier_spend", nullifier_seed]`
- **Purpose:** Prevents the same proof from being submitted twice
- **Initialized via `init`:** Transaction fails if PDA already exists

Both PDAs are rent-exempt accounts created during the instruction. The `init` constraint ensures uniqueness -- attempting to create an already-existing PDA causes an Anchor error.

## Error Codes

| Error | Description |
|-------|-------------|
| `InvalidSealEncoding` | Seal bytes wrong length or malformed |
| `InvalidJournalLength` | Journal is not exactly 192 bytes |
| `InvalidJournalBinding` | Journal task PDA or agent pubkey mismatch |
| `InvalidConstraintHash` | Journal constraint hash does not match task |
| `InvalidOutputCommitment` | Output commitment is all zeros |
| `NullifierAlreadySpent` | NullifierSpend PDA already exists (replay) |
| `BindingAlreadySpent` | BindingSpend PDA already exists (replay) |
| `InvalidRouterProgram` | Router program ID does not match pinned constant |
| `InvalidVerifierProgram` | Verifier program ID does not match pinned constant |

## NOT Affected by April 2025 Solana ZK Vulnerability

This codebase uses:
- RISC Zero zkVM (not Solana's ZK ElGamal)
- Verifier Router CPI / Groth16 (not Token-2022)
- SHA-256 hashing via Solana `hashv` (not ElGamal encryption)

The Solana ZK ElGamal vulnerability does NOT apply here.
