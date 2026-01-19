// AgenC Private Task Completion Circuit
// Proves task completion without revealing output
//
// Uses poseidon2_permutation for hashing (Sunspot compatible)

use std::hash::poseidon2_permutation;

// Poseidon2 state size for BN254
global POSEIDON_STATE_SIZE: u32 = 4;

// Byte size for field packing
global BYTES_PER_FIELD: Field = 256;

// Standard sizes
global PUBKEY_SIZE: u32 = 32;

// Hash helper using poseidon2 permutation in sponge mode
fn hash_4(input: [Field; 4]) -> Field {
    let permuted = poseidon2_permutation(input, POSEIDON_STATE_SIZE);
    permuted[0]
}

fn hash_2(a: Field, b: Field) -> Field {
    let input: [Field; 4] = [a, b, 0, 0];
    let permuted = poseidon2_permutation(input, POSEIDON_STATE_SIZE);
    permuted[0]
}

// Convert 32-byte array to field element (big-endian interpretation)
// WARNING: Values exceeding the BN254 field modulus (~2^254) will wrap.
// This is acceptable for Ed25519 pubkeys and typical task_ids, but callers
// should ensure inputs don't exceed the modulus to avoid potential collisions.
fn bytes_to_field(bytes: [u8; 32]) -> Field {
    let mut field: Field = 0;
    for i in 0..PUBKEY_SIZE {
        field = field * BYTES_PER_FIELD + (bytes[i] as Field);
    }
    field
}

fn main(
    // Public inputs (all as byte arrays for consistent on-chain encoding)
    task_id: pub [u8; 32],
    agent_pubkey: pub [u8; 32],
    constraint_hash: pub Field,
    output_commitment: pub Field,
    expected_binding: pub Field,  // Binding to prevent replay attacks

    // Private inputs
    output: [Field; 4],
    salt: Field,
) {
    // 1. Verify output satisfies the task constraint
    let computed_constraint = hash_4(output);
    assert(computed_constraint == constraint_hash, "Output hash does not match constraint_hash");

    // 2. Verify the commitment is correctly formed
    let computed_commitment = hash_2(computed_constraint, salt);
    assert(computed_commitment == output_commitment, "Commitment does not match output_commitment");

    // 3. Bind proof to task and agent
    let task_field = bytes_to_field(task_id);
    let agent_field = bytes_to_field(agent_pubkey);
    let binding = hash_2(task_field, agent_field);
    let full_binding = hash_2(binding, output_commitment);

    // CRITICAL: Assert binding matches expected (prevents replay attacks)
    assert(full_binding == expected_binding, "Binding mismatch - possible replay attack");
}

// Helper to compute expected binding for tests
fn compute_expected_binding(task_id: [u8; 32], agent_pubkey: [u8; 32], output_commitment: Field) -> Field {
    let task_field = bytes_to_field(task_id);
    let agent_field = bytes_to_field(agent_pubkey);
    let binding = hash_2(task_field, agent_field);
    hash_2(binding, output_commitment)
}

// ============================================================================
// Test Fixtures - representative values for testing
// ============================================================================

// Task ID representing value 42 (0x2a) as big-endian 32-byte array
global TEST_TASK_ID: [u8; 32] = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a
];

// Sequential bytes 0x01-0x20 representing a test agent pubkey
global TEST_AGENT_PUBKEY: [u8; 32] = [
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
    0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
    0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20
];

// Wrong task ID (999 = 0x03e7)
global WRONG_TASK_ID: [u8; 32] = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xe7
];

// Wrong agent (all 0xAA bytes)
global WRONG_AGENT: [u8; 32] = [0xAA; 32];

// Standard test output
global TEST_OUTPUT: [Field; 4] = [1, 2, 3, 4];

// Standard test salt
global TEST_SALT: Field = 12345;

// ============================================================================
// Tests
// ============================================================================

#[test]
fn test_valid_proof() {
    let constraint_hash = hash_4(TEST_OUTPUT);
    let output_commitment = hash_2(constraint_hash, TEST_SALT);

    let expected_binding = compute_expected_binding(TEST_TASK_ID, TEST_AGENT_PUBKEY, output_commitment);

    main(TEST_TASK_ID, TEST_AGENT_PUBKEY, constraint_hash, output_commitment, expected_binding, TEST_OUTPUT, TEST_SALT);
}

#[test(should_fail)]
fn test_wrong_output_fails() {
    let wrong_output: [Field; 4] = [5, 6, 7, 8];

    let constraint_hash = hash_4(TEST_OUTPUT);
    let wrong_constraint = hash_4(wrong_output);
    let output_commitment = hash_2(wrong_constraint, TEST_SALT);

    let task_id: [u8; 32] = [0; 32];
    let agent_pubkey: [u8; 32] = [0; 32];

    let expected_binding = compute_expected_binding(task_id, agent_pubkey, output_commitment);

    main(task_id, agent_pubkey, constraint_hash, output_commitment, expected_binding, wrong_output, TEST_SALT);
}

#[test(should_fail)]
fn test_wrong_salt_fails() {
    let wrong_salt: Field = 99999;

    let constraint_hash = hash_4(TEST_OUTPUT);
    let output_commitment = hash_2(constraint_hash, TEST_SALT);

    let task_id: [u8; 32] = [0; 32];
    let agent_pubkey: [u8; 32] = [0; 32];

    let expected_binding = compute_expected_binding(task_id, agent_pubkey, output_commitment);

    main(task_id, agent_pubkey, constraint_hash, output_commitment, expected_binding, TEST_OUTPUT, wrong_salt);
}

#[test(should_fail)]
fn test_wrong_task_id_fails() {
    let constraint_hash = hash_4(TEST_OUTPUT);
    let output_commitment = hash_2(constraint_hash, TEST_SALT);

    // Compute binding with CORRECT task_id
    let expected_binding = compute_expected_binding(TEST_TASK_ID, TEST_AGENT_PUBKEY, output_commitment);

    // Try with WRONG task_id - binding won't match
    main(WRONG_TASK_ID, TEST_AGENT_PUBKEY, constraint_hash, output_commitment, expected_binding, TEST_OUTPUT, TEST_SALT);
}

#[test(should_fail)]
fn test_wrong_agent_fails() {
    let constraint_hash = hash_4(TEST_OUTPUT);
    let output_commitment = hash_2(constraint_hash, TEST_SALT);

    // Compute binding with CORRECT agent
    let expected_binding = compute_expected_binding(TEST_TASK_ID, TEST_AGENT_PUBKEY, output_commitment);

    // Try with WRONG agent - binding won't match
    main(TEST_TASK_ID, WRONG_AGENT, constraint_hash, output_commitment, expected_binding, TEST_OUTPUT, TEST_SALT);
}

#[test]
fn test_correct_binding_succeeds() {
    let constraint_hash = hash_4(TEST_OUTPUT);
    let output_commitment = hash_2(constraint_hash, TEST_SALT);

    // Compute correct binding
    let expected_binding = compute_expected_binding(TEST_TASK_ID, TEST_AGENT_PUBKEY, output_commitment);

    main(TEST_TASK_ID, TEST_AGENT_PUBKEY, constraint_hash, output_commitment, expected_binding, TEST_OUTPUT, TEST_SALT);
}
