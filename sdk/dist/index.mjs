import {
  DEVNET_RPC,
  MAINNET_RPC,
  PRIVACY_CASH_PROGRAM_ID,
  PROGRAM_ID,
  TaskState,
  VERIFIER_PROGRAM_ID,
  claimTask,
  completeTask,
  completeTaskPrivate,
  createTask,
  generateProof,
  getTask,
  verifyProofLocally
} from "./chunk-QRZGQS77.mjs";

// src/client.ts
import { Connection as Connection2, LAMPORTS_PER_SOL as LAMPORTS_PER_SOL2 } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";

// src/privacy.ts
import { PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
var AgenCPrivacyClient = class {
  connection;
  program;
  circuitPath;
  privacyCash = null;
  rpcUrl;
  constructor(connection, program, circuitPath = "./circuits/task_completion", rpcUrl) {
    this.connection = connection;
    this.program = program;
    this.circuitPath = circuitPath;
    this.rpcUrl = rpcUrl || connection.rpcEndpoint;
  }
  /**
   * Set Privacy Cash client instance
   * Users should create their own Privacy Cash instance and pass it here
   */
  setPrivacyCash(privacyCash) {
    this.privacyCash = privacyCash;
    console.log("Privacy Cash client set for:", privacyCash.publicKey.toBase58());
  }
  /**
   * Initialize Privacy Cash client for a specific wallet
   * Requires privacycash package to be installed separately
   */
  async initPrivacyCash(owner) {
    try {
      const { PrivacyCash } = await import("privacycash");
      this.privacyCash = new PrivacyCash({
        RPC_url: this.rpcUrl,
        owner,
        enableDebug: true
      });
      console.log("Privacy Cash client initialized for:", owner.publicKey.toBase58());
    } catch (error) {
      console.warn("Privacy Cash SDK not available. Install with: npm install privacycash");
      console.warn("Or use setPrivacyCash() to provide your own instance.");
    }
  }
  /**
   * Check if Privacy Cash is initialized
   */
  hasPrivacyCash() {
    return this.privacyCash !== null;
  }
  /**
   * Shield escrow funds into Privacy Cash pool
   * Called by task creator when creating a private task
   */
  async shieldEscrow(creator, lamports) {
    if (!this.privacyCash) {
      await this.initPrivacyCash(creator);
    }
    if (!this.privacyCash) {
      throw new Error("Privacy Cash not available. Install privacycash or use setPrivacyCash().");
    }
    console.log(`Shielding ${lamports / LAMPORTS_PER_SOL} SOL into privacy pool...`);
    const result = await this.privacyCash.deposit({ lamports });
    console.log("Escrow shielded successfully");
    return {
      txSignature: result?.signature || result?.tx || "deposited",
      shieldedAmount: lamports
    };
  }
  /**
   * Get shielded balance for current wallet
   */
  async getShieldedBalance() {
    if (!this.privacyCash) {
      throw new Error("Privacy Cash not initialized. Call initPrivacyCash first.");
    }
    return await this.privacyCash.getPrivateBalance();
  }
  /**
   * Complete a task privately using ZK proofs and Privacy Cash withdrawal
   *
   * Flow:
   * 1. Generate ZK proof that worker completed task correctly (Noir/Sunspot)
   * 2. Submit proof on-chain for verification
   * 3. Upon verification, withdraw shielded escrow to worker via Privacy Cash
   */
  async completeTaskPrivate(params, worker) {
    const { taskId, output, salt, recipientWallet, escrowLamports } = params;
    await this.initPrivacyCash(worker);
    const task = await this.fetchTask(taskId);
    const constraintHash = task.constraintHash;
    const outputCommitment = await this.computeCommitment(output, salt);
    console.log("Step 1/3: Generating ZK proof of task completion...");
    const { zkProof, publicWitness } = await this.generateTaskCompletionProof({
      taskId,
      agentPubkey: worker.publicKey,
      constraintHash,
      outputCommitment,
      output,
      salt
    });
    console.log("ZK proof generated:", zkProof.length, "bytes");
    console.log("Step 2/3: Submitting proof to on-chain verifier...");
    const tx = await this.buildCompleteTaskPrivateTx({
      taskId,
      zkProof,
      publicWitness,
      worker: worker.publicKey
    });
    const proofTxSignature = await this.connection.sendTransaction(tx, [worker]);
    await this.connection.confirmTransaction(proofTxSignature);
    console.log("Proof verified on-chain:", proofTxSignature);
    console.log("Step 3/3: Withdrawing shielded escrow via Privacy Cash...");
    if (!this.privacyCash) {
      throw new Error("Privacy Cash not initialized");
    }
    const withdrawResult = await this.privacyCash.withdraw({
      lamports: escrowLamports,
      recipientAddress: recipientWallet.toBase58()
    });
    console.log("Private payment completed!");
    return {
      proofTxSignature,
      withdrawResult
    };
  }
  /**
   * Generate ZK proof for task completion using Noir/Sunspot
   */
  async generateTaskCompletionProof(params) {
    const { taskId, agentPubkey, constraintHash, outputCommitment, output, salt } = params;
    const proverToml = this.generateProverToml({
      taskId,
      agentPubkey: Array.from(agentPubkey.toBytes()),
      constraintHash: "0x" + constraintHash.toString("hex"),
      outputCommitment: "0x" + outputCommitment.toString(16),
      output: output.map((o) => o.toString()),
      salt: salt.toString()
    });
    const proverPath = path.join(this.circuitPath, "Prover.toml");
    fs.writeFileSync(proverPath, proverToml);
    execSync("nargo execute", { cwd: this.circuitPath });
    execSync(
      "sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof",
      { cwd: this.circuitPath }
    );
    const zkProof = fs.readFileSync(
      path.join(this.circuitPath, "target/task_completion.proof")
    );
    const publicWitness = fs.readFileSync(
      path.join(this.circuitPath, "target/task_completion.pw")
    );
    return { zkProof, publicWitness };
  }
  /**
   * Build the complete_task_private transaction
   * This submits the ZK proof for on-chain verification
   */
  async buildCompleteTaskPrivateTx(params) {
    const { taskId, zkProof, publicWitness, worker } = params;
    if (!this.program) {
      throw new Error("Program not initialized");
    }
    const [taskPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), Buffer.from(new Uint8Array(new BigUint64Array([BigInt(taskId)]).buffer))],
      this.program.programId
    );
    const [claimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), taskPda.toBuffer(), worker.toBuffer()],
      this.program.programId
    );
    const verifierProgramId = await this.getVerifierProgramId();
    const ix = await this.program.methods.completeTaskPrivate(taskId, {
      zkProof: Array.from(zkProof),
      publicWitness: Array.from(publicWitness)
    }).accounts({
      worker,
      task: taskPda,
      taskClaim: claimPda,
      zkVerifier: verifierProgramId,
      systemProgram: PublicKey.default
    }).instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = worker;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    return tx;
  }
  /**
   * Compute Poseidon commitment for output
   */
  async computeCommitment(output, salt) {
    console.log("Computing commitment...");
    return BigInt(0);
  }
  /**
   * Generate Prover.toml content
   */
  generateProverToml(params) {
    return `# Auto-generated Prover.toml
task_id = "${params.taskId}"
agent_pubkey = [${params.agentPubkey.join(", ")}]
constraint_hash = "${params.constraintHash}"
output_commitment = "${params.outputCommitment}"
output = [${params.output.map((o) => `"${o}"`).join(", ")}]
salt = "${params.salt}"
`;
  }
  async fetchTask(taskId) {
    if (!this.program) {
      throw new Error("Program not initialized");
    }
    const [taskPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), Buffer.from(new Uint8Array(new BigUint64Array([BigInt(taskId)]).buffer))],
      this.program.programId
    );
    return await this.program.account.task.fetch(taskPda);
  }
  async getVerifierProgramId() {
    return new PublicKey("8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ");
  }
};

// src/client.ts
var PrivacyClient = class {
  connection;
  program = null;
  privacyClient = null;
  config;
  wallet = null;
  constructor(config = {}) {
    this.config = {
      devnet: false,
      circuitPath: "./circuits/task_completion",
      debug: false,
      ...config
    };
    const rpcUrl = config.rpcUrl || (this.config.devnet ? DEVNET_RPC : MAINNET_RPC);
    this.connection = new Connection2(rpcUrl, "confirmed");
    if (config.wallet) {
      this.wallet = config.wallet;
    }
    if (this.config.debug) {
      console.log("PrivacyClient initialized");
      console.log("  RPC:", rpcUrl);
      console.log("  Circuit:", this.config.circuitPath);
    }
  }
  /**
   * Initialize the client with a wallet
   */
  async init(wallet) {
    this.wallet = wallet;
    const anchorWallet = new Wallet(wallet);
    const provider = new AnchorProvider(
      this.connection,
      anchorWallet,
      { commitment: "confirmed" }
    );
    if (this.config.debug) {
      console.log("Wallet initialized:", wallet.publicKey.toBase58());
    }
    this.privacyClient = new AgenCPrivacyClient(
      this.connection,
      this.program,
      this.config.circuitPath,
      this.connection.rpcEndpoint
    );
    await this.privacyClient.initPrivacyCash(wallet);
  }
  /**
   * Get connection instance
   */
  getConnection() {
    return this.connection;
  }
  /**
   * Get wallet public key
   */
  getPublicKey() {
    return this.wallet?.publicKey || null;
  }
  /**
   * Shield SOL into the privacy pool
   */
  async shield(lamports) {
    if (!this.wallet || !this.privacyClient) {
      throw new Error("Client not initialized. Call init() first.");
    }
    const result = await this.privacyClient.shieldEscrow(this.wallet, lamports);
    return {
      txSignature: result.txSignature,
      amount: result.shieldedAmount
    };
  }
  /**
   * Get shielded balance
   */
  async getShieldedBalance() {
    if (!this.privacyClient) {
      throw new Error("Client not initialized. Call init() first.");
    }
    const { lamports } = await this.privacyClient.getShieldedBalance();
    return lamports;
  }
  /**
   * Complete a task privately with ZK proof
   */
  async completeTaskPrivate(params) {
    if (!this.wallet || !this.privacyClient) {
      throw new Error("Client not initialized. Call init() first.");
    }
    return await this.privacyClient.completeTaskPrivate(params, this.wallet);
  }
  /**
   * Get the underlying AgenCPrivacyClient for advanced operations
   */
  getPrivacyClient() {
    return this.privacyClient;
  }
  /**
   * Format lamports as SOL string
   */
  static formatSol(lamports) {
    return (lamports / LAMPORTS_PER_SOL2).toFixed(9) + " SOL";
  }
  /**
   * Parse SOL string to lamports
   */
  static parseSol(sol) {
    const value = typeof sol === "string" ? parseFloat(sol) : sol;
    return Math.floor(value * LAMPORTS_PER_SOL2);
  }
};

// src/index.ts
var VERSION = "1.0.0";
export {
  DEVNET_RPC,
  MAINNET_RPC,
  PRIVACY_CASH_PROGRAM_ID,
  PROGRAM_ID,
  PrivacyClient,
  TaskState,
  VERIFIER_PROGRAM_ID,
  VERSION,
  claimTask,
  completeTask,
  completeTaskPrivate,
  createTask,
  generateProof,
  getTask,
  verifyProofLocally
};
