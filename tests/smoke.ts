/**
 * AgenC Devnet Smoke Tests
 *
 * Quick verification of core protocol functionality.
 * Run with: anchor test --skip-local-validator
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";
import BN from "bn.js";
import { AgencCoordination } from "../target/types/agenc_coordination";

describe("AgenC Smoke Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  // Unique run ID to avoid conflicts with persisted state
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // PDAs
  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  // Test accounts
  let treasury: Keypair;
  let agent: Keypair;
  let taskCreator: Keypair;
  let agentId: Buffer;
  let agentPda: PublicKey;

  // Constants
  const CAPABILITY_COMPUTE = 1 << 0;
  const CAPABILITY_ARBITER = 1 << 7;

  function deriveTaskPda(creatorPubkey: PublicKey, taskId: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("task"), creatorPubkey.toBuffer(), taskId],
      program.programId
    )[0];
  }

  function deriveEscrowPda(taskPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), taskPda.toBuffer()],
      program.programId
    )[0];
  }

  function deriveClaimPda(taskPda: PublicKey, workerPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()],
      program.programId
    )[0];
  }

  before(async () => {
    console.log("\n========================================");
    console.log("AgenC Smoke Tests");
    console.log("Program ID:", program.programId.toBase58());
    console.log("Run ID:", runId);
    console.log("========================================\n");

    // Generate test accounts
    treasury = Keypair.generate();
    agent = Keypair.generate();
    taskCreator = Keypair.generate();
    agentId = Buffer.from(`smoke-${runId}`.slice(0, 32).padEnd(32, "\0"));
    agentPda = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentId],
      program.programId
    )[0];

    // Fund test accounts
    console.log("Funding test accounts...");
    const wallets = [treasury, agent, taskCreator];
    const airdropSigs = await Promise.all(
      wallets.map(w => provider.connection.requestAirdrop(w.publicKey, 10 * LAMPORTS_PER_SOL))
    );
    await Promise.all(
      airdropSigs.map(sig => provider.connection.confirmTransaction(sig, "confirmed"))
    );
    console.log("  Accounts funded\n");
  });

  describe("1. Protocol Initialization", () => {
    it("initializes protocol config", async () => {
      try {
        await program.methods
          .initializeProtocol(
            51,                              // dispute_quorum_percent
            100,                             // dispute_vote_period
            new BN(LAMPORTS_PER_SOL / 100),  // min_stake
            1,                               // min_multisig_signers
            [provider.wallet.publicKey]      // multisig_signers
          )
          .accountsPartial({
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: provider.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
          ])
          .rpc({ skipPreflight: true });

        console.log("  Protocol initialized");
      } catch (e: any) {
        // Protocol may already be initialized
        if (e.message?.includes("already in use")) {
          console.log("  Protocol already initialized (OK)");
        } else {
          throw e;
        }
      }

      // Verify protocol config exists
      const config = await program.account.protocolConfig.fetch(protocolPda);
      assert.isTrue(config.isInitialized, "Protocol should be initialized");
      console.log("  Treasury:", config.treasury.toBase58());
    });
  });

  describe("2. Agent Registration", () => {
    it("registers an agent with COMPUTE capability", async () => {
      await program.methods
        .registerAgent(
          Array.from(agentId),
          new BN(CAPABILITY_COMPUTE | CAPABILITY_ARBITER),
          `https://smoke-test-${runId}.example.com`,
          null,
          new BN(LAMPORTS_PER_SOL / 10)
        )
        .accountsPartial({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: agent.publicKey,
        })
        .signers([agent])
        .rpc({ skipPreflight: true });

      // Verify agent registration
      const agentAccount = await program.account.agentRegistration.fetch(agentPda);
      assert.equal(
        agentAccount.authority.toBase58(),
        agent.publicKey.toBase58(),
        "Agent authority should match"
      );
      assert.isTrue(
        agentAccount.capabilities.toNumber() & CAPABILITY_COMPUTE,
        "Agent should have COMPUTE capability"
      );
      console.log("  Agent registered:", agentPda.toBase58().slice(0, 16) + "...");
    });

    it("queries agent state correctly", async () => {
      const agentAccount = await program.account.agentRegistration.fetch(agentPda);
      assert.equal(agentAccount.status, 1, "Agent should be Active (status=1)");
      assert.isTrue(agentAccount.stake.toNumber() > 0, "Agent should have stake");
      console.log("  Agent status: Active");
      console.log("  Agent stake:", agentAccount.stake.toNumber() / LAMPORTS_PER_SOL, "SOL");
    });
  });

  describe("3. Task Lifecycle", () => {
    const taskId = Buffer.from(`task-${runId}`.slice(0, 32).padEnd(32, "\0"));
    let taskPda: PublicKey;
    let escrowPda: PublicKey;
    let claimPda: PublicKey;
    const taskReward = new BN(LAMPORTS_PER_SOL / 10); // 0.1 SOL

    before(() => {
      taskPda = deriveTaskPda(taskCreator.publicKey, taskId);
      escrowPda = deriveEscrowPda(taskPda);
      claimPda = deriveClaimPda(taskPda, agentPda);
    });

    it("creates a task with escrowed reward", async () => {
      const creatorBalanceBefore = await provider.connection.getBalance(taskCreator.publicKey);

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Smoke test task".padEnd(64, "\0")),
          null,  // No constraint hash (public task)
          taskReward,
          1,     // max_workers
          0,     // task_type: Exclusive
          new BN(0)  // deadline: none
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          creator: taskCreator.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([taskCreator])
        .rpc({ skipPreflight: true });

      // Verify task created
      const task = await program.account.task.fetch(taskPda);
      assert.equal(task.status, 0, "Task should be Open (status=0)");
      assert.equal(
        task.rewardAmount.toNumber(),
        taskReward.toNumber(),
        "Task reward should match"
      );

      // Verify escrow funded
      const escrowBalance = await provider.connection.getBalance(escrowPda);
      assert.isTrue(escrowBalance >= taskReward.toNumber(), "Escrow should hold reward");

      console.log("  Task created:", taskPda.toBase58().slice(0, 16) + "...");
      console.log("  Escrow balance:", escrowBalance / LAMPORTS_PER_SOL, "SOL");
    });

    it("allows agent to claim the task", async () => {
      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          worker: agentPda,
          authority: agent.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc({ skipPreflight: true });

      // Verify claim
      const claim = await program.account.taskClaim.fetch(claimPda);
      assert.equal(claim.worker.toBase58(), agentPda.toBase58(), "Claim worker should match");
      assert.isFalse(claim.isCompleted, "Claim should not be completed yet");

      // Verify task status updated
      const task = await program.account.task.fetch(taskPda);
      assert.equal(task.status, 1, "Task should be InProgress (status=1)");
      assert.equal(task.currentWorkers, 1, "Task should have 1 worker");

      console.log("  Task claimed by agent");
    });

    it("allows agent to complete the task", async () => {
      const agentBalanceBefore = await provider.connection.getBalance(agent.publicKey);
      const config = await program.account.protocolConfig.fetch(protocolPda);

      const resultData = Buffer.alloc(64);
      resultData.write("smoke_test_result");
      const proofHash = Buffer.alloc(32);
      proofHash.write("proof_hash_smoke");

      await program.methods
        .completeTask(Array.from(proofHash), Array.from(resultData))
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          worker: agentPda,
          authority: agent.publicKey,
          treasury: config.treasury,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc({ skipPreflight: true });

      // Verify completion
      const claim = await program.account.taskClaim.fetch(claimPda);
      assert.isTrue(claim.isCompleted, "Claim should be completed");

      const task = await program.account.task.fetch(taskPda);
      assert.equal(task.status, 3, "Task should be Completed (status=3)");
      assert.equal(task.completions, 1, "Task should have 1 completion");

      // Verify reward paid
      const agentBalanceAfter = await provider.connection.getBalance(agent.publicKey);
      assert.isTrue(
        agentBalanceAfter > agentBalanceBefore,
        "Agent balance should increase"
      );

      console.log("  Task completed");
      console.log("  Reward received:", (agentBalanceAfter - agentBalanceBefore) / LAMPORTS_PER_SOL, "SOL");
    });

    it("verifies agent reputation updated", async () => {
      const agentAccount = await program.account.agentRegistration.fetch(agentPda);
      assert.equal(agentAccount.tasksCompleted, 1, "Agent should have 1 task completed");
      assert.isTrue(agentAccount.totalEarned.toNumber() > 0, "Agent should have earnings");
      console.log("  Tasks completed:", agentAccount.tasksCompleted);
      console.log("  Total earned:", agentAccount.totalEarned.toNumber() / LAMPORTS_PER_SOL, "SOL");
    });
  });

  describe("4. Task Cancellation", () => {
    const cancelTaskId = Buffer.from(`cancel-${runId}`.slice(0, 32).padEnd(32, "\0"));
    let cancelTaskPda: PublicKey;
    let cancelEscrowPda: PublicKey;
    const cancelReward = new BN(LAMPORTS_PER_SOL / 20);

    before(() => {
      cancelTaskPda = deriveTaskPda(taskCreator.publicKey, cancelTaskId);
      cancelEscrowPda = deriveEscrowPda(cancelTaskPda);
    });

    it("creates a task for cancellation", async () => {
      await program.methods
        .createTask(
          Array.from(cancelTaskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Task to cancel".padEnd(64, "\0")),
          null,
          cancelReward,
          1,
          0,
          new BN(0)
        )
        .accountsPartial({
          task: cancelTaskPda,
          escrow: cancelEscrowPda,
          creator: taskCreator.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([taskCreator])
        .rpc({ skipPreflight: true });

      console.log("  Task created for cancellation");
    });

    it("allows creator to cancel unclaimed task", async () => {
      const creatorBalanceBefore = await provider.connection.getBalance(taskCreator.publicKey);

      await program.methods
        .cancelTask()
        .accountsPartial({
          task: cancelTaskPda,
          escrow: cancelEscrowPda,
          creator: taskCreator.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([taskCreator])
        .rpc({ skipPreflight: true });

      // Verify task cancelled
      const task = await program.account.task.fetch(cancelTaskPda);
      assert.equal(task.status, 4, "Task should be Cancelled (status=4)");

      // Verify refund
      const creatorBalanceAfter = await provider.connection.getBalance(taskCreator.publicKey);
      assert.isTrue(
        creatorBalanceAfter > creatorBalanceBefore,
        "Creator should receive refund"
      );

      console.log("  Task cancelled");
      console.log("  Refund received:", (creatorBalanceAfter - creatorBalanceBefore) / LAMPORTS_PER_SOL, "SOL");
    });
  });

  describe("5. Agent Deregistration", () => {
    it("allows agent to deregister and receive stake", async () => {
      // First update agent to have no active tasks
      const agentAccount = await program.account.agentRegistration.fetch(agentPda);
      const stakeAmount = agentAccount.stake.toNumber();
      const agentBalanceBefore = await provider.connection.getBalance(agent.publicKey);

      await program.methods
        .deregisterAgent()
        .accountsPartial({
          agent: agentPda,
          authority: agent.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc({ skipPreflight: true });

      // Verify stake returned
      const agentBalanceAfter = await provider.connection.getBalance(agent.publicKey);
      const balanceIncrease = agentBalanceAfter - agentBalanceBefore;

      // Account for transaction fees
      assert.isTrue(
        balanceIncrease > stakeAmount * 0.9,
        "Agent should receive most of stake back"
      );

      console.log("  Agent deregistered");
      console.log("  Stake returned:", balanceIncrease / LAMPORTS_PER_SOL, "SOL");
    });
  });

  after(() => {
    console.log("\n========================================");
    console.log("Smoke Tests Complete");
    console.log("========================================\n");
  });
});
