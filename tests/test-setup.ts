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

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
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
  createWorkerPool,
  getWorkerFromPool,
  PooledWorker,
} from "./test-utils";

export interface TestContext {
  provider: anchor.AnchorProvider;
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  runId: string;
  treasury: Keypair;
  treasuryPubkey: PublicKey;
  secondSigner: Keypair;
  creator: Keypair;
  worker1: Keypair;
  worker2: Keypair;
  worker3: Keypair;
  creatorAgentId: Buffer;
  creatorAgentPda: PublicKey;
  agentId1: Buffer;
  agentId2: Buffer;
  agentId3: Buffer;
  workerPool: PooledWorker[];
}

/**
 * Set up the shared test context with before() and beforeEach() hooks.
 * Handles protocol initialization, agent registration, and worker pool creation.
 *
 * @param ctx - Mutable context object that will be populated with test state
 */
export function setupTestContext(ctx: TestContext): void {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;
  const protocolPda = deriveProtocolPda(program.programId);
  const runId = generateRunId();

  // Set immediately available fields
  Object.assign(ctx, { provider, program, protocolPda, runId });

  before(async () => {
    ctx.treasury = Keypair.generate();
    ctx.secondSigner = Keypair.generate();
    ctx.creator = Keypair.generate();
    ctx.worker1 = Keypair.generate();
    ctx.worker2 = Keypair.generate();
    ctx.worker3 = Keypair.generate();

    ctx.agentId1 = makeAgentId("ag1", runId);
    ctx.agentId2 = makeAgentId("ag2", runId);
    ctx.agentId3 = makeAgentId("ag3", runId);
    ctx.creatorAgentId = makeAgentId("cre", runId);
    ctx.creatorAgentPda = deriveAgentPda(ctx.creatorAgentId, program.programId);

    // Fund wallets
    const airdropAmount = 100 * LAMPORTS_PER_SOL;
    const wallets = [ctx.treasury, ctx.secondSigner, ctx.creator, ctx.worker1, ctx.worker2, ctx.worker3];
    const airdropSigs = await Promise.all(
      wallets.map(wallet => provider.connection.requestAirdrop(wallet.publicKey, airdropAmount))
    );
    await Promise.all(airdropSigs.map(sig => provider.connection.confirmTransaction(sig, "confirmed")));

    // Initialize protocol
    try {
      const minStake = new BN(LAMPORTS_PER_SOL / 100);
      const minStakeForDispute = new BN(LAMPORTS_PER_SOL / 100);
      await program.methods
        .initializeProtocol(51, 100, minStake, minStakeForDispute, 1, [provider.wallet.publicKey, ctx.secondSigner.publicKey])
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: ctx.treasury.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: ctx.secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.secondSigner])
        .rpc();
      ctx.treasuryPubkey = ctx.treasury.publicKey;
    } catch {
      const protocolConfig = await program.account.protocolConfig.fetch(protocolPda);
      ctx.treasuryPubkey = protocolConfig.treasury;
    }

    // Disable rate limiting for tests
    try {
      await program.methods
        .updateRateLimits(new BN(0), 0, new BN(0), 0, new BN(0))
        .accountsPartial({ protocolConfig: protocolPda })
        .remainingAccounts([{ pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false }])
        .rpc({ skipPreflight: true });
    } catch {
      // May already be configured
    }

    // Register agents
    const agents = [
      { id: ctx.creatorAgentId, capabilities: CAPABILITY_COMPUTE, endpoint: "https://creator.example.com", wallet: ctx.creator },
      { id: ctx.agentId1, capabilities: CAPABILITY_COMPUTE | CAPABILITY_INFERENCE, endpoint: "https://worker1.example.com", wallet: ctx.worker1 },
      { id: ctx.agentId2, capabilities: CAPABILITY_COMPUTE, endpoint: "https://worker2.example.com", wallet: ctx.worker2 },
      { id: ctx.agentId3, capabilities: CAPABILITY_COMPUTE, endpoint: "https://worker3.example.com", wallet: ctx.worker3 },
    ];

    for (const agent of agents) {
      try {
        await program.methods
          .registerAgent(Array.from(agent.id), new BN(agent.capabilities), agent.endpoint, null, new BN(LAMPORTS_PER_SOL / 100))
          .accountsPartial({ agent: deriveAgentPda(agent.id, program.programId), protocolConfig: protocolPda, authority: agent.wallet.publicKey })
          .signers([agent.wallet])
          .rpc({ skipPreflight: true });
      } catch (e: any) {
        if (!e.message?.includes("already in use")) throw e;
      }
    }

    // Initialize worker pool
    ctx.workerPool = await createWorkerPool(program, provider, protocolPda, 20, runId);
  });

  beforeEach(async () => {
    const agentsToCheck = [
      { id: ctx.agentId1, wallet: ctx.worker1, capabilities: CAPABILITY_COMPUTE | CAPABILITY_INFERENCE, endpoint: "https://worker1.example.com" },
      { id: ctx.agentId2, wallet: ctx.worker2, capabilities: CAPABILITY_COMPUTE, endpoint: "https://worker2.example.com" },
      { id: ctx.agentId3, wallet: ctx.worker3, capabilities: CAPABILITY_COMPUTE, endpoint: "https://worker3.example.com" },
      { id: ctx.creatorAgentId, wallet: ctx.creator, capabilities: CAPABILITY_COMPUTE, endpoint: "https://creator.example.com" },
    ];

    for (const agent of agentsToCheck) {
      const agentPda = deriveAgentPda(agent.id, program.programId);
      try {
        const agentAccount = await program.account.agentRegistration.fetch(agentPda);
        if (agentAccount.status && 'inactive' in agentAccount.status) {
          await program.methods
            .updateAgent(null, null, null, 1)
            .accountsPartial({ agent: agentPda, authority: agent.wallet.publicKey })
            .signers([agent.wallet])
            .rpc();
        }
      } catch {
        try {
          await program.methods
            .registerAgent(Array.from(agent.id), new BN(agent.capabilities), agent.endpoint, null, new BN(LAMPORTS_PER_SOL / 100))
            .accountsPartial({ agent: agentPda, protocolConfig: protocolPda, authority: agent.wallet.publicKey })
            .signers([agent.wallet])
            .rpc({ skipPreflight: true });
        } catch (regError: any) {
          if (!regError.message?.includes("already in use")) {
            throw regError;
          }
        }
      }
    }
  });
}
