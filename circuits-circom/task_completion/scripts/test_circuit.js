#!/usr/bin/env node
/**
 * Test suite for task_completion circuit
 *
 * Tests:
 * 1. Valid proof succeeds
 * 2. Wrong output fails (constraint_hash mismatch)
 * 3. Wrong salt fails (commitment mismatch)
 * 4. Wrong task_id fails (binding mismatch)
 * 5. Wrong agent fails (binding mismatch)
 */

const { buildPoseidon } = require('circomlibjs');
const snarkjs = require('snarkjs');
const fs = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, '../target/circuit_js/circuit.wasm');

async function main() {
    const poseidon = await buildPoseidon();
    const F = poseidon.F;

    // Check wasm exists
    if (!fs.existsSync(WASM_PATH)) {
        console.error('Circuit not compiled. Run: npm run compile');
        process.exit(1);
    }

    // Helper to compute valid input
    function computeValidInput(taskId, agentPubkey, outputValues, salt) {
        const constraint_hash = F.toObject(poseidon(outputValues));
        const output_commitment = F.toObject(poseidon([...outputValues, salt]));

        function bytesToField(bytes) {
            let result = 0n;
            for (const b of bytes) {
                result = result * 256n + BigInt(b);
            }
            return result;
        }

        const task_field = bytesToField(taskId);
        const agent_field = bytesToField(agentPubkey);
        const binding = F.toObject(poseidon([task_field, agent_field]));
        const expected_binding = F.toObject(poseidon([binding, output_commitment]));

        return {
            task_id: taskId,
            agent_pubkey: agentPubkey,
            constraint_hash: constraint_hash.toString(),
            output_commitment: output_commitment.toString(),
            expected_binding: expected_binding.toString(),
            output_values: outputValues.map(v => v.toString()),
            salt: salt.toString()
        };
    }

    // Test fixtures
    const TEST_TASK_ID = new Array(31).fill(0).concat([42]);
    const TEST_AGENT = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32];
    const TEST_OUTPUT = [1n, 2n, 3n, 4n];
    const TEST_SALT = 12345n;

    let passed = 0;
    let failed = 0;

    async function testWitness(name, input, shouldPass) {
        try {
            await snarkjs.wtns.calculate(input, WASM_PATH, { type: 'mem' });
            if (shouldPass) {
                console.log(`✓ ${name}`);
                passed++;
            } else {
                console.log(`✗ ${name} - Should have failed but passed`);
                failed++;
            }
        } catch (e) {
            if (!shouldPass) {
                console.log(`✓ ${name} (correctly rejected)`);
                passed++;
            } else {
                console.log(`✗ ${name} - ${e.message}`);
                failed++;
            }
        }
    }

    console.log('\nRunning task_completion circuit tests...\n');

    // Test 1: Valid proof
    const validInput = computeValidInput(TEST_TASK_ID, TEST_AGENT, TEST_OUTPUT, TEST_SALT);
    await testWitness('Valid proof succeeds', validInput, true);

    // Test 2: Wrong output (different output values, same public inputs)
    const wrongOutputInput = { ...validInput, output_values: ['5', '6', '7', '8'] };
    await testWitness('Wrong output fails', wrongOutputInput, false);

    // Test 3: Wrong salt
    const wrongSaltInput = { ...validInput, salt: '99999' };
    await testWitness('Wrong salt fails', wrongSaltInput, false);

    // Test 4: Wrong task_id (compute with different task, try with original binding)
    const wrongTaskInput = { ...validInput, task_id: new Array(31).fill(0).concat([99]) };
    await testWitness('Wrong task_id fails', wrongTaskInput, false);

    // Test 5: Wrong agent
    const wrongAgentInput = { ...validInput, agent_pubkey: [32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1] };
    await testWitness('Wrong agent fails', wrongAgentInput, false);

    // Test 6: Invalid byte (> 255) should fail
    const invalidByteInput = { ...validInput, task_id: [300].concat(new Array(31).fill(0)) };
    await testWitness('Invalid byte (>255) fails', invalidByteInput, false);

    // Test 7: Field overflow (first byte > 0x30)
    const overflowInput = { ...validInput, task_id: [0x40].concat(new Array(31).fill(0)) };
    await testWitness('Field overflow (first byte > 0x30) fails', overflowInput, false);

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
