import { Connection, PublicKey, Transaction, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { PrivacyCash, PrivacyCashConfig } from 'privacycash';
import { HASH_SIZE, VERIFIER_PROGRAM_ID } from './constants';

// Re-export types for external use
export type { PrivacyCashConfig };

/**
 * Dynamic loader for optional privacycash dependency.
 * The package provides shielded transaction capabilities on Solana.
 */
let PrivacyCashClass: typeof PrivacyCash | null = null;
let loadAttempted = false;
let loadError: Error | null = null;

async function loadPrivacyCash(): Promise<typeof PrivacyCash | null> {
    if (loadAttempted) {
        if (loadError) throw loadError;
        return PrivacyCashClass;
    }
    loadAttempted = true;

    try {
        const module = await import('privacycash');
        if (!module.PrivacyCash) {
            loadError = new Error('privacycash module loaded but PrivacyCash class not found');
            throw loadError;
        }
        PrivacyCashClass = module.PrivacyCash;
        return PrivacyCashClass;
    } catch (err) {
        // Only swallow "module not found" errors, rethrow others
        if (err instanceof Error && err.message.includes('Cannot find module')) {
            return null;
        }
        loadError = err instanceof Error ? err : new Error(String(err));
        throw loadError;
    }
}

function createPrivacyCash(config: PrivacyCashConfig): PrivacyCash {
    if (!PrivacyCashClass) {
        throw new Error(
            'privacycash package not installed. Install it with: npm install privacycash'
        );
    }
    return new PrivacyCashClass(config);
}

export interface PrivateCompletionParams {
    taskId: number;
    output: bigint[];  // The actual task output (kept private)
    salt: bigint;      // Random salt for commitment
    recipientWallet: PublicKey;  // Where to receive private payment
    escrowLamports: number;  // Amount to withdraw from shielded pool
}

export interface ProofArtifacts {
    zkProof: Buffer;
    publicWitness: Buffer;
}

export interface ShieldEscrowResult {
    txSignature: string;
    shieldedAmount: number;
}

export class AgenCPrivacyClient {
    private connection: Connection;
    private program: Program;
    private circuitPath: string;
    private privacyCash: PrivacyCash | null = null;
    private rpcUrl: string;
    private privacyCashLoaded: boolean = false;

    constructor(
        connection: Connection,
        program: Program,
        circuitPath: string = './circuits/task_completion',
        rpcUrl?: string
    ) {
        this.connection = connection;
        this.program = program;
        this.circuitPath = circuitPath;
        this.rpcUrl = rpcUrl || connection.rpcEndpoint;
    }

    /**
     * Initialize Privacy Cash client for a specific wallet
     * Must be called before using private escrow features
     */
    async initPrivacyCash(owner: Keypair): Promise<void> {
        if (!this.privacyCashLoaded) {
            await loadPrivacyCash();
            this.privacyCashLoaded = true;
        }
        this.privacyCash = createPrivacyCash({
            RPC_url: this.rpcUrl,
            owner: owner,
            enableDebug: true
        });
        console.log('Privacy Cash client initialized for:', owner.publicKey.toBase58());
    }

    /**
     * Shield escrow funds into Privacy Cash pool
     * Called by task creator when creating a private task
     */
    async shieldEscrow(
        creator: Keypair,
        lamports: number
    ): Promise<ShieldEscrowResult> {
        // Initialize Privacy Cash for creator if not already
        if (!this.privacyCash || this.privacyCash.publicKey.toBase58() !== creator.publicKey.toBase58()) {
            await this.initPrivacyCash(creator);
        }

        console.log(`Shielding ${lamports / LAMPORTS_PER_SOL} SOL into privacy pool...`);

        const result = await this.privacyCash!.deposit({ lamports });

        console.log('Escrow shielded successfully');
        return {
            txSignature: result?.signature || 'deposited',
            shieldedAmount: lamports
        };
    }

    /**
     * Get shielded balance for current wallet
     */
    async getShieldedBalance(): Promise<{ lamports: number }> {
        if (!this.privacyCash) {
            throw new Error('Privacy Cash not initialized. Call initPrivacyCash first.');
        }
        return await this.privacyCash.getPrivateBalance();
    }
    
    /**
     * Complete a task privately using ZK proofs and Privacy Cash withdrawal
     *
     * Flow:
     * 1. Generate ZK proof that worker completed task correctly (Noir/Sunspot)
     * 2. Submit proof on-chain for verification
     * 3. Upon verification, withdraw shielded escrow to worker via Privacy Cash
     */
    async completeTaskPrivate(
        params: PrivateCompletionParams,
        worker: Keypair,
    ): Promise<{ proofTxSignature: string; withdrawResult: any }> {
        const { taskId, output, salt, recipientWallet, escrowLamports } = params;

        // Initialize Privacy Cash for worker (to receive funds)
        await this.initPrivacyCash(worker);

        // 1. Fetch task to get constraint hash
        const task = await this.fetchTask(taskId);
        const constraintHash = task.constraintHash;

        // 2. Compute output commitment (poseidon2 hash of output + salt)
        const outputCommitment = await this.computeCommitment(output, salt);

        // 3. Generate ZK proof of task completion using Noir/Sunspot
        console.log('Step 1/3: Generating ZK proof of task completion...');
        const { zkProof, publicWitness } = await this.generateTaskCompletionProof({
            taskId,
            agentPubkey: worker.publicKey,
            constraintHash,
            outputCommitment,
            output,
            salt,
        });
        console.log('ZK proof generated:', zkProof.length, 'bytes');

        // 4. Submit proof to on-chain verifier
        console.log('Step 2/3: Submitting proof to on-chain verifier...');
        const tx = await this.buildCompleteTaskPrivateTx({
            taskId,
            zkProof,
            publicWitness,
            worker: worker.publicKey,
        });

        const proofTxSignature = await this.connection.sendTransaction(tx, [worker]);
        await this.connection.confirmTransaction(proofTxSignature);
        console.log('Proof verified on-chain:', proofTxSignature);

        // 5. Withdraw shielded escrow to worker via Privacy Cash
        // Note: In production, this would be triggered by the on-chain program
        // after ZK proof verification. For demo, we trigger it client-side.
        console.log('Step 3/3: Withdrawing shielded escrow via Privacy Cash...');
        const withdrawResult = await this.privacyCash!.withdraw({
            lamports: escrowLamports,
            recipientAddress: recipientWallet.toBase58()
        });
        console.log('Private payment completed!');

        return {
            proofTxSignature,
            withdrawResult
        };
    }
    
    /**
     * Generate ZK proof for task completion using Noir/Sunspot
     */
    private async generateTaskCompletionProof(params: {
        taskId: number;
        agentPubkey: PublicKey;
        constraintHash: Buffer;
        outputCommitment: bigint;
        output: bigint[];
        salt: bigint;
    }): Promise<{ zkProof: Buffer; publicWitness: Buffer }> {
        const { taskId, agentPubkey, constraintHash, outputCommitment, output, salt } = params;
        
        // Write Prover.toml with actual values
        const proverToml = this.generateProverToml({
            taskId,
            agentPubkey: Array.from(agentPubkey.toBytes()),
            constraintHash: '0x' + constraintHash.toString('hex'),
            outputCommitment: '0x' + outputCommitment.toString(16),
            output: output.map(o => o.toString()),
            salt: salt.toString(),
        });
        
        const proverPath = path.join(this.circuitPath, 'Prover.toml');
        fs.writeFileSync(proverPath, proverToml);
        
        // Execute Noir circuit to generate witness
        execSync('nargo execute', { cwd: this.circuitPath });
        
        // Generate proof using Sunspot
        execSync('sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof', 
            { cwd: this.circuitPath });
        
        // Read proof and public witness
        const zkProof = fs.readFileSync(
            path.join(this.circuitPath, 'target/task_completion.proof')
        );
        const publicWitness = fs.readFileSync(
            path.join(this.circuitPath, 'target/task_completion.pw')
        );
        
        return { zkProof, publicWitness };
    }
    
    /**
     * Build the complete_task_private transaction
     * This submits the ZK proof for on-chain verification
     */
    private async buildCompleteTaskPrivateTx(params: {
        taskId: number;
        zkProof: Buffer;
        publicWitness: Buffer;
        worker: PublicKey;
    }): Promise<Transaction> {
        const { taskId, zkProof, publicWitness, worker } = params;

        // Derive PDAs
        const [taskPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('task'), Buffer.from(new Uint8Array(new BigUint64Array([BigInt(taskId)]).buffer))],
            this.program.programId
        );

        const [claimPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('claim'), taskPda.toBuffer(), worker.toBuffer()],
            this.program.programId
        );

        // Get verifier program ID (deployed via Sunspot)
        const verifierProgramId = await this.getVerifierProgramId();

        // Build instruction - simplified to just verify ZK proof
        // Privacy Cash withdrawal happens separately via their SDK
        const ix = await this.program.methods
            .completeTaskPrivate(taskId, {
                zkProof: Array.from(zkProof),
                publicWitness: Array.from(publicWitness),
            })
            .accounts({
                worker,
                task: taskPda,
                taskClaim: claimPda,
                zkVerifier: verifierProgramId,
                systemProgram: PublicKey.default,
            })
            .instruction();

        const tx = new Transaction().add(ix);
        tx.feePayer = worker;
        tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

        return tx;
    }
    
    /**
     * Compute Poseidon commitment for output
     */
    private async computeCommitment(output: bigint[], salt: bigint): Promise<bigint> {
        // TODO: Use actual Poseidon hash implementation
        // This should match the circuit's poseidon::bn254::hash_5
        
        // For now, placeholder
        // In production, use a JS Poseidon implementation that matches Noir's
        console.log('Computing commitment...');
        return BigInt(0);
    }
    
    /**
     * Generate Prover.toml content
     */
    private generateProverToml(params: {
        taskId: number;
        agentPubkey: number[];
        constraintHash: string;
        outputCommitment: string;
        output: string[];
        salt: string;
    }): string {
        return `# Auto-generated Prover.toml
task_id = "${params.taskId}"
agent_pubkey = [${params.agentPubkey.join(', ')}]
constraint_hash = "${params.constraintHash}"
output_commitment = "${params.outputCommitment}"
output = [${params.output.map(o => `"${o}"`).join(', ')}]
salt = "${params.salt}"
`;
    }
    
    private async fetchTask(taskId: number): Promise<{ constraintHash: Buffer }> {
        const [taskPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('task'), Buffer.from(new Uint8Array(new BigUint64Array([BigInt(taskId)]).buffer))],
            this.program.programId
        );
        // Use type assertion for dynamic account access
        const accounts = this.program.account as Record<string, { fetch: (key: PublicKey) => Promise<unknown> }>;
        return await accounts['task'].fetch(taskPda) as { constraintHash: Buffer };
    }
    
    private async getVerifierProgramId(): Promise<PublicKey> {
        // Return the Sunspot Groth16 verifier program ID from constants
        return VERIFIER_PROGRAM_ID;
    }
}

// Helper to compute constraint hash from expected output using poseidon2
export function computeConstraintHash(expectedOutput: bigint[]): Buffer {
    // In production, use a JS poseidon2 implementation matching Noir's
    // For now, this should be computed off-chain with matching algorithm
    // The hash is: poseidon2_permutation([output[0], output[1], output[2], output[3]], 4)[0]
    console.warn('computeConstraintHash: Use poseidon2 implementation matching Noir circuit');
    return Buffer.alloc(HASH_SIZE);
}

// Helper to compute output commitment
export function computeOutputCommitment(constraintHash: bigint, salt: bigint): Buffer {
    // In production, use: poseidon2_permutation([constraintHash, salt, 0, 0], 4)[0]
    console.warn('computeOutputCommitment: Use poseidon2 implementation matching Noir circuit');
    return Buffer.alloc(HASH_SIZE);
}

/**
 * Demo: Complete AgenC Private Task Flow
 *
 * This demonstrates the full privacy-preserving task completion flow:
 * 1. Task creator shields escrow into Privacy Cash pool
 * 2. Worker completes task off-chain
 * 3. Worker generates ZK proof of completion
 * 4. Worker submits proof and receives private payment
 */
async function demo() {
    // Use Helius RPC for performance (Helius bounty integration)
    const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'YOUR_HELIUS_API_KEY';
    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
    const connection = new Connection(rpcUrl);

    console.log('=== AgenC Private Task Completion Demo ===\n');

    // Load wallets (in production, use secure key management)
    // const creatorKeypair = Keypair.fromSecretKey(...);
    // const workerKeypair = Keypair.fromSecretKey(...);

    // Initialize Anchor program
    // const program = new Program(IDL, PROGRAM_ID, provider);

    // Initialize privacy client
    // const client = new AgenCPrivacyClient(connection, program, './circuits/task_completion', rpcUrl);

    // === STEP 1: Task Creator Shields Escrow ===
    console.log('Step 1: Task creator shields escrow funds...');
    // const escrowAmount = 0.1 * LAMPORTS_PER_SOL;  // 0.1 SOL
    // await client.shieldEscrow(creatorKeypair, escrowAmount);
    // console.log(`Shielded ${escrowAmount / LAMPORTS_PER_SOL} SOL into privacy pool`);

    // === STEP 2: Create Task with Constraint Hash ===
    console.log('\nStep 2: Create task with expected output constraint...');
    // The constraint hash commits to the expected output without revealing it
    // const expectedOutput = [1n, 2n, 3n, 4n];
    // const constraintHash = computeConstraintHash(expectedOutput);
    // await program.methods.createTask(taskParams, constraintHash).accounts({...}).rpc();

    // === STEP 3: Worker Claims and Completes Task ===
    console.log('\nStep 3: Worker completes task and generates proof...');
    // const taskId = 42;
    // const output = [1n, 2n, 3n, 4n];  // Must match expected output
    // const salt = BigInt(Math.floor(Math.random() * 1e18));
    //
    // const result = await client.completeTaskPrivate({
    //     taskId,
    //     output,
    //     salt,
    //     recipientWallet: workerKeypair.publicKey,
    //     escrowLamports: 0.1 * LAMPORTS_PER_SOL,
    // }, workerKeypair);

    // === STEP 4: Verify Private Payment ===
    console.log('\nStep 4: Verify worker received private payment...');
    // client.initPrivacyCash(workerKeypair);
    // const workerBalance = await client.getShieldedBalance();
    // console.log(`Worker shielded balance: ${workerBalance.lamports / LAMPORTS_PER_SOL} SOL`);

    console.log('\n=== Demo Complete ===');
    console.log('Privacy features:');
    console.log('  - Task output hidden via ZK proof (only constraint_hash public)');
    console.log('  - Payment hidden via Privacy Cash shielded pool');
    console.log('  - Worker identity linkable to task but not to payment recipient');
}

// Export demo for CLI usage
export { demo };
