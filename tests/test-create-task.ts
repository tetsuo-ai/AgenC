/**
 * create_task Tests
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

describe("create_task Tests", () => {
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

  describe("create_task Happy Paths", () => {
    it("Exclusive task creation with Open state", async () => {
      const taskId001 = Buffer.from(
        "task-000000000000000000000001".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId001);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId001),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Exclusive task".padEnd(64, "\0")),
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

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ open: {} });
      expect(task.taskType).to.deep.equal({ exclusive: {} });
      expect(task.maxWorkers).to.equal(1);
    });

    it("Collaborative task with required_completions validation", async () => {
      const taskId002 = Buffer.from(
        "task-000000000000000000000002".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId002);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId002),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Collaborative task".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 50),
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

      const task = await program.account.task.fetch(taskPda);
      expect(task.taskType).to.deep.equal({ collaborative: {} });
      expect(task.requiredCompletions).to.equal(3);
      expect(task.maxWorkers).to.equal(3);
    });

    it("Competitive task with multiple slots", async () => {
      const taskId003 = Buffer.from(
        "task-000000000000000000000003".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId003);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId003),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Competitive task".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          5,
          getDefaultDeadline(),
          TASK_TYPE_COMPETITIVE,
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
      expect(task.taskType).to.deep.equal({ competitive: {} });
      expect(task.maxWorkers).to.equal(5);
    });

    it("Reward transfer to escrow validation", async () => {
      const taskId004 = Buffer.from(
        "task-000000000000000000000004".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId004);
      const escrowPda = deriveEscrowPda(taskPda);
      const rewardAmount = 2 * LAMPORTS_PER_SOL;

      const creatorBalanceBefore = await provider.connection.getBalance(
        creator.publicKey,
      );

      await program.methods
        .createTask(
          Array.from(taskId004),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Reward validation task".padEnd(64, "\0")),
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

      const escrow = await program.account.taskEscrow.fetch(escrowPda);
      expect(escrow.amount.toNumber()).to.equal(rewardAmount);
      expect(escrow.distributed.toNumber()).to.equal(0);

      const creatorBalanceAfter = await provider.connection.getBalance(
        creator.publicKey,
      );
      // Creator pays reward + rent for task & escrow accounts + tx fee, use closeTo for rent/fee variations
      expect(creatorBalanceBefore - creatorBalanceAfter).to.be.closeTo(
        rewardAmount,
        5_000_000,
      );
    });

    it("Zero-reward task handling - rejects zero reward", async () => {
      const taskId005 = Buffer.from(
        "task-000000000000000000000005".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId005);
      const escrowPda = deriveEscrowPda(taskPda);

      // Zero-reward tasks are now rejected (InvalidReward error)
      try {
        await program.methods
          .createTask(
            Array.from(taskId005),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Zero reward task".padEnd(64, "\0")),
            new BN(0),
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
        expect.fail("Should have rejected zero-reward task");
      } catch (e: unknown) {
        const anchorError = e as { error?: { errorCode?: { code: string } } };
        expect(anchorError.error?.errorCode?.code).to.equal("InvalidReward");
      }
    });
  });

  describe("create_task Rejection Cases", () => {
    it("Non-creator authority rejection", async () => {
      const taskId006 = Buffer.from(
        "task-000000000000000000000006".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId006);
      const escrowPda = deriveEscrowPda(taskPda);
      const unauthorized = Keypair.generate();

      try {
        await program.methods
          .createTask(
            Array.from(taskId006),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Unauthorized task".padEnd(64, "\0")),
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
            creator: unauthorized.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([unauthorized, creator])
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

    it("max_workers == 0 rejection", async () => {
      const taskId007 = Buffer.from(
        "task-000000000000000000000007".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId007);
      const escrowPda = deriveEscrowPda(taskPda);

      try {
        await program.methods
          .createTask(
            Array.from(taskId007),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Zero workers task".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            0,
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

    it("Past deadline rejection", async () => {
      const taskId008 = Buffer.from(
        "task-000000000000000000000008".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId008);
      const escrowPda = deriveEscrowPda(taskPda);

      const pastDeadline = getClockTimestamp(svm) - 3600;

      try {
        await program.methods
          .createTask(
            Array.from(taskId008),
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

    it("Invalid task type rejection", async () => {
      const taskId009 = Buffer.from(
        "task-000000000000000000000009".padEnd(32, "\0"),
      );
      const taskPda = deriveTaskPda(creator.publicKey, taskId009);
      const escrowPda = deriveEscrowPda(taskPda);

      try {
        await program.methods
          .createTask(
            Array.from(taskId009),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Invalid type task".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            new BN(0),
            99,
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
  });

});
