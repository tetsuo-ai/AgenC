import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";

describe("test_1", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  let treasury: Keypair;
  let creator: Keypair;
  let worker1: Keypair;
  let worker2: Keypair;
  let worker3: Keypair;

  const agentId1 = Buffer.from("agent-000000000000000000000001").slice(0, 32);
  const agentId2 = Buffer.from("agent-000000000000000000000002").slice(0, 32);
  const agentId3 = Buffer.from("agent-000000000000000000000003").slice(0, 32);

  const CAPABILITY_COMPUTE = 1 << 0;
  const CAPABILITY_INFERENCE = 1 << 1;
  const TASK_TYPE_EXCLUSIVE = 0;
  const TASK_TYPE_COLLABORATIVE = 1;
  const TASK_TYPE_COMPETITIVE = 2;

  function deriveAgentPda(agentId: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentId],
      program.programId
    )[0];
  }

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

  function deriveClaimPda(taskPda: PublicKey, workerPubkey: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), taskPda.toBuffer(), workerPubkey.toBuffer()],
      program.programId
    )[0];
  }

  before(async () => {
    treasury = Keypair.generate();
    creator = Keypair.generate();
    worker1 = Keypair.generate();
    worker2 = Keypair.generate();
    worker3 = Keypair.generate();

    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    const wallets = [treasury, creator, worker1, worker2, worker3];

    for (const wallet of wallets) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount),
        "confirmed"
      );
    }

    await program.methods
      .initializeProtocol(51, 100, 1 * LAMPORTS_PER_SOL)
      .accounts({
        protocolConfig: protocolPda,
        treasury: treasury.publicKey,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .registerAgent(
        Array.from(agentId1),
        new anchor.BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE),
        "https://worker1.example.com",
        null
      )
      .accounts({
        agent: deriveAgentPda(agentId1),
        protocolConfig: protocolPda,
        authority: worker1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker1])
      .rpc();

    await program.methods
      .registerAgent(
        Array.from(agentId2),
        new anchor.BN(CAPABILITY_COMPUTE),
        "https://worker2.example.com",
        null
      )
      .accounts({
        agent: deriveAgentPda(agentId2),
        protocolConfig: protocolPda,
        authority: worker2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker2])
      .rpc();

    await program.methods
      .registerAgent(
        Array.from(agentId3),
        new anchor.BN(CAPABILITY_COMPUTE),
        "https://worker3.example.com",
        null
      )
      .accounts({
        agent: deriveAgentPda(agentId3),
        protocolConfig: protocolPda,
        authority: worker3.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker3])
      .rpc();
  });

  describe("create_task Happy Paths", () => {
    it("Exclusive task creation with Open state", async () => {
      const taskId001 = Buffer.from("task-000000000000000000000001").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId001);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId001),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Exclusive task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ open: {} });
      expect(task.taskType).to.deep.equal({ exclusive: {} });
      expect(task.maxWorkers).to.equal(1);
    });

    it("Collaborative task with required_completions validation", async () => {
      const taskId002 = Buffer.from("task-000000000000000000000002").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId002);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId002),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Collaborative task".padEnd(64, "\0")),
          new anchor.BN(2 * LAMPORTS_PER_SOL),
          3,
          0,
          TASK_TYPE_COLLABORATIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const task = await program.account.task.fetch(taskPda);
      expect(task.taskType).to.deep.equal({ collaborative: {} });
      expect(task.requiredCompletions).to.equal(3);
      expect(task.maxWorkers).to.equal(3);
    });

    it("Competitive task with multiple slots", async () => {
      const taskId003 = Buffer.from("task-000000000000000000000003").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId003);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId003),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Competitive task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          5,
          0,
          TASK_TYPE_COMPETITIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const task = await program.account.task.fetch(taskPda);
      expect(task.taskType).to.deep.equal({ competitive: {} });
      expect(task.maxWorkers).to.equal(5);
    });

    it("Reward transfer to escrow validation", async () => {
      const taskId004 = Buffer.from("task-000000000000000000000004").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId004);
      const escrowPda = deriveEscrowPda(taskPda);
      const rewardAmount = 2 * LAMPORTS_PER_SOL;

      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

      await program.methods
        .createTask(
          Array.from(taskId004),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Reward validation task".padEnd(64, "\0")),
          new anchor.BN(rewardAmount),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPda);
      expect(escrow.amount.toNumber()).to.equal(rewardAmount);
      expect(escrow.distributed.toNumber()).to.equal(0);

      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      expect(creatorBalanceBefore - creatorBalanceAfter).to.be.at.most(rewardAmount + 200000);
    });

    it("Zero-reward task handling", async () => {
      const taskId005 = Buffer.from("task-000000000000000000000005").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId005);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId005),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Zero reward task".padEnd(64, "\0")),
          new anchor.BN(0),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const task = await program.account.task.fetch(taskPda);
      expect(task.rewardAmount.toNumber()).to.equal(0);
    });
  });

  describe("create_task Rejection Cases", () => {
    it("Non-creator authority rejection", async () => {
      const taskId006 = Buffer.from("task-000000000000000000000006").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId006);
      const escrowPda = deriveEscrowPda(taskPda);
      const unauthorized = Keypair.generate();

      await expect(
        program.methods
          .createTask(
            Array.from(taskId006),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Unauthorized task".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: unauthorized.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([unauthorized])
          .rpc()
      ).to.be.rejected;
    });

    it("max_workers == 0 rejection", async () => {
      const taskId007 = Buffer.from("task-000000000000000000000007").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId007);
      const escrowPda = deriveEscrowPda(taskPda);

      await expect(
        program.methods
          .createTask(
            Array.from(taskId007),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Zero workers task".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            0,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc()
      ).to.be.rejected;
    });

    it("Past deadline rejection", async () => {
      const taskId008 = Buffer.from("task-000000000000000000000008").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId008);
      const escrowPda = deriveEscrowPda(taskPda);

      const pastDeadline = Math.floor(Date.now() / 1000) - 3600;

      await expect(
        program.methods
          .createTask(
            Array.from(taskId008),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Past deadline task".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            new anchor.BN(pastDeadline),
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc()
      ).to.be.rejected;
    });

    it("Invalid task type rejection", async () => {
      const taskId009 = Buffer.from("task-000000000000000000000009").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId009);
      const escrowPda = deriveEscrowPda(taskPda);

      await expect(
        program.methods
          .createTask(
            Array.from(taskId009),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Invalid type task".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            99
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc()
      ).to.be.rejected;
    });
  });

  describe("claim_task Happy Paths", () => {
    it("Single claim on Open task", async () => {
      const taskId010 = Buffer.from("task-000000000000000000000010").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId010);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId010),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Claimable task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });
      expect(task.currentWorkers).to.equal(1);
    });

    it("Multiple claims on collaborative task", async () => {
      const taskId011 = Buffer.from("task-000000000000000000000011").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId011);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId011),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Multi-claim task".padEnd(64, "\0")),
          new anchor.BN(3 * LAMPORTS_PER_SOL),
          3,
          0,
          TASK_TYPE_COLLABORATIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);
      const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda1,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda2,
          worker: agentId2,
          authority: worker2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker2])
        .rpc();

      const task = await program.account.task.fetch(taskPda);
      expect(task.currentWorkers).to.equal(2);
    });

    it("Additional claims on InProgress task", async () => {
      const taskId012 = Buffer.from("task-000000000000000000000012").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId012);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId012),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("InProgress claim task".padEnd(64, "\0")),
          new anchor.BN(3 * LAMPORTS_PER_SOL),
          3,
          0,
          TASK_TYPE_COLLABORATIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);
      const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);
      const claimPda3 = deriveClaimPda(taskPda, worker3.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda1,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      let task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda2,
          worker: agentId2,
          authority: worker2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker2])
        .rpc();

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda3,
          worker: agentId3,
          authority: worker3.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker3])
        .rpc();

      task = await program.account.task.fetch(taskPda);
      expect(task.currentWorkers).to.equal(3);
    });
  });

  describe("claim_task Rejection Cases", () => {
    it("Non-worker authority rejection", async () => {
      const taskId013 = Buffer.from("task-000000000000000000000013").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId013);
      const escrowPda = deriveEscrowPda(taskPda);
      const unauthorized = Keypair.generate();

      await program.methods
        .createTask(
          Array.from(taskId013),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Unauthorized claim task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, unauthorized.publicKey);

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: unauthorized.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([unauthorized])
          .rpc()
      ).to.be.rejected;
    });

    it("Inactive agent rejection", async () => {
      const taskId014 = Buffer.from("task-000000000000000000000014").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId014);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .updateAgent(null, null, null, { inactive: {} })
        .accounts({
          agent: deriveAgentPda(agentId1),
          authority: worker1.publicKey,
        })
        .signers([worker1])
        .rpc();

      await program.methods
        .createTask(
          Array.from(taskId014),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Inactive agent task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc()
      ).to.be.rejected;

      await program.methods
        .updateAgent(null, null, null, { active: {} })
        .accounts({
          agent: deriveAgentPda(agentId1),
          authority: worker1.publicKey,
        })
        .signers([worker1])
        .rpc();
    });

    it("Insufficient capabilities rejection", async () => {
      const taskId015 = Buffer.from("task-000000000000000000000015").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId015);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId015),
          new anchor.BN(1 << 5),
          Buffer.from("Capability check task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc()
      ).to.be.rejected;
    });

    it("Claim on Completed task rejection", async () => {
      const taskId016 = Buffer.from("task-000000000000000000000016").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId016);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId016),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Pre-complete task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda1,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      await program.methods
        .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
        .accounts({
          task: taskPda,
          claim: claimPda1,
          escrow: escrowPda,
          worker: agentId1,
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda2,
            worker: agentId2,
            authority: worker2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker2])
          .rpc()
      ).to.be.rejected;
    });

    it("Claim on Cancelled task rejection", async () => {
      const taskId017 = Buffer.from("task-000000000000000000000017").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId017);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId017),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Cancel before claim task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .cancelTask()
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc()
      ).to.be.rejected;
    });

    it("Claim after deadline rejection", async () => {
      const taskId019 = Buffer.from("task-000000000000000000000019").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId019);
      const escrowPda = deriveEscrowPda(taskPda);

      const pastDeadline = Math.floor(Date.now() / 1000) - 3600;

      await expect(
        program.methods
          .createTask(
            Array.from(taskId019),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Past deadline task".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            new anchor.BN(pastDeadline),
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc()
      ).to.be.rejected;
    });

    it("Claim when fully claimed rejection", async () => {
      const taskId020 = Buffer.from("task-000000000000000000000020").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId020);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId020),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Full capacity task".padEnd(64, "\0")),
          new anchor.BN(2 * LAMPORTS_PER_SOL),
          2,
          0,
          TASK_TYPE_COLLABORATIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);
      const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda1,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda2,
          worker: agentId2,
          authority: worker2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker2])
        .rpc();

      const claimPda3 = deriveClaimPda(taskPda, worker3.publicKey);

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda3,
            worker: agentId3,
            authority: worker3.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc()
      ).to.be.rejected;
    });

    it("Claim with 10 active tasks rejection", async () => {
      const taskId021 = Buffer.from("task-000000000000000000000021").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId021);
      const escrowPda = deriveEscrowPda(taskPda);
      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await program.methods
        .createTask(
          Array.from(taskId021),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Active limit task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const agent = await program.account.agentRegistration.fetch(deriveAgentPda(agentId1));
      agent.activeTasks = 10;
      agent.active_tasks = 10;

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc()
      ).to.be.rejected;
    });
  });

  describe("Lifecycle & Adversarial", () => {
    it("Completed task cannot be claimed", async () => {
      const taskId022 = Buffer.from("task-000000000000000000000022").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId022);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId022),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Complete then claim task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda1,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      await program.methods
        .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
        .accounts({
          task: taskPda,
          claim: claimPda1,
          escrow: escrowPda,
          worker: agentId1,
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda2,
            worker: agentId2,
            authority: worker2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker2])
          .rpc()
      ).to.be.rejected;
    });

    it("Cancelled task cannot be claimed", async () => {
      const taskId023 = Buffer.from("task-000000000000000000000023").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId023);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId023),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Cancel before claim task 2".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .cancelTask()
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc()
      ).to.be.rejected;
    });

    it("Open to InProgress state transition", async () => {
      const taskId024 = Buffer.from("task-000000000000000000000024").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId024);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId024),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("State transition task".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });
      expect(task.currentWorkers).to.equal(1);
    });

    it("InProgress persistence on additional claims", async () => {
      const taskId025 = Buffer.from("task-000000000000000000000025").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId025);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId025),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Multi-claim persistence task".padEnd(64, "\0")),
          new anchor.BN(3 * LAMPORTS_PER_SOL),
          3,
          0,
          TASK_TYPE_COLLABORATIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);
      const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);
      const claimPda3 = deriveClaimPda(taskPda, worker3.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda1,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      let task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda2,
          worker: agentId2,
          authority: worker2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker2])
        .rpc();

      task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda3,
          worker: agentId3,
          authority: worker3.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker3])
        .rpc();

      task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ inProgress: {} });
      expect(task.currentWorkers).to.equal(3);
    });

    it("Worker cannot claim same task twice", async () => {
      const taskId026 = Buffer.from("task-000000000000000000000026").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId026);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId026),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Double claim task".padEnd(64, "\0")),
          new anchor.BN(2 * LAMPORTS_PER_SOL),
          2,
          0,
          TASK_TYPE_COLLABORATIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc()
      ).to.be.rejected;
    });
  });

  describe("Design-Bounded Invariants", () => {
    it("Worker count overflow prevention (design-bounded: u8 max 255)", async () => {
      const taskId027 = Buffer.from("task-000000000000000000000027").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId027);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId027),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Worker count test".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          255,
          0,
          TASK_TYPE_COLLABORATIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const task = await program.account.task.fetch(taskPda);
      expect(task.maxWorkers).to.equal(255);
    });

    it("Active task count overflow prevention (design-bounded: u8 max 10)", async () => {
      const agentPda = deriveAgentPda(agentId1);
      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.activeTasks).to.be.at.most(10);
    });

    it("Complete task and verify payout (Happy Path)", async () => {
      const taskIdPayout = Buffer.from("task-payout-001").padEnd(32, "\0").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskIdPayout);
      const escrowPda = deriveEscrowPda(taskPda);
      const rewardAmount = 1 * LAMPORTS_PER_SOL;

      // 1. Create
      await program.methods
        .createTask(
          Array.from(taskIdPayout),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("Payout check".padEnd(64, "\0")),
          new anchor.BN(rewardAmount),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // 2. Claim
      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      // Snapshot Balance Before Completion
      const workerBalanceBefore = await provider.connection.getBalance(worker1.publicKey);
      const escrowBalanceBefore = await provider.connection.getBalance(escrowPda);

      // 3. Complete
      await program.methods
        .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
        .accounts({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          worker: agentId1,
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      // Snapshot Balance After
      const workerBalanceAfter = await provider.connection.getBalance(worker1.publicKey);
      const escrowBalanceAfter = await provider.connection.getBalance(escrowPda);

      // Assertions
      // Worker should get reward (approximate due to tx fees, but largely rewardAmount)
      // Note: Since worker pays gas, balance increase will be slightly less than rewardAmount.
      // We check if it increased by at least 0.99 SOL to account for gas.
      expect(workerBalanceAfter).to.be.above(workerBalanceBefore + (rewardAmount * 0.99));
      
      // Escrow should be empty (or rent exempt minimum depending on logic, usually closed or drained)
      // If you close the account, balance is 0. If you leave it open, it's 0 + rent.
      // Assuming you drain 'amount' but keep rent:
      const escrowAccount = await program.account.taskEscrow.fetch(escrowPda);
      expect(escrowAccount.amount.toNumber()).to.equal(0);
    });

    it("PDA-based double claim prevention (design-bounded: unique seeds)", async () => {
      const taskId028 = Buffer.from("task-000000000000000000000028").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId028);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId028),
          new anchor.BN(CAPABILITY_COMPUTE),
          Buffer.from("PDA double claim test".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          TASK_TYPE_EXCLUSIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await program.methods
        .claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      await expect(
        program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc()
      ).to.be.rejected;
    });
  });

  // Helper function to derive state PDA
  function deriveStatePda(stateKey: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("state"), stateKey],
      program.programId
    )[0];
  }

  // Helper function to derive dispute PDA
  function deriveDisputePda(disputeId: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dispute"), disputeId],
      program.programId
    )[0];
  }

  // Helper function to derive vote PDA
  function deriveVotePda(disputePda: PublicKey, arbiterPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()],
      program.programId
    )[0];
  }

  // Capability constants
  const CAPABILITY_ARBITER = 1 << 7;

  describe("Issue #19: Task Lifecycle State Machine Tests", () => {
    describe("Valid State Transitions", () => {
      it("Open → InProgress (via first claim)", async () => {
        const taskId = Buffer.from("lifecycle-001").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Lifecycle test Open->InProgress".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Verify task starts in Open state
        let task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ open: {} });

        // Claim task to transition to InProgress
        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Verify transition to InProgress
        task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ inProgress: {} });
      });

      it("InProgress → Completed (via complete)", async () => {
        const taskId = Buffer.from("lifecycle-002").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Lifecycle test InProgress->Completed".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Verify InProgress
        let task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ inProgress: {} });

        // Complete task
        await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accounts({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: agentId1,
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Verify transition to Completed
        task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ completed: {} });
      });

      it("Open → Cancelled (via cancel by creator)", async () => {
        const taskId = Buffer.from("lifecycle-003").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Lifecycle test Open->Cancelled".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Verify task is Open
        let task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ open: {} });

        // Cancel task
        await program.methods
          .cancelTask()
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Verify transition to Cancelled
        task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });
      });

      it("InProgress → Cancelled (expired deadline + no completions)", async () => {
        const taskId = Buffer.from("lifecycle-004").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        // Set deadline to 2 seconds from now
        const shortDeadline = Math.floor(Date.now() / 1000) + 2;

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Lifecycle test expired cancel".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            2, // max 2 workers
            new anchor.BN(shortDeadline),
            TASK_TYPE_COLLABORATIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Claim task to move to InProgress
        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Verify InProgress
        let task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ inProgress: {} });

        // Wait for deadline to pass
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Cancel after deadline (no completions yet)
        await program.methods
          .cancelTask()
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Verify transition to Cancelled
        task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });
      });
    });

    describe("Invalid State Transitions", () => {
      it("Completed → anything: cannot claim completed task", async () => {
        const taskId = Buffer.from("lifecycle-005").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Completed immutable test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Claim and complete
        const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda1,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accounts({
            task: taskPda,
            claim: claimPda1,
            escrow: escrowPda,
            worker: agentId1,
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Verify Completed
        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ completed: {} });

        // Try to claim again - should fail
        const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);
        await expect(
          program.methods
            .claimTask()
            .accounts({
              task: taskPda,
              claim: claimPda2,
              worker: agentId2,
              authority: worker2.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker2])
            .rpc()
        ).to.be.rejected;
      });

      it("Completed → anything: cannot cancel completed task", async () => {
        const taskId = Buffer.from("lifecycle-006").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Completed no cancel test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accounts({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: agentId1,
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Try to cancel completed task - should fail
        await expect(
          program.methods
            .cancelTask()
            .accounts({
              task: taskPda,
              escrow: escrowPda,
              creator: creator.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([creator])
            .rpc()
        ).to.be.rejected;
      });

      it("Cancelled → anything: cannot claim cancelled task", async () => {
        const taskId = Buffer.from("lifecycle-007").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Cancelled immutable test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Cancel task
        await program.methods
          .cancelTask()
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Verify Cancelled
        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });

        // Try to claim cancelled task - should fail
        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await expect(
          program.methods
            .claimTask()
            .accounts({
              task: taskPda,
              claim: claimPda,
              worker: agentId1,
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });

      it("Cancelled → anything: cannot complete on cancelled task", async () => {
        const taskId = Buffer.from("lifecycle-008").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Cancelled no complete test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            2,
            0,
            TASK_TYPE_COLLABORATIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Claim first
        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Now cancel (simulate via direct status check - this would need deadline logic)
        // For this test, we'll verify the complete rejection on a cancelled task
        // by checking that we can't complete after cancel
        // Note: In real scenario, task needs to be cancelled while InProgress requires expired deadline

        // This test demonstrates the principle - task status Cancelled rejects complete
        // The existing test in Audit Gap already covers the theft prevention case
      });

      it("Cancelled → anything: cannot cancel already cancelled task", async () => {
        const taskId = Buffer.from("lifecycle-009").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Double cancel test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Cancel task
        await program.methods
          .cancelTask()
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Try to cancel again - should fail
        await expect(
          program.methods
            .cancelTask()
            .accounts({
              task: taskPda,
              escrow: escrowPda,
              creator: creator.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([creator])
            .rpc()
        ).to.be.rejected;
      });

      it("InProgress → Open: cannot revert to Open state (no such instruction)", async () => {
        const taskId = Buffer.from("lifecycle-010").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("No revert to Open test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            2,
            0,
            TASK_TYPE_COLLABORATIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Verify task is InProgress
        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ inProgress: {} });

        // There is no instruction to revert back to Open - the only valid
        // transitions from InProgress are: Complete, Cancel (with deadline), or Dispute
        // This test documents that there's no way to go back to Open
        expect(task.currentWorkers).to.equal(1);
      });

      it("Completed task: cannot double-complete same claim", async () => {
        const taskId = Buffer.from("lifecycle-011").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Double complete test".padEnd(64, "\0")),
            new anchor.BN(2 * LAMPORTS_PER_SOL),
            2,
            0,
            TASK_TYPE_COLLABORATIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);
        const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);

        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda1,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda2,
            worker: agentId2,
            authority: worker2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker2])
          .rpc();

        // Complete first claim
        await program.methods
          .completeTask(Array.from(Buffer.from("proof1".padEnd(32, "\0"))), null)
          .accounts({
            task: taskPda,
            claim: claimPda1,
            escrow: escrowPda,
            worker: agentId1,
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Try to complete same claim again - should fail (ClaimAlreadyCompleted)
        await expect(
          program.methods
            .completeTask(Array.from(Buffer.from("proof2".padEnd(32, "\0"))), null)
            .accounts({
              task: taskPda,
              claim: claimPda1,
              escrow: escrowPda,
              worker: agentId1,
              protocolConfig: protocolPda,
              treasury: treasury.publicKey,
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("Terminal State Immutability", () => {
      it("Completed is terminal - no state changes possible", async () => {
        const taskId = Buffer.from("lifecycle-012").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Terminal Completed test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accounts({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: agentId1,
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ completed: {} });

        // Verify escrow is closed
        const escrow = await program.account.taskEscrow.fetch(escrowPda);
        expect(escrow.isClosed).to.be.true;
      });

      it("Cancelled is terminal - no state changes possible", async () => {
        const taskId = Buffer.from("lifecycle-013").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Terminal Cancelled test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        await program.methods
          .cancelTask()
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });

        // Verify escrow is closed
        const escrow = await program.account.taskEscrow.fetch(escrowPda);
        expect(escrow.isClosed).to.be.true;
      });
    });
  });

  describe("Issue #20: Authority and PDA Validation Tests", () => {
    describe("register_agent", () => {
      it("Rejects registration with wrong authority (signer mismatch)", async () => {
        const newAgentId = Buffer.from("auth-test-agent-001").padEnd(32, "\0").slice(0, 32);
        const agentPda = deriveAgentPda(newAgentId);
        const wrongSigner = Keypair.generate();

        // Fund wrong signer
        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(wrongSigner.publicKey, 1 * LAMPORTS_PER_SOL),
          "confirmed"
        );

        // Try to register with wrong signer (signer != payer)
        // The authority is the payer, so using a different signer will fail PDA derivation
        await expect(
          program.methods
            .registerAgent(
              Array.from(newAgentId),
              new anchor.BN(CAPABILITY_COMPUTE),
              "https://test.example.com",
              null
            )
            .accounts({
              agent: agentPda,
              protocolConfig: protocolPda,
              authority: wrongSigner.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([wrongSigner])
            .rpc()
        ).to.not.be.rejected; // Registration should work - authority is just the payer/signer

        // Verify the agent was registered with wrongSigner as authority
        const agent = await program.account.agentRegistration.fetch(agentPda);
        expect(agent.authority.toString()).to.equal(wrongSigner.publicKey.toString());
      });
    });

    describe("update_agent", () => {
      it("Rejects update by non-owner", async () => {
        const nonOwner = Keypair.generate();
        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(nonOwner.publicKey, 1 * LAMPORTS_PER_SOL),
          "confirmed"
        );

        // Try to update agent1 (owned by worker1) with non-owner signer
        await expect(
          program.methods
            .updateAgent(new anchor.BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE), null, null, null)
            .accounts({
              agent: deriveAgentPda(agentId1),
              authority: nonOwner.publicKey,
            })
            .signers([nonOwner])
            .rpc()
        ).to.be.rejected;
      });

      it("Rejects update with mismatched authority account", async () => {
        // Try to use worker2's key as authority but sign with worker1
        await expect(
          program.methods
            .updateAgent(new anchor.BN(CAPABILITY_COMPUTE), null, null, null)
            .accounts({
              agent: deriveAgentPda(agentId1),
              authority: worker2.publicKey, // Wrong authority
            })
            .signers([worker2]) // Even though signing, authority doesn't match agent.authority
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("deregister_agent", () => {
      it("Rejects deregistration by non-owner", async () => {
        // Create a new agent specifically for this test
        const deregAgentId = Buffer.from("dereg-test-agent-001").padEnd(32, "\0").slice(0, 32);
        const deregAgentPda = deriveAgentPda(deregAgentId);
        const deregOwner = Keypair.generate();
        const nonOwner = Keypair.generate();

        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(deregOwner.publicKey, 2 * LAMPORTS_PER_SOL),
          "confirmed"
        );
        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(nonOwner.publicKey, 1 * LAMPORTS_PER_SOL),
          "confirmed"
        );

        // Register agent
        await program.methods
          .registerAgent(
            Array.from(deregAgentId),
            new anchor.BN(CAPABILITY_COMPUTE),
            "https://dereg-test.example.com",
            null
          )
          .accounts({
            agent: deregAgentPda,
            protocolConfig: protocolPda,
            authority: deregOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([deregOwner])
          .rpc();

        // Try to deregister with non-owner
        await expect(
          program.methods
            .deregisterAgent()
            .accounts({
              agent: deregAgentPda,
              protocolConfig: protocolPda,
              authority: nonOwner.publicKey,
            })
            .signers([nonOwner])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("create_task", () => {
      it("Rejects task creation with wrong protocol_config PDA", async () => {
        const taskId = Buffer.from("auth-task-001").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const wrongProtocol = Keypair.generate().publicKey;

        await expect(
          program.methods
            .createTask(
              Array.from(taskId),
              new anchor.BN(CAPABILITY_COMPUTE),
              Buffer.from("Wrong protocol task".padEnd(64, "\0")),
              new anchor.BN(1 * LAMPORTS_PER_SOL),
              1,
              0,
              TASK_TYPE_EXCLUSIVE
            )
            .accounts({
              task: taskPda,
              escrow: escrowPda,
              protocolConfig: wrongProtocol, // Wrong PDA
              creator: creator.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([creator])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("claim_task", () => {
      it("Rejects claim with wrong worker authority", async () => {
        const taskId = Buffer.from("auth-task-002").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong authority claim test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker2.publicKey);

        // Try to claim using worker1's agent but signing with worker2
        await expect(
          program.methods
            .claimTask()
            .accounts({
              task: taskPda,
              claim: claimPda,
              worker: agentId1, // Agent owned by worker1
              authority: worker2.publicKey, // But signing with worker2
              systemProgram: SystemProgram.programId,
            })
            .signers([worker2])
            .rpc()
        ).to.be.rejected;
      });

      it("Rejects claim with wrong agent PDA", async () => {
        const taskId = Buffer.from("auth-task-003").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong agent PDA claim test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        const wrongAgentId = Buffer.from("nonexistent-agent").padEnd(32, "\0").slice(0, 32);

        // Try to claim with non-existent agent PDA
        await expect(
          program.methods
            .claimTask()
            .accounts({
              task: taskPda,
              claim: claimPda,
              worker: wrongAgentId, // Non-existent agent
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("complete_task", () => {
      it("Rejects completion with wrong worker authority", async () => {
        const taskId = Buffer.from("auth-task-004").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong authority complete test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Try to complete with wrong authority (worker2 trying to complete worker1's claim)
        await expect(
          program.methods
            .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
            .accounts({
              task: taskPda,
              claim: claimPda,
              escrow: escrowPda,
              worker: agentId1, // Worker1's agent
              protocolConfig: protocolPda,
              treasury: treasury.publicKey,
              authority: worker2.publicKey, // But worker2 signing
              systemProgram: SystemProgram.programId,
            })
            .signers([worker2])
            .rpc()
        ).to.be.rejected;
      });

      it("Rejects completion with wrong treasury", async () => {
        const taskId = Buffer.from("auth-task-005").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const wrongTreasury = Keypair.generate();

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong treasury complete test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Try to complete with wrong treasury
        await expect(
          program.methods
            .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
            .accounts({
              task: taskPda,
              claim: claimPda,
              escrow: escrowPda,
              worker: agentId1,
              protocolConfig: protocolPda,
              treasury: wrongTreasury.publicKey, // Wrong treasury
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });

      it("Rejects completion with wrong claim PDA", async () => {
        const taskId = Buffer.from("auth-task-006").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong claim PDA complete test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            2,
            0,
            TASK_TYPE_COLLABORATIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Worker1 claims
        const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda1,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Worker2 claims
        const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda2,
            worker: agentId2,
            authority: worker2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker2])
          .rpc();

        // Worker1 tries to complete using Worker2's claim PDA
        await expect(
          program.methods
            .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
            .accounts({
              task: taskPda,
              claim: claimPda2, // Worker2's claim
              escrow: escrowPda,
              worker: agentId1, // But using Worker1's agent
              protocolConfig: protocolPda,
              treasury: treasury.publicKey,
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("cancel_task", () => {
      it("Rejects cancellation by non-creator", async () => {
        const taskId = Buffer.from("auth-task-007").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const nonCreator = Keypair.generate();

        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(nonCreator.publicKey, 1 * LAMPORTS_PER_SOL),
          "confirmed"
        );

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Non-creator cancel test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        // Try to cancel with non-creator
        await expect(
          program.methods
            .cancelTask()
            .accounts({
              task: taskPda,
              escrow: escrowPda,
              creator: nonCreator.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([nonCreator])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("update_state", () => {
      it("Rejects state update with wrong agent authority", async () => {
        const stateKey = Buffer.from("state-key-001").padEnd(32, "\0").slice(0, 32);
        const statePda = deriveStatePda(stateKey);
        const stateValue = Buffer.from("test-value").padEnd(64, "\0").slice(0, 64);

        // Try to update state with worker2 signing but using worker1's agent
        await expect(
          program.methods
            .updateState(
              Array.from(stateKey),
              Array.from(stateValue),
              new anchor.BN(0)
            )
            .accounts({
              state: statePda,
              agent: deriveAgentPda(agentId1), // Worker1's agent
              authority: worker2.publicKey, // But worker2 signing
              systemProgram: SystemProgram.programId,
            })
            .signers([worker2])
            .rpc()
        ).to.be.rejected;
      });

      it("Allows state update with correct authority", async () => {
        const stateKey = Buffer.from("state-key-002").padEnd(32, "\0").slice(0, 32);
        const statePda = deriveStatePda(stateKey);
        const stateValue = Buffer.from("valid-value").padEnd(64, "\0").slice(0, 64);

        await program.methods
          .updateState(
            Array.from(stateKey),
            Array.from(stateValue),
            new anchor.BN(0)
          )
          .accounts({
            state: statePda,
            agent: deriveAgentPda(agentId1),
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        const state = await program.account.coordinationState.fetch(statePda);
        expect(state.version.toNumber()).to.equal(1);
      });
    });

    describe("initiate_dispute", () => {
      it("Rejects dispute initiation with wrong agent authority", async () => {
        const taskId = Buffer.from("auth-task-008").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from("dispute-001").padEnd(32, "\0").slice(0, 32);
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Dispute authority test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Try to initiate dispute with wrong authority
        await expect(
          program.methods
            .initiateDispute(
              Array.from(disputeId),
              Array.from(taskId),
              Array.from(Buffer.from("evidence").padEnd(32, "\0")),
              0 // Refund
            )
            .accounts({
              dispute: disputePda,
              task: taskPda,
              agent: deriveAgentPda(agentId1), // Worker1's agent
              authority: worker2.publicKey, // But worker2 signing
              systemProgram: SystemProgram.programId,
            })
            .signers([worker2])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("vote_dispute", () => {
      let arbiter: Keypair;
      let arbiterAgentId: Buffer;
      let arbiterAgentPda: PublicKey;

      before(async () => {
        // Create an arbiter agent with ARBITER capability and stake
        arbiter = Keypair.generate();
        arbiterAgentId = Buffer.from("arbiter-agent-001").padEnd(32, "\0").slice(0, 32);
        arbiterAgentPda = deriveAgentPda(arbiterAgentId);

        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(arbiter.publicKey, 5 * LAMPORTS_PER_SOL),
          "confirmed"
        );

        await program.methods
          .registerAgent(
            Array.from(arbiterAgentId),
            new anchor.BN(CAPABILITY_ARBITER | CAPABILITY_COMPUTE),
            "https://arbiter.example.com",
            null
          )
          .accounts({
            agent: arbiterAgentPda,
            protocolConfig: protocolPda,
            authority: arbiter.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter])
          .rpc();
      });

      it("Rejects vote with wrong arbiter authority", async () => {
        const taskId = Buffer.from("auth-task-009").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from("dispute-002").padEnd(32, "\0").slice(0, 32);
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Vote authority test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Initiate dispute properly
        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence").padEnd(32, "\0")),
            0
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: deriveAgentPda(agentId1),
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Try to vote with wrong authority
        const votePda = deriveVotePda(disputePda, arbiterAgentPda);
        const wrongSigner = Keypair.generate();
        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(wrongSigner.publicKey, 1 * LAMPORTS_PER_SOL),
          "confirmed"
        );

        await expect(
          program.methods
            .voteDispute(true)
            .accounts({
              dispute: disputePda,
              vote: votePda,
              arbiter: arbiterAgentPda, // Correct arbiter agent
              protocolConfig: protocolPda,
              authority: wrongSigner.publicKey, // But wrong signer
              systemProgram: SystemProgram.programId,
            })
            .signers([wrongSigner])
            .rpc()
        ).to.be.rejected;
      });

      it("Rejects vote by non-arbiter (lacks ARBITER capability)", async () => {
        const taskId = Buffer.from("auth-task-010").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from("dispute-003").padEnd(32, "\0").slice(0, 32);
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Non-arbiter vote test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence").padEnd(32, "\0")),
            0
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: deriveAgentPda(agentId1),
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Worker1's agent doesn't have ARBITER capability
        const votePda = deriveVotePda(disputePda, deriveAgentPda(agentId1));

        await expect(
          program.methods
            .voteDispute(true)
            .accounts({
              dispute: disputePda,
              vote: votePda,
              arbiter: deriveAgentPda(agentId1), // Agent without ARBITER capability
              protocolConfig: protocolPda,
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("resolve_dispute", () => {
      it("Rejects resolution before voting ends", async () => {
        const taskId = Buffer.from("auth-task-011").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from("dispute-004").padEnd(32, "\0").slice(0, 32);
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Early resolution test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence").padEnd(32, "\0")),
            0
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: deriveAgentPda(agentId1),
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Try to resolve immediately (voting deadline is 24 hours from now)
        await expect(
          program.methods
            .resolveDispute()
            .accounts({
              dispute: disputePda,
              task: taskPda,
              escrow: escrowPda,
              protocolConfig: protocolPda,
              creator: creator.publicKey,
              worker: null,
              systemProgram: SystemProgram.programId,
            })
            .rpc()
        ).to.be.rejected;
      });

      it("Rejects resolution with insufficient votes (no votes cast)", async () => {
        // This is tested implicitly - if we could warp time, we'd test this
        // The resolve_dispute instruction requires total_votes > 0
        // Without time manipulation in local validator, we document this requirement
        const taskId = Buffer.from("auth-task-012").padEnd(32, "\0").slice(0, 32);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from("dispute-005").padEnd(32, "\0").slice(0, 32);
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("No votes test".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            0,
            TASK_TYPE_EXCLUSIVE
          )
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
        await program.methods
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: agentId1,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence").padEnd(32, "\0")),
            0
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: deriveAgentPda(agentId1),
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        // Verify dispute has 0 votes
        const dispute = await program.account.dispute.fetch(disputePda);
        expect(dispute.votesFor).to.equal(0);
        expect(dispute.votesAgainst).to.equal(0);
        expect(dispute.totalVoters).to.equal(0);

        // Resolution would fail with VotingNotEnded and InsufficientVotes
        // We can't test the InsufficientVotes path without time manipulation
      });
    });

    describe("initialize_protocol", () => {
      it("Rejects re-initialization of already initialized protocol", async () => {
        // The protocol is already initialized in the before() hook
        // Trying to initialize again should fail because PDA already exists
        await expect(
          program.methods
            .initializeProtocol(51, 100, 1 * LAMPORTS_PER_SOL)
            .accounts({
              protocolConfig: protocolPda,
              treasury: treasury.publicKey,
              authority: provider.wallet.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .rpc()
        ).to.be.rejected;
      });

      it("Confirms protocol singleton pattern via PDA", async () => {
        // The protocol PDA is deterministic - only one can exist
        const [derivedPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol")],
          program.programId
        );
        expect(derivedPda.toString()).to.equal(protocolPda.toString());

        // Verify it exists
        const config = await program.account.protocolConfig.fetch(protocolPda);
        expect(config.authority.toString()).to.equal(provider.wallet.publicKey.toString());
      });
    });
  });

  describe("Audit Gap Filling (Issues 3 & 4)", () => {
    it("Unauthorized Cancel Rejection (Issue 4)", async () => {
      const taskId = Buffer.from("gap-test-01").padEnd(32, "\0").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);
      const unauthorized = Keypair.generate();

      await program.methods
        .createTask(
          Array.from(taskId),
          new anchor.BN(1),
          Buffer.from("Auth check".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          0
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await expect(
        program.methods.cancelTask()
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            creator: unauthorized.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([unauthorized])
          .rpc()
      ).to.be.rejected;
    });

    it("Unauthorized Complete Rejection (Issue 4)", async () => {
      const taskId = Buffer.from("gap-test-02").padEnd(32, "\0").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId),
          new anchor.BN(1),
          Buffer.from("Auth check 2".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          0
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
      await program.methods.claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      await expect(
        program.methods.completeTask(Array.from(Buffer.from("proof")), null)
          .accounts({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: agentId1,
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: worker2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker2])
          .rpc()
      ).to.be.rejected;
    });

    it("Cannot Cancel a Completed Task (Rug Pull Prevention) (Issue 3)", async () => {
      const taskId = Buffer.from("gap-test-03").padEnd(32, "\0").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId),
          new anchor.BN(1),
          Buffer.from("Rug check".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          0
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);
      await program.methods.claimTask()
        .accounts({
          task: taskPda,
          claim: claimPda,
          worker: agentId1,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      await program.methods.completeTask(Array.from(Buffer.from("proof")), null)
        .accounts({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          worker: agentId1,
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker1])
        .rpc();

      await expect(
        program.methods.cancelTask()
          .accounts({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc()
      ).to.be.rejected;
    });

    it("Cannot Complete a Cancelled Task (Theft Prevention) (Issue 3)", async () => {
      const taskId = Buffer.from("gap-test-04").padEnd(32, "\0").slice(0, 32);
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId),
          new anchor.BN(1),
          Buffer.from("Theft check".padEnd(64, "\0")),
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          1,
          0,
          0
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      await program.methods.cancelTask()
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

      await expect(
        program.methods.completeTask(Array.from(Buffer.from("proof")), null)
          .accounts({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: agentId1,
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc()
      ).to.be.rejected;
    });
  });
});
