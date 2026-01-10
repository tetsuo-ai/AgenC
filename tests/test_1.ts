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
});
