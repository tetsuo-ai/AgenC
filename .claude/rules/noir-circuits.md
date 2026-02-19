---
paths:
  - "circuits/**/*.nr"
  - "circuits/**/Nargo.toml"
  - "circuits/**/Prover.toml"
---

# Noir Circuit Development Rules

Reference documentation: `docs/NOIR_REFERENCE.md`

## Language Basics

- Noir version: >=0.36.0 (compiler_version in Nargo.toml)
- All inputs are **private by default** - use `pub` for public inputs
- The `Field` type is the native field element - prefer it over integers when possible
- Use `assert()` for constraints, not return values

## Circuit Structure

```noir
fn main(
    private_input: Field,           // Private (default)
    public_input: pub Field,        // Public
    array_input: pub [u8; 32],      // Public array
) {
    // Constraints go here
    assert(condition);
}
```

## Hash Functions

This project uses **Poseidon2** for ZK-friendly hashing:

```noir
use std::hash::poseidon2_permutation;

fn hash_4(input: [Field; 4]) -> Field {
    let permuted = poseidon2_permutation(input, 4);
    permuted[0]
}

fn hash_2(a: Field, b: Field) -> Field {
    let input: [Field; 4] = [a, b, 0, 0];
    let permuted = poseidon2_permutation(input, 4);
    permuted[0]
}
```

## Control Flow Constraints

- `for` loops must have **compile-time known bounds** (e.g., `for i in 0..32`)
- `while`, `loop`, `break`, `continue` only work in `unconstrained fn`
- No dynamic iteration in constrained code

## Testing

```noir
#[test]
fn test_valid_case() {
    // Test code
    assert(result == expected);
}

#[test(should_fail)]
fn test_invalid_case() {
    // Should trigger assertion failure
}
```

## Nargo Commands

```bash
risc0-host-prover check          # Validate without compiling
risc0-host-prover execute        # Compile + generate witness
risc0-host-prover test           # Run all tests
risc0-host-prover test my_test   # Run specific test
risc0-host-prover info           # Show circuit stats (gates, opcodes)
```

## Prover.toml Format

```toml
# Field values as strings
task_id = "42"
salt = "12345"

# Hex values
constraint_hash = "0xabcd..."

# Arrays
output = ["1", "2", "3", "4"]
agent_pubkey = [1, 2, 3, 4, ...]  # u8 array as integers
```

## Common Patterns in AgenC

### Commitment Scheme
```noir
let computed_commitment = hash_2(value, salt);
assert(computed_commitment == public_commitment);
```

### Binding Proof to Identity
```noir
let binding = hash_2(task_id, agent_field);
```

## Security Considerations

- Always bind proofs to specific identities (agent pubkey, task ID)
- Use random salts for commitments to prevent rainbow table attacks
- Verify all public inputs match expected values via assertions
- Keep private witness data (output, salt) truly private
