/**
 * Compute Unit (CU) Benchmarks for AgenC Instructions (issue #40)
 *
 * Measures actual CU consumption for each instruction to validate
 * recommended CU budgets and ensure mainnet compatibility.
 *
 * Run with: anchor test -- --grep "CU Benchmarks"
 *
 * Mainnet limits:
 *   - Per-instruction: 1,400,000 CU max
 *   - Per-transaction: 1,400,000 CU max (can request up to this)
 *   - Default: 200,000 CU if not specified
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import { expect } from "chai";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  deriveAgentPda,
  deriveTaskPda,
  deriveEscrowPda,
  deriveClaimPda,
  deriveProtocolPda,
  generateRunId,
  makeAgentId,
} from "./test-utils";

/**
 * Extract compute units consumed from transaction logs.
 *
 * Looks for the pattern "consumed XXXXX of YYYYY compute units" in log messages
 * emitted by the Solana runtime.
 */
function extractComputeUnits(logs: string[]): number | null {
  for (const log of logs) {
    const match = log.match(/consumed (\d+) of (\d+) compute units/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Get transaction logs for a given signature.
 */
async function getTxLogs(
  connection: anchor.web3.Connection,
  signature: string
): Promise<string[]> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return tx?.meta?.logMessages || [];
}

describe("CU Benchmarks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;
  const protocolPda = deriveProtocolPda(program.programId);
  const runId = generateRunId();

  // Benchmark results collected during test run
  const benchmarkResults: Array<{
    instruction: string;
    consumedCU: number;
    recommendedCU: number;
    withinBudget: boolean;
  }> = [];

  // Recommended CU budgets (must match compute_budget.rs)
  const RECOMMENDED_CU = {
    register_agent: 40_000,
    update_agent: 20_000,
    create_task: 50_000,
    claim_task: 30_000,
    complete_task: 60_000,
    cancel_task: 40_000,
  };

  let treasury: Keypair;
  let secondSigner: Keypair;
  let creator: Keypair;
  let worker: Keypair;
  let creatorAgentId: Buffer;
  let workerAgentId: Buffer;

  before(async () => {
    treasury = Keypair.generate();
    secondSigner = Keypair.generate();
    creator = Keypair.generate();
    worker = Keypair.generate();
    creatorAgentId = makeAgentId("cub", runId);
    workerAgentId = makeAgentId("wub", runId);

    // Fund wallets
    const airdropAmount = 100 * LAMPORTS_PER_SOL;
    const wallets = [treasury, secondSigner, creator, worker];
    const sigs = await Promise.all(
      wallets.map((w) =>
        provider.connection.requestAirdrop(w.publicKey, airdropAmount)
      )
    );
    await Promise.all(
      sigs.map((s) => provider.connection.confirmTransaction(s, "confirmed"))
    );

    // Initialize protocol
    try {
      const minStake = new BN(LAMPORTS_PER_SOL / 100);
      await program.methods
        .initializeProtocol(
          51,
          100,
          minStake,
          minStake,
          1,
          [provider.wallet.publicKey, secondSigner.publicKey]
        )
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([secondSigner])
        .rpc();
    } catch {
      // Already initialized
    }

    // Disable rate limiting
    try {
      await program.methods
        .updateRateLimits(new BN(0), 0, new BN(0), 0, new BN(0))
        .accountsPartial({ protocolConfig: protocolPda })
        .remainingAccounts([
          {
            pubkey: provider.wallet.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ])
        .rpc({ skipPreflight: true });
    } catch {
      // May already be configured
    }
  });

  it("benchmarks register_agent CU", async () => {
    const agentPda = deriveAgentPda(creatorAgentId, program.programId);
    const sig = await program.methods
      .registerAgent(
        Array.from(creatorAgentId),
        new BN(CAPABILITY_COMPUTE),
        "https://bench-creator.example.com",
        null,
        new BN(LAMPORTS_PER_SOL / 100)
      )
      .accountsPartial({
        agent: agentPda,
        protocolConfig: protocolPda,
        authority: creator.publicKey,
      })
      .signers([creator])
      .rpc({ skipPreflight: true });

    const logs = await getTxLogs(provider.connection, sig);
    const cu = extractComputeUnits(logs);

    if (cu !== null) {
      benchmarkResults.push({
        instruction: "register_agent",
        consumedCU: cu,
        recommendedCU: RECOMMENDED_CU.register_agent,
        withinBudget: cu <= RECOMMENDED_CU.register_agent,
      });
      console.log(
        `    register_agent: ${cu} CU (budget: ${RECOMMENDED_CU.register_agent})`
      );
    }
  });

  it("benchmarks register_agent (worker) CU", async () => {
    const agentPda = deriveAgentPda(workerAgentId, program.programId);
    const sig = await program.methods
      .registerAgent(
        Array.from(workerAgentId),
        new BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE),
        "https://bench-worker.example.com",
        null,
        new BN(LAMPORTS_PER_SOL / 100)
      )
      .accountsPartial({
        agent: agentPda,
        protocolConfig: protocolPda,
        authority: worker.publicKey,
      })
      .signers([worker])
      .rpc({ skipPreflight: true });

    const logs = await getTxLogs(provider.connection, sig);
    const cu = extractComputeUnits(logs);
    if (cu !== null) {
      console.log(`    register_agent (worker): ${cu} CU`);
    }
  });

  it("benchmarks create_task CU", async () => {
    const taskId = Buffer.alloc(32);
    taskId.write("cu_bench_task_" + runId);

    const taskPda = deriveTaskPda(creator.publicKey, taskId, program.programId);
    const escrowPda = deriveEscrowPda(taskPda, program.programId);
    const creatorAgentPda = deriveAgentPda(creatorAgentId, program.programId);

    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const sig = await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Array.from(Buffer.alloc(64, 1)),
        new BN(LAMPORTS_PER_SOL / 10),
        1,
        new BN(deadline),
        0, // Exclusive
        null // No constraint hash
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc({ skipPreflight: true });

    const logs = await getTxLogs(provider.connection, sig);
    const cu = extractComputeUnits(logs);

    if (cu !== null) {
      benchmarkResults.push({
        instruction: "create_task",
        consumedCU: cu,
        recommendedCU: RECOMMENDED_CU.create_task,
        withinBudget: cu <= RECOMMENDED_CU.create_task,
      });
      console.log(
        `    create_task: ${cu} CU (budget: ${RECOMMENDED_CU.create_task})`
      );
    }
  });

  it("benchmarks claim_task CU", async () => {
    const taskId = Buffer.alloc(32);
    taskId.write("cu_bench_task_" + runId);

    const taskPda = deriveTaskPda(creator.publicKey, taskId, program.programId);
    const workerAgentPda = deriveAgentPda(workerAgentId, program.programId);
    const claimPda = deriveClaimPda(
      taskPda,
      workerAgentPda,
      program.programId
    );

    const sig = await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        protocolConfig: protocolPda,
        worker: workerAgentPda,
        authority: worker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker])
      .rpc({ skipPreflight: true });

    const logs = await getTxLogs(provider.connection, sig);
    const cu = extractComputeUnits(logs);

    if (cu !== null) {
      benchmarkResults.push({
        instruction: "claim_task",
        consumedCU: cu,
        recommendedCU: RECOMMENDED_CU.claim_task,
        withinBudget: cu <= RECOMMENDED_CU.claim_task,
      });
      console.log(
        `    claim_task: ${cu} CU (budget: ${RECOMMENDED_CU.claim_task})`
      );
    }
  });

  it("benchmarks complete_task CU", async () => {
    const taskId = Buffer.alloc(32);
    taskId.write("cu_bench_task_" + runId);

    const taskPda = deriveTaskPda(creator.publicKey, taskId, program.programId);
    const escrowPda = deriveEscrowPda(taskPda, program.programId);
    const workerAgentPda = deriveAgentPda(workerAgentId, program.programId);
    const claimPda = deriveClaimPda(
      taskPda,
      workerAgentPda,
      program.programId
    );

    const protocolConfig = await program.account.protocolConfig.fetch(
      protocolPda
    );

    const proofHash = Buffer.alloc(32, 0xab);
    const resultData = Buffer.alloc(64, 0xcd);

    const sig = await program.methods
      .completeTask(Array.from(proofHash), Array.from(resultData))
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        escrow: escrowPda,
        creator: creator.publicKey,
        worker: workerAgentPda,
        protocolConfig: protocolPda,
        treasury: protocolConfig.treasury,
        authority: worker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker])
      .rpc({ skipPreflight: true });

    const logs = await getTxLogs(provider.connection, sig);
    const cu = extractComputeUnits(logs);

    if (cu !== null) {
      benchmarkResults.push({
        instruction: "complete_task",
        consumedCU: cu,
        recommendedCU: RECOMMENDED_CU.complete_task,
        withinBudget: cu <= RECOMMENDED_CU.complete_task,
      });
      console.log(
        `    complete_task: ${cu} CU (budget: ${RECOMMENDED_CU.complete_task})`
      );
    }
  });

  after(() => {
    if (benchmarkResults.length === 0) return;

    console.log("\n    === CU Benchmark Summary ===");
    console.log(
      "    " +
        "Instruction".padEnd(25) +
        "Consumed".padStart(10) +
        "Budget".padStart(10) +
        "  Status"
    );
    console.log("    " + "-".repeat(60));

    let allWithinBudget = true;
    for (const r of benchmarkResults) {
      const status = r.withinBudget ? "OK" : "OVER";
      if (!r.withinBudget) allWithinBudget = false;
      console.log(
        "    " +
          r.instruction.padEnd(25) +
          r.consumedCU.toString().padStart(10) +
          r.recommendedCU.toString().padStart(10) +
          `  ${status}`
      );
    }
    console.log("    " + "-".repeat(60));

    // Verify none exceed mainnet 1.4M limit
    const maxCU = Math.max(...benchmarkResults.map((r) => r.consumedCU));
    console.log(`    Max CU consumed: ${maxCU} (mainnet limit: 1,400,000)`);
    expect(maxCU).to.be.lessThan(
      1_400_000,
      "Instruction exceeds mainnet CU limit"
    );
  });
});
