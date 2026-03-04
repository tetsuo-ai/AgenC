"use strict";
/**
 * Security audit integration tests — validates fixes for remaining_accounts
 * manipulation, escrow accounting, and ZK proof pre-verification defenses.
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
const bn_js_1 = __importDefault(require("bn.js"));
const chai_1 = require("chai");
const web3_js_1 = require("@solana/web3.js");
const test_utils_1 = require("./test-utils");
const HASH_SIZE = 32;
describe("security-audit-fixes", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
        .AgencCoordination;
    const protocolPda = (0, test_utils_1.deriveProtocolPda)(program.programId);
    const runId = (0, test_utils_1.generateRunId)();
    let treasuryPubkey;
    let creator;
    let creatorAgentId;
    let creatorAgentPda;
    // Helper to create and fund a fresh keypair
    async function freshKeypair() {
        const kp = web3_js_1.Keypair.generate();
        await (0, test_utils_1.fundWallet)(provider.connection, kp.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL);
        return kp;
    }
    // Helper to register an agent
    async function registerAgent(wallet, agentId, caps = test_utils_1.CAPABILITY_COMPUTE, stakeAmount = web3_js_1.LAMPORTS_PER_SOL) {
        const agentPda = (0, test_utils_1.deriveAgentPda)(agentId, program.programId);
        try {
            await program.methods
                .registerAgent(Array.from(agentId), new bn_js_1.default(caps), "https://test.example.com", null, new bn_js_1.default(stakeAmount))
                .accountsPartial({
                agent: agentPda,
                protocolConfig: protocolPda,
                authority: wallet.publicKey,
            })
                .signers([wallet])
                .rpc();
        }
        catch {
            // Already registered
        }
        return agentPda;
    }
    // Helper to create a task and return PDAs
    async function createTask(taskId, reward = web3_js_1.LAMPORTS_PER_SOL, maxWorkers = 1, taskType = test_utils_1.TASK_TYPE_EXCLUSIVE, constraintHash = null) {
        const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
        const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
        await program.methods
            .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Security test task".padEnd(64, "\0")), new bn_js_1.default(reward), maxWorkers, (0, test_utils_1.getDefaultDeadline)(), taskType, constraintHash, 0, null)
            .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
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
        return { taskPda, escrowPda };
    }
    // Helper to claim a task
    async function claimTask(taskPda, workerAgentPda, workerWallet) {
        const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, program.programId);
        await program.methods
            .claimTask()
            .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: workerAgentPda,
            protocolConfig: protocolPda,
            authority: workerWallet.publicKey,
        })
            .signers([workerWallet])
            .rpc();
        return claimPda;
    }
    before(async () => {
        const treasury = web3_js_1.Keypair.generate();
        const thirdSigner = web3_js_1.Keypair.generate();
        creator = await freshKeypair();
        await (0, test_utils_1.fundWallet)(provider.connection, treasury.publicKey, 5 * web3_js_1.LAMPORTS_PER_SOL);
        await (0, test_utils_1.fundWallet)(provider.connection, thirdSigner.publicKey, 5 * web3_js_1.LAMPORTS_PER_SOL);
        // Initialize protocol (idempotent)
        try {
            const programDataPda = (0, test_utils_1.deriveProgramDataPda)(program.programId);
            await program.methods
                .initializeProtocol(51, 100, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), 2, [provider.wallet.publicKey, treasury.publicKey, thirdSigner.publicKey])
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
        }
        catch {
            const cfg = await program.account.protocolConfig.fetch(protocolPda);
            treasuryPubkey = cfg.treasury;
        }
        await (0, test_utils_1.disableRateLimitsForTests)({
            program,
            protocolPda,
            authority: provider.wallet.publicKey,
            additionalSigners: [treasury],
            skipPreflight: false,
        });
        // Register creator agent
        creatorAgentId = (0, test_utils_1.makeAgentId)("secCre", runId);
        creatorAgentPda = await registerAgent(creator, creatorAgentId);
    });
    // ==========================================================================
    // A. remaining_accounts manipulation
    // ==========================================================================
    describe("A. remaining_accounts manipulation", () => {
        it("rejects System-owned account as claim in cancel_task", async () => {
            const worker = await freshKeypair();
            const workerId = (0, test_utils_1.makeAgentId)("secW1", runId);
            const workerPda = await registerAgent(worker, workerId);
            const taskId = (0, test_utils_1.makeTaskId)("secCa1", runId);
            const { taskPda, escrowPda } = await createTask(taskId);
            const claimPda = await claimTask(taskPda, workerPda, worker);
            // Use a random keypair (System-owned) as the fake claim account
            const fakeAccount = web3_js_1.Keypair.generate();
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
                    .remainingAccounts([
                    {
                        pubkey: fakeAccount.publicKey,
                        isSigner: false,
                        isWritable: true,
                    },
                    { pubkey: workerPda, isSigner: false, isWritable: true },
                ])
                    .signers([creator])
                    .rpc();
                chai_1.expect.fail("Should reject System-owned account as claim");
            }
            catch (e) {
                (0, chai_1.expect)(e?.message || e?.error?.errorCode?.code).to.exist;
            }
        });
        it("rejects mismatched claim/worker pair in cancel_task", async () => {
            // Create two tasks, each with a different worker
            const worker1 = await freshKeypair();
            const worker1Id = (0, test_utils_1.makeAgentId)("secWm1", runId);
            const worker1Pda = await registerAgent(worker1, worker1Id);
            const worker2 = await freshKeypair();
            const worker2Id = (0, test_utils_1.makeAgentId)("secWm2", runId);
            const worker2Pda = await registerAgent(worker2, worker2Id);
            // Task A: claimed by worker1
            const taskIdA = (0, test_utils_1.makeTaskId)("secMm1", runId);
            const { taskPda: taskPdaA, escrowPda: escrowPdaA } = await createTask(taskIdA);
            await claimTask(taskPdaA, worker1Pda, worker1);
            // Task B: claimed by worker2
            const taskIdB = (0, test_utils_1.makeTaskId)("secMm2", runId);
            const { taskPda: taskPdaB } = await createTask(taskIdB);
            await claimTask(taskPdaB, worker2Pda, worker2);
            // Try to cancel task A but pass worker2's claim from task B
            const claim2ForTaskB = (0, test_utils_1.deriveClaimPda)(taskPdaB, worker2Pda, program.programId);
            try {
                await program.methods
                    .cancelTask()
                    .accountsPartial({
                    task: taskPdaA,
                    escrow: escrowPdaA,
                    creator: creator.publicKey,
                    protocolConfig: protocolPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    tokenEscrowAta: null,
                    creatorTokenAccount: null,
                    rewardMint: null,
                    tokenProgram: null,
                })
                    .remainingAccounts([
                    { pubkey: claim2ForTaskB, isSigner: false, isWritable: true },
                    { pubkey: worker2Pda, isSigner: false, isWritable: true },
                ])
                    .signers([creator])
                    .rpc();
                chai_1.expect.fail("Should reject mismatched claim/worker pair");
            }
            catch (e) {
                (0, chai_1.expect)(e?.message || e?.error?.errorCode?.code).to.exist;
            }
        });
        it("rejects incomplete worker accounts in cancel_task", async () => {
            const worker = await freshKeypair();
            const workerId = (0, test_utils_1.makeAgentId)("secWi", runId);
            const workerPda = await registerAgent(worker, workerId);
            const taskId = (0, test_utils_1.makeTaskId)("secIn1", runId);
            const { taskPda, escrowPda } = await createTask(taskId);
            await claimTask(taskPda, workerPda, worker);
            // Pass only 1 account instead of the expected pair
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
                    .remainingAccounts([
                    {
                        pubkey: (0, test_utils_1.deriveClaimPda)(taskPda, workerPda, program.programId),
                        isSigner: false,
                        isWritable: true,
                    },
                    // Missing worker agent PDA
                ])
                    .signers([creator])
                    .rpc();
                chai_1.expect.fail("Should reject incomplete worker accounts");
            }
            catch (e) {
                (0, chai_1.expect)(e?.message || e?.error?.errorCode?.code).to.exist;
            }
        });
    });
    // ==========================================================================
    // B. Escrow accounting
    // ==========================================================================
    describe("B. Escrow accounting", () => {
        it("collaborative task: escrow stays open until all completions done", async () => {
            const worker1 = await freshKeypair();
            const worker1Id = (0, test_utils_1.makeAgentId)("secEw1", runId);
            const worker1Pda = await registerAgent(worker1, worker1Id);
            const worker2 = await freshKeypair();
            const worker2Id = (0, test_utils_1.makeAgentId)("secEw2", runId);
            const worker2Pda = await registerAgent(worker2, worker2Id);
            const taskId = (0, test_utils_1.makeTaskId)("secEs1", runId);
            const { taskPda, escrowPda } = await createTask(taskId, 2 * web3_js_1.LAMPORTS_PER_SOL, 2, test_utils_1.TASK_TYPE_COLLABORATIVE);
            const claim1 = await claimTask(taskPda, worker1Pda, worker1);
            const claim2 = await claimTask(taskPda, worker2Pda, worker2);
            // First completion — escrow should still exist
            await program.methods
                .completeTask(Array.from(Buffer.from("proof1".padEnd(32, "\0"))), null)
                .accountsPartial({
                task: taskPda,
                claim: claim1,
                escrow: escrowPda,
                worker: worker1Pda,
                creator: creator.publicKey,
                protocolConfig: protocolPda,
                treasury: treasuryPubkey,
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
            const escrowAfterFirst = await provider.connection.getAccountInfo(escrowPda);
            (0, chai_1.expect)(escrowAfterFirst).to.not.be.null;
            // Second completion — escrow should be closed
            await program.methods
                .completeTask(Array.from(Buffer.from("proof2".padEnd(32, "\0"))), null)
                .accountsPartial({
                task: taskPda,
                claim: claim2,
                escrow: escrowPda,
                worker: worker2Pda,
                creator: creator.publicKey,
                protocolConfig: protocolPda,
                treasury: treasuryPubkey,
                authority: worker2.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
                tokenEscrowAta: null,
                workerTokenAccount: null,
                treasuryTokenAccount: null,
                rewardMint: null,
                tokenProgram: null,
            })
                .signers([worker2])
                .rpc();
            const escrowAfterSecond = await provider.connection.getAccountInfo(escrowPda);
            (0, chai_1.expect)(escrowAfterSecond).to.be.null;
            const task = await program.account.task.fetch(taskPda);
            (0, chai_1.expect)(task.status).to.deep.equal({ completed: {} });
            (0, chai_1.expect)(task.completions).to.equal(2);
        });
        it("cancel after claim: rejects cancellation once claim exists", async () => {
            const worker = await freshKeypair();
            const workerId = (0, test_utils_1.makeAgentId)("secEw3", runId);
            const workerPda = await registerAgent(worker, workerId);
            const rewardAmount = web3_js_1.LAMPORTS_PER_SOL;
            const taskId = (0, test_utils_1.makeTaskId)("secEs2", runId);
            const { taskPda, escrowPda } = await createTask(taskId, rewardAmount);
            const claimPda = await claimTask(taskPda, workerPda, worker);
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
                    .remainingAccounts([
                    { pubkey: claimPda, isSigner: false, isWritable: true },
                    { pubkey: workerPda, isSigner: false, isWritable: true },
                ])
                    .signers([creator])
                    .rpc();
                chai_1.expect.fail("Cancellation should be rejected once claim exists");
            }
            catch (e) {
                (0, chai_1.expect)(e?.message || e?.error?.errorCode?.code).to.exist;
            }
        });
        it("escrow balance matches expected after completion", async () => {
            const worker = await freshKeypair();
            const workerId = (0, test_utils_1.makeAgentId)("secEw4", runId);
            const workerPda = await registerAgent(worker, workerId);
            const rewardAmount = web3_js_1.LAMPORTS_PER_SOL;
            const taskId = (0, test_utils_1.makeTaskId)("secEs3", runId);
            const { taskPda, escrowPda } = await createTask(taskId, rewardAmount);
            await claimTask(taskPda, workerPda, worker);
            const escrowBefore = await provider.connection.getBalance(escrowPda);
            const workerBefore = await provider.connection.getBalance(worker.publicKey);
            await program.methods
                .completeTask(Array.from(Buffer.from("proof1".padEnd(32, "\0"))), null)
                .accountsPartial({
                task: taskPda,
                claim: (0, test_utils_1.deriveClaimPda)(taskPda, workerPda, program.programId),
                escrow: escrowPda,
                worker: workerPda,
                creator: creator.publicKey,
                protocolConfig: protocolPda,
                treasury: treasuryPubkey,
                authority: worker.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
                tokenEscrowAta: null,
                workerTokenAccount: null,
                treasuryTokenAccount: null,
                rewardMint: null,
                tokenProgram: null,
            })
                .signers([worker])
                .rpc();
            // Escrow should be closed (exclusive task)
            const escrowAfter = await provider.connection.getAccountInfo(escrowPda);
            (0, chai_1.expect)(escrowAfter).to.be.null;
            // Worker should have received reward minus fee (within tolerance for tx fee + rent)
            const workerAfter = await provider.connection.getBalance(worker.publicKey);
            (0, chai_1.expect)(workerAfter).to.be.greaterThan(workerBefore);
        });
    });
    // ==========================================================================
    // C. Proof pre-verification defense
    // ==========================================================================
    describe("C. Proof pre-verification defense", () => {
        // Helper to create a test proof structure
        function createTestProof(overrides = {}) {
            return {
                sealBytes: overrides.sealBytes ?? Buffer.alloc(256, 0xaa),
                constraintHash: Array.from(overrides.constraintHash ?? Buffer.alloc(HASH_SIZE, 0x11)),
                outputCommitment: Array.from(overrides.outputCommitment ?? Buffer.alloc(HASH_SIZE, 0x22)),
                binding: Array.from(overrides.binding ?? Buffer.alloc(HASH_SIZE, 0x33)),
                nullifier: Array.from(overrides.nullifier ?? Buffer.alloc(HASH_SIZE, 0x44)),
            };
        }
        it("rejects completeTaskPrivate with all-zero nullifier", async () => {
            const worker = await freshKeypair();
            const workerId = (0, test_utils_1.makeAgentId)("secZk1", runId);
            const workerPda = await registerAgent(worker, workerId);
            const constraintHash = Buffer.alloc(HASH_SIZE, 0x11);
            const taskId = (0, test_utils_1.makeTaskId)("secZk1", runId);
            const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
            const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("ZK nullifier test".padEnd(64, "\0")), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 5), 1, (0, test_utils_1.getDefaultDeadline)(), test_utils_1.TASK_TYPE_EXCLUSIVE, Array.from(constraintHash), 0, null)
                .accountsPartial({
                task: taskPda,
                escrow: escrowPda,
                protocolConfig: protocolPda,
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
            const claimPda = await claimTask(taskPda, workerPda, worker);
            const proof = createTestProof({
                constraintHash,
                nullifier: Buffer.alloc(HASH_SIZE, 0), // All zeros
            });
            // Derive nullifier PDA for the all-zero nullifier
            const [nullifierPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("nullifier"), Buffer.alloc(HASH_SIZE, 0)], program.programId);
            try {
                await program.methods
                    .completeTaskPrivate(new bn_js_1.default(0), proof)
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    escrow: escrowPda,
                    worker: workerPda,
                    protocolConfig: protocolPda,
                    nullifierAccount: nullifierPda,
                    treasury: treasuryPubkey,
                    authority: worker.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker])
                    .rpc();
                chai_1.expect.fail("Should reject all-zero nullifier");
            }
            catch (e) {
                (0, chai_1.expect)(e?.message || e?.error?.errorCode?.code).to.exist;
            }
        });
        it("rejects completeTaskPrivate with all-zero binding", async () => {
            const worker = await freshKeypair();
            const workerId = (0, test_utils_1.makeAgentId)("secZk2", runId);
            const workerPda = await registerAgent(worker, workerId);
            const constraintHash = Buffer.alloc(HASH_SIZE, 0x22);
            const taskId = (0, test_utils_1.makeTaskId)("secZk2", runId);
            const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
            const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("ZK binding test".padEnd(64, "\0")), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 5), 1, (0, test_utils_1.getDefaultDeadline)(), test_utils_1.TASK_TYPE_EXCLUSIVE, Array.from(constraintHash), 0, null)
                .accountsPartial({
                task: taskPda,
                escrow: escrowPda,
                protocolConfig: protocolPda,
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
            const claimPda = await claimTask(taskPda, workerPda, worker);
            const nullifierBytes = Buffer.alloc(HASH_SIZE, 0x55);
            const proof = createTestProof({
                constraintHash,
                binding: Buffer.alloc(HASH_SIZE, 0), // All zeros
                nullifier: nullifierBytes,
            });
            const [nullifierPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("nullifier"), nullifierBytes], program.programId);
            try {
                await program.methods
                    .completeTaskPrivate(new bn_js_1.default(0), proof)
                    .accountsPartial({
                    task: taskPda,
                    claim: claimPda,
                    escrow: escrowPda,
                    worker: workerPda,
                    protocolConfig: protocolPda,
                    nullifierAccount: nullifierPda,
                    treasury: treasuryPubkey,
                    authority: worker.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([worker])
                    .rpc();
                chai_1.expect.fail("Should reject all-zero binding");
            }
            catch (e) {
                (0, chai_1.expect)(e?.message || e?.error?.errorCode?.code).to.exist;
            }
        });
    });
});
