import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";

function id32(s: string): Buffer {
  const b = Buffer.alloc(32);
  Buffer.from(s, "utf8").copy(b);
  expect(b.length).to.equal(32);
  return b;
}

const expectAnchorError = async (promise: Promise<unknown>, message: string | string[]) => {
  try {
    await promise;
    const expected = Array.isArray(message) ? message.join(", ") : message;
    expect.fail(`Expected error: ${expected}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const logs = Array.isArray((err as { logs?: string[] } | null)?.logs)
      ? (err as { logs: string[] }).logs.join("\n")
      : "";
    const nestedMessage =
      typeof (err as { error?: { errorMessage?: string } } | null)?.error?.errorMessage === "string"
        ? (err as { error: { errorMessage: string } }).error.errorMessage
        : "";
    const combined = [errorMessage, nestedMessage, logs].filter(Boolean).join("\n");
    const expected = Array.isArray(message) ? message : [message];
    const matched = expected.some((substring) => combined.includes(substring));
    expect(matched, `Expected error to include one of: ${expected.join(", ")}`).to.be.true;
  }
};

describe("coordination-security", () => {
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
  let arbiter1: Keypair;
  let arbiter2: Keypair;
  let arbiter3: Keypair;
  let unauthorized: Keypair;

  const agentId1 = id32("agent-000000000000000000000001");
  const agentId2 = id32("agent-000000000000000000000002");
  const agentId3 = id32("agent-000000000000000000000003");
  const arbiterId1 = id32("arbit-000000000000000000000001");
  const arbiterId2 = id32("arbit-000000000000000000000002");
  const arbiterId3 = id32("arbit-000000000000000000000003");
  const taskId1 = id32("task-00000000000000000000000001");
  const taskId2 = id32("task-00000000000000000000000002");
  const taskId3 = id32("task-00000000000000000000000003");
  const disputeId1 = id32("disp-00000000000000000000000001");

  const CAPABILITY_COMPUTE = 1 << 0;
  const CAPABILITY_INFERENCE = 1 << 1;
  const CAPABILITY_STORAGE = 1 << 2;
  const CAPABILITY_ARBITER = 1 << 7;

  const TASK_TYPE_EXCLUSIVE = 0;
  const TASK_TYPE_COLLABORATIVE = 1;
  const TASK_TYPE_COMPETITIVE = 2;

  const RESOLUTION_TYPE_REFUND = 0;
  const RESOLUTION_TYPE_COMPLETE = 1;
  const RESOLUTION_TYPE_SPLIT = 2;

  before(async () => {
    treasury = Keypair.generate();
    creator = Keypair.generate();
    worker1 = Keypair.generate();
    worker2 = Keypair.generate();
    worker3 = Keypair.generate();
    arbiter1 = Keypair.generate();
    arbiter2 = Keypair.generate();
    arbiter3 = Keypair.generate();
    unauthorized = Keypair.generate();

    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    const wallets = [treasury, creator, worker1, worker2, worker3, arbiter1, arbiter2, arbiter3, unauthorized];

    for (const wallet of wallets) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount),
        "confirmed"
      );
    }
  });

  describe("Happy Paths", () => {
    describe("Protocol Initialization", () => {
      it("Successfully initializes protocol", async () => {
        const tx = await program.methods
          .initializeProtocol(51, 100, 1 * LAMPORTS_PER_SOL)
          .accounts({
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: provider.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        const protocol = await program.account.protocolConfig.fetch(protocolPda);
        expect(protocol.authority.toString()).to.equal(provider.wallet.publicKey.toString());
        expect(protocol.treasury.toString()).to.equal(treasury.publicKey.toString());
        expect(protocol.disputeThreshold).to.equal(51);
        expect(protocol.protocolFeeBps).to.equal(100);
        expect(protocol.minArbiterStake).to.equal(1 * LAMPORTS_PER_SOL);
        expect(protocol.totalAgents).to.equal(0);
        expect(protocol.totalTasks).to.equal(0);

        const events = await program.account.protocolConfig.fetch(protocolPda);
      });

      it("Emits ProtocolInitialized event", async () => {
        const listener = program.addEventListener("ProtocolInitialized", (event) => {
          expect(event.authority.toString()).to.equal(provider.wallet.publicKey.toString());
          expect(event.treasury.toString()).to.equal(treasury.publicKey.toString());
          expect(event.disputeThreshold).to.equal(51);
          expect(event.protocolFeeBps).to.equal(100);
        });

        await program.methods
          .initializeProtocol(51, 100, 1 * LAMPORTS_PER_SOL)
          .accounts({
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: provider.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        await new Promise((resolve) => setTimeout(resolve, 1000));
        program.removeEventListener(listener);
      });
    });

    describe("Agent Registration", () => {
      it("Successfully registers a new agent", async () => {
        const [agentPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        );

        const balanceBefore = await provider.connection.getBalance(worker1.publicKey);

        await program.methods
          .registerAgent(
            Array.from(agentId1),
            new anchor.BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE),
            "https://worker1.example.com",
            null
          )
          .accounts({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        const agent = await program.account.agentRegistration.fetch(agentPda);
        expect(agent.agentId).to.deep.equal(Array.from(agentId1));
        expect(agent.authority.toString()).to.equal(worker1.publicKey.toString());
        expect(agent.capabilities.toNumber()).to.equal(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE);
        expect(agent.status).to.equal(1);
        expect(agent.endpoint).to.equal("https://worker1.example.com");
        expect(agent.reputation).to.equal(5000);
        expect(agent.activeTasks).to.equal(0);
      });

      it("Emits AgentRegistered event", async () => {
        const [agentPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId2],
          program.programId
        );

        let eventEmitted = false;
        const listener = program.addEventListener("AgentRegistered", (event) => {
          expect(event.agentId).to.deep.equal(Array.from(agentId2));
          expect(event.authority.toString()).to.equal(worker2.publicKey.toString());
          eventEmitted = true;
        });

        await program.methods
          .registerAgent(
            Array.from(agentId2),
            new anchor.BN(CAPABILITY_COMPUTE),
            "https://worker2.example.com",
            null
          )
          .accounts({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: worker2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker2])
          .rpc();

        await new Promise((resolve) => setTimeout(resolve, 500));
        program.removeEventListener(listener);
        expect(eventEmitted).to.be.true;
      });
    });

    describe("Agent Update and Deregister", () => {
      it("Successfully updates agent capabilities and status", async () => {
        const [agentPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        );

        await program.methods
          .updateAgent(
            new anchor.BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE | CAPABILITY_ARBITER),
            "https://worker1-updated.example.com",
            null,
            { active: {} }
          )
          .accounts({
            agent: agentPda,
            authority: worker1.publicKey,
          })
          .signers([worker1])
          .rpc();

        const agent = await program.account.agentRegistration.fetch(agentPda);
        expect(agent.capabilities.toNumber()).to.equal(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE | CAPABILITY_ARBITER);
        expect(agent.endpoint).to.equal("https://worker1-updated.example.com");
      });

      it("Successfully deregisters agent with no active tasks", async () => {
        const [agentPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId2],
          program.programId
        );

        await program.methods
          .deregisterAgent()
          .accounts({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: worker2.publicKey,
          })
          .signers([worker2])
          .rpc();

        await expect(
          program.account.agentRegistration.fetch(agentPda)
        ).to.be.rejected;

        const protocol = await program.account.protocolConfig.fetch(protocolPda);
        expect(protocol.totalAgents.toNumber()).to.equal(1);
      });
    });

    describe("Task Creation - All Types", () => {
      it("Successfully creates exclusive task with reward", async () => {
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), taskId1],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        const rewardAmount = 2 * LAMPORTS_PER_SOL;
        const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

        await program.methods
          .createTask(
            Array.from(taskId1),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Process this data".padEnd(64, "\0")),
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

        const task = await program.account.task.fetch(taskPda);
        expect(task.taskId).to.deep.equal(Array.from(taskId1));
        expect(task.creator.toString()).to.equal(creator.publicKey.toString());
        expect(task.requiredCapabilities.toNumber()).to.equal(CAPABILITY_COMPUTE);
        expect(task.rewardAmount.toNumber()).to.equal(rewardAmount);
        expect(task.maxWorkers).to.equal(1);
        expect(task.currentWorkers).to.equal(0);
        expect(task.taskType).to.deep.equal({ exclusive: {} });
        expect(task.status).to.deep.equal({ open: {} });

        const escrow = await program.account.taskEscrow.fetch(escrowPda);
        expect(escrow.amount.toNumber()).to.equal(rewardAmount);
        expect(escrow.distributed.toNumber()).to.equal(0);
      });

      it("Successfully creates collaborative task", async () => {
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), taskId2],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(taskId2),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Collaborative task".padEnd(64, "\0")),
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

        const task = await program.account.task.fetch(taskPda);
        expect(task.maxWorkers).to.equal(3);
        expect(task.taskType).to.deep.equal({ collaborative: {} });
        expect(task.requiredCompletions).to.equal(3);
      });

      it("Successfully creates competitive task", async () => {
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), taskId3],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(taskId3),
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
        expect(task.maxWorkers).to.equal(5);
        expect(task.taskType).to.deep.equal({ competitive: {} });
      });
    });

    describe("Task Claim and Complete - Exclusive Task", () => {
      it("Successfully claims exclusive task", async () => {
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), taskId1],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

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
        expect(task.currentWorkers).to.equal(1);
        expect(task.status).to.deep.equal({ inProgress: {} });

        const claim = await program.account.taskClaim.fetch(claimPda);
        expect(claim.worker.toString()).to.equal(worker1.publicKey.toString());
        expect(claim.isCompleted).to.be.false;
      });

      it("Successfully completes exclusive task and receives reward", async () => {
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), taskId1],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        const proofHash = id32("proof-hash-00000000000001");
        const rewardAmount = 2 * LAMPORTS_PER_SOL;
        const expectedFee = Math.floor(rewardAmount * 100 / 10000);
        const expectedReward = rewardAmount - expectedFee;

        const workerBalanceBefore = await provider.connection.getBalance(worker1.publicKey);
        const treasuryBalanceBefore = await provider.connection.getBalance(treasury.publicKey);

        await program.methods
          .completeTask(Array.from(proofHash), null)
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
        expect(task.completions).to.equal(1);

        const claim = await program.account.taskClaim.fetch(claimPda);
        expect(claim.isCompleted).to.be.true;
        expect(claim.rewardPaid.toNumber()).to.equal(expectedReward);
        expect(claim.proofHash).to.deep.equal(Array.from(proofHash));

        const escrow = await program.account.taskEscrow.fetch(escrowPda);
        expect(escrow.isClosed).to.be.true;

        const workerBalanceAfter = await provider.connection.getBalance(worker1.publicKey);
        const treasuryBalanceAfter = await provider.connection.getBalance(treasury.publicKey);

        expect(workerBalanceAfter - workerBalanceBefore).to.be.at.least(expectedReward - 100000);
        expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);

        const agent = await program.account.agentRegistration.fetch(
          PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId1], program.programId)[0]
        );
        expect(agent.tasksCompleted.toNumber()).to.equal(1);
        expect(agent.totalEarned.toNumber()).to.equal(expectedReward);
        expect(agent.reputation).to.equal(5100);
        expect(agent.activeTasks).to.equal(0);
      });
    });

    describe("Task Cancel - Unclaimed", () => {
      it("Successfully cancels unclaimed task", async () => {
        const newTaskId = id32("task-cancel00000000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        const rewardAmount = 1 * LAMPORTS_PER_SOL;
        const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Cancelable task".padEnd(64, "\0")),
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

        const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
        expect(creatorBalanceAfter - creatorBalanceBefore).to.be.at.least(rewardAmount - 200000);
      });
    });

    describe("Dispute Flow - Full Cycle", () => {
      let taskPda: PublicKey;
      let escrowPda: PublicKey;
      let disputePda: PublicKey;
      let workerPda: PublicKey;

      before(async () => {
        workerPda = PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId3], program.programId)[0];

        const disputeTaskId = id32("task-dispute0000000000001");
        taskPda = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), disputeTaskId],
          program.programId
        )[0];
        escrowPda = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        )[0];
        disputePda = PublicKey.findProgramAddressSync(
          [Buffer.from("dispute"), disputeId1],
          program.programId
        )[0];

        await program.methods
          .registerAgent(
            Array.from(agentId3),
            new anchor.BN(CAPABILITY_COMPUTE),
            "https://worker3.example.com",
            null
          )
          .accounts({
            agent: workerPda,
            protocolConfig: protocolPda,
            authority: worker3.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        await program.methods
          .createTask(
            Array.from(disputeTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Dispute task".padEnd(64, "\0")),
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
      });

      it("Successfully initiates dispute", async () => {
        const evidenceHash = id32("evidence-hash000000000001");

        await program.methods
          .initiateDispute(
            Array.from(disputeId1),
            Array.from(id32("task-dispute0000000000001")),
            Array.from(evidenceHash),
            RESOLUTION_TYPE_REFUND
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: workerPda,
            authority: worker3.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        const dispute = await program.account.dispute.fetch(disputePda);
        expect(dispute.task.toString()).to.equal(taskPda.toString());
        expect(dispute.initiator.toString()).to.equal(workerPda.toString());
        expect(dispute.status).to.deep.equal({ active: {} });
        expect(dispute.resolutionType).to.deep.equal({ refund: {} });

        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ disputed: {} });
      });

      it("Multiple arbiters vote on dispute", async () => {
        for (let i = 0; i < 3; i++) {
          const arbiterKey = [arbiter1, arbiter2, arbiter3][i];
          const arbiterId = [arbiterId1, arbiterId2, arbiterId3][i];
          const approve = i < 2;

          const [arbiterPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("agent"), arbiterId],
            program.programId
          );
          const [votePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()],
            program.programId
          );

          await program.methods
            .registerAgent(
              Array.from(arbiterId),
              new anchor.BN(CAPABILITY_ARBITER),
              `https://arbiter${i + 1}.example.com`,
              null
            )
            .accounts({
              agent: arbiterPda,
              protocolConfig: protocolPda,
              authority: arbiterKey.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([arbiterKey])
            .rpc();

          await program.methods
            .voteDispute(approve)
            .accounts({
              dispute: disputePda,
              vote: votePda,
              arbiter: arbiterPda,
              protocolConfig: protocolPda,
              authority: arbiterKey.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([arbiterKey])
            .rpc();
        }

        const dispute = await program.account.dispute.fetch(disputePda);
        expect(dispute.votesFor).to.equal(2);
        expect(dispute.votesAgainst).to.equal(1);
        expect(dispute.totalVoters).to.equal(3);
      });

      it("Successfully resolves dispute with refund outcome", async () => {
        const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

        await program.methods
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
          .rpc();

        const dispute = await program.account.dispute.fetch(disputePda);
        expect(dispute.status).to.deep.equal({ resolved: {} });

        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });

        const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
        expect(creatorBalanceAfter - creatorBalanceBefore).to.be.at.least(1 * LAMPORTS_PER_SOL - 200000);
      });
    });
  });

  describe("Security and Edge Cases", () => {
    describe("Unauthorized Access", () => {
      it("Fails when non-authority tries to update agent", async () => {
        const [agentPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        );

        await expect(
          program.methods
            .updateAgent(new anchor.BN(CAPABILITY_COMPUTE), "https://malicious.com", null, { active: {} })
            .accounts({
              agent: agentPda,
              authority: unauthorized.publicKey,
            })
            .signers([unauthorized])
            .rpc()
        ).to.be.rejected;
      });

      it("Fails when non-creator tries to cancel task", async () => {
        const newTaskId = id32("task-unauth0000000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Test task".padEnd(64, "\0")),
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

        await expect(
          program.methods
            .cancelTask()
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
    });

    describe("Spoofing Simulations", () => {
      it("Rejects arbiter vote signed by non-authority (fake capability claim)", async () => {
        const spoofTaskId = id32("task-spoofcap0000000001");
        const spoofDisputeId = id32("disp-spoofcap0000000001");
        const spoofArbiterId = id32("arbit-spoofcap0000001");

        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), spoofTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );
        const [disputePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("dispute"), spoofDisputeId],
          program.programId
        );
        const [arbiterPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), spoofArbiterId],
          program.programId
        );
        const [votePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()],
          program.programId
        );

        await program.methods
          .registerAgent(
            Array.from(spoofArbiterId),
            new anchor.BN(CAPABILITY_ARBITER),
            "https://arbiter-spoof.example.com",
            null
          )
          .accounts({
            agent: arbiterPda,
            protocolConfig: protocolPda,
            authority: arbiter1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter1])
          .rpc();

        await program.methods
          .createTask(
            Array.from(spoofTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Spoofing capability vote".padEnd(64, "\0")),
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
            Array.from(spoofDisputeId),
            Array.from(spoofTaskId),
            Array.from(id32("spoof-evidence-1")),
            RESOLUTION_TYPE_REFUND
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId1], program.programId)[0],
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await expect(
          program.methods
            .voteDispute(true)
            .accounts({
              dispute: disputePda,
              vote: votePda,
              arbiter: arbiterPda,
              protocolConfig: protocolPda,
              authority: unauthorized.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([unauthorized])
            .rpc()
        ).to.be.rejected;
      });

      it("Rejects replayed dispute initiation with the same PDA", async () => {
        const replayTaskId = id32("task-replaydisp0000001");
        const replayDisputeId = id32("disp-replay0000000001");

        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), replayTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );
        const [disputePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("dispute"), replayDisputeId],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(replayTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Replay dispute init".padEnd(64, "\0")),
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
            Array.from(replayDisputeId),
            Array.from(replayTaskId),
            Array.from(id32("replay-evidence")),
            RESOLUTION_TYPE_REFUND
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId1], program.programId)[0],
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await expect(
          program.methods
            .initiateDispute(
              Array.from(replayDisputeId),
              Array.from(replayTaskId),
              Array.from(id32("replay-evidence")),
              RESOLUTION_TYPE_REFUND
            )
            .accounts({
              dispute: disputePda,
              task: taskPda,
              agent: PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId1], program.programId)[0],
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });

      it("Rejects unauthorized task completion attempts (authority spoof)", async () => {
        const spoofTaskId = id32("task-spoofcomp0000001");

        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), spoofTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );
        const workerPda = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        )[0];

        await program.methods
          .createTask(
            Array.from(spoofTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Spoof complete task".padEnd(64, "\0")),
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

        const proofHash = id32("spoof-complete-proof");

        await expect(
          program.methods
            .completeTask(Array.from(proofHash), null)
            .accounts({
              task: taskPda,
              claim: claimPda,
              escrow: escrowPda,
              worker: workerPda,
              protocolConfig: protocolPda,
              treasury: treasury.publicKey,
              authority: unauthorized.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([unauthorized])
            .rpc()
        ).to.be.rejected;
      });

      it("Caps reputation at 10000 after repeated completions", async () => {
        const workerPda = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        )[0];
        const starting = await program.account.agentRegistration.fetch(workerPda);
        const startingReputation = starting.reputation;
        const completionsNeeded = Math.ceil((10000 - startingReputation + 100) / 100);

        for (let i = 0; i < completionsNeeded; i += 1) {
          const repTaskId = id32(`task-repcap-${i}`);
          const [taskPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("task"), creator.publicKey.toBuffer(), repTaskId],
            program.programId
          );
          const [escrowPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("escrow"), taskPda.toBuffer()],
            program.programId
          );
          const [claimPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
            program.programId
          );

          await program.methods
            .createTask(
              Array.from(repTaskId),
              new anchor.BN(CAPABILITY_COMPUTE),
              Buffer.from(`Reputation cap ${i}`.padEnd(64, "\0")),
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

          const proofHash = id32(`rep-proof-${i}`);

          await program.methods
            .completeTask(Array.from(proofHash), null)
            .accounts({
              task: taskPda,
              claim: claimPda,
              escrow: escrowPda,
              worker: workerPda,
              protocolConfig: protocolPda,
              treasury: treasury.publicKey,
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc();
        }

        const updated = await program.account.agentRegistration.fetch(workerPda);
        expect(updated.reputation).to.equal(10000);
      });
    });

    describe("Deadline and Stale State Guards", () => {
      it("Rejects creator cancel on in-progress task before deadline", async () => {
        const griefTaskId = id32("task-deadgrief0000001");

        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), griefTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

        const futureDeadline = Math.floor(Date.now() / 1000) + 120;

        await program.methods
          .createTask(
            Array.from(griefTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Deadline griefing guard".padEnd(64, "\0")),
            new anchor.BN(0),
            1,
            new anchor.BN(futureDeadline),
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

      it("Rejects dispute initiation on a cancelled task (stale proposal)", async () => {
        const staleTaskId = id32("task-staledisp0000001");
        const staleDisputeId = id32("disp-stale00000000001");

        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), staleTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [disputePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("dispute"), staleDisputeId],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(staleTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Stale dispute target".padEnd(64, "\0")),
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

        await expect(
          program.methods
            .initiateDispute(
              Array.from(staleDisputeId),
              Array.from(staleTaskId),
              Array.from(id32("stale-evidence")),
              RESOLUTION_TYPE_REFUND
            )
            .accounts({
              dispute: disputePda,
              task: taskPda,
              agent: PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId1], program.programId)[0],
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });

      it("Rejects dispute resolution before voting deadline", async () => {
        const timeoutTaskId = id32("task-timeout000000001");
        const timeoutDisputeId = id32("disp-timeout00000001");

        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), timeoutTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );
        const [disputePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("dispute"), timeoutDisputeId],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(timeoutTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Timeout edge case".padEnd(64, "\0")),
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
            Array.from(timeoutDisputeId),
            Array.from(timeoutTaskId),
            Array.from(id32("timeout-evidence")),
            RESOLUTION_TYPE_REFUND
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId1], program.programId)[0],
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

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
    });

    describe("Double Claims and Completions", () => {
      it("Fails when worker tries to claim same task twice", async () => {
        const newTaskId = id32("task-double0000000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Double claim test".padEnd(64, "\0")),
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

      it("Fails when worker tries to complete task twice", async () => {
        const newTaskId = id32("task-doublecomp000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Double complete test".padEnd(64, "\0")),
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

        const proofHash = id32("proof-hash-00000000000002");

        await program.methods
          .completeTask(Array.from(proofHash), null)
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
          program.methods
            .completeTask(Array.from(proofHash), null)
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

    describe("Capability and Status Validation", () => {
      it("Fails when worker lacks required capabilities", async () => {
        const newTaskId = id32("task-capcheck0000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_STORAGE),
            Buffer.from("Capability test".padEnd(64, "\0")),
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

      it("Fails when inactive agent tries to claim task", async () => {
        const [agentPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        );

        await program.methods
          .updateAgent(null, null, null, { inactive: {} })
          .accounts({
            agent: agentPda,
            authority: worker1.publicKey,
          })
          .signers([worker1])
          .rpc();

        const newTaskId = id32("task-inactive00000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Inactive agent test".padEnd(64, "\0")),
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
            agent: agentPda,
            authority: worker1.publicKey,
          })
          .signers([worker1])
          .rpc();
      });
    });

    describe("Deadline Expiry", () => {
      it("Fails to claim task after deadline", async () => {
        const newTaskId = id32("task-expired000000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        const pastDeadline = Math.floor(Date.now() / 1000) - 3600;

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Expired task".padEnd(64, "\0")),
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
          .rpc();

        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

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

      it("Successfully cancels expired task with no completions", async () => {
        const newTaskId = id32("task-cancalexp0000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        const nearFutureDeadline = Math.floor(Date.now() / 1000) + 2;

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Soon expired".padEnd(64, "\0")),
            new anchor.BN(1 * LAMPORTS_PER_SOL),
            1,
            new anchor.BN(nearFutureDeadline),
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

        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

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

        await new Promise((resolve) => setTimeout(resolve, 3000));

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
      });
    });

    describe("Dispute Threshold Tests", () => {
      it("Successfully resolves with exact threshold match", async () => {
        const newDisputeId = id32("disp-thres00000000000001");
        const newTaskId = id32("task-thres000000000000001");
        const [disputePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("dispute"), newDisputeId],
          program.programId
        );
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Threshold test".padEnd(64, "\0")),
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
          .initiateDispute(
            Array.from(newDisputeId),
            Array.from(newTaskId),
            Array.from(id32("evidence")),
            RESOLUTION_TYPE_REFUND
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: workerPda,
            authority: worker3.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        const arbiterPda1 = PublicKey.findProgramAddressSync([Buffer.from("agent"), arbiterId1], program.programId)[0];
        const arbiterPda2 = PublicKey.findProgramAddressSync([Buffer.from("agent"), arbiterId2], program.programId)[0];

        const [votePda1] = PublicKey.findProgramAddressSync(
          [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda1.toBuffer()],
          program.programId
        );
        const [votePda2] = PublicKey.findProgramAddressSync(
          [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda2.toBuffer()],
          program.programId
        );

        await program.methods
          .voteDispute(true)
          .accounts({
            dispute: disputePda,
            vote: votePda1,
            arbiter: arbiterPda1,
            protocolConfig: protocolPda,
            authority: arbiter1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter1])
          .rpc();

        await program.methods
          .voteDispute(true)
          .accounts({
            dispute: disputePda,
            vote: votePda2,
            arbiter: arbiterPda2,
            protocolConfig: protocolPda,
            authority: arbiter2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter2])
          .rpc();

        await new Promise((resolve) => setTimeout(resolve, 86401000));

        await program.methods
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
          .rpc();

        const dispute = await program.account.dispute.fetch(disputePda);
        expect(dispute.status).to.deep.equal({ resolved: {} });
      });
    });

    describe("Max Workers Boundary", () => {
      it("Fails when task exceeds max workers", async () => {
        const newTaskId = id32("task-maxwork000000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Max workers test".padEnd(64, "\0")),
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

        const [claimPda1] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );
        const [claimPda2] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker3.publicKey.toBuffer()],
          program.programId
        );

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
            worker: agentId3,
            authority: worker3.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.equal(2);

        const extraWorker = Keypair.generate();
        const extraAgentId = id32("agent-extra00000000000001");
        const [extraAgentPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), extraAgentId],
          program.programId
        );
        const [claimPda3] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), extraWorker.publicKey.toBuffer()],
          program.programId
        );

        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(extraWorker.publicKey, 2 * LAMPORTS_PER_SOL),
          "confirmed"
        );

        await program.methods
          .registerAgent(
            Array.from(extraAgentId),
            new anchor.BN(CAPABILITY_COMPUTE),
            "https://extra.com",
            null
          )
          .accounts({
            agent: extraAgentPda,
            protocolConfig: protocolPda,
            authority: extraWorker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([extraWorker])
          .rpc();

        await expect(
          program.methods
            .claimTask()
            .accounts({
              task: taskPda,
              claim: claimPda3,
              worker: extraAgentId,
              authority: extraWorker.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([extraWorker])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("Zero Reward Tasks", () => {
      it("Successfully creates and completes zero-reward task", async () => {
        const newTaskId = id32("task-zerorew000000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
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

        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

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

        const proofHash = id32("proof-hash-00000000000003");

        await program.methods
          .completeTask(Array.from(proofHash), null)
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

        const completedTask = await program.account.task.fetch(taskPda);
        expect(completedTask.status).to.deep.equal({ completed: {} });

        const claim = await program.account.taskClaim.fetch(claimPda);
        expect(claim.rewardPaid.toNumber()).to.equal(0);
      });
    });

    describe("Deregister with Active Tasks", () => {
      it("Fails to deregister agent with active tasks", async () => {
        const newTaskId = id32("task-deregfail000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Deregister test".padEnd(64, "\0")),
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

        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

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

        const [agentPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        );

        await expect(
          program.methods
            .deregisterAgent()
            .accounts({
              agent: agentPda,
              protocolConfig: protocolPda,
              authority: worker1.publicKey,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("Arbiter Voting Requirements", () => {
      it("Fails when non-arbiter tries to vote", async () => {
        const newDisputeId = id32("disp-nonarb000000000001");
        const newTaskId = id32("task-nonarb000000000001");
        const [disputePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("dispute"), newDisputeId],
          program.programId
        );
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Non-arbiter test".padEnd(64, "\0")),
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
          .initiateDispute(
            Array.from(newDisputeId),
            Array.from(newTaskId),
            Array.from(id32("evidence")),
            RESOLUTION_TYPE_REFUND
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: workerPda,
            authority: worker3.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        const [votePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vote"), disputePda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

        await expect(
          program.methods
            .voteDispute(true)
            .accounts({
              dispute: disputePda,
              vote: votePda,
              arbiter: agentId1,
              protocolConfig: protocolPda,
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("Protocol Configuration Validation", () => {
      it("Fails to initialize with invalid fee (over 1000 bps)", async () => {
        const newProtocolPda = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol2")],
          program.programId
        )[0];

        await expect(
          program.methods
            .initializeProtocol(51, 1001, 1 * LAMPORTS_PER_SOL)
            .accounts({
              protocolConfig: newProtocolPda,
              treasury: treasury.publicKey,
              authority: provider.wallet.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .rpc()
        ).to.be.rejected;
      });

      it("Fails to initialize with invalid dispute threshold (0)", async () => {
        const newProtocolPda = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol3")],
          program.programId
        )[0];

        await expect(
          program.methods
            .initializeProtocol(0, 100, 1 * LAMPORTS_PER_SOL)
            .accounts({
              protocolConfig: newProtocolPda,
              treasury: treasury.publicKey,
              authority: provider.wallet.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .rpc()
        ).to.be.rejected;
      });

      it("Fails to initialize with invalid dispute threshold (> 100)", async () => {
        const newProtocolPda = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol4")],
          program.programId
        )[0];

        await expect(
          program.methods
            .initializeProtocol(101, 100, 1 * LAMPORTS_PER_SOL)
            .accounts({
              protocolConfig: newProtocolPda,
              treasury: treasury.publicKey,
              authority: provider.wallet.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .rpc()
        ).to.be.rejected;
      });
    });

    describe("Fund Leak Prevention", () => {
      it("Verifies no lamport leaks in task lifecycle", async () => {
        const newTaskId = id32("task-fundleak0000000001");
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );

        const initialBalance = await provider.connection.getBalance(creator.publicKey);
        const rewardAmount = 2 * LAMPORTS_PER_SOL;

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Fund leak test".padEnd(64, "\0")),
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

        const afterCreateBalance = await provider.connection.getBalance(creator.publicKey);
        const escrowBalance = await provider.connection.getBalance(escrowPda);

        expect(initialBalance - afterCreateBalance).to.be.at.most(rewardAmount + 100000);
        expect(escrowBalance).to.equal(rewardAmount);

        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), worker1.publicKey.toBuffer()],
          program.programId
        );

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

        const proofHash = id32("proof-hash-00000000000004");

        await program.methods
          .completeTask(Array.from(proofHash), null)
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

        const finalEscrowBalance = await provider.connection.getBalance(escrowPda);
        expect(finalEscrowBalance).to.equal(0);
      });
    });

    describe("Issue 43 Gap Coverage", () => {
      it("Fails update_state with stale version", async () => {
        const stateKey = Buffer.from("state-ver-mismatch".padEnd(32, "\0"));
        const stateValue1 = Buffer.from("state-value-1".padEnd(64, "\0"));
        const stateValue2 = Buffer.from("state-value-2".padEnd(64, "\0"));
        const [statePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("state"), stateKey],
          program.programId
        );
        const [agentPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        );

        await program.methods
          .updateState(Array.from(stateKey), Array.from(stateValue1), new anchor.BN(0))
          .accounts({
            state: statePda,
            agent: agentPda,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await expectAnchorError(
          program.methods
            .updateState(Array.from(stateKey), Array.from(stateValue2), new anchor.BN(0))
            .accounts({
              state: statePda,
              agent: agentPda,
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc(),
          "State version mismatch (concurrent modification)"
        );
      });

      it("Fails to resolve dispute before voting deadline", async () => {
        const newTaskId = Buffer.from("task-earlyresolve0000001".padEnd(32, "\0"));
        const newDisputeId = Buffer.from("disp-earlyresolve000001".padEnd(32, "\0"));
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [workerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()],
          program.programId
        );
        const [disputePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("dispute"), newDisputeId],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Early resolve test".padEnd(64, "\0")),
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
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: workerPda,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .initiateDispute(
            Array.from(newDisputeId),
            Array.from(newTaskId),
            Array.from(Buffer.from("evidence-earlyresolve".padEnd(32, "\0"))),
            RESOLUTION_TYPE_REFUND
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: workerPda,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await expectAnchorError(
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
            .rpc(),
          "Voting period has not ended"
        );
      });

      it("Fails when the same arbiter votes twice", async () => {
        const newTaskId = Buffer.from("task-doublevote00000001".padEnd(32, "\0"));
        const newDisputeId = Buffer.from("disp-doublevote0000001".padEnd(32, "\0"));
        const arbiterId = Buffer.from("arbiter-doublevote000001".padEnd(32, "\0"));
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [workerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()],
          program.programId
        );
        const [disputePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("dispute"), newDisputeId],
          program.programId
        );
        const [arbiterPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), arbiterId],
          program.programId
        );
        const [votePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Double vote test".padEnd(64, "\0")),
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
            Array.from(newDisputeId),
            Array.from(newTaskId),
            Array.from(Buffer.from("evidence-doublevote".padEnd(32, "\0"))),
            RESOLUTION_TYPE_REFUND
          )
          .accounts({
            dispute: disputePda,
            task: taskPda,
            agent: workerPda,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .registerAgent(
            Array.from(arbiterId),
            new anchor.BN(CAPABILITY_ARBITER),
            "https://arbiter-doublevote.example.com",
            null
          )
          .accounts({
            agent: arbiterPda,
            protocolConfig: protocolPda,
            authority: arbiter1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter1])
          .rpc();

        await program.methods
          .voteDispute(true)
          .accounts({
            dispute: disputePda,
            vote: votePda,
            arbiter: arbiterPda,
            protocolConfig: protocolPda,
            authority: arbiter1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter1])
          .rpc();

        await expectAnchorError(
          program.methods
            .voteDispute(true)
            .accounts({
              dispute: disputePda,
              vote: votePda,
              arbiter: arbiterPda,
              protocolConfig: protocolPda,
              authority: arbiter1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([arbiter1])
            .rpc(),
          ["already in use", "already initialized", "Account already in use", "Allocate: account"]
        );
      });

      it("Fails to complete task with treasury mismatch", async () => {
        const newTaskId = Buffer.from("task-treasurymismatch".padEnd(32, "\0"));
        const [taskPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), newTaskId],
          program.programId
        );
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), taskPda.toBuffer()],
          program.programId
        );
        const [workerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("agent"), agentId1],
          program.programId
        );
        const [claimPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()],
          program.programId
        );
        const proofHash = Buffer.from("proof-treasurymismatch".padEnd(32, "\0"));

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new anchor.BN(CAPABILITY_COMPUTE),
            Buffer.from("Treasury mismatch test".padEnd(64, "\0")),
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
          .claimTask()
          .accounts({
            task: taskPda,
            claim: claimPda,
            worker: workerPda,
            authority: worker1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await expectAnchorError(
          program.methods
            .completeTask(Array.from(proofHash), null)
            .accounts({
              task: taskPda,
              claim: claimPda,
              escrow: escrowPda,
              worker: workerPda,
              protocolConfig: protocolPda,
              treasury: unauthorized.publicKey,
              authority: worker1.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc(),
          "Invalid input parameter"
        );
      });
    });
  });
});
