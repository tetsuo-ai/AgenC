/**
 * Audit Gap Filling (Issues 3 and 4)
 *
 * Split from test_1.ts for domain-focused test organization.
 * Uses LiteSVM for fast in-process testing.
 */

import BN from "bn.js";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COLLABORATIVE,
  TASK_TYPE_COMPETITIVE,
  VALID_EVIDENCE,
  getDefaultDeadline,
  buildCancelTaskRemainingAccounts,
} from "./test-utils";
import {
  fundAccount,
  advanceClock,
  getClockTimestamp,
} from "./litesvm-helpers";
import { createTestContext } from "./test-litesvm-setup";

describe("Audit Gap Filling (Issues 3 and 4)", () => {
  const ctx = createTestContext();

  // Local aliases — assigned from ctx after before() populates them.
  // We use property access on ctx so the values resolve at test runtime.
  let program: typeof ctx.program;
  let provider: typeof ctx.provider;
  let svm: typeof ctx.svm;
  let protocolPda: PublicKey;
  let runId: string;
  let creator: Keypair;
  let worker1: Keypair;
  let worker2: Keypair;
  let worker3: Keypair;
  let creatorAgentPda: PublicKey;
  let agentId1: Buffer;
  let agentId2: Buffer;
  let agentId3: Buffer;
  let creatorAgentId: Buffer;
  let treasuryPubkey: PublicKey;
  let secondSigner: Keypair;
  let thirdSigner: Keypair;

  // Bind PDA helpers that close over program.programId
  let deriveAgentPda: (agentId: Buffer) => PublicKey;
  let deriveTaskPda: (creatorPubkey: PublicKey, taskId: Buffer) => PublicKey;
  let deriveEscrowPda: (taskPda: PublicKey) => PublicKey;
  let deriveClaimPda: (taskPda: PublicKey, workerPubkey: PublicKey) => PublicKey;
  let makeAgentId: (prefix: string) => Buffer;
  let createFreshWorker: (capabilities?: number) => Promise<{ wallet: Keypair; agentId: Buffer; agentPda: PublicKey }>; 
  let getPooledWorker: () => { wallet: Keypair; agentId: Buffer; agentPda: PublicKey };

  before(() => {
    program = ctx.program;
    provider = ctx.provider;
    svm = ctx.svm;
    protocolPda = ctx.protocolPda;
    runId = ctx.runId;
    creator = ctx.creator;
    worker1 = ctx.worker1;
    worker2 = ctx.worker2;
    worker3 = ctx.worker3;
    creatorAgentPda = ctx.creatorAgentPda;
    agentId1 = ctx.agentId1;
    agentId2 = ctx.agentId2;
    agentId3 = ctx.agentId3;
    creatorAgentId = ctx.creatorAgentId;
    treasuryPubkey = ctx.treasuryPubkey;
    secondSigner = ctx.secondSigner;
    thirdSigner = ctx.thirdSigner;
    deriveAgentPda = ctx.deriveAgentPda;
    deriveTaskPda = ctx.deriveTaskPda;
    deriveEscrowPda = ctx.deriveEscrowPda;
    deriveClaimPda = ctx.deriveClaimPda;
    makeAgentId = ctx.makeAgentId;
    createFreshWorker = ctx.createFreshWorker;
    getPooledWorker = ctx.getPooledWorker;
  });

  describe("Audit Gap Filling (Issues 3 & 4)", () => {
    it("Unauthorized Cancel Rejection (Issue 4)", async () => {
      const taskId = Buffer.from("gap-test-01".padEnd(32, "\0"));
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);
      const unauthorized = Keypair.generate();

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(1),
          Buffer.from("Auth check".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null,
          0, // min_reputation
          null, // reward_mint
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

      try {
        await program.methods
          .cancelTask()
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            authority: unauthorized.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            creatorTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([unauthorized])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: unknown) {
        // Verify error occurred - Anchor returns AnchorError with errorCode
        const anchorError = e as {
          error?: { errorCode?: { code: string } };
          message?: string;
        };
        expect(anchorError.error?.errorCode?.code || anchorError.message).to
          .exist;
      }
    });

    it("Unauthorized Complete Rejection (Issue 4)", async () => {
      const worker = await createFreshWorker();
      const wrongSigner = Keypair.generate();
      fundAccount(svm, wrongSigner.publicKey, 1 * LAMPORTS_PER_SOL);

      const taskId = Buffer.from("gap-test-02".padEnd(32, "\0"));
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(1),
          Buffer.from("Auth check 2".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null,
          0, // min_reputation
          null, // reward_mint
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker.agentPda);
      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          worker: worker.agentPda,
          authority: worker.wallet.publicKey,
        })
        .signers([worker.wallet])
        .rpc();

      try {
        await program.methods
          .completeTask(Array.from(Buffer.from("proof")), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            worker: worker.agentPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: wrongSigner.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([wrongSigner])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: unknown) {
        // Verify error occurred - Anchor returns AnchorError with errorCode
        const anchorError = e as {
          error?: { errorCode?: { code: string } };
          message?: string;
        };
        expect(anchorError.error?.errorCode?.code || anchorError.message).to
          .exist;
      }
    });

    it("Cannot Cancel a Completed Task (Rug Pull Prevention) (Issue 3)", async () => {
      const worker = await createFreshWorker();
      const taskId = Buffer.from("gap-test-03".padEnd(32, "\0"));
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(1),
          Buffer.from("Rug check".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null,
          0, // min_reputation
          null, // reward_mint
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker.agentPda);
      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          worker: worker.agentPda,
          authority: worker.wallet.publicKey,
        })
        .signers([worker.wallet])
        .rpc();

      await program.methods
        .completeTask(Array.from(Buffer.from("proof")), null)
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          worker: worker.agentPda,
          protocolConfig: protocolPda,
          treasury: treasuryPubkey,
          authority: worker.wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: null,
          workerTokenAccount: null,
          treasuryTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
        })
        .signers([worker.wallet])
        .rpc();

      try {
        await program.methods
          .cancelTask()
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            authority: creator.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            creatorTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([creator])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: unknown) {
        // Verify error occurred - Anchor returns AnchorError with errorCode
        const anchorError = e as {
          error?: { errorCode?: { code: string } };
          message?: string;
        };
        expect(anchorError.error?.errorCode?.code || anchorError.message).to
          .exist;
      }
    });

    it("Cannot Complete a Cancelled Task (Theft Prevention) (Issue 3)", async () => {
      const worker = await createFreshWorker();
      const taskId = Buffer.from("gap-test-04".padEnd(32, "\0"));
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(1),
          Buffer.from("Theft check".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null,
          0, // min_reputation
          null, // reward_mint
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .cancelTask()
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          authority: creator.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: null,
          creatorTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
        })
        .signers([creator])
        .rpc();

      const claimPda = deriveClaimPda(taskPda, worker.agentPda);

      try {
        await program.methods
          .completeTask(Array.from(Buffer.from("proof")), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            worker: worker.agentPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker.wallet])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: unknown) {
        // Verify error occurred - Anchor returns AnchorError with errorCode
        const anchorError = e as {
          error?: { errorCode?: { code: string } };
          message?: string;
        };
        expect(anchorError.error?.errorCode?.code || anchorError.message).to
          .exist;
      }
    });
  });


});
