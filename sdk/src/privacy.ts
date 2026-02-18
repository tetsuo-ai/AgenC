import { Connection, PublicKey, Transaction, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { PrivacyCash, PrivacyCashConfig } from 'privacycash';
import { HASH_SIZE, NARGO_EXECUTE_TIMEOUT_MS, SUNSPOT_PROVE_TIMEOUT_MS } from './constants';
import { validateCircuitPath } from './validation';
import {
  computeConstraintHash as computeConstraintHashFromProofs,
  computeCommitment as computeCommitmentFromProofs,
  computeCommitmentFromOutput as computeCommitmentFromOutputProofs,
  FIELD_MODULUS,
} from './proofs';
import { createLogger, type Logger } from './logger';

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

/**
 * Result of a private task completion withdrawal
 */
export interface WithdrawResult {
    signature?: string;
    success?: boolean;
    amount?: number;
    [key: string]: unknown; // Allow additional properties from PrivacyCash
}

/**
 * @deprecated The Noir/Sunspot proof path is deprecated and non-functional with the current
 * on-chain program. Use generateProof() from @agenc/sdk/proofs (snarkjs/Circom) and
 * completeTaskPrivate() from @agenc/sdk/tasks for ZK proof generation and submission.
 *
 * SECURITY ISSUES IN THIS CLASS (preserved for reference, do not use in production):
 * - buildCompleteTaskPrivateTx uses wrong PDA seeds (missing creator) and wrong proof struct fields
 * - generateTaskCompletionProof writes secrets to disk (Prover.toml) without guaranteed cleanup
 * - Non-atomic withdrawal: Privacy Cash withdrawal is decoupled from on-chain proof verification
 */
export class AgenCPrivacyClient {
    private connection: Connection;
    private program: Program;
    private circuitPath: string;
    private privacyCash: PrivacyCash | null = null;
    private rpcUrl: string;
    private privacyCashLoaded: boolean = false;
    private logger: Logger;

    constructor(
        connection: Connection,
        program: Program,
        circuitPath: string = './circuits/task_completion',
        rpcUrl?: string,
        logger?: Logger,
    ) {
        // Security: Validate circuit path to prevent path traversal
        validateCircuitPath(circuitPath);

        this.connection = connection;
        this.program = program;
        this.circuitPath = circuitPath;
        this.rpcUrl = rpcUrl || connection.rpcEndpoint;
        this.logger = logger ?? createLogger('info');
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
        // Security: Only enable debug mode when explicitly requested via environment
        // Debug mode can expose sensitive transaction details
        const enableDebug = process.env.AGENC_DEBUG === 'true';
        this.privacyCash = createPrivacyCash({
            RPC_url: this.rpcUrl,
            owner: owner,
            enableDebug
        });
        // Security: Truncate public key in logs to avoid full exposure
        const pubkeyStr = owner.publicKey.toBase58();
        this.logger.info(`Privacy Cash client initialized for: ${pubkeyStr.substring(0, 8)}...${pubkeyStr.substring(pubkeyStr.length - 4)}`);
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

        this.logger.info(`Shielding ${lamports / LAMPORTS_PER_SOL} SOL into privacy pool...`);

        const result = await this.privacyCash!.deposit({ lamports });

        this.logger.info('Escrow shielded successfully');
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
    ): Promise<{ proofTxSignature: string; withdrawResult: WithdrawResult }> {
        const { taskId, output, salt, recipientWallet, escrowLamports } = params;

        // Initialize Privacy Cash for worker (to receive funds)
        await this.initPrivacyCash(worker);

        // 1. Fetch task to get constraint hash
        const task = await this.fetchTask(taskId);
        const constraintHash = task.constraintHash;

        // 2. Compute output commitment (poseidon2 hash of output + salt)
        const outputCommitment = await this.computeCommitment(output, salt);

        // 3. Generate ZK proof of task completion using Noir/Sunspot
        this.logger.info('Step 1/3: Generating ZK proof of task completion...');
        const { zkProof, publicWitness } = await this.generateTaskCompletionProof({
            taskId,
            agentPubkey: worker.publicKey,
            constraintHash,
            outputCommitment,
            output,
            salt,
        });
        this.logger.info(`ZK proof generated: ${zkProof.length} bytes`);

        // 4. Submit proof to on-chain verifier
        this.logger.info('Step 2/3: Submitting proof to on-chain verifier...');
        const tx = await this.buildCompleteTaskPrivateTx({
            taskId,
            zkProof,
            publicWitness,
            worker: worker.publicKey,
        });

        const proofTxSignature = await this.connection.sendTransaction(tx, [worker]);
        // Security: Wait for confirmed commitment level to ensure transaction is finalized
        const confirmation = await this.connection.confirmTransaction(proofTxSignature, 'confirmed');
        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        this.logger.info(`Proof verified on-chain: ${proofTxSignature}`);

        // 5. Withdraw shielded escrow to worker via Privacy Cash
        // Note: In production, this would be triggered by the on-chain program
        // after ZK proof verification. For demo, we trigger it client-side.
        this.logger.info('Step 3/3: Withdrawing shielded escrow via Privacy Cash...');
        const rawResult = await this.privacyCash!.withdraw({
            lamports: escrowLamports,
            recipientAddress: recipientWallet.toBase58()
        });
        if (rawResult === null || rawResult === undefined || typeof rawResult !== 'object') {
            throw new Error('Privacy Cash withdraw returned invalid result');
        }
        const withdrawResult = rawResult as WithdrawResult;
        this.logger.info('Private payment completed!');

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

        // Validate external tools are available before doing any work
        this.validateExternalTools();

        // Security: Re-validate circuit path before use
        validateCircuitPath(this.circuitPath);

        // Write Prover.toml with actual values
        const proverToml = this.generateProverToml({
            taskId,
            agentPubkey: Array.from(agentPubkey.toBytes()),
            constraintHash: '0x' + constraintHash.toString('hex'),
            outputCommitment: '0x' + outputCommitment.toString(16),
            output: output.map(o => o.toString()),
            salt: salt.toString(),
        });

        // SECURITY: Write Prover.toml containing secret salt/output to disk,
        // then ensure it is always deleted even if proof generation fails.
        const proverPath = path.join(this.circuitPath, 'Prover.toml');
        fs.writeFileSync(proverPath, proverToml);

        try {
            // Security: Execute with timeouts and confined cwd to prevent runaway processes
            try {
                execSync('nargo execute', { cwd: this.circuitPath, stdio: 'pipe', timeout: NARGO_EXECUTE_TIMEOUT_MS });
            } catch (e) {
                throw new Error(`Noir circuit execution failed (nargo execute): ${(e as Error).message}`);
            }

            // Generate proof using Sunspot
            try {
                execSync('sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof',
                    { cwd: this.circuitPath, stdio: 'pipe', timeout: SUNSPOT_PROVE_TIMEOUT_MS });
            } catch (e) {
                throw new Error(`Proof generation failed (sunspot prove): ${(e as Error).message}`);
            }

            // Read proof and public witness
            let zkProof: Buffer;
            let publicWitness: Buffer;
            try {
                zkProof = fs.readFileSync(
                    path.join(this.circuitPath, 'target/task_completion.proof')
                );
                // Note: Use .gz extension to match the actual witness file (not .pw)
                publicWitness = fs.readFileSync(
                    path.join(this.circuitPath, 'target/task_completion.gz')
                );
            } catch (e) {
                throw new Error(`Failed to read proof output files: ${(e as Error).message}`);
            }

            return { zkProof, publicWitness };
        } finally {
            // SECURITY: Always delete Prover.toml to avoid leaving secrets on disk
            try { fs.unlinkSync(proverPath); } catch { /* ignore cleanup errors */ }
        }
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

        // Build instruction - ZK proof verified inline via groth16-solana
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
                systemProgram: PublicKey.default,
            })
            .instruction();

        const tx = new Transaction().add(ix);
        tx.feePayer = worker;
        tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

        return tx;
    }
    
    /**
     * Compute Poseidon commitment for output.
     *
     * Uses poseidon-lite which is compatible with circomlib's Poseidon implementation.
     * Matches circuit.circom: output_commitment = Poseidon(output[0..3], salt)
     *
     * @param output - The task output (4 field elements)
     * @param salt - Random salt for hiding the output
     * @returns The output commitment
     */
    private async computeCommitment(output: bigint[], salt: bigint): Promise<bigint> {
        // SECURITY FIX: Use poseidon5(output[0..3], salt) to match the Circom circuit.
        // Previously used legacy poseidon2(constraintHash, salt) which does not match.
        return computeCommitmentFromOutputProofs(output, salt);
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
    
    /**
     * Validate that nargo and sunspot external tools are available.
     * Call before proof generation to fail fast with a clear error message.
     */
    private validateExternalTools(): void {
        try {
            execSync('nargo --version', { stdio: 'pipe', timeout: 5000 });
        } catch {
            throw new Error(
                'nargo not found. Install Noir: https://noir-lang.org/docs/getting_started/installation'
            );
        }

        try {
            execSync('sunspot --version', { stdio: 'pipe', timeout: 5000 });
        } catch {
            throw new Error(
                'sunspot not found. Install Sunspot for Groth16 proof generation.'
            );
        }
    }

    private async fetchTask(taskId: number): Promise<{ constraintHash: Buffer }> {
        const [taskPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('task'), Buffer.from(new Uint8Array(new BigUint64Array([BigInt(taskId)]).buffer))],
            this.program.programId
        );
        // Use type assertion for dynamic account access
        const accounts = this.program.account as Record<string, { fetch: (key: PublicKey) => Promise<unknown> }>;
        let result: unknown;
        try {
            result = await accounts['task'].fetch(taskPda);
        } catch (e) {
            throw new Error(`Failed to fetch task account (taskId=${taskId}): ${(e as Error).message}`);
        }
        if (result === null || result === undefined || typeof result !== 'object') {
            throw new Error(`Task account not found or returned invalid data (taskId=${taskId})`);
        }
        if (!('constraintHash' in result)) {
            throw new Error(`Task account missing constraintHash field (taskId=${taskId})`);
        }
        return result as { constraintHash: Buffer };
    }
    
}

/**
 * Compute constraint hash from expected output using Poseidon.
 *
 * Uses poseidon-lite (poseidon4) which is compatible with circomlib.
 * The constraint hash commits to the expected output without revealing it.
 *
 * @param expectedOutput - The expected task output (4 field elements)
 * @returns The constraint hash as a 32-byte Buffer
 */
export function computeConstraintHash(expectedOutput: bigint[]): Buffer {
    const hash = computeConstraintHashFromProofs(expectedOutput);
    // Convert bigint to 32-byte big-endian buffer
    const hex = hash.toString(16).padStart(HASH_SIZE * 2, '0');
    return Buffer.from(hex, 'hex');
}

/**
 * Compute output commitment from constraint hash and salt.
 *
 * Uses poseidon-lite (poseidon2) which is compatible with circomlib.
 * The commitment hides the output while binding to the constraint.
 *
 * @param constraintHash - The constraint hash (as bigint)
 * @param salt - Random salt for hiding
 * @returns The output commitment as a 32-byte Buffer
 */
export function computeOutputCommitment(constraintHash: bigint, salt: bigint): Buffer {
    const commitment = computeCommitmentFromProofs(constraintHash, salt);
    // Convert bigint to 32-byte big-endian buffer
    const hex = commitment.toString(16).padStart(HASH_SIZE * 2, '0');
    return Buffer.from(hex, 'hex');
}

