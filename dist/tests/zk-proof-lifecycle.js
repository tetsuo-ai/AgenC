"use strict";
/**
 * ZK proof verification lifecycle tests (LiteSVM).
 *
 * Exercises the full private task completion lifecycle with real hash
 * computations and a mock Verifier Router.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bn_js_1 = __importDefault(require("bn.js"));
const chai_1 = require("chai");
const web3_js_1 = require("@solana/web3.js");
const litesvm_helpers_1 = require("./litesvm-helpers");
const test_utils_1 = require("./test-utils");
describe("ZK Proof Verification Lifecycle (LiteSVM)", () => {
    let ctx;
    let program;
    let protocolPda;
    let routerPda;
    let verifierEntryPda;
    const runId = (0, test_utils_1.generateRunId)();
    let treasury;
    let taskCreator;
    let worker;
    let creatorAgentPda;
    let workerAgentPda;
    function taskIdToBn(taskId) {
        return new bn_js_1.default(taskId.subarray(0, 8), "le");
    }
    /**
     * Send completeTaskPrivate with the signer as fee payer to avoid
     * exceeding the 1232-byte transaction limit.
     *
     * Uses constructor.name check instead of instanceof because
     * anchor-litesvm's fromWorkspace() bundles its own litesvm module,
     * causing class identity mismatch across module boundaries.
     */
    async function sendCompleteTaskPrivate(params) {
        const signer = params.signer ?? worker;
        const workerAgent = params.workerAgent ?? workerAgentPda;
        const taskCreatorKey = params.taskCreatorKey ?? taskCreator.publicKey;
        const ix = await program.methods
            .completeTaskPrivate(taskIdToBn(params.taskIdBuf), params.proof)
            .accountsPartial({
            task: params.taskPda,
            claim: params.claimPda,
            escrow: params.escrowPda,
            creator: taskCreatorKey,
            worker: workerAgent,
            protocolConfig: protocolPda,
            bindingSpend: params.bindingSpendPda,
            nullifierSpend: params.nullifierSpendPda,
            treasury: treasury.publicKey,
            authority: signer.publicKey,
            routerProgram: test_utils_1.TRUSTED_ROUTER_PROGRAM_ID,
            router: routerPda,
            verifierEntry: verifierEntryPda,
            verifierProgram: test_utils_1.TRUSTED_VERIFIER_PROGRAM_ID,
            systemProgram: web3_js_1.SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
        })
            .instruction();
        const tx = new web3_js_1.Transaction();
        tx.add(ix);
        tx.feePayer = signer.publicKey;
        tx.recentBlockhash = ctx.svm.latestBlockhash();
        tx.sign(signer);
        const res = ctx.svm.sendTransaction(tx);
        if (res.constructor.name === "FailedTransactionMetadata") {
            const failed = res;
            throw new web3_js_1.SendTransactionError({
                action: "send",
                signature: "unknown",
                transactionMessage: failed.err().toString(),
                logs: failed.meta().logs(),
            });
        }
    }
    async function createPrivateTaskAndClaim(constraintHash, taskIdBuf, taskType = test_utils_1.TASK_TYPE_EXCLUSIVE) {
        const description = (0, test_utils_1.createDescription)("zk-lifecycle-task");
        const deadline = new bn_js_1.default((0, litesvm_helpers_1.getClockTimestamp)(ctx.svm) + 3600);
        const taskPda = (0, test_utils_1.deriveTaskPda)(taskCreator.publicKey, taskIdBuf, program.programId);
        const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
        const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, program.programId);
        await program.methods
            .createTask(Array.from(taskIdBuf), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), description, new bn_js_1.default(0.3 * web3_js_1.LAMPORTS_PER_SOL), taskType === test_utils_1.TASK_TYPE_COMPETITIVE ? 3 : 1, deadline, taskType, Array.from(constraintHash), 0, null)
            .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            creatorAgent: creatorAgentPda,
            protocolConfig: protocolPda,
            authority: taskCreator.publicKey,
            creator: taskCreator.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
        })
            .signers([taskCreator])
            .rpc();
        await program.methods
            .claimTask()
            .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: workerAgentPda,
            protocolConfig: protocolPda,
            authority: worker.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .signers([worker])
            .rpc();
        return { taskPda, escrowPda, claimPda };
    }
    const TEST_AGENT_SECRET = 42n;
    function buildProofForTask(taskPda, workerPublicKey, constraintHashBuf, output, salt) {
        const hashes = (0, test_utils_1.computeHashes)(taskPda, workerPublicKey, output, salt, TEST_AGENT_SECRET);
        const bindingSeed = (0, test_utils_1.bigintToBytes32)(hashes.binding);
        const nullifierSeed = (0, test_utils_1.bigintToBytes32)(hashes.nullifier);
        const outputCommitment = (0, test_utils_1.bigintToBytes32)(hashes.outputCommitment);
        const journal = (0, test_utils_1.buildTestJournal)({
            taskPda: taskPda.toBuffer(),
            authority: workerPublicKey.toBuffer(),
            constraintHash: constraintHashBuf,
            outputCommitment,
            binding: bindingSeed,
            nullifier: nullifierSeed,
        });
        return {
            proof: {
                sealBytes: (0, test_utils_1.buildTestSealBytes)(),
                journal,
                imageId: Array.from(test_utils_1.TRUSTED_IMAGE_ID),
                bindingSeed: Array.from(bindingSeed),
                nullifierSeed: Array.from(nullifierSeed),
            },
            bindingSeed,
            nullifierSeed,
        };
    }
    before(async () => {
        ctx = (0, litesvm_helpers_1.createLiteSVMContext)();
        (0, litesvm_helpers_1.injectMockVerifierRouter)(ctx.svm);
        program = ctx.program;
        protocolPda = (0, test_utils_1.deriveProtocolPda)(program.programId);
        routerPda = (0, test_utils_1.deriveRouterPda)();
        verifierEntryPda = (0, test_utils_1.deriveVerifierEntryPda)();
        treasury = web3_js_1.Keypair.generate();
        const thirdSigner = web3_js_1.Keypair.generate();
        taskCreator = web3_js_1.Keypair.generate();
        worker = web3_js_1.Keypair.generate();
        for (const kp of [treasury, thirdSigner, taskCreator, worker]) {
            (0, litesvm_helpers_1.fundAccount)(ctx.svm, kp.publicKey, 50 * web3_js_1.LAMPORTS_PER_SOL);
        }
        await program.methods
            .initializeProtocol(51, 100, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 10), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), 2, [ctx.payer.publicKey, treasury.publicKey, thirdSigner.publicKey])
            .accountsPartial({
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: ctx.payer.publicKey,
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
        await (0, test_utils_1.disableRateLimitsForTests)({
            program,
            protocolPda,
            authority: ctx.payer.publicKey,
            additionalSigners: [treasury],
        });
        const creatorAgentId = (0, test_utils_1.makeAgentId)("zlc", runId);
        const workerAgentId = (0, test_utils_1.makeAgentId)("zlw", runId);
        creatorAgentPda = await (0, test_utils_1.ensureAgentRegistered)({
            program,
            protocolPda,
            agentId: creatorAgentId,
            authority: taskCreator,
            capabilities: test_utils_1.CAPABILITY_COMPUTE,
            stakeLamports: web3_js_1.LAMPORTS_PER_SOL / 10,
        });
        workerAgentPda = await (0, test_utils_1.ensureAgentRegistered)({
            program,
            protocolPda,
            agentId: workerAgentId,
            authority: worker,
            capabilities: test_utils_1.CAPABILITY_COMPUTE,
            stakeLamports: web3_js_1.LAMPORTS_PER_SOL / 10,
        });
    });
    // Advance clock to satisfy rate limit cooldowns between tests
    beforeEach(() => {
        (0, litesvm_helpers_1.advanceClock)(ctx.svm, 2);
    });
    it("submits complete_task_private with dual-spend + router accounts", async () => {
        const output = [11n, 22n, 33n, 44n];
        const salt = (0, test_utils_1.generateSalt)();
        const constraintHash = (0, test_utils_1.computeConstraintHash)(output);
        const constraintHashBuf = (0, test_utils_1.bigintToBytes32)(constraintHash);
        const taskIdBuf = (0, test_utils_1.makeTaskId)("zl1", runId);
        const { taskPda, escrowPda, claimPda } = await createPrivateTaskAndClaim(constraintHashBuf, taskIdBuf);
        const { proof, bindingSeed, nullifierSeed } = buildProofForTask(taskPda, worker.publicKey, constraintHashBuf, output, salt);
        await sendCompleteTaskPrivate({
            taskIdBuf,
            proof,
            taskPda,
            claimPda,
            escrowPda,
            bindingSpendPda: (0, test_utils_1.deriveBindingSpendPda)(bindingSeed, program.programId),
            nullifierSpendPda: (0, test_utils_1.deriveNullifierSpendPda)(nullifierSeed, program.programId),
        });
        const taskAccount = await program.account.task.fetch(taskPda);
        (0, chai_1.expect)("completed" in taskAccount.status).to.be.true;
        const bindingSpend = await program.account.bindingSpend.fetch((0, test_utils_1.deriveBindingSpendPda)(bindingSeed, program.programId));
        (0, chai_1.expect)(bindingSpend.task.equals(taskPda)).to.be.true;
    });
    it("accepts explicit bindingSeed/nullifierSeed fields in payload", async () => {
        const output = [55n, 66n, 77n, 88n];
        const salt = (0, test_utils_1.generateSalt)();
        const constraintHash = (0, test_utils_1.computeConstraintHash)(output);
        const constraintHashBuf = (0, test_utils_1.bigintToBytes32)(constraintHash);
        const taskIdBuf = (0, test_utils_1.makeTaskId)("zl2", runId);
        const { taskPda, escrowPda, claimPda } = await createPrivateTaskAndClaim(constraintHashBuf, taskIdBuf);
        const { proof, bindingSeed, nullifierSeed } = buildProofForTask(taskPda, worker.publicKey, constraintHashBuf, output, salt);
        await sendCompleteTaskPrivate({
            taskIdBuf,
            proof,
            taskPda,
            claimPda,
            escrowPda,
            bindingSpendPda: (0, test_utils_1.deriveBindingSpendPda)(bindingSeed, program.programId),
            nullifierSpendPda: (0, test_utils_1.deriveNullifierSpendPda)(nullifierSeed, program.programId),
        });
        const taskAccount = await program.account.task.fetch(taskPda);
        (0, chai_1.expect)("completed" in taskAccount.status).to.be.true;
    });
    it("prevents double-completion of competitive private task", async () => {
        const output = [100n, 200n, 300n, 400n];
        const salt = (0, test_utils_1.generateSalt)();
        const constraintHash = (0, test_utils_1.computeConstraintHash)(output);
        const constraintHashBuf = (0, test_utils_1.bigintToBytes32)(constraintHash);
        const taskIdBuf = (0, test_utils_1.makeTaskId)("zl3", runId);
        // Create competitive task (max_workers=3)
        const description = (0, test_utils_1.createDescription)("zk-competitive-task");
        const deadline = new bn_js_1.default((0, litesvm_helpers_1.getClockTimestamp)(ctx.svm) + 3600);
        const taskPda = (0, test_utils_1.deriveTaskPda)(taskCreator.publicKey, taskIdBuf, program.programId);
        const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
        await program.methods
            .createTask(Array.from(taskIdBuf), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), description, new bn_js_1.default(0.3 * web3_js_1.LAMPORTS_PER_SOL), 3, deadline, test_utils_1.TASK_TYPE_COMPETITIVE, Array.from(constraintHashBuf), 0, null)
            .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            creatorAgent: creatorAgentPda,
            protocolConfig: protocolPda,
            authority: taskCreator.publicKey,
            creator: taskCreator.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
        })
            .signers([taskCreator])
            .rpc();
        // Register second worker
        const worker2 = web3_js_1.Keypair.generate();
        (0, litesvm_helpers_1.fundAccount)(ctx.svm, worker2.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL);
        const worker2AgentId = (0, test_utils_1.makeAgentId)("zlw2", runId);
        const worker2AgentPda = await (0, test_utils_1.ensureAgentRegistered)({
            program,
            protocolPda,
            agentId: worker2AgentId,
            authority: worker2,
            capabilities: test_utils_1.CAPABILITY_COMPUTE,
            stakeLamports: web3_js_1.LAMPORTS_PER_SOL / 10,
        });
        // Both workers claim BEFORE any completion
        const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, program.programId);
        await program.methods
            .claimTask()
            .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: workerAgentPda,
            protocolConfig: protocolPda,
            authority: worker.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .signers([worker])
            .rpc();
        const claim2Pda = (0, test_utils_1.deriveClaimPda)(taskPda, worker2AgentPda, program.programId);
        await program.methods
            .claimTask()
            .accountsPartial({
            task: taskPda,
            claim: claim2Pda,
            worker: worker2AgentPda,
            protocolConfig: protocolPda,
            authority: worker2.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .signers([worker2])
            .rpc();
        // First completion succeeds
        const { proof, bindingSeed, nullifierSeed } = buildProofForTask(taskPda, worker.publicKey, constraintHashBuf, output, salt);
        await sendCompleteTaskPrivate({
            taskIdBuf,
            proof,
            taskPda,
            claimPda,
            escrowPda,
            bindingSpendPda: (0, test_utils_1.deriveBindingSpendPda)(bindingSeed, program.programId),
            nullifierSpendPda: (0, test_utils_1.deriveNullifierSpendPda)(nullifierSeed, program.programId),
        });
        // Second completion should fail (competitive tasks enforce completions == 0)
        const salt2 = (0, test_utils_1.generateSalt)();
        const { proof: proof2, bindingSeed: bs2, nullifierSeed: ns2 } = buildProofForTask(taskPda, worker2.publicKey, constraintHashBuf, output, salt2);
        try {
            await sendCompleteTaskPrivate({
                taskIdBuf,
                proof: proof2,
                taskPda,
                claimPda: claim2Pda,
                escrowPda,
                bindingSpendPda: (0, test_utils_1.deriveBindingSpendPda)(bs2, program.programId),
                nullifierSpendPda: (0, test_utils_1.deriveNullifierSpendPda)(ns2, program.programId),
                signer: worker2,
                workerAgent: worker2AgentPda,
            });
            chai_1.expect.fail("double-completion of competitive task should fail");
        }
        catch (e) {
            // Expected: competitive tasks enforce completions == 0 before paying
            if (e.name === "AssertionError")
                throw e;
            (0, chai_1.expect)(String(e)).to.not.equal("");
        }
    });
});
describe("Private Replay Seed Semantics", () => {
    it("derives distinct spend PDAs for distinct binding/nullifier seeds", () => {
        const programId = new web3_js_1.PublicKey("5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7");
        const bindingA = Buffer.alloc(32, 0x21);
        const bindingB = Buffer.alloc(32, 0x22);
        const nullifierA = Buffer.alloc(32, 0x31);
        const nullifierB = Buffer.alloc(32, 0x32);
        const bindingSpendA = (0, test_utils_1.deriveBindingSpendPda)(bindingA, programId);
        const bindingSpendB = (0, test_utils_1.deriveBindingSpendPda)(bindingB, programId);
        const nullifierSpendA = (0, test_utils_1.deriveNullifierSpendPda)(nullifierA, programId);
        const nullifierSpendB = (0, test_utils_1.deriveNullifierSpendPda)(nullifierB, programId);
        (0, chai_1.expect)(bindingSpendA.equals(bindingSpendB)).to.equal(false);
        (0, chai_1.expect)(nullifierSpendA.equals(nullifierSpendB)).to.equal(false);
    });
});
