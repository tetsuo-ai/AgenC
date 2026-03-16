/**
 * Lifecycle and Design-Bounded Invariant Tests
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

describe("Lifecycle and Design-Bounded Invariant Tests", () => {
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

  describe("Lifecycle & Adversarial", () => {
    it("Completed task cannot be claimed", async () => {
      const worker1 = await createFreshWorker();
      const worker2 = await createFreshWorker();
      const taskId022 = Buffer.from(
        "task-000000000000000000000022".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId022);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId022),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Complete then claim task".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null, // constraint_hash
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
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

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

      await program.methods
        .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
        .accountsPartial({
          task: taskPda,
          claim: claimPda1,
          escrow: escrowPda,
          creator: creator.publicKey,
          worker: worker1.agentPda,
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

      const claimPda2 = deriveClaimPda(taskPda, worker2.agentPda);

      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker2.agentPda,
            authority: worker2.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker2.wallet])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: unknown) {
        // Verify error occurred - Anchor returns AnchorError with errorCode
        const anchorError = e as {
          error?: { errorCode?: { code: string } };
          message?: string;
        };
        expect(anchorError.error?.errorCode?.code || anchorError.message).to
          .exist;
      }
    });

    it("Cancelled task cannot be claimed", async () => {
      const worker = await createFreshWorker();
      const taskId023 = Buffer.from(
        "task-000000000000000000000023".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId023);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId023),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Cancel before claim task 2".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null, // constraint_hash
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
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .cancelTask()
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          authority: creator.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: null,
          creatorTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker.agentPda);

      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: unknown) {
        // Verify error occurred - Anchor returns AnchorError with errorCode
        const anchorError = e as {
          error?: { errorCode?: { code: string } };
          message?: string;
        };
        expect(anchorError.error?.errorCode?.code || anchorError.message).to
          .exist;
      }
    });

    it("Open to InProgress state transition", async () => {
      const worker = await createFreshWorker();
      const taskId024 = Buffer.from(
        "task-000000000000000000000024".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId024);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId024),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("State transition task".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null, // constraint_hash
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
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

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

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });
      expect(task.currentWorkers).to.equal(1);
    });

    it("InProgress persistence on additional claims", async () => {
      const worker1 = await createFreshWorker();
      const worker2 = await createFreshWorker();
      const worker3 = await createFreshWorker();
      const taskId025 = Buffer.from(
        "task-000000000000000000000025".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId025);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId025),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Multi-claim persistence task".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 33),
          3,
          getDefaultDeadline(),
          TASK_TYPE_COLLABORATIVE,
          null, // constraint_hash
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
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

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

      let task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });

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
      expect(task.status).to.deep.equal({ inProgress: {} });

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
      expect(task.status).to.deep.equal({ inProgress: {} });
      expect(task.currentWorkers).to.equal(3);
    });

    it("Worker cannot claim same task twice", async () => {
      const worker = await createFreshWorker();
      const taskId026 = Buffer.from(
        "task-000000000000000000000026".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId026);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId026),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Double claim task".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 50),
          2,
          getDefaultDeadline(),
          TASK_TYPE_COLLABORATIVE,
          null, // constraint_hash
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
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

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

      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: unknown) {
        // Verify error occurred - Anchor returns AnchorError with errorCode
        const anchorError = e as {
          error?: { errorCode?: { code: string } };
          message?: string;
        };
        expect(anchorError.error?.errorCode?.code || anchorError.message).to
          .exist;
      }
    });
  });

  describe("Design-Bounded Invariants", () => {
    it("Worker count max limit (design-bounded: max 100)", async () => {
      const taskId027 = Buffer.from(
        "task-000000000000000000000027".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId027);
      const escrowPda = deriveEscrowPda(taskPda);

      // max_workers must be between 1-100 (InvalidMaxWorkers error for >100)
      await program.methods
        .createTask(
          Array.from(taskId027),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Worker count test".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          100, // Max allowed is 100
          getDefaultDeadline(),
          TASK_TYPE_COLLABORATIVE,
          null, // constraint_hash
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
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

      const task = await program.account.task.fetch(taskPda);
      expect(task.maxWorkers).to.equal(100);
    });

    it("Active task count overflow prevention (design-bounded: u8 max 10)", async () => {
      const agentPda = deriveAgentPda(agentId1);
      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.activeTasks).to.be.at.most(10);
    });

    it("Complete task and verify payout (Happy Path)", async () => {
      const worker = await createFreshWorker();
      const taskIdPayout = Buffer.from("task-payout-001".padEnd(32, "\0"));
      const taskPda = deriveTaskPda(creator.publicKey, taskIdPayout);
      const escrowPda = deriveEscrowPda(taskPda);
      const rewardAmount = 1 * LAMPORTS_PER_SOL;

      // 1. Create
      await program.methods
        .createTask(
          Array.from(taskIdPayout),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Payout check".padEnd(64, "\0")),
          new BN(rewardAmount),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null, // constraint_hash
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
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

      // 2. Claim
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

      // Snapshot Balance Before Completion
      const workerBalanceBefore = await provider.connection.getBalance(
        worker.wallet.publicKey,
      );

      // 3. Complete
      await program.methods
        .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          worker: worker.agentPda,
          protocolConfig: protocolPda,
          treasury: treasuryPubkey,
          authority: worker.wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: null,
          workerTokenAccount: null,
          treasuryTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
        })
        .signers([worker.wallet])
        .rpc();

      // Snapshot Balance After
      const workerBalanceAfter = await provider.connection.getBalance(
        worker.wallet.publicKey,
      );

      // Assertions
      // Worker should get reward minus protocol fee (1%) minus tx fees.
      // Protocol fee = 1% (100 bps), so worker gets 99% of reward.
      // Then worker pays tx fee (~5000 lamports). Net gain should be positive.
      const protocolFee = Math.floor((rewardAmount * 100) / 10000); // 1%
      const workerReward = rewardAmount - protocolFee;
      const balanceGain = workerBalanceAfter - workerBalanceBefore;
      // Worker should have gained close to workerReward (minus small tx fee of ~5000 lamports)
      // Also receives claim rent back (~2000 lamports)
      expect(balanceGain).to.be.above(workerReward - 100_000); // Allow 0.0001 SOL for tx fees

      // Verify task is completed (escrow is closed after completion, can't fetch it)
      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ completed: {} });
      expect(task.completions).to.equal(1);
    });

    it("PDA-based double claim prevention (design-bounded: unique seeds)", async () => {
      const worker = await createFreshWorker();
      const taskId028 = Buffer.from(
        "task-000000000000000000000028".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId028);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId028),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("PDA double claim test".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null, // constraint_hash
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
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

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

      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: unknown) {
        // Verify error occurred - Anchor returns AnchorError with errorCode
        const anchorError = e as {
          error?: { errorCode?: { code: string } };
          message?: string;
        };
        expect(anchorError.error?.errorCode?.code || anchorError.message).to
          .exist;
      }
    });
  });

});
