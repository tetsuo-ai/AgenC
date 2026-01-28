# Security Audit Report: ZK/Privacy and Circuits (Stream A6)

**Audit Date:** 2025-01-29  
**Auditor:** Security Subagent (A6)  
**Scope:** Zero-knowledge proof vulnerabilities and privacy leaks  
**Repository:** AgenC

---

## Executive Summary

This audit reviewed the ZK proof system used for private task completion in AgenC. The system uses Groth16 (BN254) proofs via groth16-solana for on-chain verification, with circuits implemented in both Circom and Noir.

**Critical Finding:** The verifying key uses identical gamma and delta values, indicating a non-production trusted setup that could allow proof forgery.

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 1 |
| MEDIUM | 2 |
| LOW | 2 |
| INFO | 3 |

---

## Findings

### CRITICAL-01: Dummy Trusted Setup - Gamma equals Delta

**Severity:** CRITICAL  
**Location:** `programs/agenc-coordination/src/verifying_key.rs`  
**Status:** Requires Immediate Action

**Description:**  
The Groth16 verifying key has `VK_GAMMA_G2` and `VK_DELTA_G2` set to **identical values**:

```rust
pub const VK_GAMMA_G2: [u8; 128] = [
    0x19, 0x8e, 0x93, 0x93, 0x92, 0x0d, 0x48, 0x3a, ...
];

pub const VK_DELTA_G2: [u8; 128] = [
    0x19, 0x8e, 0x93, 0x93, 0x92, 0x0d, 0x48, 0x3a, ... // IDENTICAL!
];
```

The source `verification_key.json` confirms this with well-known test values:
- `vk_gamma_2[0][0]` = "10857046999023057135944570762232829481370756359578518086990519993285655852781"
- `vk_delta_2[0][0]` = "10857046999023057135944570762232829481370756359578518086990519993285655852781"

These are the **default snarkjs development values**, not from a proper trusted setup.

**Impact:**  
In Groth16, gamma and delta must be different random group elements generated during a trusted setup ceremony. When gamma == delta:
1. The simulation trapdoor degeneracy may allow crafting valid-looking proofs without knowing witnesses
2. Multiple attack vectors become possible depending on specific values
3. The soundness property of the proof system may be compromised

**Recommendation:**
1. **DO NOT deploy to mainnet** with this verifying key
2. Conduct a proper trusted setup ceremony (e.g., using snarkjs with Phase 2 contributions)
3. Document the ceremony and publish the transcript for verifiability
4. Consider using a universal/updatable setup like PLONK to avoid this issue in future

---

### HIGH-01: Missing Nullifier Mechanism for Global Proof Uniqueness

**Severity:** HIGH  
**Location:** Circuit design, `complete_task_private.rs`  
**Status:** Open

**Description:**  
The system lacks a global nullifier mechanism to prevent proof reuse across the protocol. While the current binding mechanism (`hash(hash(task_id, agent), commitment)`) provides contextual uniqueness, it has limitations:

1. **Same output reusable:** An agent who solves task A can potentially create proofs for task B if both tasks have the same `constraint_hash` (expected output hash)
2. **No spent nullifier set:** There's no on-chain set tracking which proofs have been used globally

**Current Mitigation:**  
- `claim.is_completed` flag prevents completing the same claim twice
- The binding includes task_id, so cross-task replay requires the same task

**Impact:**  
If two tasks share the same `constraint_hash` (e.g., both require finding a preimage to the same hash):
- Agent solves task A, generating a valid proof
- The same output+salt could theoretically satisfy task B's constraint
- While the binding would be different, the core knowledge could be reused

**Recommendation:**
1. Consider adding a nullifier to the circuit: `nullifier = hash(salt, agent_secret_key)`
2. Store spent nullifiers in an on-chain Merkle tree or indexed account
3. Verify `nullifier ∉ spent_nullifiers` before accepting proofs

---

### MEDIUM-01: Public Input Encoding Mismatch Risk Between Components

**Severity:** MEDIUM  
**Location:** `sdk/src/proofs.ts`, `complete_task_private.rs`, circuit files  
**Status:** Review Recommended

**Description:**  
There are three different implementations of public input encoding:

1. **Circom circuit** (circomlib Poseidon):
   - Uses `poseidon2` for 2 inputs, `poseidon4` for 4 inputs
   - Bytes to field via manual big-endian conversion

2. **Noir circuit** (std::poseidon2_permutation):
   - Uses Poseidon2 permutation in sponge mode
   - Different internal implementation

3. **SDK** (poseidon-lite):
   - Uses `poseidon2`, `poseidon4` from poseidon-lite
   - Claims circomlib compatibility

4. **On-chain** (groth16-solana):
   - Encodes each pubkey byte as separate 32-byte field element
   - Different format than SDK's `pubkeyToField()`

**Potential Issue:**  
The on-chain code uses:
```rust
// Public inputs 0-31: task_id (each byte as separate field element)
append_pubkey_as_field_elements(&mut inputs, 0, task_key);
```

But the circuit and SDK use a single field element for the entire pubkey:
```typescript
export function pubkeyToField(pubkey: PublicKey): bigint {
  // Single field element from 32 bytes
}
```

**Impact:**  
If the encoding doesn't match exactly between components, valid proofs would be rejected, or worse, the security properties might differ.

**Recommendation:**
1. Add explicit cross-component integration tests with real proofs
2. Document the exact public input format in a single source of truth
3. Verify the 67 public inputs match: 32 (task bytes) + 32 (agent bytes) + 3 (hashes) across all components

---

### MEDIUM-02: Field Overflow Check Only Heuristic in Noir Circuit

**Severity:** MEDIUM  
**Location:** `circuits/task_completion/src/main.nr`  
**Status:** Open

**Description:**  
The Noir circuit uses a heuristic field overflow check:

```noir
fn bytes_to_field(bytes: [u8; 32]) -> Field {
    // BN254 scalar field modulus starts with 0x30644e72...
    // Any input with first byte > 0x30 definitely exceeds the modulus
    assert(bytes[0] <= 0x30, "Input may exceed field modulus");
    // ...
}
```

This is a **heuristic check**, not a full modulus comparison. Values like `0x30644e73...` would pass the check but still exceed the field modulus.

**Impact:**  
- Ed25519 pubkeys are always < 2^252, so this is unlikely to trigger with real pubkeys
- However, maliciously crafted inputs could bypass this check
- The comment acknowledges this: "This is a heuristic check - full modulus comparison would be expensive in-circuit"

**Recommendation:**
1. Document this limitation clearly in security considerations
2. Ensure task IDs are validated on-chain before being used
3. Consider full modulus comparison if compute budget allows

---

### LOW-01: No Constraint on Output Uniqueness in Circuit

**Severity:** LOW  
**Location:** Circuit files  
**Status:** Informational

**Description:**  
The circuit accepts any output values that hash to the expected `constraint_hash`. There's no mechanism to ensure output uniqueness or ordering.

For example, if `constraint_hash = hash(1, 2, 3, 4)`, a circuit accepting `output = [4, 3, 2, 1]` with a different internal ordering could also satisfy the constraint if the hash function is order-dependent (which Poseidon is).

**Impact:** Low - this is by design for flexibility, but could be relevant depending on use case.

**Recommendation:** Document that outputs are only validated against their hash, not their specific values.

---

### LOW-02: Salt Generation Uses Web Crypto API

**Severity:** LOW  
**Location:** `sdk/src/proofs.ts`  
**Status:** Acceptable

**Description:**  
```typescript
export function generateSalt(): bigint {
  const bytes = new Uint8Array(HASH_SIZE);
  crypto.getRandomValues(bytes);
  // ...
}
```

This relies on the browser/Node.js `crypto.getRandomValues()`. While generally secure, it's worth noting:
- Server-side Node.js uses `/dev/urandom` (good)
- Browser implementations vary
- No fallback for environments without Web Crypto

**Recommendation:** Consider using a dedicated cryptographic library for consistent behavior across environments.

---

### INFO-01: Privacy Model Documentation

**Severity:** INFO  
**Location:** Documentation  
**Status:** Observation

**Description:**  
The system stores `output_commitment` on-chain after task completion:
```rust
claim.proof_hash = proof.output_commitment;
```

This commitment is the hash of `(constraint_hash, salt)`, not the raw output. This correctly preserves privacy of the actual output values.

However, the `constraint_hash` (public) + `output_commitment` (public) combination could theoretically be used for correlation if the same output is submitted to multiple tasks with different salts.

**Recommendation:** Document the privacy guarantees and limitations in user-facing documentation.

---

### INFO-02: Hash Function Compatibility

**Severity:** INFO  
**Location:** Multiple files  
**Status:** Observation

**Description:**  
The system uses different Poseidon implementations:
- **Circom:** circomlib Poseidon (widely audited)
- **Noir:** std::poseidon2_permutation (Noir stdlib)
- **SDK:** poseidon-lite (claims circomlib compatibility)

These should produce identical outputs for identical inputs, but:
- Different implementations may have subtle differences
- The SDK documentation claims compatibility but doesn't prove it

**Recommendation:** Add explicit tests that hash the same inputs in all three implementations and verify identical outputs.

---

### INFO-03: Competitive Task Double-Completion Race Condition Mitigated

**Severity:** INFO  
**Location:** `complete_task_private.rs`  
**Status:** Correctly Handled

**Description:**  
The code correctly handles competitive task completion:
```rust
if task.task_type == TaskType::Competitive {
    require!(
        task.completions == 0,
        CoordinationError::CompetitiveTaskAlreadyWon
    );
}
```

This check occurs BEFORE ZK verification, preventing wasted compute on already-won tasks.

---

## Audit Checklist

| Check | Status | Notes |
|-------|--------|-------|
| Proof verification bypass | ⚠️ | Trusted setup issue (CRITICAL-01) |
| Constraint satisfaction | ✅ | All three constraints properly enforced |
| Public input manipulation | ⚠️ | Encoding mismatch risk (MEDIUM-01) |
| Privacy leaks | ✅ | Only commitment stored, not raw output |
| Replay attacks | ⚠️ | Contextual protection only (HIGH-01) |
| Nullifier issues | ⚠️ | No global nullifier (HIGH-01) |
| Trusted setup | ❌ | Dummy setup detected (CRITICAL-01) |

---

## Recommendations Summary

### Immediate (Before Mainnet)
1. **Conduct proper trusted setup ceremony** (CRITICAL-01)
2. **Verify public input encoding** matches across all components (MEDIUM-01)

### Short-Term
3. Consider adding nullifier mechanism (HIGH-01)
4. Add cross-component integration tests
5. Document privacy model and limitations

### Long-Term
6. Consider migrating to universal setup (PLONK/Groth16 with KZG)
7. Formal verification of circuit constraints
8. Third-party audit of circuit implementations

---

## Files Reviewed

- `programs/agenc-coordination/src/instructions/complete_task_private.rs`
- `programs/agenc-coordination/src/verifying_key.rs`
- `programs/agenc-coordination/src/errors.rs`
- `circuits-circom/task_completion/circuit.circom`
- `circuits/task_completion/src/main.nr`
- `sdk/src/proofs.ts`
- `sdk/src/__tests__/proofs.test.ts`
- `tests/complete_task_private.ts`
- `tests/zk-proof-lifecycle.ts`
- `tests/sdk-proof-generation.ts`

---

*End of Audit Report*
