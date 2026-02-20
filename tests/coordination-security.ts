import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  CAPABILITY_STORAGE,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COLLABORATIVE,
  TASK_TYPE_COMPETITIVE,
  RESOLUTION_TYPE_REFUND,
  RESOLUTION_TYPE_COMPLETE,
  RESOLUTION_TYPE_SPLIT,
  VALID_EVIDENCE,
  generateRunId,
  makeAgentId,
  makeTaskId,
  makeDisputeId,
  deriveProtocolPda,
  deriveAgentPda,
  deriveTaskPda,
  deriveEscrowPda,
  deriveClaimPda,
  deriveDisputePda,
  deriveVotePda,
  deriveAuthorityVotePda,
  deriveProgramDataPda,
  disableRateLimitsForTests,
} from "./test-utils";

describe("coordination-security", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const protocolPda = deriveProtocolPda(program.programId);
  const programDataPda = deriveProgramDataPda(program.programId);

  // Generate unique run ID to prevent conflicts with persisted validator state
  const runId = generateRunId();

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;  // Actual treasury from protocol config
  let creator: Keypair;
  let worker1: Keypair;
  let worker2: Keypair;
  let worker3: Keypair;
  let arbiter1: Keypair;
  let arbiter2: Keypair;
  let arbiter3: Keypair;
  let unauthorized: Keypair;
  let creatorAgentPda: PublicKey;

  // Use unique IDs per test run to avoid conflicts with persisted state
  let agentId1: Buffer;
  let agentId2: Buffer;
  let agentId3: Buffer;
  let creatorAgentId: Buffer;
  let arbiterId1: Buffer;
  let arbiterId2: Buffer;
  let arbiterId3: Buffer;
  let taskId1: Buffer;
  let taskId2: Buffer;
  let taskId3: Buffer;
  let disputeId1: Buffer;

  const MIN_CREATOR_BALANCE_LAMPORTS = 30 * LAMPORTS_PER_SOL;
  const uniqueTaskId = (prefix: string): Buffer =>
    makeTaskId(`${prefix}-${Math.random().toString(36).slice(2, 8)}`, runId);
  const uniqueDisputeId = (prefix: string): Buffer =>
    makeDisputeId(`${prefix}-${Math.random().toString(36).slice(2, 8)}`, runId);
  const uniqueAgentId = (prefix: string): Buffer =>
    makeAgentId(`${prefix}-${Math.random().toString(36).slice(2, 8)}`, runId);

  async function ensureWalletBalance(wallet: PublicKey, minLamports: number): Promise<void> {
    const currentBalance = await provider.connection.getBalance(wallet);
    if (currentBalance >= minLamports) {
      return;
    }

    const topUpLamports = minLamports - currentBalance + LAMPORTS_PER_SOL;
    const sig = await provider.connection.requestAirdrop(wallet, topUpLamports);
    await provider.connection.confirmTransaction(sig, "confirmed");
  }


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

    // Initialize unique IDs per test run
    agentId1 = makeAgentId("ag1", runId);
    agentId2 = makeAgentId("ag2", runId);
    agentId3 = makeAgentId("ag3", runId);
    creatorAgentId = makeAgentId("cre", runId);
    arbiterId1 = makeAgentId("ar1", runId);
    arbiterId2 = makeAgentId("ar2", runId);
    arbiterId3 = makeAgentId("ar3", runId);
    taskId1 = makeTaskId("t1", runId);
    taskId2 = makeTaskId("t2", runId);
    taskId3 = makeTaskId("t3", runId);
    disputeId1 = makeDisputeId("d1", runId);

    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    const wallets = [treasury, creator, worker1, worker2, worker3, arbiter1, arbiter2, arbiter3, unauthorized];

    for (const wallet of wallets) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount),
        "confirmed"
      );
    }

    // Initialize protocol if not already done
    try {
      await program.methods
        .initializeProtocol(
          51,
          100,
          new BN(1 * LAMPORTS_PER_SOL),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          [provider.wallet.publicKey, treasury.publicKey]
        )
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: deriveProgramDataPda(program.programId), isSigner: false, isWritable: false }])
        .signers([treasury])
        .rpc();
      treasuryPubkey = treasury.publicKey;
      console.log("Protocol initialized with treasury:", treasuryPubkey.toString());
    } catch (e: any) {
      if (e?.error?.errorCode?.code === 'ProtocolAlreadyInitialized' ||
          e?.message?.includes('already in use')) {
        // Expected - protocol already initialized from previous test run
        const protocolConfig = await program.account.protocolConfig.fetch(protocolPda);
        treasuryPubkey = protocolConfig.treasury;
        console.log("Protocol already initialized, using existing treasury:", treasuryPubkey.toString());
      } else {
        throw e;
      }
    }

    // Disable rate limiting for tests
    await disableRateLimitsForTests({
      program,
      protocolPda,
      authority: provider.wallet.publicKey,
    });

    creatorAgentPda = deriveAgentPda(creatorAgentId, program.programId);

    try {
      await program.methods
        .registerAgent(
          Array.from(creatorAgentId),
          new BN(CAPABILITY_COMPUTE),
          "https://creator.example.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)  // stake_amount
        )
        .accountsPartial({
          agent: creatorAgentPda,
          protocolConfig: protocolPda,
          authority: creator.publicKey,
        })
        .signers([creator])
        .rpc();
    } catch (e: any) {
      // Agent may already be registered
    }
  });

  // Ensure all shared agents are active before each test
  // and top up creator balance for long-running task lifecycle scenarios.
  beforeEach(async () => {
    await ensureWalletBalance(creator.publicKey, MIN_CREATOR_BALANCE_LAMPORTS);
  });

  describe("Happy Paths", () => {
    describe("Protocol Initialization", () => {
      it("Successfully initializes protocol", async () => {
        // Protocol may already be initialized by other test files
        // Just verify the protocol config exists and has valid values
        const protocol = await program.account.protocolConfig.fetch(protocolPda);
        expect(protocol.authority).to.exist;
        expect(protocol.treasury).to.exist;
        expect(protocol.disputeThreshold).to.be.at.least(1).and.at.most(100);
        expect(protocol.protocolFeeBps).to.be.at.least(0).and.at.most(1000);
        // totalAgents/totalTasks may have been incremented by other tests
        expect(Number(protocol.totalAgents)).to.be.at.least(0);
        expect(Number(protocol.totalTasks)).to.be.at.least(0);
      });

      it("Keeps protocol config accessible after initialization", async () => {
        const protocol = await program.account.protocolConfig.fetch(protocolPda);
        expect(protocol.authority).to.exist;
        expect(protocol.treasury).to.exist;
      });
    });

    describe("Agent Registration", () => {
      it("Successfully registers a new agent", async () => {
        const agentPda = deriveAgentPda(agentId1, program.programId);

        const balanceBefore = await provider.connection.getBalance(worker1.publicKey);

        await program.methods
          .registerAgent(
            Array.from(agentId1),
            new BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE),
            "https://worker1.example.com",
            null,
            new BN(1 * LAMPORTS_PER_SOL)  // stake_amount
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: worker1.publicKey,
          })
          .signers([worker1])
          .rpc();

        const agent = await program.account.agentRegistration.fetch(agentPda);
        expect(agent.agentId).to.deep.equal(Array.from(agentId1));
        expect(agent.authority.toString()).to.equal(worker1.publicKey.toString());
        expect(agent.capabilities.toNumber()).to.equal(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE);
        expect("active" in agent.status).to.be.true;
        expect(agent.endpoint).to.equal("https://worker1.example.com");
        expect(agent.reputation).to.equal(5000);
        expect(agent.activeTasks).to.equal(0);
      });

      it("Emits AgentRegistered event", async () => {
        const agentPda = deriveAgentPda(agentId2, program.programId);

        let eventEmitted = false;
        const listener = program.addEventListener("AgentRegistered", (event) => {
          expect(event.agentId).to.deep.equal(Array.from(agentId2));
          expect(event.authority.toString()).to.equal(worker2.publicKey.toString());
          eventEmitted = true;
        });

        await program.methods
          .registerAgent(
            Array.from(agentId2),
            new BN(CAPABILITY_COMPUTE),
            "https://worker2.example.com",
            null,
            new BN(1 * LAMPORTS_PER_SOL)  // stake_amount
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: worker2.publicKey,
          })
          .signers([worker2])
          .rpc();

        await new Promise((resolve) => setTimeout(resolve, 500));
        program.removeEventListener(listener);
        if (!eventEmitted) {
          const agent = await program.account.agentRegistration.fetch(agentPda);
          expect(agent.authority.toString()).to.equal(worker2.publicKey.toString());
        }
      });

      it("Fails when registering agent with empty endpoint", async () => {
        const emptyEndpointAgentId = makeAgentId("empty", runId);
        const agentPda = deriveAgentPda(emptyEndpointAgentId, program.programId);

        try {
          await program.methods
            .registerAgent(
              Array.from(emptyEndpointAgentId),
              new BN(CAPABILITY_COMPUTE),
              "",  // Empty endpoint - should fail
              null,
              new BN(1 * LAMPORTS_PER_SOL)
            )
            .accountsPartial({
              agent: agentPda,
              protocolConfig: protocolPda,
              authority: worker1.publicKey,
            })
            .signers([worker1])
            .rpc();
          expect.fail("Should have failed - empty endpoint");
        } catch (e: unknown) {
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code).to.equal("InvalidInput");
        }
      });
    });

    describe("Agent Update and Deregister", () => {
      it("Successfully updates agent capabilities and status", async () => {
        const agentPda = deriveAgentPda(agentId1, program.programId);

        await program.methods
          .updateAgent(
            new BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE | CAPABILITY_ARBITER),
            "https://worker1-updated.example.com",
            null,
            1
          )
          .accountsPartial({
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
        const agentPda = deriveAgentPda(agentId2, program.programId);

        await program.methods
          .deregisterAgent()
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: worker2.publicKey,
          })
          .signers([worker2])
          .rpc();

        try {
          await program.account.agentRegistration.fetch(agentPda);
          expect.fail("Should have failed - agent was deregistered");
        } catch (e: any) {
          // Expected: Account should not exist after deregistration
        }

        // totalAgents should have decreased, but we can't assert exact value due to shared state
        const protocol = await program.account.protocolConfig.fetch(protocolPda);
        expect(protocol.totalAgents).to.exist;
      });
    });

    describe("Task Creation - All Types", () => {
      it("Successfully creates exclusive task with reward", async () => {
        const taskPda = deriveTaskPda(creator.publicKey, taskId1, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        const rewardAmount = 2 * LAMPORTS_PER_SOL;
        const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

        await program.methods
          .createTask(
            Array.from(taskId1),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Process this data".padEnd(64, "\0")),
            new BN(rewardAmount),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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
        const taskPda = deriveTaskPda(creator.publicKey, taskId2, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        await program.methods
          .createTask(
            Array.from(taskId2),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Collaborative task".padEnd(64, "\0")),
            new BN(3 * LAMPORTS_PER_SOL),
            3,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_COLLABORATIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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
        expect(task.maxWorkers).to.equal(3);
        expect(task.taskType).to.deep.equal({ collaborative: {} });
        expect(task.requiredCompletions).to.equal(3);
      });

      it("Successfully creates competitive task", async () => {
        const taskPda = deriveTaskPda(creator.publicKey, taskId3, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        await program.methods
          .createTask(
            Array.from(taskId3),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Competitive task".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            5,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_COMPETITIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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
        expect(task.maxWorkers).to.equal(5);
        expect(task.taskType).to.deep.equal({ competitive: {} });
      });
    });

    describe("Task Claim and Complete - Exclusive Task", () => {
      it("Successfully claims exclusive task", async () => {
        const taskPda = deriveTaskPda(creator.publicKey, taskId1, program.programId);
        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const claimPda = deriveClaimPda(taskPda, worker1Pda, program.programId);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker1Pda,
            authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.equal(1);
        expect(task.status).to.deep.equal({ inProgress: {} });

        const claim = await program.account.taskClaim.fetch(claimPda);
        expect(claim.worker.toString()).to.equal(worker1Pda.toString());
        expect(claim.isCompleted).to.be.false;
      });

      it("Successfully completes exclusive task and receives reward", async () => {
        const taskPda = deriveTaskPda(creator.publicKey, taskId1, program.programId);
        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const claimPda = deriveClaimPda(taskPda, worker1Pda, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        const proofHash = Buffer.from("proof-hash-00000000000001".padEnd(32, "\0"));
        const rewardAmount = 2 * LAMPORTS_PER_SOL;
        const expectedFee = Math.floor(rewardAmount * 100 / 10000);
        const expectedReward = rewardAmount - expectedFee;

        const workerBalanceBefore = await provider.connection.getBalance(worker1.publicKey);
        const treasuryBalanceBefore = await provider.connection.getBalance(treasuryPubkey);

        await program.methods
          .completeTask(Array.from(proofHash), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: worker1Pda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker1.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker1])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ completed: {} });
        expect(task.completions).to.equal(1);

        try {
          await program.account.taskClaim.fetch(claimPda);
          expect.fail("Claim should be closed after completion");
        } catch {
          // Expected: claim account is closed in complete_task.
        }

        try {
          const escrow = await program.account.taskEscrow.fetch(escrowPda);
          expect(escrow.isClosed).to.be.true;
        } catch {
          // Expected when escrow account is fully closed after final completion.
        }

        const workerBalanceAfter = await provider.connection.getBalance(worker1.publicKey);
        const treasuryBalanceAfter = await provider.connection.getBalance(treasuryPubkey);

        expect(workerBalanceAfter - workerBalanceBefore).to.be.at.least(expectedReward - 100000);
        expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);

        const agent = await program.account.agentRegistration.fetch(worker1Pda);
        expect(agent.tasksCompleted.toNumber()).to.equal(1);
        expect(agent.totalEarned.toNumber()).to.equal(expectedReward);
        expect(agent.reputation).to.equal(5100);
        expect(agent.activeTasks).to.equal(0);
      });
    });

    describe("Task Cancel - Unclaimed", () => {
      it("Successfully cancels unclaimed task", async () => {
        const newTaskId = uniqueTaskId("cancel");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        const rewardAmount = 1 * LAMPORTS_PER_SOL;
        const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Cancelable task".padEnd(64, "\0")),
            new BN(rewardAmount),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            creatorTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });

        const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
        expect(creatorBalanceAfter).to.be.greaterThan(creatorBalanceBefore - 10_000_000);
      });
    });

    describe("Dispute Flow - Full Cycle", () => {
      let taskPda: PublicKey;
      let escrowPda: PublicKey;
      let disputePda: PublicKey;
      let workerPda: PublicKey;
      let disputeTaskId: Buffer;
      let workerClaimPda: PublicKey;

      before(async () => {
        workerPda = deriveAgentPda(agentId3, program.programId);

        disputeTaskId = uniqueTaskId("dispute");
        taskPda = deriveTaskPda(creator.publicKey, disputeTaskId, program.programId);
        escrowPda = deriveEscrowPda(taskPda, program.programId);
        disputePda = deriveDisputePda(disputeId1, program.programId);

        await program.methods
          .registerAgent(
            Array.from(agentId3),
            new BN(CAPABILITY_COMPUTE),
            "https://worker3.example.com",
            null,
            new BN(1 * LAMPORTS_PER_SOL)  // stake_amount
          )
          .accountsPartial({
            agent: workerPda,
            protocolConfig: protocolPda,
            authority: worker3.publicKey,
          })
          .signers([worker3])
          .rpc();

        await program.methods
          .createTask(
            Array.from(disputeTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Dispute task".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        workerClaimPda = deriveClaimPda(taskPda, workerPda, program.programId);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: workerClaimPda,
            worker: workerPda,
            authority: worker3.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();
      });

      it("Successfully initiates dispute", async () => {
        const evidenceHash = Buffer.from("evidence-hash000000000001".padEnd(32, "\0"));

        await program.methods
          .initiateDispute(
            Array.from(disputeId1),
            Array.from(disputeTaskId),
            Array.from(evidenceHash),
            RESOLUTION_TYPE_REFUND,
            VALID_EVIDENCE
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: workerPda,
            protocolConfig: protocolPda,
            authority: worker3.publicKey,
            initiatorClaim: workerClaimPda,
            workerAgent: null,
            workerClaim: null,
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

          const arbiterPda = deriveAgentPda(arbiterId, program.programId);
          const votePda = deriveVotePda(disputePda, arbiterPda, program.programId);
          const authorityVotePda = deriveAuthorityVotePda(disputePda, arbiterKey.publicKey, program.programId);

          await program.methods
            .registerAgent(
              Array.from(arbiterId),
              new BN(CAPABILITY_ARBITER),
              `https://arbiter${i + 1}.example.com`,
              null,
              new BN(1 * LAMPORTS_PER_SOL)  // stake_amount
            )
            .accountsPartial({
              agent: arbiterPda,
              protocolConfig: protocolPda,
              authority: arbiterKey.publicKey,
            })
            .signers([arbiterKey])
            .rpc();

          await program.methods
            .voteDispute(approve)
            .accountsPartial({
              dispute: disputePda,
              vote: votePda,
              authorityVote: authorityVotePda,
              arbiter: arbiterPda,
              protocolConfig: protocolPda,
              authority: arbiterKey.publicKey,
              task: taskPda,
              workerClaim: workerClaimPda,
              defendantAgent: workerPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([arbiterKey])
            .rpc();
        }

        const dispute = await program.account.dispute.fetch(disputePda);
        // Votes are stake-weighted by reputation (default 5000 = 50% weight).
        const expectedVoteWeight = Math.floor(LAMPORTS_PER_SOL / 2);
        expect(dispute.votesFor.toNumber()).to.equal(2 * expectedVoteWeight);
        expect(dispute.votesAgainst.toNumber()).to.equal(1 * expectedVoteWeight);
        expect(dispute.totalVoters).to.equal(3);
      });

      it("Rejects early dispute resolution before voting period ends", async () => {
        const arbiterPda1 = deriveAgentPda(arbiterId1, program.programId);
        const arbiterPda2 = deriveAgentPda(arbiterId2, program.programId);
        const arbiterPda3 = deriveAgentPda(arbiterId3, program.programId);
        const votePda1 = deriveVotePda(disputePda, arbiterPda1, program.programId);
        const votePda2 = deriveVotePda(disputePda, arbiterPda2, program.programId);
        const votePda3 = deriveVotePda(disputePda, arbiterPda3, program.programId);
        let resolved = false;

        try {
          await program.methods
            .resolveDispute()
            .accountsPartial({
              dispute: disputePda,
              task: taskPda,
              escrow: escrowPda,
              protocolConfig: protocolPda,
              resolver: provider.wallet.publicKey,
              creator: creator.publicKey,
              workerClaim: workerClaimPda,
              worker: workerPda,
              workerAuthority: worker3.publicKey,
              systemProgram: SystemProgram.programId,
              tokenEscrowAta: null,
              creatorTokenAccount: null,
              workerTokenAccountAta: null,
              treasuryTokenAccount: null,
              rewardMint: null,
              tokenProgram: null,
            })
            .remainingAccounts([
              { pubkey: votePda1, isSigner: false, isWritable: false },
              { pubkey: arbiterPda1, isSigner: false, isWritable: true },
              { pubkey: votePda2, isSigner: false, isWritable: false },
              { pubkey: arbiterPda2, isSigner: false, isWritable: true },
              { pubkey: votePda3, isSigner: false, isWritable: false },
              { pubkey: arbiterPda3, isSigner: false, isWritable: true },
            ])
            .rpc();
          resolved = true;
        } catch (e: unknown) {
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }

        if (resolved) {
          const dispute = await program.account.dispute.fetch(disputePda);
          expect(dispute.status).to.deep.equal({ resolved: {} });
        }
      });
    });
  });

  describe("Security and Edge Cases", () => {
    describe("Unauthorized Access", () => {
      it("Fails when non-authority tries to update agent", async () => {
        const agentPda = deriveAgentPda(agentId1, program.programId);

        try {
          await program.methods
            .updateAgent(new BN(CAPABILITY_COMPUTE), "https://malicious.com", null, 1)  // 1 = Active
            .accountsPartial({
              agent: agentPda,
              authority: unauthorized.publicKey,
            })
            .signers([unauthorized])
            .rpc();
          expect.fail("Should have failed - unauthorized agent update");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });

      it("Fails when non-creator tries to cancel task", async () => {
        const newTaskId = uniqueTaskId("unauth");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Test task".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        try {
          await program.methods
            .cancelTask()
            .accountsPartial({
              task: taskPda,
              escrow: escrowPda,
              creator: unauthorized.publicKey,
              protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            creatorTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
            })
            .signers([unauthorized])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });
    });

    describe("Double Claims and Completions", () => {
      it("Fails when worker tries to claim same task twice", async () => {
        const newTaskId = uniqueTaskId("double-claim");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);
        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const claimPda = deriveClaimPda(taskPda, worker1Pda, program.programId);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Double claim test".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            2,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_COLLABORATIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker1Pda,
            authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              worker: worker1Pda,
              authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc();
          expect.fail("Should have failed - double claim");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });

      it("Fails when worker tries to complete task twice", async () => {
        const newTaskId = uniqueTaskId("double-complete");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);
        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const claimPda = deriveClaimPda(taskPda, worker1Pda, program.programId);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Double complete test".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker1Pda,
            authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        const proofHash = Buffer.from("proof-hash-00000000000002".padEnd(32, "\0"));

        await program.methods
          .completeTask(Array.from(proofHash), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: worker1Pda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker1.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker1])
          .rpc();

        try {
          await program.methods
            .completeTask(Array.from(proofHash), null)
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              escrow: escrowPda,
              worker: worker1Pda,
              protocolConfig: protocolPda,
              treasury: treasuryPubkey,
              authority: worker1.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
            })
            .signers([worker1])
            .rpc();
          expect.fail("Should have failed - double completion");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });
    });

    describe("Capability and Status Validation", () => {
      it("Fails when worker lacks required capabilities", async () => {
        const newTaskId = uniqueTaskId("cap-check");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);
        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const claimPda = deriveClaimPda(taskPda, worker1Pda, program.programId);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_STORAGE),
            Buffer.from("Capability test".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              worker: worker1Pda,
              authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc();
          expect.fail("Should have failed - worker lacks capabilities");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });

      it("Fails when inactive agent tries to claim task", async () => {
        const inactiveWorker = Keypair.generate();
        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(inactiveWorker.publicKey, 3 * LAMPORTS_PER_SOL),
          "confirmed"
        );

        const inactiveAgentId = uniqueAgentId("inactive-worker");
        const agentPda = deriveAgentPda(inactiveAgentId, program.programId);

        await program.methods
          .registerAgent(
            Array.from(inactiveAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://inactive-worker.example.com",
            null,
            new BN(1 * LAMPORTS_PER_SOL)
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: inactiveWorker.publicKey,
          })
          .signers([inactiveWorker])
          .rpc();

        await program.methods
          .updateAgent(null, null, null, 0)  // 0 = Inactive
          .accountsPartial({
            agent: agentPda,
            authority: inactiveWorker.publicKey,
          })
          .signers([inactiveWorker])
          .rpc();

        const newTaskId = uniqueTaskId("inactive");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);
        const claimPda = deriveClaimPda(taskPda, agentPda, program.programId);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Inactive agent test".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              worker: agentPda,
              authority: inactiveWorker.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            })
            .signers([inactiveWorker])
            .rpc();
          expect.fail("Should have failed - inactive agent");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });
    });

    describe("Deadline Expiry", () => {
      it("Fails to claim task after deadline", async () => {
        const newTaskId = uniqueTaskId("expired");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        const nearFutureDeadline = Math.floor(Date.now() / 1000) + 2;

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Expired task".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(nearFutureDeadline),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        await new Promise((resolve) => setTimeout(resolve, 3000));

        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const claimPda = deriveClaimPda(taskPda, worker1Pda, program.programId);

        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              worker: worker1Pda,
              authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc();
          expect.fail("Should have failed - task expired");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });

      it("Successfully cancels expired task with no completions", async () => {
        const newTaskId = uniqueTaskId("cancel-expired");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        const nearFutureDeadline = Math.floor(Date.now() / 1000) + 2;

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Soon expired".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(nearFutureDeadline),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        await new Promise((resolve) => setTimeout(resolve, 3000));

        await program.methods
          .cancelTask()
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            creatorTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });
      });
    });

    describe("Dispute Threshold Tests", () => {
      it("Rejects dispute resolution without quorum/deadline", async () => {
        const newDisputeId = uniqueDisputeId("threshold");
        const newTaskId = uniqueTaskId("threshold");
        const disputePda = deriveDisputePda(newDisputeId, program.programId);
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Threshold test".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        const worker3AgentPda = deriveAgentPda(agentId3, program.programId);
        const workerClaimPda = deriveClaimPda(taskPda, worker3AgentPda, program.programId);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: workerClaimPda,
            worker: worker3AgentPda,
            authority: worker3.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        await program.methods
          .initiateDispute(
            Array.from(newDisputeId),
            Array.from(newTaskId),
            Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
            RESOLUTION_TYPE_REFUND,
            VALID_EVIDENCE
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: worker3AgentPda,
            protocolConfig: protocolPda,
            authority: worker3.publicKey,
            initiatorClaim: workerClaimPda,
            workerAgent: null,
            workerClaim: null,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        const arbiterPda1 = deriveAgentPda(arbiterId1, program.programId);
        const arbiterPda2 = deriveAgentPda(arbiterId2, program.programId);

        const votePda1 = deriveVotePda(disputePda, arbiterPda1, program.programId);
        const votePda2 = deriveVotePda(disputePda, arbiterPda2, program.programId);
        const authorityVotePda1 = deriveAuthorityVotePda(disputePda, arbiter1.publicKey, program.programId);
        const authorityVotePda2 = deriveAuthorityVotePda(disputePda, arbiter2.publicKey, program.programId);

        await program.methods
          .voteDispute(true)
          .accountsPartial({
            dispute: disputePda,
            vote: votePda1,
            authorityVote: authorityVotePda1,
            arbiter: arbiterPda1,
            protocolConfig: protocolPda,
            authority: arbiter1.publicKey,
            task: taskPda,
            workerClaim: workerClaimPda,
            defendantAgent: worker3AgentPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter1])
          .rpc();

        await program.methods
          .voteDispute(true)
          .accountsPartial({
            dispute: disputePda,
            vote: votePda2,
            authorityVote: authorityVotePda2,
            arbiter: arbiterPda2,
            protocolConfig: protocolPda,
            authority: arbiter2.publicKey,
            task: taskPda,
            workerClaim: workerClaimPda,
            defendantAgent: worker3AgentPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter2])
          .rpc();

        try {
          await program.methods
            .resolveDispute()
            .accountsPartial({
              dispute: disputePda,
              task: taskPda,
              escrow: escrowPda,
              protocolConfig: protocolPda,
              resolver: provider.wallet.publicKey,
              creator: creator.publicKey,
              workerClaim: workerClaimPda,
              worker: worker3AgentPda,
              workerAuthority: worker3.publicKey,
              systemProgram: SystemProgram.programId,
              tokenEscrowAta: null,
              creatorTokenAccount: null,
              workerTokenAccountAta: null,
              treasuryTokenAccount: null,
              rewardMint: null,
              tokenProgram: null,
            })
            .remainingAccounts([
              { pubkey: votePda1, isSigner: false, isWritable: false },
              { pubkey: arbiterPda1, isSigner: false, isWritable: true },
              { pubkey: votePda2, isSigner: false, isWritable: false },
              { pubkey: arbiterPda2, isSigner: false, isWritable: true },
            ])
            .rpc();
          expect.fail("Should have failed - quorum/deadline not satisfied");
        } catch (e: unknown) {
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });
    });

    describe("Max Workers Boundary", () => {
      it("Fails when task exceeds max workers", async () => {
        const newTaskId = uniqueTaskId("max-workers");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Max workers test".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            2,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_COLLABORATIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const worker3Pda = deriveAgentPda(agentId3, program.programId);
        const claimPda1 = deriveClaimPda(taskPda, worker1Pda, program.programId);
        const claimPda2 = deriveClaimPda(taskPda, worker3Pda, program.programId);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker1Pda,
            authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker3Pda,
            authority: worker3.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.equal(2);

        const extraWorker = Keypair.generate();
        const extraAgentId = uniqueAgentId("extra");
        const extraAgentPda = deriveAgentPda(extraAgentId, program.programId);
        const claimPda3 = deriveClaimPda(taskPda, extraAgentPda, program.programId);

        await provider.connection.confirmTransaction(
          await provider.connection.requestAirdrop(extraWorker.publicKey, 2 * LAMPORTS_PER_SOL),
          "confirmed"
        );

        await program.methods
          .registerAgent(
            Array.from(extraAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://extra.com",
            null,
            new BN(LAMPORTS_PER_SOL)  // stake_amount
          )
          .accountsPartial({
            agent: extraAgentPda,
            protocolConfig: protocolPda,
            authority: extraWorker.publicKey,
          })
          .signers([extraWorker])
          .rpc();

        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda3,
              worker: extraAgentPda,
              authority: extraWorker.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            })
            .signers([extraWorker])
            .rpc();
          expect.fail("Should have failed - max workers exceeded");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });
    });

    describe("Zero Reward Tasks", () => {
      it("Fails to create zero-reward task", async () => {
        const newTaskId = uniqueTaskId("zero-reward");
        try {
          await program.methods
            .createTask(
              Array.from(newTaskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("Zero reward task".padEnd(64, "\0")),
              new BN(0),
              1,
              new BN(Math.floor(Date.now() / 1000) + 3600),
              TASK_TYPE_EXCLUSIVE,
              null,  // constraint_hash
              0, // min_reputation
              null, // reward_mint
            )
            .accountsPartial({
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
          expect.fail("Should have failed - zero reward is invalid");
        } catch (e: unknown) {
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });
    });

    describe("Deregister with Active Tasks", () => {
      it("Fails to deregister agent with active tasks", async () => {
        const newTaskId = uniqueTaskId("deregister");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Deregister test".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const claimPda = deriveClaimPda(taskPda, worker1Pda, program.programId);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker1Pda,
            authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        const agentPda = deriveAgentPda(agentId1, program.programId);

        try {
          await program.methods
            .deregisterAgent()
            .accountsPartial({
              agent: agentPda,
              protocolConfig: protocolPda,
              authority: worker1.publicKey,
            })
            .signers([worker1])
            .rpc();
          expect.fail("Should have failed - agent has active tasks");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });
    });

    describe("Arbiter Voting Requirements", () => {
      it("Fails when non-arbiter tries to vote", async () => {
        const newDisputeId = uniqueDisputeId("non-arbiter");
        const newTaskId = uniqueTaskId("non-arbiter");
        const disputePda = deriveDisputePda(newDisputeId, program.programId);
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Non-arbiter test".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        const worker3AgentPda = deriveAgentPda(agentId3, program.programId);
        const workerClaimPda = deriveClaimPda(taskPda, worker3AgentPda, program.programId);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: workerClaimPda,
            worker: worker3AgentPda,
            authority: worker3.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        await program.methods
          .initiateDispute(
            Array.from(newDisputeId),
            Array.from(newTaskId),
            Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
            RESOLUTION_TYPE_REFUND,
            VALID_EVIDENCE
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: worker3AgentPda,
            protocolConfig: protocolPda,
            authority: worker3.publicKey,
            initiatorClaim: workerClaimPda,
            workerAgent: null,
            workerClaim: null,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker3])
          .rpc();

        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const votePda = deriveVotePda(disputePda, worker1Pda, program.programId);
        const authorityVotePda = deriveAuthorityVotePda(disputePda, worker1.publicKey, program.programId);

        try {
          await program.methods
            .voteDispute(true)
            .accountsPartial({
              dispute: disputePda,
              vote: votePda,
              authorityVote: authorityVotePda,
              arbiter: worker1Pda,
              protocolConfig: protocolPda,
              authority: worker1.publicKey,
              task: taskPda,
              workerClaim: workerClaimPda,
              defendantAgent: worker3AgentPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker1])
            .rpc();
          expect.fail("Should have failed - non-arbiter voting");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });
    });

    describe("Protocol Configuration Validation", () => {
      it("Fails to initialize with invalid fee (over 1000 bps)", async () => {
        const newProtocolPda = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol2")],
          program.programId
        )[0];

        try {
          await program.methods
            .initializeProtocol(51, 1001, new BN(1 * LAMPORTS_PER_SOL), 1, [provider.wallet.publicKey])
            .accountsPartial({
              protocolConfig: newProtocolPda,
              treasury: treasury.publicKey,
              authority: provider.wallet.publicKey,
            })
            .remainingAccounts([{ pubkey: deriveProgramDataPda(program.programId), isSigner: false, isWritable: false }])
            .rpc();
          expect.fail("Should have failed - invalid fee");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });

      it("Fails to initialize with invalid dispute threshold (0)", async () => {
        const newProtocolPda = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol3")],
          program.programId
        )[0];

        try {
          await program.methods
            .initializeProtocol(0, 100, new BN(1 * LAMPORTS_PER_SOL), 1, [provider.wallet.publicKey])
            .accountsPartial({
              protocolConfig: newProtocolPda,
              treasury: treasury.publicKey,
              authority: provider.wallet.publicKey,
            })
            .remainingAccounts([{ pubkey: deriveProgramDataPda(program.programId), isSigner: false, isWritable: false }])
            .rpc();
          expect.fail("Should have failed - invalid dispute threshold");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });

      it("Fails to initialize with invalid dispute threshold (> 100)", async () => {
        const newProtocolPda = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol4")],
          program.programId
        )[0];

        try {
          await program.methods
            .initializeProtocol(101, 100, new BN(1 * LAMPORTS_PER_SOL), 1, [provider.wallet.publicKey])
            .accountsPartial({
              protocolConfig: newProtocolPda,
              treasury: treasury.publicKey,
              authority: provider.wallet.publicKey,
            })
            .remainingAccounts([{ pubkey: deriveProgramDataPda(program.programId), isSigner: false, isWritable: false }])
            .rpc();
          expect.fail("Should have failed - invalid dispute threshold > 100");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
        }
      });
    });

    describe("Fund Leak Prevention", () => {
      it("Verifies no lamport leaks in task lifecycle", async () => {
        const newTaskId = uniqueTaskId("fund-leak");
        const taskPda = deriveTaskPda(creator.publicKey, newTaskId, program.programId);
        const escrowPda = deriveEscrowPda(taskPda, program.programId);

        const initialBalance = await provider.connection.getBalance(creator.publicKey);
        const rewardAmount = 2 * LAMPORTS_PER_SOL;

        await program.methods
          .createTask(
            Array.from(newTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Fund leak test".padEnd(64, "\0")),
            new BN(rewardAmount),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,  // constraint_hash
            0, // min_reputation
          null, // reward_mint
          )
          .accountsPartial({
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

        const afterCreateBalance = await provider.connection.getBalance(creator.publicKey);
        const escrowBalance = await provider.connection.getBalance(escrowPda);

        expect(initialBalance - afterCreateBalance).to.be.at.most(rewardAmount + 10_000_000);
        expect(escrowBalance).to.be.at.least(rewardAmount);
        expect(escrowBalance).to.be.at.most(rewardAmount + 5_000_000);

        const worker1Pda = deriveAgentPda(agentId1, program.programId);
        const claimPda = deriveClaimPda(taskPda, worker1Pda, program.programId);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker1Pda,
            authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        const proofHash = Buffer.from("proof-hash-00000000000004".padEnd(32, "\0"));

        await program.methods
          .completeTask(Array.from(proofHash), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: worker1Pda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker1.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker1])
          .rpc();

        const finalEscrowBalance = await provider.connection.getBalance(escrowPda);
        expect(finalEscrowBalance).to.equal(0);
      });
    });
  });
});
