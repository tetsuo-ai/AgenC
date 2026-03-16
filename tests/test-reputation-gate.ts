/**
 * Reputation System Tests
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
} from "./test-utils.ts";
import {
  fundAccount,
  advanceClock,
  getClockTimestamp,
} from "./litesvm-helpers.ts";
import { createTestContext } from "./test-litesvm-setup.ts";

describe("Reputation System Tests", () => {
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

  describe("Reputation System", () => {
    describe("Reputation gate on claim_task", () => {
      it("rejects claim when worker reputation is below task min_reputation", async () => {
        const {
          wallet: w,
          agentId: wId,
          agentPda: wPda,
        } = await createFreshWorker(CAPABILITY_COMPUTE);

        // Create task with min_reputation = 6000 (default agent rep is 5000)
        const taskId = makeAgentId(`rep-gate`);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Reputation gated task".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null, // constraint_hash
            6000, // min_reputation (worker has 5000)
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

        const claimPda = deriveClaimPda(taskPda, wPda);
        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              protocolConfig: protocolPda,
              worker: wPda,
              authority: w.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([w])
            .rpc();
          expect.fail("Should have failed with InsufficientReputation");
        } catch (e: any) {
          expect(e.message).to.include("InsufficientReputation");
        }
      });

      it("allows claim when worker reputation meets task min_reputation", async () => {
        const {
          wallet: w,
          agentId: wId,
          agentPda: wPda,
        } = await createFreshWorker(CAPABILITY_COMPUTE);

        // Create task with min_reputation = 5000 (default agent rep is 5000)
        const taskId = makeAgentId(`rep-ok`);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Reputation ok task".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null, // constraint_hash
            5000, // min_reputation (worker has exactly 5000)
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

        const claimPda = deriveClaimPda(taskPda, wPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            protocolConfig: protocolPda,
            worker: wPda,
            authority: w.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([w])
          .rpc();

        // Verify claim succeeded
        const taskAccount = await program.account.task.fetch(taskPda);
        expect(taskAccount.currentWorkers).to.equal(1);
      });

      it("allows claim when min_reputation is 0 (no gate)", async () => {
        const {
          wallet: w,
          agentId: wId,
          agentPda: wPda,
        } = await createFreshWorker(CAPABILITY_COMPUTE);

        const taskId = makeAgentId(`rep-0`);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("No reputation gate".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null, // constraint_hash
            0, // min_reputation (no gate)
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

        const claimPda = deriveClaimPda(taskPda, wPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            protocolConfig: protocolPda,
            worker: wPda,
            authority: w.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([w])
          .rpc();

        const taskAccount = await program.account.task.fetch(taskPda);
        expect(taskAccount.currentWorkers).to.equal(1);
      });
    });

    describe("Task creation validation", () => {
      it("rejects min_reputation > 10000 (InvalidMinReputation)", async () => {
        const taskId = makeAgentId(`rep-inv`);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        try {
          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("Invalid rep task".padEnd(64, "\0")),
              new BN(LAMPORTS_PER_SOL / 100),
              1,
              getDefaultDeadline(),
              TASK_TYPE_EXCLUSIVE,
              null, // constraint_hash
              10001, // min_reputation > MAX_REPUTATION
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
          expect.fail("Should have failed with InvalidMinReputation");
        } catch (e: any) {
          expect(e.message).to.include("InvalidMinReputation");
        }
      });

      it("stores min_reputation on task account", async () => {
        const taskId = makeAgentId(`rep-str`);
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Stored rep task".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null, // constraint_hash
            7500, // min_reputation
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

        const taskAccount = await program.account.task.fetch(taskPda);
        expect(taskAccount.minReputation).to.equal(7500);
      });
    });
  });

});
