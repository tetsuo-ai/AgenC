"use strict";
/**
 * SPL Token Task Integration Tests (Issue #860)
 *
 * Tests the optional SPL token escrow support added in PR #864.
 * Verifies token-denominated task creation, completion, cancellation,
 * and dispute initiation across all supported task types.
 *
 * Test Strategy:
 * - Happy path: create, claim, complete, cancel with SPL tokens
 * - Edge cases: SOL regression, missing accounts, insufficient balance,
 *   competitive/collaborative token tasks, minimum amounts, 0-decimal mints
 * - Fee verification: protocol fees in tokens, not SOL
 * - Dispute preconditions: initiate + vote on token tasks (resolution
 *   requires time warp, so only preconditions are tested)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bn_js_1 = __importDefault(require("bn.js"));
const chai_1 = require("chai");
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const test_utils_1 = require("./test-utils");
const litesvm_helpers_1 = require("./litesvm-helpers");
describe("spl-token-tasks (issue #860)", () => {
    const { svm, provider, program, payer: payerKp, } = (0, litesvm_helpers_1.createLiteSVMContext)({ splTokens: true });
    const [protocolPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol")], program.programId);
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // Wallets
    let treasury;
    let treasuryPubkey;
    let secondSigner;
    let thirdSigner;
    let creator;
    let worker;
    let worker2;
    let arbiter1;
    let arbiter2;
    let arbiter3;
    // Agent IDs
    let creatorAgentId;
    let workerAgentId;
    let worker2AgentId;
    let arbiter1AgentId;
    let arbiter2AgentId;
    let arbiter3AgentId;
    // Token state
    let mint;
    let creatorAta;
    let workerAta;
    let worker2Ata;
    let treasuryAta;
    // 0-decimal mint for edge case
    let zeroDecMint;
    let zeroDecCreatorAta;
    let zeroDecWorkerAta;
    let zeroDecTreasuryAta;
    // Protocol fee: 100 bps = 1%
    const PROTOCOL_FEE_BPS = 100;
    const VALID_EVIDENCE = "This is valid dispute evidence that exceeds the minimum 50 character requirement for the dispute system.";
    let minAgentStake = web3_js_1.LAMPORTS_PER_SOL;
    let minArbiterStake = web3_js_1.LAMPORTS_PER_SOL;
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    function makeId(prefix) {
        return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
    }
    const deriveAgentPda = (agentId) => web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId], program.programId)[0];
    const deriveTaskPda = (creatorKey, taskId) => web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("task"), creatorKey.toBuffer(), taskId], program.programId)[0];
    const deriveEscrowPda = (taskPda) => web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda.toBuffer()], program.programId)[0];
    const deriveClaimPda = (taskPda, workerPda) => web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()], program.programId)[0];
    const deriveDisputePda = (disputeId) => web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("dispute"), disputeId], program.programId)[0];
    const deriveVotePda = (disputePda, arbiterPda) => web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()], program.programId)[0];
    const deriveAuthorityVotePda = (disputePda, authorityPubkey) => web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("authority_vote"),
        disputePda.toBuffer(),
        authorityPubkey.toBuffer(),
    ], program.programId)[0];
    /** Derive escrow's ATA for the given mint (allowOwnerOffCurve for PDA) */
    const deriveEscrowAta = (tokenMint, escrowPda) => (0, spl_token_1.getAssociatedTokenAddressSync)(tokenMint, escrowPda, true);
    /** Fetch token balance as bigint */
    async function getTokenBalance(ata) {
        const acct = await (0, spl_token_1.getAccount)(provider.connection, ata);
        return acct.amount;
    }
    const airdrop = (wallets, amount = 20 * web3_js_1.LAMPORTS_PER_SOL) => {
        for (const wallet of wallets) {
            (0, litesvm_helpers_1.fundAccount)(svm, wallet.publicKey, amount);
        }
    };
    const payer = () => payerKp;
    const ensureProtocol = async () => {
        try {
            const config = await program.account.protocolConfig.fetch(protocolPda);
            treasuryPubkey = config.treasury;
            minAgentStake = Math.max(config.minAgentStake.toNumber(), web3_js_1.LAMPORTS_PER_SOL);
            minArbiterStake = Math.max(config.minArbiterStake.toNumber(), minAgentStake);
        }
        catch {
            const minStake = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL);
            const minStakeForDispute = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 10);
            await program.methods
                .initializeProtocol(51, PROTOCOL_FEE_BPS, minStake, minStakeForDispute, 2, [provider.wallet.publicKey, secondSigner.publicKey, thirdSigner.publicKey])
                .accountsPartial({
                protocolConfig: protocolPda,
                treasury: secondSigner.publicKey,
                authority: provider.wallet.publicKey,
                secondSigner: secondSigner.publicKey,
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
                .signers([secondSigner, thirdSigner])
                .rpc();
            treasuryPubkey = secondSigner.publicKey;
            minAgentStake = web3_js_1.LAMPORTS_PER_SOL;
            minArbiterStake = web3_js_1.LAMPORTS_PER_SOL;
        }
        // Disable rate limiting for tests
        try {
            await program.methods
                .updateRateLimits(new bn_js_1.default(1), // task_creation_cooldown = 1s (minimum allowed)
            255, // max_tasks_per_24h = 255 (effectively unlimited)
            new bn_js_1.default(1), // dispute_initiation_cooldown = 1s (minimum allowed)
            255, // max_disputes_per_24h = 255 (effectively unlimited)
            new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100))
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
        }
        catch {
            // May already be configured
        }
    };
    const registerAgent = async (agentId, authority, capabilities, stake = 0) => {
        const agentPda = deriveAgentPda(agentId);
        try {
            await program.account.agentRegistration.fetch(agentPda);
        }
        catch {
            await program.methods
                .registerAgent(Array.from(agentId), new bn_js_1.default(capabilities), "https://example.com", null, new bn_js_1.default(stake))
                .accountsPartial({
                agent: agentPda,
                protocolConfig: protocolPda,
                authority: authority.publicKey,
            })
                .signers([authority])
                .rpc();
        }
        return agentPda;
    };
    /** Create a token-denominated task, returning all relevant PDAs */
    async function createTokenTask(opts) {
        const taskPda = deriveTaskPda(opts.creatorKp.publicKey, opts.taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const escrowAta = deriveEscrowAta(opts.tokenMint, escrowPda);
        await program.methods
            .createTask(Array.from(opts.taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Token task description".padEnd(64, "\0")), new bn_js_1.default(opts.rewardAmount), opts.maxWorkers ?? 1, (0, test_utils_1.getDefaultDeadline)(), opts.taskType ?? test_utils_1.TASK_TYPE_EXCLUSIVE, opts.constraintHash ?? null, 0, opts.tokenMint)
            .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: opts.creatorAgentPda,
            authority: opts.creatorKp.publicKey,
            creator: opts.creatorKp.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            rewardMint: opts.tokenMint,
            creatorTokenAccount: opts.creatorTokenAccount,
            tokenEscrowAta: escrowAta,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
        })
            .signers([opts.creatorKp])
            .rpc();
        return { taskPda, escrowPda, escrowAta };
    }
    /** Claim a task (no token accounts needed) */
    async function claimTask(taskPda, workerAgentPda, workerKp) {
        const claimPda = deriveClaimPda(taskPda, workerAgentPda);
        await program.methods
            .claimTask()
            .accountsPartial({
            task: taskPda,
            claim: claimPda,
            protocolConfig: protocolPda,
            worker: workerAgentPda,
            authority: workerKp.publicKey,
        })
            .signers([workerKp])
            .rpc();
        return claimPda;
    }
    /** Complete a token-denominated task */
    async function completeTokenTask(opts) {
        await program.methods
            .completeTask(Array.from(Buffer.from("proof-hash".padEnd(32, "\0"))), Buffer.from("result-data".padEnd(64, "\0")))
            .accountsPartial({
            task: opts.taskPda,
            claim: opts.claimPda,
            escrow: opts.escrowPda,
            creator: creator.publicKey,
            worker: opts.workerAgentPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: opts.workerKp.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            tokenEscrowAta: opts.escrowAta,
            workerTokenAccount: opts.workerTokenAccount,
            treasuryTokenAccount: opts.treasuryTokenAccount,
            rewardMint: opts.tokenMint,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
        })
            .signers([opts.workerKp])
            .rpc();
    }
    // ---------------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------------
    before(async () => {
        treasury = web3_js_1.Keypair.generate();
        secondSigner = web3_js_1.Keypair.generate();
        thirdSigner = web3_js_1.Keypair.generate();
        creator = web3_js_1.Keypair.generate();
        worker = web3_js_1.Keypair.generate();
        worker2 = web3_js_1.Keypair.generate();
        arbiter1 = web3_js_1.Keypair.generate();
        arbiter2 = web3_js_1.Keypair.generate();
        arbiter3 = web3_js_1.Keypair.generate();
        creatorAgentId = makeId("cre");
        workerAgentId = makeId("wrk");
        worker2AgentId = makeId("wr2");
        arbiter1AgentId = makeId("ar1");
        arbiter2AgentId = makeId("ar2");
        arbiter3AgentId = makeId("ar3");
        // Airdrop SOL
        await airdrop([
            treasury,
            secondSigner,
            thirdSigner,
            creator,
            worker,
            worker2,
            arbiter1,
            arbiter2,
            arbiter3,
        ]);
        await ensureProtocol();
        // Register agents
        await registerAgent(creatorAgentId, creator, test_utils_1.CAPABILITY_COMPUTE, minAgentStake);
        await registerAgent(workerAgentId, worker, test_utils_1.CAPABILITY_COMPUTE, minAgentStake);
        await registerAgent(worker2AgentId, worker2, test_utils_1.CAPABILITY_COMPUTE, minAgentStake);
        await registerAgent(arbiter1AgentId, arbiter1, test_utils_1.CAPABILITY_ARBITER, minArbiterStake);
        await registerAgent(arbiter2AgentId, arbiter2, test_utils_1.CAPABILITY_ARBITER, minArbiterStake);
        await registerAgent(arbiter3AgentId, arbiter3, test_utils_1.CAPABILITY_ARBITER, minArbiterStake);
        // Create 9-decimal test mint
        mint = await (0, spl_token_1.createMint)(provider.connection, payer(), payer().publicKey, null, 9);
        // Create ATAs
        creatorAta = await (0, spl_token_1.createAssociatedTokenAccount)(provider.connection, payer(), mint, creator.publicKey);
        workerAta = await (0, spl_token_1.createAssociatedTokenAccount)(provider.connection, payer(), mint, worker.publicKey);
        worker2Ata = await (0, spl_token_1.createAssociatedTokenAccount)(provider.connection, payer(), mint, worker2.publicKey);
        treasuryAta = await (0, spl_token_1.createAssociatedTokenAccount)(provider.connection, payer(), mint, treasuryPubkey);
        // Mint 100 tokens (100 * 10^9) to creator
        await (0, spl_token_1.mintTo)(provider.connection, payer(), mint, creatorAta, payer(), 100000000000n);
        // Create 0-decimal mint + ATAs for edge case
        zeroDecMint = await (0, spl_token_1.createMint)(provider.connection, payer(), payer().publicKey, null, 0);
        zeroDecCreatorAta = await (0, spl_token_1.createAssociatedTokenAccount)(provider.connection, payer(), zeroDecMint, creator.publicKey);
        zeroDecWorkerAta = await (0, spl_token_1.createAssociatedTokenAccount)(provider.connection, payer(), zeroDecMint, worker.publicKey);
        zeroDecTreasuryAta = await (0, spl_token_1.createAssociatedTokenAccount)(provider.connection, payer(), zeroDecMint, treasuryPubkey);
        // Mint 1000 whole tokens to creator (0-decimal)
        await (0, spl_token_1.mintTo)(provider.connection, payer(), zeroDecMint, zeroDecCreatorAta, payer(), 1000n);
    });
    // Advance clock to satisfy rate limit cooldowns between tests
    beforeEach(() => {
        (0, litesvm_helpers_1.advanceClock)(svm, 2);
    });
    // ---------------------------------------------------------------------------
    // Happy Path
    // ---------------------------------------------------------------------------
    describe("happy path", () => {
        it("should create a token-denominated task with escrow funded", async () => {
            const taskId = makeId("t-create");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const rewardAmount = 1000000000; // 1 token
            const creatorBefore = await getTokenBalance(creatorAta);
            const { taskPda, escrowAta } = await createTokenTask({
                taskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount,
            });
            // Verify task has reward_mint set
            const task = await program.account.task.fetch(taskPda);
            (0, chai_1.expect)(task.rewardMint).to.not.be.null;
            (0, chai_1.expect)(task.rewardMint.toBase58()).to.equal(mint.toBase58());
            // Verify escrow ATA funded
            const escrowBalance = await getTokenBalance(escrowAta);
            (0, chai_1.expect)(Number(escrowBalance)).to.equal(rewardAmount);
            // Verify creator debited
            const creatorAfter = await getTokenBalance(creatorAta);
            (0, chai_1.expect)(Number(creatorBefore - creatorAfter)).to.equal(rewardAmount);
        });
        it("should claim a token task (no token accounts needed)", async () => {
            const taskId = makeId("t-claim");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const workerAgentPda = deriveAgentPda(workerAgentId);
            const { taskPda } = await createTokenTask({
                taskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount: 500000000,
            });
            const claimPda = await claimTask(taskPda, workerAgentPda, worker);
            const claim = await program.account.taskClaim.fetch(claimPda);
            (0, chai_1.expect)(claim.task.toBase58()).to.equal(taskPda.toBase58());
        });
        it("should complete a token task with correct fee distribution", async () => {
            const taskId = makeId("t-compl");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const workerAgentPda = deriveAgentPda(workerAgentId);
            const rewardAmount = 10000000000; // 10 tokens
            const { taskPda, escrowPda, escrowAta } = await createTokenTask({
                taskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount,
            });
            const claimPda = await claimTask(taskPda, workerAgentPda, worker);
            const workerBefore = await getTokenBalance(workerAta);
            const treasuryBefore = await getTokenBalance(treasuryAta);
            await completeTokenTask({
                taskPda,
                claimPda,
                escrowPda,
                escrowAta,
                workerAgentPda,
                workerKp: worker,
                workerTokenAccount: workerAta,
                tokenMint: mint,
                treasuryTokenAccount: treasuryAta,
            });
            const workerAfter = await getTokenBalance(workerAta);
            const treasuryAfter = await getTokenBalance(treasuryAta);
            // Fee: floor(10_000_000_000 * 100 / 10000) = 100_000_000 (0.1 token)
            const expectedFee = Math.floor((rewardAmount * PROTOCOL_FEE_BPS) / 10000);
            const expectedWorkerReward = rewardAmount - expectedFee;
            (0, chai_1.expect)(Number(workerAfter - workerBefore)).to.equal(expectedWorkerReward);
            (0, chai_1.expect)(Number(treasuryAfter - treasuryBefore)).to.equal(expectedFee);
        });
        it("should cancel an unclaimed token task with full refund", async () => {
            const taskId = makeId("t-cancel");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const rewardAmount = 2000000000; // 2 tokens
            const { taskPda, escrowPda, escrowAta } = await createTokenTask({
                taskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount,
            });
            const creatorBefore = await getTokenBalance(creatorAta);
            await program.methods
                .cancelTask()
                .accountsPartial({
                task: taskPda,
                escrow: escrowPda,
                creator: creator.publicKey,
                protocolConfig: protocolPda,
                systemProgram: web3_js_1.SystemProgram.programId,
                tokenEscrowAta: escrowAta,
                creatorTokenAccount: creatorAta,
                rewardMint: mint,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            })
                .signers([creator])
                .rpc();
            const creatorAfter = await getTokenBalance(creatorAta);
            (0, chai_1.expect)(Number(creatorAfter - creatorBefore)).to.equal(rewardAmount);
            // Verify task is cancelled
            const task = await program.account.task.fetch(taskPda);
            (0, chai_1.expect)(task.status).to.deep.equal({ cancelled: {} });
        });
        it("should create a dependent token task", async () => {
            const parentTaskId = makeId("t-par");
            const childTaskId = makeId("t-child");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            // Create parent task (SOL to keep it simple)
            const parentTaskPda = deriveTaskPda(creator.publicKey, parentTaskId);
            const parentEscrowPda = deriveEscrowPda(parentTaskPda);
            await program.methods
                .createTask(Array.from(parentTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Parent task".padEnd(64, "\0")), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 10), 1, (0, test_utils_1.getDefaultDeadline)(), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, null)
                .accountsPartial({
                task: parentTaskPda,
                escrow: parentEscrowPda,
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
            // Create dependent token task
            (0, litesvm_helpers_1.advanceClock)(svm, 2); // satisfy rate limit cooldown
            const childTaskPda = deriveTaskPda(creator.publicKey, childTaskId);
            const childEscrowPda = deriveEscrowPda(childTaskPda);
            const childEscrowAta = deriveEscrowAta(mint, childEscrowPda);
            const rewardAmount = 500000000;
            await program.methods
                .createDependentTask(Array.from(childTaskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Dependent token task".padEnd(64, "\0")), new bn_js_1.default(rewardAmount), 1, (0, test_utils_1.getDefaultDeadline)(), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 1, // DependencyType::Data
            0, mint)
                .accountsPartial({
                task: childTaskPda,
                escrow: childEscrowPda,
                parentTask: parentTaskPda,
                protocolConfig: protocolPda,
                creatorAgent: creatorAgentPda,
                authority: creator.publicKey,
                creator: creator.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
                rewardMint: mint,
                creatorTokenAccount: creatorAta,
                tokenEscrowAta: childEscrowAta,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
            })
                .signers([creator])
                .rpc();
            // Verify child task has reward_mint set
            const childTask = await program.account.task.fetch(childTaskPda);
            (0, chai_1.expect)(childTask.rewardMint).to.not.be.null;
            (0, chai_1.expect)(childTask.rewardMint.toBase58()).to.equal(mint.toBase58());
            // Verify escrow funded
            const escrowBalance = await getTokenBalance(childEscrowAta);
            (0, chai_1.expect)(Number(escrowBalance)).to.equal(rewardAmount);
        });
    });
    // ---------------------------------------------------------------------------
    // Edge Cases
    // ---------------------------------------------------------------------------
    describe("edge cases", () => {
        it("should create SOL task with reward_mint: null (regression)", async () => {
            const taskId = makeId("t-sol");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const taskPda = deriveTaskPda(creator.publicKey, taskId);
            const escrowPda = deriveEscrowPda(taskPda);
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("SOL task regression".padEnd(64, "\0")), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 10), 1, (0, test_utils_1.getDefaultDeadline)(), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, null)
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
            const task = await program.account.task.fetch(taskPda);
            (0, chai_1.expect)(task.rewardMint).to.be.null;
            (0, chai_1.expect)(task.rewardAmount.toNumber()).to.equal(web3_js_1.LAMPORTS_PER_SOL / 10);
        });
        it("should fail with MissingTokenAccounts when token accounts omitted", async () => {
            const taskId = makeId("t-miss");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const taskPda = deriveTaskPda(creator.publicKey, taskId);
            const escrowPda = deriveEscrowPda(taskPda);
            try {
                // Pass reward_mint arg + account, but null out the other token accounts
                // Anchor sets null optional accounts to the program ID (= not provided)
                await program.methods
                    .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Missing token accounts".padEnd(64, "\0")), new bn_js_1.default(1000000000), 1, (0, test_utils_1.getDefaultDeadline)(), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, mint)
                    .accountsPartial({
                    task: taskPda,
                    escrow: escrowPda,
                    protocolConfig: protocolPda,
                    creatorAgent: creatorAgentPda,
                    authority: creator.publicKey,
                    creator: creator.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    rewardMint: mint,
                    creatorTokenAccount: null,
                    tokenEscrowAta: null,
                    tokenProgram: null,
                    associatedTokenProgram: null,
                })
                    .signers([creator])
                    .rpc();
                chai_1.expect.fail("Should have failed with MissingTokenAccounts");
            }
            catch (e) {
                const err = e;
                (0, chai_1.expect)(err.error?.errorCode?.code).to.equal("MissingTokenAccounts");
            }
        });
        it("should fail when creator has insufficient token balance", async () => {
            // Create a new keypair with an empty ATA
            const poorCreator = web3_js_1.Keypair.generate();
            const poorAgentId = makeId("poor");
            await airdrop([poorCreator]);
            await registerAgent(poorAgentId, poorCreator, test_utils_1.CAPABILITY_COMPUTE, minAgentStake);
            const poorAta = await (0, spl_token_1.createAssociatedTokenAccount)(provider.connection, payer(), mint, poorCreator.publicKey);
            // Do NOT mint any tokens to poorAta
            const taskId = makeId("t-insuf");
            const poorAgentPda = deriveAgentPda(poorAgentId);
            const taskPda = deriveTaskPda(poorCreator.publicKey, taskId);
            const escrowPda = deriveEscrowPda(taskPda);
            const escrowAta = deriveEscrowAta(mint, escrowPda);
            try {
                await program.methods
                    .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Insufficient balance task".padEnd(64, "\0")), new bn_js_1.default(1000000000), 1, (0, test_utils_1.getDefaultDeadline)(), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, mint)
                    .accountsPartial({
                    task: taskPda,
                    escrow: escrowPda,
                    protocolConfig: protocolPda,
                    creatorAgent: poorAgentPda,
                    authority: poorCreator.publicKey,
                    creator: poorCreator.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    rewardMint: mint,
                    creatorTokenAccount: poorAta,
                    tokenEscrowAta: escrowAta,
                    tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                    associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
                })
                    .signers([poorCreator])
                    .rpc();
                chai_1.expect.fail("Should have failed with insufficient balance");
            }
            catch (e) {
                // SPL token transfer fails — the exact error depends on the runtime
                (0, chai_1.expect)(e).to.exist;
            }
        });
        it("should handle competitive token task (first completer gets tokens)", async () => {
            const taskId = makeId("t-comp");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const workerAgentPda = deriveAgentPda(workerAgentId);
            const worker2AgentPda = deriveAgentPda(worker2AgentId);
            const rewardAmount = 5000000000;
            const { taskPda, escrowPda, escrowAta } = await createTokenTask({
                taskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount,
                maxWorkers: 2,
                taskType: test_utils_1.TASK_TYPE_COMPETITIVE,
            });
            // Both workers claim
            const claimPda1 = await claimTask(taskPda, workerAgentPda, worker);
            const claimPda2 = await claimTask(taskPda, worker2AgentPda, worker2);
            // First worker completes
            const workerBefore = await getTokenBalance(workerAta);
            await completeTokenTask({
                taskPda,
                claimPda: claimPda1,
                escrowPda,
                escrowAta,
                workerAgentPda,
                workerKp: worker,
                workerTokenAccount: workerAta,
                tokenMint: mint,
                treasuryTokenAccount: treasuryAta,
            });
            const workerAfter = await getTokenBalance(workerAta);
            const expectedFee = Math.floor((rewardAmount * PROTOCOL_FEE_BPS) / 10000);
            (0, chai_1.expect)(Number(workerAfter - workerBefore)).to.equal(rewardAmount - expectedFee);
            // Verify task is completed — second worker cannot complete
            const task = await program.account.task.fetch(taskPda);
            (0, chai_1.expect)(task.status).to.deep.equal({ completed: {} });
            // Second worker tries to complete — should fail.
            // For token tasks, the escrow ATA is closed after first completion,
            // so the second attempt fails at account deserialization rather than
            // reaching the CompetitiveTaskAlreadyWon check.
            try {
                await completeTokenTask({
                    taskPda,
                    claimPda: claimPda2,
                    escrowPda,
                    escrowAta,
                    workerAgentPda: worker2AgentPda,
                    workerKp: worker2,
                    workerTokenAccount: worker2Ata,
                    tokenMint: mint,
                    treasuryTokenAccount: treasuryAta,
                });
                chai_1.expect.fail("Second completion should have failed");
            }
            catch (e) {
                // Expected: AccountNotInitialized (escrow ATA closed) or
                // CompetitiveTaskAlreadyWon (if escrow ATA not yet closed)
                (0, chai_1.expect)(e).to.be.an("error");
            }
        });
        it("should handle collaborative token task (multiple workers get tokens)", async () => {
            const taskId = makeId("t-collab");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const workerAgentPda = deriveAgentPda(workerAgentId);
            const worker2AgentPda = deriveAgentPda(worker2AgentId);
            const rewardAmount = 10000000000; // 10 tokens total
            const { taskPda, escrowPda, escrowAta } = await createTokenTask({
                taskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount,
                maxWorkers: 2,
                taskType: test_utils_1.TASK_TYPE_COLLABORATIVE,
            });
            // Both workers claim
            const claimPda1 = await claimTask(taskPda, workerAgentPda, worker);
            const claimPda2 = await claimTask(taskPda, worker2AgentPda, worker2);
            // Worker 1 completes
            const worker1Before = await getTokenBalance(workerAta);
            await completeTokenTask({
                taskPda,
                claimPda: claimPda1,
                escrowPda,
                escrowAta,
                workerAgentPda,
                workerKp: worker,
                workerTokenAccount: workerAta,
                tokenMint: mint,
                treasuryTokenAccount: treasuryAta,
            });
            const worker1After = await getTokenBalance(workerAta);
            // Worker 2 completes
            const worker2Before = await getTokenBalance(worker2Ata);
            await completeTokenTask({
                taskPda,
                claimPda: claimPda2,
                escrowPda,
                escrowAta,
                workerAgentPda: worker2AgentPda,
                workerKp: worker2,
                workerTokenAccount: worker2Ata,
                tokenMint: mint,
                treasuryTokenAccount: treasuryAta,
            });
            const worker2After = await getTokenBalance(worker2Ata);
            // Each worker gets reward / maxWorkers, minus fee
            const perWorker = Math.floor(rewardAmount / 2);
            const feePerWorker = Math.floor((perWorker * PROTOCOL_FEE_BPS) / 10000);
            const expectedPerWorker = perWorker - feePerWorker;
            (0, chai_1.expect)(Number(worker1After - worker1Before)).to.equal(expectedPerWorker);
            (0, chai_1.expect)(Number(worker2After - worker2Before)).to.equal(expectedPerWorker);
        });
        it("should handle minimum reward amount (1 unit, fee rounds to 0)", async () => {
            const taskId = makeId("t-min");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const workerAgentPda = deriveAgentPda(workerAgentId);
            const rewardAmount = 1; // 1 smallest unit
            const { taskPda, escrowPda, escrowAta } = await createTokenTask({
                taskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount,
            });
            const claimPda = await claimTask(taskPda, workerAgentPda, worker);
            const workerBefore = await getTokenBalance(workerAta);
            const treasuryBefore = await getTokenBalance(treasuryAta);
            // fee = floor(1 * 100 / 10000) = 0, worker gets 1
            // But the program enforces worker_reward > 0, and with fee=0, worker gets 1
            await completeTokenTask({
                taskPda,
                claimPda,
                escrowPda,
                escrowAta,
                workerAgentPda,
                workerKp: worker,
                workerTokenAccount: workerAta,
                tokenMint: mint,
                treasuryTokenAccount: treasuryAta,
            });
            const workerAfter = await getTokenBalance(workerAta);
            const treasuryAfter = await getTokenBalance(treasuryAta);
            (0, chai_1.expect)(Number(workerAfter - workerBefore)).to.equal(1);
            (0, chai_1.expect)(Number(treasuryAfter - treasuryBefore)).to.equal(0);
        });
        it("should work with 0-decimal mint", async () => {
            const taskId = makeId("t-0dec");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const workerAgentPda = deriveAgentPda(workerAgentId);
            const rewardAmount = 100; // 100 whole tokens
            const taskPda = deriveTaskPda(creator.publicKey, taskId);
            const escrowPda = deriveEscrowPda(taskPda);
            const escrowAta = deriveEscrowAta(zeroDecMint, escrowPda);
            await program.methods
                .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("Zero decimal task".padEnd(64, "\0")), new bn_js_1.default(rewardAmount), 1, (0, test_utils_1.getDefaultDeadline)(), test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, zeroDecMint)
                .accountsPartial({
                task: taskPda,
                escrow: escrowPda,
                protocolConfig: protocolPda,
                creatorAgent: creatorAgentPda,
                authority: creator.publicKey,
                creator: creator.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
                rewardMint: zeroDecMint,
                creatorTokenAccount: zeroDecCreatorAta,
                tokenEscrowAta: escrowAta,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
            })
                .signers([creator])
                .rpc();
            const claimPda = await claimTask(taskPda, workerAgentPda, worker);
            const workerBefore = await getTokenBalance(zeroDecWorkerAta);
            await program.methods
                .completeTask(Array.from(Buffer.from("proof-hash-0dec".padEnd(32, "\0"))), Buffer.from("result-0dec".padEnd(64, "\0")))
                .accountsPartial({
                task: taskPda,
                claim: claimPda,
                escrow: escrowPda,
                creator: creator.publicKey,
                worker: workerAgentPda,
                protocolConfig: protocolPda,
                treasury: treasuryPubkey,
                authority: worker.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
                tokenEscrowAta: escrowAta,
                workerTokenAccount: zeroDecWorkerAta,
                treasuryTokenAccount: zeroDecTreasuryAta,
                rewardMint: zeroDecMint,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            })
                .signers([worker])
                .rpc();
            const workerAfter = await getTokenBalance(zeroDecWorkerAta);
            // fee = floor(100 * 100 / 10000) = 1 token
            const expectedFee = Math.floor((rewardAmount * PROTOCOL_FEE_BPS) / 10000);
            (0, chai_1.expect)(Number(workerAfter - workerBefore)).to.equal(rewardAmount - expectedFee);
        });
    });
    // ---------------------------------------------------------------------------
    // Fee Verification
    // ---------------------------------------------------------------------------
    describe("fee verification", () => {
        it("should collect protocol fees in tokens, not SOL", async () => {
            const taskId = makeId("t-fee");
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const workerAgentPda = deriveAgentPda(workerAgentId);
            const rewardAmount = 20000000000; // 20 tokens
            const { taskPda, escrowPda, escrowAta } = await createTokenTask({
                taskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount,
            });
            const claimPda = await claimTask(taskPda, workerAgentPda, worker);
            // Record SOL balances before completion
            const workerSolBefore = await provider.connection.getBalance(worker.publicKey);
            const treasurySolBefore = await provider.connection.getBalance(treasuryPubkey);
            // Record token balances
            const treasuryTokenBefore = await getTokenBalance(treasuryAta);
            await completeTokenTask({
                taskPda,
                claimPda,
                escrowPda,
                escrowAta,
                workerAgentPda,
                workerKp: worker,
                workerTokenAccount: workerAta,
                tokenMint: mint,
                treasuryTokenAccount: treasuryAta,
            });
            const treasuryTokenAfter = await getTokenBalance(treasuryAta);
            const treasurySolAfter = await provider.connection.getBalance(treasuryPubkey);
            // Token fee should be collected
            const expectedFee = Math.floor((rewardAmount * PROTOCOL_FEE_BPS) / 10000);
            (0, chai_1.expect)(Number(treasuryTokenAfter - treasuryTokenBefore)).to.equal(expectedFee);
            // Treasury SOL balance should be unchanged (no SOL fees)
            (0, chai_1.expect)(treasurySolAfter).to.equal(treasurySolBefore);
            // Worker SOL change should be small — no reward in SOL.
            // Worker pays tx fee but may receive rent back from closed accounts
            // (claim PDA and escrow PDA), so net change could be slightly positive.
            const workerSolAfter = await provider.connection.getBalance(worker.publicKey);
            const solDiff = Math.abs(workerSolBefore - workerSolAfter);
            // The SOL change should be well under 1 SOL (just tx fees + rent refunds)
            (0, chai_1.expect)(solDiff).to.be.lessThan(web3_js_1.LAMPORTS_PER_SOL / 10);
        });
    });
    // ---------------------------------------------------------------------------
    // Dispute Preconditions (token tasks)
    // ---------------------------------------------------------------------------
    describe("dispute preconditions (token tasks)", () => {
        let disputeTaskId;
        let disputeTaskPda;
        let disputeEscrowPda;
        let disputeEscrowAta;
        let disputeClaimPda;
        let workerAgentPda;
        let creatorAgentPda;
        // Shared dispute: created in test 1, voted in test 2, resolve-rejected in test 3
        let sharedDisputeId;
        let sharedDisputePda;
        before(async () => {
            (0, litesvm_helpers_1.advanceClock)(svm, 2); // satisfy rate limit cooldown from previous tests
            disputeTaskId = makeId("t-disp");
            creatorAgentPda = deriveAgentPda(creatorAgentId);
            workerAgentPda = deriveAgentPda(workerAgentId);
            const result = await createTokenTask({
                taskId: disputeTaskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount: 5000000000,
            });
            disputeTaskPda = result.taskPda;
            disputeEscrowPda = result.escrowPda;
            disputeEscrowAta = result.escrowAta;
            disputeClaimPda = await claimTask(disputeTaskPda, workerAgentPda, worker);
            sharedDisputeId = makeId("d-tok");
            sharedDisputePda = deriveDisputePda(sharedDisputeId);
        });
        it("should initiate a dispute on a token task", async () => {
            await program.methods
                .initiateDispute(Array.from(sharedDisputeId), Array.from(disputeTaskId), Array.from(Buffer.from("evidence-hash".padEnd(32, "\0"))), test_utils_1.RESOLUTION_TYPE_REFUND, VALID_EVIDENCE)
                .accountsPartial({
                dispute: sharedDisputePda,
                task: disputeTaskPda,
                agent: creatorAgentPda,
                protocolConfig: protocolPda,
                initiatorClaim: null,
                workerAgent: workerAgentPda,
                workerClaim: disputeClaimPda,
                authority: creator.publicKey,
            })
                .signers([creator])
                .rpc();
            const dispute = await program.account.dispute.fetch(sharedDisputePda);
            (0, chai_1.expect)(dispute.status).to.deep.equal({ active: {} });
            (0, chai_1.expect)(dispute.task.toBase58()).to.equal(disputeTaskPda.toBase58());
        });
        it("should vote on a dispute for a token task", async () => {
            const arbiter1Pda = deriveAgentPda(arbiter1AgentId);
            const votePda = deriveVotePda(sharedDisputePda, arbiter1Pda);
            const authorityVotePda = deriveAuthorityVotePda(sharedDisputePda, arbiter1.publicKey);
            // Check if voting period has already ended
            const dispute = await program.account.dispute.fetch(sharedDisputePda);
            const currentTime = Math.floor(Date.now() / 1000);
            if (dispute.votingDeadline.toNumber() <= currentTime) {
                // Voting already ended — skip but verify dispute state is valid
                (0, chai_1.expect)(dispute.status).to.deep.equal({ active: {} });
                return;
            }
            await program.methods
                .voteDispute(true)
                .accountsPartial({
                dispute: sharedDisputePda,
                task: disputeTaskPda,
                workerClaim: disputeClaimPda,
                defendantAgent: workerAgentPda,
                vote: votePda,
                authorityVote: authorityVotePda,
                arbiter: arbiter1Pda,
                protocolConfig: protocolPda,
                authority: arbiter1.publicKey,
            })
                .signers([arbiter1])
                .rpc();
            const disputeAfter = await program.account.dispute.fetch(sharedDisputePda);
            (0, chai_1.expect)(disputeAfter.votesFor.toNumber()).to.be.greaterThan(0);
        });
        it("should reject resolve before voting period ends (VotingNotEnded)", async () => {
            // Check if voting period has already ended
            const dispute = await program.account.dispute.fetch(sharedDisputePda);
            const currentTime = Math.floor(Date.now() / 1000);
            if (dispute.votingDeadline.toNumber() <= currentTime) {
                // Voting already ended — can't test VotingNotEnded, skip
                return;
            }
            // Use protocol authority as resolver (initiator can't resolve)
            try {
                await program.methods
                    .resolveDispute()
                    .accountsPartial({
                    dispute: sharedDisputePda,
                    task: disputeTaskPda,
                    escrow: disputeEscrowPda,
                    creator: creator.publicKey,
                    protocolConfig: protocolPda,
                    resolver: provider.wallet.publicKey,
                    workerClaim: null,
                    worker: null,
                    workerAuthority: null,
                    systemProgram: web3_js_1.SystemProgram.programId,
                    tokenEscrowAta: disputeEscrowAta,
                    creatorTokenAccount: creatorAta,
                    workerTokenAccountAta: null,
                    treasuryTokenAccount: treasuryAta,
                    rewardMint: mint,
                    tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                })
                    .rpc();
                chai_1.expect.fail("Should have failed with VotingNotEnded");
            }
            catch (e) {
                const err = e;
                (0, chai_1.expect)(err.error?.errorCode?.code).to.equal("VotingNotEnded");
            }
        });
    });
    describe("token dispute resolution + slash", () => {
        it("should reserve token slash at resolve and settle it in applyDisputeSlash", async () => {
            const taskId = makeId("t-slash");
            const disputeId = makeId("d-slash");
            const rewardAmount = 4000000000;
            const creatorAgentPda = deriveAgentPda(creatorAgentId);
            const workerAgentPda = deriveAgentPda(workerAgentId);
            const arbiter1Pda = deriveAgentPda(arbiter1AgentId);
            const arbiter2Pda = deriveAgentPda(arbiter2AgentId);
            const arbiter3Pda = deriveAgentPda(arbiter3AgentId);
            const { taskPda, escrowPda, escrowAta } = await createTokenTask({
                taskId,
                tokenMint: mint,
                creatorKp: creator,
                creatorAgentPda,
                creatorTokenAccount: creatorAta,
                rewardAmount,
            });
            const claimPda = await claimTask(taskPda, workerAgentPda, worker);
            const disputePda = deriveDisputePda(disputeId);
            await program.methods
                .initiateDispute(Array.from(disputeId), Array.from(taskId), Array.from(Buffer.from("slash-evidence-hash".padEnd(32, "\0"))), test_utils_1.RESOLUTION_TYPE_REFUND, VALID_EVIDENCE)
                .accountsPartial({
                dispute: disputePda,
                task: taskPda,
                agent: creatorAgentPda,
                protocolConfig: protocolPda,
                initiatorClaim: null,
                workerAgent: workerAgentPda,
                workerClaim: claimPda,
                authority: creator.publicKey,
            })
                .signers([creator])
                .rpc();
            const initiatedDispute = await program.account.dispute.fetch(disputePda);
            const votingDeadline = initiatedDispute.votingDeadline.toNumber();
            const currentClock = Number(svm.getClock().unixTimestamp);
            if (currentClock >= votingDeadline) {
                // Work around zero voting_period in test protocol config by extending
                // this dispute's deadline in-place for deterministic vote/resolve flow.
                const disputeAccount = svm.getAccount(disputePda);
                (0, chai_1.expect)(disputeAccount).to.not.equal(null);
                const patchedData = new Uint8Array(disputeAccount.data);
                const view = new DataView(patchedData.buffer, patchedData.byteOffset, patchedData.byteLength);
                view.setBigInt64(203, BigInt(currentClock + 3600), true); // voting_deadline
                view.setBigInt64(211, BigInt(currentClock + 7200), true); // expires_at
                svm.setAccount(disputePda, {
                    ...disputeAccount,
                    data: patchedData,
                });
            }
            const arbiters = [
                { kp: arbiter1, pda: arbiter1Pda },
                { kp: arbiter2, pda: arbiter2Pda },
                { kp: arbiter3, pda: arbiter3Pda },
            ];
            for (const arbiter of arbiters) {
                const votePda = deriveVotePda(disputePda, arbiter.pda);
                const authorityVotePda = deriveAuthorityVotePda(disputePda, arbiter.kp.publicKey);
                await program.methods
                    .voteDispute(true)
                    .accountsPartial({
                    dispute: disputePda,
                    task: taskPda,
                    workerClaim: claimPda,
                    defendantAgent: workerAgentPda,
                    vote: votePda,
                    authorityVote: authorityVotePda,
                    arbiter: arbiter.pda,
                    protocolConfig: protocolPda,
                    authority: arbiter.kp.publicKey,
                })
                    .signers([arbiter.kp])
                    .rpc();
            }
            const votedDispute = await program.account.dispute.fetch(disputePda);
            (0, chai_1.expect)(votedDispute.votesFor.toNumber()).to.be.greaterThan(0);
            (0, chai_1.expect)(votedDispute.votesAgainst.toNumber()).to.equal(0);
            (0, chai_1.expect)(votedDispute.totalVoters).to.equal(3);
            const secondsUntilVotingEnds = Math.max(1, (await program.account.dispute.fetch(disputePda)).votingDeadline.toNumber() -
                Number(svm.getClock().unixTimestamp) +
                1);
            (0, litesvm_helpers_1.advanceClock)(svm, secondsUntilVotingEnds);
            const disputeBeforeResolve = await program.account.dispute.fetch(disputePda);
            const config = await program.account.protocolConfig.fetch(protocolPda);
            const taskBeforeResolve = await program.account.task.fetch(taskPda);
            const workerBeforeResolve = await program.account.agentRegistration.fetch(workerAgentPda);
            const expectedSlash = Math.floor((disputeBeforeResolve.workerStakeAtDispute.toNumber() *
                config.slashPercentage) /
                100);
            const expectedReserved = Math.min(expectedSlash, rewardAmount);
            (0, chai_1.expect)(workerBeforeResolve.stake.toNumber()).to.be.greaterThan(0);
            (0, chai_1.expect)(expectedSlash).to.be.greaterThan(0);
            (0, chai_1.expect)(taskBeforeResolve.rewardMint?.toBase58()).to.equal(mint.toBase58());
            const creatorBeforeResolve = await getTokenBalance(creatorAta);
            const treasuryBeforeResolve = await getTokenBalance(treasuryAta);
            await program.methods
                .resolveDispute()
                .accountsPartial({
                dispute: disputePda,
                task: taskPda,
                escrow: escrowPda,
                protocolConfig: protocolPda,
                resolver: provider.wallet.publicKey,
                creator: creator.publicKey,
                workerClaim: claimPda,
                worker: workerAgentPda,
                workerAuthority: worker.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
                tokenEscrowAta: escrowAta,
                creatorTokenAccount: creatorAta,
                workerTokenAccountAta: null,
                treasuryTokenAccount: treasuryAta,
                rewardMint: mint,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            })
                .remainingAccounts([
                {
                    pubkey: deriveVotePda(disputePda, arbiter1Pda),
                    isSigner: false,
                    isWritable: true,
                },
                { pubkey: arbiter1Pda, isSigner: false, isWritable: true },
                {
                    pubkey: deriveVotePda(disputePda, arbiter2Pda),
                    isSigner: false,
                    isWritable: true,
                },
                { pubkey: arbiter2Pda, isSigner: false, isWritable: true },
                {
                    pubkey: deriveVotePda(disputePda, arbiter3Pda),
                    isSigner: false,
                    isWritable: true,
                },
                { pubkey: arbiter3Pda, isSigner: false, isWritable: true },
            ])
                .rpc();
            const escrowPdaInfoAfterResolve = await provider.connection.getAccountInfo(escrowPda);
            (0, chai_1.expect)(escrowPdaInfoAfterResolve, "escrow PDA unexpectedly closed during resolve").to.not.equal(null);
            const escrowAtaInfoAfterResolve = await provider.connection.getAccountInfo(escrowAta);
            (0, chai_1.expect)(escrowAtaInfoAfterResolve, "escrow ATA unexpectedly closed during resolve").to.not.equal(null);
            const creatorAfterResolve = await getTokenBalance(creatorAta);
            const treasuryAfterResolve = await getTokenBalance(treasuryAta);
            const escrowAfterResolve = await getTokenBalance(escrowAta);
            (0, chai_1.expect)(Number(creatorAfterResolve - creatorBeforeResolve)).to.equal(rewardAmount - expectedReserved);
            (0, chai_1.expect)(Number(treasuryAfterResolve - treasuryBeforeResolve)).to.equal(0);
            (0, chai_1.expect)(Number(escrowAfterResolve)).to.equal(expectedReserved);
            const escrowState = await program.account.taskEscrow.fetch(escrowPda);
            (0, chai_1.expect)(escrowState.isClosed).to.equal(false);
            (0, chai_1.expect)(escrowState.distributed.toNumber()).to.equal(rewardAmount - expectedReserved);
            const treasuryBeforeSlash = await getTokenBalance(treasuryAta);
            const workerBeforeSlash = await program.account.agentRegistration.fetch(workerAgentPda);
            await program.methods
                .applyDisputeSlash()
                .accountsPartial({
                dispute: disputePda,
                task: taskPda,
                workerClaim: claimPda,
                workerAgent: workerAgentPda,
                protocolConfig: protocolPda,
                treasury: treasuryPubkey,
                escrow: escrowPda,
                tokenEscrowAta: escrowAta,
                treasuryTokenAccount: treasuryAta,
                rewardMint: mint,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            })
                .rpc();
            const disputeAfterSlash = await program.account.dispute.fetch(disputePda);
            (0, chai_1.expect)(disputeAfterSlash.slashApplied).to.equal(true);
            const treasuryAfterSlash = await getTokenBalance(treasuryAta);
            (0, chai_1.expect)(Number(treasuryAfterSlash - treasuryBeforeSlash)).to.equal(expectedReserved);
            const workerAfterSlash = await program.account.agentRegistration.fetch(workerAgentPda);
            (0, chai_1.expect)(workerBeforeSlash.stake.sub(workerAfterSlash.stake).toNumber()).to.equal(expectedSlash);
            const escrowPdaAccount = await provider.connection.getAccountInfo(escrowPda);
            const escrowAtaAccount = await provider.connection.getAccountInfo(escrowAta);
            (0, chai_1.expect)(escrowPdaAccount).to.equal(null);
            (0, chai_1.expect)(escrowAtaAccount).to.equal(null);
        });
    });
});
