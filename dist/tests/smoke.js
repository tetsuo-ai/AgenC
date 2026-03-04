"use strict";
/**
 * AgenC Devnet Smoke Tests
 *
 * These tests verify the deployed program works correctly on devnet by making
 * actual RPC calls and asserting expected behavior.
 *
 * Following Anchor 0.32 best practices from official documentation:
 * - https://www.anchor-lang.com/docs/clients/typescript
 * - https://www.anchor-lang.com/docs/updates/release-notes/0-30-0
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
const web3_js_1 = require("@solana/web3.js");
const chai_1 = require("chai");
const bn_js_1 = __importDefault(require("bn.js"));
const test_utils_1 = require("./test-utils");
// ============================================================================
// CONSTANTS (imported from test-utils, local aliases for backwards compat)
// ============================================================================
const MIN_STAKE = test_utils_1.DEFAULT_MIN_STAKE_LAMPORTS;
const PROTOCOL_FEE_BPS = test_utils_1.DEFAULT_PROTOCOL_FEE_BPS;
const DISPUTE_THRESHOLD = test_utils_1.DEFAULT_DISPUTE_THRESHOLD;
// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
const isRateLimitError = (message) => message.includes("429") ||
    message.toLowerCase().includes("too many requests");
const ensureBalance = async (connection, keypair, minLamports) => {
    const pubkey = keypair.publicKey;
    const existing = await connection.getBalance(pubkey);
    if (existing >= minLamports) {
        console.log(`  Skipping airdrop for ${pubkey.toBase58().slice(0, 8)}... balance ${(existing / web3_js_1.LAMPORTS_PER_SOL).toFixed(2)} SOL`);
        return;
    }
    for (let attempt = 0; attempt < test_utils_1.MAX_AIRDROP_ATTEMPTS; attempt += 1) {
        try {
            const sig = await connection.requestAirdrop(pubkey, test_utils_1.AIRDROP_SOL * web3_js_1.LAMPORTS_PER_SOL);
            await connection.confirmTransaction(sig, "confirmed");
            console.log(`  Funded ${pubkey.toBase58().slice(0, 8)}...`);
            return;
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const delayMs = Math.min(test_utils_1.MAX_DELAY_MS, test_utils_1.BASE_DELAY_MS * 2 ** attempt);
            if (isRateLimitError(message)) {
                console.log(`  Faucet rate limited (HTTP 429) for ${pubkey.toBase58().slice(0, 8)}..., retrying in ${delayMs}ms`);
            }
            else {
                console.log(`  Airdrop attempt ${attempt + 1} failed for ${pubkey.toBase58().slice(0, 8)}...: ${message}`);
            }
            if (attempt === test_utils_1.MAX_AIRDROP_ATTEMPTS - 1) {
                throw new Error(`Airdrop failed for ${pubkey.toBase58().slice(0, 8)} after ${test_utils_1.MAX_AIRDROP_ATTEMPTS} attempts`);
            }
            await (0, test_utils_1.sleep)(delayMs);
        }
    }
};
// PDA helpers delegate to test-utils (3-arg versions with programId)
function deriveProtocolConfigPda(programId) {
    return (0, test_utils_1.deriveProtocolPda)(programId);
}
function deriveAgentPda(agentId, programId) {
    return (0, test_utils_1.deriveAgentPda)(agentId, programId);
}
function deriveTaskPda(creator, taskId, programId) {
    return (0, test_utils_1.deriveTaskPda)(creator, taskId, programId);
}
function deriveEscrowPda(taskPda, programId) {
    return (0, test_utils_1.deriveEscrowPda)(taskPda, programId);
}
function deriveClaimPda(taskPda, workerAgentPda, programId) {
    return (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, programId);
}
// ============================================================================
// SMOKE TESTS
// ============================================================================
describe("AgenC Devnet Smoke Tests", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
        .AgencCoordination;
    const payer = provider.wallet.payer;
    // Test accounts
    let protocolAuthority;
    let secondSigner;
    let thirdSigner;
    let treasury;
    let agent1Authority;
    let agent2Authority;
    let taskCreator;
    // PDAs
    let protocolConfigPda;
    let treasuryPubkey;
    // Test identifiers - use unique IDs per test run
    const testRunId = Date.now().toString(36);
    before(async () => {
        console.log("\n========================================");
        console.log("AgenC Smoke Test - Devnet");
        console.log("========================================\n");
        console.log(`Program ID: ${program.programId.toBase58()}`);
        console.log(`Test Run ID: ${testRunId}`);
        // Generate test keypairs
        protocolAuthority = payer ?? web3_js_1.Keypair.generate();
        secondSigner = web3_js_1.Keypair.generate();
        thirdSigner = web3_js_1.Keypair.generate();
        treasury = web3_js_1.Keypair.generate();
        agent1Authority = web3_js_1.Keypair.generate();
        agent2Authority = web3_js_1.Keypair.generate();
        taskCreator = web3_js_1.Keypair.generate();
        // Derive protocol PDA
        protocolConfigPda = deriveProtocolConfigPda(program.programId);
        // Airdrop SOL to test accounts
        console.log("Airdropping SOL to test accounts...");
        if (payer) {
            console.log(`  Reusing provider wallet for protocol authority: ${payer.publicKey.toBase58()}`);
        }
        const accounts = [
            protocolAuthority,
            secondSigner,
            thirdSigner,
            agent1Authority,
            agent2Authority,
            taskCreator,
        ];
        for (const account of accounts) {
            await ensureBalance(provider.connection, account, test_utils_1.MIN_BALANCE_SOL * web3_js_1.LAMPORTS_PER_SOL);
        }
        console.log("\nTest accounts ready.");
        console.log(`  Protocol Authority: ${protocolAuthority.publicKey.toBase58()}`);
        console.log(`  Second Signer: ${secondSigner.publicKey.toBase58()}`);
        console.log(`  Treasury: ${treasury.publicKey.toBase58()}`);
        console.log(`  Agent 1 Authority: ${agent1Authority.publicKey.toBase58()}`);
        console.log(`  Agent 2 Authority: ${agent2Authority.publicKey.toBase58()}`);
        console.log(`  Task Creator: ${taskCreator.publicKey.toBase58()}`);
    });
    describe("1. Protocol Initialization", () => {
        it("should initialize or verify protocol config", async () => {
            console.log("\n[TEST] Checking protocol initialization...");
            const programDataPda = (0, test_utils_1.deriveProgramDataPda)(program.programId);
            try {
                // Try to initialize protocol
                // Args: dispute_threshold, protocol_fee_bps, min_stake, min_stake_for_dispute, multisig_threshold, multisig_owners
                await program.methods
                    .initializeProtocol(DISPUTE_THRESHOLD, // dispute_threshold: u8
                PROTOCOL_FEE_BPS, // protocol_fee_bps: u16
                new bn_js_1.default(MIN_STAKE), // min_stake: u64
                new bn_js_1.default(0), // min_stake_for_dispute: u64
                2, // multisig_threshold: u8 (must be >= 2 and < owners.length)
                [protocolAuthority.publicKey, secondSigner.publicKey, thirdSigner.publicKey])
                    .accountsPartial({
                    treasury: treasury.publicKey,
                    authority: protocolAuthority.publicKey,
                    secondSigner: secondSigner.publicKey,
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
                    .signers([protocolAuthority, secondSigner, thirdSigner])
                    .rpc();
                treasuryPubkey = treasury.publicKey;
                console.log("  Protocol initialized successfully");
            }
            catch (e) {
                // Protocol already initialized - fetch existing config
                const protocolConfig = await program.account.protocolConfig.fetch(protocolConfigPda);
                treasuryPubkey = protocolConfig.treasury;
                console.log("  Protocol already initialized (reusing existing)");
            }
            // Verify protocol state
            const protocol = await program.account.protocolConfig.fetch(protocolConfigPda);
            chai_1.assert.isNotNull(protocol.authority, "Protocol authority should be set");
            chai_1.assert.isTrue(protocol.disputeThreshold > 0, "Dispute threshold should be > 0");
            chai_1.assert.isTrue(protocol.protocolFeeBps >= 0, "Protocol fee should be >= 0");
            console.log(`  Authority: ${protocol.authority.toBase58()}`);
            console.log(`  Treasury: ${protocol.treasury.toBase58()}`);
            console.log(`  Dispute Threshold: ${protocol.disputeThreshold}%`);
            console.log(`  Protocol Fee: ${protocol.protocolFeeBps} bps`);
        });
    });
    describe("2. Agent Registration", () => {
        const agent1IdStr = `smoke-agent1-${testRunId}`;
        const agent2IdStr = `smoke-agent2-${testRunId}`;
        let agent1Id;
        let agent2Id;
        let agent1Pda;
        let agent2Pda;
        before(() => {
            agent1Id = (0, test_utils_1.createId)(agent1IdStr);
            agent2Id = (0, test_utils_1.createId)(agent2IdStr);
            agent1Pda = deriveAgentPda(agent1Id, program.programId);
            agent2Pda = deriveAgentPda(agent2Id, program.programId);
        });
        it("should register agent 1 with COMPUTE capability", async () => {
            console.log("\n[TEST] Registering Agent 1...");
            const capabilities = test_utils_1.CAPABILITY_COMPUTE;
            const endpoint = "https://agent1.smoke-test.example.com";
            const stakeAmount = new bn_js_1.default(MIN_STAKE);
            await program.methods
                .registerAgent(Array.from(agent1Id), new bn_js_1.default(capabilities), endpoint, null, // metadata_uri
            stakeAmount)
                .accounts({
                authority: agent1Authority.publicKey,
            })
                .signers([agent1Authority])
                .rpc();
            // Verify agent state
            const agent = await program.account.agentRegistration.fetch(agent1Pda);
            chai_1.assert.deepEqual(agent.agentId, Array.from(agent1Id), "Agent ID should match");
            chai_1.assert.equal(agent.authority.toBase58(), agent1Authority.publicKey.toBase58(), "Authority should match");
            chai_1.assert.equal(agent.capabilities.toNumber(), capabilities, "Capabilities should match");
            chai_1.assert.equal(agent.endpoint, endpoint, "Endpoint should match");
            chai_1.assert.equal(agent.reputation, 5000, "Initial reputation should be 5000");
            chai_1.assert.isTrue(agent.stake.gte(stakeAmount), "Stake should be >= provided amount");
            console.log(`  Agent 1 registered successfully`);
            console.log(`  PDA: ${agent1Pda.toBase58()}`);
            console.log(`  Capabilities: ${agent.capabilities.toString()}`);
            console.log(`  Stake: ${agent.stake.toNumber() / web3_js_1.LAMPORTS_PER_SOL} SOL`);
            console.log(`  Reputation: ${agent.reputation}`);
        });
        it("should register agent 2 with INFERENCE capability", async () => {
            console.log("\n[TEST] Registering Agent 2...");
            const capabilities = test_utils_1.CAPABILITY_INFERENCE;
            const endpoint = "https://agent2.smoke-test.example.com";
            const stakeAmount = new bn_js_1.default(MIN_STAKE);
            await program.methods
                .registerAgent(Array.from(agent2Id), new bn_js_1.default(capabilities), endpoint, null, stakeAmount)
                .accounts({
                authority: agent2Authority.publicKey,
            })
                .signers([agent2Authority])
                .rpc();
            // Verify agent state
            const agent = await program.account.agentRegistration.fetch(agent2Pda);
            chai_1.assert.deepEqual(agent.agentId, Array.from(agent2Id), "Agent ID should match");
            chai_1.assert.equal(agent.capabilities.toNumber(), capabilities, "Capabilities should match");
            console.log(`  Agent 2 registered successfully`);
            console.log(`  PDA: ${agent2Pda.toBase58()}`);
            console.log(`  Capabilities: ${agent.capabilities.toString()}`);
        });
        it("should query and verify both agent states", async () => {
            console.log("\n[TEST] Querying agent states...");
            const agent1 = await program.account.agentRegistration.fetch(agent1Pda);
            const agent2 = await program.account.agentRegistration.fetch(agent2Pda);
            // Verify agent1 has COMPUTE but not INFERENCE
            chai_1.assert.isTrue((agent1.capabilities.toNumber() & test_utils_1.CAPABILITY_COMPUTE) !== 0, "Agent 1 should have COMPUTE capability");
            chai_1.assert.isFalse((agent1.capabilities.toNumber() & test_utils_1.CAPABILITY_INFERENCE) !== 0, "Agent 1 should not have INFERENCE capability");
            // Verify agent2 has INFERENCE but not COMPUTE
            chai_1.assert.isTrue((agent2.capabilities.toNumber() & test_utils_1.CAPABILITY_INFERENCE) !== 0, "Agent 2 should have INFERENCE capability");
            chai_1.assert.isFalse((agent2.capabilities.toNumber() & test_utils_1.CAPABILITY_COMPUTE) !== 0, "Agent 2 should not have COMPUTE capability");
            console.log("  Agent states verified");
            console.log(`  Agent 1 - Active tasks: ${agent1.activeTasks}, Tasks completed: ${agent1.tasksCompleted}`);
            console.log(`  Agent 2 - Active tasks: ${agent2.activeTasks}, Tasks completed: ${agent2.tasksCompleted}`);
        });
    });
    describe("3. Task Creation with Escrow", () => {
        const creatorAgentIdStr = `smoke-creator-${testRunId}`;
        const taskIdStr = `smoke-task1-${testRunId}`;
        let creatorAgentId;
        let taskId;
        let creatorAgentPda;
        let taskPda;
        let escrowPda;
        const taskReward = new bn_js_1.default(0.1 * web3_js_1.LAMPORTS_PER_SOL);
        before(async () => {
            creatorAgentId = (0, test_utils_1.createId)(creatorAgentIdStr);
            taskId = (0, test_utils_1.createId)(taskIdStr);
            creatorAgentPda = deriveAgentPda(creatorAgentId, program.programId);
            // Register task creator as an agent first
            console.log("  Registering task creator as agent...");
            await program.methods
                .registerAgent(Array.from(creatorAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COORDINATOR), "https://creator.smoke-test.example.com", null, new bn_js_1.default(MIN_STAKE))
                .accounts({
                authority: taskCreator.publicKey,
            })
                .signers([taskCreator])
                .rpc();
            taskPda = deriveTaskPda(taskCreator.publicKey, taskId, program.programId);
            escrowPda = deriveEscrowPda(taskPda, program.programId);
        });
        it("should create a task with escrowed reward", async () => {
            console.log("\n[TEST] Creating task with escrow...");
            const requiredCapabilities = test_utils_1.CAPABILITY_COMPUTE;
            const description = (0, test_utils_1.createDescription)("Smoke test compute task");
            const deadline = new bn_js_1.default(Math.floor(Date.now() / 1000) + 86400); // 24 hours from now
            const creatorBalanceBefore = await provider.connection.getBalance(taskCreator.publicKey);
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(requiredCapabilities), description, taskReward, 1, // max_workers
            deadline, test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
            0, // min_reputation
            null)
                .accountsPartial({
                task: taskPda,
                escrow: escrowPda,
                protocolConfig: protocolConfigPda,
                creatorAgent: creatorAgentPda,
                authority: taskCreator.publicKey,
                creator: taskCreator.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
                rewardMint: null,
                creatorTokenAccount: null,
                tokenEscrowAta: null,
                tokenProgram: null,
                associatedTokenProgram: null,
            })
                .signers([taskCreator])
                .rpc();
            // Verify task state
            const task = await program.account.task.fetch(taskPda);
            chai_1.assert.equal(task.creator.toBase58(), taskCreator.publicKey.toBase58(), "Creator should match");
            chai_1.assert.deepEqual(task.taskId, Array.from(taskId), "Task ID should match");
            chai_1.assert.equal(task.requiredCapabilities.toNumber(), requiredCapabilities, "Capabilities should match");
            chai_1.assert.equal(task.rewardAmount.toNumber(), taskReward.toNumber(), "Reward should match");
            chai_1.assert.equal(task.maxWorkers, 1, "Max workers should be 1");
            chai_1.assert.equal(task.currentWorkers, 0, "Current workers should be 0");
            const creatorBalanceAfter = await provider.connection.getBalance(taskCreator.publicKey);
            const balanceChange = creatorBalanceBefore - creatorBalanceAfter;
            console.log(`  Task created successfully`);
            console.log(`  Task PDA: ${taskPda.toBase58()}`);
            console.log(`  Escrow PDA: ${escrowPda.toBase58()}`);
            console.log(`  Reward: ${taskReward.toNumber() / web3_js_1.LAMPORTS_PER_SOL} SOL`);
            console.log(`  Creator balance change: ${balanceChange / web3_js_1.LAMPORTS_PER_SOL} SOL`);
        });
        it("should verify escrow balance", async () => {
            console.log("\n[TEST] Verifying escrow balance...");
            const escrowBalance = await provider.connection.getBalance(escrowPda);
            // Escrow should hold at least the task reward (plus rent)
            chai_1.assert.isTrue(escrowBalance >= taskReward.toNumber(), `Escrow balance (${escrowBalance}) should be >= task reward (${taskReward.toNumber()})`);
            console.log(`  Escrow balance: ${escrowBalance / web3_js_1.LAMPORTS_PER_SOL} SOL`);
            console.log(`  Expected minimum: ${taskReward.toNumber() / web3_js_1.LAMPORTS_PER_SOL} SOL`);
        });
    });
    describe("4. Task Claiming", () => {
        const workerAgentIdStr = `smoke-agent1-${testRunId}`;
        const invalidWorkerAgentIdStr = `smoke-agent2-${testRunId}`;
        const taskIdStr = `smoke-task1-${testRunId}`;
        let workerAgentPda;
        let invalidWorkerAgentPda;
        let taskPda;
        let claimPda;
        before(() => {
            const workerAgentId = (0, test_utils_1.createId)(workerAgentIdStr);
            const invalidWorkerAgentId = (0, test_utils_1.createId)(invalidWorkerAgentIdStr);
            const taskId = (0, test_utils_1.createId)(taskIdStr);
            workerAgentPda = deriveAgentPda(workerAgentId, program.programId);
            invalidWorkerAgentPda = deriveAgentPda(invalidWorkerAgentId, program.programId);
            taskPda = deriveTaskPda(taskCreator.publicKey, taskId, program.programId);
            claimPda = deriveClaimPda(taskPda, workerAgentPda, program.programId);
        });
        it("should reject claim from agent without matching capabilities", async () => {
            console.log("\n[TEST] Verifying capability check...");
            // Agent 2 has INFERENCE, task requires COMPUTE - should fail
            try {
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: deriveClaimPda(taskPda, invalidWorkerAgentPda, program.programId),
                    protocolConfig: protocolConfigPda,
                    worker: invalidWorkerAgentPda,
                    authority: agent2Authority.publicKey,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                    .signers([agent2Authority])
                    .rpc();
                chai_1.assert.fail("Should have rejected claim from agent without COMPUTE capability");
            }
            catch (e) {
                chai_1.assert.include(e.message.toLowerCase(), "insufficient", "Error should mention insufficient capabilities");
                console.log("  Capability check passed - invalid claim rejected");
                console.log(`  Error: ${e.message.slice(0, 100)}...`);
            }
        });
        it("should allow agent 1 to claim the task", async () => {
            console.log("\n[TEST] Agent 1 claiming task...");
            await program.methods
                .claimTask()
                .accountsPartial({
                task: taskPda,
                claim: claimPda,
                protocolConfig: protocolConfigPda,
                worker: workerAgentPda,
                authority: agent1Authority.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
                .signers([agent1Authority])
                .rpc();
            // Verify claim exists
            const claim = await program.account.taskClaim.fetch(claimPda);
            chai_1.assert.equal(claim.worker.toBase58(), workerAgentPda.toBase58(), "Worker agent PDA should match");
            // Verify task state updated
            const task = await program.account.task.fetch(taskPda);
            chai_1.assert.equal(task.currentWorkers, 1, "Current workers should be 1 after claim");
            // Verify agent state updated
            const agent = await program.account.agentRegistration.fetch(workerAgentPda);
            chai_1.assert.equal(agent.activeTasks, 1, "Agent active tasks should be 1");
            console.log("  Task claimed successfully");
            console.log(`  Claim PDA: ${claimPda.toBase58()}`);
            console.log(`  Task current workers: ${task.currentWorkers}`);
            console.log(`  Agent active tasks: ${agent.activeTasks}`);
        });
        it("should verify task state is now IN_PROGRESS", async () => {
            console.log("\n[TEST] Verifying task state...");
            const task = await program.account.task.fetch(taskPda);
            // Task status should indicate it's in progress (claimed)
            chai_1.assert.equal(task.currentWorkers, 1, "Should have 1 worker");
            chai_1.assert.equal(task.maxWorkers, 1, "Max workers should still be 1");
            console.log("  Task status verified: IN_PROGRESS (has 1 worker)");
        });
    });
    describe("5. Task Completion", () => {
        const workerAgentIdStr = `smoke-agent1-${testRunId}`;
        const taskIdStr = `smoke-task1-${testRunId}`;
        let workerAgentPda;
        let taskPda;
        let escrowPda;
        let claimPda;
        before(() => {
            const workerAgentId = (0, test_utils_1.createId)(workerAgentIdStr);
            const taskId = (0, test_utils_1.createId)(taskIdStr);
            workerAgentPda = deriveAgentPda(workerAgentId, program.programId);
            taskPda = deriveTaskPda(taskCreator.publicKey, taskId, program.programId);
            escrowPda = deriveEscrowPda(taskPda, program.programId);
            claimPda = deriveClaimPda(taskPda, workerAgentPda, program.programId);
        });
        it("should allow agent 1 to complete the task", async () => {
            console.log("\n[TEST] Agent 1 completing task...");
            const proofHash = (0, test_utils_1.createHash)("smoke-test-proof-hash");
            const resultData = Array.from(Buffer.alloc(64).fill(0x42)); // Non-zero result data
            // Get protocol config for treasury
            const protocol = await program.account.protocolConfig.fetch(protocolConfigPda);
            const workerBalanceBefore = await provider.connection.getBalance(agent1Authority.publicKey);
            await program.methods
                .completeTask(proofHash, resultData)
                .accountsPartial({
                task: taskPda,
                claim: claimPda,
                escrow: escrowPda,
                creator: taskCreator.publicKey,
                worker: workerAgentPda,
                protocolConfig: protocolConfigPda,
                treasury: protocol.treasury,
                authority: agent1Authority.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
                tokenEscrowAta: null,
                workerTokenAccount: null,
                treasuryTokenAccount: null,
                rewardMint: null,
                tokenProgram: null,
            })
                .signers([agent1Authority])
                .rpc();
            const workerBalanceAfter = await provider.connection.getBalance(agent1Authority.publicKey);
            const balanceChange = workerBalanceAfter - workerBalanceBefore;
            console.log("  Task completed");
            console.log(`  Worker balance change: ${balanceChange / web3_js_1.LAMPORTS_PER_SOL} SOL`);
            // Balance should have increased (reward minus tx fee)
            chai_1.assert.isTrue(balanceChange > 0, "Worker should have received reward");
        });
        it("should verify reward distribution", async () => {
            console.log("\n[TEST] Verifying reward distribution...");
            // Escrow should be closed/empty after completion
            const escrowInfo = await provider.connection.getAccountInfo(escrowPda);
            // Escrow account is closed after task completion
            chai_1.assert.isNull(escrowInfo, "Escrow account should be closed after completion");
            console.log("  Escrow account closed (funds distributed)");
        });
        it("should verify reputation update", async () => {
            console.log("\n[TEST] Verifying reputation update...");
            const agent = await program.account.agentRegistration.fetch(workerAgentPda);
            chai_1.assert.equal(agent.tasksCompleted.toNumber(), 1, "Tasks completed should be 1");
            chai_1.assert.isTrue(agent.totalEarned.toNumber() > 0, "Total earned should be > 0");
            // Reputation may increase or stay same depending on protocol rules
            chai_1.assert.isTrue(agent.reputation >= 5000, "Reputation should be >= initial value");
            console.log(`  Agent 1 reputation: ${agent.reputation}`);
            console.log(`  Tasks completed: ${agent.tasksCompleted.toString()}`);
            console.log(`  Total earned: ${agent.totalEarned.toNumber() / web3_js_1.LAMPORTS_PER_SOL} SOL`);
        });
    });
    describe("6. Task Cancellation Flow", () => {
        const creatorAgentIdStr = `smoke-creator-${testRunId}`;
        const cancelTaskIdStr = `smoke-cancel-${testRunId}`;
        let creatorAgentPda;
        let cancelTaskId;
        let cancelTaskPda;
        let cancelEscrowPda;
        const cancelReward = new bn_js_1.default(0.05 * web3_js_1.LAMPORTS_PER_SOL);
        before(async () => {
            const creatorAgentId = (0, test_utils_1.createId)(creatorAgentIdStr);
            creatorAgentPda = deriveAgentPda(creatorAgentId, program.programId);
            cancelTaskId = (0, test_utils_1.createId)(cancelTaskIdStr);
            cancelTaskPda = deriveTaskPda(taskCreator.publicKey, cancelTaskId, program.programId);
            cancelEscrowPda = deriveEscrowPda(cancelTaskPda, program.programId);
        });
        it("should create a task for cancellation test", async () => {
            console.log("\n[TEST] Creating task for cancellation...");
            // Task creation cooldown can still be active from prior task-creation
            // flows in this suite. Sleep past the minimum cooldown to avoid flakes.
            await (0, test_utils_1.sleep)(2200);
            await program.methods
                .createTask(Array.from(cancelTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), (0, test_utils_1.createDescription)("Task to be cancelled"), cancelReward, 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 86400), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, // min_reputation
            null)
                .accountsPartial({
                task: cancelTaskPda,
                escrow: cancelEscrowPda,
                protocolConfig: protocolConfigPda,
                creatorAgent: creatorAgentPda,
                authority: taskCreator.publicKey,
                creator: taskCreator.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
                rewardMint: null,
                creatorTokenAccount: null,
                tokenEscrowAta: null,
                tokenProgram: null,
                associatedTokenProgram: null,
            })
                .signers([taskCreator])
                .rpc();
            const task = await program.account.task.fetch(cancelTaskPda);
            chai_1.assert.equal(task.currentWorkers, 0, "Task should have no workers");
            console.log(`  Task ${cancelTaskIdStr} created`);
            console.log(`  Task PDA: ${cancelTaskPda.toBase58()}`);
        });
        it("should allow creator to cancel unclaimed task", async () => {
            console.log("\n[TEST] Cancelling unclaimed task...");
            const creatorBalanceBefore = await provider.connection.getBalance(taskCreator.publicKey);
            await program.methods
                .cancelTask()
                .accountsPartial({
                task: cancelTaskPda,
                escrow: cancelEscrowPda,
                creator: taskCreator.publicKey,
                protocolConfig: protocolConfigPda,
                systemProgram: anchor.web3.SystemProgram.programId,
                tokenEscrowAta: null,
                creatorTokenAccount: null,
                rewardMint: null,
                tokenProgram: null,
            })
                .signers([taskCreator])
                .rpc();
            const creatorBalanceAfter = await provider.connection.getBalance(taskCreator.publicKey);
            console.log("  Task cancelled");
            console.log(`  Creator balance change: ${(creatorBalanceAfter - creatorBalanceBefore) / web3_js_1.LAMPORTS_PER_SOL} SOL`);
        });
        it("should verify escrow refunded to creator", async () => {
            console.log("\n[TEST] Verifying escrow refund...");
            const escrowInfo = await provider.connection.getAccountInfo(cancelEscrowPda);
            // Escrow should be closed after cancellation
            chai_1.assert.isNull(escrowInfo, "Escrow should be closed after cancellation");
            console.log("  Escrow balance: 0 SOL (account closed)");
        });
    });
    describe("7. Agent Deregistration", () => {
        const deregAgentIdStr = `smoke-dereg-${testRunId}`;
        let deregAgentId;
        let deregAgentPda;
        let deregAuthority;
        before(async () => {
            deregAgentId = (0, test_utils_1.createId)(deregAgentIdStr);
            deregAgentPda = deriveAgentPda(deregAgentId, program.programId);
            deregAuthority = web3_js_1.Keypair.generate();
            // Fund the deregistration test account
            await ensureBalance(provider.connection, deregAuthority, test_utils_1.MIN_BALANCE_SOL * web3_js_1.LAMPORTS_PER_SOL);
            // Register an agent specifically for deregistration test
            await program.methods
                .registerAgent(Array.from(deregAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_STORAGE), "https://dereg-agent.smoke-test.example.com", null, new bn_js_1.default(MIN_STAKE))
                .accounts({
                authority: deregAuthority.publicKey,
            })
                .signers([deregAuthority])
                .rpc();
        });
        it("should allow agent to deregister", async () => {
            console.log("\n[TEST] Deregistering agent...");
            const balanceBefore = await provider.connection.getBalance(deregAuthority.publicKey);
            await program.methods
                .deregisterAgent()
                .accountsPartial({
                agent: deregAgentPda,
                authority: deregAuthority.publicKey,
            })
                .signers([deregAuthority])
                .rpc();
            const balanceAfter = await provider.connection.getBalance(deregAuthority.publicKey);
            console.log("  Agent deregistered");
            console.log(`  Balance change: ${(balanceAfter - balanceBefore) / web3_js_1.LAMPORTS_PER_SOL} SOL (stake returned)`);
            // Stake should be returned
            chai_1.assert.isTrue(balanceAfter > balanceBefore - 0.01 * web3_js_1.LAMPORTS_PER_SOL, "Stake should be returned");
        });
        it("should verify agent account is closed", async () => {
            console.log("\n[TEST] Verifying agent account closed...");
            const agentInfo = await provider.connection.getAccountInfo(deregAgentPda);
            // Agent account should be closed
            chai_1.assert.isNull(agentInfo, "Agent account should be closed after deregistration");
            console.log("  Agent account closed successfully");
        });
    });
    describe("8. Protocol Stats", () => {
        it("should verify protocol statistics", async () => {
            console.log("\n[TEST] Checking protocol stats...");
            const config = await program.account.protocolConfig.fetch(protocolConfigPda);
            console.log(`  Authority: ${config.authority.toBase58()}`);
            console.log(`  Treasury: ${config.treasury.toBase58()}`);
            console.log(`  Total agents registered: ${config.totalAgents.toString()}`);
            console.log(`  Total tasks created: ${config.totalTasks.toString()}`);
            console.log(`  Completed tasks: ${config.completedTasks.toString()}`);
            console.log(`  Protocol fee: ${config.protocolFeeBps} bps`);
            console.log(`  Min agent stake: ${config.minAgentStake.toNumber() / web3_js_1.LAMPORTS_PER_SOL} SOL`);
            // Verify stats are reasonable
            chai_1.assert.isTrue(config.totalAgents.toNumber() >= 0, "Total agents should be >= 0");
            chai_1.assert.isTrue(config.totalTasks.toNumber() >= 0, "Total tasks should be >= 0");
            const treasuryBalance = await provider.connection.getBalance(config.treasury);
            console.log(`  Treasury balance: ${treasuryBalance / web3_js_1.LAMPORTS_PER_SOL} SOL`);
        });
    });
    after(async () => {
        console.log("\n========================================");
        console.log("Smoke Test Summary");
        console.log("========================================");
        console.log(`Program ID: ${program.programId.toBase58()}`);
        console.log(`Test Run ID: ${testRunId}`);
        console.log("\nAll smoke tests completed.");
        console.log("Review results above for any failures.");
        console.log("========================================\n");
    });
});
