/**
 * Shared LiteSVM test setup for AgenC integration test files split from test_1.ts.
 *
 * Provides a reusable test context with:
 * - LiteSVM instance with funded wallets
 * - Protocol initialization
 * - Agent registration (creator + 3 workers)
 * - Worker pool for fast test execution
 * - PDA helper functions scoped to the program
 *
 * Usage:
 *   import { createTestContext, LiteSVMTestContext } from "./test-litesvm-setup";
 *
 *   describe("My Tests", () => {
 *     const ctx = createTestContext();
 *     // ctx.svm, ctx.program, ctx.creator, etc. are available after before() runs
 *   });
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  generateRunId,
  getDefaultDeadline,
  deriveAgentPda as _deriveAgentPda,
  deriveTaskPda as _deriveTaskPda,
  deriveEscrowPda as _deriveEscrowPda,
  deriveClaimPda as _deriveClaimPda,
  deriveProgramDataPda,
  disableRateLimitsForTests,
} from "./test-utils";
import {
  createLiteSVMContext,
  fundAccount,
  advanceClock,
} from "./litesvm-helpers";
import type { LiteSVM } from "litesvm";

export interface LiteSVMTestContext {
  svm: LiteSVM;
  provider: anchor.AnchorProvider;
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  runId: string;
  treasury: Keypair;
  treasuryPubkey: PublicKey;
  secondSigner: Keypair;
  thirdSigner: Keypair;
  creator: Keypair;
  worker1: Keypair;
  worker2: Keypair;
  worker3: Keypair;
  creatorAgentPda: PublicKey;
  agentId1: Buffer;
  agentId2: Buffer;
  agentId3: Buffer;
  creatorAgentId: Buffer;
  workerPool: Array<{
    wallet: Keypair;
    agentId: Buffer;
    agentPda: PublicKey;
    inUse: boolean;
  }>;
  testAgentCounter: number;

  // PDA helpers scoped to program.programId
  deriveAgentPda(agentId: Buffer): PublicKey;
  deriveTaskPda(creatorPubkey: PublicKey, taskId: Buffer): PublicKey;
  deriveEscrowPda(taskPda: PublicKey): PublicKey;
  deriveClaimPda(taskPda: PublicKey, workerPubkey: PublicKey): PublicKey;
  makeAgentId(prefix: string): Buffer;
  createFreshWorker(capabilities?: number): Promise<{
    wallet: Keypair;
    agentId: Buffer;
    agentPda: PublicKey;
  }>;
  getPooledWorker(): {
    wallet: Keypair;
    agentId: Buffer;
    agentPda: PublicKey;
  };
}

const WORKER_POOL_SIZE = 50;

/**
 * Create a full LiteSVM test context with before()/beforeEach() hooks.
 * Call this inside a top-level describe() block.
 */
export function createTestContext(): LiteSVMTestContext {
  const { svm, provider, program } = createLiteSVMContext();

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId,
  );

  const runId = generateRunId();

  const ctx: LiteSVMTestContext = {
    svm,
    provider,
    program,
    protocolPda,
    runId,
    treasury: null as any,
    treasuryPubkey: null as any,
    secondSigner: null as any,
    thirdSigner: null as any,
    creator: null as any,
    worker1: null as any,
    worker2: null as any,
    worker3: null as any,
    creatorAgentPda: null as any,
    agentId1: null as any,
    agentId2: null as any,
    agentId3: null as any,
    creatorAgentId: null as any,
    workerPool: [],
    testAgentCounter: 0,

    deriveAgentPda(agentId: Buffer): PublicKey {
      return _deriveAgentPda(agentId, program.programId);
    },

    deriveTaskPda(creatorPubkey: PublicKey, taskId: Buffer): PublicKey {
      return _deriveTaskPda(creatorPubkey, taskId, program.programId);
    },

    deriveEscrowPda(taskPda: PublicKey): PublicKey {
      return _deriveEscrowPda(taskPda, program.programId);
    },

    deriveClaimPda(taskPda: PublicKey, workerPubkey: PublicKey): PublicKey {
      return _deriveClaimPda(taskPda, workerPubkey, program.programId);
    },

    makeAgentId(prefix: string): Buffer {
      return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
    },

    async createFreshWorker(
      capabilities: number = CAPABILITY_COMPUTE,
    ): Promise<{
      wallet: Keypair;
      agentId: Buffer;
      agentPda: PublicKey;
    }> {
      // Try to get from pool first (fast path)
      const poolWorker = ctx.workerPool.find((w) => !w.inUse);
      if (poolWorker) {
        poolWorker.inUse = true;
        return {
          wallet: poolWorker.wallet,
          agentId: poolWorker.agentId,
          agentPda: poolWorker.agentPda,
        };
      }

      // Fallback: create new worker
      ctx.testAgentCounter++;
      const wallet = Keypair.generate();
      const agentId = ctx.makeAgentId(`tw${ctx.testAgentCounter}`);
      const agentPda = ctx.deriveAgentPda(agentId);

      fundAccount(svm, wallet.publicKey, 5 * LAMPORTS_PER_SOL);

      await program.methods
        .registerAgent(
          Array.from(agentId),
          new BN(capabilities),
          `https://test-worker-${ctx.testAgentCounter}.example.com`,
          null,
          new BN(LAMPORTS_PER_SOL / 10),
        )
        .accountsPartial({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: wallet.publicKey,
        })
        .signers([wallet])
        .rpc({ skipPreflight: true });

      return { wallet, agentId, agentPda };
    },

    getPooledWorker(): {
      wallet: Keypair;
      agentId: Buffer;
      agentPda: PublicKey;
    } {
      const worker = ctx.workerPool.find((w) => !w.inUse);
      if (!worker) {
        throw new Error("Worker pool exhausted! Increase WORKER_POOL_SIZE");
      }
      worker.inUse = true;
      return {
        wallet: worker.wallet,
        agentId: worker.agentId,
        agentPda: worker.agentPda,
      };
    },
  };

  before(async () => {
    ctx.treasury = Keypair.generate();
    ctx.secondSigner = Keypair.generate();
    ctx.thirdSigner = Keypair.generate();
    ctx.creator = Keypair.generate();
    ctx.worker1 = Keypair.generate();
    ctx.worker2 = Keypair.generate();
    ctx.worker3 = Keypair.generate();

    ctx.agentId1 = Buffer.from(`ag1-${runId}`.padEnd(32, "\0"));
    ctx.agentId2 = Buffer.from(`ag2-${runId}`.padEnd(32, "\0"));
    ctx.agentId3 = Buffer.from(`ag3-${runId}`.padEnd(32, "\0"));
    ctx.creatorAgentId = Buffer.from(`cre-${runId}`.padEnd(32, "\0"));

    const airdropAmount = 100 * LAMPORTS_PER_SOL;
    const wallets = [
      ctx.treasury,
      ctx.secondSigner,
      ctx.thirdSigner,
      ctx.creator,
      ctx.worker1,
      ctx.worker2,
      ctx.worker3,
    ];

    for (const wallet of wallets) {
      fundAccount(svm, wallet.publicKey, airdropAmount);
    }

    try {
      const minStake = new BN(LAMPORTS_PER_SOL / 100);
      const minStakeForDispute = new BN(LAMPORTS_PER_SOL / 100);
      await program.methods
        .initializeProtocol(
          51,
          100,
          minStake,
          minStakeForDispute,
          2,
          [provider.wallet.publicKey, ctx.secondSigner.publicKey, ctx.thirdSigner.publicKey],
        )
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: ctx.secondSigner.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: ctx.secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: deriveProgramDataPda(program.programId),
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
      ctx.treasuryPubkey = ctx.secondSigner.publicKey;
    } catch (e: unknown) {
      const protocolConfig =
        await program.account.protocolConfig.fetch(protocolPda);
      ctx.treasuryPubkey = protocolConfig.treasury;
    }

    await disableRateLimitsForTests({
      program,
      protocolPda,
      authority: provider.wallet.publicKey,
      additionalSigners: [ctx.secondSigner],
    });

    ctx.creatorAgentPda = ctx.deriveAgentPda(ctx.creatorAgentId);

    const agents = [
      {
        id: ctx.creatorAgentId,
        capabilities: CAPABILITY_COMPUTE,
        endpoint: "https://creator.example.com",
        wallet: ctx.creator,
      },
      {
        id: ctx.agentId1,
        capabilities: CAPABILITY_COMPUTE | CAPABILITY_INFERENCE,
        endpoint: "https://worker1.example.com",
        wallet: ctx.worker1,
      },
      {
        id: ctx.agentId2,
        capabilities: CAPABILITY_COMPUTE,
        endpoint: "https://worker2.example.com",
        wallet: ctx.worker2,
      },
      {
        id: ctx.agentId3,
        capabilities: CAPABILITY_COMPUTE,
        endpoint: "https://worker3.example.com",
        wallet: ctx.worker3,
      },
    ];

    for (const agent of agents) {
      try {
        await program.methods
          .registerAgent(
            Array.from(agent.id),
            new BN(agent.capabilities),
            agent.endpoint,
            null,
            new BN(LAMPORTS_PER_SOL / 100),
          )
          .accountsPartial({
            agent: ctx.deriveAgentPda(agent.id),
            protocolConfig: protocolPda,
            authority: agent.wallet.publicKey,
          })
          .signers([agent.wallet])
          .rpc({ skipPreflight: true });
      } catch (e: any) {
        if (!e.message?.includes("already in use")) {
          throw e;
        }
      }
    }

    // Initialize worker pool
    const poolWallets: Keypair[] = [];
    for (let i = 0; i < WORKER_POOL_SIZE; i++) {
      const wallet = Keypair.generate();
      poolWallets.push(wallet);
      fundAccount(svm, wallet.publicKey, 10 * LAMPORTS_PER_SOL);
    }

    const registerPromises = poolWallets.map(async (wallet, i) => {
      const agentId = ctx.makeAgentId(`pool${i}`);
      const agentPda = ctx.deriveAgentPda(agentId);

      await program.methods
        .registerAgent(
          Array.from(agentId),
          new BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE),
          `https://pool-worker-${i}.example.com`,
          null,
          new BN(LAMPORTS_PER_SOL / 10),
        )
        .accountsPartial({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: wallet.publicKey,
        })
        .signers([wallet])
        .rpc({ skipPreflight: true });

      ctx.workerPool.push({ wallet, agentId, agentPda, inUse: false });
    });

    await Promise.all(registerPromises);
  });

  beforeEach(async () => {
    advanceClock(svm, 2);

    const agentsToCheck = [
      {
        id: ctx.agentId1,
        wallet: ctx.worker1,
        name: "agentId1",
        capabilities: CAPABILITY_COMPUTE | CAPABILITY_INFERENCE,
        endpoint: "https://worker1.example.com",
      },
      {
        id: ctx.agentId2,
        wallet: ctx.worker2,
        name: "agentId2",
        capabilities: CAPABILITY_COMPUTE,
        endpoint: "https://worker2.example.com",
      },
      {
        id: ctx.agentId3,
        wallet: ctx.worker3,
        name: "agentId3",
        capabilities: CAPABILITY_COMPUTE,
        endpoint: "https://worker3.example.com",
      },
      {
        id: ctx.creatorAgentId,
        wallet: ctx.creator,
        name: "creatorAgentId",
        capabilities: CAPABILITY_COMPUTE,
        endpoint: "https://creator.example.com",
      },
    ];

    const failedAgents: string[] = [];

    for (const agent of agentsToCheck) {
      const agentPda = ctx.deriveAgentPda(agent.id);
      try {
        const agentAccount =
          await program.account.agentRegistration.fetch(agentPda);

        if (agentAccount.status && "inactive" in agentAccount.status) {
          advanceClock(svm, 61);
          await program.methods
            .updateAgent(null, null, null, 1)
            .accountsPartial({
              agent: agentPda,
              authority: agent.wallet.publicKey,
            })
            .signers([agent.wallet])
            .rpc();
        }
      } catch (e: any) {
        try {
          await program.methods
            .registerAgent(
              Array.from(agent.id),
              new BN(agent.capabilities),
              agent.endpoint,
              null,
              new BN(LAMPORTS_PER_SOL / 100),
            )
            .accountsPartial({
              agent: agentPda,
              protocolConfig: protocolPda,
              authority: agent.wallet.publicKey,
            })
            .signers([agent.wallet])
            .rpc({ skipPreflight: true });
        } catch (regError: any) {
          if (!regError.message?.includes("already in use")) {
            failedAgents.push(agent.name);
            console.error(
              `Failed to register agent ${agent.name}:`,
              regError.message,
            );
          }
        }
      }
    }

    if (failedAgents.length > 0) {
      throw new Error(`Failed to register agents: ${failedAgents.join(", ")}`);
    }
  });

  return ctx;
}
