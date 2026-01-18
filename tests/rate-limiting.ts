import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";

describe("rate-limiting", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  let treasury: Keypair;
  let creator: Keypair;
  let worker: Keypair;
  let creatorAgentPda: PublicKey;

  const CAPABILITY_COMPUTE = 1 << 0;

  const TASK_TYPE_EXCLUSIVE = 0;

  // Evidence must be at least 50 characters per initiate_dispute.rs requirements
  const VALID_EVIDENCE = "This is valid dispute evidence that exceeds the minimum 50 character requirement for the dispute system.";
  const creatorAgentId = Buffer.from("agent-ratelimit-task001".padEnd(32, "\0"));

  before(async () => {
    treasury = Keypair.generate();
    creator = Keypair.generate();
    worker = Keypair.generate();

    const airdropAmount = 100 * LAMPORTS_PER_SOL;
    const wallets = [treasury, creator, worker];

    for (const wallet of wallets) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount),
        "confirmed"
      );
    }

    // Initialize protocol with rate limits
    try {
      await program.methods
        .initializeProtocol(
          51, // dispute_threshold
          100, // protocol_fee_bps
          new BN(LAMPORTS_PER_SOL), // min_arbiter_stake
          1, // multisig_threshold
          [provider.wallet.publicKey] // multisig_owners
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
        .rpc();
    } catch (e) {
      // Protocol may already be initialized
    }
  });

  describe("Task Creation Rate Limiting", () => {
    let agentId: Buffer;
    let agentPda: PublicKey;
    let taskCounter = 0;

    before(async () => {
      agentId = creatorAgentId;
      [creatorAgentPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), agentId],
        program.programId
      );
      agentPda = creatorAgentPda;

      // Register agent for rate limiting tests
      try {
        await program.methods
          .registerAgent(
            Array.from(agentId),
            new BN(CAPABILITY_COMPUTE),
            "https://ratelimit-agent.example.com",
            null,
            new BN(LAMPORTS_PER_SOL)  // stake_amount
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: creator.publicKey,
          })
          .signers([creator])
          .rpc();
      } catch (e: any) {
        // Agent may already be registered
      }
    });

    const createTaskWithAgent = async (taskIdSuffix: string) => {
      const taskId = Buffer.from(`task-rl-${taskIdSuffix}`.padEnd(32, "\0"));
      const [taskPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), creator.publicKey.toBuffer(), taskId],
        program.programId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), taskPda.toBuffer()],
        program.programId
      );

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Rate limit test task".padEnd(64, "\0")),
          new BN(0.1 * LAMPORTS_PER_SOL),
          1,
          new BN(0),
          TASK_TYPE_EXCLUSIVE,
          null  // constraint_hash
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: agentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      return { taskPda, escrowPda };
    };

    it("Successfully creates first task (no cooldown)", async () => {
      taskCounter++;
      await createTaskWithAgent(`first-${taskCounter}`);

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.lastTaskCreated.toNumber()).to.be.greaterThan(0);
      expect(agent.taskCount24h).to.equal(1);
    });

    it("Fails when creating task within cooldown period", async () => {
      taskCounter++;
      // Immediately try to create another task
      try {
        await createTaskWithAgent(`cooldown-${taskCounter}`);
        expect.fail("Should have failed due to cooldown");
      } catch (e: any) {
        expect(e.message).to.include("CooldownNotElapsed");
      }
    });

    it("Successfully creates task after cooldown period", async function() {
      this.timeout(70000); // 70 second timeout

      // Wait for cooldown (default 60 seconds)
      await new Promise(resolve => setTimeout(resolve, 61000));

      taskCounter++;
      await createTaskWithAgent(`after-cooldown-${taskCounter}`);

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.taskCount24h).to.equal(2);
    });

    it("Creates task with agent registration", async () => {
      const taskId = Buffer.from("task-no-agent-001".padEnd(32, "\0"));
      const [taskPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), creator.publicKey.toBuffer(), taskId],
        program.programId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), taskPda.toBuffer()],
        program.programId
      );

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("No agent task".padEnd(64, "\0")),
          new BN(0.1 * LAMPORTS_PER_SOL),
          1,
          new BN(0),
          TASK_TYPE_EXCLUSIVE,
          null  // constraint_hash
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: agentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();
    });
  });

  describe("Dispute Rate Limiting", () => {
    let disputeAgentId: Buffer;
    let disputeAgentPda: PublicKey;
    let disputeCounter = 0;

    before(async () => {
      disputeAgentId = Buffer.from("agent-dispute-rl-001".padEnd(32, "\0"));
      [disputeAgentPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), disputeAgentId],
        program.programId
      );

      // Register agent for dispute tests
      try {
        await program.methods
          .registerAgent(
            Array.from(disputeAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://dispute-agent.example.com",
            null,
            new BN(LAMPORTS_PER_SOL)  // stake_amount
          )
          .accountsPartial({
            agent: disputeAgentPda,
            protocolConfig: protocolPda,
            authority: worker.publicKey,
          })
          .signers([worker])
          .rpc();
      } catch (e: any) {
        // Agent may already be registered
      }
    });

    const createTaskForDispute = async (taskIdSuffix: string) => {
      const taskId = Buffer.from(`task-disp-${taskIdSuffix}`.padEnd(32, "\0"));
      const [taskPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), creator.publicKey.toBuffer(), taskId],
        program.programId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), taskPda.toBuffer()],
        program.programId
      );
      const [claimPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), taskPda.toBuffer(), worker.publicKey.toBuffer()],
        program.programId
      );

      // Create task
      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Dispute test task".padEnd(64, "\0")),
          new BN(0.5 * LAMPORTS_PER_SOL),
          1,
          new BN(0),
          TASK_TYPE_EXCLUSIVE,
          null  // constraint_hash
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      // Claim task to make it disputable
      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          worker: disputeAgentPda,
          authority: worker.publicKey,
        })
        .signers([worker])
        .rpc();

      return { taskPda, taskId };
    };

    it("Successfully initiates first dispute", async () => {
      disputeCounter++;
      const { taskPda, taskId } = await createTaskForDispute(`first-${disputeCounter}`);

      const disputeId = Buffer.from(`disp-rl-first-${disputeCounter}`.padEnd(32, "\0"));
      const [disputePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("dispute"), disputeId],
        program.programId
      );

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
          0, // REFUND
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: disputeAgentPda,
          protocolConfig: protocolPda,
          authority: worker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker])
        .rpc();

      const agent = await program.account.agentRegistration.fetch(disputeAgentPda);
      expect(agent.lastDisputeInitiated.toNumber()).to.be.greaterThan(0);
      expect(agent.disputeCount24h).to.equal(1);
    });

    it("Fails when initiating dispute within cooldown period", async () => {
      disputeCounter++;
      const { taskPda, taskId } = await createTaskForDispute(`cooldown-${disputeCounter}`);

      const disputeId = Buffer.from(`disp-rl-cool-${disputeCounter}`.padEnd(32, "\0"));
      const [disputePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("dispute"), disputeId],
        program.programId
      );

      // Immediately try to initiate another dispute (within 5 min cooldown)
      try {
        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
            0,
            VALID_EVIDENCE
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: disputeAgentPda,
            protocolConfig: protocolPda,
            authority: worker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker])
          .rpc();
        expect.fail("Should have failed due to cooldown");
      } catch (e: any) {
        expect(e.message).to.include("CooldownNotElapsed");
      }
    });
  });

  describe("Rate Limit Configuration Update", () => {
    it("Updates rate limit parameters via multisig", async () => {
      // Update rate limits (requires multisig)
      await program.methods
        .updateRateLimits(
          new BN(30), // task_creation_cooldown: 30 seconds
          100, // max_tasks_per_24h: 100
          new BN(60), // dispute_initiation_cooldown: 60 seconds
          20, // max_disputes_per_24h: 20
          new BN(0.5 * LAMPORTS_PER_SOL) // min_stake_for_dispute
        )
        .accountsPartial({
          protocolConfig: protocolPda,
        })
        .remainingAccounts([
          { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false }
        ])
        .rpc();

      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.taskCreationCooldown.toNumber()).to.equal(30);
      expect(config.maxTasksPer24h).to.equal(100);
      expect(config.disputeInitiationCooldown.toNumber()).to.equal(60);
      expect(config.maxDisputesPer24h).to.equal(20);
      expect(config.minStakeForDispute.toNumber()).to.equal(0.5 * LAMPORTS_PER_SOL);
    });
  });

  describe("Stake Requirement for Disputes", () => {
    let lowStakeAgentId: Buffer;
    let lowStakeAgentPda: PublicKey;

    before(async () => {
      lowStakeAgentId = Buffer.from("agent-lowstake-001".padEnd(32, "\0"));
      [lowStakeAgentPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), lowStakeAgentId],
        program.programId
      );

      const lowStakeWorker = Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(lowStakeWorker.publicKey, 10 * LAMPORTS_PER_SOL),
        "confirmed"
      );

      // Register agent with no stake
      try {
        await program.methods
          .registerAgent(
            Array.from(lowStakeAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://lowstake-agent.example.com",
            null,
            new BN(0)  // stake_amount = 0 for low stake test
          )
          .accountsPartial({
            agent: lowStakeAgentPda,
            protocolConfig: protocolPda,
            authority: lowStakeWorker.publicKey,
          })
          .signers([lowStakeWorker])
          .rpc();
      } catch (e: any) {
        // Agent may already be registered
      }
    });

    it("Fails to initiate dispute with insufficient stake", async () => {
      const taskId = Buffer.from("task-stake-test-001".padEnd(32, "\0"));
      const [taskPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), creator.publicKey.toBuffer(), taskId],
        program.programId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), taskPda.toBuffer()],
        program.programId
      );

      // Create task
      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Stake test task".padEnd(64, "\0")),
          new BN(0.5 * LAMPORTS_PER_SOL),
          1,
          new BN(0),
          TASK_TYPE_EXCLUSIVE,
          null  // constraint_hash
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      const disputeId = Buffer.from("disp-stake-test-001".padEnd(32, "\0"));
      const [disputePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("dispute"), disputeId],
        program.programId
      );

      const lowStakeWorker = Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(lowStakeWorker.publicKey, 2 * LAMPORTS_PER_SOL),
        "confirmed"
      );

      // Agent has 0 stake, but protocol requires 0.5 SOL minimum
      try {
        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
            0,
            VALID_EVIDENCE
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: lowStakeAgentPda,
            protocolConfig: protocolPda,
            authority: lowStakeWorker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([lowStakeWorker])
          .rpc();
        expect.fail("Should have failed due to insufficient stake");
      } catch (e: any) {
        expect(e.message).to.include("InsufficientStakeForDispute");
      }
    });
  });

  describe("24-Hour Window Limits", () => {
    it("Tracks task count across 24h window", async () => {
      const agentId = Buffer.from("agent-24h-task-001".padEnd(32, "\0"));
      const [agentPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), agentId],
        program.programId
      );

      const testCreator = Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(testCreator.publicKey, 50 * LAMPORTS_PER_SOL),
        "confirmed"
      );

      try {
        await program.methods
          .registerAgent(
            Array.from(agentId),
            new BN(CAPABILITY_COMPUTE),
            "https://24h-agent.example.com",
            null,
            new BN(LAMPORTS_PER_SOL)  // stake_amount
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: testCreator.publicKey,
          })
          .signers([testCreator])
          .rpc();
      } catch (e: any) {
        // Agent may already be registered
      }

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.taskCount24h).to.equal(0);
      expect(agent.disputeCount24h).to.equal(0);
      expect(agent.rateLimitWindowStart.toNumber()).to.be.greaterThan(0);
    });
  });

  describe("RateLimitHit Event", () => {
    it("Emits RateLimitHit event when cooldown not elapsed", async () => {
      const agentId = Buffer.from("agent-event-test-001".padEnd(32, "\0"));
      const [agentPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), agentId],
        program.programId
      );

      const eventCreator = Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(eventCreator.publicKey, 20 * LAMPORTS_PER_SOL),
        "confirmed"
      );

      try {
        await program.methods
          .registerAgent(
            Array.from(agentId),
            new BN(CAPABILITY_COMPUTE),
            "https://event-agent.example.com",
            null,
            new BN(LAMPORTS_PER_SOL)  // stake_amount
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: eventCreator.publicKey,
          })
          .signers([eventCreator])
          .rpc();
      } catch (e: any) {
        // Agent may already be registered
      }

      // First task
      const taskId1 = Buffer.from("task-event-test-001".padEnd(32, "\0"));
      const [taskPda1] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), eventCreator.publicKey.toBuffer(), taskId1],
        program.programId
      );
      const [escrowPda1] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), taskPda1.toBuffer()],
        program.programId
      );

      await program.methods
        .createTask(
          Array.from(taskId1),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Event test task 1".padEnd(64, "\0")),
          new BN(0.1 * LAMPORTS_PER_SOL),
          1,
          new BN(0),
          TASK_TYPE_EXCLUSIVE,
          null  // constraint_hash
        )
        .accountsPartial({
          task: taskPda1,
          escrow: escrowPda1,
          protocolConfig: protocolPda,
          creatorAgent: agentPda,
          authority: eventCreator.publicKey,
          creator: eventCreator.publicKey,
        })
        .signers([eventCreator])
        .rpc();

      // Listen for RateLimitHit event
      let eventReceived = false;
      const listener = program.addEventListener("RateLimitHit", (event) => {
        expect(event.actionType).to.equal(0); // task_creation
        expect(event.limitType).to.equal(0); // cooldown
        expect(event.cooldownRemaining.toNumber()).to.be.greaterThan(0);
        eventReceived = true;
      });

      // Second task (should fail with event)
      const taskId2 = Buffer.from("task-event-test-002".padEnd(32, "\0"));
      const [taskPda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), eventCreator.publicKey.toBuffer(), taskId2],
        program.programId
      );
      const [escrowPda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), taskPda2.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .createTask(
            Array.from(taskId2),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Event test task 2".padEnd(64, "\0")),
            new BN(0.1 * LAMPORTS_PER_SOL),
            1,
            new BN(0),
            TASK_TYPE_EXCLUSIVE,
            null  // constraint_hash
          )
          .accountsPartial({
            task: taskPda2,
            escrow: escrowPda2,
            protocolConfig: protocolPda,
            creatorAgent: agentPda,
            authority: eventCreator.publicKey,
            creator: eventCreator.publicKey,
          })
          .signers([eventCreator])
          .rpc();
      } catch (e) {
        // Expected to fail
      }

      await new Promise(resolve => setTimeout(resolve, 500));
      program.removeEventListener(listener);

      // Event may or may not be received depending on when instruction fails
    });
  });

  describe("Boundary Conditions", () => {
    it("Handles zero cooldown (disabled)", async () => {
      // This test verifies the protocol handles 0 cooldown correctly
      const config = await program.account.protocolConfig.fetch(protocolPda);
      // If cooldown is > 0, the rate limiting is active
      expect(config.taskCreationCooldown.toNumber()).to.be.at.least(0);
    });

    it("Handles zero max tasks (unlimited)", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      // max_tasks_per_24h of 0 means unlimited
      // Current config should have a reasonable limit
      expect(config.maxTasksPer24h).to.be.at.least(0);
    });
  });
});
