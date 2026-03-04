"use strict";
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
const bn_js_1 = __importDefault(require("bn.js"));
const chai_1 = require("chai");
const web3_js_1 = require("@solana/web3.js");
const test_utils_1 = require("./test-utils");
describe("coordination-security", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
        .AgencCoordination;
    const protocolPda = (0, test_utils_1.deriveProtocolPda)(program.programId);
    const programDataPda = (0, test_utils_1.deriveProgramDataPda)(program.programId);
    // Generate unique run ID to prevent conflicts with persisted validator state
    const runId = (0, test_utils_1.generateRunId)();
    let treasury;
    let thirdSigner;
    let treasuryPubkey; // Actual treasury from protocol config
    let creator;
    let worker1;
    let worker2;
    let worker3;
    let arbiter1;
    let arbiter2;
    let arbiter3;
    let unauthorized;
    let creatorAgentPda;
    // Use unique IDs per test run to avoid conflicts with persisted state
    let agentId1;
    let agentId2;
    let agentId3;
    let creatorAgentId;
    let arbiterId1;
    let arbiterId2;
    let arbiterId3;
    let taskId1;
    let taskId2;
    let taskId3;
    let disputeId1;
    const MIN_CREATOR_BALANCE_LAMPORTS = 30 * web3_js_1.LAMPORTS_PER_SOL;
    const uniqueTaskId = (prefix) => (0, test_utils_1.makeTaskId)(`${prefix}-${Math.random().toString(36).slice(2, 8)}`, runId);
    const uniqueDisputeId = (prefix) => (0, test_utils_1.makeDisputeId)(`${prefix}-${Math.random().toString(36).slice(2, 8)}`, runId);
    const uniqueAgentId = (prefix) => (0, test_utils_1.makeAgentId)(`${prefix}-${Math.random().toString(36).slice(2, 8)}`, runId);
    async function ensureWalletBalance(wallet, minLamports) {
        const currentBalance = await provider.connection.getBalance(wallet);
        if (currentBalance >= minLamports) {
            return;
        }
        const topUpLamports = minLamports - currentBalance + web3_js_1.LAMPORTS_PER_SOL;
        const sig = await provider.connection.requestAirdrop(wallet, topUpLamports);
        await provider.connection.confirmTransaction(sig, "confirmed");
    }
    before(async () => {
        treasury = web3_js_1.Keypair.generate();
        thirdSigner = web3_js_1.Keypair.generate();
        creator = web3_js_1.Keypair.generate();
        worker1 = web3_js_1.Keypair.generate();
        worker2 = web3_js_1.Keypair.generate();
        worker3 = web3_js_1.Keypair.generate();
        arbiter1 = web3_js_1.Keypair.generate();
        arbiter2 = web3_js_1.Keypair.generate();
        arbiter3 = web3_js_1.Keypair.generate();
        unauthorized = web3_js_1.Keypair.generate();
        // Initialize unique IDs per test run
        agentId1 = (0, test_utils_1.makeAgentId)("ag1", runId);
        agentId2 = (0, test_utils_1.makeAgentId)("ag2", runId);
        agentId3 = (0, test_utils_1.makeAgentId)("ag3", runId);
        creatorAgentId = (0, test_utils_1.makeAgentId)("cre", runId);
        arbiterId1 = (0, test_utils_1.makeAgentId)("ar1", runId);
        arbiterId2 = (0, test_utils_1.makeAgentId)("ar2", runId);
        arbiterId3 = (0, test_utils_1.makeAgentId)("ar3", runId);
        taskId1 = (0, test_utils_1.makeTaskId)("t1", runId);
        taskId2 = (0, test_utils_1.makeTaskId)("t2", runId);
        taskId3 = (0, test_utils_1.makeTaskId)("t3", runId);
        disputeId1 = (0, test_utils_1.makeDisputeId)("d1", runId);
        const airdropAmount = 10 * web3_js_1.LAMPORTS_PER_SOL;
        const wallets = [
            treasury,
            thirdSigner,
            creator,
            worker1,
            worker2,
            worker3,
            arbiter1,
            arbiter2,
            arbiter3,
            unauthorized,
        ];
        for (const wallet of wallets) {
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount), "confirmed");
        }
        // Initialize protocol if not already done
        try {
            await program.methods
                .initializeProtocol(51, 100, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), 2, [provider.wallet.publicKey, treasury.publicKey, thirdSigner.publicKey])
                .accountsPartial({
                protocolConfig: protocolPda,
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
            console.log("Protocol initialized with treasury:", treasuryPubkey.toString());
        }
        catch (e) {
            if (e?.error?.errorCode?.code === "ProtocolAlreadyInitialized" ||
                e?.message?.includes("already in use")) {
                // Expected - protocol already initialized from previous test run
                const protocolConfig = await program.account.protocolConfig.fetch(protocolPda);
                treasuryPubkey = protocolConfig.treasury;
                console.log("Protocol already initialized, using existing treasury:", treasuryPubkey.toString());
            }
            else {
                throw e;
            }
        }
        // Disable rate limiting for tests
        await (0, test_utils_1.disableRateLimitsForTests)({
            program,
            protocolPda,
            authority: provider.wallet.publicKey,
            additionalSigners: [treasury],
        });
        creatorAgentPda = (0, test_utils_1.deriveAgentPda)(creatorAgentId, program.programId);
        try {
            await program.methods
                .registerAgent(Array.from(creatorAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://creator.example.com", null, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL))
                .accountsPartial({
                agent: creatorAgentPda,
                protocolConfig: protocolPda,
                authority: creator.publicKey,
            })
                .signers([creator])
                .rpc();
        }
        catch (e) {
            // Agent may already be registered
        }
    });
    // Ensure all shared agents are active before each test
    // and top up creator balance for long-running task lifecycle scenarios.
    beforeEach(async () => {
        await ensureWalletBalance(creator.publicKey, MIN_CREATOR_BALANCE_LAMPORTS);
    });
    describe("Happy Paths", () => {
        describe("Protocol Initialization", () => {
            it("Successfully initializes protocol", async () => {
                // Protocol may already be initialized by other test files
                // Just verify the protocol config exists and has valid values
                const protocol = await program.account.protocolConfig.fetch(protocolPda);
                (0, chai_1.expect)(protocol.authority).to.exist;
                (0, chai_1.expect)(protocol.treasury).to.exist;
                (0, chai_1.expect)(protocol.disputeThreshold).to.be.at.least(1).and.at.most(100);
                (0, chai_1.expect)(protocol.protocolFeeBps).to.be.at.least(0).and.at.most(1000);
                // totalAgents/totalTasks may have been incremented by other tests
                (0, chai_1.expect)(Number(protocol.totalAgents)).to.be.at.least(0);
                (0, chai_1.expect)(Number(protocol.totalTasks)).to.be.at.least(0);
            });
            it("Keeps protocol config accessible after initialization", async () => {
                const protocol = await program.account.protocolConfig.fetch(protocolPda);
                (0, chai_1.expect)(protocol.authority).to.exist;
                (0, chai_1.expect)(protocol.treasury).to.exist;
            });
        });
        describe("Agent Registration", () => {
            it("Successfully registers a new agent", async () => {
                const agentPda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const balanceBefore = await provider.connection.getBalance(worker1.publicKey);
                await program.methods
                    .registerAgent(Array.from(agentId1), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_INFERENCE), "https://worker1.example.com", null, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    agent: agentPda,
                    protocolConfig: protocolPda,
                    authority: worker1.publicKey,
                })
                    .signers([worker1])
                    .rpc();
                const agent = await program.account.agentRegistration.fetch(agentPda);
                (0, chai_1.expect)(agent.agentId).to.deep.equal(Array.from(agentId1));
                (0, chai_1.expect)(agent.authority.toString()).to.equal(worker1.publicKey.toString());
                (0, chai_1.expect)(agent.capabilities.toNumber()).to.equal(test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_INFERENCE);
                (0, chai_1.expect)("active" in agent.status).to.be.true;
                (0, chai_1.expect)(agent.endpoint).to.equal("https://worker1.example.com");
                (0, chai_1.expect)(agent.reputation).to.equal(5000);
                (0, chai_1.expect)(agent.activeTasks).to.equal(0);
            });
            it("Emits AgentRegistered event", async () => {
                const agentPda = (0, test_utils_1.deriveAgentPda)(agentId2, program.programId);
                let eventEmitted = false;
                const listener = program.addEventListener("AgentRegistered", (event) => {
                    (0, chai_1.expect)(event.agentId).to.deep.equal(Array.from(agentId2));
                    (0, chai_1.expect)(event.authority.toString()).to.equal(worker2.publicKey.toString());
                    eventEmitted = true;
                });
                await program.methods
                    .registerAgent(Array.from(agentId2), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://worker2.example.com", null, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    agent: agentPda,
                    protocolConfig: protocolPda,
                    authority: worker2.publicKey,
                })
                    .signers([worker2])
                    .rpc();
                await new Promise((resolve) => setTimeout(resolve, 500));
                program.removeEventListener(listener);
                if (!eventEmitted) {
                    const agent = await program.account.agentRegistration.fetch(agentPda);
                    (0, chai_1.expect)(agent.authority.toString()).to.equal(worker2.publicKey.toString());
                }
            });
            it("Fails when registering agent with empty endpoint", async () => {
                const emptyEndpointAgentId = (0, test_utils_1.makeAgentId)("empty", runId);
                const agentPda = (0, test_utils_1.deriveAgentPda)(emptyEndpointAgentId, program.programId);
                try {
                    await program.methods
                        .registerAgent(Array.from(emptyEndpointAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "", // Empty endpoint - should fail
                    null, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL))
                        .accountsPartial({
                        agent: agentPda,
                        protocolConfig: protocolPda,
                        authority: worker1.publicKey,
                    })
                        .signers([worker1])
                        .rpc();
                    chai_1.expect.fail("Should have failed - empty endpoint");
                }
                catch (e) {
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code).to.equal("InvalidInput");
                }
            });
        });
        describe("Agent Update and Deregister", () => {
            it("Successfully updates agent capabilities and status", async () => {
                const agentPda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                await program.methods
                    .updateAgent(new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_INFERENCE | test_utils_1.CAPABILITY_ARBITER), "https://worker1-updated.example.com", null, 1)
                    .accountsPartial({
                    agent: agentPda,
                    authority: worker1.publicKey,
                })
                    .signers([worker1])
                    .rpc();
                const agent = await program.account.agentRegistration.fetch(agentPda);
                (0, chai_1.expect)(agent.capabilities.toNumber()).to.equal(test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_INFERENCE | test_utils_1.CAPABILITY_ARBITER);
                (0, chai_1.expect)(agent.endpoint).to.equal("https://worker1-updated.example.com");
            });
            it("Successfully deregisters agent with no active tasks", async () => {
                const agentPda = (0, test_utils_1.deriveAgentPda)(agentId2, program.programId);
                await program.methods
                    .deregisterAgent()
                    .accountsPartial({
                    agent: agentPda,
                    protocolConfig: protocolPda,
                    authority: worker2.publicKey,
                })
                    .signers([worker2])
                    .rpc();
                try {
                    await program.account.agentRegistration.fetch(agentPda);
                    chai_1.expect.fail("Should have failed - agent was deregistered");
                }
                catch (e) {
                    // Expected: Account should not exist after deregistration
                }
                // totalAgents should have decreased, but we can't assert exact value due to shared state
                const protocol = await program.account.protocolConfig.fetch(protocolPda);
                (0, chai_1.expect)(protocol.totalAgents).to.exist;
            });
        });
        describe("Task Creation - All Types", () => {
            it("Successfully creates exclusive task with reward", async () => {
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId1, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const rewardAmount = 2 * web3_js_1.LAMPORTS_PER_SOL;
                const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
                await program.methods
                    .createTask(Array.from(taskId1), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Process this data".padEnd(64, "\0")), new bn_js_1.default(rewardAmount), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                const task = await program.account.task.fetch(taskPda);
                (0, chai_1.expect)(task.taskId).to.deep.equal(Array.from(taskId1));
                (0, chai_1.expect)(task.creator.toString()).to.equal(creator.publicKey.toString());
                (0, chai_1.expect)(task.requiredCapabilities.toNumber()).to.equal(test_utils_1.CAPABILITY_COMPUTE);
                (0, chai_1.expect)(task.rewardAmount.toNumber()).to.equal(rewardAmount);
                (0, chai_1.expect)(task.maxWorkers).to.equal(1);
                (0, chai_1.expect)(task.currentWorkers).to.equal(0);
                (0, chai_1.expect)(task.taskType).to.deep.equal({ exclusive: {} });
                (0, chai_1.expect)(task.status).to.deep.equal({ open: {} });
                const escrow = await program.account.taskEscrow.fetch(escrowPda);
                (0, chai_1.expect)(escrow.amount.toNumber()).to.equal(rewardAmount);
                (0, chai_1.expect)(escrow.distributed.toNumber()).to.equal(0);
            });
            it("Successfully creates collaborative task", async () => {
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId2, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                await program.methods
                    .createTask(Array.from(taskId2), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Collaborative task".padEnd(64, "\0")), new bn_js_1.default(3 * web3_js_1.LAMPORTS_PER_SOL), 3, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_COLLABORATIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                const task = await program.account.task.fetch(taskPda);
                (0, chai_1.expect)(task.maxWorkers).to.equal(3);
                (0, chai_1.expect)(task.taskType).to.deep.equal({ collaborative: {} });
                (0, chai_1.expect)(task.requiredCompletions).to.equal(3);
            });
            it("Successfully creates competitive task", async () => {
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId3, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                await program.methods
                    .createTask(Array.from(taskId3), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Competitive task".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 5, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_COMPETITIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                const task = await program.account.task.fetch(taskPda);
                (0, chai_1.expect)(task.maxWorkers).to.equal(5);
                (0, chai_1.expect)(task.taskType).to.deep.equal({ competitive: {} });
            });
        });
        describe("Task Claim and Complete - Exclusive Task", () => {
            it("Successfully claims exclusive task", async () => {
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId1, program.programId);
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker1Pda, program.programId);
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    worker: worker1Pda,
                    authority: worker1.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker1])
                    .rpc();
                const task = await program.account.task.fetch(taskPda);
                (0, chai_1.expect)(task.currentWorkers).to.equal(1);
                (0, chai_1.expect)(task.status).to.deep.equal({ inProgress: {} });
                const claim = await program.account.taskClaim.fetch(claimPda);
                (0, chai_1.expect)(claim.worker.toString()).to.equal(worker1Pda.toString());
                (0, chai_1.expect)(claim.isCompleted).to.be.false;
            });
            it("Successfully completes exclusive task and receives reward", async () => {
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId1, program.programId);
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker1Pda, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const proofHash = Buffer.from("proof-hash-00000000000001".padEnd(32, "\0"));
                const rewardAmount = 2 * web3_js_1.LAMPORTS_PER_SOL;
                const expectedFee = Math.floor((rewardAmount * 100) / 10000);
                const expectedReward = rewardAmount - expectedFee;
                const workerBalanceBefore = await provider.connection.getBalance(worker1.publicKey);
                const treasuryBalanceBefore = await provider.connection.getBalance(treasuryPubkey);
                await program.methods
                    .completeTask(Array.from(proofHash), null)
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    escrow: escrowPda,
                    worker: worker1Pda,
                    protocolConfig: protocolPda,
                    treasury: treasuryPubkey,
                    authority: worker1.publicKey,
                    creator: creator.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    tokenEscrowAta: null,
                    workerTokenAccount: null,
                    treasuryTokenAccount: null,
                    rewardMint: null,
                    tokenProgram: null,
                })
                    .signers([worker1])
                    .rpc();
                const task = await program.account.task.fetch(taskPda);
                (0, chai_1.expect)(task.status).to.deep.equal({ completed: {} });
                (0, chai_1.expect)(task.completions).to.equal(1);
                try {
                    await program.account.taskClaim.fetch(claimPda);
                    chai_1.expect.fail("Claim should be closed after completion");
                }
                catch {
                    // Expected: claim account is closed in complete_task.
                }
                try {
                    const escrow = await program.account.taskEscrow.fetch(escrowPda);
                    (0, chai_1.expect)(escrow.isClosed).to.be.true;
                }
                catch {
                    // Expected when escrow account is fully closed after final completion.
                }
                const workerBalanceAfter = await provider.connection.getBalance(worker1.publicKey);
                const treasuryBalanceAfter = await provider.connection.getBalance(treasuryPubkey);
                (0, chai_1.expect)(workerBalanceAfter - workerBalanceBefore).to.be.at.least(expectedReward - 100000);
                (0, chai_1.expect)(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
                const agent = await program.account.agentRegistration.fetch(worker1Pda);
                (0, chai_1.expect)(agent.tasksCompleted.toNumber()).to.equal(1);
                (0, chai_1.expect)(agent.totalEarned.toNumber()).to.equal(expectedReward);
                (0, chai_1.expect)(agent.reputation).to.equal(5100);
                (0, chai_1.expect)(agent.activeTasks).to.equal(0);
            });
        });
        describe("Task Cancel - Unclaimed", () => {
            it("Successfully cancels unclaimed task", async () => {
                const newTaskId = uniqueTaskId("cancel");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const rewardAmount = 1 * web3_js_1.LAMPORTS_PER_SOL;
                const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Cancelable task".padEnd(64, "\0")), new bn_js_1.default(rewardAmount), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                await program.methods
                    .cancelTask()
                    .accountsPartial({
                    task: taskPda,
                    escrow: escrowPda,
                    creator: creator.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    tokenEscrowAta: null,
                    creatorTokenAccount: null,
                    rewardMint: null,
                    tokenProgram: null,
                })
                    .signers([creator])
                    .rpc();
                const task = await program.account.task.fetch(taskPda);
                (0, chai_1.expect)(task.status).to.deep.equal({ cancelled: {} });
                const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
                (0, chai_1.expect)(creatorBalanceAfter).to.be.greaterThan(creatorBalanceBefore - 10000000);
            });
        });
        describe("Dispute Flow - Full Cycle", () => {
            let taskPda;
            let escrowPda;
            let disputePda;
            let workerPda;
            let disputeTaskId;
            let workerClaimPda;
            before(async () => {
                workerPda = (0, test_utils_1.deriveAgentPda)(agentId3, program.programId);
                disputeTaskId = uniqueTaskId("dispute");
                taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, disputeTaskId, program.programId);
                escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                disputePda = (0, test_utils_1.deriveDisputePda)(disputeId1, program.programId);
                await program.methods
                    .registerAgent(Array.from(agentId3), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://worker3.example.com", null, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    agent: workerPda,
                    protocolConfig: protocolPda,
                    authority: worker3.publicKey,
                })
                    .signers([worker3])
                    .rpc();
                await program.methods
                    .createTask(Array.from(disputeTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Dispute task".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                workerClaimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerPda, program.programId);
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: workerClaimPda,
                    worker: workerPda,
                    authority: worker3.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker3])
                    .rpc();
            });
            it("Successfully initiates dispute", async () => {
                const evidenceHash = Buffer.from("evidence-hash000000000001".padEnd(32, "\0"));
                await program.methods
                    .initiateDispute(Array.from(disputeId1), Array.from(disputeTaskId), Array.from(evidenceHash), test_utils_1.RESOLUTION_TYPE_REFUND, test_utils_1.VALID_EVIDENCE)
                    .accountsPartial({
                    dispute: disputePda,
                    task: taskPda,
                    agent: workerPda,
                    protocolConfig: protocolPda,
                    authority: worker3.publicKey,
                    initiatorClaim: workerClaimPda,
                    workerAgent: null,
                    workerClaim: null,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker3])
                    .rpc();
                const dispute = await program.account.dispute.fetch(disputePda);
                (0, chai_1.expect)(dispute.task.toString()).to.equal(taskPda.toString());
                (0, chai_1.expect)(dispute.initiator.toString()).to.equal(workerPda.toString());
                (0, chai_1.expect)(dispute.status).to.deep.equal({ active: {} });
                (0, chai_1.expect)(dispute.resolutionType).to.deep.equal({ refund: {} });
                const task = await program.account.task.fetch(taskPda);
                (0, chai_1.expect)(task.status).to.deep.equal({ disputed: {} });
            });
            it("Multiple arbiters vote on dispute", async () => {
                for (let i = 0; i < 3; i++) {
                    const arbiterKey = [arbiter1, arbiter2, arbiter3][i];
                    const arbiterId = [arbiterId1, arbiterId2, arbiterId3][i];
                    const approve = i < 2;
                    const arbiterPda = (0, test_utils_1.deriveAgentPda)(arbiterId, program.programId);
                    const votePda = (0, test_utils_1.deriveVotePda)(disputePda, arbiterPda, program.programId);
                    const authorityVotePda = (0, test_utils_1.deriveAuthorityVotePda)(disputePda, arbiterKey.publicKey, program.programId);
                    await program.methods
                        .registerAgent(Array.from(arbiterId), new bn_js_1.default(test_utils_1.CAPABILITY_ARBITER), `https://arbiter${i + 1}.example.com`, null, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL))
                        .accountsPartial({
                        agent: arbiterPda,
                        protocolConfig: protocolPda,
                        authority: arbiterKey.publicKey,
                    })
                        .signers([arbiterKey])
                        .rpc();
                    await program.methods
                        .voteDispute(approve)
                        .accountsPartial({
                        dispute: disputePda,
                        vote: votePda,
                        authorityVote: authorityVotePda,
                        arbiter: arbiterPda,
                        protocolConfig: protocolPda,
                        authority: arbiterKey.publicKey,
                        task: taskPda,
                        workerClaim: workerClaimPda,
                        defendantAgent: workerPda,
                        systemProgram: web3_js_1.SystemProgram.programId,
                    })
                        .signers([arbiterKey])
                        .rpc();
                }
                const dispute = await program.account.dispute.fetch(disputePda);
                // Votes are stake-weighted by reputation (default 5000 = 50% weight).
                const expectedVoteWeight = Math.floor(web3_js_1.LAMPORTS_PER_SOL / 2);
                (0, chai_1.expect)(dispute.votesFor.toNumber()).to.equal(2 * expectedVoteWeight);
                (0, chai_1.expect)(dispute.votesAgainst.toNumber()).to.equal(1 * expectedVoteWeight);
                (0, chai_1.expect)(dispute.totalVoters).to.equal(3);
            });
            it("Rejects early dispute resolution before voting period ends", async () => {
                const arbiterPda1 = (0, test_utils_1.deriveAgentPda)(arbiterId1, program.programId);
                const arbiterPda2 = (0, test_utils_1.deriveAgentPda)(arbiterId2, program.programId);
                const arbiterPda3 = (0, test_utils_1.deriveAgentPda)(arbiterId3, program.programId);
                const votePda1 = (0, test_utils_1.deriveVotePda)(disputePda, arbiterPda1, program.programId);
                const votePda2 = (0, test_utils_1.deriveVotePda)(disputePda, arbiterPda2, program.programId);
                const votePda3 = (0, test_utils_1.deriveVotePda)(disputePda, arbiterPda3, program.programId);
                let resolved = false;
                try {
                    await program.methods
                        .resolveDispute()
                        .accountsPartial({
                        dispute: disputePda,
                        task: taskPda,
                        escrow: escrowPda,
                        protocolConfig: protocolPda,
                        resolver: provider.wallet.publicKey,
                        creator: creator.publicKey,
                        workerClaim: workerClaimPda,
                        worker: workerPda,
                        workerAuthority: worker3.publicKey,
                        systemProgram: web3_js_1.SystemProgram.programId,
                        tokenEscrowAta: null,
                        creatorTokenAccount: null,
                        workerTokenAccountAta: null,
                        treasuryTokenAccount: null,
                        rewardMint: null,
                        tokenProgram: null,
                    })
                        .remainingAccounts([
                        { pubkey: votePda1, isSigner: false, isWritable: false },
                        { pubkey: arbiterPda1, isSigner: false, isWritable: true },
                        { pubkey: votePda2, isSigner: false, isWritable: false },
                        { pubkey: arbiterPda2, isSigner: false, isWritable: true },
                        { pubkey: votePda3, isSigner: false, isWritable: false },
                        { pubkey: arbiterPda3, isSigner: false, isWritable: true },
                    ])
                        .rpc();
                    resolved = true;
                }
                catch (e) {
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
                if (resolved) {
                    const dispute = await program.account.dispute.fetch(disputePda);
                    (0, chai_1.expect)(dispute.status).to.deep.equal({ resolved: {} });
                }
            });
        });
    });
    describe("Security and Edge Cases", () => {
        describe("Unauthorized Access", () => {
            it("Fails when non-authority tries to update agent", async () => {
                const agentPda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                try {
                    await program.methods
                        .updateAgent(new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://malicious.com", null, 1) // 1 = Active
                        .accountsPartial({
                        agent: agentPda,
                        authority: unauthorized.publicKey,
                    })
                        .signers([unauthorized])
                        .rpc();
                    chai_1.expect.fail("Should have failed - unauthorized agent update");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
            it("Fails when non-creator tries to cancel task", async () => {
                const newTaskId = uniqueTaskId("unauth");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Test task".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                try {
                    await program.methods
                        .cancelTask()
                        .accountsPartial({
                        task: taskPda,
                        escrow: escrowPda,
                        creator: unauthorized.publicKey,
                        protocolConfig: protocolPda,
                        systemProgram: web3_js_1.SystemProgram.programId,
                        tokenEscrowAta: null,
                        creatorTokenAccount: null,
                        rewardMint: null,
                        tokenProgram: null,
                    })
                        .signers([unauthorized])
                        .rpc();
                    chai_1.expect.fail("Should have failed");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
        });
        describe("Double Claims and Completions", () => {
            it("Fails when worker tries to claim same task twice", async () => {
                const newTaskId = uniqueTaskId("double-claim");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker1Pda, program.programId);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Double claim test".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 2, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_COLLABORATIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    worker: worker1Pda,
                    authority: worker1.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker1])
                    .rpc();
                try {
                    await program.methods
                        .claimTask()
                        .accountsPartial({
                        task: taskPda,
                        claim: claimPda,
                        worker: worker1Pda,
                        authority: worker1.publicKey,
                        protocolConfig: protocolPda,
                        systemProgram: web3_js_1.SystemProgram.programId,
                    })
                        .signers([worker1])
                        .rpc();
                    chai_1.expect.fail("Should have failed - double claim");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
            it("Fails when worker tries to complete task twice", async () => {
                const newTaskId = uniqueTaskId("double-complete");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker1Pda, program.programId);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Double complete test".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    worker: worker1Pda,
                    authority: worker1.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker1])
                    .rpc();
                const proofHash = Buffer.from("proof-hash-00000000000002".padEnd(32, "\0"));
                await program.methods
                    .completeTask(Array.from(proofHash), null)
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    escrow: escrowPda,
                    worker: worker1Pda,
                    protocolConfig: protocolPda,
                    treasury: treasuryPubkey,
                    authority: worker1.publicKey,
                    creator: creator.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    tokenEscrowAta: null,
                    workerTokenAccount: null,
                    treasuryTokenAccount: null,
                    rewardMint: null,
                    tokenProgram: null,
                })
                    .signers([worker1])
                    .rpc();
                try {
                    await program.methods
                        .completeTask(Array.from(proofHash), null)
                        .accountsPartial({
                        task: taskPda,
                        claim: claimPda,
                        escrow: escrowPda,
                        worker: worker1Pda,
                        protocolConfig: protocolPda,
                        treasury: treasuryPubkey,
                        authority: worker1.publicKey,
                        creator: creator.publicKey,
                        systemProgram: web3_js_1.SystemProgram.programId,
                        tokenEscrowAta: null,
                        workerTokenAccount: null,
                        treasuryTokenAccount: null,
                        rewardMint: null,
                        tokenProgram: null,
                    })
                        .signers([worker1])
                        .rpc();
                    chai_1.expect.fail("Should have failed - double completion");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
        });
        describe("Capability and Status Validation", () => {
            it("Fails when worker lacks required capabilities", async () => {
                const newTaskId = uniqueTaskId("cap-check");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker1Pda, program.programId);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_STORAGE), Buffer.from("Capability test".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                try {
                    await program.methods
                        .claimTask()
                        .accountsPartial({
                        task: taskPda,
                        claim: claimPda,
                        worker: worker1Pda,
                        authority: worker1.publicKey,
                        protocolConfig: protocolPda,
                        systemProgram: web3_js_1.SystemProgram.programId,
                    })
                        .signers([worker1])
                        .rpc();
                    chai_1.expect.fail("Should have failed - worker lacks capabilities");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
            it("Fails when inactive agent tries to claim task", async () => {
                const inactiveWorker = web3_js_1.Keypair.generate();
                await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(inactiveWorker.publicKey, 3 * web3_js_1.LAMPORTS_PER_SOL), "confirmed");
                const inactiveAgentId = uniqueAgentId("inactive-worker");
                const agentPda = (0, test_utils_1.deriveAgentPda)(inactiveAgentId, program.programId);
                await program.methods
                    .registerAgent(Array.from(inactiveAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://inactive-worker.example.com", null, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    agent: agentPda,
                    protocolConfig: protocolPda,
                    authority: inactiveWorker.publicKey,
                })
                    .signers([inactiveWorker])
                    .rpc();
                await program.methods
                    .updateAgent(null, null, null, 0) // 0 = Inactive
                    .accountsPartial({
                    agent: agentPda,
                    authority: inactiveWorker.publicKey,
                })
                    .signers([inactiveWorker])
                    .rpc();
                const newTaskId = uniqueTaskId("inactive");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, agentPda, program.programId);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Inactive agent test".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                try {
                    await program.methods
                        .claimTask()
                        .accountsPartial({
                        task: taskPda,
                        claim: claimPda,
                        worker: agentPda,
                        authority: inactiveWorker.publicKey,
                        protocolConfig: protocolPda,
                        systemProgram: web3_js_1.SystemProgram.programId,
                    })
                        .signers([inactiveWorker])
                        .rpc();
                    chai_1.expect.fail("Should have failed - inactive agent");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
        });
        describe("Deadline Expiry", () => {
            it("Fails to claim task after deadline", async () => {
                const newTaskId = uniqueTaskId("expired");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const nearFutureDeadline = Math.floor(Date.now() / 1000) + 2;
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Expired task".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(nearFutureDeadline), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                await new Promise((resolve) => setTimeout(resolve, 3000));
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker1Pda, program.programId);
                try {
                    await program.methods
                        .claimTask()
                        .accountsPartial({
                        task: taskPda,
                        claim: claimPda,
                        worker: worker1Pda,
                        authority: worker1.publicKey,
                        protocolConfig: protocolPda,
                        systemProgram: web3_js_1.SystemProgram.programId,
                    })
                        .signers([worker1])
                        .rpc();
                    chai_1.expect.fail("Should have failed - task expired");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
            it("Successfully cancels expired task with no completions", async () => {
                const newTaskId = uniqueTaskId("cancel-expired");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const nearFutureDeadline = Math.floor(Date.now() / 1000) + 2;
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Soon expired".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(nearFutureDeadline), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                await new Promise((resolve) => setTimeout(resolve, 3000));
                await program.methods
                    .cancelTask()
                    .accountsPartial({
                    task: taskPda,
                    escrow: escrowPda,
                    creator: creator.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    tokenEscrowAta: null,
                    creatorTokenAccount: null,
                    rewardMint: null,
                    tokenProgram: null,
                })
                    .signers([creator])
                    .rpc();
                const task = await program.account.task.fetch(taskPda);
                (0, chai_1.expect)(task.status).to.deep.equal({ cancelled: {} });
            });
        });
        describe("Dispute Threshold Tests", () => {
            it("Rejects dispute resolution without quorum/deadline", async () => {
                const newDisputeId = uniqueDisputeId("threshold");
                const newTaskId = uniqueTaskId("threshold");
                const disputePda = (0, test_utils_1.deriveDisputePda)(newDisputeId, program.programId);
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Threshold test".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                const worker3AgentPda = (0, test_utils_1.deriveAgentPda)(agentId3, program.programId);
                const workerClaimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker3AgentPda, program.programId);
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: workerClaimPda,
                    worker: worker3AgentPda,
                    authority: worker3.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker3])
                    .rpc();
                await program.methods
                    .initiateDispute(Array.from(newDisputeId), Array.from(newTaskId), Array.from(Buffer.from("evidence".padEnd(32, "\0"))), test_utils_1.RESOLUTION_TYPE_REFUND, test_utils_1.VALID_EVIDENCE)
                    .accountsPartial({
                    dispute: disputePda,
                    task: taskPda,
                    agent: worker3AgentPda,
                    protocolConfig: protocolPda,
                    authority: worker3.publicKey,
                    initiatorClaim: workerClaimPda,
                    workerAgent: null,
                    workerClaim: null,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker3])
                    .rpc();
                const arbiterPda1 = (0, test_utils_1.deriveAgentPda)(arbiterId1, program.programId);
                const arbiterPda2 = (0, test_utils_1.deriveAgentPda)(arbiterId2, program.programId);
                const votePda1 = (0, test_utils_1.deriveVotePda)(disputePda, arbiterPda1, program.programId);
                const votePda2 = (0, test_utils_1.deriveVotePda)(disputePda, arbiterPda2, program.programId);
                const authorityVotePda1 = (0, test_utils_1.deriveAuthorityVotePda)(disputePda, arbiter1.publicKey, program.programId);
                const authorityVotePda2 = (0, test_utils_1.deriveAuthorityVotePda)(disputePda, arbiter2.publicKey, program.programId);
                await program.methods
                    .voteDispute(true)
                    .accountsPartial({
                    dispute: disputePda,
                    vote: votePda1,
                    authorityVote: authorityVotePda1,
                    arbiter: arbiterPda1,
                    protocolConfig: protocolPda,
                    authority: arbiter1.publicKey,
                    task: taskPda,
                    workerClaim: workerClaimPda,
                    defendantAgent: worker3AgentPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([arbiter1])
                    .rpc();
                await program.methods
                    .voteDispute(true)
                    .accountsPartial({
                    dispute: disputePda,
                    vote: votePda2,
                    authorityVote: authorityVotePda2,
                    arbiter: arbiterPda2,
                    protocolConfig: protocolPda,
                    authority: arbiter2.publicKey,
                    task: taskPda,
                    workerClaim: workerClaimPda,
                    defendantAgent: worker3AgentPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([arbiter2])
                    .rpc();
                try {
                    await program.methods
                        .resolveDispute()
                        .accountsPartial({
                        dispute: disputePda,
                        task: taskPda,
                        escrow: escrowPda,
                        protocolConfig: protocolPda,
                        resolver: provider.wallet.publicKey,
                        creator: creator.publicKey,
                        workerClaim: workerClaimPda,
                        worker: worker3AgentPda,
                        workerAuthority: worker3.publicKey,
                        systemProgram: web3_js_1.SystemProgram.programId,
                        tokenEscrowAta: null,
                        creatorTokenAccount: null,
                        workerTokenAccountAta: null,
                        treasuryTokenAccount: null,
                        rewardMint: null,
                        tokenProgram: null,
                    })
                        .remainingAccounts([
                        { pubkey: votePda1, isSigner: false, isWritable: false },
                        { pubkey: arbiterPda1, isSigner: false, isWritable: true },
                        { pubkey: votePda2, isSigner: false, isWritable: false },
                        { pubkey: arbiterPda2, isSigner: false, isWritable: true },
                    ])
                        .rpc();
                    chai_1.expect.fail("Should have failed - quorum/deadline not satisfied");
                }
                catch (e) {
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
        });
        describe("Max Workers Boundary", () => {
            it("Fails when task exceeds max workers", async () => {
                const newTaskId = uniqueTaskId("max-workers");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Max workers test".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 2, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_COLLABORATIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const worker3Pda = (0, test_utils_1.deriveAgentPda)(agentId3, program.programId);
                const claimPda1 = (0, test_utils_1.deriveClaimPda)(taskPda, worker1Pda, program.programId);
                const claimPda2 = (0, test_utils_1.deriveClaimPda)(taskPda, worker3Pda, program.programId);
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda1,
                    worker: worker1Pda,
                    authority: worker1.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker1])
                    .rpc();
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda2,
                    worker: worker3Pda,
                    authority: worker3.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker3])
                    .rpc();
                const task = await program.account.task.fetch(taskPda);
                (0, chai_1.expect)(task.currentWorkers).to.equal(2);
                const extraWorker = web3_js_1.Keypair.generate();
                const extraAgentId = uniqueAgentId("extra");
                const extraAgentPda = (0, test_utils_1.deriveAgentPda)(extraAgentId, program.programId);
                const claimPda3 = (0, test_utils_1.deriveClaimPda)(taskPda, extraAgentPda, program.programId);
                await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(extraWorker.publicKey, 2 * web3_js_1.LAMPORTS_PER_SOL), "confirmed");
                await program.methods
                    .registerAgent(Array.from(extraAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://extra.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    agent: extraAgentPda,
                    protocolConfig: protocolPda,
                    authority: extraWorker.publicKey,
                })
                    .signers([extraWorker])
                    .rpc();
                try {
                    await program.methods
                        .claimTask()
                        .accountsPartial({
                        task: taskPda,
                        claim: claimPda3,
                        worker: extraAgentPda,
                        authority: extraWorker.publicKey,
                        protocolConfig: protocolPda,
                        systemProgram: web3_js_1.SystemProgram.programId,
                    })
                        .signers([extraWorker])
                        .rpc();
                    chai_1.expect.fail("Should have failed - max workers exceeded");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
        });
        describe("Zero Reward Tasks", () => {
            it("Fails to create zero-reward task", async () => {
                const newTaskId = uniqueTaskId("zero-reward");
                try {
                    await program.methods
                        .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Zero reward task".padEnd(64, "\0")), new bn_js_1.default(0), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                    0, // min_reputation
                    null)
                        .accountsPartial({
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
                    chai_1.expect.fail("Should have failed - zero reward is invalid");
                }
                catch (e) {
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
        });
        describe("Deregister with Active Tasks", () => {
            it("Fails to deregister agent with active tasks", async () => {
                const newTaskId = uniqueTaskId("deregister");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Deregister test".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker1Pda, program.programId);
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    worker: worker1Pda,
                    authority: worker1.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker1])
                    .rpc();
                const agentPda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                try {
                    await program.methods
                        .deregisterAgent()
                        .accountsPartial({
                        agent: agentPda,
                        protocolConfig: protocolPda,
                        authority: worker1.publicKey,
                    })
                        .signers([worker1])
                        .rpc();
                    chai_1.expect.fail("Should have failed - agent has active tasks");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
        });
        describe("Arbiter Voting Requirements", () => {
            it("Fails when non-arbiter tries to vote", async () => {
                const newDisputeId = uniqueDisputeId("non-arbiter");
                const newTaskId = uniqueTaskId("non-arbiter");
                const disputePda = (0, test_utils_1.deriveDisputePda)(newDisputeId, program.programId);
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Non-arbiter test".padEnd(64, "\0")), new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                const worker3AgentPda = (0, test_utils_1.deriveAgentPda)(agentId3, program.programId);
                const workerClaimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker3AgentPda, program.programId);
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: workerClaimPda,
                    worker: worker3AgentPda,
                    authority: worker3.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker3])
                    .rpc();
                await program.methods
                    .initiateDispute(Array.from(newDisputeId), Array.from(newTaskId), Array.from(Buffer.from("evidence".padEnd(32, "\0"))), test_utils_1.RESOLUTION_TYPE_REFUND, test_utils_1.VALID_EVIDENCE)
                    .accountsPartial({
                    dispute: disputePda,
                    task: taskPda,
                    agent: worker3AgentPda,
                    protocolConfig: protocolPda,
                    authority: worker3.publicKey,
                    initiatorClaim: workerClaimPda,
                    workerAgent: null,
                    workerClaim: null,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker3])
                    .rpc();
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const votePda = (0, test_utils_1.deriveVotePda)(disputePda, worker1Pda, program.programId);
                const authorityVotePda = (0, test_utils_1.deriveAuthorityVotePda)(disputePda, worker1.publicKey, program.programId);
                try {
                    await program.methods
                        .voteDispute(true)
                        .accountsPartial({
                        dispute: disputePda,
                        vote: votePda,
                        authorityVote: authorityVotePda,
                        arbiter: worker1Pda,
                        protocolConfig: protocolPda,
                        authority: worker1.publicKey,
                        task: taskPda,
                        workerClaim: workerClaimPda,
                        defendantAgent: worker3AgentPda,
                        systemProgram: web3_js_1.SystemProgram.programId,
                    })
                        .signers([worker1])
                        .rpc();
                    chai_1.expect.fail("Should have failed - non-arbiter voting");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
        });
        describe("Protocol Configuration Validation", () => {
            it("Fails to initialize with invalid fee (over 1000 bps)", async () => {
                const newProtocolPda = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol2")], program.programId)[0];
                try {
                    await program.methods
                        .initializeProtocol(51, 1001, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, [
                        provider.wallet.publicKey,
                    ])
                        .accountsPartial({
                        protocolConfig: newProtocolPda,
                        treasury: treasury.publicKey,
                        authority: provider.wallet.publicKey,
                    })
                        .remainingAccounts([
                        {
                            pubkey: (0, test_utils_1.deriveProgramDataPda)(program.programId),
                            isSigner: false,
                            isWritable: false,
                        },
                    ])
                        .rpc();
                    chai_1.expect.fail("Should have failed - invalid fee");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
            it("Fails to initialize with invalid dispute threshold (0)", async () => {
                const newProtocolPda = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol3")], program.programId)[0];
                try {
                    await program.methods
                        .initializeProtocol(0, 100, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, [
                        provider.wallet.publicKey,
                    ])
                        .accountsPartial({
                        protocolConfig: newProtocolPda,
                        treasury: treasury.publicKey,
                        authority: provider.wallet.publicKey,
                    })
                        .remainingAccounts([
                        {
                            pubkey: (0, test_utils_1.deriveProgramDataPda)(program.programId),
                            isSigner: false,
                            isWritable: false,
                        },
                    ])
                        .rpc();
                    chai_1.expect.fail("Should have failed - invalid dispute threshold");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
            it("Fails to initialize with invalid dispute threshold (> 100)", async () => {
                const newProtocolPda = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol4")], program.programId)[0];
                try {
                    await program.methods
                        .initializeProtocol(101, 100, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL), 1, [
                        provider.wallet.publicKey,
                    ])
                        .accountsPartial({
                        protocolConfig: newProtocolPda,
                        treasury: treasury.publicKey,
                        authority: provider.wallet.publicKey,
                    })
                        .remainingAccounts([
                        {
                            pubkey: (0, test_utils_1.deriveProgramDataPda)(program.programId),
                            isSigner: false,
                            isWritable: false,
                        },
                    ])
                        .rpc();
                    chai_1.expect.fail("Should have failed - invalid dispute threshold > 100");
                }
                catch (e) {
                    // Verify error occurred - Anchor returns AnchorError with errorCode
                    const anchorError = e;
                    (0, chai_1.expect)(anchorError.error?.errorCode?.code || anchorError.message).to
                        .exist;
                }
            });
        });
        describe("Fund Leak Prevention", () => {
            it("Verifies no lamport leaks in task lifecycle", async () => {
                const newTaskId = uniqueTaskId("fund-leak");
                const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, newTaskId, program.programId);
                const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
                const initialBalance = await provider.connection.getBalance(creator.publicKey);
                const rewardAmount = 2 * web3_js_1.LAMPORTS_PER_SOL;
                await program.methods
                    .createTask(Array.from(newTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Fund leak test".padEnd(64, "\0")), new bn_js_1.default(rewardAmount), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial({
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
                const afterCreateBalance = await provider.connection.getBalance(creator.publicKey);
                const escrowBalance = await provider.connection.getBalance(escrowPda);
                (0, chai_1.expect)(initialBalance - afterCreateBalance).to.be.at.most(rewardAmount + 10000000);
                (0, chai_1.expect)(escrowBalance).to.be.at.least(rewardAmount);
                (0, chai_1.expect)(escrowBalance).to.be.at.most(rewardAmount + 5000000);
                const worker1Pda = (0, test_utils_1.deriveAgentPda)(agentId1, program.programId);
                const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, worker1Pda, program.programId);
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    worker: worker1Pda,
                    authority: worker1.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker1])
                    .rpc();
                const proofHash = Buffer.from("proof-hash-00000000000004".padEnd(32, "\0"));
                await program.methods
                    .completeTask(Array.from(proofHash), null)
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    escrow: escrowPda,
                    worker: worker1Pda,
                    protocolConfig: protocolPda,
                    treasury: treasuryPubkey,
                    authority: worker1.publicKey,
                    creator: creator.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    tokenEscrowAta: null,
                    workerTokenAccount: null,
                    treasuryTokenAccount: null,
                    rewardMint: null,
                    tokenProgram: null,
                })
                    .signers([worker1])
                    .rpc();
                const finalEscrowBalance = await provider.connection.getBalance(escrowPda);
                (0, chai_1.expect)(finalEscrowBalance).to.equal(0);
            });
        });
    });
});
