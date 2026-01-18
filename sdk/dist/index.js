"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  DEFAULT_FEE_PERCENT: () => DEFAULT_FEE_PERCENT,
  DEVNET_RPC: () => DEVNET_RPC,
  DISCRIMINATOR_SIZE: () => DISCRIMINATOR_SIZE,
  HASH_SIZE: () => HASH_SIZE,
  MAINNET_RPC: () => MAINNET_RPC,
  OUTPUT_FIELD_COUNT: () => OUTPUT_FIELD_COUNT,
  PERCENT_BASE: () => PERCENT_BASE,
  PRIVACY_CASH_PROGRAM_ID: () => PRIVACY_CASH_PROGRAM_ID,
  PROGRAM_ID: () => PROGRAM_ID,
  PROOF_SIZE_BYTES: () => PROOF_SIZE_BYTES,
  PUBLIC_INPUTS_COUNT: () => PUBLIC_INPUTS_COUNT,
  PrivacyClient: () => PrivacyClient,
  RESULT_DATA_SIZE: () => RESULT_DATA_SIZE,
  SEEDS: () => SEEDS,
  TaskState: () => TaskState,
  U64_SIZE: () => U64_SIZE,
  VERIFICATION_COMPUTE_UNITS: () => VERIFICATION_COMPUTE_UNITS,
  VERIFIER_PROGRAM_ID: () => VERIFIER_PROGRAM_ID,
  VERSION: () => VERSION,
  checkToolsAvailable: () => checkToolsAvailable,
  claimTask: () => claimTask,
  completeTask: () => completeTask,
  completeTaskPrivate: () => completeTaskPrivate,
  computeCommitment: () => computeCommitment,
  computeConstraintHash: () => computeConstraintHash,
  computeExpectedBinding: () => computeExpectedBinding,
  createTask: () => createTask,
  generateProof: () => generateProof,
  generateSalt: () => generateSalt,
  getTask: () => getTask,
  pubkeyToField: () => pubkeyToField,
  verifyProofLocally: () => verifyProofLocally
});
module.exports = __toCommonJS(index_exports);

// src/client.ts
var import_web33 = require("@solana/web3.js");
var import_anchor = require("@coral-xyz/anchor");
var path2 = __toESM(require("path"));

// src/privacy.ts
var import_web32 = require("@solana/web3.js");
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_child_process = require("child_process");

// src/constants.ts
var import_web3 = require("@solana/web3.js");
var PROGRAM_ID = new import_web3.PublicKey("EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ");
var VERIFIER_PROGRAM_ID = new import_web3.PublicKey("8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ");
var PRIVACY_CASH_PROGRAM_ID = new import_web3.PublicKey("9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD");
var DEVNET_RPC = "https://api.devnet.solana.com";
var MAINNET_RPC = "https://api.mainnet-beta.solana.com";
var HASH_SIZE = 32;
var RESULT_DATA_SIZE = 64;
var U64_SIZE = 8;
var DISCRIMINATOR_SIZE = 8;
var OUTPUT_FIELD_COUNT = 4;
var PROOF_SIZE_BYTES = 388;
var VERIFICATION_COMPUTE_UNITS = 5e4;
var PUBLIC_INPUTS_COUNT = 67;
var PERCENT_BASE = 100;
var DEFAULT_FEE_PERCENT = 1;
var TaskState = /* @__PURE__ */ ((TaskState2) => {
  TaskState2[TaskState2["Open"] = 0] = "Open";
  TaskState2[TaskState2["Claimed"] = 1] = "Claimed";
  TaskState2[TaskState2["Completed"] = 2] = "Completed";
  TaskState2[TaskState2["Disputed"] = 3] = "Disputed";
  TaskState2[TaskState2["Cancelled"] = 4] = "Cancelled";
  return TaskState2;
})(TaskState || {});
var SEEDS = {
  PROTOCOL: Buffer.from("protocol"),
  TASK: Buffer.from("task"),
  CLAIM: Buffer.from("claim"),
  AGENT: Buffer.from("agent"),
  ESCROW: Buffer.from("escrow")
};

// src/privacy.ts
function validateCircuitPath(circuitPath) {
  if (path.isAbsolute(circuitPath)) {
    throw new Error("Security: Absolute circuit paths are not allowed");
  }
  const normalized = path.normalize(circuitPath);
  if (normalized.startsWith("..") || normalized.includes("../")) {
    throw new Error("Security: Path traversal in circuit path is not allowed");
  }
  const dangerousChars = /[;&|`$(){}[\]<>!]/;
  if (dangerousChars.test(circuitPath)) {
    throw new Error("Security: Circuit path contains disallowed characters");
  }
}
var PrivacyCashClass = null;
var loadAttempted = false;
var loadError = null;
async function loadPrivacyCash() {
  if (loadAttempted) {
    if (loadError) throw loadError;
    return PrivacyCashClass;
  }
  loadAttempted = true;
  try {
    const module2 = await import("privacycash");
    if (!module2.PrivacyCash) {
      loadError = new Error("privacycash module loaded but PrivacyCash class not found");
      throw loadError;
    }
    PrivacyCashClass = module2.PrivacyCash;
    return PrivacyCashClass;
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      return null;
    }
    loadError = err instanceof Error ? err : new Error(String(err));
    throw loadError;
  }
}
function createPrivacyCash(config) {
  if (!PrivacyCashClass) {
    throw new Error(
      "privacycash package not installed. Install it with: npm install privacycash"
    );
  }
  return new PrivacyCashClass(config);
}
var AgenCPrivacyClient = class {
  connection;
  program;
  circuitPath;
  privacyCash = null;
  rpcUrl;
  privacyCashLoaded = false;
  constructor(connection, program, circuitPath = "./circuits/task_completion", rpcUrl) {
    validateCircuitPath(circuitPath);
    this.connection = connection;
    this.program = program;
    this.circuitPath = circuitPath;
    this.rpcUrl = rpcUrl || connection.rpcEndpoint;
  }
  /**
   * Initialize Privacy Cash client for a specific wallet
   * Must be called before using private escrow features
   */
  async initPrivacyCash(owner) {
    if (!this.privacyCashLoaded) {
      await loadPrivacyCash();
      this.privacyCashLoaded = true;
    }
    this.privacyCash = createPrivacyCash({
      RPC_url: this.rpcUrl,
      owner,
      enableDebug: true
    });
    console.log("Privacy Cash client initialized for:", owner.publicKey.toBase58());
  }
  /**
   * Shield escrow funds into Privacy Cash pool
   * Called by task creator when creating a private task
   */
  async shieldEscrow(creator, lamports) {
    if (!this.privacyCash || this.privacyCash.publicKey.toBase58() !== creator.publicKey.toBase58()) {
      await this.initPrivacyCash(creator);
    }
    console.log(`Shielding ${lamports / import_web32.LAMPORTS_PER_SOL} SOL into privacy pool...`);
    const result = await this.privacyCash.deposit({ lamports });
    console.log("Escrow shielded successfully");
    return {
      txSignature: result?.signature || "deposited",
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
    validateCircuitPath(this.circuitPath);
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
    (0, import_child_process.execSync)("nargo execute", { cwd: this.circuitPath, stdio: "pipe", timeout: 12e4 });
    (0, import_child_process.execSync)(
      "sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof",
      { cwd: this.circuitPath, stdio: "pipe", timeout: 3e5 }
    );
    const zkProof = fs.readFileSync(
      path.join(this.circuitPath, "target/task_completion.proof")
    );
    const publicWitness = fs.readFileSync(
      path.join(this.circuitPath, "target/task_completion.gz")
    );
    return { zkProof, publicWitness };
  }
  /**
   * Build the complete_task_private transaction
   * This submits the ZK proof for on-chain verification
   */
  async buildCompleteTaskPrivateTx(params) {
    const { taskId, zkProof, publicWitness, worker } = params;
    const [taskPda] = import_web32.PublicKey.findProgramAddressSync(
      [Buffer.from("task"), Buffer.from(new Uint8Array(new BigUint64Array([BigInt(taskId)]).buffer))],
      this.program.programId
    );
    const [claimPda] = import_web32.PublicKey.findProgramAddressSync(
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
      systemProgram: import_web32.PublicKey.default
    }).instruction();
    const tx = new import_web32.Transaction().add(ix);
    tx.feePayer = worker;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    return tx;
  }
  /**
   * Compute Poseidon commitment for output
   *
   * SECURITY WARNING: This is a placeholder implementation that returns 0n.
   * In production, this MUST use a real Poseidon2 implementation that matches
   * the Noir circuit's poseidon2_permutation function.
   *
   * @throws Error in production mode (NODE_ENV=production)
   */
  async computeCommitment(output, salt) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Security: computeCommitment placeholder cannot be used in production. Implement Poseidon2 hash matching the Noir circuit."
      );
    }
    console.warn("[SECURITY WARNING] Using placeholder computeCommitment - NOT FOR PRODUCTION");
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
    const [taskPda] = import_web32.PublicKey.findProgramAddressSync(
      [Buffer.from("task"), Buffer.from(new Uint8Array(new BigUint64Array([BigInt(taskId)]).buffer))],
      this.program.programId
    );
    const accounts = this.program.account;
    return await accounts["task"].fetch(taskPda);
  }
  async getVerifierProgramId() {
    return VERIFIER_PROGRAM_ID;
  }
};

// src/client.ts
function isValidCircuitPath(circuitPath) {
  if (path2.isAbsolute(circuitPath)) {
    return false;
  }
  const normalized = path2.normalize(circuitPath);
  if (normalized.startsWith("..") || normalized.includes("../")) {
    return false;
  }
  return true;
}
var PrivacyClient = class {
  connection;
  program = null;
  privacyClient = null;
  config;
  wallet = null;
  constructor(config = {}) {
    const circuitPath = config.circuitPath || "./circuits/task_completion";
    if (!isValidCircuitPath(circuitPath)) {
      throw new Error("Invalid circuit path: path traversal or absolute paths not allowed");
    }
    this.config = {
      devnet: false,
      circuitPath,
      debug: false,
      ...config
    };
    const rpcUrl = config.rpcUrl || (this.config.devnet ? DEVNET_RPC : MAINNET_RPC);
    this.connection = new import_web33.Connection(rpcUrl, "confirmed");
    if (config.wallet) {
      this.wallet = config.wallet;
    }
    if (this.config.debug) {
      console.log("PrivacyClient initialized");
      console.log("  Network:", this.config.devnet ? "devnet" : "mainnet");
      console.log("  Circuit:", this.config.circuitPath);
    }
  }
  /**
   * Initialize the client with a wallet and optional IDL
   * @param wallet - The wallet keypair to use for signing
   * @param idl - Optional IDL for the AgenC program (required for full functionality)
   */
  async init(wallet, idl) {
    this.wallet = wallet;
    const anchorWallet = new import_anchor.Wallet(wallet);
    const provider = new import_anchor.AnchorProvider(
      this.connection,
      anchorWallet,
      { commitment: "confirmed" }
    );
    const programIdl = idl || this.config.idl;
    if (programIdl) {
      this.program = new import_anchor.Program(programIdl, provider);
      if (this.config.debug) {
        console.log("Program initialized with IDL");
      }
    } else if (this.config.debug) {
      console.warn("No IDL provided - some features may not be available");
    }
    if (this.config.debug) {
      const pubkey = wallet.publicKey.toBase58();
      console.log("Wallet initialized:", pubkey.substring(0, 8) + "..." + pubkey.substring(pubkey.length - 4));
    }
    if (this.program) {
      this.privacyClient = new AgenCPrivacyClient(
        this.connection,
        this.program,
        this.config.circuitPath,
        this.connection.rpcEndpoint
      );
      await this.privacyClient.initPrivacyCash(wallet);
    }
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
    return (lamports / import_web33.LAMPORTS_PER_SOL).toFixed(9) + " SOL";
  }
  /**
   * Parse SOL string to lamports
   */
  static parseSol(sol) {
    const value = typeof sol === "string" ? parseFloat(sol) : sol;
    return Math.floor(value * import_web33.LAMPORTS_PER_SOL);
  }
};

// src/proofs.ts
var fs2 = __toESM(require("fs"));
var path3 = __toESM(require("path"));
var import_child_process2 = require("child_process");
var import_poseidon2 = require("@zkpassport/poseidon2");
function validateCircuitPath2(circuitPath) {
  if (path3.isAbsolute(circuitPath)) {
    throw new Error("Security: Absolute circuit paths are not allowed");
  }
  const normalized = path3.normalize(circuitPath);
  if (normalized.startsWith("..") || normalized.includes("../")) {
    throw new Error("Security: Path traversal in circuit path is not allowed");
  }
  const dangerousChars = /[;&|`$(){}[\]<>!]/;
  if (dangerousChars.test(circuitPath)) {
    throw new Error("Security: Circuit path contains disallowed characters");
  }
}
var FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
var FIELD_HEX_LENGTH = HASH_SIZE * 2;
var BYTE_BASE = 256n;
var DEFAULT_CIRCUIT_PATH = "./circuits/task_completion";
function poseidonHash2(a, b) {
  return (0, import_poseidon2.poseidon2Hash)([a % FIELD_MODULUS, b % FIELD_MODULUS, 0n, 0n]);
}
function poseidonHash4(input) {
  if (input.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(`Input must be exactly ${OUTPUT_FIELD_COUNT} elements`);
  }
  return (0, import_poseidon2.poseidon2Hash)(input.map((x) => x % FIELD_MODULUS));
}
function pubkeyToField(pubkey) {
  const bytes = pubkey.toBytes();
  let field = 0n;
  for (const byte of bytes) {
    field = (field * BYTE_BASE + BigInt(byte)) % FIELD_MODULUS;
  }
  return field;
}
function computeExpectedBinding(taskPda, agentPubkey, outputCommitment) {
  const taskField = pubkeyToField(taskPda);
  const agentField = pubkeyToField(agentPubkey);
  const binding = poseidonHash2(taskField, agentField);
  return poseidonHash2(binding, outputCommitment % FIELD_MODULUS);
}
function computeConstraintHash(output) {
  if (output.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(`Output must be exactly ${OUTPUT_FIELD_COUNT} field elements`);
  }
  return poseidonHash4(output);
}
function computeCommitment(constraintHash, salt) {
  return poseidonHash2(constraintHash, salt);
}
var BITS_PER_BYTE = 8n;
function generateSalt() {
  const bytes = new Uint8Array(HASH_SIZE);
  crypto.getRandomValues(bytes);
  let salt = 0n;
  for (const byte of bytes) {
    salt = salt << BITS_PER_BYTE | BigInt(byte);
  }
  return salt % FIELD_MODULUS;
}
function generateProverToml(params) {
  const taskBytes = Array.from(params.taskPda.toBytes());
  const agentBytes = Array.from(params.agentPubkey.toBytes());
  const expectedBinding = computeExpectedBinding(
    params.taskPda,
    params.agentPubkey,
    params.outputCommitment
  );
  return `task_id = [${taskBytes.join(", ")}]
agent_pubkey = [${agentBytes.join(", ")}]
constraint_hash = "0x${params.constraintHash.toString("hex")}"
output_commitment = "0x${params.outputCommitment.toString(16)}"
expected_binding = "0x${expectedBinding.toString(16)}"
output = [${params.output.map((o) => `"${o.toString()}"`).join(", ")}]
salt = "${params.salt.toString()}"
`;
}
async function generateProof(params) {
  const circuitPath = params.circuitPath || DEFAULT_CIRCUIT_PATH;
  validateCircuitPath2(circuitPath);
  const startTime = Date.now();
  const expectedBindingBigint = computeExpectedBinding(
    params.taskPda,
    params.agentPubkey,
    params.outputCommitment
  );
  const proverTomlPath = path3.join(circuitPath, "Prover.toml");
  const proofOutputPath = path3.join(circuitPath, "target/task_completion.proof");
  const witnessPath = path3.join(circuitPath, "target/task_completion.gz");
  const targetDir = path3.join(circuitPath, "target");
  if (!fs2.existsSync(targetDir)) {
    fs2.mkdirSync(targetDir, { recursive: true });
  }
  fs2.writeFileSync(proverTomlPath, generateProverToml(params));
  try {
    (0, import_child_process2.execSync)("nargo execute", { cwd: circuitPath, stdio: "pipe", timeout: 12e4 });
    (0, import_child_process2.execSync)(
      "sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof",
      { cwd: circuitPath, stdio: "pipe", timeout: 3e5 }
    );
    const proof = fs2.readFileSync(proofOutputPath);
    const publicWitness = fs2.readFileSync(witnessPath);
    const expectedBinding = bigintToBytes32(expectedBindingBigint);
    return {
      proof,
      publicWitness,
      expectedBinding,
      proofSize: proof.length,
      generationTime: Date.now() - startTime
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Proof generation failed: ${message}`);
  }
}
function bigintToBytes32(value) {
  const hex = value.toString(16).padStart(FIELD_HEX_LENGTH, "0");
  return Buffer.from(hex, "hex");
}
async function verifyProofLocally(proof, publicWitness, circuitPath = DEFAULT_CIRCUIT_PATH) {
  validateCircuitPath2(circuitPath);
  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  const proofPath = path3.join(circuitPath, `target/verify_test_${uniqueSuffix}.proof`);
  const witnessPath = path3.join(circuitPath, `target/verify_test_${uniqueSuffix}.pw`);
  const relativeProofPath = `target/verify_test_${uniqueSuffix}.proof`;
  const relativeWitnessPath = `target/verify_test_${uniqueSuffix}.pw`;
  fs2.writeFileSync(proofPath, proof);
  fs2.writeFileSync(witnessPath, publicWitness);
  try {
    (0, import_child_process2.execSync)(
      `sunspot verify target/task_completion.ccs target/task_completion.vk ${relativeProofPath} ${relativeWitnessPath}`,
      { cwd: circuitPath, stdio: "pipe", timeout: 6e4 }
    );
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs2.unlinkSync(proofPath);
    } catch {
    }
    try {
      fs2.unlinkSync(witnessPath);
    } catch {
    }
  }
}
function checkToolsAvailable() {
  let nargo = false;
  let sunspot = false;
  try {
    (0, import_child_process2.execSync)("nargo --version", { stdio: "pipe" });
    nargo = true;
  } catch {
  }
  try {
    (0, import_child_process2.execSync)("sunspot --version", { stdio: "pipe" });
    sunspot = true;
  } catch {
  }
  return { nargo, sunspot };
}

// src/tasks.ts
var import_web34 = require("@solana/web3.js");
var import_anchor2 = require("@coral-xyz/anchor");
function getAccount(program, name) {
  const accounts = program.account;
  const account = accounts[name];
  if (!account) {
    throw new Error(
      `Account "${name}" not found in program. Available accounts: ${Object.keys(accounts).join(", ") || "none"}`
    );
  }
  return account;
}
function deriveTaskPda(taskId, programId = PROGRAM_ID) {
  const taskIdBuffer = Buffer.alloc(U64_SIZE);
  taskIdBuffer.writeBigUInt64LE(BigInt(taskId));
  const [pda] = import_web34.PublicKey.findProgramAddressSync(
    [SEEDS.TASK, taskIdBuffer],
    programId
  );
  return pda;
}
function deriveClaimPda(taskPda, agent, programId = PROGRAM_ID) {
  const [pda] = import_web34.PublicKey.findProgramAddressSync(
    [SEEDS.CLAIM, taskPda.toBuffer(), agent.toBuffer()],
    programId
  );
  return pda;
}
function deriveEscrowPda(taskPda, programId = PROGRAM_ID) {
  const [pda] = import_web34.PublicKey.findProgramAddressSync(
    [SEEDS.ESCROW, taskPda.toBuffer()],
    programId
  );
  return pda;
}
async function createTask(connection, program, creator, params) {
  const [protocolPda] = import_web34.PublicKey.findProgramAddressSync(
    [SEEDS.PROTOCOL],
    program.programId
  );
  const protocolState = await getAccount(program, "protocolState").fetch(protocolPda);
  const taskId = protocolState.nextTaskId?.toNumber() || 0;
  const taskPda = deriveTaskPda(taskId, program.programId);
  const escrowPda = deriveEscrowPda(taskPda, program.programId);
  const tx = await program.methods.createTask({
    description: params.description,
    escrowLamports: new import_anchor2.BN(params.escrowLamports),
    deadline: new import_anchor2.BN(params.deadline),
    constraintHash: params.constraintHash ? Array.from(params.constraintHash) : null,
    requiredSkills: params.requiredSkills || [],
    maxClaims: params.maxClaims || 1
  }).accounts({
    creator: creator.publicKey,
    task: taskPda,
    escrow: escrowPda,
    protocolState: protocolPda,
    systemProgram: import_web34.SystemProgram.programId
  }).signers([creator]).rpc();
  return { taskId, txSignature: tx };
}
async function claimTask(connection, program, agent, taskId) {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, agent.publicKey, program.programId);
  const [agentPda] = import_web34.PublicKey.findProgramAddressSync(
    [SEEDS.AGENT, agent.publicKey.toBuffer()],
    program.programId
  );
  const tx = await program.methods.claimTask(taskId).accounts({
    agent: agent.publicKey,
    agentAccount: agentPda,
    task: taskPda,
    taskClaim: claimPda,
    systemProgram: import_web34.SystemProgram.programId
  }).signers([agent]).rpc();
  return { txSignature: tx };
}
async function completeTask(connection, program, worker, taskId, resultHash) {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, worker.publicKey, program.programId);
  const escrowPda = deriveEscrowPda(taskPda, program.programId);
  const task = await getAccount(program, "task").fetch(taskPda);
  const tx = await program.methods.completeTask({
    resultHash: Array.from(resultHash)
  }).accounts({
    worker: worker.publicKey,
    task: taskPda,
    taskClaim: claimPda,
    escrow: escrowPda,
    creator: task.creator,
    systemProgram: import_web34.SystemProgram.programId
  }).signers([worker]).rpc();
  return { txSignature: tx };
}
async function completeTaskPrivate(connection, program, worker, taskId, proof, verifierProgramId) {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, worker.publicKey, program.programId);
  const escrowPda = deriveEscrowPda(taskPda, program.programId);
  const [workerAgentPda] = import_web34.PublicKey.findProgramAddressSync(
    [SEEDS.AGENT, worker.publicKey.toBuffer()],
    program.programId
  );
  const [protocolPda] = import_web34.PublicKey.findProgramAddressSync(
    [SEEDS.PROTOCOL],
    program.programId
  );
  const protocolState = await getAccount(program, "protocolConfig").fetch(protocolPda);
  const tx = await program.methods.completeTaskPrivate(new import_anchor2.BN(taskId), {
    proofData: Array.from(proof.proofData),
    constraintHash: Array.from(proof.constraintHash),
    outputCommitment: Array.from(proof.outputCommitment),
    expectedBinding: Array.from(proof.expectedBinding)
  }).accounts({
    task: taskPda,
    claim: claimPda,
    escrow: escrowPda,
    worker: workerAgentPda,
    protocolConfig: protocolPda,
    treasury: protocolState.treasury,
    zkVerifier: verifierProgramId,
    authority: worker.publicKey,
    systemProgram: import_web34.SystemProgram.programId
  }).signers([worker]).rpc();
  return { txSignature: tx };
}
async function getTask(connection, program, taskId) {
  const taskPda = deriveTaskPda(taskId, program.programId);
  try {
    const task = await getAccount(program, "task").fetch(taskPda);
    const taskData = task;
    return {
      taskId,
      state: taskData.state,
      creator: taskData.creator,
      escrowLamports: taskData.escrowLamports?.toNumber() || 0,
      deadline: taskData.deadline?.toNumber() || 0,
      constraintHash: taskData.constraintHash ? Buffer.from(taskData.constraintHash) : null,
      claimedBy: taskData.claimedBy || null,
      completedAt: taskData.completedAt?.toNumber() || null
    };
  } catch {
    return null;
  }
}

// src/index.ts
var VERSION = "1.0.0";
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_FEE_PERCENT,
  DEVNET_RPC,
  DISCRIMINATOR_SIZE,
  HASH_SIZE,
  MAINNET_RPC,
  OUTPUT_FIELD_COUNT,
  PERCENT_BASE,
  PRIVACY_CASH_PROGRAM_ID,
  PROGRAM_ID,
  PROOF_SIZE_BYTES,
  PUBLIC_INPUTS_COUNT,
  PrivacyClient,
  RESULT_DATA_SIZE,
  SEEDS,
  TaskState,
  U64_SIZE,
  VERIFICATION_COMPUTE_UNITS,
  VERIFIER_PROGRAM_ID,
  VERSION,
  checkToolsAvailable,
  claimTask,
  completeTask,
  completeTaskPrivate,
  computeCommitment,
  computeConstraintHash,
  computeExpectedBinding,
  createTask,
  generateProof,
  generateSalt,
  getTask,
  pubkeyToField,
  verifyProofLocally
});
