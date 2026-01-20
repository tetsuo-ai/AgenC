// Hash Helper Circuit for AgenC SDK
// Computes Poseidon2 hashes that match the task_completion circuit exactly
//
// This circuit is used by the SDK to compute:
// - constraint_hash = hash(output)
// - output_commitment = hash(constraint_hash, salt)
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

fn bytes_to_field(bytes: [u8; 32]) -> Field {
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
