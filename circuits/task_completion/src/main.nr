// AgenC Private Task Completion Circuit
// Proves task completion without revealing output
//
// Uses poseidon2_permutation for hashing (Sunspot compatible)

use std::hash::poseidon2_permutation;

// Hash helper using poseidon2 permutation in sponge mode
fn hash_4(input: [Field; 4]) -> Field {
    let permuted = poseidon2_permutation(input, 4);
    permuted[0]
}

fn hash_2(a: Field, b: Field) -> Field {
    let input: [Field; 4] = [a, b, 0, 0];
    let permuted = poseidon2_permutation(input, 4);
    permuted[0]
}

fn main(
    // Public inputs
    task_id: pub Field,
    agent_pubkey: pub [u8; 32],
    constraint_hash: pub Field,
    output_commitment: pub Field,

    // Private inputs
    output: [Field; 4],
    salt: Field,
) {
    // 1. Verify output satisfies the task constraint
    let computed_constraint = hash_4(output);
    assert(computed_constraint == constraint_hash, "Output does not satisfy task constraint");

    // 2. Verify the commitment is correctly formed
    let computed_commitment = hash_2(computed_constraint, salt);
    assert(computed_commitment == output_commitment, "Commitment verification failed");

    // 3. Proof binding to task and agent
    // Note: task_id and agent_pubkey are PUBLIC inputs, which means they are
    // automatically bound to the proof by the ZK verification system. The verifier
    // will check that the proof was generated with the exact public input values
    // provided. This prevents proof replay attacks where an attacker tries to
    // reuse a proof generated for a different task or agent.
    //
    // The computation below demonstrates the binding relationship but does not
    // add additional security constraints since public inputs are inherently bound.
    let mut agent_field: Field = 0;
    for i in 0..32 {
        agent_field = agent_field * 256 + (agent_pubkey[i] as Field);
    }
    let binding = hash_2(task_id, agent_field);
    let _full_binding = hash_2(binding, output_commitment);
}

#[test]
fn test_valid_proof() {
    let output: [Field; 4] = [1, 2, 3, 4];
    let salt: Field = 12345;

    let constraint_hash = hash_4(output);
    let output_commitment = hash_2(constraint_hash, salt);

    println(f"constraint_hash = {constraint_hash}");
    println(f"output_commitment = {output_commitment}");

    let task_id: Field = 42;
    let agent_pubkey: [u8; 32] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20
    ];

    main(task_id, agent_pubkey, constraint_hash, output_commitment, output, salt);
}

#[test(should_fail)]
fn test_wrong_output_fails() {
    let output: [Field; 4] = [1, 2, 3, 4];
    let wrong_output: [Field; 4] = [5, 6, 7, 8];
    let salt: Field = 12345;

    let constraint_hash = hash_4(output);
    let wrong_constraint = hash_4(wrong_output);
    let output_commitment = hash_2(wrong_constraint, salt);

    let task_id: Field = 42;
    let agent_pubkey: [u8; 32] = [0; 32];

    main(task_id, agent_pubkey, constraint_hash, output_commitment, wrong_output, salt);
}

#[test(should_fail)]
fn test_wrong_salt_fails() {
    let output: [Field; 4] = [1, 2, 3, 4];
    let salt: Field = 12345;
    let wrong_salt: Field = 99999;

    let constraint_hash = hash_4(output);
    let output_commitment = hash_2(constraint_hash, salt);

    let task_id: Field = 42;
    let agent_pubkey: [u8; 32] = [0; 32];

    main(task_id, agent_pubkey, constraint_hash, output_commitment, output, wrong_salt);
}
