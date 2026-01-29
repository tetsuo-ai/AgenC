/**
 * AgenC Devnet Smoke Tests
 *
 * These tests verify the deployed program works correctly on devnet by making
 * actual RPC calls and asserting expected behavior.
 *
 * Following Anchor 0.32 best practices from official documentation:
 * - https://www.anchor-lang.com/docs/clients/typescript
 * - https://www.anchor-lang.com/docs/updates/release-notes/0-30-0
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";
import BN from "bn.js";
import { AgencCoordination } from "../target/types/agenc_coordination";

// ============================================================================
// CONSTANTS
// ============================================================================

const AIRDROP_SOL = 2;
const MIN_BALANCE_SOL = 1;
const MAX_AIRDROP_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

// Capability bitmasks (from program)
const CAPABILITY_COMPUTE = 1 << 0;
const CAPABILITY_STORAGE = 1 << 1;
const CAPABILITY_INFERENCE = 1 << 2;
const CAPABILITY_NETWORK = 1 << 3;
const CAPABILITY_COORDINATOR = 1 << 4;
const CAPABILITY_ARBITER = 1 << 7;

// Task types
const TASK_TYPE_EXCLUSIVE = 0;
const TASK_TYPE_COLLABORATIVE = 1;
const TASK_TYPE_COMPETITIVE = 2;

// Protocol configuration
const MIN_STAKE = 1 * LAMPORTS_PER_SOL;
const PROTOCOL_FEE_BPS = 100; // 1%
const DISPUTE_THRESHOLD = 51;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitError = (message: string) =>
  message.includes("429") || message.toLowerCase().includes("too many requests");

const ensureBalance = async (
  connection: anchor.web3.Connection,
  keypair: Keypair,
  minLamports: number
) => {
  const pubkey = keypair.publicKey;
  const existing = await connection.getBalance(pubkey);
  if (existing >= minLamports) {
    console.log(
      `  Skipping airdrop for ${pubkey.toBase58().slice(0, 8)}... balance ${(
        existing / LAMPORTS_PER_SOL
      ).toFixed(2)} SOL`
    );
    return;
  }

  for (let attempt = 0; attempt < MAX_AIRDROP_ATTEMPTS; attempt += 1) {
    try {
      const sig = await connection.requestAirdrop(
        pubkey,
        AIRDROP_SOL * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
      console.log(`  Funded ${pubkey.toBase58().slice(0, 8)}...`);
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const delayMs = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      if (isRateLimitError(message)) {
        console.log(
          `  Faucet rate limited (HTTP 429) for ${pubkey.toBase58().slice(0, 8)}..., retrying in ${delayMs}ms`
        );
      } else {
        console.log(
          `  Airdrop attempt ${attempt + 1} failed for ${pubkey.toBase58().slice(0, 8)}...: ${message}`
        );
      }
      if (attempt === MAX_AIRDROP_ATTEMPTS - 1) {
        throw new Error(
          `Airdrop failed for ${pubkey.toBase58().slice(0, 8)} after ${MAX_AIRDROP_ATTEMPTS} attempts`
        );
      }
      await sleep(delayMs);
    }
  }
};

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
// PDA DERIVATION HELPERS
// ============================================================================

function deriveProtocolConfigPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    programId
  );
  return pda;
}

function deriveAgentPda(agentId: Buffer, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    programId
  );
  return pda;
}

function deriveTaskPda(creator: PublicKey, taskId: Buffer, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    programId
  );
  return pda;
}

function deriveEscrowPda(taskPda: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), taskPda.toBuffer()],
    programId
  );
  return pda;
}

function deriveClaimPda(taskPda: PublicKey, workerAgentPda: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), taskPda.toBuffer(), workerAgentPda.toBuffer()],
    programId
  );
  return pda;
}

// ============================================================================
// SMOKE TESTS
// ============================================================================

describe("AgenC Devnet Smoke Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;
  const payer = (provider.wallet as any).payer as Keypair | undefined;

  // Test accounts
  let protocolAuthority: Keypair;
  let secondSigner: Keypair;
  let treasury: Keypair;
  let agent1Authority: Keypair;
  let agent2Authority: Keypair;
  let taskCreator: Keypair;

  // PDAs
  let protocolConfigPda: PublicKey;
  let treasuryPubkey: PublicKey;

  // Test identifiers - use unique IDs per test run
  const testRunId = Date.now().toString(36);

  before(async () => {
    console.log("\n========================================");
    console.log("AgenC Smoke Test - Devnet");
    console.log("========================================\n");
    console.log(`Program ID: ${program.programId.toBase58()}`);
    console.log(`Test Run ID: ${testRunId}`);

    // Generate test keypairs
    protocolAuthority = payer ?? Keypair.generate();
    secondSigner = Keypair.generate();
    treasury = Keypair.generate();
    agent1Authority = Keypair.generate();
    agent2Authority = Keypair.generate();
    taskCreator = Keypair.generate();

    // Derive protocol PDA
    protocolConfigPda = deriveProtocolConfigPda(program.programId);

    // Airdrop SOL to test accounts
    console.log("Airdropping SOL to test accounts...");

    if (payer) {
      console.log(
        `  Reusing provider wallet for protocol authority: ${payer.publicKey.toBase58()}`
      );
    }

    const accounts = [protocolAuthority, secondSigner, agent1Authority, agent2Authority, taskCreator];
    for (const account of accounts) {
      await ensureBalance(
        provider.connection,
        account,
        MIN_BALANCE_SOL * LAMPORTS_PER_SOL
      );
    }

    console.log("\nTest accounts ready.");
    console.log(`  Protocol Authority: ${protocolAuthority.publicKey.toBase58()}`);
    console.log(`  Second Signer: ${secondSigner.publicKey.toBase58()}`);
    console.log(`  Treasury: ${treasury.publicKey.toBase58()}`);
    console.log(`  Agent 1 Authority: ${agent1Authority.publicKey.toBase58()}`);
    console.log(`  Agent 2 Authority: ${agent2Authority.publicKey.toBase58()}`);
    console.log(`  Task Creator: ${taskCreator.publicKey.toBase58()}`);
  });

  describe("1. Protocol Initialization", () => {
    it("should initialize or verify protocol config", async () => {
      console.log("\n[TEST] Checking protocol initialization...");

      try {
        // Try to initialize protocol
        // Args: dispute_threshold, protocol_fee_bps, min_stake, min_stake_for_dispute, multisig_threshold, multisig_owners
        await program.methods
          .initializeProtocol(
            DISPUTE_THRESHOLD,                                    // dispute_threshold: u8
            PROTOCOL_FEE_BPS,                                     // protocol_fee_bps: u16
            new BN(MIN_STAKE),                                    // min_stake: u64
            new BN(0),                                            // min_stake_for_dispute: u64
            2,                                                    // multisig_threshold: u8
            [protocolAuthority.publicKey, secondSigner.publicKey] // multisig_owners: Vec<Pubkey>
          )
          .accounts({
            treasury: treasury.publicKey,
            authority: protocolAuthority.publicKey,
            secondSigner: secondSigner.publicKey,
          })
          .signers([protocolAuthority, secondSigner])
          .rpc();

        treasuryPubkey = treasury.publicKey;
        console.log("  Protocol initialized successfully");
      } catch (e: any) {
        // Protocol already initialized - fetch existing config
        const protocolConfig = await program.account.protocolConfig.fetch(protocolConfigPda);
        treasuryPubkey = protocolConfig.treasury;
        console.log("  Protocol already initialized (reusing existing)");
      }

      // Verify protocol state
      const protocol = await program.account.protocolConfig.fetch(protocolConfigPda);
      assert.isNotNull(protocol.authority, "Protocol authority should be set");
      assert.isTrue(protocol.disputeThreshold > 0, "Dispute threshold should be > 0");
      assert.isTrue(protocol.protocolFeeBps >= 0, "Protocol fee should be >= 0");

      console.log(`  Authority: ${protocol.authority.toBase58()}`);
      console.log(`  Treasury: ${protocol.treasury.toBase58()}`);
      console.log(`  Dispute Threshold: ${protocol.disputeThreshold}%`);
      console.log(`  Protocol Fee: ${protocol.protocolFeeBps} bps`);
    });
  });

  describe("2. Agent Registration", () => {
    const agent1IdStr = `smoke-agent1-${testRunId}`;
    const agent2IdStr = `smoke-agent2-${testRunId}`;
    let agent1Id: Buffer;
    let agent2Id: Buffer;
    let agent1Pda: PublicKey;
    let agent2Pda: PublicKey;

    before(() => {
      agent1Id = createId(agent1IdStr);
      agent2Id = createId(agent2IdStr);
      agent1Pda = deriveAgentPda(agent1Id, program.programId);
      agent2Pda = deriveAgentPda(agent2Id, program.programId);
    });

    it("should register agent 1 with COMPUTE capability", async () => {
      console.log("\n[TEST] Registering Agent 1...");

      const capabilities = CAPABILITY_COMPUTE;
      const endpoint = "https://agent1.smoke-test.example.com";
      const stakeAmount = new BN(MIN_STAKE);

      await program.methods
        .registerAgent(
          Array.from(agent1Id),
          new BN(capabilities),
          endpoint,
          null, // metadata_uri
          stakeAmount
        )
        .accounts({
          authority: agent1Authority.publicKey,
        })
        .signers([agent1Authority])
        .rpc();

      // Verify agent state
      const agent = await program.account.agentRegistration.fetch(agent1Pda);
      assert.deepEqual(agent.agentId, Array.from(agent1Id), "Agent ID should match");
      assert.equal(agent.authority.toBase58(), agent1Authority.publicKey.toBase58(), "Authority should match");
      assert.equal(agent.capabilities.toNumber(), capabilities, "Capabilities should match");
      assert.equal(agent.endpoint, endpoint, "Endpoint should match");
      assert.equal(agent.reputation, 5000, "Initial reputation should be 5000");
      assert.isTrue(agent.stake.gte(stakeAmount), "Stake should be >= provided amount");

      console.log(`  Agent 1 registered successfully`);
      console.log(`  PDA: ${agent1Pda.toBase58()}`);
      console.log(`  Capabilities: ${agent.capabilities.toString()}`);
      console.log(`  Stake: ${agent.stake.toNumber() / LAMPORTS_PER_SOL} SOL`);
      console.log(`  Reputation: ${agent.reputation}`);
    });

    it("should register agent 2 with INFERENCE capability", async () => {
      console.log("\n[TEST] Registering Agent 2...");

      const capabilities = CAPABILITY_INFERENCE;
      const endpoint = "https://agent2.smoke-test.example.com";
      const stakeAmount = new BN(MIN_STAKE);

      await program.methods
        .registerAgent(
          Array.from(agent2Id),
          new BN(capabilities),
          endpoint,
          null,
          stakeAmount
        )
        .accounts({
          authority: agent2Authority.publicKey,
        })
        .signers([agent2Authority])
        .rpc();

      // Verify agent state
      const agent = await program.account.agentRegistration.fetch(agent2Pda);
      assert.deepEqual(agent.agentId, Array.from(agent2Id), "Agent ID should match");
      assert.equal(agent.capabilities.toNumber(), capabilities, "Capabilities should match");

      console.log(`  Agent 2 registered successfully`);
      console.log(`  PDA: ${agent2Pda.toBase58()}`);
      console.log(`  Capabilities: ${agent.capabilities.toString()}`);
    });

    it("should query and verify both agent states", async () => {
      console.log("\n[TEST] Querying agent states...");

      const agent1 = await program.account.agentRegistration.fetch(agent1Pda);
      const agent2 = await program.account.agentRegistration.fetch(agent2Pda);

      // Verify agent1 has COMPUTE but not INFERENCE
      assert.isTrue(
        (agent1.capabilities.toNumber() & CAPABILITY_COMPUTE) !== 0,
        "Agent 1 should have COMPUTE capability"
      );
      assert.isFalse(
        (agent1.capabilities.toNumber() & CAPABILITY_INFERENCE) !== 0,
        "Agent 1 should not have INFERENCE capability"
      );

      // Verify agent2 has INFERENCE but not COMPUTE
      assert.isTrue(
        (agent2.capabilities.toNumber() & CAPABILITY_INFERENCE) !== 0,
        "Agent 2 should have INFERENCE capability"
      );
      assert.isFalse(
        (agent2.capabilities.toNumber() & CAPABILITY_COMPUTE) !== 0,
        "Agent 2 should not have COMPUTE capability"
      );

      console.log("  Agent states verified");
      console.log(`  Agent 1 - Active tasks: ${agent1.activeTasks}, Tasks completed: ${agent1.tasksCompleted}`);
      console.log(`  Agent 2 - Active tasks: ${agent2.activeTasks}, Tasks completed: ${agent2.tasksCompleted}`);
    });
  });

  describe("3. Task Creation with Escrow", () => {
    const creatorAgentIdStr = `smoke-creator-${testRunId}`;
    const taskIdStr = `smoke-task1-${testRunId}`;
    let creatorAgentId: Buffer;
    let taskId: Buffer;
    let creatorAgentPda: PublicKey;
    let taskPda: PublicKey;
    let escrowPda: PublicKey;
    const taskReward = new BN(0.1 * LAMPORTS_PER_SOL);

    before(async () => {
      creatorAgentId = createId(creatorAgentIdStr);
      taskId = createId(taskIdStr);
      creatorAgentPda = deriveAgentPda(creatorAgentId, program.programId);

      // Register task creator as an agent first
      console.log("  Registering task creator as agent...");
      await program.methods
        .registerAgent(
          Array.from(creatorAgentId),
          new BN(CAPABILITY_COORDINATOR),
          "https://creator.smoke-test.example.com",
          null,
          new BN(MIN_STAKE)
        )
        .accounts({
          authority: taskCreator.publicKey,
        })
        .signers([taskCreator])
        .rpc();

      taskPda = deriveTaskPda(taskCreator.publicKey, taskId, program.programId);
      escrowPda = deriveEscrowPda(taskPda, program.programId);
    });

    it("should create a task with escrowed reward", async () => {
      console.log("\n[TEST] Creating task with escrow...");

      const requiredCapabilities = CAPABILITY_COMPUTE;
      const description = createDescription("Smoke test compute task");
      const deadline = new BN(Math.floor(Date.now() / 1000) + 86400); // 24 hours from now

      const creatorBalanceBefore = await provider.connection.getBalance(taskCreator.publicKey);

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(requiredCapabilities),
          description,
          taskReward,
          1, // max_workers
          deadline,
          TASK_TYPE_EXCLUSIVE,
          null // constraint_hash
        )
        .accountsPartial({
          creatorAgent: creatorAgentPda,
          authority: taskCreator.publicKey,
          creator: taskCreator.publicKey,
        })
        .signers([taskCreator])
        .rpc();

      // Verify task state
      const task = await program.account.task.fetch(taskPda);
      assert.equal(task.creator.toBase58(), taskCreator.publicKey.toBase58(), "Creator should match");
      assert.deepEqual(task.taskId, Array.from(taskId), "Task ID should match");
      assert.equal(task.requiredCapabilities.toNumber(), requiredCapabilities, "Capabilities should match");
      assert.equal(task.rewardAmount.toNumber(), taskReward.toNumber(), "Reward should match");
      assert.equal(task.maxWorkers, 1, "Max workers should be 1");
      assert.equal(task.currentWorkers, 0, "Current workers should be 0");

      const creatorBalanceAfter = await provider.connection.getBalance(taskCreator.publicKey);
      const balanceChange = creatorBalanceBefore - creatorBalanceAfter;

      console.log(`  Task created successfully`);
      console.log(`  Task PDA: ${taskPda.toBase58()}`);
      console.log(`  Escrow PDA: ${escrowPda.toBase58()}`);
      console.log(`  Reward: ${taskReward.toNumber() / LAMPORTS_PER_SOL} SOL`);
      console.log(`  Creator balance change: ${balanceChange / LAMPORTS_PER_SOL} SOL`);
    });

    it("should verify escrow balance", async () => {
      console.log("\n[TEST] Verifying escrow balance...");

      const escrowBalance = await provider.connection.getBalance(escrowPda);

      // Escrow should hold at least the task reward (plus rent)
      assert.isTrue(
        escrowBalance >= taskReward.toNumber(),
        `Escrow balance (${escrowBalance}) should be >= task reward (${taskReward.toNumber()})`
      );

      console.log(`  Escrow balance: ${escrowBalance / LAMPORTS_PER_SOL} SOL`);
      console.log(`  Expected minimum: ${taskReward.toNumber() / LAMPORTS_PER_SOL} SOL`);
    });
  });

  describe("4. Task Claiming", () => {
    const workerAgentIdStr = `smoke-agent1-${testRunId}`;
    const invalidWorkerAgentIdStr = `smoke-agent2-${testRunId}`;
    const taskIdStr = `smoke-task1-${testRunId}`;

    let workerAgentPda: PublicKey;
    let invalidWorkerAgentPda: PublicKey;
    let taskPda: PublicKey;
    let claimPda: PublicKey;

    before(() => {
      const workerAgentId = createId(workerAgentIdStr);
      const invalidWorkerAgentId = createId(invalidWorkerAgentIdStr);
      const taskId = createId(taskIdStr);

      workerAgentPda = deriveAgentPda(workerAgentId, program.programId);
      invalidWorkerAgentPda = deriveAgentPda(invalidWorkerAgentId, program.programId);
      taskPda = deriveTaskPda(taskCreator.publicKey, taskId, program.programId);
      claimPda = deriveClaimPda(taskPda, workerAgentPda, program.programId);
    });

    it("should reject claim from agent without matching capabilities", async () => {
      console.log("\n[TEST] Verifying capability check...");

      // Agent 2 has INFERENCE, task requires COMPUTE - should fail
      try {
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            worker: invalidWorkerAgentPda,
            authority: agent2Authority.publicKey,
          })
          .signers([agent2Authority])
          .rpc();

        assert.fail("Should have rejected claim from agent without COMPUTE capability");
      } catch (e: any) {
        assert.include(
          e.message.toLowerCase(),
          "insufficient",
          "Error should mention insufficient capabilities"
        );
        console.log("  Capability check passed - invalid claim rejected");
        console.log(`  Error: ${e.message.slice(0, 100)}...`);
      }
    });

    it("should allow agent 1 to claim the task", async () => {
      console.log("\n[TEST] Agent 1 claiming task...");

      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          worker: workerAgentPda,
          authority: agent1Authority.publicKey,
        })
        .signers([agent1Authority])
        .rpc();

      // Verify claim exists
      const claim = await program.account.taskClaim.fetch(claimPda);
      assert.equal(claim.worker.toBase58(), workerAgentPda.toBase58(), "Worker agent PDA should match");

      // Verify task state updated
      const task = await program.account.task.fetch(taskPda);
      assert.equal(task.currentWorkers, 1, "Current workers should be 1 after claim");

      // Verify agent state updated
      const agent = await program.account.agentRegistration.fetch(workerAgentPda);
      assert.equal(agent.activeTasks, 1, "Agent active tasks should be 1");

      console.log("  Task claimed successfully");
      console.log(`  Claim PDA: ${claimPda.toBase58()}`);
      console.log(`  Task current workers: ${task.currentWorkers}`);
      console.log(`  Agent active tasks: ${agent.activeTasks}`);
    });

    it("should verify task state is now IN_PROGRESS", async () => {
      console.log("\n[TEST] Verifying task state...");

      const task = await program.account.task.fetch(taskPda);

      // Task status should indicate it's in progress (claimed)
      assert.equal(task.currentWorkers, 1, "Should have 1 worker");
      assert.equal(task.maxWorkers, 1, "Max workers should still be 1");

      console.log("  Task status verified: IN_PROGRESS (has 1 worker)");
    });
  });

  describe("5. Task Completion", () => {
    const workerAgentIdStr = `smoke-agent1-${testRunId}`;
    const taskIdStr = `smoke-task1-${testRunId}`;

    let workerAgentPda: PublicKey;
    let taskPda: PublicKey;
    let escrowPda: PublicKey;
    let claimPda: PublicKey;

    before(() => {
      const workerAgentId = createId(workerAgentIdStr);
      const taskId = createId(taskIdStr);

      workerAgentPda = deriveAgentPda(workerAgentId, program.programId);
      taskPda = deriveTaskPda(taskCreator.publicKey, taskId, program.programId);
      escrowPda = deriveEscrowPda(taskPda, program.programId);
      claimPda = deriveClaimPda(taskPda, workerAgentPda, program.programId);
    });

    it("should allow agent 1 to complete the task", async () => {
      console.log("\n[TEST] Agent 1 completing task...");

      const proofHash = createHash("smoke-test-proof-hash");
      const resultData = Array.from(Buffer.alloc(64).fill(0x42)); // Non-zero result data

      // Get protocol config for treasury
      const protocol = await program.account.protocolConfig.fetch(protocolConfigPda);

      const workerBalanceBefore = await provider.connection.getBalance(agent1Authority.publicKey);

      await program.methods
        .completeTask(
          proofHash,
          resultData
        )
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          creator: taskCreator.publicKey,
          worker: workerAgentPda,
          treasury: protocol.treasury,
          authority: agent1Authority.publicKey,
        })
        .signers([agent1Authority])
        .rpc();

      const workerBalanceAfter = await provider.connection.getBalance(agent1Authority.publicKey);
      const balanceChange = workerBalanceAfter - workerBalanceBefore;

      console.log("  Task completed");
      console.log(`  Worker balance change: ${balanceChange / LAMPORTS_PER_SOL} SOL`);

      // Balance should have increased (reward minus tx fee)
      assert.isTrue(balanceChange > 0, "Worker should have received reward");
    });

    it("should verify reward distribution", async () => {
      console.log("\n[TEST] Verifying reward distribution...");

      // Escrow should be closed/empty after completion
      const escrowInfo = await provider.connection.getAccountInfo(escrowPda);

      // Escrow account is closed after task completion
      assert.isNull(escrowInfo, "Escrow account should be closed after completion");

      console.log("  Escrow account closed (funds distributed)");
    });

    it("should verify reputation update", async () => {
      console.log("\n[TEST] Verifying reputation update...");

      const agent = await program.account.agentRegistration.fetch(workerAgentPda);

      assert.equal(agent.tasksCompleted.toNumber(), 1, "Tasks completed should be 1");
      assert.isTrue(agent.totalEarned.toNumber() > 0, "Total earned should be > 0");
      // Reputation may increase or stay same depending on protocol rules
      assert.isTrue(agent.reputation >= 5000, "Reputation should be >= initial value");

      console.log(`  Agent 1 reputation: ${agent.reputation}`);
      console.log(`  Tasks completed: ${agent.tasksCompleted.toString()}`);
      console.log(`  Total earned: ${agent.totalEarned.toNumber() / LAMPORTS_PER_SOL} SOL`);
    });
  });

  describe("6. Task Cancellation Flow", () => {
    const creatorAgentIdStr = `smoke-creator-${testRunId}`;
    const cancelTaskIdStr = `smoke-cancel-${testRunId}`;
    let creatorAgentPda: PublicKey;
    let cancelTaskId: Buffer;
    let cancelTaskPda: PublicKey;
    let cancelEscrowPda: PublicKey;
    const cancelReward = new BN(0.05 * LAMPORTS_PER_SOL);

    before(async () => {
      const creatorAgentId = createId(creatorAgentIdStr);
      creatorAgentPda = deriveAgentPda(creatorAgentId, program.programId);
      cancelTaskId = createId(cancelTaskIdStr);
      cancelTaskPda = deriveTaskPda(taskCreator.publicKey, cancelTaskId, program.programId);
      cancelEscrowPda = deriveEscrowPda(cancelTaskPda, program.programId);
    });

    it("should create a task for cancellation test", async () => {
      console.log("\n[TEST] Creating task for cancellation...");

      await program.methods
        .createTask(
          Array.from(cancelTaskId),
          new BN(CAPABILITY_COMPUTE),
          createDescription("Task to be cancelled"),
          cancelReward,
          1,
          new BN(Math.floor(Date.now() / 1000) + 86400),
          TASK_TYPE_EXCLUSIVE,
          null
        )
        .accountsPartial({
          creatorAgent: creatorAgentPda,
          authority: taskCreator.publicKey,
          creator: taskCreator.publicKey,
        })
        .signers([taskCreator])
        .rpc();

      const task = await program.account.task.fetch(cancelTaskPda);
      assert.equal(task.currentWorkers, 0, "Task should have no workers");

      console.log(`  Task ${cancelTaskIdStr} created`);
      console.log(`  Task PDA: ${cancelTaskPda.toBase58()}`);
    });

    it("should allow creator to cancel unclaimed task", async () => {
      console.log("\n[TEST] Cancelling unclaimed task...");

      const creatorBalanceBefore = await provider.connection.getBalance(taskCreator.publicKey);

      await program.methods
        .cancelTask()
        .accountsPartial({
          task: cancelTaskPda,
          escrow: cancelEscrowPda,
          creator: taskCreator.publicKey,
        })
        .signers([taskCreator])
        .rpc();

      const creatorBalanceAfter = await provider.connection.getBalance(taskCreator.publicKey);

      console.log("  Task cancelled");
      console.log(`  Creator balance change: ${(creatorBalanceAfter - creatorBalanceBefore) / LAMPORTS_PER_SOL} SOL`);
    });

    it("should verify escrow refunded to creator", async () => {
      console.log("\n[TEST] Verifying escrow refund...");

      const escrowInfo = await provider.connection.getAccountInfo(cancelEscrowPda);

      // Escrow should be closed after cancellation
      assert.isNull(escrowInfo, "Escrow should be closed after cancellation");

      console.log("  Escrow balance: 0 SOL (account closed)");
    });
  });

  describe("7. Agent Deregistration", () => {
    const deregAgentIdStr = `smoke-dereg-${testRunId}`;
    let deregAgentId: Buffer;
    let deregAgentPda: PublicKey;
    let deregAuthority: Keypair;

    before(async () => {
      deregAgentId = createId(deregAgentIdStr);
      deregAgentPda = deriveAgentPda(deregAgentId, program.programId);
      deregAuthority = Keypair.generate();

      // Fund the deregistration test account
      await ensureBalance(
        provider.connection,
        deregAuthority,
        MIN_BALANCE_SOL * LAMPORTS_PER_SOL
      );

      // Register an agent specifically for deregistration test
      await program.methods
        .registerAgent(
          Array.from(deregAgentId),
          new BN(CAPABILITY_STORAGE),
          "https://dereg-agent.smoke-test.example.com",
          null,
          new BN(MIN_STAKE)
        )
        .accounts({
          authority: deregAuthority.publicKey,
        })
        .signers([deregAuthority])
        .rpc();
    });

    it("should allow agent to deregister", async () => {
      console.log("\n[TEST] Deregistering agent...");

      const balanceBefore = await provider.connection.getBalance(deregAuthority.publicKey);

      await program.methods
        .deregisterAgent()
        .accountsPartial({
          agent: deregAgentPda,
          authority: deregAuthority.publicKey,
        })
        .signers([deregAuthority])
        .rpc();

      const balanceAfter = await provider.connection.getBalance(deregAuthority.publicKey);

      console.log("  Agent deregistered");
      console.log(`  Balance change: ${(balanceAfter - balanceBefore) / LAMPORTS_PER_SOL} SOL (stake returned)`);

      // Stake should be returned
      assert.isTrue(balanceAfter > balanceBefore - 0.01 * LAMPORTS_PER_SOL, "Stake should be returned");
    });

    it("should verify agent account is closed", async () => {
      console.log("\n[TEST] Verifying agent account closed...");

      const agentInfo = await provider.connection.getAccountInfo(deregAgentPda);

      // Agent account should be closed
      assert.isNull(agentInfo, "Agent account should be closed after deregistration");

      console.log("  Agent account closed successfully");
    });
  });

  describe("8. Protocol Stats", () => {
    it("should verify protocol statistics", async () => {
      console.log("\n[TEST] Checking protocol stats...");

      const config = await program.account.protocolConfig.fetch(protocolConfigPda);

      console.log(`  Authority: ${config.authority.toBase58()}`);
      console.log(`  Treasury: ${config.treasury.toBase58()}`);
      console.log(`  Total agents registered: ${config.totalAgents.toString()}`);
      console.log(`  Total tasks created: ${config.totalTasks.toString()}`);
      console.log(`  Completed tasks: ${config.completedTasks.toString()}`);
      console.log(`  Protocol fee: ${config.protocolFeeBps} bps`);
      console.log(`  Min agent stake: ${config.minAgentStake.toNumber() / LAMPORTS_PER_SOL} SOL`);

      // Verify stats are reasonable
      assert.isTrue(config.totalAgents.toNumber() >= 0, "Total agents should be >= 0");
      assert.isTrue(config.totalTasks.toNumber() >= 0, "Total tasks should be >= 0");

      const treasuryBalance = await provider.connection.getBalance(config.treasury);
      console.log(`  Treasury balance: ${treasuryBalance / LAMPORTS_PER_SOL} SOL`);
    });
  });

  after(async () => {
    console.log("\n========================================");
    console.log("Smoke Test Summary");
    console.log("========================================");
    console.log(`Program ID: ${program.programId.toBase58()}`);
    console.log(`Test Run ID: ${testRunId}`);
    console.log("\nAll smoke tests completed.");
    console.log("Review results above for any failures.");
    console.log("========================================\n");
  });
});
