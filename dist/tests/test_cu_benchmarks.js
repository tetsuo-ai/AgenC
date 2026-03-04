"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const anchor = __importStar(require("@coral-xyz/anchor"));
const bn_js_1 = __importDefault(require("bn.js"));
const web3_js_1 = require("@solana/web3.js");
const chai_1 = require("chai");
const test_utils_1 = require("./test-utils");
/**
 * Extract compute units consumed from transaction logs.
 *
 * Looks for the pattern "consumed XXXXX of YYYYY compute units" in log messages
 * emitted by the Solana runtime.
 */
function extractComputeUnits(logs) {
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
async function getTxLogs(connection, signature) {
    const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
    });
    return tx?.meta?.logMessages || [];
}
describe("CU Benchmarks", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
        .AgencCoordination;
    const protocolPda = (0, test_utils_1.deriveProtocolPda)(program.programId);
    const runId = (0, test_utils_1.generateRunId)();
    // Benchmark results collected during test run
    const benchmarkResults = [];
    // Recommended CU budgets (must match compute_budget.rs)
    const RECOMMENDED_CU = {
        register_agent: 40000,
        update_agent: 20000,
        create_task: 50000,
        claim_task: 30000,
        complete_task: 60000,
        cancel_task: 40000,
    };
    let treasury;
    let secondSigner;
    let thirdSigner;
    let creator;
    let worker;
    let creatorAgentId;
    let workerAgentId;
    before(async () => {
        treasury = web3_js_1.Keypair.generate();
        secondSigner = web3_js_1.Keypair.generate();
        thirdSigner = web3_js_1.Keypair.generate();
        creator = web3_js_1.Keypair.generate();
        worker = web3_js_1.Keypair.generate();
        creatorAgentId = (0, test_utils_1.makeAgentId)("cub", runId);
        workerAgentId = (0, test_utils_1.makeAgentId)("wub", runId);
        // Fund wallets
        const airdropAmount = 100 * web3_js_1.LAMPORTS_PER_SOL;
        const wallets = [treasury, secondSigner, thirdSigner, creator, worker];
        const sigs = await Promise.all(wallets.map((w) => provider.connection.requestAirdrop(w.publicKey, airdropAmount)));
        await Promise.all(sigs.map((s) => provider.connection.confirmTransaction(s, "confirmed")));
        // Initialize protocol
        try {
            const minStake = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100);
            await program.methods
                .initializeProtocol(51, 100, minStake, minStake, 2, [
                provider.wallet.publicKey,
                secondSigner.publicKey,
                thirdSigner.publicKey,
            ])
                .accountsPartial({
                protocolConfig: protocolPda,
                treasury: secondSigner.publicKey,
                authority: provider.wallet.publicKey,
                secondSigner: secondSigner.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .remainingAccounts([
                {
                    pubkey: (0, test_utils_1.deriveProgramDataPda)(program.programId),
                    isSigner: false,
                    isWritable: false,
                },
                {
                    pubkey: thirdSigner.publicKey,
                    isSigner: true,
                    isWritable: false,
                },
            ])
                .signers([secondSigner, thirdSigner])
                .rpc();
        }
        catch {
            // Already initialized
        }
        // Disable rate limiting
        await (0, test_utils_1.disableRateLimitsForTests)({
            program,
            protocolPda,
            authority: provider.wallet.publicKey,
            additionalSigners: [secondSigner],
        });
    });
    it("benchmarks register_agent CU", async () => {
        const agentPda = (0, test_utils_1.deriveAgentPda)(creatorAgentId, program.programId);
        const sig = await program.methods
            .registerAgent(Array.from(creatorAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), "https://bench-creator.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
            .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: creator.publicKey,
        })
            .signers([creator])
            .rpc();
        const logs = await getTxLogs(provider.connection, sig);
        const cu = extractComputeUnits(logs);
        if (cu !== null) {
            benchmarkResults.push({
                instruction: "register_agent",
                consumedCU: cu,
                recommendedCU: RECOMMENDED_CU.register_agent,
                withinBudget: cu <= RECOMMENDED_CU.register_agent,
            });
            console.log(`    register_agent: ${cu} CU (budget: ${RECOMMENDED_CU.register_agent})`);
        }
    });
    it("benchmarks register_agent (worker) CU", async () => {
        const agentPda = (0, test_utils_1.deriveAgentPda)(workerAgentId, program.programId);
        const sig = await program.methods
            .registerAgent(Array.from(workerAgentId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_INFERENCE), "https://bench-worker.example.com", null, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
            .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: worker.publicKey,
        })
            .signers([worker])
            .rpc();
        const logs = await getTxLogs(provider.connection, sig);
        const cu = extractComputeUnits(logs);
        if (cu !== null) {
            console.log(`    register_agent (worker): ${cu} CU`);
        }
    });
    it("benchmarks create_task CU", async () => {
        const taskId = Buffer.alloc(32);
        taskId.write("cu_bench_task_" + runId);
        const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
        const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
        const creatorAgentPda = (0, test_utils_1.deriveAgentPda)(creatorAgentId, program.programId);
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const sig = await program.methods
            .createTask(Array.from(taskId), new bn_js_1.default(test_utils_1.CAPABILITY_COMPUTE), Array.from(Buffer.alloc(64, 1)), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 10), 1, new bn_js_1.default(deadline), 0, // Exclusive
        null, // No constraint hash
        0, // min_reputation
        null)
            .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
        })
            .signers([creator])
            .rpc();
        const logs = await getTxLogs(provider.connection, sig);
        const cu = extractComputeUnits(logs);
        if (cu !== null) {
            benchmarkResults.push({
                instruction: "create_task",
                consumedCU: cu,
                recommendedCU: RECOMMENDED_CU.create_task,
                withinBudget: cu <= RECOMMENDED_CU.create_task,
            });
            console.log(`    create_task: ${cu} CU (budget: ${RECOMMENDED_CU.create_task})`);
        }
    });
    it("benchmarks claim_task CU", async () => {
        const taskId = Buffer.alloc(32);
        taskId.write("cu_bench_task_" + runId);
        const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
        const workerAgentPda = (0, test_utils_1.deriveAgentPda)(workerAgentId, program.programId);
        const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, program.programId);
        const sig = await program.methods
            .claimTask()
            .accountsPartial({
            task: taskPda,
            claim: claimPda,
            protocolConfig: protocolPda,
            worker: workerAgentPda,
            authority: worker.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .signers([worker])
            .rpc();
        const logs = await getTxLogs(provider.connection, sig);
        const cu = extractComputeUnits(logs);
        if (cu !== null) {
            benchmarkResults.push({
                instruction: "claim_task",
                consumedCU: cu,
                recommendedCU: RECOMMENDED_CU.claim_task,
                withinBudget: cu <= RECOMMENDED_CU.claim_task,
            });
            console.log(`    claim_task: ${cu} CU (budget: ${RECOMMENDED_CU.claim_task})`);
        }
    });
    it("benchmarks complete_task CU", async () => {
        const taskId = Buffer.alloc(32);
        taskId.write("cu_bench_task_" + runId);
        const taskPda = (0, test_utils_1.deriveTaskPda)(creator.publicKey, taskId, program.programId);
        const escrowPda = (0, test_utils_1.deriveEscrowPda)(taskPda, program.programId);
        const workerAgentPda = (0, test_utils_1.deriveAgentPda)(workerAgentId, program.programId);
        const claimPda = (0, test_utils_1.deriveClaimPda)(taskPda, workerAgentPda, program.programId);
        const protocolConfig = await program.account.protocolConfig.fetch(protocolPda);
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
            systemProgram: web3_js_1.SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
        })
            .signers([worker])
            .rpc();
        const logs = await getTxLogs(provider.connection, sig);
        const cu = extractComputeUnits(logs);
        if (cu !== null) {
            benchmarkResults.push({
                instruction: "complete_task",
                consumedCU: cu,
                recommendedCU: RECOMMENDED_CU.complete_task,
                withinBudget: cu <= RECOMMENDED_CU.complete_task,
            });
            console.log(`    complete_task: ${cu} CU (budget: ${RECOMMENDED_CU.complete_task})`);
        }
    });
    after(() => {
        if (benchmarkResults.length === 0)
            return;
        console.log("\n    === CU Benchmark Summary ===");
        console.log("    " +
            "Instruction".padEnd(25) +
            "Consumed".padStart(10) +
            "Budget".padStart(10) +
            "  Status");
        console.log("    " + "-".repeat(60));
        let allWithinBudget = true;
        for (const r of benchmarkResults) {
            const status = r.withinBudget ? "OK" : "OVER";
            if (!r.withinBudget)
                allWithinBudget = false;
            console.log("    " +
                r.instruction.padEnd(25) +
                r.consumedCU.toString().padStart(10) +
                r.recommendedCU.toString().padStart(10) +
                `  ${status}`);
        }
        console.log("    " + "-".repeat(60));
        // Verify none exceed mainnet 1.4M limit
        const maxCU = Math.max(...benchmarkResults.map((r) => r.consumedCU));
        console.log(`    Max CU consumed: ${maxCU} (mainnet limit: 1,400,000)`);
        (0, chai_1.expect)(maxCU).to.be.lessThan(1400000, "Instruction exceeds mainnet CU limit");
    });
});
