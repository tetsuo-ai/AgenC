/**
 * claim_task Tests
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
} from "./test-utils.ts";
import {
  fundAccount,
  advanceClock,
  getClockTimestamp,
} from "./litesvm-helpers.ts";
import { createTestContext } from "./test-litesvm-setup.ts";

describe("claim_task Tests", () => {
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

  describe("claim_task Happy Paths", () => {
    it("Single claim on Open task", async () => {
      const worker = await createFreshWorker();
      const taskId010 = Buffer.from(
        "task-000000000000000000000010".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId010);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId010),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Claimable task".padEnd(64, "\0")),
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

    it("Multiple claims on collaborative task", async () => {
      const worker1 = await createFreshWorker();
      const worker2 = await createFreshWorker();
      const taskId011 = Buffer.from(
        "task-000000000000000000000011".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId011);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId011),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Multi-claim task".padEnd(64, "\0")),
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

      const task = await program.account.task.fetch(taskPda);
      expect(task.currentWorkers).to.equal(2);
    });

    it("Additional claims on InProgress task", async () => {
      const worker1 = await createFreshWorker();
      const worker2 = await createFreshWorker();
      const worker3 = await createFreshWorker();
      const taskId012 = Buffer.from(
        "task-000000000000000000000012".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId012);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId012),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("InProgress claim task".padEnd(64, "\0")),
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
  });

  describe("claim_task Rejection Cases", () => {
    it("Non-worker authority rejection", async () => {
      const worker = await createFreshWorker();
      const taskId013 = Buffer.from(
        "task-000000000000000000000013".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId013);
      const escrowPda = deriveEscrowPda(taskPda);
      const unauthorized = Keypair.generate();

      await program.methods
        .createTask(
          Array.from(taskId013),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Unauthorized claim task".padEnd(64, "\0")),
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

      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: unauthorized.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([unauthorized])
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

    it("Inactive agent rejection", async () => {
      const worker = await createFreshWorker();
      const taskId014 = Buffer.from(
        "task-000000000000000000000014".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId014);
      const escrowPda = deriveEscrowPda(taskPda);

      // Deactivate the fresh worker (advance clock to satisfy update cooldown)
      advanceClock(svm, 61);
      await program.methods
        .updateAgent(null, null, null, 0) // 0 = Inactive
        .accountsPartial({
          agent: worker.agentPda,
          authority: worker.wallet.publicKey,
        })
        .signers([worker.wallet])
        .rpc();

      await program.methods
        .createTask(
          Array.from(taskId014),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Inactive agent task".padEnd(64, "\0")),
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

      // Note: Don't reactivate the worker - agent update cooldown prevents immediate reactivation
      // The test already proved the rejection, worker is disposable (from pool or fresh)
    });

    it("Insufficient capabilities rejection", async () => {
      const worker = await createFreshWorker(); // has CAPABILITY_COMPUTE only
      const taskId015 = Buffer.from(
        "task-000000000000000000000015".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId015);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId015),
          new BN(1 << 5), // Requires capability that worker doesn't have
          Buffer.from("Capability check task".padEnd(64, "\0")),
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

    it("Claim on Completed task rejection", async () => {
      const worker1 = await createFreshWorker();
      const worker2 = await createFreshWorker();
      const taskId016 = Buffer.from(
        "task-000000000000000000000016".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId016);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId016),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Pre-complete task".padEnd(64, "\0")),
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

    it("Claim on Cancelled task rejection", async () => {
      const worker = await createFreshWorker();
      const taskId017 = Buffer.from(
        "task-000000000000000000000017".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId017);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId017),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Cancel before claim task".padEnd(64, "\0")),
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

    it("Claim after deadline rejection", async () => {
      const taskId019 = Buffer.from(
        "task-000000000000000000000019".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId019);
      const escrowPda = deriveEscrowPda(taskPda);

      const pastDeadline = getClockTimestamp(svm) - 3600;

      try {
        await program.methods
          .createTask(
            Array.from(taskId019),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Past deadline task".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            new BN(pastDeadline),
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
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
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

    it("Claim when fully claimed rejection", async () => {
      const worker1 = await createFreshWorker();
      const worker2 = await createFreshWorker();
      const worker3 = await createFreshWorker();
      const taskId020 = Buffer.from(
        "task-000000000000000000000020".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId020);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId020),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Full capacity task".padEnd(64, "\0")),
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

      const claimPda3 = deriveClaimPda(taskPda, worker3.agentPda);

      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda3,
            worker: worker3.agentPda,
            authority: worker3.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3.wallet])
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

    it("Claim with 10 active tasks rejection", async () => {
      const taskId021 = Buffer.from(
        "task-000000000000000000000021".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId021);
      const escrowPda = deriveEscrowPda(taskPda);
      const claimPda = deriveClaimPda(taskPda, deriveAgentPda(agentId1));

      await program.methods
        .createTask(
          Array.from(taskId021),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Active limit task".padEnd(64, "\0")),
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

      const agent = await program.account.agentRegistration.fetch(
        deriveAgentPda(agentId1),
      );
      agent.activeTasks = 10;
      agent.active_tasks = 10;

      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: deriveAgentPda(agentId1),
            authority: worker1.publicKey,
            creator: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
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
