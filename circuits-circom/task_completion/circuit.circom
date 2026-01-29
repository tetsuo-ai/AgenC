pragma circom ^2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// AgenC Private Task Completion Circuit (Circom version)
// Proves task completion without revealing output
//
// Uses circomlib Poseidon for hashing (groth16-solana compatible)
//
// Public Inputs (6 total):
//   - task_id: 32-byte task identifier as field element
//   - agent_pubkey: 32-byte agent public key as field element
//   - constraint_hash: hash of expected output
//   - output_commitment: commitment to the output
//   - expected_binding: anti-replay binding value
//   - nullifier: prevents proof/knowledge reuse (derived from constraint_hash + agent_secret)
//
// Private Inputs:
//   - output[4]: actual task output (4 field elements)
//   - salt: random salt for commitment
//   - agent_secret: secret known only to the agent for nullifier derivation

// Convert 32 bytes to a single field element (big-endian)
// BN254 scalar field is ~254 bits, so 32 bytes fits safely when first byte <= 0x30
template BytesToField(n) {
    signal input bytes[n];
    signal output out;

    signal acc[n + 1];
    acc[0] <== 0;

    for (var i = 0; i < n; i++) {
        acc[i + 1] <== acc[i] * 256 + bytes[i];
    }

    out <== acc[n];
}

// Validate that a byte is in range [0, 255]
template ByteRangeCheck() {
    signal input in;

    // Decompose to 8 bits to prove it's a valid byte
    component bits = Num2Bits(8);
    bits.in <== in;
}

// Validate first byte <= 0x30 to prevent field overflow
// BN254 scalar field modulus starts with 0x30644e72...
template FieldOverflowCheck() {
    signal input first_byte;

    // first_byte must be <= 48 (0x30)
    component lt = LessEqThan(8);
    lt.in[0] <== first_byte;
    lt.in[1] <== 48; // 0x30
    lt.out === 1;
}

// Main circuit template
template TaskCompletion() {
    // Public inputs
    signal input task_id[32];           // Task ID as 32 bytes
    signal input agent_pubkey[32];      // Agent public key as 32 bytes
    signal input constraint_hash;        // Hash of expected output
    signal input output_commitment;      // Commitment to output
    signal input expected_binding;       // Anti-replay binding

    // Public output (nullifier to prevent proof/knowledge reuse)
    signal output nullifier;

    // Private inputs
    signal input output_values[4];       // Task output (4 field elements)
    signal input salt;                   // Random salt
    signal input agent_secret;           // Agent's secret for nullifier derivation

    // ========================================
    // Byte range validation for task_id and agent_pubkey
    // ========================================
    component task_id_range[32];
    component agent_pubkey_range[32];

    for (var i = 0; i < 32; i++) {
        task_id_range[i] = ByteRangeCheck();
        task_id_range[i].in <== task_id[i];

        agent_pubkey_range[i] = ByteRangeCheck();
        agent_pubkey_range[i].in <== agent_pubkey[i];
    }

    // ========================================
    // Field overflow check (first byte <= 0x30)
    // ========================================
    component task_overflow = FieldOverflowCheck();
    task_overflow.first_byte <== task_id[0];

    component agent_overflow = FieldOverflowCheck();
    agent_overflow.first_byte <== agent_pubkey[0];

    // ========================================
    // Convert bytes to field elements
    // ========================================
    component task_to_field = BytesToField(32);
    for (var i = 0; i < 32; i++) {
        task_to_field.bytes[i] <== task_id[i];
    }
    signal task_field <== task_to_field.out;

    component agent_to_field = BytesToField(32);
    for (var i = 0; i < 32; i++) {
        agent_to_field.bytes[i] <== agent_pubkey[i];
    }
    signal agent_field <== agent_to_field.out;

    // ========================================
    // 1. Verify output satisfies the task constraint
    //    constraint_hash = Poseidon(output[0], output[1], output[2], output[3])
    // ========================================
    component hash_output = Poseidon(4);
    hash_output.inputs[0] <== output_values[0];
    hash_output.inputs[1] <== output_values[1];
    hash_output.inputs[2] <== output_values[2];
    hash_output.inputs[3] <== output_values[3];

    signal computed_constraint <== hash_output.out;
    computed_constraint === constraint_hash;

    // ========================================
    // 2. Verify commitment is correctly formed
    //    output_commitment = Poseidon(output[0], output[1], output[2], output[3], salt)
    //    FIX #532: Bind directly to raw output values, not constraint_hash
    //    This prevents theoretical collision attacks on the intermediate hash
    // ========================================
    component hash_commitment = Poseidon(5);
    hash_commitment.inputs[0] <== output_values[0];
    hash_commitment.inputs[1] <== output_values[1];
    hash_commitment.inputs[2] <== output_values[2];
    hash_commitment.inputs[3] <== output_values[3];
    hash_commitment.inputs[4] <== salt;

    signal computed_commitment <== hash_commitment.out;
    computed_commitment === output_commitment;

    // ========================================
    // 3. Bind proof to task and agent (anti-replay)
    //    binding = Poseidon(task_field, agent_field)
    //    full_binding = Poseidon(binding, output_commitment)
    // ========================================
    component hash_binding = Poseidon(2);
    hash_binding.inputs[0] <== task_field;
    hash_binding.inputs[1] <== agent_field;

    signal binding <== hash_binding.out;

    component hash_full_binding = Poseidon(2);
    hash_full_binding.inputs[0] <== binding;
    hash_full_binding.inputs[1] <== computed_commitment;

    signal full_binding <== hash_full_binding.out;

    // CRITICAL: Assert binding matches expected (prevents replay attacks)
    full_binding === expected_binding;

    // ========================================
    // 4. Compute nullifier to prevent proof/knowledge reuse
    //    nullifier = Poseidon(constraint_hash, agent_secret)
    //
    //    This ensures the same (constraint, agent_secret) pair can only
    //    be used once. The on-chain program stores spent nullifiers to
    //    prevent replay of the same proof/knowledge across different tasks.
    // ========================================
    component hash_nullifier = Poseidon(2);
    hash_nullifier.inputs[0] <== computed_constraint;
    hash_nullifier.inputs[1] <== agent_secret;

    nullifier <== hash_nullifier.out;
}

component main {public [task_id, agent_pubkey, constraint_hash, output_commitment, expected_binding]} = TaskCompletion();
