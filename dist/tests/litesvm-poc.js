"use strict";
/**
 * LiteSVM Proof of Concept — validates all API assumptions before migrating tests.
 *
 * Tests:
 * 1. fromWorkspace() loads the program
 * 2. LiteSVMProvider creates an Anchor-compatible provider
 * 3. Program instance works with IDL
 * 4. ProgramData PDA injection works
 * 5. initialize_protocol succeeds
 * 6. register_agent + create_task + claim_task + complete_task lifecycle
 * 7. provider.connection.getBalance() works
 * 8. provider.connection.getAccountInfo() works (and returns null for missing)
 * 9. SPL Token operations work (createMint, mintTo, getAccount)
 * 10. Clock manipulation works
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bn_js_1 = __importDefault(require("bn.js"));
const chai_1 = require("chai");
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const litesvm_helpers_1 = require("./litesvm-helpers");
const test_utils_1 = require("./test-utils");
describe("litesvm-poc", () => {
    const { svm, provider, program, payer } = (0, litesvm_helpers_1.createLiteSVMContext)({
        splTokens: true,
    });
    const [protocolPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol")], program.programId);
    let treasury;
    let secondSigner;
    let thirdSigner;
    let creator;
    let worker;
    before(() => {
        treasury = web3_js_1.Keypair.generate();
        secondSigner = web3_js_1.Keypair.generate();
        thirdSigner = web3_js_1.Keypair.generate();
        creator = web3_js_1.Keypair.generate();
        worker = web3_js_1.Keypair.generate();
        // Fund accounts instantly (no airdrop latency)
        (0, litesvm_helpers_1.fundAccount)(svm, treasury.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL);
        (0, litesvm_helpers_1.fundAccount)(svm, secondSigner.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL);
        (0, litesvm_helpers_1.fundAccount)(svm, thirdSigner.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL);
        (0, litesvm_helpers_1.fundAccount)(svm, creator.publicKey, 100 * web3_js_1.LAMPORTS_PER_SOL);
        (0, litesvm_helpers_1.fundAccount)(svm, worker.publicKey, 100 * web3_js_1.LAMPORTS_PER_SOL);
    });
    describe("Phase 0: API Validation", () => {
        it("should have a valid program instance", () => {
            (0, chai_1.expect)(program.programId).to.be.instanceOf(web3_js_1.PublicKey);
            (0, chai_1.expect)(program.programId.equals(web3_js_1.PublicKey.default)).to.equal(false);
        });
        it("should initialize protocol successfully", async () => {
            const minStake = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100);
            const minStakeForDispute = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100);
            const programDataPda = (0, test_utils_1.deriveProgramDataPda)(program.programId);
            await program.methods
                .initializeProtocol(51, 100, minStake, minStakeForDispute, 2, [
                provider.wallet.publicKey,
                secondSigner.publicKey,
                thirdSigner.publicKey,
            ])
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
            // Verify protocol was initialized
            const config = await program.account.protocolConfig.fetch(protocolPda);
            (0, chai_1.expect)(config.treasury.toBase58()).to.equal(secondSigner.publicKey.toBase58());
            (0, chai_1.expect)(config.protocolFeeBps).to.equal(100);
        });
        it("should set rate limits to minimums", async () => {
            await program.methods
                .updateRateLimits(new bn_js_1.default(1), // task_creation_cooldown = 1s (minimum allowed)
            255, // max_tasks_per_24h = 255 (effectively unlimited)
            new bn_js_1.default(1), // dispute_initiation_cooldown = 1s (minimum allowed)
            255, // max_disputes_per_24h = 255 (effectively unlimited)
            new bn_js_1.default(test_utils_1.MIN_DISPUTE_STAKE_LAMPORTS))
                .accountsPartial({ protocolConfig: protocolPda })
                .remainingAccounts([
                {
                    pubkey: provider.wallet.publicKey,
                    isSigner: true,
                    isWritable: false,
                },
                {
                    pubkey: secondSigner.publicKey,
                    isSigner: true,
                    isWritable: false,
                },
            ])
                .signers([secondSigner])
                .rpc();
        });
        it("should register an agent", async () => {
            const agentId = Buffer.from("poc-agent-creator".padEnd(32, "\0"));
            const [agentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId], program.programId);
            await program.methods
                .registerAgent(Array.from(agentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://creator.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100))
                .accountsPartial({
                agent: agentPda,
                protocolConfig: protocolPda,
                authority: creator.publicKey,
            })
                .signers([creator])
                .rpc();
            const agent = await program.account.agentRegistration.fetch(agentPda);
            (0, chai_1.expect)(agent.authority.toBase58()).to.equal(creator.publicKey.toBase58());
        });
        it("should create, claim, and complete a task", async () => {
            // Register worker agent
            const workerAgentId = Buffer.from("poc-agent-worker".padEnd(32, "\0"));
            const [workerAgentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), workerAgentId], program.programId);
            await program.methods
                .registerAgent(Array.from(workerAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_INFERENCE), "https://worker.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100))
                .accountsPartial({
                agent: workerAgentPda,
                protocolConfig: protocolPda,
                authority: worker.publicKey,
            })
                .signers([worker])
                .rpc();
            // Create task
            const creatorAgentId = Buffer.from("poc-agent-creator".padEnd(32, "\0"));
            const [creatorAgentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), creatorAgentId], program.programId);
            const taskId = Buffer.from("poc-task-001".padEnd(32, "\0"));
            const [taskPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("task"), creator.publicKey.toBuffer(), taskId], program.programId);
            const [escrowPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda.toBuffer()], program.programId);
            const reward = web3_js_1.LAMPORTS_PER_SOL;
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("PoC task description".padEnd(64, "\0")), new bn_js_1.default(reward), 1, (0, test_utils_1.getDefaultDeadline)(), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, null)
                .accountsPartial({
                task: taskPda,
                escrow: escrowPda,
                creatorAgent: creatorAgentPda,
                authority: creator.publicKey,
                creator: creator.publicKey,
                protocolConfig: protocolPda,
                systemProgram: web3_js_1.SystemProgram.programId,
                rewardMint: null,
                creatorTokenAccount: null,
                tokenEscrowAta: null,
                tokenProgram: null,
                associatedTokenProgram: null,
            })
                .signers([creator])
                .rpc();
            // Verify task created
            const task = await program.account.task.fetch(taskPda);
            (0, chai_1.expect)(task.rewardAmount.toNumber()).to.equal(reward);
            // Claim task
            const [claimPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("claim"), taskPda.toBuffer(), workerAgentPda.toBuffer()], program.programId);
            await program.methods
                .claimTask()
                .accountsPartial({
                task: taskPda,
                claim: claimPda,
                worker: workerAgentPda,
                authority: worker.publicKey,
                protocolConfig: protocolPda,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([worker])
                .rpc();
            // Complete task
            const proofHash = Array.from(Buffer.from("proof".padEnd(32, "\0")));
            const balanceBefore = await provider.connection.getBalance(worker.publicKey);
            await program.methods
                .completeTask(proofHash, null)
                .accountsPartial({
                task: taskPda,
                claim: claimPda,
                escrow: escrowPda,
                creator: creator.publicKey,
                worker: workerAgentPda,
                protocolConfig: protocolPda,
                treasury: secondSigner.publicKey,
                authority: worker.publicKey,
                tokenEscrowAta: null,
                workerTokenAccount: null,
                treasuryTokenAccount: null,
                rewardMint: null,
                tokenProgram: null,
            })
                .signers([worker])
                .rpc();
            // Verify task completed
            const completedTask = await program.account.task.fetch(taskPda);
            (0, chai_1.expect)(completedTask.completions).to.equal(1);
            // Verify worker received reward
            const balanceAfter = await provider.connection.getBalance(worker.publicKey);
            (0, chai_1.expect)(balanceAfter).to.be.greaterThan(balanceBefore);
        });
        it("provider.connection.getBalance() works", async () => {
            const balance = await provider.connection.getBalance(payer.publicKey);
            (0, chai_1.expect)(balance).to.be.a("number");
            (0, chai_1.expect)(balance).to.be.greaterThan(0);
        });
        it("provider.connection.getAccountInfo() returns null for missing accounts", async () => {
            const missing = web3_js_1.Keypair.generate().publicKey;
            const info = await provider.connection.getAccountInfo(missing);
            (0, chai_1.expect)(info).to.be.null;
        });
        it("provider.connection.getAccountInfo() returns data for existing accounts", async () => {
            const info = await provider.connection.getAccountInfo(protocolPda);
            (0, chai_1.expect)(info).to.not.be.null;
            (0, chai_1.expect)(info.data).to.be.instanceOf(Buffer);
            (0, chai_1.expect)(info.data.length).to.be.greaterThan(0);
        });
        it("provider.connection.getSlot() and getBlockTime() work", async () => {
            const slot = await provider.connection.getSlot();
            (0, chai_1.expect)(slot).to.be.a("number");
            const blockTime = await provider.connection.getBlockTime(slot);
            (0, chai_1.expect)(blockTime).to.be.a("number");
        });
        it("clock manipulation works", () => {
            const before = (0, litesvm_helpers_1.getClockTimestamp)(svm);
            (0, litesvm_helpers_1.advanceClock)(svm, 3600); // advance 1 hour
            const after = (0, litesvm_helpers_1.getClockTimestamp)(svm);
            (0, chai_1.expect)(after - before).to.equal(3600);
        });
    });
    describe("SPL Token Operations", () => {
        let mint;
        let payerAta;
        it("should create an SPL token mint", async () => {
            const payerKp = provider.wallet.payer;
            mint = await (0, spl_token_1.createMint)(provider.connection, payerKp, payerKp.publicKey, null, 6);
            (0, chai_1.expect)(mint).to.be.instanceOf(web3_js_1.PublicKey);
        });
        it("should create an associated token account", async () => {
            const payerKp = provider.wallet.payer;
            payerAta = await (0, spl_token_1.createAssociatedTokenAccount)(provider.connection, payerKp, mint, payerKp.publicKey);
            (0, chai_1.expect)(payerAta).to.be.instanceOf(web3_js_1.PublicKey);
        });
        it("should mint tokens", async () => {
            const payerKp = provider.wallet.payer;
            await (0, spl_token_1.mintTo)(provider.connection, payerKp, mint, payerAta, payerKp, 1000000000);
            const account = await (0, spl_token_1.getAccount)(provider.connection, payerAta);
            (0, chai_1.expect)(Number(account.amount)).to.equal(1000000000);
        });
    });
});
