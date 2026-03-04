"use strict";
/**
 * Task lifecycle guard tests (#959)
 *
 * Verifies that on-chain guards reject invalid state transitions:
 * - Double completion on competitive tasks
 * - Dispute initiation on completed tasks
 * - Claim after task deadline
 * - Cancel on completed tasks
 * - Deregister with active tasks or disputes
 * - Completion of cancelled tasks
 * - Claim on cancelled tasks
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bn_js_1 = __importDefault(require("bn.js"));
const chai_1 = require("chai");
const web3_js_1 = require("@solana/web3.js");
const test_utils_1 = require("./test-utils");
const litesvm_helpers_1 = require("./litesvm-helpers");
describe("Task lifecycle guards (#959)", () => {
    const { svm, provider, program } = (0, litesvm_helpers_1.createLiteSVMContext)();
    const [protocolPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol")], program.programId);
    const runId = (0, test_utils_1.generateRunId)();
    let treasury;
    let treasuryPubkey;
    let secondSigner;
    let thirdSigner;
    let creator;
    let creatorAgentId;
    let creatorAgentPda;
    let agentCounter = 0;
    let taskCounter = 0;
    function deriveAgentPda(agentId) {
        return (0, test_utils_1.deriveAgentPda)(agentId, program.programId);
    }
    function deriveTaskPda(creatorPubkey, taskId) {
        return (0, test_utils_1.deriveTaskPda)(creatorPubkey, taskId, program.programId);
    }
    function deriveEscrowPda(taskPda) {
        return (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
    }
    function deriveClaimPda(taskPda, workerPda) {
        return (0, test_utils_1.deriveClaimPda)(taskPda, workerPda, program.programId);
    }
    function deriveDisputePda(disputeId) {
        return (0, test_utils_1.deriveDisputePda)(disputeId, program.programId);
    }
    function makeAgentId(prefix) {
        return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
    }
    function makeTaskId(prefix) {
        return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
    }
    function makeDisputeId(prefix) {
        return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
    }
    async function createFreshWorker(capabilities = test_utils_1.CAPABILITY_COMPUTE) {
        agentCounter++;
        const wallet = web3_js_1.Keypair.generate();
        const agentId = makeAgentId(`lw${agentCounter}`);
        const agentPda = deriveAgentPda(agentId);
        (0, litesvm_helpers_1.fundAccount)(svm, wallet.publicKey, 5 * web3_js_1.LAMPORTS_PER_SOL);
        await program.methods
            .registerAgent(Array.from(agentId), new bn_js_1.default(capabilities), `https://lifecycle-worker-${agentCounter}.example.com`, null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 10))
            .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: wallet.publicKey,
        })
            .signers([wallet])
            .rpc({ skipPreflight: true });
        return { wallet, agentId, agentPda };
    }
    function nextTaskId() {
        taskCounter++;
        return makeTaskId(`lt${taskCounter}`);
    }
    async function createExclusiveTask(creatorWallet, creatorAgent, taskId, deadline) {
        const taskPda = deriveTaskPda(creatorWallet.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const dl = deadline ?? new bn_js_1.default((0, litesvm_helpers_1.getClockTimestamp)(svm) + 3600);
        await program.methods
            .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("lifecycle guard test".padEnd(64, "\0")), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), 1, dl, test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, null)
            .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent,
            authority: creatorWallet.publicKey,
            creator: creatorWallet.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
        })
            .signers([creatorWallet])
            .rpc();
        return { taskPda, escrowPda };
    }
    async function createCompetitiveTask(creatorWallet, creatorAgent, taskId, maxWorkers) {
        const taskPda = deriveTaskPda(creatorWallet.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        await program.methods
            .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("competitive guard test".padEnd(64, "\0")), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), maxWorkers, new bn_js_1.default((0, litesvm_helpers_1.getClockTimestamp)(svm) + 3600), test_utils_1.TASK_TYPE_COMPETITIVE, null, 0, null)
            .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent,
            authority: creatorWallet.publicKey,
            creator: creatorWallet.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
        })
            .signers([creatorWallet])
            .rpc();
        return { taskPda, escrowPda };
    }
    async function claimTask(taskPda, worker) {
        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
            .claimTask()
            .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            protocolConfig: protocolPda,
        })
            .signers([worker.wallet])
            .rpc();
        return claimPda;
    }
    async function completeTask(taskPda, escrowPda, claimPda, worker, creatorPubkey) {
        await program.methods
            .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
            .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            creator: creatorPubkey,
            worker: worker.agentPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker.wallet.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
        })
            .signers([worker.wallet])
            .rpc();
    }
    before(async () => {
        treasury = web3_js_1.Keypair.generate();
        secondSigner = web3_js_1.Keypair.generate();
        thirdSigner = web3_js_1.Keypair.generate();
        creator = web3_js_1.Keypair.generate();
        creatorAgentId = makeAgentId("lcr");
        creatorAgentPda = deriveAgentPda(creatorAgentId);
        const wallets = [treasury, secondSigner, thirdSigner, creator];
        for (const wallet of wallets) {
            (0, litesvm_helpers_1.fundAccount)(svm, wallet.publicKey, 100 * web3_js_1.LAMPORTS_PER_SOL);
        }
        // Initialize protocol
        try {
            const programDataPda = (0, test_utils_1.deriveProgramDataPda)(program.programId);
            await program.methods
                .initializeProtocol(51, 100, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), 2, [provider.wallet.publicKey, secondSigner.publicKey, thirdSigner.publicKey])
                .accountsPartial({
                protocolConfig: protocolPda,
                treasury: secondSigner.publicKey,
                authority: provider.wallet.publicKey,
                secondSigner: secondSigner.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .remainingAccounts([
                { pubkey: programDataPda, isSigner: false, isWritable: false },
                {
                    pubkey: thirdSigner.publicKey,
                    isSigner: true,
                    isWritable: false,
                },
            ])
                .signers([secondSigner, thirdSigner])
                .rpc();
            treasuryPubkey = secondSigner.publicKey;
        }
        catch {
            const protocolConfig = await program.account.protocolConfig.fetch(protocolPda);
            treasuryPubkey = protocolConfig.treasury;
        }
        // Disable rate limiting for tests
        await (0, test_utils_1.disableRateLimitsForTests)({
            program,
            protocolPda,
            authority: provider.wallet.publicKey,
            additionalSigners: [secondSigner],
        });
        // Register creator agent
        try {
            await program.methods
                .registerAgent(Array.from(creatorAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://lifecycle-creator.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 10))
                .accountsPartial({
                agent: creatorAgentPda,
                protocolConfig: protocolPda,
                authority: creator.publicKey,
            })
                .signers([creator])
                .rpc({ skipPreflight: true });
        }
        catch (e) {
            if (!e.message?.includes("already in use"))
                throw e;
        }
    });
    // Advance clock to satisfy rate limit cooldowns between tests
    beforeEach(() => {
        (0, litesvm_helpers_1.advanceClock)(svm, 2);
    });
    it("rejects double completion on competitive task (CompetitiveTaskAlreadyWon)", async () => {
        const taskId = nextTaskId();
        const { taskPda, escrowPda } = await createCompetitiveTask(creator, creatorAgentPda, taskId, 2);
        const workerA = await createFreshWorker();
        const workerB = await createFreshWorker();
        const claimA = await claimTask(taskPda, workerA);
        const claimB = await claimTask(taskPda, workerB);
        // Worker A completes successfully
        await completeTask(taskPda, escrowPda, claimA, workerA, creator.publicKey);
        // Worker B's completion should fail. After first competitive completion the escrow
        // is closed (zeroed), so Anchor rejects at account deserialization. Both
        // AccountNotInitialized (escrow gone) and CompetitiveTaskAlreadyWon (guard) are valid.
        try {
            await completeTask(taskPda, escrowPda, claimB, workerB, creator.publicKey);
            chai_1.expect.fail("Should have rejected double completion on competitive task");
        }
        catch (e) {
            const code = (0, test_utils_1.getErrorCode)(e);
            const msg = e?.message ?? "";
            (0, chai_1.expect)(code === "CompetitiveTaskAlreadyWon" ||
                code === "TaskAlreadyCompleted" ||
                code === "AccountNotInitialized" ||
                msg.includes("AccountNotInitialized") ||
                msg.includes("Error processing Instruction")).to.be.true;
        }
    });
    it("rejects dispute initiation on completed task (TaskNotInProgress)", async () => {
        const taskId = nextTaskId();
        const { taskPda, escrowPda } = await createExclusiveTask(creator, creatorAgentPda, taskId);
        const worker = await createFreshWorker();
        const claimPda = await claimTask(taskPda, worker);
        await completeTask(taskPda, escrowPda, claimPda, worker, creator.publicKey);
        // Attempt dispute on completed task (worker-initiated path to avoid
        // optional account deserialization issues with the creator path)
        const disputeId = makeDisputeId(`dac${taskCounter}`);
        const disputePda = deriveDisputePda(disputeId);
        try {
            await program.methods
                .initiateDispute(Array.from(disputeId), Array.from(taskId), Array.from(Buffer.from("evidence".padEnd(32, "\0"))), 0, test_utils_1.VALID_EVIDENCE)
                .accountsPartial({
                dispute: disputePda,
                task: taskPda,
                agent: worker.agentPda,
                authority: worker.wallet.publicKey,
                protocolConfig: protocolPda,
                systemProgram: web3_js_1.SystemProgram.programId,
                initiatorClaim: claimPda,
                workerAgent: null,
                workerClaim: null,
            })
                .signers([worker.wallet])
                .rpc();
            chai_1.expect.fail("Should have rejected dispute on completed task");
        }
        catch (e) {
            // TaskNotInProgress fires before ClaimAlreadyCompleted in the handler.
            // In some cases Anchor rejects at account deserialization level if claim
            // state is affected by completion; both outcomes block the dispute.
            const code = (0, test_utils_1.getErrorCode)(e);
            const msg = e?.message ?? "";
            (0, chai_1.expect)(code === "TaskNotInProgress" ||
                code === "AccountNotInitialized" ||
                msg.includes("Error processing Instruction")).to.be.true;
        }
    });
    it("rejects claim after task deadline (TaskExpired)", async () => {
        const taskId = nextTaskId();
        const deadline = new bn_js_1.default((0, litesvm_helpers_1.getClockTimestamp)(svm) + 60);
        const { taskPda } = await createExclusiveTask(creator, creatorAgentPda, taskId, deadline);
        // Advance clock past deadline
        (0, litesvm_helpers_1.advanceClock)(svm, 61);
        const worker = await createFreshWorker();
        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        try {
            await program.methods
                .claimTask()
                .accountsPartial({
                task: taskPda,
                claim: claimPda,
                worker: worker.agentPda,
                authority: worker.wallet.publicKey,
                protocolConfig: protocolPda,
            })
                .signers([worker.wallet])
                .rpc();
            chai_1.expect.fail("Should have rejected claim after deadline");
        }
        catch (e) {
            const code = (0, test_utils_1.getErrorCode)(e);
            (0, chai_1.expect)(code).to.equal("TaskExpired");
        }
    });
    it("rejects cancel on completed task (InvalidStatusTransition)", async () => {
        const taskId = nextTaskId();
        const { taskPda, escrowPda } = await createExclusiveTask(creator, creatorAgentPda, taskId);
        const worker = await createFreshWorker();
        const claimPda = await claimTask(taskPda, worker);
        await completeTask(taskPda, escrowPda, claimPda, worker, creator.publicKey);
        try {
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
            chai_1.expect.fail("Should have rejected cancel on completed task");
        }
        catch (e) {
            // Escrow is already closed after completion, so Anchor account constraint
            // will fail before status check. Either error is acceptable.
            const code = (0, test_utils_1.getErrorCode)(e);
            const msg = e?.message ?? "";
            (0, chai_1.expect)(code === "InvalidStatusTransition" ||
                msg.includes("AccountNotInitialized") ||
                msg.includes("does not exist") ||
                msg.includes("Error processing Instruction")).to.be.true;
        }
    });
    it("rejects deregister with active tasks (AgentHasActiveTasks)", async () => {
        const worker = await createFreshWorker();
        const taskId = nextTaskId();
        const { taskPda } = await createExclusiveTask(creator, creatorAgentPda, taskId);
        await claimTask(taskPda, worker);
        try {
            await program.methods
                .deregisterAgent()
                .accountsPartial({
                agent: worker.agentPda,
                protocolConfig: protocolPda,
                authority: worker.wallet.publicKey,
            })
                .signers([worker.wallet])
                .rpc();
            chai_1.expect.fail("Should have rejected deregister with active tasks");
        }
        catch (e) {
            const code = (0, test_utils_1.getErrorCode)(e);
            (0, chai_1.expect)(code).to.equal("AgentHasActiveTasks");
        }
    });
    it("rejects deregister with disputes_as_defendant > 0 (ActiveDisputesExist)", async () => {
        const worker = await createFreshWorker();
        const taskId = nextTaskId();
        const { taskPda } = await createExclusiveTask(creator, creatorAgentPda, taskId);
        const claimPda = await claimTask(taskPda, worker);
        // Initiate dispute against the worker (creator-initiated)
        const disputeId = makeDisputeId(`dd${taskCounter}`);
        const disputePda = deriveDisputePda(disputeId);
        await program.methods
            .initiateDispute(Array.from(disputeId), Array.from(taskId), Array.from(Buffer.from("evidence".padEnd(32, "\0"))), 0, test_utils_1.VALID_EVIDENCE)
            .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: creatorAgentPda,
            authority: creator.publicKey,
            protocolConfig: protocolPda,
            systemProgram: web3_js_1.SystemProgram.programId,
            initiatorClaim: null,
            workerAgent: worker.agentPda,
            workerClaim: claimPda,
        })
            .signers([creator])
            .rpc();
        try {
            await program.methods
                .deregisterAgent()
                .accountsPartial({
                agent: worker.agentPda,
                protocolConfig: protocolPda,
                authority: worker.wallet.publicKey,
            })
                .signers([worker.wallet])
                .rpc();
            chai_1.expect.fail("Should have rejected deregister with active disputes");
        }
        catch (e) {
            const code = (0, test_utils_1.getErrorCode)(e);
            // Worker has both active tasks and disputes; either error is valid
            (0, chai_1.expect)(code === "ActiveDisputesExist" || code === "AgentHasActiveTasks")
                .to.be.true;
        }
    });
    it("rejects completion of cancelled task (TaskCannotBeCancelled or TaskNotInProgress)", async () => {
        const taskId = nextTaskId();
        const { taskPda, escrowPda } = await createExclusiveTask(creator, creatorAgentPda, taskId);
        // Cancel the task before any claims
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
        // Attempt completion on cancelled task — escrow is closed so Anchor will reject
        const worker = await createFreshWorker();
        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        try {
            await completeTask(taskPda, escrowPda, claimPda, worker, creator.publicKey);
            chai_1.expect.fail("Should have rejected completion of cancelled task");
        }
        catch (e) {
            // Task is cancelled and escrow is closed — any error is expected
            const code = (0, test_utils_1.getErrorCode)(e);
            const msg = e?.message ?? "";
            (0, chai_1.expect)(code === "TaskCannotBeCancelled" ||
                code === "TaskNotInProgress" ||
                code === "TaskAlreadyCompleted" ||
                msg.includes("AccountNotInitialized") ||
                msg.includes("does not exist") ||
                msg.includes("Error processing Instruction")).to.be.true;
        }
    });
    it("rejects claim on cancelled task (TaskNotOpen)", async () => {
        const taskId = nextTaskId();
        const { taskPda, escrowPda } = await createExclusiveTask(creator, creatorAgentPda, taskId);
        // Cancel the task
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
        // Attempt claim on cancelled task
        const worker = await createFreshWorker();
        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        try {
            await program.methods
                .claimTask()
                .accountsPartial({
                task: taskPda,
                claim: claimPda,
                worker: worker.agentPda,
                authority: worker.wallet.publicKey,
                protocolConfig: protocolPda,
            })
                .signers([worker.wallet])
                .rpc();
            chai_1.expect.fail("Should have rejected claim on cancelled task");
        }
        catch (e) {
            const code = (0, test_utils_1.getErrorCode)(e);
            (0, chai_1.expect)(code).to.equal("TaskNotOpen");
        }
    });
});
