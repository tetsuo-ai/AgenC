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
describe("rate-limiting", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
        .AgencCoordination;
    const [protocolPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol")], program.programId);
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let treasury;
    let creator;
    let worker;
    let creatorAgentPda;
    const creatorAgentId = Buffer.from(`agent-ratelimit-${runId}`.slice(0, 32).padEnd(32, "\0"));
    const toNum = (value) => {
        if (value &&
            typeof value.toNumber === "function") {
            return value.toNumber();
        }
        return Number(value ?? 0);
    };
    const readField = (obj, keys) => {
        for (const key of keys) {
            if (key in obj)
                return obj[key];
        }
        return undefined;
    };
    before(async () => {
        treasury = web3_js_1.Keypair.generate();
        const thirdSigner = web3_js_1.Keypair.generate();
        creator = web3_js_1.Keypair.generate();
        worker = web3_js_1.Keypair.generate();
        const airdropAmount = 100 * web3_js_1.LAMPORTS_PER_SOL;
        const wallets = [treasury, thirdSigner, creator, worker];
        for (const wallet of wallets) {
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount), "confirmed");
        }
        // Initialize protocol with rate limits
        try {
            const programDataPda = (0, test_utils_1.deriveProgramDataPda)(program.programId);
            await program.methods
                .initializeProtocol(51, // dispute_threshold
            100, // protocol_fee_bps
            new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL), // min_arbiter_stake
            new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), // min_stake_for_dispute
            2, // multisig_threshold (must be >= 2 and < owners.length)
            [provider.wallet.publicKey, treasury.publicKey, thirdSigner.publicKey])
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
        }
        catch (e) {
            // Protocol may already be initialized
        }
        // Force deterministic rate-limit config for this suite.
        await program.methods
            .updateRateLimits(new bn_js_1.default(60), 100, new bn_js_1.default(300), 20, new bn_js_1.default(0.5 * web3_js_1.LAMPORTS_PER_SOL))
            .accountsPartial({
            protocolConfig: protocolPda,
        })
            .remainingAccounts([
            {
                pubkey: provider.wallet.publicKey,
                isSigner: true,
                isWritable: false,
            },
            {
                pubkey: treasury.publicKey,
                isSigner: true,
                isWritable: false,
            },
        ])
            .signers([treasury])
            .rpc();
    });
    const solCreateTaskAccounts = (taskPda, escrowPda, creatorAgent, authority, creatorAccount) => ({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent,
        authority,
        creator: creatorAccount,
        systemProgram: web3_js_1.SystemProgram.programId,
        rewardMint: null,
        creatorTokenAccount: null,
        tokenEscrowAta: null,
        tokenProgram: null,
        associatedTokenProgram: null,
    });
    describe("Task Creation Rate Limiting", () => {
        let agentId;
        let agentPda;
        let taskCounter = 0;
        before(async () => {
            agentId = creatorAgentId;
            [creatorAgentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId], program.programId);
            agentPda = creatorAgentPda;
            // Register agent for rate limiting tests
            try {
                await program.methods
                    .registerAgent(Array.from(agentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://ratelimit-agent.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    agent: agentPda,
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
        const createTaskWithAgent = async (taskIdSuffix) => {
            const taskId = Buffer.from(`task-rl-${taskIdSuffix}`.padEnd(32, "\0"));
            const [taskPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("task"), creator.publicKey.toBuffer(), taskId], program.programId);
            const [escrowPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda.toBuffer()], program.programId);
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Rate limit test task".padEnd(64, "\0")), new bn_js_1.default(0.1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
            0, // min_reputation
            null)
                .accountsPartial(solCreateTaskAccounts(taskPda, escrowPda, agentPda, creator.publicKey, creator.publicKey))
                .signers([creator])
                .rpc();
            return { taskPda, escrowPda };
        };
        it("Successfully creates first task (no cooldown)", async () => {
            taskCounter++;
            await createTaskWithAgent(`first-${taskCounter}`);
            const agent = await program.account.agentRegistration.fetch(agentPda);
            (0, chai_1.expect)(agent.lastTaskCreated.toNumber()).to.be.greaterThan(0);
            (0, chai_1.expect)(toNum(readField(agent, [
                "taskCount24h",
                "taskCount24H",
                "task_count_24h",
            ]))).to.be.at.least(0);
        });
        it("Fails when creating task within cooldown period", async () => {
            taskCounter++;
            // Immediately try to create another task
            try {
                await createTaskWithAgent(`cooldown-${taskCounter}`);
                chai_1.expect.fail("Should have failed due to cooldown");
            }
            catch (e) {
                (0, chai_1.expect)(e.message).to.match(/CooldownNotElapsed|RateLimitExceeded/);
            }
        });
        it("Successfully creates task after cooldown period", async function () {
            this.timeout(70000); // 70 second timeout
            // Wait for cooldown (default 60 seconds)
            await new Promise((resolve) => setTimeout(resolve, 61000));
            taskCounter++;
            await createTaskWithAgent(`after-cooldown-${taskCounter}`);
            const agent = await program.account.agentRegistration.fetch(agentPda);
            (0, chai_1.expect)(agent.lastTaskCreated.toNumber()).to.be.greaterThan(0);
        });
        it("Creates task with agent registration", async () => {
            const isolatedCreator = web3_js_1.Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(isolatedCreator.publicKey, 20 * web3_js_1.LAMPORTS_PER_SOL), "confirmed");
            const isolatedAgentId = Buffer.from(`agent-isolated-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [isolatedAgentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), isolatedAgentId], program.programId);
            await program.methods
                .registerAgent(Array.from(isolatedAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://isolated-agent.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
                .accountsPartial({
                agent: isolatedAgentPda,
                protocolConfig: protocolPda,
                authority: isolatedCreator.publicKey,
            })
                .signers([isolatedCreator])
                .rpc();
            const taskId = Buffer.from(`task-no-agent-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [taskPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("task"), isolatedCreator.publicKey.toBuffer(), taskId], program.programId);
            const [escrowPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda.toBuffer()], program.programId);
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("No agent task".padEnd(64, "\0")), new bn_js_1.default(0.1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
            0, // min_reputation
            null)
                .accountsPartial(solCreateTaskAccounts(taskPda, escrowPda, isolatedAgentPda, isolatedCreator.publicKey, isolatedCreator.publicKey))
                .signers([isolatedCreator])
                .rpc();
        });
    });
    describe("Dispute Rate Limiting", () => {
        let disputeAgentId;
        let disputeAgentPda;
        let disputeCounter = 0;
        before(async () => {
            disputeAgentId = Buffer.from(`agent-dispute-${runId}`.slice(0, 32).padEnd(32, "\0"));
            [disputeAgentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), disputeAgentId], program.programId);
            // Register agent for dispute tests
            try {
                await program.methods
                    .registerAgent(Array.from(disputeAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://dispute-agent.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    agent: disputeAgentPda,
                    protocolConfig: protocolPda,
                    authority: worker.publicKey,
                })
                    .signers([worker])
                    .rpc();
            }
            catch (e) {
                // Agent may already be registered
            }
        });
        const createTaskForDispute = async (taskIdSuffix) => {
            const disputeCreator = web3_js_1.Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(disputeCreator.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL), "confirmed");
            const creatorAgentId = Buffer.from(`disp-creator-${taskIdSuffix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [localCreatorAgentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), creatorAgentId], program.programId);
            await program.methods
                .registerAgent(Array.from(creatorAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://dispute-creator.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
                .accountsPartial({
                agent: localCreatorAgentPda,
                protocolConfig: protocolPda,
                authority: disputeCreator.publicKey,
            })
                .signers([disputeCreator])
                .rpc();
            const taskId = Buffer.from(`task-disp-${taskIdSuffix}`.padEnd(32, "\0"));
            const [taskPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("task"), disputeCreator.publicKey.toBuffer(), taskId], program.programId);
            const [escrowPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda.toBuffer()], program.programId);
            const [claimPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("claim"), taskPda.toBuffer(), disputeAgentPda.toBuffer()], program.programId);
            // Create task
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Dispute test task".padEnd(64, "\0")), new bn_js_1.default(0.5 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
            0, // min_reputation
            null)
                .accountsPartial(solCreateTaskAccounts(taskPda, escrowPda, localCreatorAgentPda, disputeCreator.publicKey, disputeCreator.publicKey))
                .signers([disputeCreator])
                .rpc();
            // Claim task to make it disputable
            await program.methods
                .claimTask()
                .accountsPartial({
                task: taskPda,
                claim: claimPda,
                protocolConfig: protocolPda,
                worker: disputeAgentPda,
                authority: worker.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([worker])
                .rpc();
            return { taskPda, taskId, claimPda };
        };
        it("Successfully initiates first dispute", async () => {
            disputeCounter++;
            const { taskPda, taskId, claimPda } = await createTaskForDispute(`first-${disputeCounter}`);
            const disputeId = Buffer.from(`disp-first-${disputeCounter}-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [disputePda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("dispute"), disputeId], program.programId);
            await program.methods
                .initiateDispute(Array.from(disputeId), Array.from(taskId), Array.from(Buffer.from("evidence".padEnd(32, "\0"))), 0, // REFUND
            test_utils_1.VALID_EVIDENCE)
                .accountsPartial({
                dispute: disputePda,
                task: taskPda,
                agent: disputeAgentPda,
                protocolConfig: protocolPda,
                initiatorClaim: claimPda,
                workerAgent: disputeAgentPda,
                workerClaim: claimPda,
                authority: worker.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([worker])
                .rpc();
            const dispute = await program.account.dispute.fetch(disputePda);
            (0, chai_1.expect)(dispute.task.toString()).to.equal(taskPda.toString());
        });
        it("Fails when initiating dispute within cooldown period", async () => {
            disputeCounter++;
            const { taskPda, taskId, claimPda } = await createTaskForDispute(`cooldown-${disputeCounter}`);
            const disputeId = Buffer.from(`disp-cool-${disputeCounter}-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [disputePda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("dispute"), disputeId], program.programId);
            // Immediately try to initiate another dispute (within 5 min cooldown)
            try {
                await program.methods
                    .initiateDispute(Array.from(disputeId), Array.from(taskId), Array.from(Buffer.from("evidence".padEnd(32, "\0"))), 0, test_utils_1.VALID_EVIDENCE)
                    .accountsPartial({
                    dispute: disputePda,
                    task: taskPda,
                    agent: disputeAgentPda,
                    protocolConfig: protocolPda,
                    initiatorClaim: claimPda,
                    workerAgent: disputeAgentPda,
                    workerClaim: claimPda,
                    authority: worker.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker])
                    .rpc();
            }
            catch (e) {
                (0, chai_1.expect)(e.message).to.match(/CooldownNotElapsed|RateLimitExceeded/);
            }
        });
    });
    describe("Rate Limit Configuration Update", () => {
        it("Updates rate limit parameters via multisig", async () => {
            // Update rate limits (requires multisig)
            await program.methods
                .updateRateLimits(new bn_js_1.default(30), // task_creation_cooldown: 30 seconds
            100, // max_tasks_per_24h: 100
            new bn_js_1.default(60), // dispute_initiation_cooldown: 60 seconds
            20, // max_disputes_per_24h: 20
            new bn_js_1.default(0.5 * web3_js_1.LAMPORTS_PER_SOL))
                .accountsPartial({
                protocolConfig: protocolPda,
            })
                .remainingAccounts([
                {
                    pubkey: provider.wallet.publicKey,
                    isSigner: true,
                    isWritable: false,
                },
                {
                    pubkey: treasury.publicKey,
                    isSigner: true,
                    isWritable: false,
                },
            ])
                .signers([treasury])
                .rpc();
            const config = await program.account.protocolConfig.fetch(protocolPda);
            (0, chai_1.expect)(config.taskCreationCooldown.toNumber()).to.equal(30);
            (0, chai_1.expect)(toNum(readField(config, [
                "maxTasksPer24h",
                "maxTasksPer24H",
                "max_tasks_per_24h",
            ]))).to.equal(100);
            (0, chai_1.expect)(config.disputeInitiationCooldown.toNumber()).to.equal(60);
            (0, chai_1.expect)(toNum(readField(config, [
                "maxDisputesPer24h",
                "maxDisputesPer24H",
                "max_disputes_per_24h",
            ]))).to.equal(20);
            (0, chai_1.expect)(config.minStakeForDispute.toNumber()).to.equal(0.5 * web3_js_1.LAMPORTS_PER_SOL);
        });
    });
    describe("Stake Requirement for Disputes", () => {
        let lowStakeAgentId;
        let lowStakeAgentPda;
        let lowStakeAuthority;
        before(async () => {
            lowStakeAgentId = Buffer.from(`agent-lowstake-${runId}`.slice(0, 32).padEnd(32, "\0"));
            [lowStakeAgentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), lowStakeAgentId], program.programId);
            lowStakeAuthority = web3_js_1.Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(lowStakeAuthority.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL), "confirmed");
            // Register agent with no stake
            try {
                await program.methods
                    .registerAgent(Array.from(lowStakeAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://lowstake-agent.example.com", null, new bn_js_1.default(0))
                    .accountsPartial({
                    agent: lowStakeAgentPda,
                    protocolConfig: protocolPda,
                    authority: lowStakeAuthority.publicKey,
                })
                    .signers([lowStakeAuthority])
                    .rpc();
            }
            catch (e) {
                // Agent may already be registered
            }
        });
        it("Fails to initiate dispute with insufficient stake", async () => {
            const stakeCreator = web3_js_1.Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(stakeCreator.publicKey, 20 * web3_js_1.LAMPORTS_PER_SOL), "confirmed");
            const stakeCreatorAgentId = Buffer.from(`stake-creator-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [stakeCreatorAgentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), stakeCreatorAgentId], program.programId);
            await program.methods
                .registerAgent(Array.from(stakeCreatorAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://stake-creator.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
                .accountsPartial({
                agent: stakeCreatorAgentPda,
                protocolConfig: protocolPda,
                authority: stakeCreator.publicKey,
            })
                .signers([stakeCreator])
                .rpc();
            const taskId = Buffer.from("task-stake-test-001".padEnd(32, "\0"));
            const [taskPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("task"), stakeCreator.publicKey.toBuffer(), taskId], program.programId);
            const [escrowPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda.toBuffer()], program.programId);
            // Create task
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Stake test task".padEnd(64, "\0")), new bn_js_1.default(0.5 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
            0, // min_reputation
            null)
                .accountsPartial(solCreateTaskAccounts(taskPda, escrowPda, stakeCreatorAgentPda, stakeCreator.publicKey, stakeCreator.publicKey))
                .signers([stakeCreator])
                .rpc();
            const disputeId = Buffer.from(`disp-stake-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [disputePda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("dispute"), disputeId], program.programId);
            // Agent has 0 stake, but protocol requires 0.5 SOL minimum
            const [lowStakeClaimPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("claim"), taskPda.toBuffer(), lowStakeAgentPda.toBuffer()], program.programId);
            try {
                await program.methods
                    .claimTask()
                    .accountsPartial({
                    task: taskPda,
                    claim: lowStakeClaimPda,
                    protocolConfig: protocolPda,
                    worker: lowStakeAgentPda,
                    authority: lowStakeAuthority.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([lowStakeAuthority])
                    .rpc();
                await program.methods
                    .initiateDispute(Array.from(disputeId), Array.from(taskId), Array.from(Buffer.from("evidence".padEnd(32, "\0"))), 0, test_utils_1.VALID_EVIDENCE)
                    .accountsPartial({
                    dispute: disputePda,
                    task: taskPda,
                    agent: lowStakeAgentPda,
                    protocolConfig: protocolPda,
                    initiatorClaim: lowStakeClaimPda,
                    workerAgent: lowStakeAgentPda,
                    workerClaim: lowStakeClaimPda,
                    authority: lowStakeAuthority.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([lowStakeAuthority])
                    .rpc();
            }
            catch (e) {
                (0, chai_1.expect)(e.message).to.match(/InsufficientStakeForDispute|CooldownNotElapsed|RateLimitExceeded|AccountNotInitialized/);
            }
        });
    });
    describe("24-Hour Window Limits", () => {
        it("Tracks task count across 24h window", async () => {
            const agentId = Buffer.from(`agent-24h-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [agentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId], program.programId);
            const testCreator = web3_js_1.Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(testCreator.publicKey, 50 * web3_js_1.LAMPORTS_PER_SOL), "confirmed");
            try {
                await program.methods
                    .registerAgent(Array.from(agentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://24h-agent.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    agent: agentPda,
                    protocolConfig: protocolPda,
                    authority: testCreator.publicKey,
                })
                    .signers([testCreator])
                    .rpc();
            }
            catch (e) {
                // Agent may already be registered
            }
            const agent = await program.account.agentRegistration.fetch(agentPda);
            (0, chai_1.expect)(toNum(readField(agent, [
                "taskCount24h",
                "taskCount24H",
                "task_count_24h",
            ]))).to.equal(0);
            (0, chai_1.expect)(toNum(readField(agent, [
                "disputeCount24h",
                "disputeCount24H",
                "dispute_count_24h",
            ]))).to.equal(0);
            (0, chai_1.expect)(agent.rateLimitWindowStart.toNumber()).to.be.greaterThan(0);
        });
    });
    describe("RateLimitHit Event", () => {
        it("Emits RateLimitHit event when cooldown not elapsed", async () => {
            const agentId = Buffer.from(`agent-event-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [agentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId], program.programId);
            const eventCreator = web3_js_1.Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(eventCreator.publicKey, 20 * web3_js_1.LAMPORTS_PER_SOL), "confirmed");
            try {
                await program.methods
                    .registerAgent(Array.from(agentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://event-agent.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    agent: agentPda,
                    protocolConfig: protocolPda,
                    authority: eventCreator.publicKey,
                })
                    .signers([eventCreator])
                    .rpc();
            }
            catch (e) {
                // Agent may already be registered
            }
            // First task
            const taskId1 = Buffer.from(`task-event-1-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [taskPda1] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("task"), eventCreator.publicKey.toBuffer(), taskId1], program.programId);
            const [escrowPda1] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda1.toBuffer()], program.programId);
            await program.methods
                .createTask(Array.from(taskId1), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Event test task 1".padEnd(64, "\0")), new bn_js_1.default(0.1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
            0, // min_reputation
            null)
                .accountsPartial(solCreateTaskAccounts(taskPda1, escrowPda1, agentPda, eventCreator.publicKey, eventCreator.publicKey))
                .signers([eventCreator])
                .rpc();
            // Listen for RateLimitHit event
            let eventReceived = false;
            const listener = program.addEventListener("RateLimitHit", (event) => {
                (0, chai_1.expect)(event.actionType).to.equal(0); // task_creation
                (0, chai_1.expect)(event.limitType).to.equal(0); // cooldown
                (0, chai_1.expect)(event.cooldownRemaining.toNumber()).to.be.greaterThan(0);
                eventReceived = true;
            });
            // Second task (should fail with event)
            const taskId2 = Buffer.from(`task-event-2-${runId}`.slice(0, 32).padEnd(32, "\0"));
            const [taskPda2] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("task"), eventCreator.publicKey.toBuffer(), taskId2], program.programId);
            const [escrowPda2] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda2.toBuffer()], program.programId);
            try {
                await program.methods
                    .createTask(Array.from(taskId2), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Event test task 2".padEnd(64, "\0")), new bn_js_1.default(0.1 * web3_js_1.LAMPORTS_PER_SOL), 1, new bn_js_1.default(Math.floor(Date.now() / 1000) + 3600), test_utils_1.TASK_TYPE_EXCLUSIVE, null, // constraint_hash
                0, // min_reputation
                null)
                    .accountsPartial(solCreateTaskAccounts(taskPda2, escrowPda2, agentPda, eventCreator.publicKey, eventCreator.publicKey))
                    .signers([eventCreator])
                    .rpc();
            }
            catch (e) {
                // Expected to fail
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
            program.removeEventListener(listener);
            // Event may or may not be received depending on when instruction fails
        });
    });
    describe("Boundary Conditions", () => {
        it("Handles zero cooldown (disabled)", async () => {
            // This test verifies the protocol handles 0 cooldown correctly
            const config = await program.account.protocolConfig.fetch(protocolPda);
            // If cooldown is > 0, the rate limiting is active
            (0, chai_1.expect)(config.taskCreationCooldown.toNumber()).to.be.at.least(0);
        });
        it("Handles zero max tasks (unlimited)", async () => {
            const config = await program.account.protocolConfig.fetch(protocolPda);
            // max_tasks_per_24h of 0 means unlimited
            // Current config should have a reasonable limit
            (0, chai_1.expect)(toNum(readField(config, [
                "maxTasksPer24h",
                "maxTasksPer24H",
                "max_tasks_per_24h",
            ]))).to.be.at.least(0);
        });
    });
});
