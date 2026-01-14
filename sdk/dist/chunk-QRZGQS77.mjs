// src/constants.ts
import { PublicKey } from "@solana/web3.js";
var PROGRAM_ID = new PublicKey("EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ");
var VERIFIER_PROGRAM_ID = new PublicKey("8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ");
var PRIVACY_CASH_PROGRAM_ID = new PublicKey("9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD");
var DEVNET_RPC = "https://api.devnet.solana.com";
var MAINNET_RPC = "https://api.mainnet-beta.solana.com";
var PROOF_SIZE_BYTES = 388;
var VERIFICATION_COMPUTE_UNITS = 5e4;
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

// src/proofs.ts
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
async function generateProof(params) {
  const circuitPath = params.circuitPath || "./circuits/task_completion";
  const startTime = Date.now();
  const proverToml = generateProverToml(params);
  const proverPath = path.join(circuitPath, "Prover.toml");
  fs.writeFileSync(proverPath, proverToml);
  try {
    execSync("nargo execute", {
      cwd: circuitPath,
      stdio: "pipe"
    });
    execSync(
      "sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof",
      {
        cwd: circuitPath,
        stdio: "pipe"
      }
    );
    const proof = fs.readFileSync(path.join(circuitPath, "target/task_completion.proof"));
    const publicWitness = fs.readFileSync(path.join(circuitPath, "target/task_completion.pw"));
    const generationTime = Date.now() - startTime;
    return {
      proof,
      publicWitness,
      proofSize: proof.length,
      generationTime
    };
  } catch (error) {
    throw new Error(`Proof generation failed: ${error.message}`);
  }
}
async function verifyProofLocally(proof, publicWitness, circuitPath = "./circuits/task_completion") {
  const proofPath = path.join(circuitPath, "target/verify_test.proof");
  const witnessPath = path.join(circuitPath, "target/verify_test.pw");
  fs.writeFileSync(proofPath, proof);
  fs.writeFileSync(witnessPath, publicWitness);
  try {
    execSync(
      `sunspot verify target/task_completion.ccs target/task_completion.vk ${proofPath} ${witnessPath}`,
      {
        cwd: circuitPath,
        stdio: "pipe"
      }
    );
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(proofPath);
      fs.unlinkSync(witnessPath);
    } catch {
    }
  }
}
function generateProverToml(params) {
  const agentBytes = Array.from(params.agentPubkey.toBytes());
  return `# Auto-generated Prover.toml for AgenC task completion proof
task_id = "${params.taskId}"
agent_pubkey = [${agentBytes.join(", ")}]
constraint_hash = "0x${params.constraintHash.toString("hex")}"
output_commitment = "0x${params.outputCommitment.toString(16)}"
output = [${params.output.map((o) => `"${o.toString()}"`).join(", ")}]
salt = "${params.salt.toString()}"
`;
}
function generateSalt() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let salt = BigInt(0);
  for (const byte of bytes) {
    salt = salt << 8n | BigInt(byte);
  }
  return salt % 2n ** 254n;
}
function checkToolsAvailable() {
  let nargo = false;
  let sunspot = false;
  try {
    execSync("nargo --version", { stdio: "pipe" });
    nargo = true;
  } catch {
  }
  try {
    execSync("sunspot --version", { stdio: "pipe" });
    sunspot = true;
  } catch {
  }
  return { nargo, sunspot };
}

// src/tasks.ts
import {
  PublicKey as PublicKey2,
  SystemProgram
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
function deriveTaskPda(taskId, programId = PROGRAM_ID) {
  const taskIdBuffer = Buffer.alloc(8);
  taskIdBuffer.writeBigUInt64LE(BigInt(taskId));
  const [pda] = PublicKey2.findProgramAddressSync(
    [SEEDS.TASK, taskIdBuffer],
    programId
  );
  return pda;
}
function deriveClaimPda(taskPda, agent, programId = PROGRAM_ID) {
  const [pda] = PublicKey2.findProgramAddressSync(
    [SEEDS.CLAIM, taskPda.toBuffer(), agent.toBuffer()],
    programId
  );
  return pda;
}
function deriveEscrowPda(taskPda, programId = PROGRAM_ID) {
  const [pda] = PublicKey2.findProgramAddressSync(
    [SEEDS.ESCROW, taskPda.toBuffer()],
    programId
  );
  return pda;
}
async function createTask(connection, program, creator, params) {
  const [protocolPda] = PublicKey2.findProgramAddressSync(
    [SEEDS.PROTOCOL],
    program.programId
  );
  const protocolState = await program.account.protocolState.fetch(protocolPda);
  const taskId = protocolState.nextTaskId?.toNumber() || 0;
  const taskPda = deriveTaskPda(taskId, program.programId);
  const escrowPda = deriveEscrowPda(taskPda, program.programId);
  const tx = await program.methods.createTask({
    description: params.description,
    escrowLamports: new BN(params.escrowLamports),
    deadline: new BN(params.deadline),
    constraintHash: params.constraintHash ? Array.from(params.constraintHash) : null,
    requiredSkills: params.requiredSkills || [],
    maxClaims: params.maxClaims || 1
  }).accounts({
    creator: creator.publicKey,
    task: taskPda,
    escrow: escrowPda,
    protocolState: protocolPda,
    systemProgram: SystemProgram.programId
  }).signers([creator]).rpc();
  return { taskId, txSignature: tx };
}
async function claimTask(connection, program, agent, taskId) {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, agent.publicKey, program.programId);
  const [agentPda] = PublicKey2.findProgramAddressSync(
    [SEEDS.AGENT, agent.publicKey.toBuffer()],
    program.programId
  );
  const tx = await program.methods.claimTask(taskId).accounts({
    agent: agent.publicKey,
    agentAccount: agentPda,
    task: taskPda,
    taskClaim: claimPda,
    systemProgram: SystemProgram.programId
  }).signers([agent]).rpc();
  return { txSignature: tx };
}
async function completeTask(connection, program, worker, taskId, resultHash) {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, worker.publicKey, program.programId);
  const escrowPda = deriveEscrowPda(taskPda, program.programId);
  const task = await program.account.task.fetch(taskPda);
  const tx = await program.methods.completeTask({
    resultHash: Array.from(resultHash)
  }).accounts({
    worker: worker.publicKey,
    task: taskPda,
    taskClaim: claimPda,
    escrow: escrowPda,
    creator: task.creator,
    systemProgram: SystemProgram.programId
  }).signers([worker]).rpc();
  return { txSignature: tx };
}
async function completeTaskPrivate(connection, program, worker, taskId, zkProof, publicWitness, verifierProgramId) {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, worker.publicKey, program.programId);
  const tx = await program.methods.completeTaskPrivate(taskId, {
    zkProof: Array.from(zkProof),
    publicWitness: Array.from(publicWitness)
  }).accounts({
    worker: worker.publicKey,
    task: taskPda,
    taskClaim: claimPda,
    zkVerifier: verifierProgramId,
    systemProgram: SystemProgram.programId
  }).signers([worker]).rpc();
  return { txSignature: tx };
}
async function getTask(connection, program, taskId) {
  const taskPda = deriveTaskPda(taskId, program.programId);
  try {
    const task = await program.account.task.fetch(taskPda);
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
function formatTaskState(state) {
  const states = {
    [0 /* Open */]: "Open",
    [1 /* Claimed */]: "Claimed",
    [2 /* Completed */]: "Completed",
    [3 /* Disputed */]: "Disputed",
    [4 /* Cancelled */]: "Cancelled"
  };
  return states[state] || "Unknown";
}

export {
  PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  PRIVACY_CASH_PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  PROOF_SIZE_BYTES,
  VERIFICATION_COMPUTE_UNITS,
  TaskState,
  generateProof,
  verifyProofLocally,
  generateSalt,
  checkToolsAvailable,
  deriveTaskPda,
  createTask,
  claimTask,
  completeTask,
  completeTaskPrivate,
  getTask,
  formatTaskState
};
