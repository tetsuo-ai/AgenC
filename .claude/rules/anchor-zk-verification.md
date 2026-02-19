---
paths:
  - "programs/**/complete_task_private.rs"
  - "programs/**/*proof*.rs"
  - "programs/**/*zk*.rs"
---

# Anchor ZK Proof Verification Rules

## Verifier Program

ZK proofs are verified via CPI to the Sunspot Groth16 verifier:
```rust
pub const ZK_VERIFIER_PROGRAM_ID: Pubkey = pubkey!("8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ");
```

## Proof Structure

```rust
pub struct PrivateCompletionPayload {
    pub proof_data: Vec<u8>,         // Groth16 proof (~256 bytes for BN254)
    pub constraint_hash: [u8; 32],   // Public: task constraint hash
    pub output_commitment: [u8; 32], // Public: commitment to private output
}
```

## Public Witness Format

35 public inputs (matching Noir circuit):
1. `task_id` (32 bytes) - Task key as field element
2. `agent_pubkey` (32 x 32 bytes) - Each byte as separate field element
3. `constraint_hash` (32 bytes)
4. `output_commitment` (32 bytes)

Header format: 12 bytes (4 bytes nr_inputs LE + 8 bytes padding)

## Verification via CPI

```rust
let ix = Instruction {
    program_id: verifier.key(),
    accounts: vec![],
    data: instruction_data,  // proof_bytes + public_witness
};
invoke(&ix, &[])?;  // Returns error if proof invalid
```

## Security Requirements

- Always validate `zk_verifier.key() == ZK_VERIFIER_PROGRAM_ID`
- Log public inputs for transparency/debugging
- Store commitment (not result) for private completions
- Verify task state before accepting proof

## NOT Affected by April 2025 Solana ZK Vulnerability

This codebase uses:
- Noir circuits (not Solana's ZK ElGamal)
- Sunspot/Groth16 verifier (not Token-2022)
- Poseidon2 hashing (not ElGamal encryption)

The Solana ZK ElGamal vulnerability does NOT apply here.
