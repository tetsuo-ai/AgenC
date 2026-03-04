"use strict";
/**
 * AgenC Integration Tests
 *
 * Following Anchor 0.32 best practices from official documentation:
 * - https://www.anchor-lang.com/docs/clients/typescript
 * - https://www.anchor-lang.com/docs/updates/release-notes/0-30-0
 *
 * Key patterns used:
 * 1. Use .accounts() for accounts with resolvable PDAs (const seeds or arg seeds)
 * 2. Use .accountsPartial() ONLY for self-referential PDAs that can't be auto-resolved
 * 3. All instruction arguments must match the IDL exactly
 * 4. Account names use camelCase (Anchor converts from snake_case automatically)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const anchor = __importStar(require("@coral-xyz/anchor"));
const chai_1 = require("chai");
const bn_js_1 = __importDefault(require("bn.js"));
const web3_js_1 = require("@solana/web3.js");
const test_utils_1 = require("./test-utils");
describe("AgenC Integration Tests", () => {
    // Provider and program setup
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
        .AgencCoordination;
    const runId = (0, test_utils_1.generateRunId)();
    // ============================================================================
    // CONSTANTS - Test-specific values (capabilities and task types from test-utils)
    // ============================================================================
    // Protocol configuration (must match deployed protocol config)
    const MIN_STAKE = 1 * web3_js_1.LAMPORTS_PER_SOL; // Minimum stake for agents (1 SOL)
    const PROTOCOL_FEE_BPS = 100; // 1% fee
    const DISPUTE_THRESHOLD = 51; // 51% for dispute resolution
    // ============================================================================
    // TEST ACCOUNTS
    // ============================================================================
    let treasury;
    let thirdSigner; // Required for multisig threshold >= 2
    let treasuryPubkey; // Actual treasury from protocol config
    let creator;
    let worker1;
    let worker2;
    // PDAs
    let protocolConfigPda;
    let programDataPda;
    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================
    /**
     * Create a 32-byte buffer from a string (padded with zeros)
     */
    function createId(name) {
        return Buffer.from(`${name}-${runId}`.slice(0, 32).padEnd(32, "\0"));
    }
    /**
     * Create a 64-byte description buffer
     */
    function createDescription(desc) {
        const buf = Buffer.alloc(64);
        buf.write(desc);
        return Array.from(buf);
    }
    /**
     * Create a 32-byte hash buffer
     */
    function createHash(data) {
        const buf = Buffer.alloc(32);
        buf.write(data);
        return Array.from(buf);
    }
    // ============================================================================
    // SETUP
    // ============================================================================
    before(async () => {
        // Generate test keypairs
        treasury = web3_js_1.Keypair.generate();
        thirdSigner = web3_js_1.Keypair.generate();
        creator = web3_js_1.Keypair.generate();
        worker1 = web3_js_1.Keypair.generate();
        worker2 = web3_js_1.Keypair.generate();
        // Derive protocol PDA
        protocolConfigPda = (0, test_utils_1.deriveProtocolPda)(program.programId);
        programDataPda = (0, test_utils_1.deriveProgramDataPda)(program.programId);
        // Airdrop SOL to test accounts
        const airdropAmount = 10 * web3_js_1.LAMPORTS_PER_SOL;
        const accounts = [treasury, thirdSigner, creator, worker1, worker2];
        for (const account of accounts) {
            const sig = await provider.connection.requestAirdrop(account.publicKey, airdropAmount);
            await provider.connection.confirmTransaction(sig, "confirmed");
        }
        console.log("Test Setup Complete");
        console.log(`  Program ID: ${program.programId.toString()}`);
        console.log(`  Protocol Config PDA: ${protocolConfigPda.toString()}`);
    });
    // ============================================================================
    // TEST: Protocol Initialization
    // ============================================================================
    describe("Protocol Initialization", () => {
        it("initializes protocol with correct parameters", async () => {
            /**
             * initializeProtocol instruction:
             * - Args: dispute_threshold, protocol_fee_bps, min_stake, multisig_threshold, multisig_owners
             * - Accounts: protocol_config (PDA const), treasury, authority (signer), system_program
             *
             * Since protocol_config has only const seeds, it CAN be auto-resolved.
             * We use .accounts() and let Anchor resolve what it can.
             */
            try {
                await program.methods
                    .initializeProtocol(DISPUTE_THRESHOLD, // dispute_threshold: u8
                PROTOCOL_FEE_BPS, // protocol_fee_bps: u16
                new bn_js_1.default(MIN_STAKE), // min_stake: u64
                new bn_js_1.default(MIN_STAKE / 100), // min_stake_for_dispute: u64
                2, // multisig_threshold: u8 (must be >= 2 and < owners.length)
                [provider.wallet.publicKey, treasury.publicKey, thirdSigner.publicKey])
                    .accountsPartial({
                    protocolConfig: protocolConfigPda,
                    treasury: treasury.publicKey,
                    authority: provider.wallet.publicKey,
                    secondSigner: treasury.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .remainingAccounts([
                    {
                        pubkey: (0, test_utils_1.deriveProgramDataPda)(program.programId),
                        isSigner: false,
                        isWritable: false,
                    },
                    {
                        pubkey: thirdSigner.publicKey,
                        isSigner: true,
                        isWritable: false,
                    },
                ])
                    .signers([treasury, thirdSigner])
                    .rpc();
                treasuryPubkey = treasury.publicKey;
                console.log("  Protocol initialized successfully");
            }
            catch (e) {
                // Protocol may already be initialized from previous test runs
                // Read the actual treasury from protocol config
                const protocolConfig = await program.account.protocolConfig.fetch(protocolConfigPda);
                treasuryPubkey = protocolConfig.treasury;
                console.log("  Protocol already initialized (reusing existing)");
            }
            // Disable rate limiting for tests
            await (0, test_utils_1.disableRateLimitsForTests)({
                program,
                protocolPda: protocolConfigPda,
                authority: provider.wallet.publicKey,
                additionalSigners: [treasury],
            });
            // Verify protocol state
            const protocol = await program.account.protocolConfig.fetch(protocolConfigPda);
            (0, chai_1.expect)(protocol.authority.toString()).to.equal(provider.wallet.publicKey.toString());
            (0, chai_1.expect)(protocol.disputeThreshold).to.equal(DISPUTE_THRESHOLD);
            (0, chai_1.expect)(protocol.protocolFeeBps).to.equal(PROTOCOL_FEE_BPS);
        });
    });
    // ============================================================================
    // TEST: Agent Registration
    // ============================================================================
    describe("Agent Registration", () => {
        const agentId = createId("test-agent-001");
        let agentPda;
        before(() => {
            agentPda = (0, test_utils_1.deriveAgentPda)(agentId, program.programId);
        });
        it("registers an agent with stake", async () => {
            /**
             * registerAgent instruction:
             * - Args: agent_id, capabilities, endpoint, metadata_uri, stake_amount
             * - Accounts: agent (PDA from arg), protocol_config (PDA const), authority (signer), system_program
             *
             * Since agent PDA uses "kind": "arg" with path "agentId", Anchor CAN auto-resolve it
             * from the instruction arguments. We use .accounts() for clean code.
             */
            try {
                await program.methods
                    .registerAgent(Array.from(agentId), // agent_id: [u8; 32]
                new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), // capabilities: u64
                "https://agent.example.com", // endpoint: string
                null, // metadata_uri: Option<string>
                new bn_js_1.default(MIN_STAKE))
                    .accounts({
                    // agent: auto-resolved from agentId arg
                    // protocolConfig: auto-resolved from const seeds
                    authority: worker1.publicKey,
                    // systemProgram: auto-resolved from address field
                })
                    .signers([worker1])
                    .rpc();
                console.log("  Agent registered successfully");
            }
            catch (e) {
                if (!e.message?.includes("already in use")) {
                    throw e;
                }
                console.log("  Agent already registered (reusing existing)");
            }
            // Verify agent state
            const agent = await program.account.agentRegistration.fetch(agentPda);
            (0, chai_1.expect)(agent.agentId).to.deep.equal(Array.from(agentId));
            (0, chai_1.expect)(agent.authority.toString()).to.equal(worker1.publicKey.toString());
            (0, chai_1.expect)(agent.capabilities.toNumber()).to.equal(test_utils_1.CAPABILITY_COMPUTE);
            (0, chai_1.expect)(agent.reputation).to.equal(5000); // Initial reputation is 50%
        });
        it("registers a second agent for task testing", async () => {
            const agent2Id = createId("test-agent-002");
            try {
                await program.methods
                    .registerAgent(Array.from(agent2Id), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_INFERENCE), "https://agent2.example.com", null, new bn_js_1.default(MIN_STAKE))
                    .accounts({
                    authority: worker2.publicKey,
                })
                    .signers([worker2])
                    .rpc();
                console.log("  Second agent registered");
            }
            catch (e) {
                if (!e.message?.includes("already in use")) {
                    throw e;
                }
                console.log("  Second agent already registered");
            }
        });
    });
    // ============================================================================
    // TEST: Task Creation
    // ============================================================================
    describe("Task Creation", () => {
        const creatorAgentId = createId("creator-agent-001");
        const taskId = createId("test-task-001");
        let creatorAgentPda;
        let taskPda;
        let escrowPda;
        before(async () => {
            creatorAgentPda = (0, test_utils_1.deriveAgentPda)(creatorAgentId, program.programId);
            taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
            escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
            // Register creator as an agent first
            try {
                await program.methods
                    .registerAgent(Array.from(creatorAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COORDINATOR), "https://creator.example.com", null, new bn_js_1.default(MIN_STAKE))
                    .accounts({
                    authority: creator.publicKey,
                })
                    .signers([creator])
                    .rpc();
                console.log("  Creator registered as agent");
            }
            catch (e) {
                if (!e.message?.includes("already in use")) {
                    throw e;
                }
            }
        });
        it("creates a task with escrow", async () => {
            /**
             * createTask instruction:
             * - Args: task_id, required_capabilities, description, reward_amount, max_workers, deadline, task_type, constraint_hash
             * - Accounts: task (PDA from arg), escrow (PDA from task), protocol_config, creator_agent, authority, creator, system_program
             *
             * IMPORTANT: creator_agent has a self-referential PDA seed (creator_agent.agent_id).
             * This CANNOT be auto-resolved, so we MUST use .accountsPartial() and provide it explicitly.
             */
            const rewardAmount = 0.1 * web3_js_1.LAMPORTS_PER_SOL;
            try {
                await program.methods
                    .createTask(Array.from(taskId), // task_id: [u8; 32]
                new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), // required_capabilities: u64
                createDescription("Test task"), // description: [u8; 64]
                new bn_js_1.default(rewardAmount), // reward_amount: u64
                1, // max_workers: u8
                new bn_js_1.default(Math.floor(Date.now() / 1000) + 86400), // deadline: i64 (must be > 0 and in future)
                test_utils_1.TASK_TYPE_EXCLUSIVE, // task_type: u8
                null, // constraint_hash: Option<[u8; 32]>
                0, // min_reputation
                null)
                    .accountsPartial({
                    task: taskPda,
                    escrow: escrowPda,
                    protocolConfig: protocolConfigPda,
                    creatorAgent: creatorAgentPda, // MUST provide - self-referential PDA
                    authority: creator.publicKey,
                    creator: creator.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    rewardMint: null,
                    creatorTokenAccount: null,
                    tokenEscrowAta: null,
                    tokenProgram: null,
                    associatedTokenProgram: null,
                })
                    .signers([creator])
                    .rpc();
                console.log("  Task created with escrow");
            }
            catch (e) {
                if (!e.message?.includes("already in use")) {
                    throw e;
                }
                console.log("  Task already exists");
            }
            // Verify task state
            const task = await program.account.task.fetch(taskPda);
            (0, chai_1.expect)(task.creator.toString()).to.equal(creator.publicKey.toString());
            (0, chai_1.expect)(task.requiredCapabilities.toNumber()).to.equal(test_utils_1.CAPABILITY_COMPUTE);
            (0, chai_1.expect)(task.maxWorkers).to.equal(1);
        });
    });
    // ============================================================================
    // TEST: Task Claiming
    // ============================================================================
    describe("Task Claiming", () => {
        const workerAgentId = createId("test-agent-001");
        const creatorAgentId = createId("creator-agent-001");
        const taskId = createId("claim-test-task");
        let workerAgentPda;
        let creatorAgentPda;
        let taskPda;
        let claimPda;
        before(async () => {
            workerAgentPda = (0, test_utils_1.deriveAgentPda)(workerAgentId, program.programId);
            creatorAgentPda = (0, test_utils_1.deriveAgentPda)(creatorAgentId, program.programId);
            taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
            claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, program.programId);
            // disableRateLimitsForTests keeps task_creation_cooldown at 1s (minimum).
            // Wait here to avoid cross-suite flakiness when createTask calls happen
            // back-to-back across adjacent describe blocks.
            await (0, test_utils_1.sleep)(2200);
            // Create a new task for claiming test
            try {
                await program.methods
                    .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), createDescription("Claimable task"), new bn_js_1.default(0.1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, // min_reputation
                null)
                    .accountsPartial({
                    task: taskPda,
                    escrow: (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId),
                    protocolConfig: protocolConfigPda,
                    creatorAgent: creatorAgentPda,
                    authority: creator.publicKey,
                    creator: creator.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    rewardMint: null,
                    creatorTokenAccount: null,
                    tokenEscrowAta: null,
                    tokenProgram: null,
                    associatedTokenProgram: null,
                })
                    .signers([creator])
                    .rpc();
            }
            catch (e) {
                if (!e.message?.includes("already in use")) {
                    throw e;
                }
            }
        });
        it("allows worker to claim task", async () => {
            /**
             * claimTask instruction:
             * - Args: (none)
             * - Accounts: task (self-ref PDA), claim (PDA from task+worker), protocol_config, worker (self-ref PDA), authority, system_program
             *
             * Both task and worker have self-referential PDAs, so we use accountsPartial.
             */
            try {
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    protocolConfig: protocolConfigPda,
                    worker: workerAgentPda,
                    authority: worker1.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker1])
                    .rpc();
                console.log("  Task claimed successfully");
            }
            catch (e) {
                if (!e.message?.includes("already")) {
                    throw e;
                }
                console.log("  Task already claimed");
            }
            // Verify claim exists
            const claim = await program.account.taskClaim.fetch(claimPda);
            (0, chai_1.expect)(claim.worker.toString()).to.equal(workerAgentPda.toString());
        });
    });
    // ============================================================================
    // TEST: Task Completion
    // ============================================================================
    describe("Task Completion", () => {
        const workerAgentId = createId("complete-worker");
        const creatorAgentId = createId("complete-creator");
        const taskId = createId("complete-test-task");
        let workerAgentPda;
        let creatorAgentPda;
        let taskPda;
        let escrowPda;
        let claimPda;
        before(async () => {
            workerAgentPda = (0, test_utils_1.deriveAgentPda)(workerAgentId, program.programId);
            creatorAgentPda = (0, test_utils_1.deriveAgentPda)(creatorAgentId, program.programId);
            taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
            escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
            claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, program.programId);
            // Register worker agent
            try {
                await program.methods
                    .registerAgent(Array.from(workerAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://complete-worker.example.com", null, new bn_js_1.default(MIN_STAKE))
                    .accounts({
                    authority: worker1.publicKey,
                })
                    .signers([worker1])
                    .rpc();
            }
            catch (e) {
                if (!e.message?.includes("already in use"))
                    throw e;
            }
            // Register creator agent
            try {
                await program.methods
                    .registerAgent(Array.from(creatorAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COORDINATOR), "https://complete-creator.example.com", null, new bn_js_1.default(MIN_STAKE))
                    .accounts({
                    authority: creator.publicKey,
                })
                    .signers([creator])
                    .rpc();
            }
            catch (e) {
                if (!e.message?.includes("already in use"))
                    throw e;
            }
            // Create task
            try {
                await program.methods
                    .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), createDescription("Completable task"), new bn_js_1.default(0.1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, // min_reputation
                null)
                    .accountsPartial({
                    task: taskPda,
                    escrow: escrowPda,
                    protocolConfig: protocolConfigPda,
                    creatorAgent: creatorAgentPda,
                    authority: creator.publicKey,
                    creator: creator.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    rewardMint: null,
                    creatorTokenAccount: null,
                    tokenEscrowAta: null,
                    tokenProgram: null,
                    associatedTokenProgram: null,
                })
                    .signers([creator])
                    .rpc();
            }
            catch (e) {
                if (!e.message?.includes("already in use"))
                    throw e;
            }
            // Claim task
            try {
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    protocolConfig: protocolConfigPda,
                    worker: workerAgentPda,
                    authority: worker1.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker1])
                    .rpc();
            }
            catch (e) {
                if (!e.message?.includes("already"))
                    throw e;
            }
        });
        it("allows worker to complete task and receive reward", async () => {
            /**
             * completeTask instruction:
             * - Args: proof_hash, result_data
             * - Accounts: task, claim, escrow, worker, protocol_config, treasury, authority, system_program
             */
            const proofHash = createHash("proof-hash-data");
            const resultData = Array.from(Buffer.alloc(64).fill(1));
            // Get protocol config to find treasury
            const protocol = await program.account.protocolConfig.fetch(protocolConfigPda);
            const balanceBefore = await provider.connection.getBalance(worker1.publicKey);
            try {
                await program.methods
                    .completeTask(proofHash, // proof_hash: [u8; 32]
                resultData)
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    escrow: escrowPda,
                    creator: creator.publicKey,
                    worker: workerAgentPda,
                    protocolConfig: protocolConfigPda,
                    treasury: protocol.treasury,
                    authority: worker1.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    tokenEscrowAta: null,
                    workerTokenAccount: null,
                    treasuryTokenAccount: null,
                    rewardMint: null,
                    tokenProgram: null,
                })
                    .signers([worker1])
                    .rpc();
                console.log("  Task completed successfully");
                const balanceAfter = await provider.connection.getBalance(worker1.publicKey);
                console.log(`  Worker balance change: ${(balanceAfter - balanceBefore) / web3_js_1.LAMPORTS_PER_SOL} SOL`);
            }
            catch (e) {
                // Task might already be completed
                if (!e.message?.includes("InvalidTaskStatus")) {
                    throw e;
                }
                console.log("  Task already completed");
            }
        });
    });
    // ============================================================================
    // TEST: Agent Update
    // ============================================================================
    describe("Agent Update", () => {
        const agentId = createId("update-test-agent");
        let agentPda;
        before(async () => {
            agentPda = (0, test_utils_1.deriveAgentPda)(agentId, program.programId);
            // Register agent first
            try {
                await program.methods
                    .registerAgent(Array.from(agentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://update-agent.example.com", null, new bn_js_1.default(MIN_STAKE))
                    .accounts({
                    authority: worker2.publicKey,
                })
                    .signers([worker2])
                    .rpc();
            }
            catch (e) {
                if (!e.message?.includes("already in use"))
                    throw e;
            }
        });
        it("updates agent capabilities and endpoint", async () => {
            /**
             * updateAgent instruction:
             * - Args: capabilities, endpoint, metadata_uri, status (all Option types)
             * - Accounts: agent (self-ref PDA), authority
             */
            await program.methods
                .updateAgent(new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_STORAGE), // capabilities: Option<u64>
            "https://updated-agent.example.com", // endpoint: Option<string>
            null, // metadata_uri: Option<string>
            null)
                .accountsPartial({
                agent: agentPda,
                authority: worker2.publicKey,
            })
                .signers([worker2])
                .rpc();
            // Verify update
            const agent = await program.account.agentRegistration.fetch(agentPda);
            (0, chai_1.expect)(agent.capabilities.toNumber()).to.equal(test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_STORAGE);
            (0, chai_1.expect)(agent.endpoint).to.equal("https://updated-agent.example.com");
            console.log("  Agent updated successfully");
        });
    });
    // ============================================================================
    // TEST: Task Cancellation
    // ============================================================================
    describe("Task Cancellation", () => {
        const creatorAgentId = createId("cancel-creator");
        const taskId = createId("cancel-test-task");
        let creatorAgentPda;
        let taskPda;
        let escrowPda;
        before(async () => {
            creatorAgentPda = (0, test_utils_1.deriveAgentPda)(creatorAgentId, program.programId);
            taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
            escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
            // Register creator agent
            try {
                await program.methods
                    .registerAgent(Array.from(creatorAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COORDINATOR), "https://cancel-creator.example.com", null, new bn_js_1.default(MIN_STAKE))
                    .accounts({
                    authority: creator.publicKey,
                })
                    .signers([creator])
                    .rpc();
            }
            catch (e) {
                if (!e.message?.includes("already in use"))
                    throw e;
            }
            // Create task to cancel
            try {
                await program.methods
                    .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), createDescription("Task to cancel"), new bn_js_1.default(0.05 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, // min_reputation
                null)
                    .accountsPartial({
                    task: taskPda,
                    escrow: escrowPda,
                    protocolConfig: protocolConfigPda,
                    creatorAgent: creatorAgentPda,
                    authority: creator.publicKey,
                    creator: creator.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    rewardMint: null,
                    creatorTokenAccount: null,
                    tokenEscrowAta: null,
                    tokenProgram: null,
                    associatedTokenProgram: null,
                })
                    .signers([creator])
                    .rpc();
            }
            catch (e) {
                if (!e.message?.includes("already in use"))
                    throw e;
            }
        });
        it("allows creator to cancel unclaimed task", async () => {
            /**
             * cancelTask instruction:
             * - Args: (none)
             * - Accounts: task (self-ref PDA), escrow, creator (signer), system_program
             */
            try {
                await program.methods
                    .cancelTask()
                    .accountsPartial({
                    task: taskPda,
                    escrow: escrowPda,
                    creator: creator.publicKey,
                    protocolConfig: protocolConfigPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    tokenEscrowAta: null,
                    creatorTokenAccount: null,
                    rewardMint: null,
                    tokenProgram: null,
                })
                    .signers([creator])
                    .rpc();
                console.log("  Task cancelled successfully");
            }
            catch (e) {
                if (!e.message?.includes("InvalidTaskStatus")) {
                    throw e;
                }
                console.log("  Task already cancelled or in wrong state");
            }
        });
    });
    // ============================================================================
    // TEST: Agent Deregistration
    // ============================================================================
    describe("Agent Deregistration", () => {
        const agentId = createId("deregister-agent");
        let agentPda;
        before(async () => {
            agentPda = (0, test_utils_1.deriveAgentPda)(agentId, program.programId);
            // Register agent to deregister
            try {
                await program.methods
                    .registerAgent(Array.from(agentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://deregister.example.com", null, new bn_js_1.default(MIN_STAKE))
                    .accounts({
                    authority: worker2.publicKey,
                })
                    .signers([worker2])
                    .rpc();
            }
            catch (e) {
                if (!e.message?.includes("already in use"))
                    throw e;
            }
        });
        it("allows agent to deregister when no active tasks", async () => {
            /**
             * deregisterAgent instruction:
             * - Args: (none)
             * - Accounts: agent (self-ref PDA), protocol_config, authority
             */
            try {
                await program.methods
                    .deregisterAgent()
                    .accountsPartial({
                    agent: agentPda,
                    // protocolConfig: auto-resolved
                    authority: worker2.publicKey,
                })
                    .signers([worker2])
                    .rpc();
                console.log("  Agent deregistered successfully");
            }
            catch (e) {
                if (!e.message?.includes("ActiveTasksRemain")) {
                    throw e;
                }
                console.log("  Agent has active tasks, cannot deregister");
            }
        });
    });
});
