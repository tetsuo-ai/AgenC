#!/usr/bin/env node
/**
 * Parse snarkjs verification key JSON to Rust format for groth16-solana
 *
 * Usage: node parse_vk_to_rust.js verification_key.json > verifying_key.rs
 *
 * Output format compatible with groth16-solana Groth16Verifyingkey
 *
 * IMPORTANT: Copy the generated output to:
 *   programs/agenc-coordination/src/verifying_key.rs
 */

const fs = require('fs');

if (process.argv.length < 3) {
    console.error('Usage: node parse_vk_to_rust.js <verification_key.json>');
    process.exit(1);
}

const vkPath = process.argv[2];
const vk = JSON.parse(fs.readFileSync(vkPath, 'utf8'));

// BN254 base field modulus (for y-coordinate negation if needed)
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Convert a G1 point (affine) to bytes
// Format: [x (32 bytes BE), y (32 bytes BE)]
function g1ToBytes(point) {
    const x = BigInt(point[0]);
    const y = BigInt(point[1]);
    return [
        ...bigintToBytes32BE(x),
        ...bigintToBytes32BE(y)
    ];
}

// Convert a G2 point (affine) to bytes
// Format: [x_c1 (32 bytes), x_c0 (32 bytes), y_c1 (32 bytes), y_c0 (32 bytes)]
// Note: groth16-solana expects [c1, c0] order for Fp2 elements
function g2ToBytes(point) {
    const x_c0 = BigInt(point[0][0]);
    const x_c1 = BigInt(point[0][1]);
    const y_c0 = BigInt(point[1][0]);
    const y_c1 = BigInt(point[1][1]);
    return [
        ...bigintToBytes32BE(x_c1),
        ...bigintToBytes32BE(x_c0),
        ...bigintToBytes32BE(y_c1),
        ...bigintToBytes32BE(y_c0)
    ];
}

// Convert bigint to 32 bytes big-endian
function bigintToBytes32BE(n) {
    const bytes = [];
    for (let i = 31; i >= 0; i--) {
        bytes[31 - i] = Number((n >> BigInt(i * 8)) & 0xFFn);
    }
    return bytes;
}

// Format bytes as Rust array
function formatRustArray(bytes, name, perLine = 16) {
    let result = `pub const ${name}: [u8; ${bytes.length}] = [\n`;
    for (let i = 0; i < bytes.length; i += perLine) {
        const slice = bytes.slice(i, i + perLine);
        result += '    ' + slice.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ');
        if (i + perLine < bytes.length) {
            result += ',\n';
        } else {
            result += '\n';
        }
    }
    result += '];\n';
    return result;
}

// Format IC points as array of 64-byte arrays
function formatRustIcArray(icPoints) {
    const numPoints = icPoints.length;
    let result = `pub const VK_IC: [[u8; 64]; ${numPoints}] = [\n`;

    for (let i = 0; i < numPoints; i++) {
        const bytes = g1ToBytes(icPoints[i]);
        result += '    [\n';
        for (let j = 0; j < 64; j += 16) {
            const slice = bytes.slice(j, j + 16);
            result += '        ' + slice.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ');
            if (j + 16 < 64) {
                result += ',\n';
            } else {
                result += '\n';
            }
        }
        result += '    ]';
        if (i < numPoints - 1) {
            result += ',\n';
        } else {
            result += '\n';
        }
    }

    result += '];\n';
    return result;
}

// Parse verification key
const alpha = g1ToBytes(vk.vk_alpha_1);
const beta = g2ToBytes(vk.vk_beta_2);
const gamma = g2ToBytes(vk.vk_gamma_2);
const delta = g2ToBytes(vk.vk_delta_2);

// ============================================================================
// Security validation (issues #356, #358)
// ============================================================================

// Check if gamma == delta (indicates single-party trusted setup)
const gammaHex = gamma.map(b => b.toString(16).padStart(2, '0')).join('');
const deltaHex = delta.map(b => b.toString(16).padStart(2, '0')).join('');

if (gammaHex === deltaHex) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════════╗');
    console.error('║  SECURITY WARNING: gamma_g2 == delta_g2 (issues #356, #358)     ║');
    console.error('║                                                                  ║');
    console.error('║  This verifying key is from a SINGLE-PARTY trusted setup.        ║');
    console.error('║  Proofs generated with this key are FORGEABLE.                   ║');
    console.error('║                                                                  ║');
    console.error('║  This key is ONLY safe for devnet/localnet testing.              ║');
    console.error('║  Run an MPC ceremony (see CEREMONY.md) before mainnet deploy.    ║');
    console.error('╚══════════════════════════════════════════════════════════════════╝');
    console.error('');

    // If --require-mpc flag is passed, fail hard
    if (process.argv.includes('--require-mpc')) {
        console.error('ERROR: --require-mpc flag set but key is from single-party setup. Aborting.');
        process.exit(1);
    }
}

// Output Rust code
console.log('//! Groth16 verifying key for task_completion circuit.');
console.log('//!');
console.log('//! Auto-generated from: ' + vkPath);
console.log('//! Number of public inputs: ' + (vk.IC.length - 1));
console.log('//!');
console.log('//! To update, run:');
console.log('//!   cd circuits-circom/task_completion');
console.log('//!   node scripts/parse_vk_to_rust.js target/verification_key.json');
console.log('//!');
console.log('//! Then copy this output to programs/agenc-coordination/src/verifying_key.rs');
console.log('');
console.log('use groth16_solana::groth16::Groth16Verifyingkey;');
console.log('');
console.log('/// Number of public inputs for the task_completion circuit.');
console.log(`pub const PUBLIC_INPUTS_COUNT: usize = ${vk.IC.length - 1};`);
console.log('');
console.log('/// G1 point: vk.alpha (64 bytes: x || y)');
console.log(formatRustArray(alpha, 'VK_ALPHA_G1'));
console.log('/// G2 point: vk.beta (128 bytes: x_c1 || x_c0 || y_c1 || y_c0)');
console.log(formatRustArray(beta, 'VK_BETA_G2'));
console.log('/// G2 point: vk.gamma (128 bytes)');
console.log(formatRustArray(gamma, 'VK_GAMMA_G2'));
console.log('/// G2 point: vk.delta (128 bytes)');
console.log(formatRustArray(delta, 'VK_DELTA_G2'));
console.log(`/// Number of IC points (1 base + ${vk.IC.length - 1} for public inputs)`);
console.log(`pub const VK_IC_LENGTH: usize = ${vk.IC.length};`);
console.log('');
console.log(`/// IC points: ${vk.IC.length} G1 points (64 bytes each)`);
console.log(formatRustIcArray(vk.IC));
console.log('');
console.log('/// Get the verifying key as a Groth16Verifyingkey struct.');
console.log('pub fn get_verifying_key() -> Groth16Verifyingkey<\'static> {');
console.log('    Groth16Verifyingkey {');
console.log('        nr_pubinputs: PUBLIC_INPUTS_COUNT,');
console.log('        vk_alpha_g1: VK_ALPHA_G1,');
console.log('        vk_beta_g2: VK_BETA_G2,');
console.log('        vk_gamme_g2: VK_GAMMA_G2, // Note: typo in groth16-solana crate');
console.log('        vk_delta_g2: VK_DELTA_G2,');
console.log('        vk_ic: &VK_IC,');
console.log('    }');
console.log('}');
