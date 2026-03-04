"use strict";
/**
 * Shared test setup for AgenC integration tests (issue #95).
 *
 * This module provides the shared before()/beforeEach() lifecycle that was
 * previously duplicated inside test_1.ts. New focused test files should import
 * this instead of duplicating the setup logic.
 *
 * Usage:
 *   import { setupTestContext, TestContext } from "./test-setup";
 *
 *   describe("My Test Suite", () => {
 *     const ctx: TestContext = {} as TestContext;
 *     setupTestContext(ctx);
 *
 *     it("should do something", async () => {
 *       // Use ctx.program, ctx.creator, ctx.worker1, etc.
 *     });
 *   });
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
exports.setupTestContext = setupTestContext;
const anchor = __importStar(require("@coral-xyz/anchor"));
const bn_js_1 = __importDefault(require("bn.js"));
const web3_js_1 = require("@solana/web3.js");
const test_utils_1 = require("./test-utils");
/**
 * Set up the shared test context with before() and beforeEach() hooks.
 * Handles protocol initialization, agent registration, and worker pool creation.
 *
 * @param ctx - Mutable context object that will be populated with test state
 */
function setupTestContext(ctx) {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
        .AgencCoordination;
    const protocolPda = (0, test_utils_1.deriveProtocolPda)(program.programId);
    const runId = (0, test_utils_1.generateRunId)();
    // Set immediately available fields
    Object.assign(ctx, { provider, program, protocolPda, runId });
    before(async () => {
        ctx.treasury = web3_js_1.Keypair.generate();
        ctx.secondSigner = web3_js_1.Keypair.generate();
        ctx.thirdSigner = web3_js_1.Keypair.generate();
        ctx.creator = web3_js_1.Keypair.generate();
        ctx.worker1 = web3_js_1.Keypair.generate();
        ctx.worker2 = web3_js_1.Keypair.generate();
        ctx.worker3 = web3_js_1.Keypair.generate();
        ctx.agentId1 = (0, test_utils_1.makeAgentId)("ag1", runId);
        ctx.agentId2 = (0, test_utils_1.makeAgentId)("ag2", runId);
        ctx.agentId3 = (0, test_utils_1.makeAgentId)("ag3", runId);
        ctx.creatorAgentId = (0, test_utils_1.makeAgentId)("cre", runId);
        ctx.creatorAgentPda = (0, test_utils_1.deriveAgentPda)(ctx.creatorAgentId, program.programId);
        // Fund wallets
        const airdropAmount = 100 * web3_js_1.LAMPORTS_PER_SOL;
        const wallets = [
            ctx.treasury,
            ctx.secondSigner,
            ctx.thirdSigner,
            ctx.creator,
            ctx.worker1,
            ctx.worker2,
            ctx.worker3,
        ];
        const airdropSigs = await Promise.all(wallets.map((wallet) => provider.connection.requestAirdrop(wallet.publicKey, airdropAmount)));
        await Promise.all(airdropSigs.map((sig) => provider.connection.confirmTransaction(sig, "confirmed")));
        // Initialize protocol
        try {
            const minStake = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100);
            const minStakeForDispute = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100);
            const programDataPda = (0, test_utils_1.deriveProgramDataPda)(program.programId);
            await program.methods
                .initializeProtocol(51, 100, minStake, minStakeForDispute, 2, [
                provider.wallet.publicKey,
                ctx.secondSigner.publicKey,
                ctx.thirdSigner.publicKey,
            ])
                .accountsPartial({
                protocolConfig: protocolPda,
                treasury: ctx.treasury.publicKey,
                authority: provider.wallet.publicKey,
                secondSigner: ctx.secondSigner.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .remainingAccounts([
                {
                    pubkey: (0, test_utils_1.deriveProgramDataPda)(program.programId),
                    isSigner: false,
                    isWritable: false,
                },
                {
                    pubkey: ctx.thirdSigner.publicKey,
                    isSigner: true,
                    isWritable: false,
                },
            ])
                .signers([ctx.secondSigner, ctx.thirdSigner])
                .rpc();
            ctx.treasuryPubkey = ctx.treasury.publicKey;
        }
        catch {
            const protocolConfig = await program.account.protocolConfig.fetch(protocolPda);
            ctx.treasuryPubkey = protocolConfig.treasury;
        }
        await (0, test_utils_1.disableRateLimitsForTests)({
            program,
            protocolPda,
            authority: provider.wallet.publicKey,
            additionalSigners: [ctx.secondSigner],
        });
        // Register agents
        const agents = [
            {
                id: ctx.creatorAgentId,
                capabilities: test_utils_1.CAPABILITY_COMPUTE,
                endpoint: "https://creator.example.com",
                wallet: ctx.creator,
            },
            {
                id: ctx.agentId1,
                capabilities: test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_INFERENCE,
                endpoint: "https://worker1.example.com",
                wallet: ctx.worker1,
            },
            {
                id: ctx.agentId2,
                capabilities: test_utils_1.CAPABILITY_COMPUTE,
                endpoint: "https://worker2.example.com",
                wallet: ctx.worker2,
            },
            {
                id: ctx.agentId3,
                capabilities: test_utils_1.CAPABILITY_COMPUTE,
                endpoint: "https://worker3.example.com",
                wallet: ctx.worker3,
            },
        ];
        for (const agent of agents) {
            await (0, test_utils_1.ensureAgentRegistered)({
                program,
                protocolPda,
                agentId: agent.id,
                authority: agent.wallet,
                capabilities: agent.capabilities,
                endpoint: agent.endpoint,
                stakeLamports: web3_js_1.LAMPORTS_PER_SOL / 100,
                skipPreflight: true,
            });
        }
        // Initialize worker pool
        ctx.workerPool = await (0, test_utils_1.createWorkerPool)(program, provider, protocolPda, 20, runId);
    });
    beforeEach(async () => {
        const agentsToCheck = [
            {
                id: ctx.agentId1,
                wallet: ctx.worker1,
                capabilities: test_utils_1.CAPABILITY_COMPUTE | test_utils_1.CAPABILITY_INFERENCE,
                endpoint: "https://worker1.example.com",
            },
            {
                id: ctx.agentId2,
                wallet: ctx.worker2,
                capabilities: test_utils_1.CAPABILITY_COMPUTE,
                endpoint: "https://worker2.example.com",
            },
            {
                id: ctx.agentId3,
                wallet: ctx.worker3,
                capabilities: test_utils_1.CAPABILITY_COMPUTE,
                endpoint: "https://worker3.example.com",
            },
            {
                id: ctx.creatorAgentId,
                wallet: ctx.creator,
                capabilities: test_utils_1.CAPABILITY_COMPUTE,
                endpoint: "https://creator.example.com",
            },
        ];
        for (const agent of agentsToCheck) {
            const agentPda = (0, test_utils_1.deriveAgentPda)(agent.id, program.programId);
            try {
                const agentAccount = await program.account.agentRegistration.fetch(agentPda);
                if (agentAccount.status && "inactive" in agentAccount.status) {
                    await program.methods
                        .updateAgent(null, null, null, 1)
                        .accountsPartial({
                        agent: agentPda,
                        authority: agent.wallet.publicKey,
                    })
                        .signers([agent.wallet])
                        .rpc();
                }
            }
            catch {
                await (0, test_utils_1.ensureAgentRegistered)({
                    program,
                    protocolPda,
                    agentId: agent.id,
                    authority: agent.wallet,
                    capabilities: agent.capabilities,
                    endpoint: agent.endpoint,
                    stakeLamports: web3_js_1.LAMPORTS_PER_SOL / 100,
                    skipPreflight: true,
                });
            }
        }
    });
}
