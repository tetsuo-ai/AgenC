"use strict";
/**
 * Shared test utilities for AgenC integration tests.
 *
 * This module provides common helpers to reduce boilerplate across test files:
 * - PDA derivation functions
 * - Capability and task type constants
 * - Helper functions for test setup
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRUSTED_VERIFIER_PROGRAM_ID = exports.TRUSTED_ROUTER_PROGRAM_ID = exports.TRUSTED_IMAGE_ID = exports.PROPOSAL_STATUS_CANCELLED = exports.PROPOSAL_STATUS_DEFEATED = exports.PROPOSAL_STATUS_EXECUTED = exports.PROPOSAL_STATUS_ACTIVE = exports.PROPOSAL_TYPE_RATE_LIMIT_CHANGE = exports.PROPOSAL_TYPE_TREASURY_SPEND = exports.PROPOSAL_TYPE_FEE_CHANGE = exports.PROPOSAL_TYPE_PROTOCOL_UPGRADE = exports.DEFAULT_DISPUTE_THRESHOLD = exports.DEFAULT_PROTOCOL_FEE_BPS = exports.DEFAULT_MIN_STAKE_LAMPORTS = exports.MAX_DELAY_MS = exports.BASE_DELAY_MS = exports.MAX_AIRDROP_ATTEMPTS = exports.MIN_BALANCE_SOL = exports.AIRDROP_SOL = exports.BPF_LOADER_UPGRADEABLE_ID = exports.VALID_EVIDENCE = exports.RESOLUTION_TYPE_SPLIT = exports.RESOLUTION_TYPE_COMPLETE = exports.RESOLUTION_TYPE_REFUND = exports.TASK_TYPE_COMPETITIVE = exports.TASK_TYPE_COLLABORATIVE = exports.TASK_TYPE_EXCLUSIVE = exports.MIN_DISPUTE_STAKE_LAMPORTS = exports.CAPABILITY_AGGREGATOR = exports.CAPABILITY_VALIDATOR = exports.CAPABILITY_ARBITER = exports.CAPABILITY_COORDINATOR = exports.CAPABILITY_ACTUATOR = exports.CAPABILITY_SENSOR = exports.CAPABILITY_NETWORK = exports.CAPABILITY_STORAGE = exports.CAPABILITY_INFERENCE = exports.CAPABILITY_COMPUTE = exports.bigintToBytes32 = exports.generateSalt = exports.computeConstraintHash = exports.computeHashes = void 0;
exports.deriveProtocolPda = deriveProtocolPda;
exports.deriveProgramDataPda = deriveProgramDataPda;
exports.deriveAgentPda = deriveAgentPda;
exports.deriveTaskPda = deriveTaskPda;
exports.deriveEscrowPda = deriveEscrowPda;
exports.deriveClaimPda = deriveClaimPda;
exports.deriveDisputePda = deriveDisputePda;
exports.deriveVotePda = deriveVotePda;
exports.deriveAuthorityVotePda = deriveAuthorityVotePda;
exports.deriveStatePda = deriveStatePda;
exports.createId = createId;
exports.createDescription = createDescription;
exports.createHash = createHash;
exports.generateRunId = generateRunId;
exports.makeAgentId = makeAgentId;
exports.makeTaskId = makeTaskId;
exports.makeDisputeId = makeDisputeId;
exports.getDefaultDeadline = getDefaultDeadline;
exports.getDeadlineInSeconds = getDeadlineInSeconds;
exports.sleep = sleep;
exports.fundWallet = fundWallet;
exports.fundWallets = fundWallets;
exports.disableRateLimitsForTests = disableRateLimitsForTests;
exports.ensureAgentRegistered = ensureAgentRegistered;
exports.createWorkerPool = createWorkerPool;
exports.getWorkerFromPool = getWorkerFromPool;
exports.returnWorkerToPool = returnWorkerToPool;
exports.deriveGovernanceConfigPda = deriveGovernanceConfigPda;
exports.deriveProposalPda = deriveProposalPda;
exports.deriveGovernanceVotePda = deriveGovernanceVotePda;
exports.deriveFeedPostPda = deriveFeedPostPda;
exports.deriveFeedVotePda = deriveFeedVotePda;
exports.errorContainsAny = errorContainsAny;
exports.getErrorCode = getErrorCode;
exports.buildTestSealBytes = buildTestSealBytes;
exports.buildTestJournal = buildTestJournal;
exports.deriveBindingSpendPda = deriveBindingSpendPda;
exports.deriveNullifierSpendPda = deriveNullifierSpendPda;
exports.deriveRouterPda = deriveRouterPda;
exports.deriveVerifierEntryPda = deriveVerifierEntryPda;
const bn_js_1 = __importDefault(require("bn.js"));
const web3_js_1 = require("@solana/web3.js");
// Re-export SDK ZK helpers for integration tests
var sdk_1 = require("@agenc/sdk");
Object.defineProperty(exports, "computeHashes", { enumerable: true, get: function () { return sdk_1.computeHashes; } });
Object.defineProperty(exports, "computeConstraintHash", { enumerable: true, get: function () { return sdk_1.computeConstraintHash; } });
Object.defineProperty(exports, "generateSalt", { enumerable: true, get: function () { return sdk_1.generateSalt; } });
Object.defineProperty(exports, "bigintToBytes32", { enumerable: true, get: function () { return sdk_1.bigintToBytes32; } });
// ============================================================================
// Capability Constants (matches program)
// ============================================================================
exports.CAPABILITY_COMPUTE = 1 << 0;
exports.CAPABILITY_INFERENCE = 1 << 1;
exports.CAPABILITY_STORAGE = 1 << 2;
exports.CAPABILITY_NETWORK = 1 << 3;
exports.CAPABILITY_SENSOR = 1 << 4;
exports.CAPABILITY_ACTUATOR = 1 << 5;
exports.CAPABILITY_COORDINATOR = 1 << 6;
exports.CAPABILITY_ARBITER = 1 << 7;
exports.CAPABILITY_VALIDATOR = 1 << 8;
exports.CAPABILITY_AGGREGATOR = 1 << 9;
// ============================================================================
// Rate Limit Constants (matches program update_rate_limits.rs)
// ============================================================================
/**
 * On-chain minimum for min_stake_for_dispute (update_rate_limits.rs:MIN_DISPUTE_STAKE).
 * The updateRateLimits instruction rejects values below this with InvalidInput.
 */
exports.MIN_DISPUTE_STAKE_LAMPORTS = 1000;
// ============================================================================
// Task Type Constants (matches program)
// ============================================================================
exports.TASK_TYPE_EXCLUSIVE = 0;
exports.TASK_TYPE_COLLABORATIVE = 1;
exports.TASK_TYPE_COMPETITIVE = 2;
// ============================================================================
// Resolution Type Constants (matches program)
// ============================================================================
exports.RESOLUTION_TYPE_REFUND = 0;
exports.RESOLUTION_TYPE_COMPLETE = 1;
exports.RESOLUTION_TYPE_SPLIT = 2;
// ============================================================================
// Valid Evidence String (minimum 50 characters required)
// ============================================================================
exports.VALID_EVIDENCE = "This is valid dispute evidence that exceeds the minimum 50 character requirement for the dispute system.";
// ============================================================================
// PDA Derivation Functions
// ============================================================================
/**
 * Derive the protocol config PDA (singleton).
 */
function deriveProtocolPda(programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId)[0];
}
/** BPF Loader Upgradeable program ID */
exports.BPF_LOADER_UPGRADEABLE_ID = new web3_js_1.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/**
 * Derive the ProgramData PDA for an upgradeable program.
 * Used for initialize_protocol's upgrade authority check (fix #839).
 */
function deriveProgramDataPda(programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([programId.toBuffer()], exports.BPF_LOADER_UPGRADEABLE_ID)[0];
}
/**
 * Derive an agent registration PDA from agent ID.
 */
function deriveAgentPda(agentId, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId], programId)[0];
}
/**
 * Derive a task PDA from creator pubkey and task ID.
 */
function deriveTaskPda(creatorPubkey, taskId, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("task"), creatorPubkey.toBuffer(), taskId], programId)[0];
}
/**
 * Derive an escrow PDA from task PDA.
 */
function deriveEscrowPda(taskPda, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda.toBuffer()], programId)[0];
}
/**
 * Derive a claim PDA from task PDA and worker agent PDA.
 */
function deriveClaimPda(taskPda, workerAgentPda, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("claim"), taskPda.toBuffer(), workerAgentPda.toBuffer()], programId)[0];
}
/**
 * Derive a dispute PDA from dispute ID.
 */
function deriveDisputePda(disputeId, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("dispute"), disputeId], programId)[0];
}
/**
 * Derive a vote PDA from dispute PDA and voter agent PDA.
 */
function deriveVotePda(disputePda, voterAgentPda, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("vote"), disputePda.toBuffer(), voterAgentPda.toBuffer()], programId)[0];
}
/**
 * Derive an authority vote PDA from dispute PDA and voter authority.
 */
function deriveAuthorityVotePda(disputePda, voterAuthority, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("authority_vote"),
        disputePda.toBuffer(),
        voterAuthority.toBuffer(),
    ], programId)[0];
}
/**
 * Derive a shared state PDA from key string.
 */
function deriveStatePda(key, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("state"), Buffer.from(key)], programId)[0];
}
// ============================================================================
// Buffer Creation Helpers
// ============================================================================
/**
 * Create a 32-byte buffer from a string (padded with zeros).
 */
function createId(name) {
    return Buffer.from(name.padEnd(32, "\0"));
}
/**
 * Create a 64-byte description array from a string.
 */
function createDescription(desc) {
    const buf = Buffer.alloc(64);
    buf.write(desc);
    return Array.from(buf);
}
/**
 * Create a 32-byte hash array from a string.
 */
function createHash(data) {
    const buf = Buffer.alloc(32);
    buf.write(data);
    return Array.from(buf);
}
// ============================================================================
// Default Protocol Configuration Constants
// ============================================================================
/** Default airdrop amount in SOL for test wallets */
exports.AIRDROP_SOL = 2;
/** Minimum balance threshold before re-airdropping */
exports.MIN_BALANCE_SOL = 1;
/** Maximum retries for airdrop requests */
exports.MAX_AIRDROP_ATTEMPTS = 5;
/** Base delay for exponential backoff (ms) */
exports.BASE_DELAY_MS = 500;
/** Maximum delay between retries (ms) */
exports.MAX_DELAY_MS = 8000;
/** Default min stake for protocol initialization (1 SOL) */
exports.DEFAULT_MIN_STAKE_LAMPORTS = 1 * web3_js_1.LAMPORTS_PER_SOL;
/** Default protocol fee in basis points (1% = 100 bps) */
exports.DEFAULT_PROTOCOL_FEE_BPS = 100;
/** Default dispute threshold percentage */
exports.DEFAULT_DISPUTE_THRESHOLD = 51;
// ============================================================================
// Helper Functions
// ============================================================================
/**
 * Generate a unique run ID to prevent conflicts with persisted validator state.
 * Call once at the start of each test file.
 */
function generateRunId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
/**
 * Create a unique agent ID with the given prefix and run ID.
 * Ensures IDs don't collide across test runs.
 */
function makeAgentId(prefix, runId) {
    return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}
/**
 * Create a unique task ID with the given prefix and run ID.
 */
function makeTaskId(prefix, runId) {
    return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}
/**
 * Create a unique dispute ID with the given prefix and run ID.
 */
function makeDisputeId(prefix, runId) {
    return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}
/**
 * Get a default deadline 1 hour in the future.
 */
function getDefaultDeadline() {
    return new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600);
}
/**
 * Get a deadline N seconds in the future.
 */
function getDeadlineInSeconds(seconds) {
    return new bn_js_1.default(Math.floor(Date.now() / 1000) + seconds);
}
/**
 * Sleep for a specified number of milliseconds.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Fund a wallet with SOL via airdrop.
 */
async function fundWallet(connection, wallet, lamports = 5 * web3_js_1.LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(wallet, lamports);
    await connection.confirmTransaction(sig, "confirmed");
}
/**
 * Fund multiple wallets in parallel.
 */
async function fundWallets(connection, wallets, lamports = 5 * web3_js_1.LAMPORTS_PER_SOL) {
    const sigs = await Promise.all(wallets.map((wallet) => connection.requestAirdrop(wallet, lamports)));
    await Promise.all(sigs.map((sig) => connection.confirmTransaction(sig, "confirmed")));
}
/**
 * Disable protocol rate limits for deterministic integration tests.
 *
 * Sets cooldowns to 0 and per-24h limits to 0 (unlimited).
 * The on-chain MIN_DISPUTE_STAKE (1000 lamports) is used by default for
 * min_stake_for_dispute — passing 0 will be rejected by the program.
 *
 * Safe to call repeatedly in before hooks; silently succeeds if rate limits
 * are already configured with the same values.
 */
async function disableRateLimitsForTests(params) {
    const { program, protocolPda, authority, additionalSigners = [], minStakeForDisputeLamports = exports.MIN_DISPUTE_STAKE_LAMPORTS, skipPreflight = true, } = params;
    const remainingAccounts = [
        { pubkey: authority, isSigner: true, isWritable: false },
        ...additionalSigners.map((s) => ({
            pubkey: s.publicKey,
            isSigner: true,
            isWritable: false,
        })),
    ];
    const builder = program.methods
        .updateRateLimits(new bn_js_1.default(1), // task_creation_cooldown = 1s (minimum allowed)
    255, // max_tasks_per_24h = 255 (effectively unlimited)
    new bn_js_1.default(1), // dispute_initiation_cooldown = 1s (minimum allowed)
    255, // max_disputes_per_24h = 255 (effectively unlimited)
    new bn_js_1.default(minStakeForDisputeLamports))
        .accountsPartial({ protocolConfig: protocolPda })
        .remainingAccounts(remainingAccounts);
    if (additionalSigners.length > 0) {
        builder.signers(additionalSigners);
    }
    await builder.rpc({ skipPreflight });
}
/**
 * Ensure an agent registration exists, creating it if needed.
 */
async function ensureAgentRegistered(params) {
    const { program, protocolPda, agentId, authority, capabilities, endpoint = "https://example.com", stakeLamports = web3_js_1.LAMPORTS_PER_SOL, skipPreflight = true, } = params;
    const agentPda = deriveAgentPda(agentId, program.programId);
    try {
        await program.methods
            .registerAgent(Array.from(agentId), new bn_js_1.default(capabilities), endpoint, null, new bn_js_1.default(stakeLamports))
            .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: authority.publicKey,
        })
            .signers([authority])
            .rpc({ skipPreflight });
    }
    catch (error) {
        const message = error.message ?? "";
        if (!message.includes("already in use")) {
            throw error;
        }
    }
    return agentPda;
}
/**
 * Create a worker pool for fast test execution.
 * Pre-funds and registers workers to avoid airdrop delays.
 */
async function createWorkerPool(connection, program, protocolPda, runId, size = 20, capabilities = exports.CAPABILITY_COMPUTE, stake = web3_js_1.LAMPORTS_PER_SOL) {
    const pool = [];
    const wallets = [];
    const airdropSigs = [];
    // Generate wallets and request airdrops in parallel
    for (let i = 0; i < size; i++) {
        const wallet = web3_js_1.Keypair.generate();
        wallets.push(wallet);
        const sig = await connection.requestAirdrop(wallet.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL);
        airdropSigs.push(sig);
    }
    // Confirm all airdrops
    await Promise.all(airdropSigs.map((sig) => connection.confirmTransaction(sig, "confirmed")));
    // Register all workers in parallel
    const registerPromises = wallets.map(async (wallet, i) => {
        const agentId = makeAgentId(`pool${i}`, runId);
        const agentPda = deriveAgentPda(agentId, program.programId);
        await program.methods
            .registerAgent(Array.from(agentId), new bn_js_1.default(capabilities), `https://pool-worker-${i}.example.com`, null, new bn_js_1.default(stake))
            .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: wallet.publicKey,
        })
            .signers([wallet])
            .rpc();
        pool.push({
            wallet,
            agentId,
            agentPda,
            inUse: false,
        });
    });
    await Promise.all(registerPromises);
    return pool;
}
/**
 * Get a worker from the pool, marking it as in use.
 */
function getWorkerFromPool(pool) {
    const worker = pool.find((w) => !w.inUse);
    if (worker) {
        worker.inUse = true;
    }
    return worker ?? null;
}
/**
 * Return a worker to the pool.
 */
function returnWorkerToPool(worker) {
    worker.inUse = false;
}
// ============================================================================
// Proposal Type Constants (matches program ProposalType enum)
// ============================================================================
exports.PROPOSAL_TYPE_PROTOCOL_UPGRADE = 0;
exports.PROPOSAL_TYPE_FEE_CHANGE = 1;
exports.PROPOSAL_TYPE_TREASURY_SPEND = 2;
exports.PROPOSAL_TYPE_RATE_LIMIT_CHANGE = 3;
// ============================================================================
// Proposal Status Constants (matches program ProposalStatus enum)
// ============================================================================
exports.PROPOSAL_STATUS_ACTIVE = 0;
exports.PROPOSAL_STATUS_EXECUTED = 1;
exports.PROPOSAL_STATUS_DEFEATED = 2;
exports.PROPOSAL_STATUS_CANCELLED = 3;
// ============================================================================
// Governance PDA Derivation Functions
// ============================================================================
/**
 * Derive the governance config PDA (singleton).
 */
function deriveGovernanceConfigPda(programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("governance")], programId)[0];
}
/**
 * Derive a proposal PDA from proposer agent PDA and nonce.
 */
function deriveProposalPda(proposerAgentPda, nonce, programId) {
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(BigInt(nonce));
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("proposal"), proposerAgentPda.toBuffer(), nonceBuffer], programId)[0];
}
/**
 * Derive a governance vote PDA from proposal PDA and voter authority pubkey.
 * Seeds: ["governance_vote", proposal_pda, authority_pubkey]
 */
function deriveGovernanceVotePda(proposalPda, voterAuthorityPubkey, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("governance_vote"),
        proposalPda.toBuffer(),
        voterAuthorityPubkey.toBuffer(),
    ], programId)[0];
}
// ============================================================================
// Feed PDA Derivation Functions
// ============================================================================
/**
 * Derive a feed post PDA from author agent PDA and nonce.
 * Seeds: ["post", author_agent_pda, nonce]
 */
function deriveFeedPostPda(authorPda, nonce, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("post"), authorPda.toBuffer(), Buffer.from(nonce)], programId)[0];
}
/**
 * Derive a feed vote PDA from post PDA and voter agent PDA.
 * Seeds: ["upvote", post_pda, voter_agent_pda]
 */
function deriveFeedVotePda(postPda, voterPda, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("upvote"), postPda.toBuffer(), voterPda.toBuffer()], programId)[0];
}
// ============================================================================
// Assertion Helpers
// ============================================================================
/**
 * Check if an error message contains any of the expected patterns.
 */
function errorContainsAny(error, patterns) {
    const message = error?.message ?? "";
    const errorCode = error?.error?.errorCode
        ?.code ?? "";
    return patterns.some((p) => message.includes(p) || errorCode.includes(p));
}
/**
 * Extract error code from an Anchor error.
 */
function getErrorCode(error) {
    return error?.error
        ?.errorCode?.code;
}
// ============================================================================
// ZK Proof Test Helpers
// ============================================================================
/** Trusted RISC0 selector bytes */
const ZK_TRUSTED_SELECTOR = Buffer.from([0x52, 0x5a, 0x56, 0x4d]);
/** Trusted RISC0 image ID — must match on-chain constant */
exports.TRUSTED_IMAGE_ID = Buffer.from([
    202, 175, 194, 115, 244, 76, 8, 9, 197, 55, 54, 103, 21, 34, 178, 245, 211,
    97, 58, 48, 7, 14, 121, 214, 109, 60, 64, 137, 170, 156, 79, 219,
]);
/** Trusted router program ID */
exports.TRUSTED_ROUTER_PROGRAM_ID = new web3_js_1.PublicKey("6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7");
/** Trusted verifier program ID */
exports.TRUSTED_VERIFIER_PROGRAM_ID = new web3_js_1.PublicKey("THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge");
/**
 * Build a 260-byte Borsh-encoded Risc0Seal with the trusted selector
 * and non-zero proof body. Valid for on-chain decode_and_validate_seal().
 */
function buildTestSealBytes() {
    const seal = Buffer.alloc(260);
    // Selector (4 bytes)
    ZK_TRUSTED_SELECTOR.copy(seal, 0);
    // Groth16 proof body (256 bytes): pi_a(64) + pi_b(128) + pi_c(64)
    // Fill with non-zero bytes to pass Borsh deserialization
    for (let i = 4; i < 260; i++) {
        seal[i] = ((i * 7 + 13) % 255) + 1; // non-zero pseudo-random fill
    }
    return seal;
}
/**
 * Build a 192-byte journal from 6 x 32-byte fields.
 * Field order: taskPda, authority, constraintHash, outputCommitment, binding, nullifier
 */
function buildTestJournal(fields) {
    return Buffer.concat([
        Buffer.from(fields.taskPda),
        Buffer.from(fields.authority),
        Buffer.from(fields.constraintHash),
        Buffer.from(fields.outputCommitment),
        Buffer.from(fields.binding),
        Buffer.from(fields.nullifier),
    ]);
}
/**
 * Derive a binding_spend PDA.
 * Seeds: ["binding_spend", bindingSeed]
 */
function deriveBindingSpendPda(bindingSeed, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("binding_spend"), Buffer.from(bindingSeed)], programId)[0];
}
/**
 * Derive a nullifier_spend PDA.
 * Seeds: ["nullifier_spend", nullifierSeed]
 */
function deriveNullifierSpendPda(nullifierSeed, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("nullifier_spend"), Buffer.from(nullifierSeed)], programId)[0];
}
/**
 * Derive the router PDA under the trusted router program.
 * Seeds: ["router"] under TRUSTED_RISC0_ROUTER_PROGRAM_ID
 */
function deriveRouterPda() {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("router")], exports.TRUSTED_ROUTER_PROGRAM_ID)[0];
}
/**
 * Derive the verifier-entry PDA under the trusted router program.
 * Seeds: ["verifier", selector] under TRUSTED_RISC0_ROUTER_PROGRAM_ID
 */
function deriveVerifierEntryPda() {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("verifier"), ZK_TRUSTED_SELECTOR], exports.TRUSTED_ROUTER_PROGRAM_ID)[0];
}
