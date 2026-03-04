"use strict";
/**
 * Agent Feed integration tests (Issue #1103)
 *
 * Tests for the on-chain agent feed/forum system: post_to_feed and upvote_post
 * instructions.
 *
 * Uses LiteSVM for fast test execution.
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
describe("agent-feed (issue #1103)", () => {
    const { svm, provider, program, payer } = (0, litesvm_helpers_1.createLiteSVMContext)();
    const protocolPda = (0, test_utils_1.deriveProtocolPda)(program.programId);
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let secondSigner;
    let thirdSigner;
    let treasury;
    let poster1;
    let poster2;
    let poster3;
    let repCreator;
    let poster1AgentId;
    let poster2AgentId;
    let poster3AgentId;
    let repCreatorAgentId;
    let poster1AgentPda;
    let poster2AgentPda;
    let poster3AgentPda;
    let repCreatorAgentPda;
    const AGENT_STAKE = web3_js_1.LAMPORTS_PER_SOL;
    function makeId(prefix) {
        return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
    }
    function makeNonce(label) {
        return Buffer.from(label.slice(0, 32).padEnd(32, "\0"));
    }
    const airdrop = (wallets, amount = 100 * web3_js_1.LAMPORTS_PER_SOL) => {
        for (const wallet of wallets) {
            (0, litesvm_helpers_1.fundAccount)(svm, wallet.publicKey, amount);
        }
    };
    let repTaskCounter = 0;
    const nextRepTaskId = (prefix) => {
        repTaskCounter += 1;
        return Buffer.from(`${prefix}-${runId}-${repTaskCounter}`.slice(0, 32).padEnd(32, "\0"));
    };
    const completeTaskForReputation = async (workerWallet, workerAgentPda, label) => {
        (0, litesvm_helpers_1.advanceClock)(svm, 2); // satisfy rate limit cooldown
        const taskId = nextRepTaskId(label);
        const taskPda = (0, test_utils_1.deriveTaskPda)(repCreator.publicKey, taskId, program.programId);
        const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
        const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, program.programId);
        const deadline = new bn_js_1.default((0, litesvm_helpers_1.getClockTimestamp)(svm) + 3600);
        await program.methods
            .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Buffer.from("feed reputation task".padEnd(64, "\0")), new bn_js_1.default(1000000), 1, deadline, test_utils_1.TASK_TYPE_EXCLUSIVE, null, 0, null)
            .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: repCreatorAgentPda,
            authority: repCreator.publicKey,
            creator: repCreator.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
        })
            .signers([repCreator])
            .rpc();
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
        await program.methods
            .completeTask(Array.from(Buffer.from("feed-rep-proof".padEnd(32, "\0"))), null)
            .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            creator: repCreator.publicKey,
            worker: workerAgentPda,
            protocolConfig: protocolPda,
            treasury: secondSigner.publicKey,
            authority: workerWallet.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
        })
            .signers([workerWallet])
            .rpc();
    };
    const boostReputation = async (workerWallet, workerAgentPda, completions, label) => {
        for (let i = 0; i < completions; i += 1) {
            await completeTaskForReputation(workerWallet, workerAgentPda, `${label}-${i}`);
        }
    };
    before(async () => {
        secondSigner = web3_js_1.Keypair.generate();
        thirdSigner = web3_js_1.Keypair.generate();
        treasury = web3_js_1.Keypair.generate();
        poster1 = web3_js_1.Keypair.generate();
        poster2 = web3_js_1.Keypair.generate();
        poster3 = web3_js_1.Keypair.generate();
        repCreator = web3_js_1.Keypair.generate();
        poster1AgentId = makeId("fpst1");
        poster2AgentId = makeId("fpst2");
        poster3AgentId = makeId("fpst3");
        repCreatorAgentId = makeId("frepc");
        airdrop([secondSigner, thirdSigner, treasury, poster1, poster2, poster3, repCreator]);
        // Initialize protocol
        try {
            await program.account.protocolConfig.fetch(protocolPda);
        }
        catch {
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
        }
        await (0, test_utils_1.disableRateLimitsForTests)({
            program,
            protocolPda,
            authority: provider.wallet.publicKey,
            additionalSigners: [secondSigner],
            minStakeForDisputeLamports: web3_js_1.LAMPORTS_PER_SOL / 100,
            skipPreflight: false,
        });
        // Register agents
        poster1AgentPda = await (0, test_utils_1.ensureAgentRegistered)({
            program,
            protocolPda,
            agentId: poster1AgentId,
            authority: poster1,
            capabilities: test_utils_1.CAPABILITY_COMPUTE,
            endpoint: "https://example.com",
            stakeLamports: AGENT_STAKE,
            skipPreflight: false,
        });
        poster2AgentPda = await (0, test_utils_1.ensureAgentRegistered)({
            program,
            protocolPda,
            agentId: poster2AgentId,
            authority: poster2,
            capabilities: test_utils_1.CAPABILITY_COMPUTE,
            endpoint: "https://example.com",
            stakeLamports: AGENT_STAKE,
            skipPreflight: false,
        });
        poster3AgentPda = await (0, test_utils_1.ensureAgentRegistered)({
            program,
            protocolPda,
            agentId: poster3AgentId,
            authority: poster3,
            capabilities: test_utils_1.CAPABILITY_COMPUTE,
            endpoint: "https://example.com",
            stakeLamports: AGENT_STAKE,
            skipPreflight: false,
        });
        repCreatorAgentPda = await (0, test_utils_1.ensureAgentRegistered)({
            program,
            protocolPda,
            agentId: repCreatorAgentId,
            authority: repCreator,
            capabilities: test_utils_1.CAPABILITY_COMPUTE,
            endpoint: "https://example.com",
            stakeLamports: AGENT_STAKE,
            skipPreflight: false,
        });
        // Feed instructions require elevated reputation and account age.
        await boostReputation(poster1, poster1AgentPda, 5, "feed-rep-p1");
        await boostReputation(poster2, poster2AgentPda, 5, "feed-rep-p2");
        await boostReputation(poster3, poster3AgentPda, 2, "feed-rep-p3");
        (0, litesvm_helpers_1.advanceClock)(svm, 60 * 60 + 1);
    });
    // Advance clock to satisfy rate limit cooldowns between tests
    beforeEach(() => {
        (0, litesvm_helpers_1.advanceClock)(svm, 2);
    });
    // ==========================================================================
    // post_to_feed
    // ==========================================================================
    describe("post_to_feed", () => {
        it("should create a valid post", async () => {
            const nonce = makeNonce("post-valid-001");
            const contentHash = (0, test_utils_1.createHash)("ipfs-content-hash-1");
            const topic = (0, test_utils_1.createHash)("general");
            const postPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, nonce, program.programId);
            await program.methods
                .postToFeed(contentHash, Array.from(nonce), topic, null)
                .accountsPartial({
                post: postPda,
                author: poster1AgentPda,
                protocolConfig: protocolPda,
                authority: poster1.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster1])
                .rpc();
            const post = await program.account.feedPost.fetch(postPda);
            (0, chai_1.expect)(post.author.toBase58()).to.equal(poster1AgentPda.toBase58());
            (0, chai_1.expect)(post.upvoteCount).to.equal(0);
            (0, chai_1.expect)(post.parentPost).to.be.null;
            (0, chai_1.expect)(Buffer.from(post.contentHash).toString()).to.include("ipfs-content-hash-1");
            (0, chai_1.expect)(Buffer.from(post.topic).toString()).to.include("general");
        });
        it("should create a reply with parent_post", async () => {
            const parentNonce = makeNonce("post-parent-001");
            const parentContentHash = (0, test_utils_1.createHash)("parent-content");
            const parentTopic = (0, test_utils_1.createHash)("discussion");
            const parentPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, parentNonce, program.programId);
            // Create parent post
            await program.methods
                .postToFeed(parentContentHash, Array.from(parentNonce), parentTopic, null)
                .accountsPartial({
                post: parentPda,
                author: poster1AgentPda,
                protocolConfig: protocolPda,
                authority: poster1.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster1])
                .rpc();
            // Create reply
            const replyNonce = makeNonce("post-reply-001");
            const replyContentHash = (0, test_utils_1.createHash)("reply-content");
            const replyPda = (0, test_utils_1.deriveFeedPostPda)(poster2AgentPda, replyNonce, program.programId);
            await program.methods
                .postToFeed(replyContentHash, Array.from(replyNonce), parentTopic, parentPda)
                .accountsPartial({
                post: replyPda,
                author: poster2AgentPda,
                protocolConfig: protocolPda,
                authority: poster2.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster2])
                .rpc();
            const reply = await program.account.feedPost.fetch(replyPda);
            (0, chai_1.expect)(reply.parentPost).to.not.be.null;
            (0, chai_1.expect)(reply.parentPost.toBase58()).to.equal(parentPda.toBase58());
        });
        it("should reject zero content_hash", async () => {
            const nonce = makeNonce("post-zero-hash-001");
            const zeroHash = new Array(32).fill(0);
            const topic = (0, test_utils_1.createHash)("general");
            const postPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, Buffer.from(nonce), program.programId);
            try {
                await program.methods
                    .postToFeed(zeroHash, Array.from(nonce), topic, null)
                    .accountsPartial({
                    post: postPda,
                    author: poster1AgentPda,
                    protocolConfig: protocolPda,
                    authority: poster1.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([poster1])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["FeedInvalidContentHash", "6169"])).to.be
                    .true;
            }
        });
        it("should reject zero topic", async () => {
            const nonce = makeNonce("post-zero-topic-001");
            const contentHash = (0, test_utils_1.createHash)("valid-content");
            const zeroTopic = new Array(32).fill(0);
            const postPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, Buffer.from(nonce), program.programId);
            try {
                await program.methods
                    .postToFeed(contentHash, Array.from(nonce), zeroTopic, null)
                    .accountsPartial({
                    post: postPda,
                    author: poster1AgentPda,
                    protocolConfig: protocolPda,
                    authority: poster1.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([poster1])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["FeedInvalidTopic", "6170"])).to.be.true;
            }
        });
        it("should reject duplicate nonce (account already exists)", async () => {
            const nonce = makeNonce("post-dup-nonce-001");
            const contentHash = (0, test_utils_1.createHash)("content-1");
            const topic = (0, test_utils_1.createHash)("general");
            const postPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, nonce, program.programId);
            // First post succeeds
            await program.methods
                .postToFeed(contentHash, Array.from(nonce), topic, null)
                .accountsPartial({
                post: postPda,
                author: poster1AgentPda,
                protocolConfig: protocolPda,
                authority: poster1.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster1])
                .rpc();
            // Second post with same nonce fails
            const contentHash2 = (0, test_utils_1.createHash)("content-2");
            try {
                await program.methods
                    .postToFeed(contentHash2, Array.from(nonce), topic, null)
                    .accountsPartial({
                    post: postPda,
                    author: poster1AgentPda,
                    protocolConfig: protocolPda,
                    authority: poster1.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([poster1])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["already in use", "custom program error"])).to.be.true;
            }
        });
    });
    // ==========================================================================
    // upvote_post
    // ==========================================================================
    describe("upvote_post", () => {
        let targetPostPda;
        before(async () => {
            // Create a post by poster1 for upvote tests
            const nonce = makeNonce("upvote-target-001");
            const contentHash = (0, test_utils_1.createHash)("upvotable-content");
            const topic = (0, test_utils_1.createHash)("hot-topics");
            targetPostPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, nonce, program.programId);
            await program.methods
                .postToFeed(contentHash, Array.from(nonce), topic, null)
                .accountsPartial({
                post: targetPostPda,
                author: poster1AgentPda,
                protocolConfig: protocolPda,
                authority: poster1.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster1])
                .rpc();
        });
        it("should upvote a post successfully", async () => {
            const votePda = (0, test_utils_1.deriveFeedVotePda)(targetPostPda, poster2AgentPda, program.programId);
            await program.methods
                .upvotePost()
                .accountsPartial({
                post: targetPostPda,
                vote: votePda,
                voter: poster2AgentPda,
                protocolConfig: protocolPda,
                authority: poster2.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster2])
                .rpc();
            const post = await program.account.feedPost.fetch(targetPostPda);
            (0, chai_1.expect)(post.upvoteCount).to.equal(1);
            const vote = await program.account.feedVote.fetch(votePda);
            (0, chai_1.expect)(vote.post.toBase58()).to.equal(targetPostPda.toBase58());
            (0, chai_1.expect)(vote.voter.toBase58()).to.equal(poster2AgentPda.toBase58());
        });
        it("should reject self-upvote", async () => {
            const votePda = (0, test_utils_1.deriveFeedVotePda)(targetPostPda, poster1AgentPda, program.programId);
            try {
                await program.methods
                    .upvotePost()
                    .accountsPartial({
                    post: targetPostPda,
                    vote: votePda,
                    voter: poster1AgentPda,
                    protocolConfig: protocolPda,
                    authority: poster1.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([poster1])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["FeedSelfUpvote", "6172"])).to.be.true;
            }
        });
        it("should reject duplicate upvote (PDA already exists)", async () => {
            // poster2 already upvoted in previous test
            const votePda = (0, test_utils_1.deriveFeedVotePda)(targetPostPda, poster2AgentPda, program.programId);
            try {
                await program.methods
                    .upvotePost()
                    .accountsPartial({
                    post: targetPostPda,
                    vote: votePda,
                    voter: poster2AgentPda,
                    protocolConfig: protocolPda,
                    authority: poster2.publicKey,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([poster2])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                // In LiteSVM, duplicate PDA init may surface differently
                const msg = err.message || err.toString();
                (0, chai_1.expect)(msg).to.not.equal("Should have thrown");
            }
        });
        it("should track upvote count across multiple voters", async () => {
            // Create a fresh post for multi-upvote test
            const nonce = makeNonce("multi-upvote-001");
            const contentHash = (0, test_utils_1.createHash)("multi-upvote-content");
            const topic = (0, test_utils_1.createHash)("popular");
            const postPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, nonce, program.programId);
            await program.methods
                .postToFeed(contentHash, Array.from(nonce), topic, null)
                .accountsPartial({
                post: postPda,
                author: poster1AgentPda,
                protocolConfig: protocolPda,
                authority: poster1.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster1])
                .rpc();
            // Poster2 upvotes → count = 1
            const vote2Pda = (0, test_utils_1.deriveFeedVotePda)(postPda, poster2AgentPda, program.programId);
            await program.methods
                .upvotePost()
                .accountsPartial({
                post: postPda,
                vote: vote2Pda,
                voter: poster2AgentPda,
                protocolConfig: protocolPda,
                authority: poster2.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster2])
                .rpc();
            let post = await program.account.feedPost.fetch(postPda);
            (0, chai_1.expect)(post.upvoteCount).to.equal(1);
            // Poster3 upvotes → count = 2
            const vote3Pda = (0, test_utils_1.deriveFeedVotePda)(postPda, poster3AgentPda, program.programId);
            await program.methods
                .upvotePost()
                .accountsPartial({
                post: postPda,
                vote: vote3Pda,
                voter: poster3AgentPda,
                protocolConfig: protocolPda,
                authority: poster3.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster3])
                .rpc();
            post = await program.account.feedPost.fetch(postPda);
            (0, chai_1.expect)(post.upvoteCount).to.equal(2);
        });
    });
    // ==========================================================================
    // Feed queries
    // ==========================================================================
    describe("feed queries", () => {
        // Note: LiteSVM does not support getProgramAccounts, so we test
        // individual post fetches by known PDA instead of .all() queries.
        it("should fetch a known post by PDA", async () => {
            const nonce = makeNonce("query-fetch-001");
            const contentHash = (0, test_utils_1.createHash)("fetch-test-content");
            const topic = (0, test_utils_1.createHash)("query-topic");
            const postPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, nonce, program.programId);
            await program.methods
                .postToFeed(contentHash, Array.from(nonce), topic, null)
                .accountsPartial({
                post: postPda,
                author: poster1AgentPda,
                protocolConfig: protocolPda,
                authority: poster1.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster1])
                .rpc();
            const post = await program.account.feedPost.fetch(postPda);
            (0, chai_1.expect)(post.author.toBase58()).to.equal(poster1AgentPda.toBase58());
            (0, chai_1.expect)(Buffer.from(post.contentHash).toString()).to.include("fetch-test-content");
        });
        it("should verify author field at correct offset", async () => {
            // Create a post and verify the author Pubkey is at offset 8 (after discriminator)
            const nonce = makeNonce("query-author-001");
            const contentHash = (0, test_utils_1.createHash)("author-check");
            const topic = (0, test_utils_1.createHash)("offsets");
            const postPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, nonce, program.programId);
            await program.methods
                .postToFeed(contentHash, Array.from(nonce), topic, null)
                .accountsPartial({
                post: postPda,
                author: poster1AgentPda,
                protocolConfig: protocolPda,
                authority: poster1.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster1])
                .rpc();
            const post = await program.account.feedPost.fetch(postPda);
            (0, chai_1.expect)(post.author.toBase58()).to.equal(poster1AgentPda.toBase58());
            // Also verify raw account data — author at offset 8
            const accountInfo = await provider.connection.getAccountInfo(postPda);
            (0, chai_1.expect)(accountInfo).to.not.be.null;
            const authorBytes = accountInfo.data.slice(8, 40);
            (0, chai_1.expect)(new web3_js_1.PublicKey(authorBytes).toBase58()).to.equal(poster1AgentPda.toBase58());
        });
        it("should verify topic field at correct offset", async () => {
            const nonce = makeNonce("query-topic-001");
            const contentHash = (0, test_utils_1.createHash)("topic-check");
            const topicStr = "offsets-topic";
            const topic = (0, test_utils_1.createHash)(topicStr);
            const postPda = (0, test_utils_1.deriveFeedPostPda)(poster1AgentPda, nonce, program.programId);
            await program.methods
                .postToFeed(contentHash, Array.from(nonce), topic, null)
                .accountsPartial({
                post: postPda,
                author: poster1AgentPda,
                protocolConfig: protocolPda,
                authority: poster1.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([poster1])
                .rpc();
            // Verify via deserialized account
            const post = await program.account.feedPost.fetch(postPda);
            (0, chai_1.expect)(Buffer.from(post.topic).toString()).to.include(topicStr);
            // Verify raw topic at offset 72 (8 discriminator + 32 author + 32 content_hash)
            const accountInfo = await provider.connection.getAccountInfo(postPda);
            (0, chai_1.expect)(accountInfo).to.not.be.null;
            const topicBytes = accountInfo.data.slice(72, 104);
            (0, chai_1.expect)(Buffer.from(topicBytes).toString()).to.include(topicStr);
        });
    });
});
