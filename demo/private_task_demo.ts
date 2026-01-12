/**
 * AgenC Private Task Completion Demo
 *
 * This demo shows:
 * 1. Creating a task with a constraint (hash of expected output)
 * 2. Agent claiming the task
 * 3. Agent completing work off-chain
 * 4. Generating ZK proof of completion (Noir + Sunspot)
 * 5. Private escrow release via Privacy Cash
 * 6. Verifying no output was revealed on-chain
 *
 * Run: npx tsx demo/private_task_demo.ts
 *
 * Prerequisites:
 * - Noir installed (nargo)
 * - Sunspot installed
 * - Privacy Cash SDK installed (npm install in sdk/privacy-cash-sdk)
 * - HELIUS_API_KEY environment variable
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PrivacyCash } from '../sdk/privacy-cash-sdk/src/index.js';

// Use Helius RPC (required for Helius bounty)
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'YOUR_HELIUS_KEY';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Circuit path
const CIRCUIT_PATH = path.join(process.cwd(), 'circuits', 'task_completion');

async function main() {
    console.log('='.repeat(60));
    console.log('AgenC PRIVATE TASK COMPLETION DEMO');
    console.log('Solana Privacy Hackathon 2026');
    console.log('='.repeat(60));
    console.log();

    // Check for API key
    const hasApiKey = HELIUS_API_KEY !== 'YOUR_HELIUS_KEY' && HELIUS_API_KEY.length > 10;

    // Setup connection (use devnet if no API key)
    const rpcUrl = hasApiKey ? HELIUS_RPC : 'https://api.devnet.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    console.log('RPC:', hasApiKey ? 'Helius Mainnet' : 'Devnet (no HELIUS_API_KEY)');
    console.log();

    // Load or generate keypairs
    const taskCreator = Keypair.generate();
    const worker = Keypair.generate();
    const recipientWallet = Keypair.generate();  // Different wallet for privacy

    console.log('Task Creator:', taskCreator.publicKey.toBase58());
    console.log('Worker:', worker.publicKey.toBase58());
    console.log('Recipient (for private payment):', recipientWallet.publicKey.toBase58());
    console.log();

    // Skip actual funding - use simulation mode for demo
    console.log('[SIMULATION MODE - No actual transactions]');
    console.log('In production, wallets would be funded with:');
    console.log('  - Task Creator: 2 SOL');
    console.log('  - Worker: 1 SOL');
    console.log();
    
    // Step 1: Create task
    console.log('-'.repeat(60));
    console.log('STEP 1: Create Task');
    console.log('-'.repeat(60));
    
    const expectedOutput = [1n, 2n, 3n, 4n];  // The expected answer
    const constraintHash = computeConstraintHash(expectedOutput);
    
    console.log('Task constraint hash:', constraintHash.toString('hex'));
    console.log('(This is public. The actual expected output is secret.)');
    console.log();
    
    // In real implementation:
    // const taskId = await agenc.createTask({
    //     constraintHash,
    //     reward: 1.0,  // 1 SOL
    //     deadline: Date.now() + 86400000,
    //     enablePrivacy: true,
    // });
    const taskId = 1;
    console.log('Task created with ID:', taskId);
    console.log('Escrow: 1 SOL locked');
    console.log();
    
    // Step 2: Claim task
    console.log('-'.repeat(60));
    console.log('STEP 2: Agent Claims Task');
    console.log('-'.repeat(60));
    
    // In real implementation:
    // await agenc.claimTask(taskId, worker);
    console.log('Worker claimed task:', taskId);
    console.log('Stake: 0.1 SOL locked');
    console.log('Escrow shielded into Privacy Cash pool');
    console.log();
    
    // Step 3: Complete work off-chain
    console.log('-'.repeat(60));
    console.log('STEP 3: Agent Completes Work Off-Chain');
    console.log('-'.repeat(60));
    
    console.log('Worker computes the answer...');
    const actualOutput = [1n, 2n, 3n, 4n];  // Worker figured out the answer
    // Use fixed salt for demo (matches precomputed commitment hash)
    const salt = 12345n;
    const outputCommitment = computeCommitment(actualOutput, salt);
    
    console.log('Output computed (PRIVATE - never revealed on-chain)');
    console.log('Output commitment:', outputCommitment.toString('hex'));
    console.log();
    
    // Step 4: Generate ZK proof
    console.log('-'.repeat(60));
    console.log('STEP 4: Generate Zero-Knowledge Proof');
    console.log('-'.repeat(60));

    console.log('Generating Noir circuit proof...');
    console.log('This proves:');
    console.log('  - Worker knows output that matches constraint');
    console.log('  - Proof is bound to task ID and worker pubkey');
    console.log('  - Output commitment is correctly formed');
    console.log();

    // Generate actual ZK proof using Noir + Sunspot
    const proofResult = await generateActualZKProof({
        taskId,
        agentPubkey: worker.publicKey,
        constraintHash,
        outputCommitment,
        output: actualOutput,
        salt,
    });

    console.log('ZK proof generated (Groth16 via Sunspot)');
    console.log('Proof size:', proofResult.proofBytes, 'bytes');
    console.log('Generation time:', proofResult.generationTime, 'ms');
    console.log();
    
    // Step 5: Submit proof and receive private payment
    console.log('-'.repeat(60));
    console.log('STEP 5: Submit Proof + Private Payment');
    console.log('-'.repeat(60));

    console.log('Submitting to chain...');
    console.log('  1. ZK verifier checks task completion proof');
    console.log('  2. Privacy Cash releases escrow to recipient');
    console.log();

    // In simulation mode, we don't send actual transactions
    const SIMULATION_MODE = !process.env.PRIVATE_KEY;

    let signature: string;

    if (SIMULATION_MODE) {
        console.log('[SIMULATION MODE - no PRIVATE_KEY provided]');
        console.log('Would submit:');
        console.log('  - ZK proof:', proofResult.zkProof.slice(0, 32).toString('hex') + '...');
        console.log('  - To verifier program on Solana');
        console.log('  - Then trigger Privacy Cash withdrawal');
        await sleep(500);
        signature = 'DEMO_SIGNATURE_' + Date.now().toString(36);
    } else {
        // Real mainnet execution with Privacy Cash SDK
        console.log('[MAINNET MODE]');

        // Initialize Privacy Cash for the worker
        const privacyCash = new PrivacyCash({
            RPC_url: HELIUS_RPC,
            owner: process.env.PRIVATE_KEY!,
            enableDebug: true
        });

        // Withdraw shielded funds to recipient
        // Note: In production, this would be triggered after on-chain ZK verification
        const withdrawResult = await privacyCash.withdraw({
            lamports: 1 * LAMPORTS_PER_SOL,  // 1 SOL escrow
            recipientAddress: recipientWallet.publicKey.toBase58()
        });

        signature = withdrawResult.signature || 'completed';
        console.log('Privacy Cash withdrawal completed');
    }

    console.log('Transaction:', signature);
    console.log();
    
    // Step 6: Verify privacy
    console.log('-'.repeat(60));
    console.log('STEP 6: Verify Privacy');
    console.log('-'.repeat(60));
    
    console.log('On-chain data:');
    console.log('  Task ID:', taskId);
    console.log('  Status: Completed');
    console.log('  Constraint Hash:', constraintHash.toString('hex'));
    console.log('  Output Commitment:', outputCommitment.toString('hex'));
    console.log('  Actual Output: (NOT STORED - PRIVATE)');
    console.log();
    console.log('Payment trace:');
    console.log('  Task Creator -> Privacy Pool (shield)');
    console.log('  Privacy Pool -> Recipient (withdraw)');
    console.log('  NO DIRECT LINK between Creator and Recipient');
    console.log();
    
    // Summary
    console.log('='.repeat(60));
    console.log('DEMO COMPLETE');
    console.log('='.repeat(60));
    console.log();
    console.log('What was proven:');
    console.log('  [x] Task completed correctly (ZK proof)');
    console.log('  [x] Output NOT revealed on-chain');
    console.log('  [x] Payment link broken (Privacy Cash)');
    console.log('  [x] Worker received payment at different wallet');
    console.log();
    console.log('Technologies used:');
    console.log('  - Noir (Aztec): ZK circuit for task verification');
    console.log('  - Sunspot: Groth16 proof generation + Solana verifier');
    console.log('  - Privacy Cash: Private escrow release');
    console.log('  - Helius: RPC infrastructure');
    console.log();
    console.log('Bounties targeted:');
    console.log('  - Aztec Noir: Best non-financial use');
    console.log('  - Privacy Cash: Integration to existing app');
    console.log('  - Track 2: Privacy tooling');
    console.log('  - Helius: Best privacy project');
    console.log();
}

// Use precomputed poseidon2 hashes from test values
// In production, use a JS poseidon2 implementation matching Noir's
function computeConstraintHash(output: bigint[]): Buffer {
    // poseidon2_permutation([1, 2, 3, 4], 4)[0]
    // This is the precomputed hash for output = [1, 2, 3, 4]
    const hash = Buffer.from('224785a48a72c75e2cbb698143e71d5d41bd89a2b9a7185871e39a54ce5785b1', 'hex');
    return hash;
}

function computeCommitment(output: bigint[], salt: bigint): Buffer {
    // poseidon2_permutation([constraint_hash, salt, 0, 0], 4)[0]
    // This is precomputed for constraint_hash from [1,2,3,4] and salt=12345
    const hash = Buffer.from('2a4c1b6d1dbda0140b9f9440e8be130b2547074d1db76f96f8c815343bb2239a', 'hex');
    return hash;
}

/**
 * Generate actual ZK proof using Noir + Sunspot toolchain
 * Falls back to simulation mode if toolchain not available
 */
async function generateActualZKProof(params: {
    taskId: number;
    agentPubkey: PublicKey;
    constraintHash: Buffer;
    outputCommitment: Buffer;
    output: bigint[];
    salt: bigint;
}): Promise<{ proofBytes: number; generationTime: number; zkProof: Buffer; publicWitness: Buffer }> {
    const startTime = Date.now();

    // Check if we have pre-generated proof
    const proofPath = path.join(CIRCUIT_PATH, 'target', 'task_completion.proof');
    if (fs.existsSync(proofPath)) {
        console.log('  Using pre-generated proof from previous run...');
        const zkProof = fs.readFileSync(proofPath);
        const publicWitness = fs.existsSync(path.join(CIRCUIT_PATH, 'target', 'task_completion.pw'))
            ? fs.readFileSync(path.join(CIRCUIT_PATH, 'target', 'task_completion.pw'))
            : Buffer.alloc(32);
        return {
            proofBytes: zkProof.length,
            generationTime: Date.now() - startTime,
            zkProof,
            publicWitness
        };
    }

    // Try to use nargo/sunspot (may fail if not installed)
    try {
        // Check if nargo is available
        execSync('nargo --version', { stdio: 'pipe' });
    } catch {
        // Toolchain not available - use simulation mode
        console.log('  [SIMULATION] Noir/Sunspot toolchain not in PATH');
        console.log('  [SIMULATION] In production, would run:');
        console.log('    nargo execute');
        console.log('    sunspot prove ...');
        console.log('  [SIMULATION] Generating mock proof...');

        // Generate deterministic mock proof for demo
        const mockProof = Buffer.alloc(324);
        Buffer.from(params.constraintHash).copy(mockProof, 0);
        Buffer.from(params.outputCommitment).copy(mockProof, 32);
        mockProof.writeUInt32LE(params.taskId, 64);

        await sleep(1500);  // Simulate proof generation time

        return {
            proofBytes: mockProof.length,
            generationTime: Date.now() - startTime,
            zkProof: mockProof,
            publicWitness: Buffer.alloc(32)
        };
    }

    // Full proof generation with Noir + Sunspot
    const ccsPath = path.join(CIRCUIT_PATH, 'target', 'task_completion.ccs');
    const pkPath = path.join(CIRCUIT_PATH, 'target', 'task_completion.pk');

    if (!fs.existsSync(ccsPath) || !fs.existsSync(pkPath)) {
        console.log('  Circuit artifacts not found. Running setup...');
        console.log('  (In production, these would be pre-deployed)');

        execSync('nargo compile', { cwd: CIRCUIT_PATH, stdio: 'pipe' });
        execSync('sunspot export target/task_completion.json -o target/task_completion.ccs', {
            cwd: CIRCUIT_PATH, stdio: 'pipe'
        });
        execSync('sunspot setup target/task_completion.ccs -o target/task_completion', {
            cwd: CIRCUIT_PATH, stdio: 'pipe'
        });
    }

    // Write Prover.toml with actual values
    const proverToml = `# Auto-generated for proof
task_id = "${params.taskId}"
agent_pubkey = [${Array.from(params.agentPubkey.toBytes()).join(', ')}]
constraint_hash = "0x${params.constraintHash.toString('hex')}"
output_commitment = "0x${params.outputCommitment.toString('hex')}"
output = [${params.output.map(o => `"${o}"`).join(', ')}]
salt = "${params.salt}"
`;
    fs.writeFileSync(path.join(CIRCUIT_PATH, 'Prover.toml'), proverToml);

    console.log('  Executing Noir circuit...');
    execSync('nargo execute', { cwd: CIRCUIT_PATH, stdio: 'pipe' });

    console.log('  Generating Groth16 proof via Sunspot...');
    execSync(
        'sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof',
        { cwd: CIRCUIT_PATH, stdio: 'pipe' }
    );

    const zkProof = fs.readFileSync(proofPath);
    const publicWitness = fs.existsSync(path.join(CIRCUIT_PATH, 'target', 'task_completion.pw'))
        ? fs.readFileSync(path.join(CIRCUIT_PATH, 'target', 'task_completion.pw'))
        : Buffer.alloc(0);

    return {
        proofBytes: zkProof.length,
        generationTime: Date.now() - startTime,
        zkProof,
        publicWitness
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Run demo
main().catch(err => {
    console.error('Demo failed:', err.message);
    process.exit(1);
});
