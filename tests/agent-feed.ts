/**
 * Agent Feed integration tests (Issue #1103)
 *
 * Tests for the on-chain agent feed/forum system: post_to_feed and upvote_post
 * instructions.
 *
 * Uses LiteSVM for fast test execution.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  TASK_TYPE_EXCLUSIVE,
  deriveProtocolPda,
  deriveProgramDataPda,
  deriveTaskPda,
  deriveEscrowPda,
  deriveClaimPda,
  deriveFeedPostPda,
  deriveFeedVotePda,
  createHash,
  errorContainsAny,
  disableRateLimitsForTests,
  ensureAgentRegistered,
} from "./test-utils";
import {
  createLiteSVMContext,
  fundAccount,
  advanceClock,
  getClockTimestamp,
} from "./litesvm-helpers";

describe("agent-feed (issue #1103)", () => {
  const { svm, provider, program, payer } = createLiteSVMContext();

  const protocolPda = deriveProtocolPda(program.programId);

  const runId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let secondSigner: Keypair;
  let thirdSigner: Keypair;
  let treasury: Keypair;
  let poster1: Keypair;
  let poster2: Keypair;
  let poster3: Keypair;
  let repCreator: Keypair;

  let poster1AgentId: Buffer;
  let poster2AgentId: Buffer;
  let poster3AgentId: Buffer;
  let repCreatorAgentId: Buffer;

  let poster1AgentPda: PublicKey;
  let poster2AgentPda: PublicKey;
  let poster3AgentPda: PublicKey;
  let repCreatorAgentPda: PublicKey;

  const AGENT_STAKE = LAMPORTS_PER_SOL;

  function makeId(prefix: string): Buffer {
    return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
  }

  function makeNonce(label: string): Buffer {
    return Buffer.from(label.slice(0, 32).padEnd(32, "\0"));
  }

  const airdrop = (
    wallets: Keypair[],
    amount: number = 100 * LAMPORTS_PER_SOL,
  ) => {
    for (const wallet of wallets) {
      fundAccount(svm, wallet.publicKey, amount);
    }
  };

  let repTaskCounter = 0;
  const nextRepTaskId = (prefix: string): Buffer => {
    repTaskCounter += 1;
    return Buffer.from(
      `${prefix}-${runId}-${repTaskCounter}`.slice(0, 32).padEnd(32, "\0"),
    );
  };

  const completeTaskForReputation = async (
    workerWallet: Keypair,
    workerAgentPda: PublicKey,
    label: string,
  ): Promise<void> => {
    const taskId = nextRepTaskId(label);
    const taskPda = deriveTaskPda(
      repCreator.publicKey,
      taskId,
      program.programId,
    );
    const escrowPda = deriveEscrowPda(taskPda, program.programId);
    const claimPda = deriveClaimPda(taskPda, workerAgentPda, program.programId);
    const deadline = new BN(getClockTimestamp(svm) + 3600);

    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Buffer.from("feed reputation task".padEnd(64, "\0")),
        new BN(1_000_000),
        1,
        deadline,
        TASK_TYPE_EXCLUSIVE,
        null,
        0,
        null,
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent: repCreatorAgentPda,
        authority: repCreator.publicKey,
        creator: repCreator.publicKey,
        systemProgram: SystemProgram.programId,
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
      .completeTask(
        Array.from(Buffer.from("feed-rep-proof".padEnd(32, "\0"))),
        null,
      )
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

  const boostReputation = async (
    workerWallet: Keypair,
    workerAgentPda: PublicKey,
    completions: number,
    label: string,
  ): Promise<void> => {
    for (let i = 0; i < completions; i += 1) {
      await completeTaskForReputation(
        workerWallet,
        workerAgentPda,
        `${label}-${i}`,
      );
    }
  };

  before(async () => {
    secondSigner = Keypair.generate();
    thirdSigner = Keypair.generate();
    treasury = Keypair.generate();
    poster1 = Keypair.generate();
    poster2 = Keypair.generate();
    poster3 = Keypair.generate();
    repCreator = Keypair.generate();

    poster1AgentId = makeId("fpst1");
    poster2AgentId = makeId("fpst2");
    poster3AgentId = makeId("fpst3");
    repCreatorAgentId = makeId("frepc");

    airdrop([secondSigner, thirdSigner, treasury, poster1, poster2, poster3, repCreator]);

    // Initialize protocol
    try {
      await program.account.protocolConfig.fetch(protocolPda);
    } catch {
      await program.methods
        .initializeProtocol(
          51,
          100,
          new BN(LAMPORTS_PER_SOL / 100),
          new BN(LAMPORTS_PER_SOL / 100),
          2,
          [provider.wallet.publicKey, secondSigner.publicKey, thirdSigner.publicKey],
        )
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: secondSigner.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: deriveProgramDataPda(program.programId),
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

    await disableRateLimitsForTests({
      program,
      protocolPda,
      authority: provider.wallet.publicKey,
      additionalSigners: [secondSigner],
      minStakeForDisputeLamports: LAMPORTS_PER_SOL / 100,
      skipPreflight: false,
    });

    // Register agents
    poster1AgentPda = await ensureAgentRegistered({
      program,
      protocolPda,
      agentId: poster1AgentId,
      authority: poster1,
      capabilities: CAPABILITY_COMPUTE,
      endpoint: "https://example.com",
      stakeLamports: AGENT_STAKE,
      skipPreflight: false,
    });
    poster2AgentPda = await ensureAgentRegistered({
      program,
      protocolPda,
      agentId: poster2AgentId,
      authority: poster2,
      capabilities: CAPABILITY_COMPUTE,
      endpoint: "https://example.com",
      stakeLamports: AGENT_STAKE,
      skipPreflight: false,
    });
    poster3AgentPda = await ensureAgentRegistered({
      program,
      protocolPda,
      agentId: poster3AgentId,
      authority: poster3,
      capabilities: CAPABILITY_COMPUTE,
      endpoint: "https://example.com",
      stakeLamports: AGENT_STAKE,
      skipPreflight: false,
    });
    repCreatorAgentPda = await ensureAgentRegistered({
      program,
      protocolPda,
      agentId: repCreatorAgentId,
      authority: repCreator,
      capabilities: CAPABILITY_COMPUTE,
      endpoint: "https://example.com",
      stakeLamports: AGENT_STAKE,
      skipPreflight: false,
    });

    // Feed instructions require elevated reputation and account age.
    await boostReputation(poster1, poster1AgentPda, 5, "feed-rep-p1");
    await boostReputation(poster2, poster2AgentPda, 5, "feed-rep-p2");
    await boostReputation(poster3, poster3AgentPda, 2, "feed-rep-p3");
    advanceClock(svm, 60 * 60 + 1);
  });

  // ==========================================================================
  // post_to_feed
  // ==========================================================================

  describe("post_to_feed", () => {
    it("should create a valid post", async () => {
      const nonce = makeNonce("post-valid-001");
      const contentHash = createHash("ipfs-content-hash-1");
      const topic = createHash("general");
      const postPda = deriveFeedPostPda(
        poster1AgentPda,
        nonce,
        program.programId,
      );

      await program.methods
        .postToFeed(contentHash, Array.from(nonce), topic, null)
        .accountsPartial({
          post: postPda,
          author: poster1AgentPda,
          protocolConfig: protocolPda,
          authority: poster1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster1])
        .rpc();

      const post = await program.account.feedPost.fetch(postPda);
      expect(post.author.toBase58()).to.equal(poster1AgentPda.toBase58());
      expect(post.upvoteCount).to.equal(0);
      expect(post.parentPost).to.be.null;
      expect(Buffer.from(post.contentHash as number[]).toString()).to.include(
        "ipfs-content-hash-1",
      );
      expect(Buffer.from(post.topic as number[]).toString()).to.include(
        "general",
      );
    });

    it("should create a reply with parent_post", async () => {
      const parentNonce = makeNonce("post-parent-001");
      const parentContentHash = createHash("parent-content");
      const parentTopic = createHash("discussion");
      const parentPda = deriveFeedPostPda(
        poster1AgentPda,
        parentNonce,
        program.programId,
      );

      // Create parent post
      await program.methods
        .postToFeed(
          parentContentHash,
          Array.from(parentNonce),
          parentTopic,
          null,
        )
        .accountsPartial({
          post: parentPda,
          author: poster1AgentPda,
          protocolConfig: protocolPda,
          authority: poster1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster1])
        .rpc();

      // Create reply
      const replyNonce = makeNonce("post-reply-001");
      const replyContentHash = createHash("reply-content");
      const replyPda = deriveFeedPostPda(
        poster2AgentPda,
        replyNonce,
        program.programId,
      );

      await program.methods
        .postToFeed(
          replyContentHash,
          Array.from(replyNonce),
          parentTopic,
          parentPda,
        )
        .accountsPartial({
          post: replyPda,
          author: poster2AgentPda,
          protocolConfig: protocolPda,
          authority: poster2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster2])
        .rpc();

      const reply = await program.account.feedPost.fetch(replyPda);
      expect(reply.parentPost).to.not.be.null;
      expect(reply.parentPost!.toBase58()).to.equal(parentPda.toBase58());
    });

    it("should reject zero content_hash", async () => {
      const nonce = makeNonce("post-zero-hash-001");
      const zeroHash = new Array(32).fill(0);
      const topic = createHash("general");
      const postPda = deriveFeedPostPda(
        poster1AgentPda,
        Buffer.from(nonce),
        program.programId,
      );

      try {
        await program.methods
          .postToFeed(zeroHash, Array.from(nonce), topic, null)
          .accountsPartial({
            post: postPda,
            author: poster1AgentPda,
            protocolConfig: protocolPda,
            authority: poster1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([poster1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["FeedInvalidContentHash", "6169"])).to.be
          .true;
      }
    });

    it("should reject zero topic", async () => {
      const nonce = makeNonce("post-zero-topic-001");
      const contentHash = createHash("valid-content");
      const zeroTopic = new Array(32).fill(0);
      const postPda = deriveFeedPostPda(
        poster1AgentPda,
        Buffer.from(nonce),
        program.programId,
      );

      try {
        await program.methods
          .postToFeed(contentHash, Array.from(nonce), zeroTopic, null)
          .accountsPartial({
            post: postPda,
            author: poster1AgentPda,
            protocolConfig: protocolPda,
            authority: poster1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([poster1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["FeedInvalidTopic", "6170"])).to.be.true;
      }
    });

    it("should reject duplicate nonce (account already exists)", async () => {
      const nonce = makeNonce("post-dup-nonce-001");
      const contentHash = createHash("content-1");
      const topic = createHash("general");
      const postPda = deriveFeedPostPda(
        poster1AgentPda,
        nonce,
        program.programId,
      );

      // First post succeeds
      await program.methods
        .postToFeed(contentHash, Array.from(nonce), topic, null)
        .accountsPartial({
          post: postPda,
          author: poster1AgentPda,
          protocolConfig: protocolPda,
          authority: poster1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster1])
        .rpc();

      // Second post with same nonce fails
      const contentHash2 = createHash("content-2");
      try {
        await program.methods
          .postToFeed(contentHash2, Array.from(nonce), topic, null)
          .accountsPartial({
            post: postPda,
            author: poster1AgentPda,
            protocolConfig: protocolPda,
            authority: poster1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([poster1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(
          errorContainsAny(err, ["already in use", "custom program error"]),
        ).to.be.true;
      }
    });
  });

  // ==========================================================================
  // upvote_post
  // ==========================================================================

  describe("upvote_post", () => {
    let targetPostPda: PublicKey;

    before(async () => {
      // Create a post by poster1 for upvote tests
      const nonce = makeNonce("upvote-target-001");
      const contentHash = createHash("upvotable-content");
      const topic = createHash("hot-topics");
      targetPostPda = deriveFeedPostPda(
        poster1AgentPda,
        nonce,
        program.programId,
      );

      await program.methods
        .postToFeed(contentHash, Array.from(nonce), topic, null)
        .accountsPartial({
          post: targetPostPda,
          author: poster1AgentPda,
          protocolConfig: protocolPda,
          authority: poster1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster1])
        .rpc();
    });

    it("should upvote a post successfully", async () => {
      const votePda = deriveFeedVotePda(
        targetPostPda,
        poster2AgentPda,
        program.programId,
      );

      await program.methods
        .upvotePost()
        .accountsPartial({
          post: targetPostPda,
          vote: votePda,
          voter: poster2AgentPda,
          protocolConfig: protocolPda,
          authority: poster2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster2])
        .rpc();

      const post = await program.account.feedPost.fetch(targetPostPda);
      expect(post.upvoteCount).to.equal(1);

      const vote = await program.account.feedVote.fetch(votePda);
      expect(vote.post.toBase58()).to.equal(targetPostPda.toBase58());
      expect(vote.voter.toBase58()).to.equal(poster2AgentPda.toBase58());
    });

    it("should reject self-upvote", async () => {
      const votePda = deriveFeedVotePda(
        targetPostPda,
        poster1AgentPda,
        program.programId,
      );

      try {
        await program.methods
          .upvotePost()
          .accountsPartial({
            post: targetPostPda,
            vote: votePda,
            voter: poster1AgentPda,
            protocolConfig: protocolPda,
            authority: poster1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([poster1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["FeedSelfUpvote", "6172"])).to.be.true;
      }
    });

    it("should reject duplicate upvote (PDA already exists)", async () => {
      // poster2 already upvoted in previous test
      const votePda = deriveFeedVotePda(
        targetPostPda,
        poster2AgentPda,
        program.programId,
      );

      try {
        await program.methods
          .upvotePost()
          .accountsPartial({
            post: targetPostPda,
            vote: votePda,
            voter: poster2AgentPda,
            protocolConfig: protocolPda,
            authority: poster2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([poster2])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // In LiteSVM, duplicate PDA init may surface differently
        const msg = err.message || err.toString();
        expect(msg).to.not.equal("Should have thrown");
      }
    });

    it("should track upvote count across multiple voters", async () => {
      // Create a fresh post for multi-upvote test
      const nonce = makeNonce("multi-upvote-001");
      const contentHash = createHash("multi-upvote-content");
      const topic = createHash("popular");
      const postPda = deriveFeedPostPda(
        poster1AgentPda,
        nonce,
        program.programId,
      );

      await program.methods
        .postToFeed(contentHash, Array.from(nonce), topic, null)
        .accountsPartial({
          post: postPda,
          author: poster1AgentPda,
          protocolConfig: protocolPda,
          authority: poster1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster1])
        .rpc();

      // Poster2 upvotes → count = 1
      const vote2Pda = deriveFeedVotePda(
        postPda,
        poster2AgentPda,
        program.programId,
      );
      await program.methods
        .upvotePost()
        .accountsPartial({
          post: postPda,
          vote: vote2Pda,
          voter: poster2AgentPda,
          protocolConfig: protocolPda,
          authority: poster2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster2])
        .rpc();

      let post = await program.account.feedPost.fetch(postPda);
      expect(post.upvoteCount).to.equal(1);

      // Poster3 upvotes → count = 2
      const vote3Pda = deriveFeedVotePda(
        postPda,
        poster3AgentPda,
        program.programId,
      );
      await program.methods
        .upvotePost()
        .accountsPartial({
          post: postPda,
          vote: vote3Pda,
          voter: poster3AgentPda,
          protocolConfig: protocolPda,
          authority: poster3.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster3])
        .rpc();

      post = await program.account.feedPost.fetch(postPda);
      expect(post.upvoteCount).to.equal(2);
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
      const contentHash = createHash("fetch-test-content");
      const topic = createHash("query-topic");
      const postPda = deriveFeedPostPda(
        poster1AgentPda,
        nonce,
        program.programId,
      );

      await program.methods
        .postToFeed(contentHash, Array.from(nonce), topic, null)
        .accountsPartial({
          post: postPda,
          author: poster1AgentPda,
          protocolConfig: protocolPda,
          authority: poster1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster1])
        .rpc();

      const post = await program.account.feedPost.fetch(postPda);
      expect(post.author.toBase58()).to.equal(poster1AgentPda.toBase58());
      expect(Buffer.from(post.contentHash as number[]).toString()).to.include(
        "fetch-test-content",
      );
    });

    it("should verify author field at correct offset", async () => {
      // Create a post and verify the author Pubkey is at offset 8 (after discriminator)
      const nonce = makeNonce("query-author-001");
      const contentHash = createHash("author-check");
      const topic = createHash("offsets");
      const postPda = deriveFeedPostPda(
        poster1AgentPda,
        nonce,
        program.programId,
      );

      await program.methods
        .postToFeed(contentHash, Array.from(nonce), topic, null)
        .accountsPartial({
          post: postPda,
          author: poster1AgentPda,
          protocolConfig: protocolPda,
          authority: poster1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster1])
        .rpc();

      const post = await program.account.feedPost.fetch(postPda);
      expect(post.author.toBase58()).to.equal(poster1AgentPda.toBase58());

      // Also verify raw account data — author at offset 8
      const accountInfo = await provider.connection.getAccountInfo(postPda);
      expect(accountInfo).to.not.be.null;
      const authorBytes = accountInfo!.data.slice(8, 40);
      expect(new PublicKey(authorBytes).toBase58()).to.equal(
        poster1AgentPda.toBase58(),
      );
    });

    it("should verify topic field at correct offset", async () => {
      const nonce = makeNonce("query-topic-001");
      const contentHash = createHash("topic-check");
      const topicStr = "offsets-topic";
      const topic = createHash(topicStr);
      const postPda = deriveFeedPostPda(
        poster1AgentPda,
        nonce,
        program.programId,
      );

      await program.methods
        .postToFeed(contentHash, Array.from(nonce), topic, null)
        .accountsPartial({
          post: postPda,
          author: poster1AgentPda,
          protocolConfig: protocolPda,
          authority: poster1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster1])
        .rpc();

      // Verify via deserialized account
      const post = await program.account.feedPost.fetch(postPda);
      expect(Buffer.from(post.topic as number[]).toString()).to.include(
        topicStr,
      );

      // Verify raw topic at offset 72 (8 discriminator + 32 author + 32 content_hash)
      const accountInfo = await provider.connection.getAccountInfo(postPda);
      expect(accountInfo).to.not.be.null;
      const topicBytes = accountInfo!.data.slice(72, 104);
      expect(Buffer.from(topicBytes).toString()).to.include(topicStr);
    });
  });
});
