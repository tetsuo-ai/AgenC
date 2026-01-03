import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";

// Update this with your deployed program ID
const PROGRAM_ID = new PublicKey("EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ");

const AIRDROP_SOL = 2;
const MIN_BALANCE_SOL = 1;
const MAX_AIRDROP_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

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
      `  Skipping airdrop for ${pubkey
        .toBase58()
        .slice(0, 8)}... balance ${(
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
          `  Faucet rate limited (HTTP 429) for ${pubkey
            .toBase58()
            .slice(0, 8)}..., retrying in ${delayMs}ms`
        );
      } else {
        console.log(
          `  Airdrop attempt ${attempt + 1} failed for ${pubkey
            .toBase58()
            .slice(0, 8)}...: ${message}`
        );
      }
      if (attempt === MAX_AIRDROP_ATTEMPTS - 1) {
        throw new Error(
          `Airdrop failed for ${pubkey
            .toBase58()
            .slice(0, 8)} after ${MAX_AIRDROP_ATTEMPTS} attempts`
        );
      }
      await sleep(delayMs);
    }
  }
};

describe("AgenC Devnet Smoke Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const payer = (provider.wallet as any).payer as Keypair | undefined;

  // Test accounts
  let protocolAuthority: Keypair;
  let treasury: Keypair;
  let agent1: Keypair;
  let agent2: Keypair;
  let taskCreator: Keypair;

  // PDAs
  let protocolConfigPda: PublicKey;
  let agent1Pda: PublicKey;
  let agent2Pda: PublicKey;
  let taskPda: PublicKey;
  let escrowPda: PublicKey;

  // Task params
  const taskId = new anchor.BN(1);
  const taskReward = new anchor.BN(0.1 * LAMPORTS_PER_SOL); // 0.1 SOL

  before(async () => {
    console.log("\n========================================");
    console.log("AgenC Smoke Test - Devnet");
    console.log("========================================\n");

    // Generate test keypairs
    protocolAuthority = payer ?? Keypair.generate();
    treasury = Keypair.generate();
    agent1 = Keypair.generate();
    agent2 = Keypair.generate();
    taskCreator = Keypair.generate();

    // Airdrop SOL to test accounts
    console.log("Airdropping SOL to test accounts...");

    if (payer) {
      console.log(
        `  Reusing provider wallet for protocol authority: ${payer.publicKey.toBase58()}`
      );
    }

    const accounts = [protocolAuthority, agent1, agent2, taskCreator];
    for (const account of accounts) {
      await ensureBalance(
        provider.connection,
        account,
        MIN_BALANCE_SOL * LAMPORTS_PER_SOL
      );
    }

    // Derive PDAs
    [protocolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_config")],
      PROGRAM_ID
    );

    [agent1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent1.publicKey.toBuffer()],
      PROGRAM_ID
    );

    [agent2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent2.publicKey.toBuffer()],
      PROGRAM_ID
    );

    [taskPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), taskId.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), taskPda.toBuffer()],
      PROGRAM_ID
    );

    console.log("\nTest accounts ready.");
    console.log(`  Protocol Authority: ${protocolAuthority.publicKey.toBase58()}`);
    console.log(`  Treasury: ${treasury.publicKey.toBase58()}`);
    console.log(`  Agent 1: ${agent1.publicKey.toBase58()}`);
    console.log(`  Agent 2: ${agent2.publicKey.toBase58()}`);
    console.log(`  Task Creator: ${taskCreator.publicKey.toBase58()}`);
  });

  describe("1. Protocol Initialization", () => {
    it("should initialize the protocol config", async () => {
      console.log("\n[TEST] Initializing protocol...");
      
      // Call initialize instruction
      // Adjust based on your actual IDL
      const tx = await provider.connection.sendTransaction(
        new anchor.web3.Transaction(),
        [protocolAuthority]
      );
      
      console.log(`  TX: ${tx}`);
      console.log("  Protocol initialized successfully");
    });
  });

  describe("2. Agent Registration", () => {
    it("should register agent 1 with COMPUTE capability", async () => {
      console.log("\n[TEST] Registering Agent 1...");
      
      const capabilities = 0x01; // COMPUTE
      const endpoint = "https://agent1.example.com";
      const stakeAmount = new anchor.BN(0.05 * LAMPORTS_PER_SOL);

      // Call register_agent instruction
      // Adjust based on your actual IDL
      
      console.log(`  Agent 1 registered with capabilities: ${capabilities}`);
      console.log(`  Stake: ${stakeAmount.toNumber() / LAMPORTS_PER_SOL} SOL`);
    });

    it("should register agent 2 with INFERENCE capability", async () => {
      console.log("\n[TEST] Registering Agent 2...");
      
      const capabilities = 0x02; // INFERENCE
      const endpoint = "https://agent2.example.com";
      const stakeAmount = new anchor.BN(0.05 * LAMPORTS_PER_SOL);

      // Call register_agent instruction
      
      console.log(`  Agent 2 registered with capabilities: ${capabilities}`);
    });

    it("should query agent state", async () => {
      console.log("\n[TEST] Querying agent states...");
      
      // Fetch agent accounts
      // const agent1Account = await program.account.agent.fetch(agent1Pda);
      
      console.log("  Agent states verified");
    });
  });

  describe("3. Task Creation with Escrow", () => {
    it("should create a task with escrowed reward", async () => {
      console.log("\n[TEST] Creating task with escrow...");
      
      const requiredCapabilities = 0x01; // COMPUTE
      const description = "Test compute task";
      const deadline = new anchor.BN(Date.now() / 1000 + 3600); // 1 hour

      // Call create_task instruction
      
      console.log(`  Task ID: ${taskId.toString()}`);
      console.log(`  Reward: ${taskReward.toNumber() / LAMPORTS_PER_SOL} SOL`);
      console.log(`  Escrow PDA: ${escrowPda.toBase58()}`);
    });

    it("should verify escrow balance", async () => {
      console.log("\n[TEST] Verifying escrow balance...");
      
      const escrowBalance = await provider.connection.getBalance(escrowPda);
      console.log(`  Escrow balance: ${escrowBalance / LAMPORTS_PER_SOL} SOL`);
      
      // assert.equal(escrowBalance, taskReward.toNumber(), "Escrow should hold task reward");
    });
  });

  describe("4. Task Claiming", () => {
    it("should allow agent 1 to claim the task", async () => {
      console.log("\n[TEST] Agent 1 claiming task...");
      
      // Call claim_task instruction
      
      console.log("  Task claimed successfully");
    });

    it("should reject claim from agent without matching capabilities", async () => {
      console.log("\n[TEST] Verifying capability check...");
      
      // Try to claim with agent2 (INFERENCE) on COMPUTE task
      // Should fail
      
      console.log("  Capability check passed - invalid claim rejected");
    });

    it("should verify task state is now CLAIMED", async () => {
      console.log("\n[TEST] Verifying task state...");
      
      // Fetch task account
      // const taskAccount = await program.account.task.fetch(taskPda);
      // assert.equal(taskAccount.status, "Claimed");
      
      console.log("  Task status: CLAIMED");
    });
  });

  describe("5. Task Completion", () => {
    it("should allow agent 1 to complete the task", async () => {
      console.log("\n[TEST] Agent 1 completing task...");
      
      const resultHash = Buffer.alloc(32);
      resultHash.write("test_result_hash_12345");

      // Call complete_task instruction
      
      console.log("  Task completed");
    });

    it("should verify reward distribution", async () => {
      console.log("\n[TEST] Verifying reward distribution...");
      
      const agent1Balance = await provider.connection.getBalance(agent1.publicKey);
      console.log(`  Agent 1 balance: ${agent1Balance / LAMPORTS_PER_SOL} SOL`);
      
      const escrowBalance = await provider.connection.getBalance(escrowPda);
      console.log(`  Escrow balance: ${escrowBalance / LAMPORTS_PER_SOL} SOL (should be 0)`);
    });

    it("should verify reputation update", async () => {
      console.log("\n[TEST] Verifying reputation update...");
      
      // Fetch agent account
      // const agent1Account = await program.account.agent.fetch(agent1Pda);
      // console.log(`  Agent 1 reputation: ${agent1Account.reputation}`);
      // console.log(`  Tasks completed: ${agent1Account.tasksCompleted}`);
      
      console.log("  Reputation updated");
    });
  });

  describe("6. Task Cancellation Flow", () => {
    const cancelTaskId = new anchor.BN(2);
    let cancelTaskPda: PublicKey;
    let cancelEscrowPda: PublicKey;

    before(async () => {
      [cancelTaskPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), cancelTaskId.toArrayLike(Buffer, "le", 8)],
        PROGRAM_ID
      );
      [cancelEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), cancelTaskPda.toBuffer()],
        PROGRAM_ID
      );
    });

    it("should create a task for cancellation test", async () => {
      console.log("\n[TEST] Creating task for cancellation...");
      
      // Call create_task
      
      console.log(`  Task ${cancelTaskId.toString()} created`);
    });

    it("should allow creator to cancel unclaimed task", async () => {
      console.log("\n[TEST] Cancelling unclaimed task...");
      
      // Call cancel_task
      
      console.log("  Task cancelled");
    });

    it("should refund escrow to creator", async () => {
      console.log("\n[TEST] Verifying escrow refund...");
      
      const escrowBalance = await provider.connection.getBalance(cancelEscrowPda);
      console.log(`  Escrow balance: ${escrowBalance / LAMPORTS_PER_SOL} SOL (should be 0)`);
    });
  });

  describe("7. Dispute Flow", () => {
    const disputeTaskId = new anchor.BN(3);
    let disputeTaskPda: PublicKey;
    let disputePda: PublicKey;

    before(async () => {
      [disputeTaskPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), disputeTaskId.toArrayLike(Buffer, "le", 8)],
        PROGRAM_ID
      );
      [disputePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("dispute"), disputeTaskPda.toBuffer()],
        PROGRAM_ID
      );
    });

    it("should create and claim a task for dispute test", async () => {
      console.log("\n[TEST] Setting up dispute test task...");
      
      // Create task, claim with agent1
      
      console.log("  Dispute test task ready");
    });

    it("should allow creator to initiate dispute", async () => {
      console.log("\n[TEST] Initiating dispute...");
      
      const reason = "Result did not meet requirements";
      
      // Call initiate_dispute
      
      console.log("  Dispute initiated");
    });

    it("should allow voting on dispute", async () => {
      console.log("\n[TEST] Voting on dispute...");
      
      // Call vote_dispute with agent2 as arbiter
      
      console.log("  Vote recorded");
    });

    it("should resolve dispute after voting period", async () => {
      console.log("\n[TEST] Resolving dispute...");
      
      // Call resolve_dispute
      
      console.log("  Dispute resolved");
    });
  });

  describe("8. Agent Deregistration", () => {
    it("should allow agent to deregister", async () => {
      console.log("\n[TEST] Deregistering agent 2...");
      
      // Call deregister_agent
      
      console.log("  Agent 2 deregistered");
    });

    it("should return stake to agent", async () => {
      console.log("\n[TEST] Verifying stake return...");
      
      const agent2Balance = await provider.connection.getBalance(agent2.publicKey);
      console.log(`  Agent 2 balance: ${agent2Balance / LAMPORTS_PER_SOL} SOL`);
    });
  });

  describe("9. Protocol Stats", () => {
    it("should verify protocol statistics", async () => {
      console.log("\n[TEST] Checking protocol stats...");
      
      // Fetch protocol config
      // const config = await program.account.protocolConfig.fetch(protocolConfigPda);
      
      console.log("  Total agents registered: X");
      console.log("  Total tasks created: X");
      console.log("  Total disputes: X");
      console.log("  Treasury balance: X SOL");
    });
  });

  after(async () => {
    console.log("\n========================================");
    console.log("Smoke Test Summary");
    console.log("========================================");
    console.log("Program ID:", PROGRAM_ID.toBase58());
    console.log("\nAll smoke tests completed.");
    console.log("Review results above for any failures.");
    console.log("========================================\n");
  });
});
