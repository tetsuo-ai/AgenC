#!/usr/bin/env node
/**
 * Generate valid test input for task_completion circuit
 *
 * Computes Poseidon hashes using circomlibjs (same implementation as circomlib)
 */

const { buildPoseidon } = require('circomlibjs');

async function main() {
    const poseidon = await buildPoseidon();
    const F = poseidon.F; // Field arithmetic

    // Test values matching Noir test fixtures
    const task_id = [
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 42
    ];

    const agent_pubkey = [
        1, 2, 3, 4, 5, 6, 7, 8,
        9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24,
        25, 26, 27, 28, 29, 30, 31, 32
    ];

    const output_values = [1n, 2n, 3n, 4n];
    const salt = 12345n;

    // Convert bytes to field element (big-endian)
    function bytesToField(bytes) {
        let result = 0n;
        for (const b of bytes) {
            result = result * 256n + BigInt(b);
        }
        return result;
    }

    // Compute hashes
    // constraint_hash = Poseidon(output[0], output[1], output[2], output[3])
    const constraint_hash_raw = poseidon(output_values);
    const constraint_hash = F.toObject(constraint_hash_raw);
    console.error('constraint_hash:', constraint_hash.toString());

    // output_commitment = Poseidon(constraint_hash, salt)
    const commitment_raw = poseidon([constraint_hash, salt]);
    const output_commitment = F.toObject(commitment_raw);
    console.error('output_commitment:', output_commitment.toString());

    // Compute binding
    const task_field = bytesToField(task_id);
    const agent_field = bytesToField(agent_pubkey);
    console.error('task_field:', task_field.toString());
    console.error('agent_field:', agent_field.toString());

    // binding = Poseidon(task_field, agent_field)
    const binding_raw = poseidon([task_field, agent_field]);
    const binding = F.toObject(binding_raw);
    console.error('binding:', binding.toString());

    // full_binding = Poseidon(binding, output_commitment)
    const full_binding_raw = poseidon([binding, output_commitment]);
    const expected_binding = F.toObject(full_binding_raw);
    console.error('expected_binding:', expected_binding.toString());

    // Generate input.json
    const input = {
        task_id: task_id,
        agent_pubkey: agent_pubkey,
        constraint_hash: constraint_hash.toString(),
        output_commitment: output_commitment.toString(),
        expected_binding: expected_binding.toString(),
        output_values: output_values.map(v => v.toString()),
        salt: salt.toString()
    };

    console.log(JSON.stringify(input, null, 2));
}

main().catch(console.error);
