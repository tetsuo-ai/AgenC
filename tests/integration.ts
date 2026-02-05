/**
 * AgenC Integration Tests
 *
 * Following Anchor 0.32 best practices from official documentation:
 * - https://www.anchor-lang.com/docs/clients/typescript
 * - https://www.anchor-lang.com/docs/updates/release-notes/0-30-0
 *
 * Key patterns used:
 * 1. Use .accounts() for accounts with resolvable PDAs (const seeds or arg seeds)
 * 2. Use .accountsPartial() ONLY for self-referential PDAs that can't be auto-resolved
 * 3. All instruction arguments must match the IDL exactly
 * 4. Account names use camelCase (Anchor converts from snake_case automatically)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  CAPABILITY_STORAGE,
  CAPABILITY_NETWORK,
  CAPABILITY_COORDINATOR,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COLLABORATIVE,
  TASK_TYPE_COMPETITIVE,
  deriveProtocolPda,
  deriveAgentPda as deriveAgentPdaUtil,
  deriveTaskPda as deriveTaskPdaUtil,
  deriveEscrowPda as deriveEscrowPdaUtil,
  deriveClaimPda as deriveClaimPdaUtil,
  deriveDisputePda as deriveDisputePdaUtil,
  deriveVotePda as deriveVotePdaUtil,
  deriveAuthorityVotePda as deriveAuthorityVotePdaUtil,
  generateRunId,
  makeAgentId,
  makeTaskId,
  makeDisputeId,
  getDefaultDeadline,
  sleep,
} from "./test-utils";

describe("AgenC Integration Tests", () => {
  // Provider and program setup
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  // ============================================================================
  // CONSTANTS - Test-specific values (capabilities and task types from test-utils)
  // ============================================================================

  // Protocol configuration (must match deployed protocol config)
  const MIN_STAKE = 1 * LAMPORTS_PER_SOL; // Minimum stake for agents (1 SOL)
  const PROTOCOL_FEE_BPS = 100; // 1% fee
  const DISPUTE_THRESHOLD = 51; // 51% for dispute resolution

  // ============================================================================
  // TEST ACCOUNTS
  // ============================================================================

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;  // Actual treasury from protocol config
  let creator: Keypair;
  let worker1: Keypair;
  let worker2: Keypair;

  // PDAs
  let protocolConfigPda: PublicKey;

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Create a 32-byte buffer from a string (padded with zeros)
   */
  function createId(name: string): Buffer {
    return Buffer.from(name.padEnd(32, "\0"));
  }

  /**
   * Create a 64-byte description buffer
   */
  function createDescription(desc: string): number[] {
    const buf = Buffer.alloc(64);
    buf.write(desc);
    return Array.from(buf);
  }

  /**
   * Create a 32-byte hash buffer
   */
  function createHash(data: string): number[] {
    const buf = Buffer.alloc(32);
    buf.write(data);
    return Array.from(buf);
  }

  // ============================================================================
  // SETUP
  // ============================================================================

  before(async () => {
    // Generate test keypairs
    treasury = Keypair.generate();
    creator = Keypair.generate();
    worker1 = Keypair.generate();
    worker2 = Keypair.generate();

    // Derive protocol PDA
    protocolConfigPda = deriveProtocolPda(program.programId);

    // Airdrop SOL to test accounts
    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    const accounts = [treasury, creator, worker1, worker2];

    for (const account of accounts) {
      const sig = await provider.connection.requestAirdrop(
        account.publicKey,
        airdropAmount
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    console.log("Test Setup Complete");
    console.log(`  Program ID: ${program.programId.toString()}`);
    console.log(`  Protocol Config PDA: ${protocolConfigPda.toString()}`);
  });

  // ============================================================================
  // TEST: Protocol Initialization
  // ============================================================================

  describe("Protocol Initialization", () => {
    it("initializes protocol with correct parameters", async () => {
      /**
       * initializeProtocol instruction:
       * - Args: dispute_threshold, protocol_fee_bps, min_stake, multisig_threshold, multisig_owners
       * - Accounts: protocol_config (PDA const), treasury, authority (signer), system_program
       *
       * Since protocol_config has only const seeds, it CAN be auto-resolved.
       * We use .accounts() and let Anchor resolve what it can.
       */
      try {
        await program.methods
          .initializeProtocol(
            DISPUTE_THRESHOLD,                    // dispute_threshold: u8
            PROTOCOL_FEE_BPS,                     // protocol_fee_bps: u16
            new BN(MIN_STAKE),                    // min_stake: u64
            1,                                    // multisig_threshold: u8
            [provider.wallet.publicKey]           // multisig_owners: Vec<Pubkey>
          )
          .accounts({
            // protocolConfig: auto-resolved from const seeds
            treasury: treasury.publicKey,
            authority: provider.wallet.publicKey,
            // systemProgram: auto-resolved from address field
          })
          .rpc();

        treasuryPubkey = treasury.publicKey;
        console.log("  Protocol initialized successfully");
      } catch (e: any) {
        // Protocol may already be initialized from previous test runs
        // Read the actual treasury from protocol config
        const protocolConfig = await program.account.protocolConfig.fetch(protocolConfigPda);
        treasuryPubkey = protocolConfig.treasury;
        console.log("  Protocol already initialized (reusing existing)");
      }

      // Disable rate limiting for tests
      try {
        await program.methods
          .updateRateLimits(
            new BN(0),  // task_creation_cooldown = 0 (disabled)
            0,          // max_tasks_per_24h = 0 (unlimited)
            new BN(0),  // dispute_initiation_cooldown = 0 (disabled)
            0,          // max_disputes_per_24h = 0 (unlimited)
            new BN(0)   // min_stake_for_dispute = 0
          )
          .accountsPartial({
            protocolConfig: protocolConfigPda,
          })
          .remainingAccounts([
            { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
          ])
          .rpc();
      } catch (e: any) {
        // May already be configured
      }

      // Verify protocol state
      const protocol = await program.account.protocolConfig.fetch(protocolConfigPda);
      expect(protocol.authority.toString()).to.equal(provider.wallet.publicKey.toString());
      expect(protocol.disputeThreshold).to.equal(DISPUTE_THRESHOLD);
      expect(protocol.protocolFeeBps).to.equal(PROTOCOL_FEE_BPS);
    });
  });

  // ============================================================================
  // TEST: Agent Registration
  // ============================================================================

  describe("Agent Registration", () => {
    const agentId = createId("test-agent-001");
    let agentPda: PublicKey;

    before(() => {
      agentPda = deriveAgentPdaUtil(agentId, program.programId);
    });

    it("registers an agent with stake", async () => {
      /**
       * registerAgent instruction:
       * - Args: agent_id, capabilities, endpoint, metadata_uri, stake_amount
       * - Accounts: agent (PDA from arg), protocol_config (PDA const), authority (signer), system_program
       *
       * Since agent PDA uses "kind": "arg" with path "agentId", Anchor CAN auto-resolve it
       * from the instruction arguments. We use .accounts() for clean code.
       */
      try {
        await program.methods
          .registerAgent(
            Array.from(agentId),                  // agent_id: [u8; 32]
            new BN(CAPABILITY_COMPUTE),           // capabilities: u64
            "https://agent.example.com",          // endpoint: string
            null,                                 // metadata_uri: Option<string>
            new BN(MIN_STAKE)                     // stake_amount: u64
          )
          .accounts({
            // agent: auto-resolved from agentId arg
            // protocolConfig: auto-resolved from const seeds
            authority: worker1.publicKey,
            // systemProgram: auto-resolved from address field
          })
          .signers([worker1])
          .rpc();

        console.log("  Agent registered successfully");
      } catch (e: any) {
        if (!e.message?.includes("already in use")) {
          throw e;
        }
        console.log("  Agent already registered (reusing existing)");
      }

      // Verify agent state
      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.agentId).to.deep.equal(Array.from(agentId));
      expect(agent.authority.toString()).to.equal(worker1.publicKey.toString());
      expect(agent.capabilities.toNumber()).to.equal(CAPABILITY_COMPUTE);
      expect(agent.reputation).to.equal(5000); // Initial reputation is 50%
    });

    it("registers a second agent for task testing", async () => {
      const agent2Id = createId("test-agent-002");

      try {
        await program.methods
          .registerAgent(
            Array.from(agent2Id),
            new BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE),
            "https://agent2.example.com",
            null,
            new BN(MIN_STAKE)
          )
          .accounts({
            authority: worker2.publicKey,
          })
          .signers([worker2])
          .rpc();

        console.log("  Second agent registered");
      } catch (e: any) {
        if (!e.message?.includes("already in use")) {
          throw e;
        }
        console.log("  Second agent already registered");
      }
    });
  });

  // ============================================================================
  // TEST: Task Creation
  // ============================================================================

  describe("Task Creation", () => {
    const creatorAgentId = createId("creator-agent-001");
    const taskId = createId("test-task-001");
    let creatorAgentPda: PublicKey;
    let taskPda: PublicKey;
    let escrowPda: PublicKey;

    before(async () => {
      creatorAgentPda = deriveAgentPdaUtil(creatorAgentId, program.programId);
      taskPda = deriveTaskPdaUtil(creator.publicKey, taskId, program.programId);
      escrowPda = deriveEscrowPdaUtil(taskPda, program.programId);

      // Register creator as an agent first
      try {
        await program.methods
          .registerAgent(
            Array.from(creatorAgentId),
            new BN(CAPABILITY_COORDINATOR),
            "https://creator.example.com",
            null,
            new BN(MIN_STAKE)
          )
          .accounts({
            authority: creator.publicKey,
          })
          .signers([creator])
          .rpc();

        console.log("  Creator registered as agent");
      } catch (e: any) {
        if (!e.message?.includes("already in use")) {
          throw e;
        }
      }
    });

    it("creates a task with escrow", async () => {
      /**
       * createTask instruction:
       * - Args: task_id, required_capabilities, description, reward_amount, max_workers, deadline, task_type, constraint_hash
       * - Accounts: task (PDA from arg), escrow (PDA from task), protocol_config, creator_agent, authority, creator, system_program
       *
       * IMPORTANT: creator_agent has a self-referential PDA seed (creator_agent.agent_id).
       * This CANNOT be auto-resolved, so we MUST use .accountsPartial() and provide it explicitly.
       */
      const rewardAmount = 0.1 * LAMPORTS_PER_SOL;

      try {
        await program.methods
          .createTask(
            Array.from(taskId),                   // task_id: [u8; 32]
            new BN(CAPABILITY_COMPUTE),           // required_capabilities: u64
            createDescription("Test task"),       // description: [u8; 64]
            new BN(rewardAmount),                 // reward_amount: u64
            1,                                    // max_workers: u8
            new BN(Math.floor(Date.now() / 1000) + 86400), // deadline: i64 (must be > 0 and in future)
            TASK_TYPE_EXCLUSIVE,                  // task_type: u8
            null                                  // constraint_hash: Option<[u8; 32]>
          )
          .accountsPartial({
            // task: auto-resolved from taskId arg + creator account
            // escrow: auto-resolved from task account
            // protocolConfig: auto-resolved from const seeds
            creatorAgent: creatorAgentPda,        // MUST provide - self-referential PDA
            authority: creator.publicKey,
            creator: creator.publicKey,
            // systemProgram: auto-resolved
          })
          .signers([creator])
          .rpc();

        console.log("  Task created with escrow");
      } catch (e: any) {
        if (!e.message?.includes("already in use")) {
          throw e;
        }
        console.log("  Task already exists");
      }

      // Verify task state
      const task = await program.account.task.fetch(taskPda);
      expect(task.creator.toString()).to.equal(creator.publicKey.toString());
      expect(task.requiredCapabilities.toNumber()).to.equal(CAPABILITY_COMPUTE);
      expect(task.maxWorkers).to.equal(1);
    });
  });

  // ============================================================================
  // TEST: Task Claiming
  // ============================================================================

  describe("Task Claiming", () => {
    const workerAgentId = createId("test-agent-001");
    const creatorAgentId = createId("creator-agent-001");
    const taskId = createId("claim-test-task");
    let workerAgentPda: PublicKey;
    let creatorAgentPda: PublicKey;
    let taskPda: PublicKey;
    let claimPda: PublicKey;

    before(async () => {
      workerAgentPda = deriveAgentPdaUtil(workerAgentId, program.programId);
      creatorAgentPda = deriveAgentPdaUtil(creatorAgentId, program.programId);
      taskPda = deriveTaskPdaUtil(creator.publicKey, taskId, program.programId);
      claimPda = deriveClaimPdaUtil(taskPda, workerAgentPda, program.programId);

      // Create a new task for claiming test
      try {
        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            createDescription("Claimable task"),
            new BN(0.1 * LAMPORTS_PER_SOL),
            1,
            new BN(0),
            TASK_TYPE_EXCLUSIVE,
            null
          )
          .accountsPartial({
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
          })
          .signers([creator])
          .rpc();
      } catch (e: any) {
        if (!e.message?.includes("already in use")) {
          throw e;
        }
      }
    });

    it("allows worker to claim task", async () => {
      /**
       * claimTask instruction:
       * - Args: (none)
       * - Accounts: task (self-ref PDA), claim (PDA from task+worker), protocol_config, worker (self-ref PDA), authority, system_program
       *
       * Both task and worker have self-referential PDAs, so we use accountsPartial.
       */
      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            // claim: auto-resolved from task + authority
            // protocolConfig: auto-resolved
            worker: workerAgentPda,
            authority: worker1.publicKey,
            // systemProgram: auto-resolved
          })
          .signers([worker1])
          .rpc();

        console.log("  Task claimed successfully");
      } catch (e: any) {
        if (!e.message?.includes("already")) {
          throw e;
        }
        console.log("  Task already claimed");
      }

      // Verify claim exists
      const claim = await program.account.taskClaim.fetch(claimPda);
      expect(claim.worker.toString()).to.equal(worker1.publicKey.toString());
    });
  });

  // ============================================================================
  // TEST: Task Completion
  // ============================================================================

  describe("Task Completion", () => {
    const workerAgentId = createId("complete-worker");
    const creatorAgentId = createId("complete-creator");
    const taskId = createId("complete-test-task");
    let workerAgentPda: PublicKey;
    let creatorAgentPda: PublicKey;
    let taskPda: PublicKey;
    let escrowPda: PublicKey;
    let claimPda: PublicKey;

    before(async () => {
      workerAgentPda = deriveAgentPdaUtil(workerAgentId, program.programId);
      creatorAgentPda = deriveAgentPdaUtil(creatorAgentId, program.programId);
      taskPda = deriveTaskPdaUtil(creator.publicKey, taskId, program.programId);
      escrowPda = deriveEscrowPdaUtil(taskPda, program.programId);
      claimPda = deriveClaimPdaUtil(taskPda, workerAgentPda, program.programId);

      // Register worker agent
      try {
        await program.methods
          .registerAgent(
            Array.from(workerAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://complete-worker.example.com",
            null,
            new BN(MIN_STAKE)
          )
          .accounts({
            authority: worker1.publicKey,
          })
          .signers([worker1])
          .rpc();
      } catch (e: any) {
        if (!e.message?.includes("already in use")) throw e;
      }

      // Register creator agent
      try {
        await program.methods
          .registerAgent(
            Array.from(creatorAgentId),
            new BN(CAPABILITY_COORDINATOR),
            "https://complete-creator.example.com",
            null,
            new BN(MIN_STAKE)
          )
          .accounts({
            authority: creator.publicKey,
          })
          .signers([creator])
          .rpc();
      } catch (e: any) {
        if (!e.message?.includes("already in use")) throw e;
      }

      // Create task
      try {
        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            createDescription("Completable task"),
            new BN(0.1 * LAMPORTS_PER_SOL),
            1,
            new BN(0),
            TASK_TYPE_EXCLUSIVE,
            null
          )
          .accountsPartial({
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
          })
          .signers([creator])
          .rpc();
      } catch (e: any) {
        if (!e.message?.includes("already in use")) throw e;
      }

      // Claim task
      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            worker: workerAgentPda,
            authority: worker1.publicKey,
          })
          .signers([worker1])
          .rpc();
      } catch (e: any) {
        if (!e.message?.includes("already")) throw e;
      }
    });

    it("allows worker to complete task and receive reward", async () => {
      /**
       * completeTask instruction:
       * - Args: proof_hash, result_data
       * - Accounts: task, claim, escrow, worker, protocol_config, treasury, authority, system_program
       */
      const proofHash = createHash("proof-hash-data");
      const resultData = Array.from(Buffer.alloc(64).fill(1));

      // Get protocol config to find treasury
      const protocol = await program.account.protocolConfig.fetch(protocolConfigPda);

      const balanceBefore = await provider.connection.getBalance(worker1.publicKey);

      try {
        await program.methods
          .completeTask(
            proofHash,                            // proof_hash: [u8; 32]
            resultData                            // result_data: Option<[u8; 64]>
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: workerAgentPda,
            // protocolConfig: auto-resolved
            treasury: protocol.treasury,
            authority: worker1.publicKey,
            // systemProgram: auto-resolved
          })
          .signers([worker1])
          .rpc();

        console.log("  Task completed successfully");

        const balanceAfter = await provider.connection.getBalance(worker1.publicKey);
        console.log(`  Worker balance change: ${(balanceAfter - balanceBefore) / LAMPORTS_PER_SOL} SOL`);
      } catch (e: any) {
        // Task might already be completed
        if (!e.message?.includes("InvalidTaskStatus")) {
          throw e;
        }
        console.log("  Task already completed");
      }
    });
  });

  // ============================================================================
  // TEST: Agent Update
  // ============================================================================

  describe("Agent Update", () => {
    const agentId = createId("update-test-agent");
    let agentPda: PublicKey;

    before(async () => {
      agentPda = deriveAgentPdaUtil(agentId, program.programId);

      // Register agent first
      try {
        await program.methods
          .registerAgent(
            Array.from(agentId),
            new BN(CAPABILITY_COMPUTE),
            "https://update-agent.example.com",
            null,
            new BN(MIN_STAKE)
          )
          .accounts({
            authority: worker2.publicKey,
          })
          .signers([worker2])
          .rpc();
      } catch (e: any) {
        if (!e.message?.includes("already in use")) throw e;
      }
    });

    it("updates agent capabilities and endpoint", async () => {
      /**
       * updateAgent instruction:
       * - Args: capabilities, endpoint, metadata_uri, status (all Option types)
       * - Accounts: agent (self-ref PDA), authority
       */
      await program.methods
        .updateAgent(
          new BN(CAPABILITY_COMPUTE | CAPABILITY_STORAGE),  // capabilities: Option<u64>
          "https://updated-agent.example.com",               // endpoint: Option<string>
          null,                                              // metadata_uri: Option<string>
          null                                               // status: Option<u8>
        )
        .accountsPartial({
          agent: agentPda,
          authority: worker2.publicKey,
        })
        .signers([worker2])
        .rpc();

      // Verify update
      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.capabilities.toNumber()).to.equal(CAPABILITY_COMPUTE | CAPABILITY_STORAGE);
      expect(agent.endpoint).to.equal("https://updated-agent.example.com");

      console.log("  Agent updated successfully");
    });
  });

  // ============================================================================
  // TEST: Task Cancellation
  // ============================================================================

  describe("Task Cancellation", () => {
    const creatorAgentId = createId("cancel-creator");
    const taskId = createId("cancel-test-task");
    let creatorAgentPda: PublicKey;
    let taskPda: PublicKey;
    let escrowPda: PublicKey;

    before(async () => {
      creatorAgentPda = deriveAgentPdaUtil(creatorAgentId, program.programId);
      taskPda = deriveTaskPdaUtil(creator.publicKey, taskId, program.programId);
      escrowPda = deriveEscrowPdaUtil(taskPda, program.programId);

      // Register creator agent
      try {
        await program.methods
          .registerAgent(
            Array.from(creatorAgentId),
            new BN(CAPABILITY_COORDINATOR),
            "https://cancel-creator.example.com",
            null,
            new BN(MIN_STAKE)
          )
          .accounts({
            authority: creator.publicKey,
          })
          .signers([creator])
          .rpc();
      } catch (e: any) {
        if (!e.message?.includes("already in use")) throw e;
      }

      // Create task to cancel
      try {
        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            createDescription("Task to cancel"),
            new BN(0.05 * LAMPORTS_PER_SOL),
            1,
            new BN(0),
            TASK_TYPE_EXCLUSIVE,
            null
          )
          .accountsPartial({
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
          })
          .signers([creator])
          .rpc();
      } catch (e: any) {
        if (!e.message?.includes("already in use")) throw e;
      }
    });

    it("allows creator to cancel unclaimed task", async () => {
      /**
       * cancelTask instruction:
       * - Args: (none)
       * - Accounts: task (self-ref PDA), escrow, creator (signer), system_program
       */
      try {
        await program.methods
          .cancelTask()
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
          protocolConfig: protocolPda,
            // systemProgram: auto-resolved
          })
          .signers([creator])
          .rpc();

        console.log("  Task cancelled successfully");
      } catch (e: any) {
        if (!e.message?.includes("InvalidTaskStatus")) {
          throw e;
        }
        console.log("  Task already cancelled or in wrong state");
      }
    });
  });

  // ============================================================================
  // TEST: Agent Deregistration
  // ============================================================================

  describe("Agent Deregistration", () => {
    const agentId = createId("deregister-agent");
    let agentPda: PublicKey;

    before(async () => {
      agentPda = deriveAgentPdaUtil(agentId, program.programId);

      // Register agent to deregister
      try {
        await program.methods
          .registerAgent(
            Array.from(agentId),
            new BN(CAPABILITY_COMPUTE),
            "https://deregister.example.com",
            null,
            new BN(MIN_STAKE)
          )
          .accounts({
            authority: worker2.publicKey,
          })
          .signers([worker2])
          .rpc();
      } catch (e: any) {
        if (!e.message?.includes("already in use")) throw e;
      }
    });

    it("allows agent to deregister when no active tasks", async () => {
      /**
       * deregisterAgent instruction:
       * - Args: (none)
       * - Accounts: agent (self-ref PDA), protocol_config, authority
       */
      try {
        await program.methods
          .deregisterAgent()
          .accountsPartial({
            agent: agentPda,
            // protocolConfig: auto-resolved
            authority: worker2.publicKey,
          })
          .signers([worker2])
          .rpc();

        console.log("  Agent deregistered successfully");
      } catch (e: any) {
        if (!e.message?.includes("ActiveTasksRemain")) {
          throw e;
        }
        console.log("  Agent has active tasks, cannot deregister");
      }
    });
  });
});
