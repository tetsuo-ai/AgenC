import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Program, Idl } from '@coral-xyz/anchor';

interface PrivateCompletionParams {
    taskId: number;
    output: bigint[];
    salt: bigint;
    recipientWallet: PublicKey;
    escrowLamports: number;
}
interface ShieldEscrowResult {
    txSignature: string;
    shieldedAmount: number;
}
/**
 * Result of a private task completion withdrawal
 */
interface WithdrawResult {
    signature?: string;
    success?: boolean;
    amount?: number;
    [key: string]: unknown;
}
declare class AgenCPrivacyClient {
    private connection;
    private program;
    private circuitPath;
    private privacyCash;
    private rpcUrl;
    private privacyCashLoaded;
    constructor(connection: Connection, program: Program, circuitPath?: string, rpcUrl?: string);
    /**
     * Initialize Privacy Cash client for a specific wallet
     * Must be called before using private escrow features
     */
    initPrivacyCash(owner: Keypair): Promise<void>;
    /**
     * Shield escrow funds into Privacy Cash pool
     * Called by task creator when creating a private task
     */
    shieldEscrow(creator: Keypair, lamports: number): Promise<ShieldEscrowResult>;
    /**
     * Get shielded balance for current wallet
     */
    getShieldedBalance(): Promise<{
        lamports: number;
    }>;
    /**
     * Complete a task privately using ZK proofs and Privacy Cash withdrawal
     *
     * Flow:
     * 1. Generate ZK proof that worker completed task correctly (Noir/Sunspot)
     * 2. Submit proof on-chain for verification
     * 3. Upon verification, withdraw shielded escrow to worker via Privacy Cash
     */
    completeTaskPrivate(params: PrivateCompletionParams, worker: Keypair): Promise<{
        proofTxSignature: string;
        withdrawResult: WithdrawResult;
    }>;
    /**
     * Generate ZK proof for task completion using Noir/Sunspot
     */
    private generateTaskCompletionProof;
    /**
     * Build the complete_task_private transaction
     * This submits the ZK proof for on-chain verification
     */
    private buildCompleteTaskPrivateTx;
    /**
     * Compute Poseidon commitment for output
     *
     * SECURITY WARNING: This is a placeholder implementation that returns 0n.
     * In production, this MUST use a real Poseidon2 implementation that matches
     * the Noir circuit's poseidon2_permutation function.
     *
     * @throws Error in production mode (NODE_ENV=production)
     */
    private computeCommitment;
    /**
     * Generate Prover.toml content
     */
    private generateProverToml;
    private fetchTask;
}

/**
 * High-level Privacy Client for AgenC
 *
 * Provides a simplified interface for privacy-preserving task operations
 */

interface PrivacyClientConfig {
    /** Solana RPC endpoint URL */
    rpcUrl?: string;
    /** Use devnet (default: false for mainnet) */
    devnet?: boolean;
    /** Path to Noir circuit directory */
    circuitPath?: string;
    /** Owner wallet keypair */
    wallet?: Keypair;
    /** Enable debug logging */
    debug?: boolean;
    /** Program IDL (required for full functionality) */
    idl?: Idl;
}
declare class PrivacyClient {
    private connection;
    private program;
    private privacyClient;
    private config;
    private wallet;
    constructor(config?: PrivacyClientConfig);
    /**
     * Initialize the client with a wallet and optional IDL
     * @param wallet - The wallet keypair to use for signing
     * @param idl - Optional IDL for the AgenC program (required for full functionality)
     */
    init(wallet: Keypair, idl?: Idl): Promise<void>;
    /**
     * Get connection instance
     */
    getConnection(): Connection;
    /**
     * Get wallet public key
     */
    getPublicKey(): PublicKey | null;
    /**
     * Shield SOL into the privacy pool
     * @param lamports - Amount in lamports to shield (must be positive integer)
     * @throws Error if lamports is invalid or client not initialized
     */
    shield(lamports: number): Promise<{
        txSignature: string;
        amount: number;
    }>;
    /**
     * Get shielded balance
     */
    getShieldedBalance(): Promise<number>;
    /**
     * Complete a task privately with ZK proof
     */
    completeTaskPrivate(params: {
        taskId: number;
        output: bigint[];
        salt: bigint;
        recipientWallet: PublicKey;
        escrowLamports: number;
    }): Promise<{
        proofTxSignature: string;
        withdrawResult: any;
    }>;
    /**
     * Get the underlying AgenCPrivacyClient for advanced operations
     */
    getPrivacyClient(): AgenCPrivacyClient | null;
    /**
     * Format lamports as SOL string
     */
    static formatSol(lamports: number): string;
    /**
     * Parse SOL string to lamports
     *
     * Note: For large SOL amounts (> ~9 million SOL), consider using BigInt
     * to avoid floating point precision issues. This method validates inputs
     * and throws on invalid values.
     *
     * @param sol - SOL amount as string or number
     * @returns lamports as number (safe for amounts < MAX_SAFE_INTEGER / LAMPORTS_PER_SOL)
     * @throws Error if input is invalid or would cause precision loss
     */
    static parseSol(sol: string | number): number;
}

/**
 * ZK Proof Generation for AgenC
 *
 * Uses snarkjs with Circom circuits for Groth16 proof generation.
 * Hash computation uses poseidon-lite for exact circomlib compatibility.
 *
 * ## Security Notes
 *
 * ### Salt Security
 * - Each proof MUST use a unique, cryptographically random salt
 * - NEVER reuse a salt across different proofs - this can leak private output data
 * - Use `generateSalt()` to create secure random salts
 * - Store salts securely if you need to verify commitments later
 *
 * ### Hash Computation
 * - All hashes are computed via poseidon-lite (circomlib compatible)
 * - This guarantees exact compatibility with the task_completion circuit
 */

/** BN254 scalar field modulus */
declare const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/**
 * Result from computing hashes
 */
interface HashResult {
    constraintHash: bigint;
    outputCommitment: bigint;
    expectedBinding: bigint;
}
/**
 * Parameters for proof generation
 */
interface ProofGenerationParams {
    taskPda: PublicKey;
    agentPubkey: PublicKey;
    output: bigint[];
    salt: bigint;
    circuitPath?: string;
}
interface ProofResult {
    proof: Buffer;
    constraintHash: Buffer;
    outputCommitment: Buffer;
    expectedBinding: Buffer;
    proofSize: number;
    generationTime: number;
}
/**
 * Generate a cryptographically secure random salt for proof commitments.
 *
 * SECURITY: Each proof MUST use a fresh salt. Reusing salts across different
 * proofs with different outputs can leak information about the private outputs.
 *
 * @returns A random bigint in the BN254 scalar field [0, FIELD_MODULUS)
 */
declare function generateSalt(): bigint;
/**
 * Convert a PublicKey to a field element.
 *
 * Interprets the 32-byte public key as a big-endian integer and reduces
 * it modulo the BN254 scalar field.
 *
 * @param pubkey - The public key to convert
 * @returns The field element representation
 */
declare function pubkeyToField(pubkey: PublicKey): bigint;
/**
 * Compute the constraint hash from output values.
 * Uses Poseidon hash matching the circomlib implementation.
 *
 * @param output - Task output (4 field elements)
 * @returns The constraint hash
 */
declare function computeConstraintHash(output: bigint[]): bigint;
/**
 * Compute the output commitment from constraint hash and salt.
 * Uses Poseidon hash matching the circomlib implementation.
 *
 * @param constraintHash - The constraint hash
 * @param salt - Random salt
 * @returns The output commitment
 */
declare function computeCommitment(constraintHash: bigint, salt: bigint): bigint;
/**
 * Compute the expected binding for proof verification.
 * Binding = hash(hash(task_id, agent_pubkey), output_commitment)
 *
 * @param taskPda - Task PDA
 * @param agentPubkey - Agent's public key
 * @param outputCommitment - The output commitment
 * @returns The expected binding
 */
declare function computeExpectedBinding(taskPda: PublicKey, agentPubkey: PublicKey, outputCommitment: bigint): bigint;
/**
 * Compute all hashes needed for proof generation.
 *
 * @param taskPda - Task PDA (used as task_id)
 * @param agentPubkey - Agent's public key
 * @param output - Task output (4 field elements)
 * @param salt - Random salt for commitment
 * @returns Computed hashes (constraintHash, outputCommitment, expectedBinding)
 */
declare function computeHashes(taskPda: PublicKey, agentPubkey: PublicKey, output: bigint[], salt: bigint): HashResult;
/**
 * Generate a ZK proof for private task completion.
 *
 * This function:
 * 1. Computes all necessary hashes using poseidon-lite (circomlib compatible)
 * 2. Generates the witness for the task_completion circuit
 * 3. Creates the Groth16 proof via snarkjs
 *
 * @param params - Proof generation parameters
 * @returns Proof result including proof bytes and public inputs
 */
declare function generateProof(params: ProofGenerationParams): Promise<ProofResult>;
/**
 * Verify a proof locally using snarkjs.
 *
 * @param proof - The proof buffer (256 bytes in groth16-solana format)
 * @param publicSignals - Array of public signals
 * @param circuitPath - Path to circuit directory
 * @returns True if proof is valid
 */
declare function verifyProofLocally(proof: Buffer, publicSignals: bigint[], circuitPath?: string): Promise<boolean>;
interface ToolsStatus {
    snarkjs: boolean;
    snarkjsVersion?: string;
}
/**
 * Check if required tools (snarkjs) are available.
 * Note: circom is only needed for circuit compilation, not proof generation.
 * @returns Status of snarkjs including version if available
 */
declare function checkToolsAvailable(): ToolsStatus;
/**
 * Throws an error with installation instructions if required tools are missing.
 */
declare function requireTools(): void;

/**
 * AgenC SDK Constants
 */

/** AgenC Coordination Program ID */
declare const PROGRAM_ID: PublicKey;
/** Privacy Cash Program ID */
declare const PRIVACY_CASH_PROGRAM_ID: PublicKey;
/** Default Devnet RPC endpoint */
declare const DEVNET_RPC = "https://api.devnet.solana.com";
/** Default Mainnet RPC (Helius recommended) */
declare const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
/** Size of cryptographic hashes in bytes (SHA256, Poseidon) */
declare const HASH_SIZE = 32;
/** Size of result/description data fields in bytes */
declare const RESULT_DATA_SIZE = 64;
/** Size of a u64 in bytes for buffer encoding */
declare const U64_SIZE = 8;
/** Anchor account discriminator size in bytes */
declare const DISCRIMINATOR_SIZE = 8;
/** Number of field elements in output array (circuit constraint) */
declare const OUTPUT_FIELD_COUNT = 4;
/** Proof size in bytes (Groth16 via groth16-solana) */
declare const PROOF_SIZE_BYTES = 256;
/** Approximate verification compute units */
declare const VERIFICATION_COMPUTE_UNITS = 50000;
/** Number of public inputs in the circuit (32 task_id bytes + 32 agent bytes + constraint_hash + output_commitment + expected_binding) */
declare const PUBLIC_INPUTS_COUNT = 67;
/** Base for percentage calculations (100 = 100%) */
declare const PERCENT_BASE = 100;
/** Default protocol fee percentage */
declare const DEFAULT_FEE_PERCENT = 1;
/**
 * Task states matching on-chain TaskStatus enum.
 * Values MUST match programs/agenc-coordination/src/state.rs:TaskStatus
 */
declare enum TaskState {
    /** Task is open for claims */
    Open = 0,
    /** Task has been claimed and is being worked on */
    InProgress = 1,
    /** Task is awaiting validation */
    PendingValidation = 2,
    /** Task has been completed successfully */
    Completed = 3,
    /** Task has been cancelled by creator */
    Cancelled = 4,
    /** Task is in dispute resolution */
    Disputed = 5
}
/** PDA seeds */
declare const SEEDS: {
    readonly PROTOCOL: Buffer<ArrayBuffer>;
    readonly TASK: Buffer<ArrayBuffer>;
    readonly CLAIM: Buffer<ArrayBuffer>;
    readonly AGENT: Buffer<ArrayBuffer>;
    readonly ESCROW: Buffer<ArrayBuffer>;
    readonly DISPUTE: Buffer<ArrayBuffer>;
    readonly VOTE: Buffer<ArrayBuffer>;
    readonly AUTHORITY_VOTE: Buffer<ArrayBuffer>;
};

/**
 * Task Management Helpers for AgenC
 *
 * Create, claim, and complete tasks on the AgenC protocol
 */

interface TaskParams {
    /** Task description/title */
    description: string;
    /** Escrow amount in lamports */
    escrowLamports: number;
    /** Deadline as Unix timestamp */
    deadline: number;
    /**
     * Constraint hash for private task verification.
     * For private tasks, this is the Poseidon hash of the expected output.
     * Workers must prove they know an output that hashes to this value.
     * CRITICAL: Must be set for private tasks, verified on-chain during completion.
     */
    constraintHash?: Buffer;
    /** Required skills (optional) */
    requiredSkills?: string[];
    /** Maximum number of claims allowed */
    maxClaims?: number;
}
interface TaskStatus {
    /** Task ID */
    taskId: number;
    /** Current state */
    state: TaskState;
    /** Creator public key */
    creator: PublicKey;
    /** Escrow amount */
    escrowLamports: number;
    /** Deadline timestamp */
    deadline: number;
    /** Constraint hash (if private) */
    constraintHash: Buffer | null;
    /** Claimed by agent (if claimed) */
    claimedBy: PublicKey | null;
    /** Completion timestamp (if completed) */
    completedAt: number | null;
}
/**
 * Derive task PDA from task ID
 * @param taskId - Task ID (must be a non-negative integer)
 * @param programId - Program ID (defaults to PROGRAM_ID)
 * @returns Task PDA public key
 * @throws Error if taskId is invalid
 */
declare function deriveTaskPda(taskId: number, programId?: PublicKey): PublicKey;
/**
 * Derive claim PDA from task and agent
 */
declare function deriveClaimPda(taskPda: PublicKey, agent: PublicKey, programId?: PublicKey): PublicKey;
/**
 * Derive escrow PDA from task
 */
declare function deriveEscrowPda(taskPda: PublicKey, programId?: PublicKey): PublicKey;
/**
 * Create a new task
 */
declare function createTask(connection: Connection, program: Program, creator: Keypair, params: TaskParams): Promise<{
    taskId: number;
    txSignature: string;
}>;
/**
 * Claim a task as an agent
 */
declare function claimTask(connection: Connection, program: Program, agent: Keypair, taskId: number): Promise<{
    txSignature: string;
}>;
/**
 * Complete a task (standard, non-private)
 */
declare function completeTask(connection: Connection, program: Program, worker: Keypair, taskId: number, resultHash: Buffer): Promise<{
    txSignature: string;
}>;
interface PrivateCompletionProof {
    proofData: Buffer;
    constraintHash: Buffer;
    outputCommitment: Buffer;
    expectedBinding: Buffer;
}
/**
 * Complete a task privately with ZK proof
 */
declare function completeTaskPrivate(connection: Connection, program: Program, worker: Keypair, taskId: number, proof: PrivateCompletionProof, verifierProgramId: PublicKey): Promise<{
    txSignature: string;
}>;
/**
 * Get task status
 */
declare function getTask(connection: Connection, program: Program, taskId: number): Promise<TaskStatus | null>;
/**
 * Get all tasks created by an address
 */
declare function getTasksByCreator(connection: Connection, program: Program, creator: PublicKey): Promise<TaskStatus[]>;
/**
 * Format task state as human-readable string
 */
declare function formatTaskState(state: TaskState): string;
/**
 * Calculate escrow fee (protocol fee percentage)
 * @param escrowLamports - Escrow amount in lamports (must be non-negative)
 * @param feePercentage - Fee percentage (must be between 0 and PERCENT_BASE)
 * @returns Fee amount in lamports
 * @throws Error if inputs would cause overflow or are invalid
 */
declare function calculateEscrowFee(escrowLamports: number, feePercentage?: number): number;

/**
 * @agenc/sdk - Privacy-preserving agent coordination on Solana
 *
 * AgenC enables agents to complete tasks and receive payments with full privacy:
 * - ZK proofs verify task completion without revealing outputs
 * - Privacy Cash breaks payment linkability via shielded pools
 * - Inline groth16-solana verifier validates Circom circuit proofs
 */

declare const VERSION = "1.0.0";

export { DEFAULT_FEE_PERCENT, DEVNET_RPC, DISCRIMINATOR_SIZE, FIELD_MODULUS, HASH_SIZE, type HashResult, MAINNET_RPC, OUTPUT_FIELD_COUNT, PERCENT_BASE, PRIVACY_CASH_PROGRAM_ID, PROGRAM_ID, PROOF_SIZE_BYTES, PUBLIC_INPUTS_COUNT, PrivacyClient, type PrivacyClientConfig, type PrivateCompletionProof, type ProofGenerationParams, type ProofResult, RESULT_DATA_SIZE, SEEDS, type TaskParams, TaskState, type TaskStatus, type ToolsStatus, U64_SIZE, VERIFICATION_COMPUTE_UNITS, VERSION, calculateEscrowFee, checkToolsAvailable, claimTask, completeTask, completeTaskPrivate, computeCommitment, computeConstraintHash, computeExpectedBinding, computeHashes, createTask, deriveClaimPda, deriveEscrowPda, deriveTaskPda, formatTaskState, generateProof, generateSalt, getTask, getTasksByCreator, pubkeyToField, requireTools, verifyProofLocally };
