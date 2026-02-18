/**
 * SDK ZK Proof Generation Integration Tests
 *
 * Tests the full proof generation flow using the SDK:
 * 1. Hash computation via nargo (hash_helper circuit)
 * 2. Proof generation via sunspot
 * 3. Local proof verification
 *
 * Prerequisites:
 * - nargo installed
 * - sunspot installed
 * - Circuits compiled with proving keys generated
 *
 * Run with: npx ts-mocha tests/sdk-proof-generation.ts
 */

import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

// SDK imports (using relative path since SDK may not be installed)
const SDK_PATH = path.join(__dirname, "../sdk/src");

describe("SDK Proof Generation", function () {
  // Increase timeout for proof generation (can take 30-60 seconds)
  this.timeout(120000);

  const CIRCUIT_PATH = path.join(__dirname, "../circuits/task_completion");
  const HASH_HELPER_PATH = path.join(__dirname, "../circuits/hash_helper");

  let sdkAvailable = false;
  let toolsAvailable = { nargo: false, sunspot: false };

  before(function () {
    // Check if SDK source exists
    if (!fs.existsSync(path.join(SDK_PATH, "proofs.ts"))) {
      console.log("SDK source not found, skipping tests");
      this.skip();
      return;
    }

    // Check tools
    try {
      execSync("nargo --version", { stdio: "pipe" });
      toolsAvailable.nargo = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("nargo probe failed:", message);
    }

    try {
      execSync("sunspot --version", { stdio: "pipe" });
      toolsAvailable.sunspot = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("sunspot probe failed:", message);
    }

    if (!toolsAvailable.nargo) {
      console.log("nargo not found, skipping proof tests");
      console.log("Install with: noirup");
      this.skip();
      return;
    }

    // Check circuit files
    if (!fs.existsSync(path.join(CIRCUIT_PATH, "Nargo.toml"))) {
      console.log("task_completion circuit not found");
      this.skip();
      return;
    }

    if (!fs.existsSync(path.join(HASH_HELPER_PATH, "Nargo.toml"))) {
      console.log("hash_helper circuit not found");
      this.skip();
      return;
    }

    sdkAvailable = true;
  });

  describe("hash computation via nargo", function () {
    it("should compute hashes for valid inputs", async function () {
      if (!sdkAvailable || !toolsAvailable.nargo) {
        this.skip();
        return;
      }

      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const output = [1n, 2n, 3n, 4n];
      const salt = 12345n;

      // Write Prover.toml for hash_helper
      const taskBytes = Array.from(taskPda.toBytes());
      const agentBytes = Array.from(agentPubkey.toBytes());

      const proverToml = `task_id = [${taskBytes.join(", ")}]
agent_pubkey = [${agentBytes.join(", ")}]
output = [${output.map((o) => `"${o.toString()}"`).join(", ")}]
salt = "${salt.toString()}"
`;

      fs.writeFileSync(path.join(HASH_HELPER_PATH, "Prover.toml"), proverToml);

      // Execute hash_helper circuit
      const result = execSync("nargo execute", {
        cwd: HASH_HELPER_PATH,
        encoding: "utf-8",
        timeout: 60000,
      });

      // Parse output
      const outputMatch = result.match(
        /Circuit output: \((0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+)\)/
      );

      expect(outputMatch).to.not.be.null;
      expect(outputMatch!.length).to.equal(4);

      const constraintHash = BigInt(outputMatch![1]);
      const outputCommitment = BigInt(outputMatch![2]);
      const expectedBinding = BigInt(outputMatch![3]);

      // Hashes should be non-zero
      expect(constraintHash).to.not.equal(0n);
      expect(outputCommitment).to.not.equal(0n);
      expect(expectedBinding).to.not.equal(0n);

      console.log("  Constraint hash:", constraintHash.toString(16).slice(0, 16) + "...");
      console.log("  Output commitment:", outputCommitment.toString(16).slice(0, 16) + "...");
    });

    it("should produce consistent hashes for same inputs", async function () {
      if (!sdkAvailable || !toolsAvailable.nargo) {
        this.skip();
        return;
      }

      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const output = [100n, 200n, 300n, 400n];
      const salt = 99999n;

      const taskBytes = Array.from(taskPda.toBytes());
      const agentBytes = Array.from(agentPubkey.toBytes());

      const proverToml = `task_id = [${taskBytes.join(", ")}]
agent_pubkey = [${agentBytes.join(", ")}]
output = [${output.map((o) => `"${o.toString()}"`).join(", ")}]
salt = "${salt.toString()}"
`;

      // Run twice with same inputs
      fs.writeFileSync(path.join(HASH_HELPER_PATH, "Prover.toml"), proverToml);
      const result1 = execSync("nargo execute", {
        cwd: HASH_HELPER_PATH,
        encoding: "utf-8",
      });

      fs.writeFileSync(path.join(HASH_HELPER_PATH, "Prover.toml"), proverToml);
      const result2 = execSync("nargo execute", {
        cwd: HASH_HELPER_PATH,
        encoding: "utf-8",
      });

      const match1 = result1.match(/Circuit output: \((0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+)\)/);
      const match2 = result2.match(/Circuit output: \((0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+)\)/);

      expect(match1![1]).to.equal(match2![1]); // constraint_hash
      expect(match1![2]).to.equal(match2![2]); // output_commitment
      expect(match1![3]).to.equal(match2![3]); // expected_binding
    });

    it("should produce different hashes for different outputs", async function () {
      if (!sdkAvailable || !toolsAvailable.nargo) {
        this.skip();
        return;
      }

      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const salt = 12345n;

      const taskBytes = Array.from(taskPda.toBytes());
      const agentBytes = Array.from(agentPubkey.toBytes());

      // First output
      const output1 = [1n, 2n, 3n, 4n];
      fs.writeFileSync(
        path.join(HASH_HELPER_PATH, "Prover.toml"),
        `task_id = [${taskBytes.join(", ")}]
agent_pubkey = [${agentBytes.join(", ")}]
output = [${output1.map((o) => `"${o.toString()}"`).join(", ")}]
salt = "${salt.toString()}"
`
      );
      const result1 = execSync("nargo execute", { cwd: HASH_HELPER_PATH, encoding: "utf-8" });
      const match1 = result1.match(/Circuit output: \((0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+)\)/);

      // Second output (different)
      const output2 = [5n, 6n, 7n, 8n];
      fs.writeFileSync(
        path.join(HASH_HELPER_PATH, "Prover.toml"),
        `task_id = [${taskBytes.join(", ")}]
agent_pubkey = [${agentBytes.join(", ")}]
output = [${output2.map((o) => `"${o.toString()}"`).join(", ")}]
salt = "${salt.toString()}"
`
      );
      const result2 = execSync("nargo execute", { cwd: HASH_HELPER_PATH, encoding: "utf-8" });
      const match2 = result2.match(/Circuit output: \((0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+)\)/);

      // constraint_hash should be different (different output)
      expect(match1![1]).to.not.equal(match2![1]);
    });
  });

  describe("proof generation", function () {
    it("should generate and verify a proof", async function () {
      if (!sdkAvailable || !toolsAvailable.nargo || !toolsAvailable.sunspot) {
        console.log("Skipping: sunspot required for proof generation");
        this.skip();
        return;
      }

      // Check for proving key
      const pkPath = path.join(CIRCUIT_PATH, "target/task_completion.pk");
      if (!fs.existsSync(pkPath)) {
        console.log("Proving key not found. Generate with:");
        console.log("  cd circuits/task_completion && nargo compile && sunspot setup target/task_completion.ccs");
        this.skip();
        return;
      }

      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const output = [1n, 2n, 3n, 4n];
      const salt = 12345n;

      // Step 1: Compute hashes
      const taskBytes = Array.from(taskPda.toBytes());
      const agentBytes = Array.from(agentPubkey.toBytes());

      fs.writeFileSync(
        path.join(HASH_HELPER_PATH, "Prover.toml"),
        `task_id = [${taskBytes.join(", ")}]
agent_pubkey = [${agentBytes.join(", ")}]
output = [${output.map((o) => `"${o.toString()}"`).join(", ")}]
salt = "${salt.toString()}"
`
      );

      const hashResult = execSync("nargo execute", { cwd: HASH_HELPER_PATH, encoding: "utf-8" });
      const hashMatch = hashResult.match(/Circuit output: \((0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+)\)/);
      expect(hashMatch).to.not.be.null;

      const constraintHash = hashMatch![1];
      const outputCommitment = hashMatch![2];
      const expectedBinding = hashMatch![3];

      // Step 2: Write Prover.toml for main circuit
      fs.writeFileSync(
        path.join(CIRCUIT_PATH, "Prover.toml"),
        `task_id = [${taskBytes.join(", ")}]
agent_pubkey = [${agentBytes.join(", ")}]
constraint_hash = "${constraintHash}"
output_commitment = "${outputCommitment}"
expected_binding = "${expectedBinding}"
output = [${output.map((o) => `"${o.toString()}"`).join(", ")}]
salt = "${salt.toString()}"
`
      );

      // Step 3: Execute circuit
      console.log("  Executing circuit...");
      execSync("nargo execute", { cwd: CIRCUIT_PATH, stdio: "pipe", timeout: 60000 });

      // Step 4: Generate proof
      console.log("  Generating proof (this takes 30-60 seconds)...");
      execSync(
        "sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof",
        { cwd: CIRCUIT_PATH, stdio: "pipe", timeout: 300000 }
      );

      // Step 5: Verify proof exists and has correct size
      const proofPath = path.join(CIRCUIT_PATH, "target/task_completion.proof");
      expect(fs.existsSync(proofPath)).to.be.true;

      const proof = fs.readFileSync(proofPath);
      expect(proof.length).to.equal(388); // Groth16 proof size

      // Step 6: Verify proof
      console.log("  Verifying proof...");
      execSync(
        "sunspot verify target/task_completion.ccs target/task_completion.vk target/task_completion.proof target/task_completion.gz",
        { cwd: CIRCUIT_PATH, stdio: "pipe", timeout: 60000 }
      );

      console.log("  Proof generated and verified successfully!");
    });
  });

  describe("circuit constraints", function () {
    it("should pass circuit tests", async function () {
      if (!toolsAvailable.nargo) {
        this.skip();
        return;
      }

      // Run nargo test for task_completion circuit
      const result = execSync("nargo test", {
        cwd: CIRCUIT_PATH,
        encoding: "utf-8",
        timeout: 60000,
      });

      expect(result).to.include("PASS");
    });

    it("should compile without errors", async function () {
      if (!toolsAvailable.nargo) {
        this.skip();
        return;
      }

      // Compile the circuit
      execSync("nargo compile", {
        cwd: CIRCUIT_PATH,
        stdio: "pipe",
        timeout: 60000,
      });

      // Check that compilation artifacts exist
      const ccsPath = path.join(CIRCUIT_PATH, "target/task_completion.ccs");
      expect(fs.existsSync(ccsPath)).to.be.true;
    });
  });
});
