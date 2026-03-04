"use strict";
/**
 * complete_task_private integration tests (LiteSVM).
 *
 * Uses a mock Verifier Router to exercise the full positive path
 * without requiring a real RISC Zero prover.
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
describe("complete_task_private (LiteSVM + mock router)", () => {
    let ctx;
    let program;
    let protocolPda;
    let routerPda;
    let verifierEntryPda;
    const runId = (0, test_utils_1.generateRunId)();
    let treasury;
    let creator;
    let worker;
    let creatorAgentPda;
    let workerAgentPda;
    function taskIdToBn(taskId) {
        return new bn_js_1.default(taskId.subarray(0, 8), "le");
    }
    /**
     * Build and send a completeTaskPrivate transaction with the signer
     * as fee payer. This avoids a second signer/key that would push
     * the transaction over the 1232-byte limit.
     *
     * Uses constructor.name check instead of instanceof because
     * anchor-litesvm's fromWorkspace() bundles its own litesvm module,
     * causing class identity mismatch across module boundaries.
     */
    async function sendCompleteTaskPrivate(params) {
        const signer = params.signer ?? worker;
        const workerAgent = params.workerAgent ?? workerAgentPda;
        const taskCreatorKey = params.taskCreator ?? creator.publicKey;
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
    async function createTaskAndClaim(constraintHash, taskIdBuf, rewardLamports = 0.2 * web3_js_1.LAMPORTS_PER_SOL) {
        const description = (0, test_utils_1.createDescription)("private-router-task");
        const deadline = new bn_js_1.default((0, litesvm_helpers_1.getClockTimestamp)(ctx.svm) + 3600);
        const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskIdBuf, program.programId);
        const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
        const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, program.programId);
        await program.methods
            .createTask(Array.from(taskIdBuf), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), description, new bn_js_1.default(rewardLamports), 1, deadline, test_utils_1.TASK_TYPE_EXCLUSIVE, Array.from(constraintHash), 0, null)
            .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            creatorAgent: creatorAgentPda,
            protocolConfig: protocolPda,
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
    function buildProofForTask(taskPda, workerPubkey, constraintHashBuf, output, salt) {
        const hashes = (0, test_utils_1.computeHashes)(taskPda, workerPubkey, output, salt, TEST_AGENT_SECRET);
        const bindingSeed = (0, test_utils_1.bigintToBytes32)(hashes.binding);
        const nullifierSeed = (0, test_utils_1.bigintToBytes32)(hashes.nullifier);
        const outputCommitment = (0, test_utils_1.bigintToBytes32)(hashes.outputCommitment);
        const journal = (0, test_utils_1.buildTestJournal)({
            taskPda: taskPda.toBuffer(),
            authority: workerPubkey.toBuffer(),
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
        creator = web3_js_1.Keypair.generate();
        worker = web3_js_1.Keypair.generate();
        for (const kp of [treasury, thirdSigner, creator, worker]) {
            (0, litesvm_helpers_1.fundAccount)(ctx.svm, kp.publicKey, 50 * web3_js_1.LAMPORTS_PER_SOL);
        }
        await program.methods
            .initializeProtocol(51, 100, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), 2, [ctx.payer.publicKey, treasury.publicKey, thirdSigner.publicKey])
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
        const creatorAgentId = (0, test_utils_1.makeAgentId)("zkc", runId);
        const workerAgentId = (0, test_utils_1.makeAgentId)("zkw", runId);
        creatorAgentPda = await (0, test_utils_1.ensureAgentRegistered)({
            program,
            protocolPda,
            agentId: creatorAgentId,
            authority: creator,
            capabilities: test_utils_1.CAPABILITY_COMPUTE,
        });
        workerAgentPda = await (0, test_utils_1.ensureAgentRegistered)({
            program,
            protocolPda,
            agentId: workerAgentId,
            authority: worker,
            capabilities: test_utils_1.CAPABILITY_COMPUTE,
        });
    });
    // Advance clock to satisfy rate limit cooldowns between tests
    beforeEach(() => {
        (0, litesvm_helpers_1.advanceClock)(ctx.svm, 2);
    });
    it("completes private task end-to-end with real hashes", async () => {
        const output = [11n, 22n, 33n, 44n];
        const salt = (0, test_utils_1.generateSalt)();
        const constraintHash = (0, test_utils_1.computeConstraintHash)(output);
        const constraintHashBuf = (0, test_utils_1.bigintToBytes32)(constraintHash);
        const taskIdBuf = (0, test_utils_1.makeTaskId)("zkp1", runId);
        const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(constraintHashBuf, taskIdBuf);
        const { proof, bindingSeed, nullifierSeed } = buildProofForTask(taskPda, worker.publicKey, constraintHashBuf, output, salt);
        const bindingSpendPda = (0, test_utils_1.deriveBindingSpendPda)(bindingSeed, program.programId);
        const nullifierSpendPda = (0, test_utils_1.deriveNullifierSpendPda)(nullifierSeed, program.programId);
        const workerBalanceBefore = Number(ctx.svm.getBalance(worker.publicKey));
        await sendCompleteTaskPrivate({
            taskIdBuf,
            proof,
            taskPda,
            claimPda,
            escrowPda,
            bindingSpendPda,
            nullifierSpendPda,
        });
        // Verify task status = Completed
        const taskAccount = await program.account.task.fetch(taskPda);
        (0, chai_1.expect)("completed" in taskAccount.status).to.be.true;
        // Verify BindingSpend PDA exists
        const bindingSpend = await program.account.bindingSpend.fetch(bindingSpendPda);
        (0, chai_1.expect)(Buffer.from(bindingSpend.binding).equals(bindingSeed)).to.be.true;
        (0, chai_1.expect)(bindingSpend.task.equals(taskPda)).to.be.true;
        (0, chai_1.expect)(bindingSpend.agent.equals(workerAgentPda)).to.be.true;
        // Verify NullifierSpend PDA exists
        const nullifierSpend = await program.account.nullifierSpend.fetch(nullifierSpendPda);
        (0, chai_1.expect)(Buffer.from(nullifierSpend.nullifier).equals(nullifierSeed)).to.be.true;
        (0, chai_1.expect)(nullifierSpend.task.equals(taskPda)).to.be.true;
        (0, chai_1.expect)(nullifierSpend.agent.equals(workerAgentPda)).to.be.true;
        // Verify worker balance increased (reward minus tx fee + PDA rent)
        const workerBalanceAfter = Number(ctx.svm.getBalance(worker.publicKey));
        (0, chai_1.expect)(workerBalanceAfter).to.be.greaterThan(workerBalanceBefore - 10000000);
    });
    it("rejects replay with same binding seed", async () => {
        const output = [55n, 66n, 77n, 88n];
        const salt = (0, test_utils_1.generateSalt)();
        const constraintHash = (0, test_utils_1.computeConstraintHash)(output);
        const constraintHashBuf = (0, test_utils_1.bigintToBytes32)(constraintHash);
        const taskIdBuf = (0, test_utils_1.makeTaskId)("zkp2", runId);
        const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(constraintHashBuf, taskIdBuf);
        const { proof, bindingSeed, nullifierSeed } = buildProofForTask(taskPda, worker.publicKey, constraintHashBuf, output, salt);
        // First completion should succeed
        await sendCompleteTaskPrivate({
            taskIdBuf,
            proof,
            taskPda,
            claimPda,
            escrowPda,
            bindingSpendPda: (0, test_utils_1.deriveBindingSpendPda)(bindingSeed, program.programId),
            nullifierSpendPda: (0, test_utils_1.deriveNullifierSpendPda)(nullifierSeed, program.programId),
        });
        // Second task reusing the same binding/nullifier seeds should fail
        (0, litesvm_helpers_1.advanceClock)(ctx.svm, 2); // satisfy rate limit cooldown
        const taskIdBuf2 = (0, test_utils_1.makeTaskId)("zkp2b", runId);
        const { taskPda: task2Pda, escrowPda: escrow2Pda, claimPda: claim2Pda } = await createTaskAndClaim(constraintHashBuf, taskIdBuf2);
        // Build journal for second task but reuse binding/nullifier
        const hashes = (0, test_utils_1.computeHashes)(taskPda, worker.publicKey, output, salt, TEST_AGENT_SECRET);
        const outputCommitment = (0, test_utils_1.bigintToBytes32)(hashes.outputCommitment);
        const journal2 = (0, test_utils_1.buildTestJournal)({
            taskPda: task2Pda.toBuffer(),
            authority: worker.publicKey.toBuffer(),
            constraintHash: constraintHashBuf,
            outputCommitment,
            binding: bindingSeed,
            nullifier: nullifierSeed,
        });
        const proof2 = {
            sealBytes: (0, test_utils_1.buildTestSealBytes)(),
            journal: journal2,
            imageId: Array.from(test_utils_1.TRUSTED_IMAGE_ID),
            bindingSeed: Array.from(bindingSeed),
            nullifierSeed: Array.from(nullifierSeed),
        };
        try {
            await sendCompleteTaskPrivate({
                taskIdBuf: taskIdBuf2,
                proof: proof2,
                taskPda: task2Pda,
                claimPda: claim2Pda,
                escrowPda: escrow2Pda,
                bindingSpendPda: (0, test_utils_1.deriveBindingSpendPda)(bindingSeed, program.programId),
                nullifierSpendPda: (0, test_utils_1.deriveNullifierSpendPda)(nullifierSeed, program.programId),
            });
            chai_1.expect.fail("replay should have been rejected");
        }
        catch (e) {
            if (e instanceof chai_1.AssertionError)
                throw e;
            (0, chai_1.expect)(String(e)).to.not.equal("");
        }
    });
    it("rejects wrong image ID", async () => {
        const output = [99n, 100n, 101n, 102n];
        const salt = (0, test_utils_1.generateSalt)();
        const constraintHash = (0, test_utils_1.computeConstraintHash)(output);
        const constraintHashBuf = (0, test_utils_1.bigintToBytes32)(constraintHash);
        const taskIdBuf = (0, test_utils_1.makeTaskId)("zkp3", runId);
        const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(constraintHashBuf, taskIdBuf);
        const { proof, bindingSeed, nullifierSeed } = buildProofForTask(taskPda, worker.publicKey, constraintHashBuf, output, salt);
        // Tamper with image ID
        const wrongProof = { ...proof, imageId: [...proof.imageId] };
        wrongProof.imageId[0] ^= 0xff;
        try {
            await sendCompleteTaskPrivate({
                taskIdBuf,
                proof: wrongProof,
                taskPda,
                claimPda,
                escrowPda,
                bindingSpendPda: (0, test_utils_1.deriveBindingSpendPda)(bindingSeed, program.programId),
                nullifierSpendPda: (0, test_utils_1.deriveNullifierSpendPda)(nullifierSeed, program.programId),
            });
            chai_1.expect.fail("wrong image ID should have been rejected");
        }
        catch (e) {
            if (e instanceof chai_1.AssertionError)
                throw e;
            (0, chai_1.expect)(String(e)).to.include("InvalidImageId");
        }
    });
    it("rejects wrong constraint hash in journal", async () => {
        const output = [200n, 201n, 202n, 203n];
        const salt = (0, test_utils_1.generateSalt)();
        const constraintHash = (0, test_utils_1.computeConstraintHash)(output);
        const constraintHashBuf = (0, test_utils_1.bigintToBytes32)(constraintHash);
        const taskIdBuf = (0, test_utils_1.makeTaskId)("zkp4", runId);
        const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(constraintHashBuf, taskIdBuf);
        const hashes = (0, test_utils_1.computeHashes)(taskPda, worker.publicKey, output, salt, TEST_AGENT_SECRET);
        const bindingSeed = (0, test_utils_1.bigintToBytes32)(hashes.binding);
        const nullifierSeed = (0, test_utils_1.bigintToBytes32)(hashes.nullifier);
        const outputCommitment = (0, test_utils_1.bigintToBytes32)(hashes.outputCommitment);
        // Build journal with wrong constraint hash
        const wrongConstraintHash = Buffer.from(constraintHashBuf);
        wrongConstraintHash[0] ^= 0xff;
        const journal = (0, test_utils_1.buildTestJournal)({
            taskPda: taskPda.toBuffer(),
            authority: worker.publicKey.toBuffer(),
            constraintHash: wrongConstraintHash,
            outputCommitment,
            binding: bindingSeed,
            nullifier: nullifierSeed,
        });
        const proof = {
            sealBytes: (0, test_utils_1.buildTestSealBytes)(),
            journal,
            imageId: Array.from(test_utils_1.TRUSTED_IMAGE_ID),
            bindingSeed: Array.from(bindingSeed),
            nullifierSeed: Array.from(nullifierSeed),
        };
        try {
            await sendCompleteTaskPrivate({
                taskIdBuf,
                proof,
                taskPda,
                claimPda,
                escrowPda,
                bindingSpendPda: (0, test_utils_1.deriveBindingSpendPda)(bindingSeed, program.programId),
                nullifierSpendPda: (0, test_utils_1.deriveNullifierSpendPda)(nullifierSeed, program.programId),
            });
            chai_1.expect.fail("wrong constraint hash should have been rejected");
        }
        catch (e) {
            if (e instanceof chai_1.AssertionError)
                throw e;
            (0, chai_1.expect)(String(e)).to.include("ConstraintHashMismatch");
        }
    });
    it("rejects low-entropy binding seed", async () => {
        const output = [300n, 301n, 302n, 303n];
        const salt = (0, test_utils_1.generateSalt)();
        const constraintHash = (0, test_utils_1.computeConstraintHash)(output);
        const constraintHashBuf = (0, test_utils_1.bigintToBytes32)(constraintHash);
        const taskIdBuf = (0, test_utils_1.makeTaskId)("zkp5", runId);
        const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(constraintHashBuf, taskIdBuf);
        const hashes = (0, test_utils_1.computeHashes)(taskPda, worker.publicKey, output, salt, TEST_AGENT_SECRET);
        const nullifierSeed = (0, test_utils_1.bigintToBytes32)(hashes.nullifier);
        const outputCommitment = (0, test_utils_1.bigintToBytes32)(hashes.outputCommitment);
        // Low-entropy binding seed (constant fill — only 1 distinct byte)
        const lowEntropyBinding = Buffer.alloc(32, 0xaa);
        const journal = (0, test_utils_1.buildTestJournal)({
            taskPda: taskPda.toBuffer(),
            authority: worker.publicKey.toBuffer(),
            constraintHash: constraintHashBuf,
            outputCommitment,
            binding: lowEntropyBinding,
            nullifier: nullifierSeed,
        });
        const proof = {
            sealBytes: (0, test_utils_1.buildTestSealBytes)(),
            journal,
            imageId: Array.from(test_utils_1.TRUSTED_IMAGE_ID),
            bindingSeed: Array.from(lowEntropyBinding),
            nullifierSeed: Array.from(nullifierSeed),
        };
        try {
            await sendCompleteTaskPrivate({
                taskIdBuf,
                proof,
                taskPda,
                claimPda,
                escrowPda,
                bindingSpendPda: (0, test_utils_1.deriveBindingSpendPda)(lowEntropyBinding, program.programId),
                nullifierSpendPda: (0, test_utils_1.deriveNullifierSpendPda)(nullifierSeed, program.programId),
            });
            chai_1.expect.fail("low-entropy binding should have been rejected");
        }
        catch (e) {
            if (e instanceof chai_1.AssertionError)
                throw e;
            (0, chai_1.expect)(String(e)).to.include("InsufficientSeedEntropy");
        }
    });
});
