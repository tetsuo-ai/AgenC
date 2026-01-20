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

// Convert 32-byte array to field element (big-endian interpretation)
// NOTE: Ed25519 pubkeys are always < 2^252 (curve order), well within BN254 field modulus (~2^254).
// Task IDs should be validated by the on-chain program to be within safe bounds.
// Security: We validate the high byte isn't suspiciously large to catch obviously oversized values.
fn bytes_to_field(bytes: [u8; 32]) -> Field {
    // BN254 scalar field modulus starts with 0x30644e72...
    // Any input with first byte > 0x30 definitely exceeds the modulus
    // This is a heuristic check - full modulus comparison would be expensive in-circuit
    assert(bytes[0] <= 0x30, "Input may exceed field modulus - first byte too large");

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

// Test that oversized field inputs are rejected (security fix MAIN-001)
#[test(should_fail)]
fn test_field_overflow_rejected() {
    // Input with first byte 0x40 exceeds BN254 field modulus heuristic check (> 0x30)
    let oversized_input: [u8; 32] = [0x40; 32];

    // This should fail due to the field overflow check in bytes_to_field
    let _ = bytes_to_field(oversized_input);
}
