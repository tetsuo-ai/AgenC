/**
 * Task Lifecycle Tests
 *
 * Tests for the complete task lifecycle: creation, claiming, completion, and cancellation.
 * Covers: createTask, claimTask, completeTask, cancelTask instructions.
 *
 * Run with: npx ts-mocha tests/task-lifecycle.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COLLABORATIVE,
  TASK_TYPE_COMPETITIVE,
  HASH_SIZE,
  RESULT_DATA_SIZE,
  deriveProtocolPda,
  deriveAgentPda,
  deriveTaskPda,
  deriveEscrowPda,
  deriveClaimPda,
  generateRunId,
  makeAgentId,
  makeTaskId,
  fundWallet,
  fundWallets,
  initializeProtocolIfNeeded,
  disableRateLimits,
  registerAgent,
  createTask,
  claimTask,
  completeTask,
  cancelTask,
  WorkerPool,
} from "./utils/test-helpers";

describe("Task Lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;
  const protocolPda = deriveProtocolPda(program.programId);
  const runId = generateRunId();

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;
  let creator: Keypair;
  let creatorAgentPda: PublicKey;
  let workerPool: WorkerPool;

  before(async () => {
    console.log("\n========================================");
    console.log("Task Lifecycle Tests");
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
    const creatorAgentId = makeAgentId("creator", runId);
    creatorAgentPda = await registerAgent(
      program,
      protocolPda,
      creatorAgentId,
      creator,
      CAPABILITY_COMPUTE
    );

    // Initialize worker pool
    workerPool = new WorkerPool(program, protocolPda, provider, runId);
    await workerPool.initialize(10);

    console.log("  Setup complete\n");
  });

  // ============================================================================
  // Task Creation
  // ============================================================================

  describe("Task Creation", () => {
    it("creates exclusive task with escrowed reward", async () => {
      const taskId = makeTaskId("create-1", runId);
      const reward = LAMPORTS_PER_SOL / 10;

      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        reward,
        taskType: TASK_TYPE_EXCLUSIVE,
      });

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ open: {} });
      expect(task.rewardAmount.toNumber()).to.equal(reward);
      expect(task.maxWorkers).to.equal(1);
      expect(task.currentWorkers).to.equal(0);
      expect(task.taskType).to.deep.equal({ exclusive: {} });

      const escrowBalance = await provider.connection.getBalance(escrowPda);
      expect(escrowBalance).to.be.greaterThanOrEqual(reward);

      console.log("  Exclusive task created with escrow");
    });

    it("creates collaborative task with multiple workers", async () => {
      const taskId = makeTaskId("create-2", runId);

      const { taskPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        maxWorkers: 3,
        taskType: TASK_TYPE_COLLABORATIVE,
      });

      const task = await program.account.task.fetch(taskPda);
      expect(task.taskType).to.deep.equal({ collaborative: {} });
      expect(task.maxWorkers).to.equal(3);

      console.log("  Collaborative task created");
    });

    it("creates competitive task", async () => {
      const taskId = makeTaskId("create-3", runId);

      const { taskPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        maxWorkers: 5,
        taskType: TASK_TYPE_COMPETITIVE,
      });

      const task = await program.account.task.fetch(taskPda);
      expect(task.taskType).to.deep.equal({ competitive: {} });
      expect(task.maxWorkers).to.equal(5);

      console.log("  Competitive task created");
    });

    it("creates private task with constraint hash", async () => {
      const taskId = makeTaskId("create-4", runId);
      const constraintHash = Buffer.alloc(HASH_SIZE, 0x42);

      const { taskPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        constraintHash,
      });

      const task = await program.account.task.fetch(taskPda);
      expect(Buffer.from(task.constraintHash)).to.deep.equal(constraintHash);

      console.log("  Private task created with constraint hash");
    });
  });

  // ============================================================================
  // Task Claiming
  // ============================================================================

  describe("Task Claiming", () => {
    it("allows qualified agent to claim task", async () => {
      const taskId = makeTaskId("claim-1", runId);
      const { taskPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        capabilities: CAPABILITY_COMPUTE,
      });

      const worker = workerPool.getWorker();
      const claimPda = await claimTask(
        program,
        protocolPda,
        taskPda,
        worker.agentPda,
        worker.wallet
      );

      const claim = await program.account.taskClaim.fetch(claimPda);
      expect(claim.task.toBase58()).to.equal(taskPda.toBase58());
      expect(claim.worker.toBase58()).to.equal(worker.agentPda.toBase58());
      expect(claim.isCompleted).to.be.false;

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });
      expect(task.currentWorkers).to.equal(1);

      console.log("  Task claimed successfully");
    });

    it("allows multiple workers to claim collaborative task", async () => {
      const taskId = makeTaskId("claim-2", runId);
      const { taskPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        maxWorkers: 3,
        taskType: TASK_TYPE_COLLABORATIVE,
      });

      const worker1 = workerPool.getWorker();
      const worker2 = workerPool.getWorker();

      await claimTask(program, protocolPda, taskPda, worker1.agentPda, worker1.wallet);
      await claimTask(program, protocolPda, taskPda, worker2.agentPda, worker2.wallet);

      const task = await program.account.task.fetch(taskPda);
      expect(task.currentWorkers).to.equal(2);

      console.log("  Multiple workers claimed collaborative task");
    });

    it("rejects claim on fully claimed task", async () => {
      const taskId = makeTaskId("claim-3", runId);
      const { taskPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        maxWorkers: 1,
      });

      const worker1 = workerPool.getWorker();
      const worker2 = workerPool.getWorker();

      await claimTask(program, protocolPda, taskPda, worker1.agentPda, worker1.wallet);

      try {
        await claimTask(program, protocolPda, taskPda, worker2.agentPda, worker2.wallet);
        expect.fail("Should have rejected claim on full task");
      } catch (e: any) {
        expect(e.message).to.include("TaskFullyClaimed");
        console.log("  Claim on full task rejected");
      }
    });

    it("rejects duplicate claim by same worker", async () => {
      const taskId = makeTaskId("claim-4", runId);
      const { taskPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        maxWorkers: 3,
        taskType: TASK_TYPE_COLLABORATIVE,
      });

      const worker = workerPool.getWorker();
      await claimTask(program, protocolPda, taskPda, worker.agentPda, worker.wallet);

      try {
        await claimTask(program, protocolPda, taskPda, worker.agentPda, worker.wallet);
        expect.fail("Should have rejected duplicate claim");
      } catch (e: any) {
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("AlreadyClaimed") || msg.includes("already in use")
        );
        console.log("  Duplicate claim rejected");
      }
    });
  });

  // ============================================================================
  // Task Completion
  // ============================================================================

  describe("Task Completion", () => {
    it("completes task and pays reward", async () => {
      const taskId = makeTaskId("complete-1", runId);
      const reward = LAMPORTS_PER_SOL / 10;

      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        reward,
      });

      const worker = await workerPool.createFreshWorker();
      const claimPda = await claimTask(
        program,
        protocolPda,
        taskPda,
        worker.agentPda,
        worker.wallet
      );

      const balanceBefore = await provider.connection.getBalance(worker.wallet.publicKey);

      await completeTask(
        program,
        protocolPda,
        taskPda,
        claimPda,
        escrowPda,
        worker.agentPda,
        worker.wallet,
        treasuryPubkey
      );

      const balanceAfter = await provider.connection.getBalance(worker.wallet.publicKey);
      expect(balanceAfter).to.be.greaterThan(balanceBefore);

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ completed: {} });
      expect(task.completions).to.equal(1);

      const claim = await program.account.taskClaim.fetch(claimPda);
      expect(claim.isCompleted).to.be.true;

      console.log("  Task completed and reward paid");
    });

    it("updates worker statistics on completion", async () => {
      const taskId = makeTaskId("complete-2", runId);
      const reward = LAMPORTS_PER_SOL / 10;

      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        reward,
      });

      const worker = await workerPool.createFreshWorker();
      const agentBefore = await program.account.agentRegistration.fetch(worker.agentPda);
      const tasksBefore = agentBefore.tasksCompleted;

      const claimPda = await claimTask(
        program,
        protocolPda,
        taskPda,
        worker.agentPda,
        worker.wallet
      );

      await completeTask(
        program,
        protocolPda,
        taskPda,
        claimPda,
        escrowPda,
        worker.agentPda,
        worker.wallet,
        treasuryPubkey
      );

      const agentAfter = await program.account.agentRegistration.fetch(worker.agentPda);
      expect(agentAfter.tasksCompleted).to.equal(tasksBefore + 1);
      expect(agentAfter.totalEarned.toNumber()).to.be.greaterThan(0);

      console.log("  Worker statistics updated");
    });

    it("competitive task allows only first completion", async () => {
      const taskId = makeTaskId("complete-3", runId);

      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        maxWorkers: 2,
        taskType: TASK_TYPE_COMPETITIVE,
      });

      const worker1 = await workerPool.createFreshWorker();
      const worker2 = await workerPool.createFreshWorker();

      const claim1Pda = await claimTask(program, protocolPda, taskPda, worker1.agentPda, worker1.wallet);
      const claim2Pda = await claimTask(program, protocolPda, taskPda, worker2.agentPda, worker2.wallet);

      // First worker completes
      await completeTask(
        program,
        protocolPda,
        taskPda,
        claim1Pda,
        escrowPda,
        worker1.agentPda,
        worker1.wallet,
        treasuryPubkey
      );

      // Second worker tries to complete
      try {
        await completeTask(
          program,
          protocolPda,
          taskPda,
          claim2Pda,
          escrowPda,
          worker2.agentPda,
          worker2.wallet,
          treasuryPubkey
        );
        expect.fail("Should have rejected second completion");
      } catch (e: any) {
        expect(e.message).to.include("CompetitiveTaskAlreadyWon");
        console.log("  Second completion on competitive task rejected");
      }
    });
  });

  // ============================================================================
  // Task Cancellation
  // ============================================================================

  describe("Task Cancellation", () => {
    it("allows creator to cancel unclaimed task", async () => {
      const taskId = makeTaskId("cancel-1", runId);
      const reward = LAMPORTS_PER_SOL / 10;

      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
        reward,
      });

      const balanceBefore = await provider.connection.getBalance(creator.publicKey);

      await cancelTask(program, taskPda, escrowPda, creator);

      const balanceAfter = await provider.connection.getBalance(creator.publicKey);
      expect(balanceAfter).to.be.greaterThan(balanceBefore * 0.99);

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ cancelled: {} });

      console.log("  Unclaimed task cancelled with refund");
    });

    it("rejects cancellation by non-creator", async () => {
      const taskId = makeTaskId("cancel-2", runId);
      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
      });

      const nonCreator = Keypair.generate();
      await fundWallet(provider.connection, nonCreator);

      try {
        await program.methods
          .cancelTask()
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            creator: nonCreator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([nonCreator])
          .rpc();
        expect.fail("Should have rejected non-creator cancellation");
      } catch (e: any) {
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("UnauthorizedTaskAction") ||
          msg.includes("InvalidCreator") ||
          msg.includes("constraint")
        );
        console.log("  Non-creator cancellation rejected");
      }
    });

    it("rejects cancellation of claimed task", async () => {
      const taskId = makeTaskId("cancel-3", runId);
      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
      });

      const worker = workerPool.getWorker();
      await claimTask(program, protocolPda, taskPda, worker.agentPda, worker.wallet);

      try {
        await cancelTask(program, taskPda, escrowPda, creator);
        expect.fail("Should have rejected cancellation of claimed task");
      } catch (e: any) {
        expect(e.message).to.include("TaskCannotBeCancelled");
        console.log("  Claimed task cancellation rejected");
      }
    });
  });

  // ============================================================================
  // Task State Machine Validation
  // ============================================================================

  describe("State Machine Validation", () => {
    it("Open -> InProgress (via claim)", async () => {
      const taskId = makeTaskId("state-1", runId);
      const { taskPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
      });

      let task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ open: {} });

      const worker = workerPool.getWorker();
      await claimTask(program, protocolPda, taskPda, worker.agentPda, worker.wallet);

      task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });

      console.log("  Open -> InProgress transition verified");
    });

    it("InProgress -> Completed (via complete)", async () => {
      const taskId = makeTaskId("state-2", runId);
      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
      });

      const worker = await workerPool.createFreshWorker();
      const claimPda = await claimTask(program, protocolPda, taskPda, worker.agentPda, worker.wallet);

      let task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });

      await completeTask(
        program,
        protocolPda,
        taskPda,
        claimPda,
        escrowPda,
        worker.agentPda,
        worker.wallet,
        treasuryPubkey
      );

      task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ completed: {} });

      console.log("  InProgress -> Completed transition verified");
    });

    it("Open -> Cancelled (via cancel)", async () => {
      const taskId = makeTaskId("state-3", runId);
      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
      });

      let task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ open: {} });

      await cancelTask(program, taskPda, escrowPda, creator);

      task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ cancelled: {} });

      console.log("  Open -> Cancelled transition verified");
    });

    it("rejects claim on cancelled task", async () => {
      const taskId = makeTaskId("state-4", runId);
      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
      });

      await cancelTask(program, taskPda, escrowPda, creator);

      const worker = workerPool.getWorker();
      try {
        await claimTask(program, protocolPda, taskPda, worker.agentPda, worker.wallet);
        expect.fail("Should have rejected claim on cancelled task");
      } catch (e: any) {
        expect(e.message).to.include("TaskNotOpen");
        console.log("  Claim on cancelled task rejected");
      }
    });

    it("rejects claim on completed task", async () => {
      const taskId = makeTaskId("state-5", runId);
      const { taskPda, escrowPda } = await createTask({
        program,
        protocolPda,
        taskId,
        creatorAgentPda,
        creatorWallet: creator,
      });

      const worker1 = await workerPool.createFreshWorker();
      const claimPda = await claimTask(program, protocolPda, taskPda, worker1.agentPda, worker1.wallet);

      await completeTask(
        program,
        protocolPda,
        taskPda,
        claimPda,
        escrowPda,
        worker1.agentPda,
        worker1.wallet,
        treasuryPubkey
      );

      const worker2 = workerPool.getWorker();
      try {
        await claimTask(program, protocolPda, taskPda, worker2.agentPda, worker2.wallet);
        expect.fail("Should have rejected claim on completed task");
      } catch (e: any) {
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("TaskNotOpen") || msg.includes("TaskFullyClaimed")
        );
        console.log("  Claim on completed task rejected");
      }
    });
  });

  after(() => {
    console.log("\n========================================");
    console.log("Task Lifecycle Tests Complete");
    console.log("========================================\n");
  });
});
