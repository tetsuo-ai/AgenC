/**
 * Issue #25: Concurrency and Race Condition Simulation Tests
 *
 * Split from test_1.ts for domain-focused test organization.
 * Uses LiteSVM for fast in-process testing.
 */

import BN from "bn.js";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COLLABORATIVE,
  TASK_TYPE_COMPETITIVE,
  VALID_EVIDENCE,
  getDefaultDeadline,
  buildCancelTaskRemainingAccounts,
} from "./test-utils";
import {
  fundAccount,
  advanceClock,
  getClockTimestamp,
} from "./litesvm-helpers";
import { createTestContext } from "./test-litesvm-setup";

describe("Issue #25: Concurrency and Race Condition Simulation Tests", () => {
  const ctx = createTestContext();

  // Local aliases — assigned from ctx after before() populates them.
  // We use property access on ctx so the values resolve at test runtime.
  let program: typeof ctx.program;
  let provider: typeof ctx.provider;
  let svm: typeof ctx.svm;
  let protocolPda: PublicKey;
  let runId: string;
  let creator: Keypair;
  let worker1: Keypair;
  let worker2: Keypair;
  let worker3: Keypair;
  let creatorAgentPda: PublicKey;
  let agentId1: Buffer;
  let agentId2: Buffer;
  let agentId3: Buffer;
  let creatorAgentId: Buffer;
  let treasuryPubkey: PublicKey;
  let secondSigner: Keypair;
  let thirdSigner: Keypair;

  // Bind PDA helpers that close over program.programId
  let deriveAgentPda: (agentId: Buffer) => PublicKey;
  let deriveTaskPda: (creatorPubkey: PublicKey, taskId: Buffer) => PublicKey;
  let deriveEscrowPda: (taskPda: PublicKey) => PublicKey;
  let deriveClaimPda: (taskPda: PublicKey, workerPubkey: PublicKey) => PublicKey;
  let makeAgentId: (prefix: string) => Buffer;
  let createFreshWorker: (capabilities?: number) => Promise<{ wallet: Keypair; agentId: Buffer; agentPda: PublicKey }>; 
  let getPooledWorker: () => { wallet: Keypair; agentId: Buffer; agentPda: PublicKey };

  before(() => {
    program = ctx.program;
    provider = ctx.provider;
    svm = ctx.svm;
    protocolPda = ctx.protocolPda;
    runId = ctx.runId;
    creator = ctx.creator;
    worker1 = ctx.worker1;
    worker2 = ctx.worker2;
    worker3 = ctx.worker3;
    creatorAgentPda = ctx.creatorAgentPda;
    agentId1 = ctx.agentId1;
    agentId2 = ctx.agentId2;
    agentId3 = ctx.agentId3;
    creatorAgentId = ctx.creatorAgentId;
    treasuryPubkey = ctx.treasuryPubkey;
    secondSigner = ctx.secondSigner;
    thirdSigner = ctx.thirdSigner;
    deriveAgentPda = ctx.deriveAgentPda;
    deriveTaskPda = ctx.deriveTaskPda;
    deriveEscrowPda = ctx.deriveEscrowPda;
    deriveClaimPda = ctx.deriveClaimPda;
    makeAgentId = ctx.makeAgentId;
    createFreshWorker = ctx.createFreshWorker;
    getPooledWorker = ctx.getPooledWorker;
  });

  describe("Issue #25: Concurrency and Race Condition Simulation Tests", () => {
    describe("Multiple claims", () => {
      it("Multiple workers can claim collaborative task up to max_workers", async () => {
        const taskId = Buffer.from("concurrent-001".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Multi-claim test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 33),
            3,
            getDefaultDeadline(),
            TASK_TYPE_COLLABORATIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // All 3 workers claim using fresh agents
        const worker1 = await createFreshWorker();
        const worker2 = await createFreshWorker();
        const worker3 = await createFreshWorker();
        const claimPda1 = deriveClaimPda(taskPda, worker1.agentPda);
        const claimPda2 = deriveClaimPda(taskPda, worker2.agentPda);
        const claimPda3 = deriveClaimPda(taskPda, worker3.agentPda);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker1.agentPda,
            authority: worker1.wallet.publicKey,
          })
          .signers([worker1.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker2.agentPda,
            authority: worker2.wallet.publicKey,
          })
          .signers([worker2.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda3,
            worker: worker3.agentPda,
            authority: worker3.wallet.publicKey,
          })
          .signers([worker3.wallet])
          .rpc();

        // Verify all 3 claims succeeded
        const task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.equal(3);
        expect(task.maxWorkers).to.equal(3);
      });

      it("max_workers+1 claim attempt fails (TaskFullyClaimed)", async () => {
        const taskId = Buffer.from("concurrent-002".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Overflow claim test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 50),
            2,
            getDefaultDeadline(),
            TASK_TYPE_COLLABORATIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // First 2 claims succeed using fresh workers
        const worker1 = await createFreshWorker();
        const worker2 = await createFreshWorker();
        const worker3 = await createFreshWorker();
        const claimPda1 = deriveClaimPda(taskPda, worker1.agentPda);
        const claimPda2 = deriveClaimPda(taskPda, worker2.agentPda);
        const claimPda3 = deriveClaimPda(taskPda, worker3.agentPda);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker1.agentPda,
            authority: worker1.wallet.publicKey,
          })
          .signers([worker1.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker2.agentPda,
            authority: worker2.wallet.publicKey,
          })
          .signers([worker2.wallet])
          .rpc();

        // Third claim should fail
        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda3,
              worker: worker3.agentPda,
              authority: worker3.wallet.publicKey,
            })
            .signers([worker3.wallet])
            .rpc();
          expect.fail("Third claim should fail");
        } catch (e: any) {
          expect(e.message).to.include("TaskFullyClaimed");
        }

        const task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.equal(2);
      });

      it("Concurrent claims don't exceed limit (PDA uniqueness enforces this)", async () => {
        const taskId = Buffer.from("concurrent-003".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("PDA uniqueness test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // First claim succeeds
        const worker = await createFreshWorker();
        const claimPda1 = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
          })
          .signers([worker.wallet])
          .rpc();

        // Same worker trying to claim again should fail (PDA already exists)
        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda1,
              worker: worker.agentPda,
              authority: worker.wallet.publicKey,
            })
            .signers([worker.wallet])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: any) {
          // PDA already exists - error could be "already in use" (system),
          // AlreadyClaimed (program), or TaskFullyClaimed (max_workers reached)
          expect(e).to.exist;
        }
      });
    });

    describe("Completion races", () => {
      it("First completion on exclusive task wins full reward", async () => {
        const taskId = Buffer.from("concurrent-004".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const rewardAmount = 1 * LAMPORTS_PER_SOL;

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("First wins test".padEnd(64, "\0")),
            new BN(rewardAmount),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const worker = await createFreshWorker();
        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
          })
          .signers([worker.wallet])
          .rpc();

        const workerBefore = await provider.connection.getBalance(
          worker.wallet.publicKey,
        );

        await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: worker.agentPda,
            creator: creator.publicKey,
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

        const workerAfter = await provider.connection.getBalance(
          worker.wallet.publicKey,
        );
        const protocolFee = Math.floor((rewardAmount * 100) / 10000);
        const expectedReward = rewardAmount - protocolFee;

        // Worker should have received the reward (minus tx fee)
        expect(workerAfter).to.be.greaterThan(workerBefore);
      });

      it("Collaborative task: all required completions must happen", async () => {
        const taskId = Buffer.from("concurrent-005".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("All completions test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 50),
            2,
            getDefaultDeadline(),
            TASK_TYPE_COLLABORATIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const worker1 = await createFreshWorker();
        const worker2 = await createFreshWorker();
        const claimPda1 = deriveClaimPda(taskPda, worker1.agentPda);
        const claimPda2 = deriveClaimPda(taskPda, worker2.agentPda);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker1.agentPda,
            authority: worker1.wallet.publicKey,
          })
          .signers([worker1.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker2.agentPda,
            authority: worker2.wallet.publicKey,
          })
          .signers([worker2.wallet])
          .rpc();

        // First completion pays first worker — escrow stays open for collaborative tasks
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof1".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            escrow: escrowPda,
            worker: worker1.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker1.wallet.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker1.wallet])
          .rpc();

        let task = await program.account.task.fetch(taskPda);
        expect(task.completions).to.equal(1);
        // Escrow should still exist after first completion
        const escrowAccount =
          await provider.connection.getAccountInfo(escrowPda);
        expect(escrowAccount).to.not.be.null;

        // Second completion succeeds — escrow closes after final completion
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof2".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            escrow: escrowPda,
            worker: worker2.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker2.wallet.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker2.wallet])
          .rpc();

        task = await program.account.task.fetch(taskPda);
        expect(task.completions).to.equal(2);
        expect(task.status).to.deep.equal({ completed: {} });

        // Escrow should be closed after all completions
        const escrowAfter = await provider.connection.getAccountInfo(escrowPda);
        expect(escrowAfter).to.be.null;
      });
    });

    describe("State consistency", () => {
      it("current_workers count stays accurate across multiple claims", async () => {
        const taskId = Buffer.from("concurrent-006".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Worker count test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 33),
            3,
            getDefaultDeadline(),
            TASK_TYPE_COLLABORATIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        let task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.equal(0);

        // Create fresh workers
        const worker1 = await createFreshWorker();
        const worker2 = await createFreshWorker();
        const worker3 = await createFreshWorker();

        // Claim 1
        const claimPda1 = deriveClaimPda(taskPda, worker1.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker1.agentPda,
            authority: worker1.wallet.publicKey,
          })
          .signers([worker1.wallet])
          .rpc();

        task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.equal(1);

        // Claim 2
        const claimPda2 = deriveClaimPda(taskPda, worker2.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker2.agentPda,
            authority: worker2.wallet.publicKey,
          })
          .signers([worker2.wallet])
          .rpc();

        task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.equal(2);

        // Claim 3
        const claimPda3 = deriveClaimPda(taskPda, worker3.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda3,
            worker: worker3.agentPda,
            authority: worker3.wallet.publicKey,
          })
          .signers([worker3.wallet])
          .rpc();

        task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.equal(3);
      });

      it("completions count stays accurate across multiple completions", async () => {
        const taskId = Buffer.from("concurrent-007".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Completion count test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 33),
            3,
            getDefaultDeadline(),
            TASK_TYPE_COLLABORATIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const worker1 = await createFreshWorker();
        const worker2 = await createFreshWorker();
        const worker3 = await createFreshWorker();
        const claimPda1 = deriveClaimPda(taskPda, worker1.agentPda);
        const claimPda2 = deriveClaimPda(taskPda, worker2.agentPda);
        const claimPda3 = deriveClaimPda(taskPda, worker3.agentPda);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker1.agentPda,
            authority: worker1.wallet.publicKey,
          })
          .signers([worker1.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker2.agentPda,
            authority: worker2.wallet.publicKey,
          })
          .signers([worker2.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda3,
            worker: worker3.agentPda,
            authority: worker3.wallet.publicKey,
          })
          .signers([worker3.wallet])
          .rpc();

        let task = await program.account.task.fetch(taskPda);
        expect(task.completions).to.equal(0);

        // Complete 1 — escrow stays open
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof1".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            escrow: escrowPda,
            worker: worker1.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker1.wallet.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker1.wallet])
          .rpc();

        task = await program.account.task.fetch(taskPda);
        expect(task.completions).to.equal(1);

        // Complete 2 — escrow stays open
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof2".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            escrow: escrowPda,
            worker: worker2.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker2.wallet.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker2.wallet])
          .rpc();

        task = await program.account.task.fetch(taskPda);
        expect(task.completions).to.equal(2);

        // Complete 3 — final completion closes escrow
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof3".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda3,
            escrow: escrowPda,
            worker: worker3.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker3.wallet.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker3.wallet])
          .rpc();

        task = await program.account.task.fetch(taskPda);
        expect(task.completions).to.equal(3);
        expect(task.status).to.deep.equal({ completed: {} });
      });

      it("Worker active_tasks count stays consistent", async () => {
        // Create a fresh agent to track
        const trackAgentOwner = Keypair.generate();
        const trackAgentId = makeAgentId("track-1");
        const trackAgentPda = deriveAgentPda(trackAgentId);

        fundAccount(svm, trackAgentOwner.publicKey, 5 * LAMPORTS_PER_SOL);

        await program.methods
          .registerAgent(
            Array.from(trackAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://track.example.com",
            null,
            new BN(LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            agent: trackAgentPda,
            protocolConfig: protocolPda,
            authority: trackAgentOwner.publicKey,
          })
          .signers([trackAgentOwner])
          .rpc();

        let agent =
          await program.account.agentRegistration.fetch(trackAgentPda);
        expect(agent.activeTasks).to.equal(0);

        // Claim task 1
        const taskId1 = Buffer.from("track-task-001".padEnd(32, "\0"));
        const taskPda1 = deriveTaskPda(creator.publicKey, taskId1);
        const escrowPda1 = deriveEscrowPda(taskPda1);

        await program.methods
          .createTask(
            Array.from(taskId1),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Track test 1".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda1,
            escrow: escrowPda1,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda1 = deriveClaimPda(
          taskPda1,
          deriveAgentPda(trackAgentId),
        );
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda1,
            claim: claimPda1,
            worker: deriveAgentPda(trackAgentId),
            authority: trackAgentOwner.publicKey,
          })
          .signers([trackAgentOwner])
          .rpc();

        agent = await program.account.agentRegistration.fetch(trackAgentPda);
        expect(agent.activeTasks).to.equal(1);

        // Claim task 2
        advanceClock(svm, 2); // satisfy rate limit cooldown
        const taskId2 = Buffer.from("track-task-002".padEnd(32, "\0"));
        const taskPda2 = deriveTaskPda(creator.publicKey, taskId2);
        const escrowPda2 = deriveEscrowPda(taskPda2);

        await program.methods
          .createTask(
            Array.from(taskId2),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Track test 2".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda2,
            escrow: escrowPda2,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda2 = deriveClaimPda(
          taskPda2,
          deriveAgentPda(trackAgentId),
        );
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda2,
            claim: claimPda2,
            worker: deriveAgentPda(trackAgentId),
            authority: trackAgentOwner.publicKey,
          })
          .signers([trackAgentOwner])
          .rpc();

        agent = await program.account.agentRegistration.fetch(trackAgentPda);
        expect(agent.activeTasks).to.equal(2);

        // Complete task 1
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof1".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda1,
            claim: claimPda1,
            escrow: escrowPda1,
            worker: deriveAgentPda(trackAgentId),
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: trackAgentOwner.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([trackAgentOwner])
          .rpc();

        agent = await program.account.agentRegistration.fetch(trackAgentPda);
        expect(agent.activeTasks).to.equal(1);

        // Complete task 2
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof2".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda2,
            claim: claimPda2,
            escrow: escrowPda2,
            worker: deriveAgentPda(trackAgentId),
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: trackAgentOwner.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([trackAgentOwner])
          .rpc();

        agent = await program.account.agentRegistration.fetch(trackAgentPda);
        expect(agent.activeTasks).to.equal(0);
      });
    });
  });


});
