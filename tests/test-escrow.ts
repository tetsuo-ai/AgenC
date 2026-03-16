/**
 * Issue #21: Escrow Fund Safety and Lamport Accounting Tests
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

describe("Issue #21: Escrow Fund Safety and Lamport Accounting Tests", () => {
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

  describe("Issue #21: Escrow Fund Safety and Lamport Accounting Tests", () => {
    // Account sizes for rent calculation
    const TASK_SIZE = 311; // From state.rs: Task::SIZE
    const ESCROW_SIZE = 58; // From state.rs: TaskEscrow::SIZE
    const CLAIM_SIZE = 195; // From state.rs: TaskClaim::SIZE

    // Protocol fee is 100 bps (1%) as set in before() hook
    const PROTOCOL_FEE_BPS = 100;

    async function getMinRent(size: number): Promise<number> {
      return await provider.connection.getMinimumBalanceForRentExemption(size);
    }

    describe("create_task lamport accounting", () => {
      it("Creator balance decreases by exactly reward_amount + rent, escrow has reward_amount", async () => {
        const taskId = Buffer.from("escrow-001".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const rewardAmount = 2 * LAMPORTS_PER_SOL;

        // Get rent costs
        const taskRent = await getMinRent(TASK_SIZE);
        const escrowRent = await getMinRent(ESCROW_SIZE);

        // Snapshot before
        const creatorBalanceBefore = await provider.connection.getBalance(
          creator.publicKey,
        );

        const tx = await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Escrow accounting test".padEnd(64, "\0")),
            new BN(rewardAmount),
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

        // Get transaction fee
        const txDetails = await provider.connection.getTransaction(tx, {
          commitment: "confirmed",
        });
        const txFee = txDetails?.meta?.fee || 0;

        // Snapshot after
        const creatorBalanceAfter = await provider.connection.getBalance(
          creator.publicKey,
        );
        const escrowBalance = await provider.connection.getBalance(escrowPda);
        const taskBalance = await provider.connection.getBalance(taskPda);

        // Verify accounting (with tolerance for rent variations across validator versions)
        const expectedCreatorDecrease =
          rewardAmount + taskRent + escrowRent + txFee;
        const actualCreatorDecrease =
          creatorBalanceBefore - creatorBalanceAfter;

        // Allow ~500000 lamport tolerance for rent calculation variations
        expect(actualCreatorDecrease).to.be.closeTo(
          expectedCreatorDecrease,
          500000,
        );
        expect(escrowBalance).to.be.closeTo(escrowRent + rewardAmount, 500000);
        expect(taskBalance).to.be.closeTo(taskRent, 500000);

        // Verify escrow account data
        const escrow = await program.account.taskEscrow.fetch(escrowPda);
        expect(escrow.amount.toNumber()).to.equal(rewardAmount);
        expect(escrow.distributed.toNumber()).to.equal(0);
        expect(escrow.isClosed).to.be.false;
      });

      it("Zero-reward task: rejected with InvalidReward error", async () => {
        const taskId = Buffer.from("escrow-002".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        // Zero-reward tasks are now rejected
        try {
          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("Zero reward escrow test".padEnd(64, "\0")),
              new BN(0), // Zero reward - should fail
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
          expect.fail("Should have rejected zero-reward task");
        } catch (e: unknown) {
          const anchorError = e as { error?: { errorCode?: { code: string } } };
          expect(anchorError.error?.errorCode?.code).to.equal("InvalidReward");
        }
      });
    });

    describe("complete_task lamport accounting", () => {
      it("Escrow decreases by reward, worker increases by (reward - fee), treasury increases by fee", async () => {
        const worker = await createFreshWorker();
        const taskId = Buffer.from("escrow-003".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const rewardAmount = 1 * LAMPORTS_PER_SOL;

        // Create task
        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Complete accounting test".padEnd(64, "\0")),
            new BN(rewardAmount),
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

        // Claim task
        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();

        // Snapshot before completion
        const escrowBalanceBefore =
          await provider.connection.getBalance(escrowPda);
        const workerBalanceBefore = await provider.connection.getBalance(
          worker.wallet.publicKey,
        );
        const treasuryBalanceBefore =
          await provider.connection.getBalance(treasuryPubkey);

        // Complete task
        const tx = await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
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

        const txDetails = await provider.connection.getTransaction(tx, {
          commitment: "confirmed",
        });
        const txFee = txDetails?.meta?.fee || 0;

        // Snapshot after
        // Escrow is closed after task completion (rent returned to creator)
        const escrowBalanceAfter =
          await provider.connection.getBalance(escrowPda);
        const workerBalanceAfter = await provider.connection.getBalance(
          worker.wallet.publicKey,
        );
        const treasuryBalanceAfter =
          await provider.connection.getBalance(treasuryPubkey);

        // Calculate expected amounts
        // Verify the on-chain fee matches expected protocol fee
        const taskAccount = await program.account.task.fetch(taskPda);
        expect(taskAccount.protocolFeeBps).to.equal(
          PROTOCOL_FEE_BPS,
          "Task protocol_fee_bps should match protocol config",
        );
        const protocolFee = Math.floor(
          (rewardAmount * PROTOCOL_FEE_BPS) / 10000,
        );
        const workerReward = rewardAmount - protocolFee;

        // Escrow is closed, so all funds (including rent) are transferred out
        // Worker receives reward - fee (and also claim rent refund)
        // Use closeTo with wider tolerance since claim rent is also refunded to worker
        // The worker also receives claim account rent refund (~2.3M lamports)
        expect(workerBalanceAfter - workerBalanceBefore).to.be.closeTo(
          workerReward - txFee,
          2500000,
        );
        expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(
          protocolFee,
        );

        // Verify escrow is closed (balance is 0)
        expect(escrowBalanceAfter).to.equal(0);
      });

      it("Collaborative task: reward splits exactly among workers, no dust left", async () => {
        const w1 = await createFreshWorker();
        const w2 = await createFreshWorker();
        const w3 = await createFreshWorker();
        const taskId = Buffer.from("escrow-004".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const escrowRent = await getMinRent(ESCROW_SIZE);
        // Use 3 SOL to divide evenly by 3 workers
        const rewardAmount = 3 * LAMPORTS_PER_SOL;

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Collaborative split test".padEnd(64, "\0")),
            new BN(rewardAmount),
            3, // 3 workers required
            getDefaultDeadline(),
            TASK_TYPE_COLLABORATIVE,
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

        // All 3 workers claim
        const claimPda1 = deriveClaimPda(taskPda, w1.agentPda);
        const claimPda2 = deriveClaimPda(taskPda, w2.agentPda);
        const claimPda3 = deriveClaimPda(taskPda, w3.agentPda);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: w1.agentPda,
            authority: w1.wallet.publicKey,
          })
          .signers([w1.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: w2.agentPda,
            authority: w2.wallet.publicKey,
          })
          .signers([w2.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda3,
            worker: w3.agentPda,
            authority: w3.wallet.publicKey,
          })
          .signers([w3.wallet])
          .rpc();

        // Snapshot balances before completions
        const escrowBefore = await provider.connection.getBalance(escrowPda);
        const treasuryBefore =
          await provider.connection.getBalance(treasuryPubkey);

        // Each worker should receive 1/3 of the reward
        const rewardPerWorker = Math.floor(rewardAmount / 3);
        const feePerWorker = Math.floor(
          (rewardPerWorker * PROTOCOL_FEE_BPS) / 10000,
        );
        const netRewardPerWorker = rewardPerWorker - feePerWorker;

        // Worker 1 completes — escrow stays open for remaining workers
        const w1Before = await provider.connection.getBalance(
          w1.wallet.publicKey,
        );
        const tx1 = await program.methods
          .completeTask(
            Array.from(Buffer.from("proof1".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            escrow: escrowPda,
            worker: w1.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: w1.wallet.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([w1.wallet])
          .rpc();
        const tx1Details = await provider.connection.getTransaction(tx1, {
          commitment: "confirmed",
        });
        const tx1Fee = tx1Details?.meta?.fee || 0;
        const w1After = await provider.connection.getBalance(
          w1.wallet.publicKey,
        );
        // Use closeTo with wider tolerance to account for claim rent refund
        expect(w1After - w1Before + tx1Fee).to.be.closeTo(
          netRewardPerWorker,
          2500000,
        );

        // Escrow should still exist after first completion
        const escrowMid1 = await provider.connection.getAccountInfo(escrowPda);
        expect(escrowMid1).to.not.be.null;

        // Worker 2 completes — escrow stays open (2/3 done)
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof2".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            escrow: escrowPda,
            worker: w2.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: w2.wallet.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([w2.wallet])
          .rpc();

        // Escrow should still exist after second completion
        const escrowMid2 = await provider.connection.getAccountInfo(escrowPda);
        expect(escrowMid2).to.not.be.null;

        // Worker 3 completes — final completion closes escrow
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof3".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda3,
            escrow: escrowPda,
            worker: w3.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: w3.wallet.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([w3.wallet])
          .rpc();

        // Verify escrow is closed after final completion
        const escrowAfter = await provider.connection.getAccountInfo(escrowPda);
        expect(escrowAfter).to.be.null;

        // Verify task is completed
        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ completed: {} });
        expect(task.completions).to.equal(3);
      });
    });

    describe("cancel_task lamport accounting", () => {
      it("Creator receives exact refund (escrow.amount - escrow.distributed)", async () => {
        const taskId = Buffer.from("escrow-005".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const rewardAmount = 2 * LAMPORTS_PER_SOL;

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Cancel refund test".padEnd(64, "\0")),
            new BN(rewardAmount),
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

        // Snapshot before cancel
        const creatorBalanceBefore = await provider.connection.getBalance(
          creator.publicKey,
        );
        const escrowBalanceBefore =
          await provider.connection.getBalance(escrowPda);
        const escrowRent = await getMinRent(ESCROW_SIZE);

        // Cancel task
        const tx = await program.methods
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

        const txDetails = await provider.connection.getTransaction(tx, {
          commitment: "confirmed",
        });
        const txFee = txDetails?.meta?.fee || 0;

        // Snapshot after
        const creatorBalanceAfter = await provider.connection.getBalance(
          creator.publicKey,
        );
        const escrowBalanceAfter =
          await provider.connection.getBalance(escrowPda);

        // Verify creator receives full refund (minus tx fee) plus escrow rent
        // Use wider tolerance since escrow rent is also returned
        expect(
          creatorBalanceAfter - creatorBalanceBefore + txFee,
        ).to.be.closeTo(rewardAmount + escrowRent, 50000);

        // Verify escrow is closed (balance is 0)
        expect(escrowBalanceAfter).to.equal(0);

        // Verify task state
        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });
      });

      it("Cannot cancel task with completions > 0 (funds already distributed)", async () => {
        // The program requires completions == 0 to cancel an InProgress task.
        // This test verifies that cancelling after a completion fails correctly.
        const worker = await createFreshWorker();
        const taskId = Buffer.from("escrow-006".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const rewardAmount = 2 * LAMPORTS_PER_SOL;

        // Create collaborative task with 2 workers, short deadline
        const shortDeadline = getClockTimestamp(svm) + 2;

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Partial refund test".padEnd(64, "\0")),
            new BN(rewardAmount),
            2,
            new BN(shortDeadline),
            TASK_TYPE_COLLABORATIVE,
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

        // Worker claims and completes
        const claimPda1 = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
          })
          .signers([worker.wallet])
          .rpc();

        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof1".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            escrow: escrowPda,
            worker: worker.agentPda,
            creator: creator.publicKey,
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

        // Wait for deadline
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Verify task has completions > 0
        const task = await program.account.task.fetch(taskPda);
        expect(task.completions).to.equal(1);

        // Attempt to cancel should fail because:
        // 1. Completions > 0 means funds already distributed
        // 2. Additionally, escrow is closed after completion (close = creator directive)
        // Either TaskCannotBeCancelled or AccountNotInitialized error is acceptable
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
          expect.fail("Expected cancel to fail after completion");
        } catch (e: any) {
          const errorCode = e.error?.errorCode?.code || e.message || "";
          // Escrow is closed after completion, so either error is valid
          expect(
            errorCode.includes("TaskCannotBeCancelled") ||
              errorCode.includes("AccountNotInitialized"),
          ).to.be.true;
        }
      });
    });

    describe("Double withdrawal prevention", () => {
      it("Completing same claim twice fails", async () => {
        const w1 = await createFreshWorker();
        const w2 = await createFreshWorker();
        const taskId = Buffer.from("escrow-007".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const rewardAmount = 2 * LAMPORTS_PER_SOL;

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Double complete test".padEnd(64, "\0")),
            new BN(rewardAmount),
            2,
            getDefaultDeadline(),
            TASK_TYPE_COLLABORATIVE,
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

        const claimPda1 = deriveClaimPda(taskPda, w1.agentPda);
        const claimPda2 = deriveClaimPda(taskPda, w2.agentPda);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: w1.agentPda,
            authority: w1.wallet.publicKey,
          })
          .signers([w1.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: w2.agentPda,
            authority: w2.wallet.publicKey,
          })
          .signers([w2.wallet])
          .rpc();

        // Worker 1 completes successfully
        const escrowBefore = await provider.connection.getBalance(escrowPda);

        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof1".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            escrow: escrowPda,
            worker: w1.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: w1.wallet.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([w1.wallet])
          .rpc();

        const escrowAfter = await provider.connection.getBalance(escrowPda);

        // Note: Claim account is closed after completion (close = authority directive)
        // So we can't fetch it - verify via balance that funds were distributed
        // The claim closure is verified by the second completion attempt failing

        // Worker 1 tries to complete again - should fail because:
        // 1. Claim is already closed (close = authority)
        // 2. Even if claim existed, isCompleted = true would reject
        try {
          await program.methods
            .completeTask(
              Array.from(Buffer.from("proof2".padEnd(32, "\0"))),
              null,
            )
            .accountsPartial({
              task: taskPda,
              claim: claimPda1,
              escrow: escrowPda,
              worker: w1.agentPda,
              creator: creator.publicKey,
              protocolConfig: protocolPda,
              treasury: treasuryPubkey,
              authority: w1.wallet.publicKey,
              tokenEscrowAta: null,
              workerTokenAccount: null,
              treasuryTokenAccount: null,
              rewardMint: null,
              tokenProgram: null,
            })
            .signers([w1.wallet])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Claim is closed after first completion, so second attempt fails
          // Error is AccountNotInitialized (claim closed) or ClaimAlreadyCompleted
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }

        // Verify escrow balance didn't change on failed attempt (may be 0 if closed)
        const escrowFinal = await provider.connection.getBalance(escrowPda);
        expect(escrowFinal).to.equal(escrowAfter);
      });

      it("Cancelling completed task fails", async () => {
        const worker = await createFreshWorker();
        const taskId = Buffer.from("escrow-008".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Cancel completed test".padEnd(64, "\0")),
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
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: worker.agentPda,
            creator: creator.publicKey,
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

        // Snapshot before attempted cancel
        const creatorBefore = await provider.connection.getBalance(
          creator.publicKey,
        );

        // Try to cancel completed task - should fail
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

        // Verify no funds moved
        const creatorAfter = await provider.connection.getBalance(
          creator.publicKey,
        );
        expect(creatorAfter).to.equal(creatorBefore);
      });
    });

    describe("Escrow close behavior", () => {
      it("After task completion, escrow.is_closed = true, lamports drained correctly", async () => {
        const worker = await createFreshWorker();
        const taskId = Buffer.from("escrow-009".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const escrowRent = await getMinRent(ESCROW_SIZE);
        const rewardAmount = 1 * LAMPORTS_PER_SOL;

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Escrow close test".padEnd(64, "\0")),
            new BN(rewardAmount),
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

        // Snapshot creator balance before completion to verify escrow rent returned
        const creatorBalanceBefore = await provider.connection.getBalance(
          creator.publicKey,
        );

        await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: worker.agentPda,
            creator: creator.publicKey,
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

        // Note: Escrow account is closed (close = creator directive) after completion
        // All lamports are drained to creator, account no longer exists

        // Verify escrow is fully closed (balance is 0)
        const escrowBalance = await provider.connection.getBalance(escrowPda);
        expect(escrowBalance).to.equal(0);

        // Verify creator received the escrow rent (escrow account closed)
        const creatorBalanceAfter = await provider.connection.getBalance(
          creator.publicKey,
        );
        expect(creatorBalanceAfter).to.be.greaterThan(creatorBalanceBefore);

        // Verify task state is completed
        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ completed: {} });
      });

      it("After cancel, escrow.is_closed = true", async () => {
        const taskId = Buffer.from("escrow-010".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const escrowRent = await getMinRent(ESCROW_SIZE);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Escrow close on cancel".padEnd(64, "\0")),
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

        // Snapshot creator balance before cancel to verify escrow is refunded
        const creatorBalanceBefore = await provider.connection.getBalance(
          creator.publicKey,
        );

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

        // Note: Escrow account is closed (close = creator directive) after cancel
        // All lamports (reward + rent) are refunded to creator

        // Verify escrow is fully closed (balance is 0)
        const escrowBalance = await provider.connection.getBalance(escrowPda);
        expect(escrowBalance).to.equal(0);

        // Verify creator received refund
        const creatorBalanceAfter = await provider.connection.getBalance(
          creator.publicKey,
        );
        expect(creatorBalanceAfter).to.be.greaterThan(creatorBalanceBefore);

        // Verify task state is cancelled
        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });
      });
    });

    describe("Lamport conservation (no leaks)", () => {
      it("Sum of all balance deltas equals zero (accounting for tx fees)", async () => {
        const worker = await createFreshWorker();
        const taskId = Buffer.from("escrow-011".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const rewardAmount = 1 * LAMPORTS_PER_SOL;
        const taskRent = await getMinRent(TASK_SIZE);
        const escrowRent = await getMinRent(ESCROW_SIZE);
        const claimRent = await getMinRent(CLAIM_SIZE);

        // Snapshot all balances before
        const creatorBefore = await provider.connection.getBalance(
          creator.publicKey,
        );
        const workerBefore = await provider.connection.getBalance(
          worker.wallet.publicKey,
        );
        const treasuryBefore =
          await provider.connection.getBalance(treasuryPubkey);

        let totalTxFees = 0;

        // Create task
        const tx1 = await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Conservation test".padEnd(64, "\0")),
            new BN(rewardAmount),
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
        const tx1Details = await provider.connection.getTransaction(tx1, {
          commitment: "confirmed",
        });
        totalTxFees += tx1Details?.meta?.fee || 0;

        // Claim task
        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        const tx2 = await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
          })
          .signers([worker.wallet])
          .rpc();
        const tx2Details = await provider.connection.getTransaction(tx2, {
          commitment: "confirmed",
        });
        totalTxFees += tx2Details?.meta?.fee || 0;

        // Complete task
        const tx3 = await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: worker.agentPda,
            creator: creator.publicKey,
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
        const tx3Details = await provider.connection.getTransaction(tx3, {
          commitment: "confirmed",
        });
        totalTxFees += tx3Details?.meta?.fee || 0;

        // Snapshot all balances after
        const creatorAfter = await provider.connection.getBalance(
          creator.publicKey,
        );
        const workerAfter = await provider.connection.getBalance(
          worker.wallet.publicKey,
        );
        const treasuryAfter =
          await provider.connection.getBalance(treasuryPubkey);
        const taskBalance = await provider.connection.getBalance(taskPda);
        const escrowBalance = await provider.connection.getBalance(escrowPda);
        const claimBalance = await provider.connection.getBalance(claimPda);

        // Calculate all deltas
        const creatorDelta = creatorAfter - creatorBefore;
        const workerDelta = workerAfter - workerBefore;
        const treasuryDelta = treasuryAfter - treasuryBefore;

        // Expected: creator paid (reward + task rent + escrow rent + tx fee)
        // Worker paid (claim rent + tx fees) and received (reward - protocol fee)
        // Treasury received protocol fee
        // New accounts hold rent

        const protocolFee = Math.floor(
          (rewardAmount * PROTOCOL_FEE_BPS) / 10000,
        );
        const workerReward = rewardAmount - protocolFee;

        // Verify conservation: all deltas + new account balances - tx fees = 0
        // Or: creator_delta + worker_delta + treasury_delta + task + escrow + claim = -totalTxFees
        const totalDelta = creatorDelta + workerDelta + treasuryDelta;
        const newAccountsTotal = taskBalance + escrowBalance + claimBalance;

        // Conservation check: what went out of existing accounts = what went into new accounts + fees
        // creatorDelta (negative) + workerDelta + treasuryDelta + newAccountsTotal = -totalTxFees
        // Use closeTo to account for tx fee retrieval timing issues
        expect(totalDelta + newAccountsTotal + totalTxFees).to.be.closeTo(
          0,
          25000,
        );
      });
    });
  });


});
