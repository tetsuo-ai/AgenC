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

// BN254 scalar field modulus as bytes (big-endian)
// Value: 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
global BN254_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
    0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01
];

// Hash 4 field elements using Poseidon2 permutation in sponge mode
// Returns the first element of the permuted state as the hash output
// Security: Poseidon2 is a ZK-friendly algebraic hash function providing collision resistance
fn hash_4(input: [Field; 4]) -> Field {
    let permuted = poseidon2_permutation(input, POSEIDON_STATE_SIZE);
    permuted[0]
}

// Hash 2 field elements using Poseidon2 permutation
// Inputs are padded with zeros to fill the 4-element state
// Security: Zero-padding is safe as Poseidon2 uses fixed-size input
fn hash_2(a: Field, b: Field) -> Field {
    let input: [Field; 4] = [a, b, 0, 0];
    let permuted = poseidon2_permutation(input, POSEIDON_STATE_SIZE);
    permuted[0]
}

// Check if a 32-byte array is strictly less than the BN254 field modulus
// Uses lexicographic comparison (big-endian byte order)
// Security: This provides defense-in-depth against field overflow attacks
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
            // If equal, continue to next byte
        }
    }
    // If all bytes equal (bytes == modulus), return false (not strictly less than)
    result
}

// Convert 32-byte array to field element (big-endian interpretation)
// NOTE: Ed25519 pubkeys are always < 2^252 (curve order), well within BN254 field modulus (~2^254).
// Task IDs should be validated by the on-chain program to be within safe bounds.
// Security: Full modulus comparison ensures input is within valid field range
fn bytes_to_field(bytes: [u8; 32]) -> Field {
    // Full modulus comparison - input must be strictly less than BN254 scalar field modulus
    assert(bytes_less_than_modulus(bytes), "Input exceeds BN254 field modulus");

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

// Wrong agent (different from TEST_AGENT_PUBKEY but within valid field range)
// Using 0x20 as first byte to satisfy field modulus check (must be <= 0x30)
global WRONG_AGENT: [u8; 32] = [
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
    0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
    0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f
];

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

// Test that obviously oversized field inputs are rejected
#[test(should_fail)]
fn test_field_overflow_rejected() {
    // Input with first byte 0x40 clearly exceeds BN254 field modulus (> 0x30)
    let oversized_input: [u8; 32] = [0x40; 32];

    // This should fail due to the field overflow check in bytes_to_field
    let _ = bytes_to_field(oversized_input);
}

// Test that values with first byte 0x30 but exceeding modulus are rejected (issue #539)
// This catches the edge case where heuristic-only checking would fail
#[test(should_fail)]
fn test_field_overflow_edge_case_rejected() {
    // Value: 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000002
    // This is exactly 1 greater than BN254 modulus - first byte is 0x30 (passes heuristic)
    // but the full value exceeds the modulus
    let edge_case_input: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
        0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
        0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x02  // Last byte is 0x02, exceeds modulus (0x01)
    ];

    // This should fail - old heuristic check would have passed this!
    let _ = bytes_to_field(edge_case_input);
}

// Test that values exactly equal to modulus are rejected
#[test(should_fail)]
fn test_field_modulus_exact_rejected() {
    // Exactly the BN254 modulus - should be rejected (must be strictly less than)
    let modulus_input: [u8; 32] = BN254_MODULUS;

    let _ = bytes_to_field(modulus_input);
}

// Test that values just below modulus are accepted
#[test]
fn test_field_just_below_modulus_accepted() {
    // Value: 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000
    // This is exactly 1 less than BN254 modulus - should be accepted
    let valid_input: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
        0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
        0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x00  // Last byte is 0x00, just under modulus
    ];

    // This should succeed
    let _ = bytes_to_field(valid_input);
}

// Test the bytes_less_than_modulus helper function
#[test]
fn test_bytes_less_than_modulus() {
    // Zero should be less than modulus
    let zero: [u8; 32] = [0; 32];
    assert(bytes_less_than_modulus(zero) == true);

    // Small value should be less than modulus
    let small: [u8; 32] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    assert(bytes_less_than_modulus(small) == true);

    // Value with first byte 0x31 should NOT be less than modulus
    let too_large: [u8; 32] = [0x31, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert(bytes_less_than_modulus(too_large) == false);

    // Modulus itself should NOT be less than modulus
    assert(bytes_less_than_modulus(BN254_MODULUS) == false);
}
