// DEPRECATED: This circuit is kept for reference only.
// The canonical ZK circuit is circuits/task_completion/ (Noir) or circuits-circom/ (Circom).
// This hash_helper uses Poseidon2 (Noir) which is NOT compatible with circomlib Poseidon.
// Do NOT use for proof generation — the hashes will NOT match the on-chain verifier.
//
// Original purpose: compute Poseidon2 hashes for the task_completion circuit.
// - constraint_hash = hash(output)
// - output_commitment = hash(constraint_hash, salt)  [OLD FORMULA — current circuit uses Poseidon5(output, salt)]
// - expected_binding = hash(hash(task_field, agent_field), output_commitment)

use std::hash::poseidon2_permutation;

global POSEIDON_STATE_SIZE: u32 = 4;
global BYTES_PER_FIELD: Field = 256;
global PUBKEY_SIZE: u32 = 32;

fn hash_4(input: [Field; 4]) -> Field {
    let permuted = poseidon2_permutation(input, POSEIDON_STATE_SIZE);
    permuted[0]
}

fn hash_2(a: Field, b: Field) -> Field {
    let input: [Field; 4] = [a, b, 0, 0];
    let permuted = poseidon2_permutation(input, POSEIDON_STATE_SIZE);
    permuted[0]
}

// BN254 scalar field modulus bytes (big-endian)
global BN254_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
    0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01
];

// Check if a 32-byte array is strictly less than the BN254 field modulus
// Uses lexicographic comparison (big-endian byte order)
fn bytes_less_than_modulus(bytes: [u8; 32]) -> bool {
    let mut result = false;
    let mut decided = false;

    for i in 0..32 {
        if !decided {
            if bytes[i] < BN254_MODULUS[i] {
                result = true;
                decided = true;
            } else if bytes[i] > BN254_MODULUS[i] {
                result = false;
                decided = true;
            }
        }
    }
    result
}

fn bytes_to_field(bytes: [u8; 32]) -> Field {
    // Security: Validate input is within BN254 scalar field to prevent field aliasing
    assert(bytes_less_than_modulus(bytes), "Input exceeds BN254 field modulus");

    let mut field: Field = 0;
    for i in 0..PUBKEY_SIZE {
        field = field * BYTES_PER_FIELD + (bytes[i] as Field);
    }
    field
}

// Main function computes all hashes needed for proof generation
// Returns (constraint_hash, output_commitment, expected_binding)
fn main(
    task_id: [u8; 32],
    agent_pubkey: [u8; 32],
    output: [Field; 4],
    salt: Field,
) -> pub (Field, Field, Field) {
    // Compute constraint_hash = hash(output)
    let constraint_hash = hash_4(output);

    // Compute output_commitment = hash(constraint_hash, salt)
    let output_commitment = hash_2(constraint_hash, salt);

    // Compute expected_binding
    let task_field = bytes_to_field(task_id);
    let agent_field = bytes_to_field(agent_pubkey);
    let binding = hash_2(task_field, agent_field);
    let expected_binding = hash_2(binding, output_commitment);

    (constraint_hash, output_commitment, expected_binding)
}

#[test]
fn test_hash_helper_matches_task_completion() {
    // Same test values as task_completion circuit
    let task_id: [u8; 32] = [
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a
    ];

    let agent_pubkey: [u8; 32] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20
    ];

    let output: [Field; 4] = [1, 2, 3, 4];
    let salt: Field = 12345;

    let (constraint_hash, output_commitment, expected_binding) = main(task_id, agent_pubkey, output, salt);

    // These values should match the task_completion circuit test output
    println(f"constraint_hash = {constraint_hash}");
    println(f"output_commitment = {output_commitment}");
    println(f"expected_binding = {expected_binding}");

    // Verify against known values from task_completion tests
    assert(constraint_hash == 0x224785a48a72c75e2cbb698143e71d5d41bd89a2b9a7185871e39a54ce5785b1);
    assert(output_commitment == 0x2a4c1b6d1dbda0140b9f9440e8be130b2547074d1db76f96f8c815343bb2239a);
    assert(expected_binding == 0x1d78cba9074d45399c8a90d8ae5f018b908ca61d3682f354704b7c9a176d3320);
}
