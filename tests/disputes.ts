/**
 * Dispute System Tests
 *
 * Tests for dispute initiation, voting, and resolution.
 * Covers: initiateDispute, voteDispute, resolveDispute instructions.
 *
 * Run with: npx ts-mocha tests/disputes.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  HASH_SIZE,
  VALID_EVIDENCE,
  deriveProtocolPda,
  deriveAgentPda,
  deriveTaskPda,
  deriveEscrowPda,
  deriveClaimPda,
  deriveDisputePda,
  deriveVotePda,
  generateRunId,
  makeAgentId,
  makeTaskId,
  makeDisputeId,
  fundWallet,
  fundWallets,
  initializeProtocolIfNeeded,
  disableRateLimits,
  registerAgent,
  createTask,
  claimTask,
  WorkerPool,
} from "./utils/test-helpers";

describe("Dispute System", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;
  const protocolPda = deriveProtocolPda(program.programId);
  const runId = generateRunId();

  // Resolution types
  const RESOLUTION_REFUND = 0;
  const RESOLUTION_COMPLETE = 1;
  const RESOLUTION_SLASH = 2;

  // Voting period (from protocol config)
  const VOTING_PERIOD = 24 * 60 * 60; // 24 hours

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;
  let creator: Keypair;
  let creatorAgentPda: PublicKey;
  let workerPool: WorkerPool;

  before(async () => {
    console.log("\n========================================");
    console.log("Dispute System Tests");
    console.log("Program ID:", program.programId.toBase58());
    console.log("Run ID:", runId);
    console.log("========================================\n");

    treasury = Keypair.generate();
    creator = Keypair.generate();
    await fundWallets(provider.connection, [treasury, creator], 10 * LAMPORTS_PER_SOL);

    treasuryPubkey = await initializeProtocolIfNeeded(
      program,
      protocolPda,
      treasury,
      provider.wallet as anchor.Wallet
    );

    await disableRateLimits(program, protocolPda, provider.wallet as anchor.Wallet);

    // Register creator agent
    const creatorAgentId = makeAgentId("disp-creator", runId);
    creatorAgentPda = await registerAgent(
      program,
      protocolPda,
      creatorAgentId,
      creator,
      CAPABILITY_COMPUTE
    );

    // Initialize worker pool with arbiter capability
    workerPool = new WorkerPool(program, protocolPda, provider, runId);
    await workerPool.initialize(15);

    console.log("  Setup complete\n");
  });

  // Helper to create a claimed task for dispute testing
  async function createClaimedTask(suffix: string): Promise<{
    taskPda: PublicKey;
    escrowPda: PublicKey;
    claimPda: PublicKey;
    worker: { wallet: Keypair; agentId: Buffer; agentPda: PublicKey };
    taskId: Buffer;
  }> {
    const taskId = makeTaskId(`disp-${suffix}`, runId);
    const { taskPda, escrowPda } = await createTask({
      program,
      protocolPda,
      taskId,
      creatorAgentPda,
      creatorWallet: creator,
      reward: LAMPORTS_PER_SOL / 10,
    });

    const worker = await workerPool.createFreshWorker(CAPABILITY_COMPUTE | CAPABILITY_ARBITER);
    const claimPda = await claimTask(
      program,
      protocolPda,
      taskPda,
      worker.agentPda,
      worker.wallet
    );

    return { taskPda, escrowPda, claimPda, worker, taskId };
  }

  // ============================================================================
  // Dispute Initiation
  // ============================================================================

  describe("Dispute Initiation", () => {
    it("allows worker to initiate dispute on in-progress task", async () => {
      const { taskPda, worker, taskId } = await createClaimedTask("init-1");
      const disputeId = makeDisputeId("init-1", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.alloc(HASH_SIZE, 0x11)),
          RESOLUTION_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: worker.agentPda,
          authority: worker.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker.wallet])
        .rpc({ skipPreflight: true });

      const dispute = await program.account.dispute.fetch(disputePda);
      expect(dispute.status).to.deep.equal({ active: {} });
      expect(dispute.resolutionType).to.deep.equal({ refund: {} });
      expect(dispute.votesFor).to.equal(0);
      expect(dispute.votesAgainst).to.equal(0);

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ disputed: {} });

      console.log("  Dispute initiated on in-progress task");
    });

    it("sets correct voting deadline (24 hours from creation)", async () => {
      const { taskPda, worker, taskId } = await createClaimedTask("init-2");
      const disputeId = makeDisputeId("init-2", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);

      const beforeTimestamp = Math.floor(Date.now() / 1000);

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.alloc(HASH_SIZE, 0x22)),
          RESOLUTION_COMPLETE,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: worker.agentPda,
          authority: worker.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker.wallet])
        .rpc({ skipPreflight: true });

      const afterTimestamp = Math.floor(Date.now() / 1000);
      const dispute = await program.account.dispute.fetch(disputePda);

      expect(dispute.votingDeadline.toNumber()).to.be.at.least(beforeTimestamp + VOTING_PERIOD - 10);
      expect(dispute.votingDeadline.toNumber()).to.be.at.most(afterTimestamp + VOTING_PERIOD + 10);

      console.log("  Voting deadline set correctly");
    });

    it("rejects dispute on open task", async () => {
      const taskId = makeTaskId("disp-open", runId);
      const { taskPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
      });

      const disputeId = makeDisputeId("open", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);
      const worker = await workerPool.createFreshWorker(CAPABILITY_COMPUTE | CAPABILITY_ARBITER);

      try {
        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.alloc(HASH_SIZE, 0x33)),
            RESOLUTION_REFUND,
            VALID_EVIDENCE
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: worker.agentPda,
            authority: worker.wallet.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();
        expect.fail("Should have rejected dispute on open task");
      } catch (e: any) {
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("TaskNotInProgress") || msg.includes("constraint")
        );
        console.log("  Dispute on open task rejected");
      }
    });

    it("rejects dispute with insufficient evidence", async () => {
      const { taskPda, worker, taskId } = await createClaimedTask("init-3");
      const disputeId = makeDisputeId("init-3", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);

      try {
        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.alloc(HASH_SIZE, 0x44)),
            RESOLUTION_REFUND,
            "Too short" // Less than 50 characters
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: worker.agentPda,
            authority: worker.wallet.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();
        expect.fail("Should have rejected insufficient evidence");
      } catch (e: any) {
        expect(e.message).to.include("InsufficientEvidence");
        console.log("  Insufficient evidence rejected");
      }
    });
  });

  // ============================================================================
  // Dispute Voting
  // ============================================================================

  describe("Dispute Voting", () => {
    it("allows arbiter to vote on dispute", async () => {
      const { taskPda, worker, taskId } = await createClaimedTask("vote-1");
      const disputeId = makeDisputeId("vote-1", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.alloc(HASH_SIZE, 0x55)),
          RESOLUTION_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: worker.agentPda,
          authority: worker.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker.wallet])
        .rpc({ skipPreflight: true });

      // Create an arbiter to vote
      const arbiter = await workerPool.createFreshWorker(CAPABILITY_COMPUTE | CAPABILITY_ARBITER);
      const votePda = deriveVotePda(disputePda, arbiter.agentPda, program.programId);

      await program.methods
        .voteDispute(true) // Vote in favor
        .accountsPartial({
          dispute: disputePda,
          vote: votePda,
          arbiter: arbiter.agentPda,
          authority: arbiter.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([arbiter.wallet])
        .rpc({ skipPreflight: true });

      const dispute = await program.account.dispute.fetch(disputePda);
      expect(dispute.votesFor).to.equal(1);
      expect(dispute.votesAgainst).to.equal(0);

      console.log("  Arbiter voted on dispute");
    });

    it("records votes correctly (for and against)", async () => {
      const { taskPda, worker, taskId } = await createClaimedTask("vote-2");
      const disputeId = makeDisputeId("vote-2", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.alloc(HASH_SIZE, 0x66)),
          RESOLUTION_COMPLETE,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: worker.agentPda,
          authority: worker.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker.wallet])
        .rpc({ skipPreflight: true });

      // First arbiter votes FOR
      const arbiter1 = await workerPool.createFreshWorker(CAPABILITY_COMPUTE | CAPABILITY_ARBITER);
      const vote1Pda = deriveVotePda(disputePda, arbiter1.agentPda, program.programId);

      await program.methods
        .voteDispute(true)
        .accountsPartial({
          dispute: disputePda,
          vote: vote1Pda,
          arbiter: arbiter1.agentPda,
          authority: arbiter1.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([arbiter1.wallet])
        .rpc({ skipPreflight: true });

      // Second arbiter votes AGAINST
      const arbiter2 = await workerPool.createFreshWorker(CAPABILITY_COMPUTE | CAPABILITY_ARBITER);
      const vote2Pda = deriveVotePda(disputePda, arbiter2.agentPda, program.programId);

      await program.methods
        .voteDispute(false)
        .accountsPartial({
          dispute: disputePda,
          vote: vote2Pda,
          arbiter: arbiter2.agentPda,
          authority: arbiter2.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([arbiter2.wallet])
        .rpc({ skipPreflight: true });

      const dispute = await program.account.dispute.fetch(disputePda);
      expect(dispute.votesFor).to.equal(1);
      expect(dispute.votesAgainst).to.equal(1);

      console.log("  Votes for and against recorded correctly");
    });

    it("rejects duplicate vote from same arbiter", async () => {
      const { taskPda, worker, taskId } = await createClaimedTask("vote-3");
      const disputeId = makeDisputeId("vote-3", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.alloc(HASH_SIZE, 0x77)),
          RESOLUTION_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: worker.agentPda,
          authority: worker.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker.wallet])
        .rpc({ skipPreflight: true });

      const arbiter = await workerPool.createFreshWorker(CAPABILITY_COMPUTE | CAPABILITY_ARBITER);
      const votePda = deriveVotePda(disputePda, arbiter.agentPda, program.programId);

      // First vote
      await program.methods
        .voteDispute(true)
        .accountsPartial({
          dispute: disputePda,
          vote: votePda,
          arbiter: arbiter.agentPda,
          authority: arbiter.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([arbiter.wallet])
        .rpc({ skipPreflight: true });

      // Try to vote again
      try {
        await program.methods
          .voteDispute(false)
          .accountsPartial({
            dispute: disputePda,
            vote: votePda,
            arbiter: arbiter.agentPda,
            authority: arbiter.wallet.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter.wallet])
          .rpc();
        expect.fail("Should have rejected duplicate vote");
      } catch (e: any) {
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("AlreadyVoted") || msg.includes("already in use")
        );
        console.log("  Duplicate vote rejected");
      }
    });

    it("rejects vote from non-arbiter", async () => {
      const { taskPda, worker, taskId } = await createClaimedTask("vote-4");
      const disputeId = makeDisputeId("vote-4", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.alloc(HASH_SIZE, 0x88)),
          RESOLUTION_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: worker.agentPda,
          authority: worker.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker.wallet])
        .rpc({ skipPreflight: true });

      // Create agent WITHOUT arbiter capability
      const nonArbiter = await workerPool.createFreshWorker(CAPABILITY_COMPUTE); // No ARBITER
      const votePda = deriveVotePda(disputePda, nonArbiter.agentPda, program.programId);

      try {
        await program.methods
          .voteDispute(true)
          .accountsPartial({
            dispute: disputePda,
            vote: votePda,
            arbiter: nonArbiter.agentPda,
            authority: nonArbiter.wallet.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([nonArbiter.wallet])
          .rpc();
        expect.fail("Should have rejected non-arbiter vote");
      } catch (e: any) {
        expect(e.message).to.include("NotArbiter");
        console.log("  Non-arbiter vote rejected");
      }
    });
  });

  // ============================================================================
  // Dispute State
  // ============================================================================

  describe("Dispute State", () => {
    it("dispute starts with Active status", async () => {
      const { taskPda, worker, taskId } = await createClaimedTask("state-1");
      const disputeId = makeDisputeId("state-1", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.alloc(HASH_SIZE, 0x99)),
          RESOLUTION_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: worker.agentPda,
          authority: worker.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker.wallet])
        .rpc({ skipPreflight: true });

      const dispute = await program.account.dispute.fetch(disputePda);
      expect(dispute.status).to.deep.equal({ active: {} });
      expect(dispute.initiator.toBase58()).to.equal(worker.agentPda.toBase58());

      console.log("  Dispute starts with Active status");
    });

    it("stores evidence hash correctly", async () => {
      const { taskPda, worker, taskId } = await createClaimedTask("state-2");
      const disputeId = makeDisputeId("state-2", runId);
      const disputePda = deriveDisputePda(disputeId, program.programId);
      const evidenceHash = Buffer.alloc(HASH_SIZE, 0xAA);

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(evidenceHash),
          RESOLUTION_COMPLETE,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: worker.agentPda,
          authority: worker.wallet.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker.wallet])
        .rpc({ skipPreflight: true });

      const dispute = await program.account.dispute.fetch(disputePda);
      expect(Buffer.from(dispute.evidenceHash)).to.deep.equal(evidenceHash);

      console.log("  Evidence hash stored correctly");
    });
  });

  after(() => {
    console.log("\n========================================");
    console.log("Dispute System Tests Complete");
    console.log("========================================\n");
  });
});
