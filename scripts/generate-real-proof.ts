/**
 * Generate a real Groth16 proof fixture for E2E testing.
 *
 * Uses deterministic keypairs derived from known seeds so the proof fixture
 * is reusable — the E2E test can reconstruct the exact same accounts.
 *
 * This script calls the agenc-zkvm-host binary with --features production-prover
 * to generate a real RISC Zero Groth16 proof. This can take 10-30 minutes on
 * first run (downloads ceremony params). The fixture is committed to git so
 * it only needs to run once.
 *
 * Prerequisites:
 *   - rzup toolchain installed (curl -L https://risczero.com/install | bash && rzup install)
 *   - Docker running (for Groth16 prover)
 *
 * Usage:
 *   npx tsx scripts/generate-real-proof.ts
 *
 * Output:
 *   tests/fixtures/real-groth16-proof.json
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

// SDK constants
const PROGRAM_ID = new PublicKey("5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7");
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Deterministic seed derivation
function deterministicSeed(label: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(label).digest());
}

function bigintToBytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function normalizeFieldElement(value: bigint): bigint {
  return ((value % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS;
}

function hashFieldElements(domainTag: Buffer, values: bigint[]): bigint {
  const hasher = createHash("sha256");
  hasher.update(domainTag);
  for (const value of values) {
    hasher.update(bigintToBytes32(normalizeFieldElement(value)));
  }
  const digest = hasher.digest();
  return BigInt(`0x${digest.toString("hex")}`) % FIELD_MODULUS;
}

function pubkeyToField(pubkey: PublicKey): bigint {
  const bytes = pubkey.toBytes();
  let field = 0n;
  for (const byte of bytes) {
    field = (field * 256n + BigInt(byte)) % FIELD_MODULUS;
  }
  return field;
}

function computeConstraintHash(output: bigint[]): bigint {
  return hashFieldElements(Buffer.from("AGENC_V2_CONSTRAINT_HASH"), output.map(normalizeFieldElement));
}

function computeOutputCommitment(output: bigint[], salt: bigint): bigint {
  return hashFieldElements(Buffer.from("AGENC_V2_OUTPUT_COMMITMENT"), [
    ...output.map(normalizeFieldElement),
    normalizeFieldElement(salt),
  ]);
}

function computeBinding(taskPda: PublicKey, agentPubkey: PublicKey, outputCommitment: bigint): bigint {
  const taskField = pubkeyToField(taskPda);
  const agentField = pubkeyToField(agentPubkey);
  const bindingBase = hashFieldElements(Buffer.from("AGENC_V2_BINDING_BASE"), [taskField, agentField]);
  return hashFieldElements(Buffer.from("AGENC_V2_BINDING"), [bindingBase, normalizeFieldElement(outputCommitment)]);
}

function computeNullifier(constraintHash: bigint, outputCommitment: bigint, agentSecret: bigint): bigint {
  const digest = createHash("sha256")
    .update(Buffer.from("AGENC_V2_NULLIFIER"))
    .update(bigintToBytes32(normalizeFieldElement(constraintHash)))
    .update(bigintToBytes32(normalizeFieldElement(outputCommitment)))
    .update(bigintToBytes32(normalizeFieldElement(agentSecret)))
    .digest();
  return BigInt(`0x${digest.toString("hex")}`);
}

async function callHostBinary(input: {
  task_pda: number[];
  agent_authority: number[];
  constraint_hash: number[];
  output_commitment: number[];
  binding: number[];
  nullifier: number[];
}): Promise<{ seal_bytes: number[]; journal: number[]; image_id: number[] }> {
  const hostBinaryDir = path.resolve(__dirname, "..", "zkvm");
  const inputJson = JSON.stringify(input);

  console.log("Spawning host binary (this may take 10-30 minutes for Groth16)...");
  console.log("If this is the first run, the RISC Zero ceremony params will be downloaded (~1.5 GB).");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "cargo",
      ["run", "-p", "agenc-zkvm-host", "--features", "production-prover", "--", "prove", "--stdin"],
      {
        cwd: hostBinaryDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 1_800_000, // 30 minutes
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString();
      stderr += line;
      // Print progress to console
      process.stderr.write(line);
    });

    child.on("error", (err: Error) => {
      reject(new Error(`Failed to spawn host binary: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`Host binary exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Failed to parse host output: ${(err as Error).message}\nstdout: ${stdout}`));
      }
    });

    child.stdin.write(inputJson);
    child.stdin.end();
  });
}

async function main() {
  console.log("=== Generating Real Groth16 Proof Fixture ===\n");

  // 1. Create deterministic keypairs
  const creatorSeed = deterministicSeed("agenc-e2e-creator");
  const workerSeed = deterministicSeed("agenc-e2e-worker");
  const creator = Keypair.fromSeed(creatorSeed);
  const worker = Keypair.fromSeed(workerSeed);

  console.log("Creator:", creator.publicKey.toBase58());
  console.log("Worker:", worker.publicKey.toBase58());

  // 2. Deterministic task parameters
  const taskId = 1;
  const output = [11n, 22n, 33n, 44n];
  const salt = 987654321n;
  const agentSecret = pubkeyToField(worker.publicKey); // For demo, use pubkey-derived secret

  // 3. Derive task PDA
  const taskIdBytes = Buffer.alloc(32, 0);
  taskIdBytes.writeUInt32LE(taskId, 0);
  const [taskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.publicKey.toBuffer(), taskIdBytes],
    PROGRAM_ID,
  );
  console.log("Task PDA:", taskPda.toBase58());

  // Derive worker agent PDA
  const workerAgentId = Buffer.from("e2e-worker-agent\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0");
  const [workerAgentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), workerAgentId],
    PROGRAM_ID,
  );
  console.log("Worker Agent PDA:", workerAgentPda.toBase58());

  // 4. Compute hashes using the same logic as SDK
  const constraintHash = computeConstraintHash(output);
  const outputCommitment = computeOutputCommitment(output, salt);
  const binding = computeBinding(taskPda, worker.publicKey, outputCommitment);
  const nullifier = computeNullifier(constraintHash, outputCommitment, agentSecret);

  console.log("\nComputed hashes:");
  console.log("  constraintHash:", constraintHash.toString(16).padStart(64, "0"));
  console.log("  outputCommitment:", outputCommitment.toString(16).padStart(64, "0"));
  console.log("  binding:", binding.toString(16).padStart(64, "0"));
  console.log("  nullifier:", nullifier.toString(16).padStart(64, "0"));

  // 5. Build prover input
  const proverInput = {
    task_pda: Array.from(taskPda.toBytes()),
    agent_authority: Array.from(worker.publicKey.toBytes()),
    constraint_hash: Array.from(bigintToBytes32(constraintHash)),
    output_commitment: Array.from(bigintToBytes32(outputCommitment)),
    binding: Array.from(bigintToBytes32(binding)),
    nullifier: Array.from(bigintToBytes32(nullifier)),
  };

  // 6. Generate proof
  console.log("\nGenerating Groth16 proof...");
  const startTime = Date.now();
  const result = await callHostBinary(proverInput);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nProof generated in ${elapsed}s`);

  // 7. Validate output
  if (result.seal_bytes.length !== 260) {
    throw new Error(`Unexpected seal_bytes length: ${result.seal_bytes.length}`);
  }
  if (result.journal.length !== 256) {
    throw new Error(`Unexpected journal length: ${result.journal.length}`);
  }
  if (result.image_id.length !== 32) {
    throw new Error(`Unexpected image_id length: ${result.image_id.length}`);
  }

  // Verify selector
  const selector = result.seal_bytes.slice(0, 4);
  if (selector[0] !== 0x52 || selector[1] !== 0x5a || selector[2] !== 0x56 || selector[3] !== 0x4d) {
    throw new Error(`Unexpected selector: ${selector}`);
  }

  // 8. Build fixture
  const fixture = {
    _comment: "Real RISC Zero Groth16 proof fixture for E2E testing. Do not edit manually.",
    sealBytes: result.seal_bytes,
    journal: result.journal,
    imageId: result.image_id,
    bindingSeed: Array.from(bigintToBytes32(binding)),
    nullifierSeed: Array.from(bigintToBytes32(nullifier)),
    creatorSecretKey: Array.from(creator.secretKey),
    workerSecretKey: Array.from(worker.secretKey),
    workerAgentId: Array.from(workerAgentId),
    taskId,
    output: output.map(String),
    salt: salt.toString(),
  };

  // 9. Write fixture
  const fixturePath = path.resolve(__dirname, "..", "tests", "fixtures", "real-groth16-proof.json");
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`\nFixture written to: ${fixturePath}`);
  console.log(`  seal_bytes: ${result.seal_bytes.length} bytes`);
  console.log(`  journal: ${result.journal.length} bytes`);
  console.log(`  imageId: ${result.image_id.length} bytes`);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Proof generation failed:", err.message);
  process.exit(1);
});
